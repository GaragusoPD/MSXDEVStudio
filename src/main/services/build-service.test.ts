import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { REAL_MSXGL, emulatorConfigured, hasMsxgl, scratchRoot } from './__fixtures__/msxgl'
import type { BuildFinished, ConversionResult, IpcEvents, OpenProject } from '../../shared/ipc'
import { defaultProject } from '../../shared/msxproj'
import { BuildService, type BuildDeps } from './build-service'
import { createProject, resolveNodeBinary, saveProject } from './project'

// The same real MSXgl checkout the other suites use. Never referenced from
// product code — BuildService gets the root from ToolchainService.
const runsBuilds = hasMsxgl && resolveNodeBinary(REAL_MSXGL) !== null
const BUILD_TIMEOUT = 300_000

const tmpDirs: string[] = []
const services: BuildService[] = []

function makeProject(name: string, patch: (project: OpenProject['project']) => void = () => {}): OpenProject {
  const location = mkdtempSync(join(scratchRoot(), `build-${name}-`))
  tmpDirs.push(location)
  const opened = createProject(
    { name, location, machine: '1', target: 'ROM_32K', libModules: ['system', 'bios', 'vdp', 'print', 'input', 'memory'] },
    REAL_MSXGL
  )
  patch(opened.project)
  return { ...opened, ...saveProject(opened.root, opened.projectFile, opened.project) }
}

interface Harness {
  service: BuildService
  events: { channel: keyof IpcEvents; payload: unknown }[]
  opened: string[]
  prepared: () => number
  output: () => string[]
}

function harness(open: OpenProject, overrides: Partial<BuildDeps> = {}): Harness {
  const events: Harness['events'] = []
  const opened: string[] = []
  let prepared = 0
  const deps: BuildDeps = {
    getProject: () => open,
    prepare: () => {
      prepared += 1
    },
    // Spec 07's pre-build step; `resources.test.ts` covers the real one.
    exportResources: async () => [],
    msxglPath: () => REAL_MSXGL,
    nodeOverride: () => null,
    openmsxPath: () => null,
    emit: (channel, payload) => {
      events.push({ channel, payload })
    },
    openExternal: async (url) => {
      opened.push(url)
    },
    ...overrides
  }
  const service = new BuildService(deps)
  services.push(service)
  return {
    service,
    events,
    opened,
    prepared: () => prepared,
    output: () =>
      events
        .filter((e) => e.channel === 'build:output')
        .flatMap((e) => (e.payload as IpcEvents['build:output']).lines)
  }
}

/** Every process whose command line mentions this project — i.e. the build's sdcc/sdasz80 children. */
function processesFor(root: string): string[] {
  try {
    return execFileSync('pgrep', ['-af', root], { encoding: 'utf-8' })
      .split('\n')
      .filter((line) => line.trim() && !line.includes('pgrep'))
  } catch {
    return [] // pgrep exits 1 when nothing matches
  }
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

afterEach(() => {
  for (const service of services.splice(0)) service.dispose()
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

describe('BuildService.start', () => {
  it('refuses to build without a project or a toolchain', async () => {
    const noProject = harness({} as OpenProject, { getProject: () => null })
    await expect(noProject.service.start('build')).rejects.toThrow(/No project is open/)

    const noMsxgl = harness({} as OpenProject, {
      getProject: () => ({ root: '/tmp', projectFile: 'x.msxproj' }) as OpenProject,
      msxglPath: () => null
    })
    await expect(noMsxgl.service.start('build')).rejects.toThrow(/MSXgl is not configured/)
  })

  it.runIf(runsBuilds)(
    'builds a wizard-created project into a 32 KB ROM and reports it as an artifact',
    async () => {
      const open = makeProject('svcgame', (project) => {
        project.build.defines = { IDE_BUILD: '1' }
      })
      const test = harness(open)

      const result = await test.service.start('build')

      expect(result.ok, `${result.message}\n${test.output().join('\n')}`).toBe(true)
      expect(result.code).toBe(0)
      expect(result.message).toBeNull()
      expect(result.problems).toEqual([])
      expect(result.artifacts).toContainEqual({ path: 'emul/rom/svcgame.rom', size: 32768 })
      expect(result.artifacts.some((a) => a.path === 'out/svcgame.map')).toBe(true)

      // Pre-build step ran, and `.msxproj` defines reached the command line.
      expect(test.prepared()).toBe(1)
      expect(test.output()[0]).toContain('define=IDE_BUILD:1')

      // The full event sequence the renderer relies on.
      const channels = test.events.map((e) => e.channel)
      expect(channels[0]).toBe('build:started')
      expect(channels).toContain('build:output')
      expect(channels[channels.length - 1]).toBe('build:finished')
      expect(test.events[test.events.length - 1].payload).toEqual(result)
      expect(test.output().some((line) => line.includes('COMPILE'))).toBe(true)
    },
    BUILD_TIMEOUT
  )

  it.runIf(runsBuilds)(
    'rejects a second build while one is running',
    async () => {
      const open = makeProject('busygame')
      const test = harness(open)

      const first = test.service.start('build')
      await expect(test.service.start('build')).rejects.toThrow(/already in progress/)
      expect(test.service.running).toBe(true)

      await first
      expect(test.service.running).toBe(false)
      // …and a build after that one finished is fine again.
      await expect(test.service.start('clean')).resolves.toMatchObject({ ok: true })
    },
    BUILD_TIMEOUT
  )

  it.runIf(runsBuilds)(
    'turns real SDCC diagnostics into clickable problems and explains the exit code',
    async () => {
      const open = makeProject('brokengame')
      const source = join(open.root, 'main.c')
      writeFileSync(
        source,
        readFileSync(source, 'utf-8').replace('u8 count = 0;', 'u8 count = g_DoesNotExist;\n\tNo_Such_Function(count);'),
        'utf-8'
      )
      const test = harness(open)

      const result = await test.service.start('build')

      expect(result.ok).toBe(false)
      expect(result.artifacts).toEqual([])
      expect(result.message).toContain('Compilation failed')
      const errors = result.problems.filter((p) => p.severity === 'error')
      expect(errors.length).toBeGreaterThan(0)
      expect(errors[0].file).toBe('main.c') // project-relative → the Problems panel can jump to it
      expect(errors[0].line).toBeGreaterThan(0)
      expect(errors[0].message).toContain('g_DoesNotExist')
      expect(result.problems.some((p) => p.severity === 'warning')).toBe(true)
    },
    BUILD_TIMEOUT
  )
})

/**
 * A stand-in for MSXgl: `engine/script/js/build.js` that prints one SDCC-style
 * error and exits with `code`, run by this test's own Node. What `BuildService`
 * does around the build — the conversions and the event it ends with — needs no
 * compiler, and must not touch the real checkout another suite may be building in.
 */
function fakeMsxgl(code: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-msxgl-'))
  tmpDirs.push(dir)
  mkdirSync(join(dir, 'engine/script/js'), { recursive: true })
  writeFileSync(
    join(dir, 'engine/script/js/build.js'),
    `console.log("main.c:12: error 20: Undefined identifier 'g_Foo'")\nprocess.exit(${code})\n`
  )
  return dir
}

function fakeProject(): OpenProject {
  const root = mkdtempSync(join(tmpdir(), 'fake-project-'))
  tmpDirs.push(root)
  writeFileSync(join(root, 'main.c'), '', 'utf-8')
  return { root, projectFile: 'game.msxproj', project: defaultProject('game'), imported: false } as OpenProject
}

describe('BuildService: resource exports that failed', () => {
  const failed: ConversionResult[] = [
    { kind: 'resource', input: 'res/items.tiles.json', out: 'content/items.h', status: 'failed', message: 'compass has 2 poses but no export target' },
    { kind: 'resource', input: 'res/ok.tiles.json', out: 'content/ok.h', status: 'converted', message: '1 + 2 bytes' }
  ]

  /** A harness over the fake MSXgl that keeps a *copy* of each event, as the renderer receives it over IPC. */
  function run(code: number, command: 'build' | 'clean' = 'build'): { result: Promise<BuildFinished>; sent: { channel: string; payload: unknown }[] } {
    const sent: { channel: string; payload: unknown }[] = []
    const test = harness(fakeProject(), {
      msxglPath: () => fakeMsxgl(code),
      nodeOverride: () => process.execPath,
      exportResources: async () => failed,
      emit: (channel, payload) => sent.push({ channel, payload: structuredClone(payload) })
    })
    return { result: test.service.start(command), sent }
  }

  it('are build problems, ahead of the compiler’s own, in the result and in the build:finished the Problems panel is filled from', async () => {
    const { result, sent } = run(1)
    const finished = await result
    const expected = [
      { id: 'r0', severity: 'error', file: 'res/items.tiles.json', message: 'compass has 2 poses but no export target' },
      { id: 'p0', severity: 'error', file: 'main.c', line: 12, message: "error 20: Undefined identifier 'g_Foo'" }
    ]
    expect(finished.problems).toMatchObject(expected)
    expect(finished.problems).toHaveLength(2)
    const event = sent.filter((e) => e.channel === 'build:finished')
    expect(event).toHaveLength(1)
    expect((event[0].payload as BuildFinished).problems).toMatchObject(expected)
    // Still written to the output too, where they always were.
    expect(sent.some((e) => e.channel === 'build:output' && (e.payload as IpcEvents['build:output']).lines.some((line) => line.includes('Resource export failed: res/items.tiles.json')))).toBe(true)
  })

  it('leave ok to MSXgl: the build still runs and can succeed', async () => {
    const finished = await run(0).result
    expect(finished.ok).toBe(true)
    expect(finished.problems.map((problem) => problem.id)).toEqual(['r0', 'p0'])
  })

  it('are reported for a clean too', async () => {
    const finished = await run(0, 'clean').result
    expect(finished.problems[0]).toMatchObject({ id: 'r0', file: 'res/items.tiles.json' })
  })

  it('are none of a sample’s business: "Try it" exports nothing', async () => {
    const test = harness({} as OpenProject, {
      getProject: () => null,
      msxglPath: () => fakeMsxgl(0),
      nodeOverride: () => process.execPath,
      exportResources: async () => failed
    })
    const finished = await test.service.startExternal(fakeProject().root, ['projname=s_hello'])
    expect(finished.problems.map((problem) => problem.id)).toEqual(['p0'])
  })
})

describe('BuildService.kill', () => {
  it.runIf(runsBuilds && process.platform !== 'win32')(
    'terminates the build process tree, leaving no orphan node/sdcc processes',
    async () => {
      // "Insane" complexity makes the first SDCC run long enough to be caught mid-compile.
      const open = makeProject('killgame', (project) => {
        project.build.compileComplexity = 'Insane'
      })
      const test = harness(open)

      const running = test.service.start('build')
      for (let i = 0; i < 200 && !processesFor(open.root).length; i++) await wait(100)
      expect(processesFor(open.root).length, 'expected a compiler child to be running').toBeGreaterThan(0)

      test.service.kill()
      const result = await running

      expect(result.ok).toBe(false)
      expect(result.code).toBeNull()
      expect(result.message).toBe('Build canceled.')
      expect(test.service.running).toBe(false)

      await wait(500)
      expect(processesFor(open.root)).toEqual([])
    },
    BUILD_TIMEOUT
  )

  it('is a no-op when nothing is running', () => {
    expect(() => harness({} as OpenProject).service.kill()).not.toThrow()
  })
})

describe('BuildService.startExternal', () => {
  it.runIf(runsBuilds)(
    // ponytail: this writes real build output into the shared MSXgl fixture's samples/ folder,
    // same as production "Try it" — matches real usage, so it's left in place rather than cleaned up.
    'builds a sample in place (Spec 12 "Try it"), touching no project',
    async () => {
      const samples = join(REAL_MSXGL, 'projects', 'samples')
      const test = harness({} as OpenProject, { getProject: () => null })

      const result = await test.service.startExternal(samples, ['projname=s_hello'])

      expect(result.ok, `${result.message}\n${test.output().join('\n')}`).toBe(true)
      expect(result.code).toBe(0)
      expect(existsSync(join(samples, 'emul/rom/s_hello.rom'))).toBe(true)
      // No project to regenerate config for, and no artifacts resolved without one.
      expect(test.prepared()).toBe(0)
      expect(result.artifacts).toEqual([])
    },
    BUILD_TIMEOUT
  )

  it.runIf(runsBuilds)(
    'shares the one-build-at-a-time lock with start()',
    async () => {
      const samples = join(REAL_MSXGL, 'projects', 'samples')
      const test = harness({} as OpenProject, { getProject: () => null })

      const first = test.service.startExternal(samples, ['projname=s_hello'])
      await expect(test.service.startExternal(samples, ['projname=s_hello'])).rejects.toThrow(/already in progress/)
      await first
    },
    BUILD_TIMEOUT
  )
})

describe('BuildService WebMSX run', () => {
  it.runIf(runsBuilds)(
    'serves the ROM over loopback and opens webmsx.org pointed at it',
    async () => {
      const open = makeProject('webgame', (project) => {
        project.emulator.preferred = 'webmsx'
      })
      const test = harness(open)

      const result: BuildFinished = await test.service.start('run')
      expect(result.ok, result.message ?? '').toBe(true)

      // WebMSX runs the ROM itself, so MSXgl's own `run` step must stay off.
      expect(test.output()[0]).not.toContain(' run')

      expect(test.opened).toHaveLength(1)
      const url = new URL(test.opened[0])
      expect(url.origin + url.pathname).toBe('https://webmsx.org/')
      expect(url.searchParams.get('MACHINE')).toBe('MSX1')

      const romUrl = url.searchParams.get('ROM') as string
      expect(romUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/webgame\.rom$/)
      const response = await fetch(romUrl)
      expect(response.status).toBe(200)
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
      expect((await response.arrayBuffer()).byteLength).toBe(32768)

      // Closing the project (or quitting) takes the server down with it.
      test.service.dispose()
      await expect(fetch(romUrl)).rejects.toThrow()
    },
    BUILD_TIMEOUT
  )

  // Skipped against a clone whose `projects/default_config.js` names an
  // emulator: MSXgl's RUN step launches it for real and waits for the window.
  it.runIf(runsBuilds && !emulatorConfigured())(
    'hands the run step to MSXgl (not the browser) when openMSX is preferred',
    async () => {
      // defaultProject() → emulator.preferred: 'openmsx'.
      const open = makeProject('openmsxgame')
      const test = harness(open)

      const result = await test.service.start('run')

      expect(result.ok, result.message ?? '').toBe(true)
      expect(test.output()[0]).toMatch(/build\.js all run$/)
      // MSXgl reached its RUN step; whether an emulator actually boots depends
      // on the user's `Emulator` path (Spec 02) and can't be checked headless.
      expect(test.output().some((line) => line.includes('RUN'))).toBe(true)
      expect(test.opened).toEqual([])
      expect(result.artifacts).toContainEqual({ path: 'emul/rom/openmsxgame.rom', size: 32768 })
    },
    BUILD_TIMEOUT
  )
})
