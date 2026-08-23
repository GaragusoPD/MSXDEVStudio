/**
 * The whole meta-tile path in one test: paint a meta, place it on a map, export
 * both, and check the two headers agree with each other.
 *
 * Every step here is covered in isolation elsewhere. What this adds is the
 * seam between them — that the symbol the map `extern`s is the one the meta
 * exported under, that dedup and the reserved blank survive the round trip into
 * the tables, and that a baked placement really does come out with bit 7 set.
 * Those are the joins where a rename or an off-by-one would pass every unit
 * test and still produce a project that does not link.
 */

import { describe, expect, it } from 'vitest'
import { addMetaRef, normalizeMap, placeMeta, setPlacementBaked } from './map'
import { createMetaTileDoc } from './meta-tile'
import { paintBitmapMeta, paintMeta } from './meta-paint'
import { normalizeBitmapTiles, sheetCols } from './bitmap-tile'
import { defaultExport, renderResourceFiles } from './resource'
import { blankTileEntry, normalizeTiles } from './tile'

/** Every pixel of the 8×8 cell whose top-left dot is (ox, oy). */
const cell = (ox: number, oy: number): { x: number; y: number }[] =>
  Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => ({ x: ox + x, y: oy + y }))).flat()

describe('paint a meta-tile, place it, export the pair', () => {
  it('produces a meta table and a placement table that agree', () => {
    let tiles = normalizeTiles({ mode: 'sc2', count: 1, reserveTile0: true })
    expect(tiles.tiles[0]).toEqual(blankTileEntry('sc2'))

    // A 2×2 meta with its top-left and bottom-right cells filled, and the other
    // two left transparent — the shape that exercises both dedup and tile 0.
    let meta = createMetaTileDoc('res/tiles.tiles.json', 2, 2)
    for (const points of [cell(0, 0), cell(8, 8)]) {
      const result = paintMeta(meta, tiles, 0, points, 5)
      expect(result.refused).toBeUndefined()
      meta = result.meta
      tiles = result.tiles
    }

    // The two painted cells are the same picture, so they share one tile...
    expect(meta.frames[0].tiles[0]).toBe(meta.frames[0].tiles[3])
    // ...the untouched ones still point at the reserved blank...
    expect(meta.frames[0].tiles[1]).toBe(0)
    expect(meta.frames[0].tiles[2]).toBe(0)
    // ...and exactly one tile was created for both of them.
    expect(tiles.count).toBe(2)

    meta = {
      ...meta,
      flags: 0x01,
      export: { ...defaultExport('res/tree.meta-tiles.json'), name: 'g_Tree', helpers: true }
    }

    let map = normalizeMap({ tileset: 'res/tiles.tiles.json', width: 32, height: 24 })
    map = addMetaRef(map, {
      path: 'res/tree.meta-tiles.json',
      name: 'g_Tree',
      width: 2,
      height: 2,
      frames: 1,
      flags: 1
    })
    map = placeMeta(map, 0, 0, 4, 4)
    map = placeMeta(map, 0, 0, 10, 8)
    map = setPlacementBaked(map, 0, 1, true)
    map = { ...map, export: { ...defaultExport('res/level.map.json'), name: 'g_Level', helpers: true } }

    // Header and source together: the tables are in one and the helpers in the
    // other, and this test is about whether they agree.
    const render = (resource: Parameters<typeof renderResourceFiles>[0], path: string, block: typeof map.export): string => {
      const files = renderResourceFiles(resource, path, block!)
      return `${files.header ?? ''}\n${files.source ?? ''}`
    }

    const metaText = render({ kind: 'metatiles', doc: meta }, 'res/tree.meta-tiles.json', meta.export)
    const mapText = render({ kind: 'map', doc: map }, 'res/level.map.json', map.export)

    expect(metaText).toContain('#define G_TREE_CELLS 4')
    expect(metaText).toContain('#define G_TREE_FRAMES 1')
    expect(metaText).toContain('#define G_TREE_FLAGS 0x01')
    expect(metaText).toContain('void g_Tree_Draw(u8 x, u8 y, u8 frame)')
    expect(metaText).toContain('if(src[col] == 0) { ++col; continue; }')

    // The join that nothing else checks: the map declares the meta by the exact
    // symbol the meta exported under, so the two objects link.
    expect(mapText).toContain('extern const u8 g_Tree[];')
    expect(mapText).toContain('#define G_LEVEL_METAS 1')
    expect(mapText).toContain('#define G_LEVEL_PLACEMENTS 2')
    expect(mapText).toContain('void g_Level_DrawPlacements(const u8* frames)')

    // Live at (4,4); baked at (10,8), which sets bit 7 of the slot byte. The
    // definition, not the header's `extern` — the bytes are what matter here.
    const table = /g_Level_Placements\[\]\s*=\s*\{[^}]*\}/s.exec(mapText)?.[0] ?? ''
    expect(table).toMatch(/0x00,\s*0x04,\s*0x04/)
    expect(table).toMatch(/0x80,\s*0x0A,\s*0x08/)
  })
})

describe('the bitmap path: paint, place, export', () => {
  it('emits a transparent blit only when the tileset nominates colour 0', () => {
    let tiles = normalizeBitmapTiles({
      mode: 'sc5',
      width: 16,
      height: 16,
      count: 1,
      reserveTile0: true,
      transparent: 0
    })
    let meta = { ...createMetaTileDoc('res/canyon.btiles.json', 2, 2), transparent: 0 }

    // Two opaque cells on a diagonal; the other two stay transparent.
    for (const [ox, oy] of [[0, 0], [16, 16]]) {
      const points = Array.from({ length: 16 }, (_, y) =>
        Array.from({ length: 16 }, (_, x) => ({ x: ox + x, y: oy + y }))
      ).flat()
      const result = paintBitmapMeta(meta, tiles, 0, points, 7)
      meta = { ...result.meta, transparent: 0 }
      tiles = result.tiles
    }
    expect(meta.frames[0].tiles[0]).toBe(meta.frames[0].tiles[3])
    expect(meta.frames[0].tiles[1]).toBe(0)
    expect(tiles.count).toBe(2)

    const withCell = {
      ...meta,
      cell: { width: 16, height: 16, cols: sheetCols(tiles) },
      export: { ...defaultExport('res/rock.meta-btiles.json'), name: 'g_Rock', helpers: true }
    }
    const render = (resource: Parameters<typeof renderResourceFiles>[0], path: string, block: typeof withCell.export): string => {
      const files = renderResourceFiles(resource, path, block!)
      return `${files.header ?? ''}\n${files.source ?? ''}`
    }

    const text = render({ kind: 'metabtiles', doc: withCell }, 'res/rock.meta-btiles.json', withCell.export)
    expect(text).toContain('#define G_ROCK_TRANSPARENT 0')
    // Both kinds of see-through: the skipped cell and the skipped colour.
    expect(text).toContain('if(cell == 0) continue;')
    expect(text).toContain('VDP_CommandLMMM')

    // Nominating any other index cannot use the VDP's transparency at all.
    const opaque = { ...withCell, transparent: 3 }
    const opaqueText = render({ kind: 'metabtiles', doc: opaque }, 'res/rock.meta-btiles.json', opaque.export)
    // The *call*, not the string: the header comment names VDP_OP_TIMP
    // precisely to explain why it is not being used.
    expect(opaqueText).not.toContain('VDP_CommandLMMM')
    expect(opaqueText).toContain('VDP_CommandHMMM')
    expect(opaqueText).toContain('only ever skips colour 0')
  })

  it('a bitmap map blits its placements instead of writing a name table', () => {
    let map = normalizeMap({
      tileset: 'res/canyon.btiles.json',
      width: 16,
      height: 12,
      cell: { width: 16, height: 16, cols: 16 }
    })
    map = addMetaRef(map, {
      path: 'res/rock.meta-btiles.json',
      name: 'g_Rock',
      width: 2,
      height: 2,
      frames: 1,
      flags: 0,
      masked: true
    })
    map = placeMeta(map, 0, 0, 3, 3)
    const block = { ...defaultExport('res/stage.map.json'), name: 'g_Stage', helpers: true }
    const files = renderResourceFiles({ kind: 'map', doc: { ...map, export: block } }, 'res/stage.map.json', block)
    const text = `${files.header ?? ''}\n${files.source ?? ''}`

    expect(text).toContain('void g_Stage_DrawPlacements(const u8* frames, UY atlasY)')
    expect(text).toContain('extern const u8 g_Rock[];')
    expect(text).toContain('VDP_CommandLMMM(sx, sy, dx, dy, 16, 16, VDP_OP_TIMP);')
    expect(text).not.toContain('VDP_WriteLayout_GM2(src + col')
  })
})
