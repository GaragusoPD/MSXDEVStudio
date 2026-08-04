import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { REAL_MSXGL, hasMsxgl, scratchRoot } from './__fixtures__/msxgl'
import type { IpcEvents, OpenProject } from '../../shared/ipc'
import type { ImgRule, MsxProject } from '../../shared/msxproj'
import { decodeAyfxBank, normalizeSfx, SFX_PRESETS } from '../../shared/msx/sfx'
import { mergeColorByte, normalizeTiles } from '../../shared/msx/tile'
import { defaultExport, serializeResource } from '../../shared/msx/resource'
import { BuildService, type BuildDeps } from './build-service'
import { createProject, resolveNodeBinary, saveProject, writeGeneratedConfig } from './project'
import {
  exportAll,
  exportResourceFile,
  findResourceFiles,
  msximgArgs,
  msximgPath,
  runImgRule,
  summarize,
  generatedSourceModules
} from './resources'

// The same real MSXgl checkout the other suites use. Never referenced from
// product code — services get the root from ToolchainService.
const SAMPLE_PNG = join(REAL_MSXGL, 'projects/samples/datasrc/img/city.png')
const hasMsximg = existsSync(msximgPath(REAL_MSXGL)) && existsSync(SAMPLE_PNG)
const runsBuilds = hasMsxgl && resolveNodeBinary(REAL_MSXGL) !== null
const BUILD_TIMEOUT = 300_000

const tmpDirs: string[] = []

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function scratch(name: string): string {
  const dir = mkdtempSync(join(scratchRoot(), `${name}-`))
  tmpDirs.push(dir)
  return dir
}

/** A minimal project object — only `resources.imgRules` matters to `exportAll`. */
function fakeProject(imgRules: ImgRule[] = []): MsxProject {
  return { resources: { imgRules } } as MsxProject
}

/** Writes a 2-tile sc2 tileset that exports to `content/<name>.h`. */
function writeTileset(root: string, relative: string, out = 'content/hero.h'): void {
  const doc = normalizeTiles({
    mode: 'sc2',
    count: 2,
    tiles: [
      { pattern: [0x18, 0x3c, 0x7e, 0xff, 0xff, 0x7e, 0x3c, 0x18], color: new Array(8).fill(mergeColorByte(15, 4)) },
      { pattern: [0xff, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0xff], color: new Array(8).fill(mergeColorByte(6, 1)) }
    ]
  })
  // Named explicitly: this fixture is about the export mechanics, not about
  // whatever `defaultExport` currently names things.
  doc.export = { ...defaultExport(relative), name: 'g_Hero', out }
  mkdirSync(join(root, relative, '..'), { recursive: true })
  writeFileSync(join(root, relative), serializeResource({ kind: 'tiles', doc }), 'utf-8')
}

/** Backdates a file so mtime comparisons are unambiguous on coarse filesystems. */
function backdate(path: string, secondsAgo: number): void {
  const when = new Date(Date.now() - secondsAgo * 1000)
  utimesSync(path, when, when)
}

describe('findResourceFiles', () => {
  it('finds every resource kind recursively, skipping build folders', () => {
    const root = scratch('scan')
    mkdirSync(join(root, 'art'), { recursive: true })
    mkdirSync(join(root, 'out'), { recursive: true })
    mkdirSync(join(root, 'node_modules'), { recursive: true })
    for (const path of [
      'a.tiles.json',
      'art/b.sprites.json',
      'art/c.map.json',
      'art/d.screen.json',
      'art/e.sfx.json',
      'main.c',
      'notes.json',
      'out/stale.tiles.json',
      'node_modules/dep.tiles.json'
    ]) {
      writeFileSync(join(root, path), '{}', 'utf-8')
    }
    expect(findResourceFiles(root)).toEqual([
      'a.tiles.json',
      'art/b.sprites.json',
      'art/c.map.json',
      'art/d.screen.json',
      'art/e.sfx.json'
    ])
  })

  it('returns nothing for a folder that does not exist', () => {
    expect(findResourceFiles(join(tmpdir(), 'definitely-not-here-msxstudio'))).toEqual([])
  })
})

describe('exportResourceFile', () => {
  it('writes a deterministic C header to the export target', () => {
    const root = scratch('export')
    writeTileset(root, 'art/hero.tiles.json')

    const result = exportResourceFile(root, 'art/hero.tiles.json')
    expect(result).toMatchObject({
      kind: 'resource',
      input: 'art/hero.tiles.json',
      out: 'content/hero.h + content/hero.c',
      status: 'converted'
    })

    // Declarations in the header, data in the source: that split is what lets a
    // second module include the header without a duplicate symbol.
    const header = readFileSync(join(root, 'content/hero.h'), 'utf-8')
    expect(header).toContain('extern const unsigned char g_Hero_Patterns[];')
    expect(header).toContain('#pragma once')
    expect(header).not.toContain('0x18,')
    expect(header).toContain('//  - Source: art/hero.tiles.json')

    const text = readFileSync(join(root, 'content/hero.c'), 'utf-8')
    expect(text).toContain('#include "hero.h"')
    expect(text).toContain('const unsigned char g_Hero_Patterns[] =')
    expect(text).toContain('\t0x18, /* ...##... */')
    expect(text).toContain('const unsigned char g_Hero_Colors[] =')

    // Byte-stable: re-export (forced) must produce identical bytes, both halves.
    expect(exportResourceFile(root, 'art/hero.tiles.json', { force: true }).status).toBe('converted')
    expect(readFileSync(join(root, 'content/hero.h'), 'utf-8')).toBe(header)
    expect(readFileSync(join(root, 'content/hero.c'), 'utf-8')).toBe(text)
  })

  it('exports a .sfx.json as an ayFX bank that decodes back to the authored effects', () => {
    const root = scratch('export-sfx')
    const doc = normalizeSfx({ effects: SFX_PRESETS })
    doc.export = { name: 'g_Sfx', format: 'bin', out: 'content/sfx.afb' }
    writeFileSync(join(root, 'blips.sfx.json'), serializeResource({ kind: 'sfx', doc }), 'utf-8')

    expect(findResourceFiles(root)).toEqual(['blips.sfx.json'])
    expect(exportResourceFile(root, 'blips.sfx.json')).toMatchObject({ out: 'content/sfx.afb', status: 'converted' })

    const bank = new Uint8Array(readFileSync(join(root, 'content/sfx.afb')))
    expect(bank[0]).toBe(SFX_PRESETS.length)
    expect(decodeAyfxBank(bank).map((effect) => effect.frames)).toEqual(doc.effects.map((effect) => effect.frames))
  })

  it('writes raw bytes for format: bin', () => {
    const root = scratch('export-bin')
    writeTileset(root, 'hero.tiles.json', 'content/hero.bin')
    const doc = JSON.parse(readFileSync(join(root, 'hero.tiles.json'), 'utf-8')) as { export: { format: string } }
    doc.export.format = 'bin'
    writeFileSync(join(root, 'hero.tiles.json'), JSON.stringify(doc), 'utf-8')

    expect(exportResourceFile(root, 'hero.tiles.json').status).toBe('converted')
    const bytes = readFileSync(join(root, 'content/hero.bin'))
    expect(bytes).toHaveLength(32) // 2 tiles × (8 pattern + 8 color)
    expect(bytes[0]).toBe(0x18)
  })

  it('skips when the output is newer than the source', () => {
    const root = scratch('skip')
    writeTileset(root, 'hero.tiles.json')
    expect(exportResourceFile(root, 'hero.tiles.json').status).toBe('converted')
    expect(exportResourceFile(root, 'hero.tiles.json').status).toBe('skipped')

    // Touching the source makes it dirty again.
    backdate(join(root, 'content/hero.h'), 60)
    expect(exportResourceFile(root, 'hero.tiles.json').status).toBe('converted')
  })

  it('re-runs when the .msxproj changed after the last export', () => {
    const root = scratch('skip-config')
    writeTileset(root, 'hero.tiles.json')
    exportResourceFile(root, 'hero.tiles.json')
    expect(exportResourceFile(root, 'hero.tiles.json', { configMtimeMs: Date.now() + 5000 }).status).toBe('converted')
  })

  it('reports resources without an export block instead of failing', () => {
    const root = scratch('noexport')
    writeFileSync(join(root, 'x.tiles.json'), JSON.stringify({ mode: 'sc2', count: 1 }), 'utf-8')
    expect(exportResourceFile(root, 'x.tiles.json')).toMatchObject({ status: 'skipped', message: 'No export target set.' })
  })

  it('reports malformed JSON as a failure, not an exception', () => {
    const root = scratch('broken')
    writeFileSync(join(root, 'x.tiles.json'), '{ not json', 'utf-8')
    const result = exportResourceFile(root, 'x.tiles.json')
    expect(result.status).toBe('failed')
    expect(result.message).toBeTruthy()
  })

  it('refuses paths that escape the project folder', () => {
    const root = scratch('escape')
    expect(exportResourceFile(root, '../evil.tiles.json').message).toMatch(/escapes the project/)

    writeTileset(root, 'hero.tiles.json', '../../evil.h')
    expect(exportResourceFile(root, 'hero.tiles.json').message).toMatch(/escapes the project/)
  })

  it('refuses to export a resource that fails validation', () => {
    const root = scratch('invalid')
    // sc4 keeps its palette through normalization, so a bad entry reaches the validator.
    writeFileSync(
      join(root, 'hero.tiles.json'),
      JSON.stringify({
        mode: 'sc4',
        count: 1,
        palette: new Array(16).fill(0x888), // outside the GRB333 space
        export: { name: 'g_Hero', format: 'c', out: 'content/hero.h' }
      }),
      'utf-8'
    )
    const result = exportResourceFile(root, 'hero.tiles.json')
    expect(result.status).toBe('failed')
    expect(result.message).toContain('GRB333')
    expect(existsSync(join(root, 'content/hero.h'))).toBe(false)
  })
})

describe('msximgArgs', () => {
  it('puts the input first, forces -nodate/-ret0, and owns -out', () => {
    const args = msximgArgs({ input: 'assets/title.png', out: 'content/title.h', args: ['-mode', 'bmp', '-bpc', '4'] })
    expect(args[0]).toBe('assets/title.png')
    expect(args).toContain('-nodate')
    expect(args).toContain('-ret0')
    expect(args.slice(-2)).toEqual(['-out', 'content/title.h'])
    expect(args.filter((arg) => arg === '-out')).toHaveLength(1)
  })

  it('does not duplicate flags the user already passed', () => {
    const args = msximgArgs({ input: 'a.png', out: 'b.h', args: ['-nodate', '-ret0'] })
    expect(args.filter((arg) => arg === '-nodate')).toHaveLength(1)
    expect(args.filter((arg) => arg === '-ret0')).toHaveLength(1)
    expect(args.filter((arg) => arg === '-out')).toHaveLength(1)
  })

  it('drops a hand-typed -out together with its path', () => {
    const args = msximgArgs({ input: 'a.png', out: 'b.h', args: ['-out', 'wrong.h', '-bpc', '4'] })
    expect(args).not.toContain('wrong.h')
    expect(args).toEqual(['a.png', '-bpc', '4', '-nodate', '-ret0', '-out', 'b.h'])
  })
})

describe('imgRules', () => {
  it('reports a missing input without spawning anything', async () => {
    const root = scratch('img-missing')
    const result = await runImgRule(root, REAL_MSXGL, { input: 'nope.png', out: 'content/x.h', args: [] })
    expect(result).toMatchObject({ kind: 'imgRule', status: 'failed' })
    expect(result.message).toContain('Input not found')
  })

  it('reports a missing MSXimg binary clearly', async () => {
    const root = scratch('img-nobin')
    writeFileSync(join(root, 'a.png'), 'not really a png', 'utf-8')
    const result = await runImgRule(root, join(root, 'no-msxgl'), { input: 'a.png', out: 'content/x.h', args: [] })
    expect(result.message).toMatch(/MSXimg not found/)
  })

  it('refuses rule paths that escape the project', async () => {
    const root = scratch('img-escape')
    const result = await runImgRule(root, REAL_MSXGL, { input: '../a.png', out: 'content/x.h', args: [] })
    expect(result.message).toMatch(/escapes the project/)
  })

  it.runIf(hasMsximg)('converts a real PNG with the bundled MSXimg', async () => {
    const root = scratch('img-real')
    mkdirSync(join(root, 'assets'), { recursive: true })
    writeFileSync(join(root, 'assets/city.png'), readFileSync(SAMPLE_PNG))
    const rule: ImgRule = {
      input: 'assets/city.png',
      out: 'content/city_tiles.h',
      args: ['-mode', 'gm2', '-name', 'g_CityTiles', '-pos', '0', '256', '-size', '192', '144', '-offset', '0']
    }

    const result = await runImgRule(root, REAL_MSXGL, rule)
    expect(result.status, result.message).toBe('converted')

    const header = readFileSync(join(root, 'content/city_tiles.h'), 'utf-8')
    expect(header).toContain('const unsigned char g_CityTiles_Names[] =')
    expect(header).toContain('const unsigned char g_CityTiles_Patterns[] =')
    expect(header).toContain('const unsigned char g_CityTiles_Colors[] =')
    // -nodate is forced, so re-running produces identical bytes.
    expect(header).not.toMatch(/ on \w{3} \w{3}/)

    const first = readFileSync(join(root, 'content/city_tiles.h'))
    expect((await runImgRule(root, REAL_MSXGL, rule, { force: true })).status).toBe('converted')
    expect(readFileSync(join(root, 'content/city_tiles.h'))).toEqual(first)

    // …and it is mtime-skipped on the next unforced run.
    expect((await runImgRule(root, REAL_MSXGL, rule)).status).toBe('skipped')
  })

  it.runIf(hasMsximg)('surfaces MSXimg failures as the rule result', async () => {
    const root = scratch('img-bad')
    writeFileSync(join(root, 'broken.png'), 'definitely not a PNG', 'utf-8')
    const result = await runImgRule(root, REAL_MSXGL, { input: 'broken.png', out: 'content/x.h', args: ['-bpc', '4'] })
    expect(result.status).toBe('failed')
    expect(result.message).toMatch(/Fail to load|Error/i)
  })
})

describe('exportAll', () => {
  it('runs resources then imgRules, and the second pass converts nothing', async () => {
    const root = scratch('exportall')
    writeTileset(root, 'art/hero.tiles.json', 'content/hero.h')
    writeTileset(root, 'art/enemy.tiles.json', 'content/enemy.h')

    const rules: ImgRule[] = hasMsximg
      ? [{ input: 'assets/city.png', out: 'content/city.h', args: ['-mode', 'gm2', '-name', 'g_City', '-pos', '0', '256', '-size', '64', '64'] }]
      : []
    if (rules.length) {
      mkdirSync(join(root, 'assets'), { recursive: true })
      writeFileSync(join(root, 'assets/city.png'), readFileSync(SAMPLE_PNG))
    }

    const first = await exportAll(root, fakeProject(rules), { msxglPath: REAL_MSXGL })
    expect(first.filter((result) => result.status === 'converted')).toHaveLength(2 + rules.length)
    expect(first.filter((result) => result.status === 'failed')).toEqual([])
    expect(summarize(first)).toBe(`Resources: ${2 + rules.length} converted, 0 up to date, 0 failed.`)

    // The acceptance criterion: nothing dirty ⇒ zero conversions.
    const second = await exportAll(root, fakeProject(rules), { msxglPath: REAL_MSXGL })
    expect(second.filter((result) => result.status === 'converted')).toEqual([])
    expect(second.every((result) => result.status === 'skipped')).toBe(true)

    // Dirty one source ⇒ exactly one conversion.
    backdate(join(root, 'content/hero.h'), 60)
    const third = await exportAll(root, fakeProject(rules), { msxglPath: REAL_MSXGL })
    expect(third.filter((result) => result.status === 'converted').map((result) => result.input)).toEqual([
      'art/hero.tiles.json'
    ])
  })

  it('reports imgRules as failed when MSXgl is not configured', async () => {
    const root = scratch('exportall-nomsxgl')
    const results = await exportAll(root, fakeProject([{ input: 'a.png', out: 'b.h', args: [] }]), { msxglPath: null })
    expect(results[0]).toMatchObject({ kind: 'imgRule', status: 'failed' })
    expect(results[0].message).toMatch(/MSXgl is not configured/)
  })

  it('does nothing for a project with no resources and no rules', async () => {
    expect(await exportAll(scratch('empty'), fakeProject())).toEqual([])
  })
})

// ── the real thing: generated headers must actually compile ─────────────────

describe('generated headers compile into a ROM', () => {
  /** A wizard-created project whose `main.c` includes and references `header`. */
  function projectUsing(name: string, header: string, symbols: string[]): OpenProject {
    const location = scratch(`compile-${name}`)
    const opened = createProject(
      { name, location, machine: '1', target: 'ROM_32K', libModules: ['system', 'bios', 'vdp', 'memory'] },
      REAL_MSXGL
    )
    const uses = symbols.map((symbol) => `\tsum += ${symbol}[0];`).join('\n')
    writeFileSync(
      join(opened.root, 'main.c'),
      `#include "msxgl.h"\n#include "${header}"\n\nvoid main()\n{\n\tu16 sum = 0;\n${uses}\n\tVDP_SetColor((u8)sum);\n\twhile(1) Halt();\n}\n`,
      'utf-8'
    )
    return { ...opened, ...saveProject(opened.root, opened.projectFile, opened.project) }
  }

  /** Builds `open` with the real BuildService and returns the outcome plus its output. */
  async function build(open: OpenProject): Promise<{ ok: boolean; rom: string; log: string }> {
    const lines: string[] = []
    const deps: BuildDeps = {
      getProject: () => open,
      // What ProjectService does before a build: rewrite the config, which is
      // where the exporter's generated .c files get listed for compilation.
      prepare: () =>
        writeGeneratedConfig(open.root, open.projectFile, open.project, generatedSourceModules(open.root)),
      exportResources: () => exportAll(open.root, open.project, { msxglPath: REAL_MSXGL }),
      msxglPath: () => REAL_MSXGL,
      nodeOverride: () => null,
      openmsxPath: () => null,
      emit: (channel, payload) => {
        if (channel === 'build:output') lines.push(...(payload as IpcEvents['build:output']).lines)
      },
      openExternal: async () => {}
    }
    const service = new BuildService(deps)
    try {
      const result = await service.start('build')
      return { ok: result.ok, rom: result.artifacts.map((a) => a.path).join(','), log: lines.join('\n') }
    } finally {
      service.dispose()
    }
  }

  it.runIf(runsBuilds)(
    'compiles a header produced by an imgRule (real MSXimg → #include → ROM)',
    async () => {
      const open = projectUsing('imgrom', 'content/city_tiles.h', [
        'g_CityTiles_Names',
        'g_CityTiles_Patterns',
        'g_CityTiles_Colors'
      ])
      mkdirSync(join(open.root, 'assets'), { recursive: true })
      writeFileSync(join(open.root, 'assets/city.png'), readFileSync(SAMPLE_PNG))
      open.project.resources.imgRules = [
        {
          input: 'assets/city.png',
          out: 'content/city_tiles.h',
          args: ['-mode', 'gm2', '-name', 'g_CityTiles', '-pos', '0', '256', '-size', '192', '144', '-offset', '0']
        }
      ]
      saveProject(open.root, open.projectFile, open.project)

      const result = await build(open)
      expect(existsSync(join(open.root, 'content/city_tiles.h')), result.log).toBe(true)
      expect(result.ok, result.log).toBe(true)
      expect(result.rom).toContain('emul/rom/imgrom.rom')
      expect(statSync(join(open.root, 'emul/rom/imgrom.rom')).size).toBe(32768)
      // The build's own output shows the conversion it ran.
      expect(result.log).toContain('Converted assets/city.png → content/city_tiles.h')
    },
    BUILD_TIMEOUT
  )

  it.runIf(runsBuilds)(
    'compiles a header produced by emitC (tileset resource → #include → ROM)',
    async () => {
      const open = projectUsing('tilerom', 'content/hero.h', ['g_Hero_Patterns', 'g_Hero_Colors'])
      writeTileset(open.root, 'art/hero.tiles.json', 'content/hero.h')

      const result = await build(open)
      expect(existsSync(join(open.root, 'content/hero.h')), result.log).toBe(true)
      expect(result.ok, result.log).toBe(true)
      expect(statSync(join(open.root, 'emul/rom/tilerom.rom')).size).toBe(32768)
      expect(result.log).toContain('Converted art/hero.tiles.json → content/hero.h + content/hero.c')
    },
    BUILD_TIMEOUT
  )
})
