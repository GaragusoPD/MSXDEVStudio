import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultProject, type MsxProject } from '../../shared/msxproj'
import {
  ArtifactServer,
  artifactCandidates,
  buildArgs,
  buildStamp,
  commandSteps,
  exitCodeMessage,
  needsFullRebuild,
  parseProblem,
  parseProblems,
  resolveArtifacts,
  runnableArtifact,
  stripAnsi,
  targetExtension,
  webmsxMachine,
  webmsxUrl,
  windowsBuildCwd,
  writeBuildStamp
} from './build'

const ROOT = '/projects/mygame'

/** Raw output captured from real MSXgl builds — see `__fixtures__/`. */
function fixture(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', name), 'utf-8')
}

const tmpDirs: string[] = []
function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

function project(overrides: Partial<MsxProject> = {}): MsxProject {
  return { ...defaultProject('mygame'), ...overrides }
}

describe('windowsBuildCwd', () => {
  it('leaves a clean path alone', () => {
    expect(windowsBuildCwd('C:\\dev\\game', 'win32')).toBe('C:\\dev\\game')
    expect(windowsBuildCwd('C:\\My Game\\foo', 'linux')).toBe('C:\\My Game\\foo')
  })

  // Shells out to PowerShell for the 8.3 name, which is far slower than the
  // default 5s test timeout on a cold or busy Windows box.
  it.runIf(process.platform === 'win32')(
    'collapses a spaced Windows path to 8.3',
    () => {
      const parent = makeTmpDir('msx build-')
      const spaced = join(parent, 'My Game')
      mkdirSync(spaced)
      const short = windowsBuildCwd(spaced)
      expect(short).not.toMatch(/\s/)
      expect(existsSync(short)).toBe(true)
    },
    60_000
  )
})

describe('build arguments', () => {
  it('maps each IDE command to MSXgl build steps', () => {
    expect(commandSteps('build', true)).toEqual(['all'])
    expect(commandSteps('rebuild', true)).toEqual(['rebuild'])
    expect(commandSteps('clean', true)).toEqual(['clean'])
    expect(commandSteps('run', true)).toEqual(['all', 'run'])
  })

  it('leaves MSXgl´s run step out when WebMSX (not an installed emulator) will run it', () => {
    expect(commandSteps('run', false)).toEqual(['all'])
  })

  it('swaps all for rebuild when a full rebuild is forced', () => {
    expect(commandSteps('build', true, true)).toEqual(['rebuild'])
    expect(commandSteps('run', true, true)).toEqual(['rebuild', 'run'])
    expect(commandSteps('clean', true, true)).toEqual(['clean'])
  })

  it('passes build.defines as repeated define= args and points at build.js', () => {
    const args = buildArgs(
      '/opt/MSXgl',
      project({ build: { ...defaultProject('mygame').build, defines: { DEBUG_MODE: '', LEVELS: '4' } } }),
      'build',
      true
    )
    expect(args[0]).toBe(join('/opt/MSXgl', 'engine', 'script', 'js', 'build.js'))
    expect(args).toContain('all')
    expect(args).toContain('define=DEBUG_MODE')
    expect(args).toContain('define=LEVELS:4')
  })
})

describe('incremental rebuild guard', () => {
  /** A project dir with one compiled `.rel` at time `relTime` and a matching stamp. */
  function builtProject(stamp: string, relTime: Date): string {
    const root = makeTmpDir('msxdevstudio-guard-')
    mkdirSync(join(root, 'out'))
    writeFileSync(join(root, 'out', 'main.rel'), '')
    utimesSync(join(root, 'out', 'main.rel'), relTime, relTime)
    writeBuildStamp(root, stamp)
    return root
  }

  const before = new Date('2026-01-01T00:00:00Z')
  const after = new Date('2026-01-02T00:00:00Z')

  it('is false with no .rel files — a plain all compiles everything anyway', () => {
    const root = makeTmpDir('msxdevstudio-guard-')
    expect(needsFullRebuild(root, 'stamp')).toBe(false)
    mkdirSync(join(root, 'out'))
    expect(needsFullRebuild(root, 'stamp')).toBe(false)
  })

  it('is true when .rels exist without a stamp (built before the guard existed)', () => {
    const root = builtProject('stamp', before)
    rmSync(join(root, 'out', '.msxdevstudio-stamp'))
    expect(needsFullRebuild(root, 'stamp')).toBe(true)
  })

  it('detects compile-flag changes through the stamp', () => {
    const root = builtProject('old-flags', before)
    expect(needsFullRebuild(root, 'old-flags')).toBe(false)
    expect(needsFullRebuild(root, 'new-flags')).toBe(true)
  })

  it('detects headers newer than the oldest .rel, but not output/hidden dirs', () => {
    const root = builtProject('stamp', before)
    expect(needsFullRebuild(root, 'stamp')).toBe(false)

    mkdirSync(join(root, 'emul'))
    writeFileSync(join(root, 'emul', 'ignored.h'), '')
    utimesSync(join(root, 'emul', 'ignored.h'), after, after)
    expect(needsFullRebuild(root, 'stamp')).toBe(false)

    mkdirSync(join(root, 'content'))
    writeFileSync(join(root, 'content', 'title.h'), '')
    utimesSync(join(root, 'content', 'title.h'), after, after)
    expect(needsFullRebuild(root, 'stamp')).toBe(true)
  })

  it('ignores headers older than every .rel', () => {
    const root = builtProject('stamp', after)
    writeFileSync(join(root, 'msxgl_config.h'), '')
    utimesSync(join(root, 'msxgl_config.h'), before, before)
    expect(needsFullRebuild(root, 'stamp')).toBe(false)
  })

  it('buildStamp changes with defines and with project_config.js content', () => {
    const root = makeTmpDir('msxdevstudio-stamp-')
    const base = project()
    const withDefine = project({ build: { ...base.build, defines: { DEBUG_MODE: '' } } })
    expect(buildStamp(root, base)).not.toBe(buildStamp(root, withDefine))

    const stampBefore = buildStamp(root, base)
    writeFileSync(join(root, 'project_config.js'), 'Optim = "Speed";\n')
    expect(buildStamp(root, base)).not.toBe(stampBefore)
  })
})

describe('stripAnsi', () => {
  it('removes the colour codes MSXgl prints and the trailing CR', () => {
    expect(stripAnsi('[91mError: Module no_such_module.c not found![0m\r')).toBe(
      'Error: Module no_such_module.c not found!'
    )
  })
})

describe('problem parsing (real captured build output)', () => {
  it('parses SDCC syntax errors', () => {
    // "./template.c:41: syntax error: token -> 'VDP_ClearVRAM' ; column 14"
    const problems = parseProblems(fixture('sdcc-syntax-error.stderr.txt'), ROOT)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({
      severity: 'error',
      file: 'template.c',
      line: 41
    })
    expect(problems[0].message).toContain('syntax error')
  })

  it('parses SDCC numbered errors and warnings, keeping their severities apart', () => {
    const problems = parseProblems(fixture('sdcc-errors-warnings.stderr.txt'), ROOT)
    expect(problems.filter((p) => p.severity === 'error')).toHaveLength(2)
    expect(problems.filter((p) => p.severity === 'warning')).toHaveLength(5)
    expect(problems[0]).toMatchObject({
      severity: 'error',
      file: 'template.c',
      line: 48,
      message: "error 20: Undefined identifier 'g_DoesNotExist'"
    })
    expect(problems[1]).toMatchObject({
      severity: 'warning',
      file: 'template.c',
      line: 49,
      message: "warning 112: function 'No_Such_Function' implicit declaration"
    })
  })

  it('parses sdasz80 assembler errors (SDCC 4.6.0 file:line form)', () => {
    const problems = parseProblems(fixture('sdasz80-errors.stderr.txt'), ROOT)
    expect(problems).toHaveLength(2)
    expect(problems[0]).toMatchObject({
      severity: 'error',
      file: 'bad.s',
      line: 3,
      message: '<u> undefined symbol encountered during assembly'
    })
    expect(problems[1].line).toBe(4)
  })

  it('parses the documented ?ASxxxx / ?ASlink forms, including file-less link errors', () => {
    const problems = parseProblems(fixture('asxxxx-errors.txt'), ROOT)
    expect(problems).toHaveLength(4)
    expect(problems[0]).toMatchObject({ severity: 'error', file: 'bad.s', line: 4, message: '<o>' })
    expect(problems[1]).toMatchObject({ severity: 'warning', file: 'src/tiles.asm', line: 12 })
    expect(problems[2].severity).toBe('warning')
    expect(problems[2].file).toBeUndefined()
    expect(problems[2].message).toContain("Undefined Global '_Missing_Function'")
    expect(problems[3].severity).toBe('error')
    expect(problems[3].file).toBeUndefined()
  })

  it('ignores ordinary build chatter, including ANSI-coloured lines and timings', () => {
    expect(parseProblems(fixture('libmodules-110.stdout.txt'), ROOT)).toEqual([])
    for (const line of [
      'Total build time: 00:00:04.123',
      '- ProjDir:  /projects/mygame/',
      'Compiling ./template.c using SDCC C compiler...',
      '[92mSuccess[0m'
    ]) {
      expect(parseProblem(line, ROOT), line).toBeNull()
    }
  })

  it('keeps engine-source diagnostics visible but not clickable (they are outside the project)', () => {
    const problem = parseProblem('/opt/MSXgl/engine/src/vdp.c:120: warning 84: no such thing', ROOT)
    expect(problem?.severity).toBe('warning')
    expect(problem?.file).toBeUndefined()
    expect(problem?.message).toContain('/opt/MSXgl/engine/src/vdp.c:120')
  })

  it('relativises absolute in-project paths', () => {
    expect(parseProblem(`${ROOT}/src/game.c:7: error 20: nope`, ROOT)).toMatchObject({
      file: 'src/game.c',
      line: 7
    })
  })
})

describe('exitCodeMessage', () => {
  it('says nothing on success', () => {
    expect(exitCodeMessage(0)).toBeNull()
  })

  it('points tool-path failures at Toolchain Settings', () => {
    for (const code of [20, 30, 35, 40, 50]) {
      expect(exitCodeMessage(code)).toContain('Toolchain Settings')
    }
  })

  it('explains a bad LibModules entry (110)', () => {
    expect(exitCodeMessage(110)).toContain('LibModules')
  })

  it('explains the openMSX turbo-R C-BIOS gap (500)', () => {
    expect(exitCodeMessage(500)).toContain('openMSX machine override')
  })

  it('recognises MSXgl codes after POSIX truncates them to 8 bits', () => {
    // POSIX reports `code % 256`: exit(500) arrives as 244, exit(310) as 54.
    expect(exitCodeMessage(500 % 256)).toBe(exitCodeMessage(500))
    expect(exitCodeMessage(310 % 256)).toContain('Compilation failed')
    expect(exitCodeMessage(320 % 256)).toContain('Assembly failed')
  })

  it('falls back to a generic message plus the last stderr lines', () => {
    const message = exitCodeMessage(7, ['', 'one', 'two', 'three', 'four', 'five', 'six'])
    expect(message).toContain('exit code 7')
    expect(message).toContain('six')
    expect(message).not.toContain('one') // only the last five lines
  })

  it('reports a killed build', () => {
    expect(exitCodeMessage(null)).toBe('Build canceled.')
  })
})

describe('artifact resolution', () => {
  it('knows each target family´s file extension', () => {
    expect(targetExtension('ROM_32K')).toBe('rom')
    expect(targetExtension('rom')).toBe('rom') // alias → ROM_32K
    expect(targetExtension('DOS2_MAPPER')).toBe('com')
    expect(targetExtension('BIN_DISK')).toBe('bin')
    expect(targetExtension('LIB')).toBe('lib')
  })

  it('lists the paths MSXgl deploys per target family', () => {
    expect(artifactCandidates(project({ target: 'ROM_32K' }))).toEqual([
      'emul/rom/mygame.rom',
      'out/mygame.map'
    ])
    expect(artifactCandidates(project({ target: 'BIN_DISK' }))).toEqual([
      'emul/bin/mygame.bin',
      'emul/dsk/BIN_DISK_mygame.dsk',
      'out/mygame.map'
    ])
    expect(artifactCandidates(project({ target: 'DOS2' }))).toEqual([
      'emul/dos2/mygame.com',
      'emul/dsk/DOS2_mygame.dsk',
      'out/mygame.map'
    ])
    expect(artifactCandidates(project({ target: 'DOS0' }))[0]).toBe('emul/dos0/BOOTDISK.COM')
    expect(artifactCandidates(project({ target: 'BIN_TAPE' }))[1]).toBe('emul/cas/mygame.cas')
  })

  it('returns only what exists on disk, with sizes', () => {
    const root = makeTmpDir('artifacts-')
    mkdirSync(join(root, 'emul/rom'), { recursive: true })
    writeFileSync(join(root, 'emul/rom/mygame.rom'), Buffer.alloc(32768))

    expect(resolveArtifacts(root, project({ target: 'ROM_32K' }))).toEqual([
      { path: 'emul/rom/mygame.rom', size: 32768 }
    ])
  })

  it('picks the ROM to run, else the DSK', () => {
    const rom = { path: 'emul/rom/g.rom', size: 1 }
    const dsk = { path: 'emul/dsk/DOS2_g.dsk', size: 2 }
    const map = { path: 'out/g.map', size: 3 }
    expect(runnableArtifact([map, rom, dsk])).toEqual({ artifact: rom, slot: 'ROM' })
    expect(runnableArtifact([map, dsk])).toEqual({ artifact: dsk, slot: 'DISK' })
    expect(runnableArtifact([map])).toBeNull()
  })
})

describe('WebMSX hand-off', () => {
  it('maps MSXgl machines to WebMSX MACHINE values, highest wins for multi-machine', () => {
    expect(webmsxMachine('1')).toBe('MSX1')
    expect(webmsxMachine('2')).toBe('MSX2')
    expect(webmsxMachine('2P')).toBe('MSX2P')
    expect(webmsxMachine('TR')).toBe('MSXTR')
    expect(webmsxMachine('12')).toBe('MSX2')
    expect(webmsxMachine('22P')).toBe('MSX2P')
    expect(webmsxMachine('122P')).toBe('MSX2P')
    expect(webmsxMachine('2K')).toBe('MSX2')
    expect(webmsxMachine('0')).toBe('MSX1')
  })

  it('builds ROM= and DISK= urls with the artifact url encoded', () => {
    expect(webmsxUrl('1', 'ROM', 'http://127.0.0.1:5000/my%20game.rom')).toBe(
      'https://webmsx.org/?MACHINE=MSX1&ROM=http%3A%2F%2F127.0.0.1%3A5000%2Fmy%2520game.rom'
    )
    expect(webmsxUrl('2P', 'DISK', 'http://127.0.0.1:1/g.dsk')).toContain('&DISK=')
  })
})

describe('ArtifactServer', () => {
  it('serves only the published artifacts, with CORS, and stops cleanly', async () => {
    const root = makeTmpDir('artifact-server-')
    const rom = join(root, 'game.rom')
    const secret = join(root, 'secret.txt')
    writeFileSync(rom, Buffer.from([1, 2, 3, 4]))
    writeFileSync(secret, 'not yours')

    const server = new ArtifactServer()
    const [url] = await server.serve([rom])
    try {
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/game\.rom$/)

      const response = await fetch(url)
      expect(response.status).toBe(200)
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]))

      const base = new URL(url).origin
      for (const path of ['/secret.txt', '/', '/../secret.txt', '/emul/rom/game.rom']) {
        expect((await fetch(base + path)).status, path).toBe(404)
      }
      expect((await fetch(url, { method: 'POST' })).status).toBe(404)
    } finally {
      server.stop()
    }

    await expect(fetch(url)).rejects.toThrow()
  })

  it('replaces the published set on the next build without changing port', async () => {
    const root = makeTmpDir('artifact-server-2-')
    const first = join(root, 'first.rom')
    const second = join(root, 'second.dsk')
    writeFileSync(first, 'a')
    writeFileSync(second, 'b')

    const server = new ArtifactServer()
    try {
      const [firstUrl] = await server.serve([first])
      const [secondUrl] = await server.serve([second])
      expect(new URL(firstUrl).port).toBe(new URL(secondUrl).port)
      expect((await fetch(firstUrl)).status).toBe(404)
      expect((await fetch(secondUrl)).status).toBe(200)
    } finally {
      server.stop()
    }
  })
})
