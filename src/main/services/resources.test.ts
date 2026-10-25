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
import { normalizeTileAnim } from '../../shared/msx/tile-anim'
import { normalizeOwnedMeta } from '../../shared/msx/meta-owned'
import { normalizeMap } from '../../shared/msx/map'
import { normalizeSwSprites, type SwMode } from '../../shared/msx/swsprite'
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
  generatedSourceModules,
  swSpriteOverlapProblems
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
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
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
    expect(findResourceFiles(join(tmpdir(), 'definitely-not-here-msxdevstudio'))).toEqual([])
  })
})

describe('exports that read other files', () => {
  const ANIM = 'res/coin.anim-tiles.json'
  const TILESET = 'res/main.tiles.json'

  /** A 1×1, four-pose animation whose first pose's rows are all `first`. */
  function writeAnim(root: string, first = 0x18): void {
    const doc = normalizeTileAnim({
      mode: 'sc2',
      frames: [first, 0x3c, 0x7e, 0x3c].map((mark) => ({ tiles: [{ pattern: new Array(8).fill(mark), color: new Array(8).fill(0xb5) }], duration: 10 })),
      export: defaultExport(ANIM)
    })
    mkdirSync(join(root, 'res'), { recursive: true })
    writeFileSync(join(root, ANIM), serializeResource({ kind: 'anim', doc }), 'utf-8')
  }

  /** A tileset with the animation attached at slot 2 — and, on disk, stale art in the window. */
  function writeAnimatedTileset(root: string): void {
    const doc = normalizeTiles({
      mode: 'sc2',
      count: 4,
      animations: [{ path: ANIM, slot: 2, bank: null, name: 'g_CoinAnim', width: 1, height: 1, frames: 4, colorsVary: false, loop: 'loop' }],
      export: { ...defaultExport(TILESET), helpers: true }
    })
    mkdirSync(join(root, 'res'), { recursive: true })
    writeFileSync(join(root, TILESET), serializeResource({ kind: 'tiles', doc }), 'utf-8')
  }

  const setTime = (root: string, relative: string, seconds: number): void => utimesSync(join(root, relative), seconds, seconds)

  it("writes the animation's first pose into the window, whatever the tileset file says", () => {
    const root = scratch('anim-refresh')
    writeAnim(root)
    writeAnimatedTileset(root)
    expect(exportResourceFile(root, TILESET).status).toBe('converted')
    const source = readFileSync(join(root, 'content/main_tiles.c'), 'utf-8')
    // Tile 2's eight pattern rows are the coin's first pose, not the blank the file holds.
    expect(source).toMatch(/(\t0x18, \/\* \.\.\.##\.\.\. \*\/\n){8}/)
    const header = readFileSync(join(root, 'content/main_tiles.h'), 'utf-8')
    expect(header).toContain('void g_MainTiles_Animate(void);')
    expect(source).toContain('VDP_LoadPattern_GM2(g_CoinAnim_Patterns + (u16)frame * 8, 1, 2);')
  })

  it('re-exports the tileset when only the animation changed', () => {
    const root = scratch('anim-dep')
    writeAnim(root)
    writeAnimatedTileset(root)
    expect(exportResourceFile(root, TILESET).status).toBe('converted')
    // Everything the same age; then the animation is saved again, alone.
    for (const file of [TILESET, ANIM, 'content/main_tiles.h', 'content/main_tiles.c']) setTime(root, file, 1_000_000)
    expect(exportResourceFile(root, TILESET).status).toBe('skipped')
    writeAnim(root, 0xff)
    setTime(root, ANIM, 2_000_000)
    expect(exportResourceFile(root, TILESET).status).toBe('converted')
    expect(readFileSync(join(root, 'content/main_tiles.c'), 'utf-8')).toContain('0xFF, /* ######## */')
  })

  it('fails, naming the file, when an attached animation is missing', () => {
    const root = scratch('anim-missing')
    writeAnimatedTileset(root)
    const result = exportResourceFile(root, TILESET)
    expect(result.status).toBe('failed')
    expect(result.message).toContain('res/coin.anim-tiles.json is attached but missing')
  })

  it("re-exports a map when only a meta it places changed — the mirror it keeps of the meta's size and flags", () => {
    const root = scratch('meta-dep')
    mkdirSync(join(root, 'res'), { recursive: true })
    const art = { pattern: new Array(8).fill(0x81), color: new Array(8).fill(0xf1) }
    const meta = normalizeOwnedMeta({ version: 3, mode: 'sc2', width: 1, height: 1, frames: [{ tiles: [art] }], export: defaultExport('res/rock.meta-tiles.json') })
    writeFileSync(join(root, 'res/rock.meta-tiles.json'), serializeResource({ kind: 'metatiles', doc: meta }), 'utf-8')
    const tiles = normalizeTiles({
      mode: 'sc2',
      count: 2,
      tiles: [{ pattern: new Array(8).fill(0), color: new Array(8).fill(0) }, art],
      metas: [{ path: 'res/rock.meta-tiles.json', name: 'g_RockMetatiles', width: 1, height: 1, flags: 0, frames: 1, cells: [1] }]
    })
    writeFileSync(join(root, TILESET), serializeResource({ kind: 'tiles', doc: tiles }), 'utf-8')
    const map = normalizeMap({
      tileset: TILESET,
      width: 4,
      height: 4,
      metas: [{ path: 'res/rock.meta-tiles.json', name: 'g_RockMetatiles', width: 1, height: 1, frames: 1, flags: 0, cells: [1] }],
      layers: [{ name: 'bg', data: new Array(16).fill(0), placements: [{ slot: 0, x: 1, y: 1 }] }],
      export: { ...defaultExport('res/level.map.json'), helpers: true }
    })
    writeFileSync(join(root, 'res/level.map.json'), serializeResource({ kind: 'map', doc: map }), 'utf-8')
    expect(exportResourceFile(root, 'res/level.map.json').status).toBe('converted')
    for (const file of ['res/level.map.json', 'content/level_map.h', 'content/level_map.c']) setTime(root, file, 1_000_000)
    setTime(root, 'res/rock.meta-tiles.json', 1_000_000)
    // A map that places metas also reads its tileset — see the test below.
    setTime(root, TILESET, 1_000_000)
    expect(exportResourceFile(root, 'res/level.map.json').status).toBe('skipped')

    // New flags, saved in the meta editor; the map file is not touched.
    writeFileSync(join(root, 'res/rock.meta-tiles.json'), serializeResource({ kind: 'metatiles', doc: { ...meta, flags: 0x40 } }), 'utf-8')
    setTime(root, 'res/rock.meta-tiles.json', 2_000_000)
    expect(exportResourceFile(root, 'res/level.map.json').status).toBe('converted')
    expect(readFileSync(join(root, 'content/level_map.c'), 'utf-8')).toMatch(/g_LevelMap_MetaInfo\[\]\s*=\s*\{[^}]*0x01,\s*0x01,\s*0x40/s)
  })
})

describe('meta-tiles that own their pixels, exported from the files alone', () => {
  const TILESET = 'res/main.tiles.json'
  const ROCK = 'res/rock.meta-tiles.json'
  const LEVEL = 'res/level.map.json'
  const setTime = (root: string, relative: string, seconds: number): void => utimesSync(join(root, relative), seconds, seconds)
  const entry = (mark: number): { pattern: number[]; color: number[] } => ({ pattern: new Array(8).fill(mark), color: new Array(8).fill(0xf1) })

  /** A 2×1 rock, its right half see-through; or, with `poses`, a left half that changes. */
  function writeRock(root: string, mark = 0x81, poses = 1, out: string | null = 'content/rock_meta.h'): void {
    const doc = normalizeOwnedMeta({
      version: 3,
      mode: 'sc2',
      width: 2,
      height: 1,
      holes: [false, true],
      frames: Array.from({ length: poses }, (_, pose) => ({ tiles: [entry(mark + pose), entry(0)] })),
      flags: 1,
      export: out ? { ...defaultExport(ROCK), out } : null
    })
    mkdirSync(join(root, 'res'), { recursive: true })
    writeFileSync(join(root, ROCK), serializeResource({ kind: 'metatiles', doc }), 'utf-8')
  }

  /** A tileset with the rock attached — and, on disk, whatever cells it was given. */
  function writeTilesetWithRock(root: string, cells: number[] = [3, 0]): void {
    const doc = normalizeTiles({
      mode: 'sc2',
      count: 4,
      tiles: [entry(0), entry(1), entry(2), entry(0x81)],
      metas: [{ path: ROCK, name: 'g_RockMeta', width: 2, height: 1, flags: 1, frames: 1, cells }],
      export: { ...defaultExport(TILESET), helpers: true }
    })
    writeFileSync(join(root, TILESET), serializeResource({ kind: 'tiles', doc }), 'utf-8')
  }

  function writeLevel(root: string): void {
    const map = normalizeMap({
      tileset: TILESET,
      width: 4,
      height: 4,
      // Stale on purpose: a version-2 shaped mirror, no cells.
      metas: [{ path: ROCK, name: 'g_RockMeta', width: 2, height: 1, frames: 1, flags: 1 }],
      layers: [{ name: 'bg', data: new Array(16).fill(1), placements: [{ slot: 0, x: 1, y: 1 }] }],
      export: { ...defaultExport(LEVEL), helpers: true }
    })
    writeFileSync(join(root, LEVEL), serializeResource({ kind: 'map', doc: map }), 'utf-8')
  }

  it("the tileset states the meta's tiles, as the meta's art resolves them now", () => {
    const root = scratch('owned-tiles')
    writeRock(root, 0x99)
    writeTilesetWithRock(root)
    expect(exportResourceFile(root, TILESET).status).toBe('converted')
    const source = readFileSync(join(root, 'content/main_tiles.c'), 'utf-8')
    // Tile 3 no longer shows the rock; the export gives it a new tile 4 holding 0x99.
    expect(source).toMatch(/g_MainTiles_MetaCells\[\] =\n\{\n\t0x04, 0x00,/)
    expect(source).toMatch(/(\t0x99, \/\* #\.\.##\.\.# \*\/\n){8}/)
    expect(readFileSync(join(root, 'content/main_tiles.h'), 'utf-8')).toContain('#define G_MAINTILES_META_ROCK 0')
  })

  it("a map draws the meta with the same tiles the tileset's export gave it", () => {
    const root = scratch('owned-map')
    writeRock(root, 0x99)
    writeTilesetWithRock(root)
    writeLevel(root)
    expect(exportResourceFile(root, LEVEL).status).toBe('converted')
    const source = readFileSync(join(root, 'content/level_map.c'), 'utf-8')
    expect(source).toMatch(/g_LevelMap_MetaCells\[\] =\n\{\n\t0x04, 0x00,/)
    expect(source).not.toContain('extern const u8 g_RockMeta[]')
  })

  it('re-exports the map when only the tileset changed', () => {
    const root = scratch('owned-map-dep')
    writeRock(root)
    writeTilesetWithRock(root)
    writeLevel(root)
    expect(exportResourceFile(root, LEVEL).status).toBe('converted')
    for (const file of [TILESET, ROCK, LEVEL, 'content/level_map.h', 'content/level_map.c']) setTime(root, file, 1_000_000)
    expect(exportResourceFile(root, LEVEL).status).toBe('skipped')
    setTime(root, TILESET, 2_000_000)
    expect(exportResourceFile(root, LEVEL).status).toBe('converted')
  })

  it('re-exports the tileset when only the meta changed', () => {
    const root = scratch('owned-tiles-dep')
    writeRock(root)
    writeTilesetWithRock(root)
    expect(exportResourceFile(root, TILESET).status).toBe('converted')
    for (const file of [TILESET, ROCK, 'content/main_tiles.h', 'content/main_tiles.c']) setTime(root, file, 1_000_000)
    expect(exportResourceFile(root, TILESET).status).toBe('skipped')
    writeRock(root, 0x7e)
    setTime(root, ROCK, 2_000_000)
    expect(exportResourceFile(root, TILESET).status).toBe('converted')
  })

  it('an animated meta gives the tileset a window its _Animate() plays from the meta’s header', () => {
    const root = scratch('owned-anim')
    writeRock(root, 0x81, 3)
    writeTilesetWithRock(root)
    expect(exportResourceFile(root, TILESET).status).toBe('converted')
    const source = readFileSync(join(root, 'content/main_tiles.c'), 'utf-8')
    expect(source).toContain('extern const u8 g_RockMetatiles_Patterns[];')
    expect(exportResourceFile(root, ROCK).status).toBe('converted')
    expect(readFileSync(join(root, 'content/rock_meta.c'), 'utf-8')).toContain('g_RockMetatiles_Patterns[]')
  })

  it('fails when an animated meta has nowhere to write its poses', () => {
    const root = scratch('owned-anim-noexport')
    writeRock(root, 0x81, 3, null)
    writeTilesetWithRock(root)
    const result = exportResourceFile(root, TILESET)
    expect(result.status).toBe('failed')
    expect(result.message).toMatch(/animates, and its poses are written to its own header/)
  })

  it('fails, naming the file, when an attached meta is missing', () => {
    const root = scratch('owned-missing')
    mkdirSync(join(root, 'res'), { recursive: true })
    writeTilesetWithRock(root)
    const result = exportResourceFile(root, TILESET)
    expect(result.status).toBe('failed')
    expect(result.message).toContain('res/rock.meta-tiles.json is attached but missing')
  })

  it('a map placing a meta its tileset does not have attached says so', () => {
    const root = scratch('owned-unattached')
    writeRock(root)
    writeFileSync(join(root, TILESET), serializeResource({ kind: 'tiles', doc: normalizeTiles({ mode: 'sc2', count: 4 }) }), 'utf-8')
    writeLevel(root)
    const result = exportResourceFile(root, LEVEL)
    expect(result.status).toBe('failed')
    expect(result.message).toMatch(/is not attached to res\/main\.tiles\.json/)
  })
})

describe('exportResourceFile', () => {
  it("exports a closed map in its tileset's current numbering, but only a stamped one", () => {
    const root = scratch('reorder-replay')
    writeTileset(root, 'res/hero.tiles.json')
    const path = join(root, 'res/hero.tiles.json')
    // Tiles 0 and 1 swapped after the map last saw the log.
    const swap = Array.from({ length: 256 }, (_, i) => (i === 0 ? 1 : i === 1 ? 0 : i))
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf-8')), reorderLog: [{ path: 'res/hero.tiles.json', mapping: swap, at: 20 }] }))
    const map = normalizeMap({
      tileset: 'res/hero.tiles.json',
      width: 2,
      height: 1,
      layers: [{ name: 'bg', data: [0, 1] }],
      export: defaultExport('res/level.map.json')
    })
    const exported = (seen: number | null): string => {
      const content = JSON.parse(serializeResource({ kind: 'map', doc: map }))
      if (seen !== null) content.tilesetReorderSeen = seen
      writeFileSync(join(root, 'res/level.map.json'), JSON.stringify(content))
      exportResourceFile(root, 'res/level.map.json', { force: true })
      return readFileSync(join(root, 'content/level_map.c'), 'utf-8')
    }
    const asWritten = exported(null)
    expect(exported(20)).toBe(asWritten)
    const replayed = exported(10)
    expect(replayed).not.toBe(asWritten)
    expect(replayed.replace(/0x01, 0x00/, '0x00, 0x01')).toBe(asWritten)
  })

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

/**
 * The mirror a map keeps of the metas it places, refreshed at export time.
 *
 * These export **without opening the map in the editor**, which is the common
 * case and the one that was broken: a fresh clone, a CI build, or an agent
 * editing `res/` JSON by hand all reach the exporter with whatever the file
 * last said. The editor's own re-sync never runs on that path.
 */
describe('exporting a map whose meta mirror is stale', () => {
  const solid = { pattern: new Array(8).fill(0x81), color: new Array(8).fill(0xf1) }
  /**
   * A tileset with a 2×3 meta attached, the meta itself, and a map placing it
   * with the mirror it had before the meta grew: 2×2, no flags, other tiles.
   */
  function project(root: string, mirrorCells: number[] | undefined): void {
    mkdirSync(join(root, 'res'), { recursive: true })
    const tiles = normalizeTiles({
      mode: 'sc2',
      count: 4,
      tiles: [{ pattern: new Array(8).fill(0), color: new Array(8).fill(0) }, solid, solid, solid],
      metas: [{ path: 'res/ground_rocks.meta-tiles.json', name: 'g_GroundRocksMetatiles', width: 2, height: 3, flags: 1, frames: 1, cells: [3, 3, 3, 3, 3, 3] }],
      export: defaultExport('res/main.tiles.json')
    })
    writeFileSync(join(root, 'res/main.tiles.json'), serializeResource({ kind: 'tiles', doc: tiles }))
    const meta = normalizeOwnedMeta({
      version: 3,
      mode: 'sc2',
      width: 2,
      height: 3,
      frames: [{ tiles: new Array(6).fill(solid) }],
      flags: 0x01,
      export: defaultExport('res/ground_rocks.meta-tiles.json')
    })
    writeFileSync(join(root, 'res/ground_rocks.meta-tiles.json'), serializeResource({ kind: 'metatiles', doc: meta }))
    writeFileSync(
      join(root, 'res/level.map.json'),
      JSON.stringify({
        version: 1,
        tileset: 'res/main.tiles.json',
        width: 8,
        height: 8,
        metas: [{ path: 'res/ground_rocks.meta-tiles.json', name: 'g_GroundRocksMetatiles', width: 2, height: 2, frames: 1, flags: 0, ...(mirrorCells ? { cells: mirrorCells } : {}) }],
        layers: [{ name: 'background', placements: [{ slot: 0, x: 1, y: 1 }] }],
        export: { name: 'g_LevelMap', format: 'c', out: 'content/level_map.h', helpers: true }
      })
    )
  }

  it('refreshes the size, flags and tiles, so _MetaInfo and _MetaCells describe the meta as it is now', () => {
    const root = scratch('stale-size')
    project(root, [1, 2, 1, 2])
    expect(exportResourceFile(root, 'res/level.map.json')).toMatchObject({ status: 'converted' })
    const source = readFileSync(join(root, 'content/level_map.c'), 'utf-8')
    // 2x3 and flags 0x01, from the meta file — not the 2x2 / flags 0 the map held.
    expect(source).toMatch(/g_LevelMap_MetaInfo\[\]\s*=\s*\{[^}]*0x02,\s*0x03,\s*0x01/s)
    // Its tiles, from its attachment to the tileset: still tile 3, which shows its art.
    expect(source).toMatch(/g_LevelMap_MetaCells\[\]\s*=\s*\{\s*0x03,\s*0x03,\s*0x03,\s*0x03,\s*0x03,\s*0x03/s)
  })

  it('keeps the mirror when the meta file is gone, so the map still exports what it last drew', () => {
    const root = scratch('missing-meta')
    project(root, [3, 3, 3, 3])
    rmSync(join(root, 'res/ground_rocks.meta-tiles.json'))
    expect(exportResourceFile(root, 'res/level.map.json')).toMatchObject({ status: 'converted' })
    // The tileset is where the missing file is reported.
    expect(exportResourceFile(root, 'res/main.tiles.json').message).toContain('is attached but missing')
  })

  it('leaves a map that places nothing exactly as it was', () => {
    const root = scratch('no-metas')
    writeTileset(root, 'res/main.tiles.json')
    mkdirSync(join(root, 'res'), { recursive: true })
    writeFileSync(
      join(root, 'res/plain.map.json'),
      JSON.stringify({
        version: 1,
        tileset: 'res/main.tiles.json',
        width: 4,
        height: 4,
        export: { name: 'g_Plain', format: 'c', out: 'content/plain.h', helpers: true }
      })
    )
    exportResourceFile(root, 'res/plain.map.json')
    const source = readFileSync(join(root, 'content/plain.c'), 'utf-8')
    expect(source).not.toContain('_MetaInfo')
    expect(source).not.toContain('DrawPlacements')
  })
})

describe('exporting a map whose tileset is banked', () => {
  /** A 2-tile sc2 tileset where bank 1 overrides tile 0 — `isBanked` reads true. */
  function writeBankedTileset(root: string, relative: string): void {
    const solid = (byte: number) => ({
      pattern: new Array(8).fill(byte),
      color: new Array(8).fill(mergeColorByte(15, 4))
    })
    const doc = normalizeTiles({
      mode: 'sc2',
      count: 2,
      tiles: [solid(0x18), solid(0x3c)],
      bankTiles: [[], [solid(0xff)], []]
    })
    doc.export = { ...defaultExport(relative), name: 'g_Hero', out: 'content/hero.h' }
    mkdirSync(join(root, relative, '..'), { recursive: true })
    writeFileSync(join(root, relative), serializeResource({ kind: 'tiles', doc }), 'utf-8')
  }

  function writeMap(root: string, height: number): void {
    mkdirSync(join(root, 'res'), { recursive: true })
    writeFileSync(
      join(root, 'res/level.map.json'),
      JSON.stringify({
        version: 1,
        tileset: 'res/main.tiles.json',
        width: 32,
        height,
        export: { name: 'g_LevelMap', format: 'c', out: 'content/level_map.h' }
      })
    )
  }

  it('fails the export when the map is not 24 rows tall', () => {
    const root = scratch('banked-tall')
    writeBankedTileset(root, 'res/main.tiles.json')
    writeMap(root, 48)

    const result = exportResourceFile(root, 'res/level.map.json')
    expect(result.status).toBe('failed')
    expect(result.message).toMatch(/24 rows/)
  })

  it('exports cleanly at exactly 24 rows, the mirror case', () => {
    const root = scratch('banked-24')
    writeBankedTileset(root, 'res/main.tiles.json')
    writeMap(root, 24)

    expect(exportResourceFile(root, 'res/level.map.json')).toMatchObject({ status: 'converted' })
  })
})

/**
 * Defect A: a software sprite in a pattern mode reserves pattern indices
 * 192-255 at runtime (`swsprite.ts`'s own `_FIRST_PATTERN`), and
 * `VDP_LoadPattern_GM2` writes that reservation into all three banks. A
 * tileset whose art reaches that far — a bank's own override or the shared
 * (meta-tile) region, which is allocated downward from 255 and so always
 * does — has that art silently overwritten the instant a sprite loads. Never
 * shown before this check: neither `validateTiles` nor `validateSwSprites`
 * can see the other's file.
 */
describe('swSpriteOverlapProblems — software sprites vs. the shared/banked pattern range', () => {
  /** A tiled-mode (sc1/sc2/sc4) swsprites resource — the family that actually reserves 192-255. */
  function writeSwSprites(root: string, relative: string, mode: SwMode = 'sc2'): void {
    const doc = normalizeSwSprites({ mode, sprites: [{ name: 'hero' }] })
    mkdirSync(join(root, relative, '..'), { recursive: true })
    writeFileSync(join(root, relative), serializeResource({ kind: 'swsprites', doc }), 'utf-8')
  }

  /**
   * A banked tileset carrying meta-tile art: bank lengths deliberately
   * uneven (2 / 0 / 5) and a non-zero shared region — a fixture uniform
   * across banks would not have caught the collision this checks for.
   */
  function writeBankedTilesetWithMetas(root: string, relative: string): void {
    const solid = (byte: number) => ({ pattern: new Array(8).fill(byte), color: new Array(8).fill(mergeColorByte(15, 4)) })
    const doc = normalizeTiles({
      mode: 'sc2',
      count: 4,
      tiles: [solid(0x11), solid(0x22), solid(0x33), solid(0x44)],
      bankTiles: [[solid(0x55), solid(0x66)], [], [solid(0x77), solid(0x88), solid(0x99), solid(0xaa), solid(0xbb)]],
      sharedTiles: 6
    })
    doc.export = { ...defaultExport(relative), name: 'g_Hero', out: 'content/hero.h' }
    mkdirSync(join(root, relative, '..'), { recursive: true })
    writeFileSync(join(root, relative), serializeResource({ kind: 'tiles', doc }), 'utf-8')
  }

  it('reports a problem for sprites plus a banked tileset carrying metas — the shared region always reaches 255', () => {
    const root = scratch('overlap-banked-metas')
    writeBankedTilesetWithMetas(root, 'res/hero.tiles.json')
    writeSwSprites(root, 'res/hero.swsprites.json')

    const problems = swSpriteOverlapProblems(root)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({ kind: 'resource', input: 'res/hero.tiles.json', out: 'content/hero.h', status: 'failed' })
    expect(problems[0].message).toContain('res/hero.tiles.json')
    expect(problems[0].message).toContain('255')
    expect(problems[0].message).toContain('192-255')
  })

  it('reports nothing for sprites plus a small, plain tileset', () => {
    const root = scratch('overlap-plain')
    writeTileset(root, 'res/hero.tiles.json') // 2 tiles, unbanked, no shared region
    writeSwSprites(root, 'res/hero.swsprites.json')

    expect(swSpriteOverlapProblems(root)).toEqual([])
  })

  it('reports nothing for a banked tileset with metas when the project has no swsprites resource', () => {
    const root = scratch('overlap-no-sprites')
    writeBankedTilesetWithMetas(root, 'res/hero.tiles.json')

    expect(swSpriteOverlapProblems(root)).toEqual([])
  })

  it('reports the pre-existing unbanked case too: count alone past 192', () => {
    const root = scratch('overlap-unbanked')
    const doc = normalizeTiles({ mode: 'sc2', count: 200 })
    doc.export = { ...defaultExport('res/hero.tiles.json'), name: 'g_Hero', out: 'content/hero.h' }
    mkdirSync(join(root, 'res'), { recursive: true })
    writeFileSync(join(root, 'res/hero.tiles.json'), serializeResource({ kind: 'tiles', doc }), 'utf-8')
    writeSwSprites(root, 'res/hero.swsprites.json')

    const problems = swSpriteOverlapProblems(root)
    expect(problems).toHaveLength(1)
    expect(problems[0].message).toContain('199')
  })

  // The bank-length term of `tilesetHighestIndex` is the only one no other test
  // exercises alone: every other banked fixture reaches 192+ through its shared
  // region, so dropping the bank term entirely left them all green. A bank can
  // grow past 192 on its own — `sharedTiles` is 0 here — and that is a real
  // collision the shared-region cases would never have caught.
  it('reports a bank whose own art passes 192, with no shared region at all', () => {
    const root = scratch('overlap-bank-length')
    const solid = (byte: number) => ({
      pattern: new Array(8).fill(byte),
      color: new Array(8).fill(mergeColorByte(15, 4))
    })
    const doc = normalizeTiles({
      mode: 'sc2',
      count: 4,
      tiles: [solid(0x11), solid(0x22), solid(0x33), solid(0x44)],
      // Bank 1 alone reaches 200 entries — highest index 199. Banks deliberately
      // uneven, and the shared region empty, so only the bank term can trip this.
      bankTiles: [[solid(0x55)], Array.from({ length: 200 }, (_, i) => solid(i & 0xff)), []],
      sharedTiles: 0
    })
    doc.export = { ...defaultExport('res/hero.tiles.json'), name: 'g_Hero', out: 'content/hero.h' }
    mkdirSync(join(root, 'res'), { recursive: true })
    writeFileSync(join(root, 'res/hero.tiles.json'), serializeResource({ kind: 'tiles', doc }), 'utf-8')
    writeSwSprites(root, 'res/hero.swsprites.json')

    const problems = swSpriteOverlapProblems(root)
    expect(problems).toHaveLength(1)
    expect(problems[0].message).toContain('199')
  })

  it('reports nothing when the only swsprites resource is not a pattern-mode (tiled) one', () => {
    // sc5 sprites are blitted into VRAM, not written into the pattern table —
    // `swSpriteFamily` never emits `_FIRST_PATTERN` for them, so there is no
    // real collision to warn about.
    const root = scratch('overlap-bitmap-sprites')
    writeBankedTilesetWithMetas(root, 'res/hero.tiles.json')
    writeSwSprites(root, 'res/hero.swsprites.json', 'sc5')

    expect(swSpriteOverlapProblems(root)).toEqual([])
  })

  it('is wired into exportAll, so a real build sees it', async () => {
    const root = scratch('overlap-exportall')
    writeBankedTilesetWithMetas(root, 'res/hero.tiles.json')
    writeSwSprites(root, 'res/hero.swsprites.json')

    const results = await exportAll(root, fakeProject())
    const overlap = results.find((result) => result.status === 'failed' && result.input === 'res/hero.tiles.json')
    expect(overlap?.message).toContain('192-255')
    // The tileset's own export still happens — this is a warning, not a block.
    expect(results.some((result) => result.status === 'converted' && result.input === 'res/hero.tiles.json')).toBe(true)
  })
})
