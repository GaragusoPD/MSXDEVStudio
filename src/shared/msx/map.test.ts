import { describe, expect, it } from 'vitest'
import {
  addMetaRef,
  MAX_MAP_METAS,
  metaSlotOf,
  movePlacement,
  normalizeMap,
  placeMeta,
  placementAt,
  placementBytes,
  placementCount,
  placementHelperC,
  removeMetaRef,
  removePlacement,
  resizeMap,
  setPlacementBaked,
  validateMap,
  type MetaRef
} from './map'
import { addLayer } from '../map-editor'

const tree: MetaRef = { path: 'res/tree.meta-tiles.json', name: 'tree', width: 2, height: 3, frames: 4, flags: 1 }
const coin: MetaRef = { path: 'res/coin.meta-tiles.json', name: 'coin', width: 1, height: 1, frames: 6, flags: 2 }

const blank = (): ReturnType<typeof normalizeMap> => normalizeMap({ tileset: 't.tiles.json', width: 8, height: 8 })
const withTree = (): ReturnType<typeof normalizeMap> => addMetaRef(blank(), tree)

describe('meta refs', () => {
  it('a map with no metas normalizes to empty lists, so old files are unchanged', () => {
    const doc = blank()
    expect(doc.metas).toEqual([])
    expect(doc.layers[0].placements).toEqual([])
  })

  it('re-adding the same path refreshes the mirror rather than duplicating it', () => {
    const doc = addMetaRef(withTree(), { ...tree, height: 4, frames: 8 })
    expect(doc.metas).toHaveLength(1)
    expect(doc.metas[0].height).toBe(4)
  })

  it('metaSlotOf finds a meta, or reports -1', () => {
    expect(metaSlotOf(withTree(), tree.path)).toBe(0)
    expect(metaSlotOf(withTree(), coin.path)).toBe(-1)
  })

  it('refuses a 129th meta, because the slot byte only has seven bits', () => {
    let doc = blank()
    for (let i = 0; i < 130; i++) doc = addMetaRef(doc, { ...tree, path: `m${i}.meta-tiles.json`, name: `m${i}` })
    expect(doc.metas).toHaveLength(MAX_MAP_METAS)
  })
})

describe('placements', () => {
  it('places a meta on a layer', () => {
    expect(placeMeta(withTree(), 0, 0, 3, 4).layers[0].placements).toEqual([{ slot: 0, x: 3, y: 4 }])
  })

  it('refuses an origin outside the grid', () => {
    const doc = withTree()
    expect(placeMeta(doc, 0, 0, 99, 0)).toBe(doc)
  })

  it('refuses an unknown slot', () => {
    const doc = withTree()
    expect(placeMeta(doc, 0, 7, 0, 0)).toBe(doc)
  })

  it('placementAt finds the topmost placement covering a cell — z-order is list order', () => {
    let doc = placeMeta(withTree(), 0, 0, 0, 0)
    doc = placeMeta(doc, 0, 0, 1, 1)
    expect(placementAt(doc, 0, 1, 1)).toBe(1)
    expect(placementAt(doc, 0, 0, 0)).toBe(0)
    expect(placementAt(doc, 0, 6, 6)).toBeNull()
  })

  it('movePlacement clamps to the grid by refusing', () => {
    const doc = placeMeta(withTree(), 0, 0, 1, 1)
    expect(movePlacement(doc, 0, 0, 2, 2).layers[0].placements[0]).toMatchObject({ x: 2, y: 2 })
    expect(movePlacement(doc, 0, 0, 99, 0)).toBe(doc)
  })

  it('removePlacement drops one', () => {
    expect(removePlacement(placeMeta(withTree(), 0, 0, 1, 1), 0, 0).layers[0].placements).toEqual([])
  })

  it('removeMetaRef renumbers the slots of surviving placements', () => {
    let doc = addMetaRef(withTree(), coin)
    doc = placeMeta(doc, 0, 1, 0, 0)
    doc = removeMetaRef(doc, 0)
    expect(doc.metas).toHaveLength(1)
    expect(doc.layers[0].placements[0].slot).toBe(0)
  })

  it('removeMetaRef drops the placements that referenced it', () => {
    expect(removeMetaRef(placeMeta(withTree(), 0, 0, 0, 0), 0).layers[0].placements).toEqual([])
  })

  it('setPlacementBaked flips the flag, and clears the key rather than storing false', () => {
    const baked = setPlacementBaked(placeMeta(withTree(), 0, 0, 1, 1), 0, 0, true)
    expect(baked.layers[0].placements[0].baked).toBe(true)
    expect(setPlacementBaked(baked, 0, 0, false).layers[0].placements[0]).toEqual({ slot: 0, x: 1, y: 1 })
  })

  it('resizeMap drops a placement whose origin no longer fits', () => {
    const doc = placeMeta(withTree(), 0, 0, 6, 6)
    expect(resizeMap(doc, 4, 4).layers[0].placements).toEqual([])
    expect(resizeMap(doc, 8, 8).layers[0].placements).toHaveLength(1)
  })

  it('normalize drops a placement whose slot is gone, rather than drawing from a missing entry', () => {
    const doc = normalizeMap({
      tileset: 't.tiles.json',
      width: 8,
      height: 8,
      metas: [tree],
      layers: [{ name: 'background', placements: [{ slot: 0, x: 1, y: 1 }, { slot: 5, x: 2, y: 2 }] }]
    })
    expect(doc.layers[0].placements).toEqual([{ slot: 0, x: 1, y: 1 }])
  })
})

describe('placementBytes', () => {
  it('packs slot, baked, x and y into three bytes each', () => {
    const doc = setPlacementBaked(placeMeta(withTree(), 0, 0, 3, 4), 0, 0, true)
    expect([...placementBytes(doc)]).toEqual([0x80, 3, 4])
  })

  it('walks every layer in order', () => {
    let doc = addLayer(withTree(), 'over')
    doc = placeMeta(doc, 0, 0, 1, 1)
    doc = placeMeta(doc, 1, 0, 2, 2)
    expect([...placementBytes(doc)]).toEqual([0, 1, 1, 0, 2, 2])
    expect(placementCount(doc)).toBe(2)
  })
})

describe('validateMap', () => {
  it('accepts a placement that fits', () => {
    expect(validateMap(placeMeta(withTree(), 0, 0, 6, 5))).toEqual([])
  })

  it('reports a placement whose far edge hangs off the grid', () => {
    expect(validateMap(placeMeta(withTree(), 0, 0, 7, 7)).join(' ')).toContain('extends past the map')
  })
})

describe('placements in a bitmap mode', () => {
  const bitmapMap = (over: Record<string, unknown> = {}): ReturnType<typeof normalizeMap> => {
    let doc = normalizeMap({
      tileset: 'res/canyon.btiles.json',
      width: 16,
      height: 12,
      cell: { width: 16, height: 16, cols: 16 },
      ...over
    })
    doc = addMetaRef(doc, { ...tree, width: 2, height: 2, masked: true })
    return placeMeta(doc, 0, 0, 2, 2)
  }

  it('blits out of the atlas rather than writing a name table', () => {
    const c = placementHelperC(bitmapMap(), 'g_Stage')
    const source = c.source.join('\n')
    expect(source).toContain('void g_Stage_DrawPlacements(const u8* frames, UY atlasY)')
    expect(source).not.toContain('VDP_WriteLayout_GM2')
  })

  it('skips a cell holding tile 0, whatever the meta', () => {
    expect(placementHelperC(bitmapMap(), 'g_Stage').source.join('\n')).toContain('if(cell == 0) continue;')
  })

  it('offers both blits, chosen per meta by its mirrored `masked` flag', () => {
    const source = placementHelperC(bitmapMap(), 'g_Stage').source.join('\n')
    expect(source).toContain('VDP_OP_TIMP')
    expect(source).toContain('VDP_CommandHMMM(sx, sy, dx, dy, 16, 16);')
    expect(source).toContain('{ tree, 2, 2, 4, 1 },')
  })

  it('still skips baked placements', () => {
    expect(placementHelperC(bitmapMap(), 'g_Stage').source.join('\n')).toContain('if(slot & 0x80) continue;')
  })

  it('refuses placements on a SCREEN 3 map that blits, since MSX1 has no command engine', () => {
    const doc = bitmapMap({ cell: { width: 4, height: 4, cols: 16, sc3: true } })
    expect(validateMap(doc).join(' ')).toContain('no command engine')
  })

  it('allows them on a 2x2 SCREEN 3 map, which draws through the name table', () => {
    const doc = bitmapMap({ cell: { width: 2, height: 2, cols: 16, sc3: true } })
    expect(validateMap(doc).join(' ')).not.toContain('command engine')
    expect(placementHelperC(doc, 'g_Stage').source.join('\n')).toContain('VDP_WriteLayout_GM2')
  })
})
