import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { REAL_MSXGL, scratchRoot } from './__fixtures__/msxgl'
import type { NewProjectRequest } from '../../shared/ipc'
import type { ConfigGlobals } from '../../shared/msxproj'
import {
  collectContentDependencies,
  existingSampleIds,
  extractIncludes,
  findSegmentFiles,
  forkSample,
  readSampleSource,
  samplesDir
} from './examples'
import { evaluateProjectConfig, resolveNodeBinary } from './project'

// The same real MSXgl checkout the other suites use. Never referenced from
// product code — ExamplesService gets the root from ToolchainService.
const hasMsxgl = existsSync(join(REAL_MSXGL, 'projects/samples/s_hello.c'))
const NODE = resolveNodeBinary(REAL_MSXGL)
const SAMPLES = samplesDir(REAL_MSXGL)
const BUILD_TIMEOUT = 600_000

const tmpDirs: string[] = []
function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(scratchRoot(), prefix))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function evalSample(id: string): Promise<ConfigGlobals> {
  return evaluateProjectConfig(REAL_MSXGL, SAMPLES, NODE as string, `${id}.js`)
}

function buildProject(root: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(NODE as string, [join(REAL_MSXGL, 'engine/script/js/build.js'), 'all'], {
    cwd: root,
    encoding: 'utf-8',
    timeout: BUILD_TIMEOUT
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('extractIncludes', () => {
  it('finds only real, quoted #include lines', () => {
    const source = [
      '#include "msxgl.h"',
      '// #include "commented_out.h"',
      '\t#include "indented.h"',
      '#include <system.h>', // angle-bracket — never ours to copy
      'not an include "content/x.h"'
    ].join('\n')
    expect(extractIncludes(source)).toEqual(['msxgl.h', 'indented.h'])
  })
})

describe('existingSampleIds', () => {
  it.runIf(hasMsxgl)('keeps ids with a .c on disk and drops the rest', () => {
    expect(existingSampleIds(REAL_MSXGL, ['s_hello', 's_scroll', 's_does_not_exist'])).toEqual(['s_hello', 's_scroll'])
  })

  it('returns nothing for a folder that is not MSXgl', () => {
    expect(existingSampleIds(makeTmpDir('not-msxgl-'), ['s_hello'])).toEqual([])
  })
})

describe('collectContentDependencies', () => {
  it.runIf(hasMsxgl)('resolves samples/content/ assets and skips engine-provided headers', () => {
    const source = readSampleSource(REAL_MSXGL, 's_scroll')
    const deps = collectContentDependencies(REAL_MSXGL, source)
    expect([...deps.files.values()].sort()).toEqual(
      ['content/data_sprt_layer.h', 'content/tile/data_map_gm2.h', 'content/tile/data_tile_gm2.h'].sort()
    )
    expect(deps.unresolved).toEqual([])
  })

  it.runIf(hasMsxgl)('finds nothing for a sample with only engine includes', () => {
    const source = readSampleSource(REAL_MSXGL, 's_mapper')
    const deps = collectContentDependencies(REAL_MSXGL, source)
    expect(deps.files.size).toBe(0)
    expect(deps.unresolved).toEqual([])
  })

  it('reports includes that resolve nowhere as unresolved, without throwing', () => {
    const fakeRoot = makeTmpDir('fake-msxgl-')
    const deps = collectContentDependencies(fakeRoot, '#include "content/missing.h"\n#include "msxgl.h"\n')
    expect(deps.files.size).toBe(0)
    expect(deps.unresolved).toEqual(['content/missing.h', 'msxgl.h'])
  })
})

describe('findSegmentFiles', () => {
  it.runIf(hasMsxgl)("finds and renames s_mapper's segment siblings", () => {
    const files = findSegmentFiles(REAL_MSXGL, 's_mapper', 'mygame')
    expect(files.map((f) => f.newName).sort()).toEqual(['mygame_s4_b2.c', 'mygame_s5_b3.asm'])
  })

  it.runIf(hasMsxgl)('resolves a ProjSegments subdirectory (segment/s_arkos)', () => {
    const files = findSegmentFiles(REAL_MSXGL, 'segment/s_arkos', 'akgame')
    expect(files.length).toBeGreaterThan(0)
    expect(files.every((f) => f.newName.startsWith('akgame_s'))).toBe(true)
  })

  it('returns nothing when the segment directory does not exist', () => {
    expect(findSegmentFiles(makeTmpDir('not-msxgl-'), 's_x', 'y')).toEqual([])
  })
})

describe('forkSample', () => {
  it('creates the project even when an include cannot be resolved, listing it as a notice', () => {
    const msxglRoot = makeTmpDir('fake-msxgl-')
    const samples = join(msxglRoot, 'projects', 'samples')
    mkdirSync(samples, { recursive: true })
    writeFileSync(join(samples, 's_fake.c'), '#include "msxgl.h"\n#include "content/missing.h"\n', 'utf-8')
    writeFileSync(join(samples, 'msxgl_config_msx1.h'), '// msx1 config\n', 'utf-8')

    const location = makeTmpDir('fork-fake-')
    const request: NewProjectRequest = { name: 'fakegame', location, machine: '1', target: 'ROM_32K', libModules: [] }
    const { opened, notices } = forkSample(msxglRoot, 's_fake', request, { Machine: '1', Target: 'ROM_32K' }, false)

    expect(existsSync(join(opened.root, 'main.c'))).toBe(true)
    expect(existsSync(join(opened.root, 'msxgl_config.h'))).toBe(true)
    expect(opened.project.projModules).toEqual(['main'])
    expect(notices.some((n) => n.includes('content/missing.h'))).toBe(true)
  })

  it.runIf(hasMsxgl)('the "copy entire content" fallback copies everything under samples/content/', () => {
    const location = makeTmpDir('fork-blunt-')
    const request: NewProjectRequest = { name: 'blunt', location, machine: '1', target: 'ROM_32K', libModules: [] }
    const { opened } = forkSample(REAL_MSXGL, 's_hello', request, { Machine: '1', Target: 'ROM_32K' }, true)
    expect(readdirSync(join(opened.root, 'content'))).toEqual(
      expect.arrayContaining(readdirSync(join(SAMPLES, 'content')))
    )
  })
})

describe('forkSample (integration, real MSXgl toolchain)', () => {
  it.runIf(hasMsxgl && NODE !== null)(
    'forks s_scroll with the right machine/target/libModules and copies its includes, and it builds',
    async () => {
      const location = makeTmpDir('fork-scroll-')
      const globals = await evalSample('s_scroll')
      const request: NewProjectRequest = { name: 'scrollgame', location, machine: '1', target: 'ROM_32K', libModules: [] }

      const { opened, notices } = forkSample(REAL_MSXGL, 's_scroll', request, globals, false)

      expect(opened.project.machine).toBe('2')
      expect(opened.project.target).toBe('ROM_32K')
      expect(opened.project.libModules).toContain('scroll')
      expect(opened.project.projModules).toEqual(['main'])
      expect(notices).toEqual([])

      for (const rel of [
        'main.c',
        'msxgl_config.h',
        'scrollgame.msxproj',
        'project_config.js',
        'content/tile/data_tile_gm2.h',
        'content/tile/data_map_gm2.h',
        'content/data_sprt_layer.h'
      ]) {
        expect(existsSync(join(opened.root, rel)), rel).toBe(true)
      }
      // Samples use a MSX_VERSION dispatcher; the forked project gets the concrete MSX2 header.
      expect(readFileSync(join(opened.root, 'msxgl_config.h'), 'utf-8')).toBe(
        readFileSync(join(SAMPLES, 'msxgl_config_msx2.h'), 'utf-8')
      )

      const result = buildProject(opened.root)
      const rom = join(opened.root, 'emul/rom/scrollgame.rom')
      expect(existsSync(rom), `build failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`).toBe(true)
    },
    BUILD_TIMEOUT
  )

  it.runIf(hasMsxgl && NODE !== null)(
    'forks s_mapper with its segment files copied and renamed to the new project, and it builds',
    async () => {
      const location = makeTmpDir('fork-mapper-')
      const globals = await evalSample('s_mapper')
      const request: NewProjectRequest = { name: 'mapgame', location, machine: '1', target: 'ROM_ASCII8', libModules: [] }

      const { opened, notices } = forkSample(REAL_MSXGL, 's_mapper', request, globals, false)

      expect(opened.project.target).toBe('ROM_ASCII8')
      expect(opened.project.romSize).toBe(128)
      expect(opened.project.rom.bankedCall).toBe(true)
      expect(notices).toEqual([])
      expect(existsSync(join(opened.root, 'mapgame_s4_b2.c'))).toBe(true)
      expect(existsSync(join(opened.root, 'mapgame_s5_b3.asm'))).toBe(true)

      const result = buildProject(opened.root)
      const rom = join(opened.root, 'emul/rom/mapgame.rom')
      expect(existsSync(rom), `build failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`).toBe(true)
    },
    BUILD_TIMEOUT
  )

  it.runIf(hasMsxgl && NODE !== null)(
    'forks s_vgm with its RawFiles copied and rewritten into the .msxproj, and it builds',
    async () => {
      const location = makeTmpDir('fork-vgm-')
      const globals = await evalSample('s_vgm')
      const request: NewProjectRequest = { name: 'vgmgame', location, machine: '1', target: 'ROM_ASCII16', libModules: [] }

      const { opened, notices } = forkSample(REAL_MSXGL, 's_vgm', request, globals, false)

      expect(opened.project.files.rawFiles.length).toBeGreaterThan(0)
      expect(opened.project.files.rawFiles[0]).toMatchObject({ segment: 2, file: 'content/vgm/psg_ds4_03.vgm' })
      expect(notices).toEqual([])
      for (const raw of opened.project.files.rawFiles) {
        expect(existsSync(join(opened.root, raw.file)), raw.file).toBe(true)
      }
      // The stale build artifact from the samples/ checkout isn't copied — main.c's include was
      // renamed to the name MSXgl will actually (re)generate for this project.
      expect(existsSync(join(opened.root, 's_vgm_rawdef.h'))).toBe(false)
      expect(readFileSync(join(opened.root, 'main.c'), 'utf-8')).toContain('#include "vgmgame_rawdef.h"')

      const config = readFileSync(join(opened.root, 'project_config.js'), 'utf-8')
      expect(config).toContain('RawFiles = [')
      expect(config).toContain('content/vgm/psg_ds4_03.vgm')

      const result = buildProject(opened.root)
      const rom = join(opened.root, 'emul/rom/vgmgame.rom')
      expect(existsSync(rom), `build failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`).toBe(true)
      // Confirms the rename was necessary and correct: MSXgl really does generate this filename.
      expect(existsSync(join(opened.root, 'vgmgame_rawdef.h'))).toBe(true)
    },
    BUILD_TIMEOUT
  )
})
