import { describe, expect, it } from 'vitest'
import { unpackRlep } from './compress'
import { defineName, emitBin, emitC } from './emitC'
import { createMapDoc, normalizeMap } from './map'
import { normalizeMetaTile } from './meta-tile'
import { addMetaRef, placeMeta, setPlacementBaked } from './map'
import { packGrb } from './palette'
import {
  RESOURCE_SUFFIXES,
  defaultExport,
  defaultTableName,
  parseResource,
  renderResourceBin,
  renderResourceFiles,
  resourceBaseName,
  resourceKindOf,
  resourceTables,
  serializeResource,
  validateResource,
  type ResourceDoc
} from './resource'
import {
  blankConverted,
  decodeIndices,
  encodeIndices,
  normalizeScreen,
  packBitmap,
  palettePairBytes,
  screenPixels,
  type ScreenDoc
} from './screen'
import { normalizeBitmapTiles } from './bitmap-tile'
import { sc3Offset } from './sc3'
import { decodeAyfxBank, normalizeSfx, SFX_PRESETS, type SfxDoc } from './sfx'
import { createSpritesDoc } from './sprite'
import { addLayer, setCharacterGrid } from '../sprite-editor'
import { createBlock } from '../tile-editor'
import { createTilesDoc, mergeColorByte, normalizeTiles, type TileEntry, type TilesDoc } from './tile'

/**
 * Both halves of a C export as one string. Most assertions here care that a
 * line was emitted at all, not which of the two files it landed in — the tests
 * that do care about the split say so explicitly.
 */
function rendered(...args: Parameters<typeof renderResourceFiles>): string {
  const files = renderResourceFiles(...args)
  return `${files.header ?? ''}\n${files.source ?? ''}`
}

/** A small, fully specified tileset so the emitted bytes are predictable. */
function fixtureTiles(): ResourceDoc {
  return {
    kind: 'tiles',
    doc: normalizeTiles({
      mode: 'sc2',
      count: 2,
      tiles: [
        { pattern: [0x00, 0x7e, 0x81, 0xa5, 0x81, 0xbd, 0x42, 0x3c], color: new Array(8).fill(mergeColorByte(15, 1)) },
        { pattern: [0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00], color: new Array(8).fill(mergeColorByte(6, 4)) }
      ]
    })
  }
}

describe('emitCHeader', () => {
  it('is byte-stable across runs — no dates, no absolute paths', () => {
    const options = {
      name: 'g_Fixture',
      tables: resourceTables(fixtureTiles()),
      notes: ['Source: art/fixture.tiles.json'],
      defines: true
    }
    const first = emitC(options)
    const second = emitC({ ...options, tables: resourceTables(fixtureTiles()) })
    expect(second).toEqual(first)
    for (const text of [first.header, first.source]) {
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}/)
      expect(text).not.toMatch(/\/home\/|[A-Z]:\\/)
    }
  })

  it('writes MSXgl-style tables with per-byte art and a size comment', () => {
    const { header, source: text } = emitC({
      name: 'g_Test',
      headerFile: 'test.h',
      tables: [{ suffix: '_Patterns', bytes: Uint8Array.from([0x7e, 0x00]), art: true }]
    })
    // The data is in the .c; the .h only says it exists, so a second module
    // including it is not a duplicate symbol.
    expect(header).toContain('extern const unsigned char g_Test_Patterns[];')
    expect(header).not.toContain('0x7E')
    expect(text).toContain('#include "test.h"')
    expect(text).toContain('const unsigned char g_Test_Patterns[] =')
    expect(text).toContain('\t0x7E, /* .######. */')
    expect(text).toContain('\t0x00, /* ........ */')
    expect(text).toContain('// g_Test_Patterns size: 2 Bytes')
    expect(text.endsWith('\n')).toBe(true)
  })

  it('emits size defines when asked', () => {
    const { header } = emitC({
      name: 'g_Test',
      tables: [{ suffix: '', bytes: new Uint8Array(4) }],
      defines: true
    })
    expect(header).toContain('#define G_TEST_SIZE 4')
    expect(defineName('g_My-Tiles')).toBe('G_MY_TILES')
  })

  it('wraps plain tables at 16 bytes per line', () => {
    const { source } = emitC({ name: 'g_T', tables: [{ suffix: '', bytes: new Uint8Array(20) }] })
    const body = source.split('\n').filter((line: string) => line.startsWith('\t'))
    expect(body).toHaveLength(2)
    expect(body[0].split(',').filter(Boolean)).toHaveLength(16)
  })

  it('totals multi-table headers', () => {
    const { source: text } = emitC({
      name: 'g_T',
      tables: [
        { suffix: '_A', bytes: new Uint8Array(3) },
        { suffix: '_B', bytes: new Uint8Array(5) }
      ]
    })
    expect(text).toContain('// Total size: 8 Bytes')
  })
})

describe('emitBin', () => {
  it('concatenates the tables in order', () => {
    const bytes = emitBin([
      { suffix: '', bytes: Uint8Array.from([1, 2]) },
      { suffix: '', bytes: Uint8Array.from([3]) }
    ])
    expect([...bytes]).toEqual([1, 2, 3])
  })
})

describe('file naming', () => {
  it('recognises every resource suffix', () => {
    expect(resourceKindOf('art/hero.tiles.json')).toBe('tiles')
    expect(resourceKindOf('hero.sprites.json')).toBe('sprites')
    expect(resourceKindOf('levels/l1.map.json')).toBe('map')
    expect(resourceKindOf('title.screen.json')).toBe('screen')
    expect(resourceKindOf('audio/blips.sfx.json')).toBe('sfx')
    expect(resourceKindOf('main.c')).toBeNull()
    expect(resourceKindOf('notes.json')).toBeNull()
  })

  it('derives table names and default export blocks', () => {
    expect(resourceBaseName('art/city_bg.tiles.json')).toBe('city_bg')
    expect(defaultTableName('city_bg')).toBe('g_CityBg')
    // The kind is part of the default name, so a tileset and a map of the same
    // subject cannot both land on `g_CityBg` in `content/city_bg.h`.
    expect(defaultExport('art/city_bg.tiles.json')).toEqual({
      name: 'g_CityBgTiles',
      format: 'c',
      out: 'content/city_bg_tiles.h'
    })
  })
})

describe('tiles resource', () => {
  it('emits patterns then colors, sized by the mode', () => {
    const tables = resourceTables(fixtureTiles())
    expect(tables.map((table) => table.suffix)).toEqual(['_Patterns', '_Colors'])
    expect(tables[0].bytes).toHaveLength(16)
    expect(tables[1].bytes).toHaveLength(16)
    expect([...tables[0].bytes.subarray(0, 8)]).toEqual([0x00, 0x7e, 0x81, 0xa5, 0x81, 0xbd, 0x42, 0x3c])
  })

  it('emits one color byte per group for sc1', () => {
    const tables = resourceTables({ kind: 'tiles', doc: createTilesDoc('sc1', 16) })
    expect(tables[0].bytes).toHaveLength(128)
    expect(tables[1].bytes).toHaveLength(2)
  })

  it('appends a palette table on sc4', () => {
    const doc = createTilesDoc('sc4', 1)
    doc.palette = new Array(16).fill(packGrb(7, 0, 0))
    const tables = resourceTables({ kind: 'tiles', doc })
    expect(tables.map((table) => table.suffix)).toEqual(['_Patterns', '_Colors', '_Palette'])
    expect(tables[2].bytes).toHaveLength(32)
    expect([...tables[2].bytes.subarray(0, 2)]).toEqual([0x70, 0x00]) // [0RRR0BBB][00000GGG]
  })

  it('appends a flags table only once a tile carries a bit', () => {
    const doc = createTilesDoc('sc2', 4)
    expect(resourceTables({ kind: 'tiles', doc }).map((t) => t.suffix)).toEqual(['_Patterns', '_Colors'])

    doc.flags[2] = 0b0000_0101
    const tables = resourceTables({ kind: 'tiles', doc })
    expect(tables.map((t) => t.suffix)).toEqual(['_Patterns', '_Colors', '_Flags'])
    // One byte per tile, so the game can index it straight with a tile id.
    expect([...tables[2].bytes]).toEqual([0, 0, 0b101, 0])
  })

  it('emits a blocks table with per-block offsets, and the stamper on request', () => {
    const doc = createBlock(createTilesDoc('sc2', 2), 'door', 2, 3)
    const resource: ResourceDoc = { kind: 'tiles', doc }
    const tables = resourceTables(resource)
    expect(tables.map((t) => t.suffix)).toEqual(['_Patterns', '_Colors', '_Blocks'])
    expect([...tables[2].bytes]).toEqual([2, 3, 4, 5, 6, 7]) // row-major tile ids

    const block = defaultExport('scenery.tiles.json')
    const plain = rendered(resource, 'scenery.tiles.json', block)
    expect(plain).toContain('#define G_SCENERYTILES_DOOR_BASE 0')
    expect(plain).toContain('#define G_SCENERYTILES_DOOR_W 2')
    expect(plain).toContain('#define G_SCENERYTILES_DOOR_H 3')
    expect(plain).not.toContain('DrawBlock')

    const withCode = rendered(resource, 'scenery.tiles.json', { ...block, helpers: true })
    // Prototype in the header, body in the source: a `static` definition in a
    // header would give every module including it its own copy.
    const files = renderResourceFiles(resource, 'scenery.tiles.json', { ...block, helpers: true })
    expect(files.header).toContain('void g_SceneryTiles_DrawBlock(u8 x, u8 y, u16 base, u8 w, u8 h);')
    expect(files.source).toContain('void g_SceneryTiles_DrawBlock(u8 x, u8 y, u16 base, u8 w, u8 h)')
    expect(files.source).not.toContain('static void g_SceneryTiles_DrawBlock')
    expect(withCode).toContain('VDP_WriteLayout_GM2(g_SceneryTiles_Blocks + base, x, y, w, h);')
  })

  it('round-trips through JSON', () => {
    const resource = fixtureTiles()
    const reparsed = parseResource('x.tiles.json', serializeResource(resource))
    expect(reparsed).toEqual(resource)
    expect(validateResource(reparsed)).toEqual([])
  })

  it('renders a C header naming its source, not an absolute path', () => {
    const text = rendered(fixtureTiles(), 'art/fixture.tiles.json', defaultExport('art/fixture.tiles.json'))
    expect(text).toContain('//  - Source: art/fixture.tiles.json')
    expect(text).toContain('//  - Mode: SCREEN 2 (GRAPHIC 2)')
    expect(text).toContain('const unsigned char g_FixtureTiles_Patterns[] =')
  })

  it('renders bin as the raw concatenation', () => {
    const bytes = renderResourceBin(fixtureTiles(), { name: 'g_X', format: 'bin', out: 'content/x.bin' })
    expect(bytes).toHaveLength(32)
    expect(bytes[1]).toBe(0x7e)
  })
})

/** One 2×2 metasprite of 16×16 sprites — four planes, one per cell. */
function metaResource(): ResourceDoc {
  return { kind: 'sprites', doc: setCharacterGrid(createSpritesDoc(2, 16), 0, 2, 2) }
}

describe('sprites resource', () => {
  it('emits patterns and 16-byte line colors in mode 2', () => {
    const tables = resourceTables({ kind: 'sprites', doc: createSpritesDoc(2, 16) })
    expect(tables.map((table) => table.suffix)).toEqual(['_Patterns', '_Colors'])
    expect(tables[0].bytes).toHaveLength(32)
    expect(tables[1].bytes).toHaveLength(16)
  })

  it('round-trips through the on-disk shape', () => {
    const resource: ResourceDoc = { kind: 'sprites', doc: createSpritesDoc(2, 16) }
    expect(parseResource('x.sprites.json', serializeResource(resource))).toEqual(resource)
  })

  it('adds a layout table only once a character takes several hardware sprites', () => {
    const plain = { kind: 'sprites', doc: createSpritesDoc(2, 16) } as ResourceDoc
    expect(resourceTables(plain).map((t) => t.suffix)).toEqual(['_Patterns', '_Colors'])

    // Superposition: planes stacked on one cell also need placing from one x/y.
    const stacked = { kind: 'sprites', doc: addLayer(createSpritesDoc(1, 16), 0) } as ResourceDoc
    const stackedTables = resourceTables(stacked)
    expect(stackedTables.map((t) => t.suffix)).toEqual(['_Patterns', '_Colors', '_Layout'])
    expect([...stackedTables[2].bytes]).toEqual([0, 0, 0, 0])

    const tables = resourceTables(metaResource())
    expect(tables.map((t) => t.suffix)).toEqual(['_Patterns', '_Colors', '_Layout'])
    // 2×2 grid of 16×16 sprites: one plane per cell, dx/dy in dots.
    expect([...tables[2].bytes]).toEqual([0, 0, 16, 0, 0, 16, 16, 16])
  })

  it('emits per-character offsets so one character can be addressed out of a sheet', () => {
    const text = rendered(metaResource(), 'hero.sprites.json', defaultExport('hero.sprites.json'))
    expect(text).toContain('#define G_HEROSPRITES_SPRITE_0_BASE 0')
    expect(text).toContain('#define G_HEROSPRITES_SPRITE_0_PLANES 4')
    expect(text).toContain('#define G_HEROSPRITES_SPRITE_0_FRAMES 1')
  })

  it('appends the placement helper only when the export opts in', () => {
    const block = defaultExport('hero.sprites.json')
    expect(rendered(metaResource(), 'hero.sprites.json', block)).not.toContain('g_HeroSprites_SetMeta')

    const text = rendered(metaResource(), 'hero.sprites.json', { ...block, helpers: true })
    expect(text).toContain('void g_HeroSprites_SetMeta(u8 index, u8 x, u8 y, u8 base, u8 planes)')
    // Mode 2 drives the per-line color table; 16×16 patterns step by 4.
    expect(text).toContain('VDP_SetSpriteExMultiColor(index + i, px, py, plane * 4, g_HeroSprites_Colors + ((u16)plane * 16));')
  })

  it('uses the mode-1 setter and 8×8 pattern step when that is what the sheet is', () => {
    const doc = setCharacterGrid(createSpritesDoc(1, 8), 0, 2, 1)
    const text = rendered(
      { kind: 'sprites', doc }, 'hero.sprites.json', { ...defaultExport('hero.sprites.json'), helpers: true })
    
    expect(text).toContain('VDP_SetSpriteSM1(index + i, px, py, plane * 1, g_HeroSprites_Colors[plane]);')
  })
})

describe('map resource', () => {
  it('emits one table per layer, named after the layer', () => {
    const doc = normalizeMap({
      tileset: './main.tiles.json',
      width: 4,
      height: 2,
      layers: [
        { name: 'background', data: [1, 2, 3, 4, 5, 6, 7, 8] },
        { name: 'foreground', data: [0, 1, 0, 1, 0, 1, 0, 1] }
      ]
    })
    const tables = resourceTables({ kind: 'map', doc })
    expect(tables.map((table) => table.suffix)).toEqual(['_Background', '_Foreground'])
    expect([...tables[0].bytes]).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(tables[1].comment).toContain('Names layer')
  })

  it('defaults to a single background layer of the right size', () => {
    const doc = createMapDoc('./main.tiles.json')
    expect(doc.layers).toHaveLength(1)
    expect(doc.layers[0].data).toHaveLength(32 * 24)
    expect(validateResource({ kind: 'map', doc })).toEqual([])
  })

  it('packs the layers when the export asks for it, and says what it unpacks to', () => {
    const doc = createMapDoc('./main.tiles.json')
    doc.layers[0].data.fill(3)
    const [table] = resourceTables({ kind: 'map', doc }, 'rlep')
    expect(table.unpacked).toBe(32 * 24)
    expect(table.bytes.length).toBeLessThan(40)
    expect([...unpackRlep(table.bytes)]).toEqual(doc.layers[0].data)

    const header = rendered(
      { kind: 'map', doc }, 'art/level.map.json', {
        name: 'g_Level',
        format: 'c',
        out: 'content/level.h',
        helpers: true,
        compress: 'rlep'
      })
    
    expect(header).toContain('#define G_LEVEL_BACKGROUND_UNPACKED_SIZE 768')
    expect(header).toContain('RLEp_UnpackToRAM(layer, buffer)')
  })

  it('ships the layer raw when packing it would make it bigger, helper included', () => {
    // 8 cells of alternating noise: every chunk costs more than the byte it saves.
    const doc = normalizeMap({
      tileset: './main.tiles.json',
      width: 4,
      height: 2,
      layers: [{ name: 'background', data: [1, 2, 3, 4, 5, 6, 7, 8] }]
    })
    const [table] = resourceTables({ kind: 'map', doc }, 'rlep')
    expect(table.unpacked).toBeUndefined()
    expect([...table.bytes]).toEqual([1, 2, 3, 4, 5, 6, 7, 8])

    const header = rendered(
      { kind: 'map', doc }, 'art/level.map.json', {
        name: 'g_Level',
        format: 'c',
        out: 'content/level.h',
        helpers: true,
        compress: 'rlep'
      })
    
    // The helper has to agree with the table it sits next to, or it unpacks raw bytes.
    expect(header).not.toContain('RLEp_UnpackToRAM')
    expect(header).toContain('VDP_WriteLayout_GM2(layer, x, y, G_LEVEL_W, G_LEVEL_H)')
  })

  it('draws a bitmap-mode map by copying cells out of an atlas, not by writing a name table', () => {
    const doc = normalizeMap({
      tileset: 'res/canyon.screen.json',
      width: 16,
      height: 4,
      cell: { width: 16, height: 16, cols: 16 },
      layers: [{ name: 'terrain', data: new Array(64).fill(0).map((_, i) => i) }]
    })
    expect(validateResource({ kind: 'map', doc })).toEqual([])

    const header = rendered(
      { kind: 'map', doc }, 'res/stage.map.json', {
        name: 'g_Stage',
        format: 'c',
        out: 'content/stage.h',
        helpers: true
      })

    // The cell geometry has to reach C: nothing else in the header knows it.
    expect(header).toContain('#define G_STAGE_CELL_W 16')
    expect(header).toContain('#define G_STAGE_CELL_H 16')
    expect(header).toContain('#define G_STAGE_ATLAS_COLS 16')
    expect(header).toContain('void g_Stage_DrawRow(const u8* layer, u8 row, UY atlasY, UY destY)')
    expect(header).toContain('VDP_CommandHMMM((u16)(cell % G_STAGE_ATLAS_COLS) * G_STAGE_CELL_W')
    // There is no name table in a bitmap mode — emitting one would compile and
    // draw nothing.
    expect(header).not.toContain('VDP_WriteLayout_GM2')
  })

  it('emits nothing about transparency unless the map names a cell', () => {
    const doc = normalizeMap({
      tileset: 'res/canyon.screen.json',
      width: 16,
      height: 4,
      cell: { width: 16, height: 16, cols: 16 },
      layers: [{ name: 'terrain', data: new Array(64).fill(0) }]
    })
    expect(doc.transparent).toBeNull()
    const header = rendered({ kind: 'map', doc }, 'res/stage.map.json', {
      name: 'g_Stage',
      format: 'c',
      out: 'content/stage.h',
      helpers: true
    })
    // Cell 0 is an ordinary picture, so the plain row blit must stay unguarded.
    expect(header).not.toContain('_TRANSPARENT')
    expect(header).not.toContain('_DrawRowOver')
    expect(header).not.toContain('if(cell !=')
  })

  it('adds an overlay row blit that skips the transparent cell, keeping the plain one unguarded', () => {
    const doc = normalizeMap({
      tileset: 'res/canyon.screen.json',
      width: 16,
      height: 4,
      cell: { width: 16, height: 16, cols: 16 },
      transparent: 7,
      layers: [
        { name: 'terrain', data: new Array(64).fill(0) },
        { name: 'foreground', data: new Array(64).fill(7) }
      ]
    })
    expect(validateResource({ kind: 'map', doc })).toEqual([])

    const header = rendered({ kind: 'map', doc }, 'res/stage.map.json', {
      name: 'g_Stage',
      format: 'c',
      out: 'content/stage.h',
      helpers: true
    })

    expect(header).toContain('#define G_STAGE_TRANSPARENT 7')
    expect(header).toContain('void g_Stage_DrawRowOver(const u8* layer, u8 row, UY atlasY, UY destY)')
    expect(header).toContain('if(cell != G_STAGE_TRANSPARENT)')
    // The background layer still pays no compare — that is why there are two.
    expect(header).toContain('void g_Stage_DrawRow(const u8* layer, u8 row, UY atlasY, UY destY)')
    // Skipping drops the blit, never the column: both walk the row in step, so
    // the guard has to sit on the copy alone.
    expect(header.match(/dx \+= G_STAGE_CELL_W;/g)).toHaveLength(2)
    expect(header).toContain('if(cell != G_STAGE_TRANSPARENT)\n\t\t\tVDP_CommandHMMM(')
  })

  it('flags a layered bitmap map that never said which cell is empty', () => {
    const doc = normalizeMap({
      tileset: 'res/canyon.screen.json',
      width: 16,
      height: 4,
      cell: { width: 16, height: 16, cols: 16 },
      layers: [
        { name: 'terrain', data: new Array(64).fill(0) },
        { name: 'foreground', data: new Array(64).fill(0) }
      ]
    })
    expect(validateResource({ kind: 'map', doc }).join(' ')).toContain('no transparent cell')
  })

  it('exports a plain tile map exactly as it did before meta-tiles existed', () => {
    // The additive guard: nothing about an ordinary map may move. If this ever
    // fails, a meta-tile change has leaked into the path every existing project
    // and both demos are on.
    const doc = normalizeMap({
      tileset: 'res/tiles.tiles.json',
      width: 4,
      height: 2,
      layers: [{ name: 'background', data: [1, 2, 3, 4, 5, 6, 7, 8] }]
    })
    const header = rendered({ kind: 'map', doc }, 'res/level.map.json', {
      name: 'g_Level',
      format: 'c',
      out: 'content/level.h',
      helpers: true
    })
    expect(header).toContain('#define G_LEVEL_W 4')
    expect(header).toContain('#define G_LEVEL_H 2')
    expect(header).toContain('void g_Level_DrawLayer(const u8* layer, u8 x, u8 y)')
    expect(header).toContain('VDP_WriteLayout_GM2(layer, x, y, G_LEVEL_W, G_LEVEL_H)')
    // None of the meta vocabulary may appear on a map that never asked for it.
    expect(header).not.toContain('_META_')
    expect(header).not.toContain('_TILE_W')
    expect(header).not.toContain('ExpandRow')
  })

  it('keeps a transparent cell off pattern-mode maps, which have no per-cell decision', () => {
    const doc = normalizeMap({
      tileset: 'res/tiles.tiles.json',
      transparent: 3,
      layers: [{ name: 'background', data: new Array(768).fill(0) }]
    })
    expect(doc.transparent).toBeNull()
  })

  it('rejects a cell the VDP cannot copy', () => {
    // Every bitmap mode packs at least two dots per byte, and HMMM moves bytes.
    const doc = normalizeMap({
      tileset: 'res/canyon.screen.json',
      cell: { width: 15, height: 16, cols: 16 }
    })
    expect(validateResource({ kind: 'map', doc }).join(' ')).toContain('odd')
  })
})

describe('meta-tile resource', () => {
  const tree = (): ResourceDoc => ({
    kind: 'metatiles',
    doc: normalizeMetaTile({
      tileset: 'res/tiles.tiles.json',
      width: 2,
      height: 2,
      flags: 0x05,
      // Frame 1 holds a transparent cell, which is what the run-splitting in
      // the emitted _Draw exists for.
      frames: [{ tiles: [1, 2, 3, 4] }, { tiles: [1, 0, 3, 4] }]
    })
  })

  it('emits one table at a per-frame stride, and states the geometry and flags', () => {
    const header = rendered(tree(), 'res/tree.meta-tiles.json', {
      name: 'g_Tree',
      format: 'c',
      out: 'content/tree.h',
      helpers: true
    })
    expect(header).toContain('#define G_TREE_META_W 2')
    expect(header).toContain('#define G_TREE_META_H 2')
    expect(header).toContain('#define G_TREE_CELLS 4')
    expect(header).toContain('#define G_TREE_FRAMES 2')
    expect(header).toContain('#define G_TREE_FLAGS 0x05')
    expect(header).toContain('#define G_TREE_SIZE 8')
    expect([...resourceTables(tree())[0].bytes]).toEqual([1, 2, 3, 4, 1, 0, 3, 4])
  })

  it('draws a frame as runs, skipping the transparent tile', () => {
    const header = rendered(tree(), 'res/tree.meta-tiles.json', {
      name: 'g_Tree',
      format: 'c',
      out: 'content/tree.h',
      helpers: true
    })
    expect(header).toContain('void g_Tree_Draw(u8 x, u8 y, u8 frame)')
    expect(header).toContain('const u8* src = g_Tree + ((u16)frame * G_TREE_CELLS);')
    // A name table has no holes, so transparency is a *skipped write* — which
    // means a row is one call per opaque run, not one covering the rectangle.
    expect(header).toContain('if(src[col] == 0) { ++col; continue; }')
    expect(header).toContain('VDP_WriteLayout_GM2(src + col, x + col, y + row, run - col, 1);')
  })

  it('omits the helper when the export block does not ask for it', () => {
    const header = rendered(tree(), 'res/tree.meta-tiles.json', {
      name: 'g_Tree',
      format: 'c',
      out: 'content/tree.h'
    })
    expect(header).toContain('#define G_TREE_FRAMES 2')
    expect(header).not.toContain('g_Tree_Draw')
  })

  it('stamps a bitmap meta out of the atlas instead, one HMMM per cell', () => {
    const doc = normalizeMetaTile({
      tileset: 'res/canyon.btiles.json',
      width: 2,
      height: 2,
      cell: { width: 16, height: 16, cols: 16 },
      frames: [{ tiles: [1, 2, 3, 4] }]
    })
    const header = rendered({ kind: 'metabtiles', doc }, 'res/rock.meta-btiles.json', {
      name: 'g_Rock',
      format: 'c',
      out: 'content/rock.h',
      helpers: true
    })
    expect(header).toContain('#define G_ROCK_CELL_W 16')
    expect(header).toContain('void g_Rock_Draw(UX x, UY y, u8 frame, UY atlasY)')
    expect(header).toContain('VDP_CommandHMMM((u16)(cell % G_ROCK_ATLAS_COLS) * G_ROCK_CELL_W')
    // There is no name table in a bitmap mode.
    expect(header).not.toContain('VDP_WriteLayout_GM2')
  })
})

describe('placed meta-tiles on a map', () => {
  const tree = { path: 'res/tree.meta-tiles.json', name: 'g_Tree', width: 2, height: 3, frames: 4, flags: 0x01 }
  const coin = { path: 'res/coin.meta-tiles.json', name: 'g_Coin', width: 1, height: 1, frames: 6, flags: 0x02 }

  const level = (): ResourceDoc => {
    let doc = normalizeMap({ tileset: 'res/tiles.tiles.json', width: 32, height: 24 })
    doc = addMetaRef(addMetaRef(doc, tree), coin)
    doc = placeMeta(doc, 0, 0, 4, 4)
    doc = placeMeta(doc, 0, 1, 10, 8)
    doc = setPlacementBaked(doc, 0, 1, true)
    return { kind: 'map', doc }
  }

  const block = { name: 'g_Level', format: 'c' as const, out: 'content/level.h', helpers: true }

  it('emits the placement table beside the layer tables, three bytes each', () => {
    const tables = resourceTables(level())
    const placements = tables.find((table) => table.suffix === '_Placements')!
    // slot|baked<<7, x, y — the second one is baked, so bit 7 is set.
    expect([...placements.bytes]).toEqual([0, 4, 4, 0x81, 10, 8])
  })

  it('names each meta and mirrors its flags, so a game needs no other header', () => {
    const header = rendered(level(), 'res/level.map.json', block)
    expect(header).toContain('#define G_LEVEL_METAS 2')
    expect(header).toContain('#define G_LEVEL_PLACEMENTS 2')
    expect(header).toContain('#define G_LEVEL_META_G_TREE 0')
    expect(header).toContain('#define G_LEVEL_META_G_COIN 1')
    expect(header).toContain('#define G_LEVEL_FLAGS_G_TREE 0x01')
  })

  it('externs each placed meta and builds a table from the mirror', () => {
    const header = rendered(level(), 'res/level.map.json', block)
    expect(header).toContain('extern const u8 g_Tree[];')
    expect(header).toContain('extern const u8 g_Coin[];')
    expect(header).toContain('{ g_Tree, 2, 3, 6, 4 },')
    expect(header).toContain('void g_Level_DrawPlacements(const u8* frames)')
  })

  it('emits a slot table of width, height and flags, so collision needs no meta header', () => {
    const tables = resourceTables(level())
    const info = tables.find((table) => table.suffix === '_MetaInfo')!
    expect([...info.bytes]).toEqual([2, 3, 0x01, 1, 1, 0x02])
    const header = rendered(level(), 'res/level.map.json', block)
    expect(header).toContain('extern const unsigned char g_Level_MetaInfo[];')
  })

  it('emits the slot table with helpers off — it is data, not ready-made C', () => {
    const header = rendered(level(), 'res/level.map.json', { ...block, helpers: false })
    expect(header).toContain('extern const unsigned char g_Level_MetaInfo[];')
    expect(header).not.toContain('DrawPlacements')
  })

  it('skips baked placements, which the layer write already drew', () => {
    expect(rendered(level(), 'res/level.map.json', block)).toContain('if(slot & 0x80) continue;')
  })

  it('still emits the ordinary layer blit — placements are additive', () => {
    const header = rendered(level(), 'res/level.map.json', block)
    expect(header).toContain('VDP_WriteLayout_GM2(layer, x, y, G_LEVEL_W, G_LEVEL_H)')
  })

  it('a map that places nothing gets exactly the C it always did', () => {
    const plain: ResourceDoc = { kind: 'map', doc: normalizeMap({ tileset: 'res/tiles.tiles.json', width: 8, height: 8 }) }
    const header = rendered(plain, 'res/plain.map.json', { ...block, name: 'g_Plain' })
    expect(header).not.toContain('_PLACEMENTS')
    expect(header).not.toContain('DrawPlacements')
    expect(resourceTables(plain).some((table) => table.suffix === '_Placements')).toBe(false)
    expect(resourceTables(plain).some((table) => table.suffix === '_MetaInfo')).toBe(false)
  })

  it('warns when a placement hangs off the edge of the grid', () => {
    let doc = normalizeMap({ tileset: 'res/tiles.tiles.json', width: 8, height: 8 })
    doc = placeMeta(addMetaRef(doc, tree), 0, 0, 7, 7)
    expect(validateResource({ kind: 'map', doc }).join(' ')).toContain('extends past the map')
  })
})

describe('screen resource', () => {
  const indices = Uint8Array.from({ length: 16 }, (_, i) => i % 16)
  const doc = normalizeScreen({
    mode: 'sc5',
    source: './title.png',
    converted: { width: 4, height: 4, palette: new Array(16).fill(packGrb(1, 2, 3)), indices: encodeIndices(indices) }
  })

  it('packs sc5 at two pixels per byte, high nibble first', () => {
    const tables = resourceTables({ kind: 'screen', doc })
    expect(tables.map((table) => table.suffix)).toEqual(['_Palette', '_Data'])
    expect(tables[1].bytes).toHaveLength(8)
    expect(tables[1].bytes[0]).toBe(0x01)
    expect(tables[1].bytes[1]).toBe(0x23)
  })

  it('drops the picture when the fragments tile it — the strip is the same pixels', () => {
    const sheet = normalizeScreen({
      ...doc,
      fragments: [
        { name: 'left', x: 0, y: 0, width: 2, height: 4 },
        { name: 'right', x: 2, y: 0, width: 2, height: 4 }
      ]
    })
    const tables = resourceTables({ kind: 'screen', doc: sheet })
    expect(tables.map((table) => table.suffix)).toEqual(['_Palette', '_Strip', '_Rects'])
    // …and what is left really is the picture, not a re-ordering of it.
    expect([...tables[1].bytes]).toEqual([...resourceTables({ kind: 'screen', doc })[1].bytes])
  })

  it('keeps the picture when the fragments are only cut-outs of it', () => {
    const sheet = normalizeScreen({ ...doc, fragments: [{ name: 'corner', x: 0, y: 0, width: 2, height: 2 }] })
    const tables = resourceTables({ kind: 'screen', doc: sheet })
    expect(tables.map((table) => table.suffix)).toEqual(['_Palette', '_Data', '_Strip', '_Rects'])
  })

  it('keeps the picture when it is packed, because _Bands indexes it', () => {
    const flat = normalizeScreen({
      mode: 'sc5',
      source: './flat.png',
      converted: { width: 64, height: 8, palette: null, indices: encodeIndices(new Uint8Array(64 * 8)) },
      fragments: [{ name: 'all', x: 0, y: 0, width: 64, height: 8 }]
    })
    expect(resourceTables({ kind: 'screen', doc: flat }, 'rlep').map((t) => t.suffix)).toContain('_Data')
  })

  it('packs sc6 at four pixels per byte and sc8 at one', () => {
    expect([...packBitmap(Uint8Array.from([3, 2, 1, 0]), 4, 1, 'sc6')]).toEqual([0xe4])
    expect([...packBitmap(Uint8Array.from([200, 5]), 2, 1, 'sc8')]).toEqual([200, 5])
  })

  it('applies retouch pixels on top of the cached conversion', () => {
    const retouched = { ...doc, retouch: [0, 0, 9] }
    expect(screenPixels(retouched)?.indices[0]).toBe(9)
    expect(screenPixels(doc)?.indices[0]).toBe(0)
  })

  it('refuses to export before the editor has cached a conversion', () => {
    const bare = normalizeScreen({ mode: 'sc5', source: './title.png' })
    expect(() => resourceTables({ kind: 'screen', doc: bare })).toThrow(/no converted image cached/)
  })

  it('writes palette entries as the V9938 register pair (screen)', () => {
    expect([...palettePairBytes([packGrb(1, 2, 3)])]).toEqual([0x13, 0x02])
  })

  it('packs a picture into bands small enough to unpack on an MSX', () => {
    // A full SCREEN 5 of one colour: 27 136 bytes raw, which no 32K-ROM
    // program could unpack in one piece.
    const flat = normalizeScreen({
      mode: 'sc5',
      source: './title.png',
      converted: {
        width: 256,
        height: 212,
        palette: new Array(16).fill(packGrb(1, 2, 3)),
        indices: encodeIndices(new Uint8Array(256 * 212).fill(4))
      }
    })
    const tables = resourceTables({ kind: 'screen', doc: flat }, 'rlep')
    expect(tables.map((table) => table.suffix)).toEqual(['_Palette', '_Data', '_Bands'])

    const data = tables[1]
    const offsets = tables[2].bytes
    expect(data.unpacked).toBe(256 * 212 / 2)
    expect(data.bytes.length).toBeLessThan(1000)
    expect(offsets).toHaveLength(14 * 2) // 212 lines in bands of 16

    // Every band unpacks to its own slice of the raw bitmap, in order.
    const rebuilt: number[] = []
    for (let band = 0; band < offsets.length / 2; band++) {
      const at = offsets[band * 2] + (offsets[band * 2 + 1] << 8)
      rebuilt.push(...unpackRlep(data.bytes.subarray(at)))
    }
    expect(rebuilt).toEqual([...packBitmap(new Uint8Array(256 * 212).fill(4), 256, 212, 'sc5')])

    const header = rendered(
      { kind: 'screen', doc: flat }, 'art/title.screen.json', {
        name: 'g_Title',
        format: 'c',
        out: 'content/title.h',
        helpers: true,
        compress: 'rlep'
      })
    
    expect(header).toContain('#define G_TITLE_BANDS 14')
    expect(header).toContain('#define G_TITLE_BAND_ROWS 16')
    expect(header).toContain('#define G_TITLE_BAND_BYTES 2048')
    expect(header).toContain('#define G_TITLE_STRIDE 128')
    expect(header).toContain('RLEp_UnpackToRAM(src, buffer)')
  })

  it('leaves a picture that will not shrink alone, and says so', () => {
    // 4×4 of 16 distinct indices: nothing repeats, and the band table would
    // cost more than the packing saves.
    const tables = resourceTables({ kind: 'screen', doc }, 'rlep')
    expect(tables.map((table) => table.suffix)).toEqual(['_Palette', '_Data'])
    expect(tables[1].unpacked).toBeUndefined()

    const header = rendered(
      { kind: 'screen', doc }, 'art/title.screen.json', {
        name: 'g_Title',
        format: 'c',
        out: 'content/title.h',
        helpers: true,
        compress: 'rlep'
      })
    
    expect(header).toContain('packing gained nothing here')
    expect(header).not.toContain('RLEp_UnpackToRAM')
  })
})

describe('sfx resource', () => {
  const sfxDoc = (): SfxDoc =>
    normalizeSfx({
      rate: 50,
      effects: [
        { name: 'zap', frames: [{ toneOn: true, tone: 0x123, volume: 15 }] },
        { name: 'boom', frames: [{ toneOn: false, noiseOn: true, noise: 4, volume: 12 }] }
      ]
    })
  const fixtureSfx = (): ResourceDoc => ({ kind: 'sfx', doc: sfxDoc() })

  it('emits one table: the raw ayFX bank the player takes a pointer to', () => {
    const [table, ...rest] = resourceTables(fixtureSfx())
    expect(rest).toHaveLength(0)
    expect(table.suffix).toBe('')
    expect(table.comment).toContain('zap, boom')
    expect([...table.bytes]).toEqual([
      0x02, // two effects
      0x03, 0x00, // increment for #0: stream at 5, entry high byte at 2
      0x07, 0x00, // increment for #1: stream at 11, entry high byte at 4
      0xef, 0x23, 0x01, 0x00, // noise off + new noise + new tone + tone on, volume 15; tone 0x0123; noise 0
      0xd0, 0x20, // end marker
      0x7c, 0x00, 0x00, 0x04, // tone off + noise on, volume 12; each stream latches tone and noise afresh
      0xd0, 0x20
    ])
    expect(decodeAyfxBank(table.bytes).map((effect) => effect.frames)).toEqual(sfxDoc().effects.map((e) => e.frames))
  })

  it('re-parses an exported bank back into the in-memory model', () => {
    const doc = normalizeSfx({ effects: SFX_PRESETS })
    const bank = renderResourceBin({ kind: 'sfx', doc }, {
      name: 'g_FxSfx',
      format: 'bin',
      out: 'content/fx.afb'
    })
    expect(decodeAyfxBank(bank).map((effect) => effect.frames)).toEqual(doc.effects.map((effect) => effect.frames))
  })

  it('renders a C header naming the ayFX module to enable', () => {
    const text = rendered(fixtureSfx(), 'audio/fx.sfx.json', defaultExport('audio/fx.sfx.json'))
    expect(text).toContain('//  - Source: audio/fx.sfx.json')
    expect(text).toContain('ayfx/ayfx_player')
    expect(text).toContain('//  - Effects: 0=zap, 1=boom')
    expect(text).toContain('//  - Replay rate: 50 Hz')
    expect(text).toContain('const unsigned char g_FxSfx[] =')
  })

  it('parses, serializes and validates through the resource family', () => {
    const parsed = parseResource('audio/fx.sfx.json', serializeResource(fixtureSfx()))
    expect(parsed).toEqual(fixtureSfx())
    expect(validateResource(parsed)).toEqual([])
    expect(defaultExport('audio/fx.sfx.json')).toEqual({ name: 'g_FxSfx', format: 'c', out: 'content/fx_sfx.h' })
    // A stem that already names the kind is left alone, rather than doubled.
    expect(defaultExport('tiles.tiles.json')).toEqual({ name: 'g_Tiles', format: 'c', out: 'content/tiles.h' })
    expect(defaultExport('hero_sprites.sprites.json')).toEqual({
      name: 'g_HeroSprites',
      format: 'c',
      out: 'content/hero_sprites.h'
    })
  })

  it('keeps the meta suffixes out of the plain tileset kinds', () => {
    // `resourceKindOf` matches by `endsWith` in declaration order, so a dotted
    // `.meta.tiles.json` would have resolved to `tiles` and opened an editor that
    // cannot read the file. The hyphen is what makes that impossible.
    expect(resourceKindOf('res/canyon.meta-tiles.json')).toBe('metatiles')
    expect(resourceKindOf('res/canyon.meta-btiles.json')).toBe('metabtiles')
    expect(resourceKindOf('res/canyon.tiles.json')).toBe('tiles')
    expect(resourceKindOf('res/canyon.btiles.json')).toBe('btiles')
    expect(resourceBaseName('res/canyon.meta-tiles.json')).toBe('canyon')
    expect(defaultExport('res/canyon.meta-tiles.json')).toEqual({
      name: 'g_CanyonMetatiles',
      format: 'c',
      out: 'content/canyon_metatiles.h'
    })
  })

  it('creates a valid default doc from {} for every kind — the Resources panel New button', () => {
    for (const [kind, suffix] of Object.entries(RESOURCE_SUFFIXES)) {
      const path = `untitled${suffix}`
      const resource = parseResource(path, '{}')
      expect(resource.kind).toBe(kind)
      resource.doc.export = defaultExport(path)
      // Blank maps/screens legitimately warn until their editor picks a tileset / imports a source.
      const blankStateWarnings: Record<string, string[]> = {
        map: ['No tileset referenced'],
        // A blank meta has a frame from the moment it exists, so the only
        // thing it can be missing is the tileset its indices mean anything in.
        metatiles: ['No tileset referenced'],
        metabtiles: ['No tileset referenced'],
        screen: ['No source image, and nothing drawn yet']
      }
      expect(validateResource(resource)).toEqual(blankStateWarnings[kind] ?? [])
      expect(parseResource(path, serializeResource(resource))).toEqual(resource)
    }
  })
})

/**
 * SCREEN 3 is the only mode whose *byte order* differs rather than just its
 * packing, and the only one whose helpers are the mode itself rather than an
 * optional extra — so these check the seams where it forks from the V9938
 * bitmap modes it shares a document type with.
 */
describe('SCREEN 3 export', () => {
  function sc3Screen(over: Partial<ScreenDoc> = {}): ResourceDoc {
    const doc = normalizeScreen({ mode: 'sc3', ...over })
    return { kind: 'screen', doc: { ...doc, converted: doc.converted ?? blankConverted('sc3') } }
  }

  it('emits the whole framebuffer, in VRAM order', () => {
    const doc = normalizeScreen({ mode: 'sc3' })
    const converted = blankConverted('sc3')
    const indices = decodeIndices(converted.indices)
    // (2, 1): second byte-column, second block row — so both terms of the
    // address are non-zero and a linear packer would put it somewhere else.
    indices[1 * 64 + 2] = 0x0c
    const resource: ResourceDoc = {
      kind: 'screen',
      doc: { ...doc, converted: { ...converted, indices: encodeIndices(indices) } }
    }
    const [table] = resourceTables(resource)
    expect(table.bytes.length).toBe(1536)
    expect(table.bytes[sc3Offset(2, 1)]).toBe(0xc0)
  })

  it('states the page addresses only when double buffering is asked for', () => {
    const resource = sc3Screen()
    const block = { name: 'g_Play', format: 'c' as const, out: 'content/play.h', helpers: true }
    expect(rendered(resource, 'res/play.screen.json', block)).not.toContain('G_PLAY_PAGE1')
    const both = rendered(resource, 'res/play.screen.json', { ...block, doubleBuffer: true })
    expect(both).toContain('#define G_PLAY_PAGE1 0x1000')
    expect(both).toContain('void g_Play_Flip(void);')
  })

  it('emits the runtime even with no fragments — the helpers are the mode, not an extra', () => {
    const text = rendered(sc3Screen(), 'res/play.screen.json', {
      name: 'g_Play',
      format: 'c',
      out: 'content/play.h',
      helpers: true
    })
    expect(text).toContain('void g_Play_InitScreen(void);')
    expect(text).toContain('VDP_SetMode(VDP_MODE_MULTICOLOR);')
    // No V9938 command engine anywhere on this path.
    expect(text).not.toContain('VDP_CommandHMMC')
    expect(text).not.toContain('VDP_CommandLMMM')
  })

  it('states the picture`s size once, even when it is smaller than the screen', () => {
    // `fitToMode` only shrinks, so an imported picture can be under 64x48 — and
    // then the mode's size and the picture's size are different numbers. Emitting
    // both would be a conflicting macro redefinition, not a harmless repeat.
    const doc = normalizeScreen({ mode: 'sc3' })
    const converted = { ...blankConverted('sc3'), width: 48, height: 32 }
    const resource: ResourceDoc = {
      kind: 'screen',
      doc: { ...doc, converted: { ...converted, indices: encodeIndices(new Uint8Array(48 * 32)) } }
    }
    const text = rendered(resource, 'res/play.screen.json', {
      name: 'g_Play',
      format: 'c',
      out: 'content/play.h',
      helpers: true
    })
    expect(text.match(/#define G_PLAY_W /g)).toHaveLength(1)
    expect(text).toContain('#define G_PLAY_W 48')
    expect(text).toContain('#define G_PLAY_SIZE 1536')
  })

  it('rejects a fragment that starts or ends mid-byte', () => {
    const odd = sc3Screen({ fragments: [{ name: 'hero', x: 3, y: 0, width: 4, height: 4 }] })
    expect(validateResource(odd).join(' ')).toContain('even column')
    const even = sc3Screen({ fragments: [{ name: 'hero', x: 4, y: 0, width: 4, height: 4 }] })
    expect(validateResource(even)).toEqual([])
  })

  it('packs fragments one after another, and says where each starts in bytes', () => {
    const resource = sc3Screen({
      fragments: [
        { name: 'a', x: 0, y: 0, width: 4, height: 4 },
        { name: 'b', x: 8, y: 0, width: 2, height: 2 }
      ]
    })
    const tables = resourceTables(resource)
    const strip = tables.find((table) => table.suffix === '_Strip')
    const rects = tables.find((table) => table.suffix === '_Rects')
    // 4x4 blocks is 2 bytes a row over 4 rows, then 2x2 is 1 byte over 2 rows.
    expect(strip?.bytes.length).toBe(8 + 2)
    expect([...(rects?.bytes ?? [])]).toEqual([0, 0, 4, 4, 8, 0, 2, 2])
  })

  it('gives a 2x2 tileset a pattern table, and a bigger one blit data', () => {
    const small: ResourceDoc = { kind: 'btiles', doc: normalizeBitmapTiles({ mode: 'sc3', count: 4 }) }
    const smallTables = resourceTables(small)
    expect(smallTables[0].suffix).toBe('_Patterns')
    expect(smallTables[0].bytes.length).toBe(4 * 8)

    const big: ResourceDoc = {
      kind: 'btiles',
      doc: normalizeBitmapTiles({ mode: 'sc3', width: 4, height: 4, count: 4 })
    }
    const bigTables = resourceTables(big)
    expect(bigTables[0].suffix).toBe('_Tiles')
    expect(bigTables[0].bytes.length).toBe(4 * 2 * 4)
  })

  it('holds no palette table — the sixteen colours are the hardware`s', () => {
    const doc = normalizeBitmapTiles({ mode: 'sc3', count: 2 })
    expect(doc.palette).toBeNull()
    expect(resourceTables({ kind: 'btiles', doc }).some((table) => table.suffix === '_Palette')).toBe(false)
  })

  it('rounds `cell.sc3` through the file, so a reopened map still exports as SCREEN 3', () => {
    const doc = normalizeMap({
      tileset: 'res/tiles.btiles.json',
      width: 4,
      height: 4,
      cell: { width: 2, height: 2, cols: 16, sc3: true }
    })
    // The round trip is the point: `setTileset` sets the flag, but every export
    // after that reads a file.
    const reloaded = parseResource('res/level.map.json', serializeResource({ kind: 'map', doc }))
    const text = rendered(reloaded, 'res/level.map.json', {
      name: 'g_Level',
      format: 'c',
      out: 'content/level.h',
      helpers: true
    })
    // 2x2 is one name-table entry, so this is the VDP path, not a blit.
    expect(text).toContain('VDP_WriteLayout_GM2')
    expect(text).not.toContain('VDP_CommandHMMM')
    expect(text).toContain('VDP_MODE_SCREEN3')
  })

  it('blits a map whose tiles are bigger than a name-table entry', () => {
    const doc = normalizeMap({
      tileset: 'res/tiles.btiles.json',
      width: 4,
      height: 4,
      cell: { width: 4, height: 4, cols: 16, sc3: true }
    })
    const text = rendered({ kind: 'map', doc }, 'res/level.map.json', {
      name: 'g_Level',
      format: 'c',
      out: 'content/level.h',
      helpers: true
    })
    expect(text).toContain('void g_Level_DrawRow(u8* buf, const u8* tiles, const u8* layer, u8 row, u8 x, u8 y)')
    expect(text).not.toContain('VDP_CommandHMMM')
  })
})

/**
 * A screen and a map differ only in width and height — so once the size is free,
 * a scrolling world *is* a big screen, and these are the seams that fork on it.
 */
describe('screens bigger than the display', () => {
  const block = { name: 'g_World', format: 'c' as const, out: 'content/world.h', helpers: true }

  function world(mode: 'sc3' | 'sc5', width: number, height: number): ResourceDoc {
    const doc = normalizeScreen({ mode, width, height })
    return { kind: 'screen', doc: { ...doc, converted: blankConverted(mode, width, height) } }
  }

  it('takes its size from the cached conversion when the file predates the field', () => {
    // Every `.screen.json` written before `width`/`height` existed says its size
    // only through what it converted; defaulting to the mode would crop it.
    const doc = normalizeScreen({
      mode: 'sc5',
      converted: { width: 64, height: 32, palette: null, indices: encodeIndices(new Uint8Array(64 * 32)) }
    })
    expect([doc.width, doc.height]).toEqual([64, 32])
  })

  it('packs a SCREEN 3 world linearly, not in the VDP`s byte order', () => {
    const [table] = resourceTables(world('sc3', 128, 96))
    // 64 bytes a row, 96 rows — and emphatically not the 1536 of a framebuffer.
    expect(table.bytes.length).toBe(64 * 96)
  })

  it('still packs a one-screen SCREEN 3 picture for direct upload', () => {
    const [table] = resourceTables(world('sc3', 64, 48))
    expect(table.bytes.length).toBe(1536)
  })

  it('gives a SCREEN 3 world a window instead of an upload', () => {
    const big = rendered(world('sc3', 128, 96))
    expect(big).toContain('void g_World_DrawWindow(u8* buf, u16 camX, u16 camY);')
    expect(big).toContain('#define G_WORLD_STRIDE 64')
    // The display's size is stated apart from the picture's, or the window loop
    // would run over the whole world.
    expect(big).toContain('#define G_WORLD_VIEW_H 48')
    expect(big).toContain('#define G_WORLD_W 128')
    // A picture that cannot be uploaded whole must not offer to be.
    expect(big).not.toContain('void g_World_Draw(void);')

    const small = rendered(world('sc3', 64, 48))
    expect(small).toContain('void g_World_Draw(void);')
    expect(small).not.toContain('_DrawWindow')
  })

  it('windows a bitmap world a row at a time, out of ROM', () => {
    const text = rendered(world('sc5', 512, 424))
    expect(text).toContain('void g_World_DrawRow(UX camX, UY camY, u8 row, UY destY);')
    expect(text).toContain('#define G_WORLD_VIEW_W 256')
    expect(text).toContain('#define G_WORLD_PPB 2')
    expect(text).toContain('VDP_CommandHMMC')
  })

  it('snaps the width to a whole number of bytes, per mode', () => {
    // SCREEN 6 packs four dots a byte, so 250 cannot be a row length.
    expect(normalizeScreen({ mode: 'sc6', width: 250, height: 100 }).width).toBe(252)
    expect(normalizeScreen({ mode: 'sc3', width: 65, height: 50 }).width).toBe(66)
  })

  it('crops the picture with the document rather than letting the two disagree', () => {
    const big = world('sc3', 64, 48)
    const shrunk = normalizeScreen({ ...big.doc, width: 32, height: 24 })
    expect(shrunk.converted?.width).toBe(32)
    expect(validateResource({ kind: 'screen', doc: shrunk })).toEqual([])
  })

  function rendered(resource: ResourceDoc): string {
    const files = renderResourceFiles(resource, 'res/world.screen.json', block)
    return `${files.header ?? ''}\n${files.source ?? ''}`
  }
})

describe('resourceKindOf', () => {
  it('answers null for a missing path rather than throwing', () => {
    // An editor session handed no path must degrade to an error banner, not a
    // blank pane: this throwing inside a render unmounts the whole editor.
    expect(resourceKindOf(undefined as unknown as string)).toBeNull()
    expect(resourceKindOf('')).toBeNull()
  })

  it('still matches the hyphenated meta suffixes before the plain ones', () => {
    expect(resourceKindOf('res/tree.meta-tiles.json')).toBe('metatiles')
    expect(resourceKindOf('res/rock.meta-btiles.json')).toBe('metabtiles')
    expect(resourceKindOf('res/main.tiles.json')).toBe('tiles')
  })
})

describe('exporting a banked tileset', () => {
  const solid = (byte: number): TileEntry => ({ pattern: new Array(8).fill(byte), color: new Array(8).fill(0xf1) })

  const banked = (): TilesDoc =>
    normalizeTiles({
      mode: 'sc2',
      count: 256,
      bankTiles: [new Array(4).fill(solid(1)), new Array(6).fill(solid(2)), []],
      sharedTiles: 3,
      export: { name: 'g_Title', format: 'c', out: 'content/title.h', helpers: true }
    })

  // Local shadow of the module-level `rendered`, same pattern the screen tests
  // below use: every fixture in this block already carries its own `export`
  // block, so there is nothing to vary by passing sourceName/block separately.
  function rendered(resource: ResourceDoc): string {
    const files = renderResourceFiles(resource, 'res/title.tiles.json', resource.doc.export!)
    return `${files.header ?? ''}\n${files.source ?? ''}`
  }

  it('emits a table and a count per bank, plus the common set', () => {
    const header = rendered({ kind: 'tiles', doc: banked() })
    expect(header).toContain('#define G_TITLE_BANK0_TILES 4')
    expect(header).toContain('#define G_TITLE_BANK1_TILES 6')
    expect(header).toContain('g_Title_Bank0_Patterns')
    expect(header).toContain('g_Title_Bank1_Colors')
    // Bank 2 overrides nothing, so it gets no table of its own.
    expect(header).not.toContain('g_Title_Bank2_Patterns')
  })

  it('each bank loads the common tail from its own offset', () => {
    const header = rendered({ kind: 'tiles', doc: banked() })
    // Bank 0 overrides 0..3, so it still shows the common set from 4 up; bank 1
    // from 6. Loading the same slice into both would draw the wrong art.
    expect(header).toContain('VDP_LoadBankPattern_GM2(g_Title_Patterns + 4 * 8, G_TITLE_TILES - 4, 0, 4)')
    expect(header).toContain('VDP_LoadBankPattern_GM2(g_Title_Patterns + 6 * 8, G_TITLE_TILES - 6, 1, 6)')
    expect(header).toContain('VDP_LoadBankPattern_GM2(g_Title_Bank0_Patterns, G_TITLE_BANK0_TILES, 0, 0)')
  })

  it('an unbanked tileset exports exactly what it exports today', () => {
    // The feature's promise, asserted rather than assumed.
    const doc = normalizeTiles({ mode: 'sc2', count: 4, export: { name: 'g_T', format: 'c', out: 'content/t.h', helpers: true } })
    const header = rendered({ kind: 'tiles', doc })
    expect(header).not.toContain('Bank')
    expect(header).not.toContain('LoadBankPattern')
  })

  it('a stray sharedTiles with no bank to justify it is incoherent state, not a real one', () => {
    // A hand-edited (or half-migrated) file could carry `sharedTiles > 0`
    // with `bankTiles` empty — nothing here ever writes that shape, but
    // `normalizeTiles` cannot assume a file was produced by this app. Before
    // the producer clamped this, `resourceTables` (gated on `sharedTiles >
    // 0` alone) emitted `_Shared_Patterns`/`_Shared_Colors`, while
    // `resourceConstants`/`resourceCode` (gated on `isBanked`) emitted
    // neither `_SHARED_TILES` nor a loader for them — two dead tables in an
    // otherwise data-only header, and the art they held still never reached
    // any bank's VRAM. `normalizeTiles` now clamps `sharedTiles` to 0 in this
    // shape (see `tile.ts`), so all three should agree there is nothing
    // banked here at all — the output should be byte-for-byte the plain
    // unbanked case, with or without helpers.
    const strayShared = normalizeTiles({
      mode: 'sc2',
      count: 4,
      sharedTiles: 3,
      export: { name: 'g_T', format: 'c', out: 'content/t.h', helpers: true }
    })
    const plain = normalizeTiles({ mode: 'sc2', count: 4, export: { name: 'g_T', format: 'c', out: 'content/t.h', helpers: true } })
    expect(strayShared.sharedTiles).toBe(0)
    expect(rendered({ kind: 'tiles', doc: strayShared })).toBe(rendered({ kind: 'tiles', doc: plain }))

    const strayNoHelpers = { ...strayShared, export: { ...strayShared.export!, helpers: false } }
    const plainNoHelpers = { ...plain, export: { ...plain.export!, helpers: false } }
    expect(rendered({ kind: 'tiles', doc: strayNoHelpers })).toBe(rendered({ kind: 'tiles', doc: plainNoHelpers }))
  })

  it('the shared (meta-tile) region reaches every bank, not just when count already covers it', () => {
    // `banked()` above uses count:256, which already spans the whole array —
    // `tilePatternBytes` (bounded to `count`) happens to include the shared
    // tail there too, masking the exact gap Task 2's review found: on a
    // realistic tileset `count` sits well below the shared reservation, so
    // the common table never reaches it and the meta-tile art needs its own
    // path into every bank's VRAM.
    const rawTiles: unknown[] = new Array(4).fill(solid(1))
    rawTiles[253] = solid(0xaa)
    rawTiles[254] = solid(0xbb)
    rawTiles[255] = solid(0xcc)
    const doc = normalizeTiles({
      mode: 'sc2',
      count: 4,
      tiles: rawTiles,
      bankTiles: [[solid(2)], [], []],
      sharedTiles: 3,
      export: { name: 'g_Title', format: 'c', out: 'content/title.h', helpers: true }
    })
    const header = rendered({ kind: 'tiles', doc })
    expect(header).toContain('#define G_TITLE_SHARED_TILES 3')
    expect(header).toContain('g_Title_Shared_Patterns')
    expect(header).toContain('g_Title_Shared_Colors')
    // Loaded into every bank — including bank 2, which overrides nothing of
    // its own — at the shared region's real hardware offset (253).
    expect(header).toContain('VDP_LoadBankPattern_GM2(g_Title_Shared_Patterns, G_TITLE_SHARED_TILES, 0, 253)')
    expect(header).toContain('VDP_LoadBankPattern_GM2(g_Title_Shared_Patterns, G_TITLE_SHARED_TILES, 1, 253)')
    expect(header).toContain('VDP_LoadBankPattern_GM2(g_Title_Shared_Patterns, G_TITLE_SHARED_TILES, 2, 253)')
  })

  it("omits a bank's common-tail load once its own overrides reach or pass count", () => {
    // Nothing ties a bank's size to `count` — a fresh tileset starts at
    // count 1, and a bank can still grow well past that (see
    // `bankCapacityLeft`). A naive `TILES - overrides` would then hit 0 or
    // go negative, and VDP_LoadBankPattern_GM2's count is a `u8` where **0
    // means 256** — loading 256 tiles out of an 8-byte table over the bank,
    // shared region included.
    const doc = normalizeTiles({
      mode: 'sc2',
      count: 1,
      bankTiles: [[solid(1), solid(2), solid(3)], [], []],
      export: { name: 'g_T', format: 'c', out: 'content/t.h', helpers: true }
    })
    const header = rendered({ kind: 'tiles', doc })
    // Bank 0's own table still loads in full...
    expect(header).toContain('VDP_LoadBankPattern_GM2(g_T_Bank0_Patterns, G_T_BANK0_TILES, 0, 0)')
    // ...but nothing tries to load a common tail that doesn't exist for it.
    expect(header).not.toContain('G_T_TILES - 3')
    expect(header).not.toContain('g_T_Patterns + 3 * 8')
    // Banks 1 and 2 have no overrides of their own (0 < count), so they still
    // load the one common tile that exists.
    expect(header).toContain('VDP_LoadBankPattern_GM2(g_T_Patterns, G_T_TILES, 1, 0)')
    expect(header).toContain('VDP_LoadBankPattern_GM2(g_T_Patterns, G_T_TILES, 2, 0)')
  })
})
