/**
 * The whole meta-tile path in one test: draw a meta, attach it to a tileset,
 * place it on a map, export all three, and check the headers agree.
 *
 * Every step here is covered in isolation elsewhere. What this adds is the
 * seam between them — that the tiles the map draws a meta with are the tiles
 * the tileset's export gave it, that dedup and see-through cells survive the
 * round trip into the tables, and that a baked placement really does come out
 * with bit 7 set. Those are the joins where an off-by-one would pass every unit
 * test and still draw the wrong picture.
 */

import { describe, expect, it } from 'vitest'
import { addMetaRef, metaRefFrom, normalizeMap, placeMeta, setPlacementBaked } from './map'
import { createMetaTileDoc } from './meta-tile'
import { normalizeOwnedMeta, resolveMeta } from './meta-owned'
import { paintBitmapMeta } from './meta-paint'
import { normalizeBitmapTiles, sheetCols } from './bitmap-tile'
import { defaultExport, renderResourceFiles } from './resource'
import { normalizeTiles } from './tile'

const render = (resource: Parameters<typeof renderResourceFiles>[0], path: string, name: string): string => {
  const files = renderResourceFiles(resource, path, { ...defaultExport(path), name, helpers: true })
  return `${files.header ?? ''}\n${files.source ?? ''}`
}

describe('draw a meta-tile, attach it, place it, export all three', () => {
  it('the map draws the meta with the tiles the tileset gave it', () => {
    // A 2×2 meta: its top-left and bottom-right cells the same solid block, the
    // other two see-through — the shape that exercises dedup and holes.
    const solid = { pattern: new Array(8).fill(0xff), color: new Array(8).fill(0x51) }
    const meta = normalizeOwnedMeta({
      version: 3,
      mode: 'sc2',
      width: 2,
      height: 2,
      holes: [false, true, true, false],
      frames: [{ tiles: [solid, {}, {}, solid] }],
      flags: 0x01,
      export: { ...defaultExport('res/tree.meta-tiles.json'), name: 'g_Tree' }
    })
    const attached = resolveMeta(normalizeTiles({ mode: 'sc2', count: 1, reserveTile0: true }), 'res/tree.meta-tiles.json', meta, 'g_Tree')
    if (typeof attached === 'string') throw new Error(attached)
    const tiles = attached.doc
    // One tile for both solid cells; the holes are 0.
    expect(attached.binding.cells).toEqual([1, 0, 0, 1])
    expect(tiles.count).toBe(2)

    let map = normalizeMap({ tileset: 'res/tiles.tiles.json', width: 32, height: 24 })
    map = addMetaRef(map, metaRefFrom('res/tree.meta-tiles.json', meta, 'g_Tree', attached.binding))
    map = placeMeta(map, 0, 0, 4, 4)
    map = placeMeta(map, 0, 0, 10, 8)
    map = setPlacementBaked(map, 0, 1, true)

    const tilesText = render({ kind: 'tiles', doc: tiles }, 'res/tiles.tiles.json', 'g_Tiles')
    const metaText = render({ kind: 'metatiles', doc: meta }, 'res/tree.meta-tiles.json', 'g_Tree')
    const mapText = render({ kind: 'map', doc: map }, 'res/level.map.json', 'g_Level')

    const table = (text: string, name: string): string => new RegExp(`${name}\\[\\]\\s*=\\s*\\{[^}]*\\}`, 's').exec(text)?.[0] ?? ''
    // The join that nothing else checks: the map's cells are the tileset's.
    expect(table(tilesText, 'g_Tiles_MetaCells')).toMatch(/0x01,\s*0x00,\s*0x00,\s*0x01/)
    expect(table(mapText, 'g_Level_MetaCells')).toMatch(/0x01,\s*0x00,\s*0x00,\s*0x01/)
    expect(metaText).toContain('#define G_TREE_FLAGS 0x01')
    expect(metaText).not.toContain('_Draw')
    expect(mapText).toContain('#define G_LEVEL_METAS 1')
    expect(mapText).toContain('#define G_LEVEL_PLACEMENTS 2')
    expect(mapText).toContain('void g_Level_DrawPlacements(void)')

    // Live at (4,4); baked at (10,8), which sets bit 7 of the slot byte.
    const placements = table(mapText, 'g_Level_Placements')
    expect(placements).toMatch(/0x00,\s*0x04,\s*0x04/)
    expect(placements).toMatch(/0x80,\s*0x0A,\s*0x08/)
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
    const renderBlock = (resource: Parameters<typeof renderResourceFiles>[0], path: string, block: typeof withCell.export): string => {
      const files = renderResourceFiles(resource, path, block!)
      return `${files.header ?? ''}\n${files.source ?? ''}`
    }

    const text = renderBlock({ kind: 'metabtiles', doc: withCell }, 'res/rock.meta-btiles.json', withCell.export)
    expect(text).toContain('#define G_ROCK_TRANSPARENT 0')
    // Both kinds of see-through: the skipped cell and the skipped colour.
    expect(text).toContain('if(cell == 0) continue;')
    expect(text).toContain('VDP_CommandLMMM')

    // Nominating any other index cannot use the VDP's transparency at all.
    const opaque = { ...withCell, transparent: 3 }
    const opaqueText = renderBlock({ kind: 'metabtiles', doc: opaque }, 'res/rock.meta-btiles.json', opaque.export)
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
