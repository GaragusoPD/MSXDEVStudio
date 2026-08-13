import { describe, expect, it } from 'vitest'
import {
  addMeta,
  createMetaTilesDoc,
  metaBytes,
  metaStride,
  metaTileAt,
  normalizeMetaTiles,
  remapMetaTiles,
  removeMeta,
  renameMeta,
  reorderMetas,
  resizeMetas,
  setMetaTile,
  validateMetaTiles
} from './meta-tile'
import { removeTile, reorderTiles, normalizeTiles } from './tile'

/** Two 2×2 metas over a tileset, tiles chosen so every position is distinguishable. */
function fixture(): ReturnType<typeof normalizeMetaTiles> {
  return normalizeMetaTiles({
    tileset: 'res/main.tiles.json',
    width: 2,
    height: 2,
    metas: [
      { name: 'ground', tiles: [1, 2, 3, 4] },
      { name: 'wall', tiles: [5, 6, 7, 8] }
    ]
  })
}

describe('meta-tile set', () => {
  it('forces every meta to the set geometry, so the exported table has one stride', () => {
    // A hand-edited file with a short meta and an over-long one: the table is read
    // at a fixed stride, so one odd entry would shift every meta after it.
    const doc = normalizeMetaTiles({
      tileset: 'res/main.tiles.json',
      width: 2,
      height: 2,
      metas: [{ name: 'short', tiles: [9] }, { name: 'long', tiles: [1, 2, 3, 4, 5, 6] }]
    })
    expect(doc.metas.map((meta) => meta.tiles)).toEqual([
      [9, 0, 0, 0],
      [1, 2, 3, 4]
    ])
    expect(metaStride(doc)).toBe(4)
    expect([...metaBytes(doc)]).toEqual([9, 0, 0, 0, 1, 2, 3, 4])
    expect(validateMetaTiles(doc)).toEqual([])
  })

  it('names an unnamed meta after its index and keeps a given name', () => {
    const doc = normalizeMetaTiles({ tileset: 'a.tiles.json', metas: [{}, { name: 'sky' }] })
    expect(doc.metas.map((meta) => meta.name)).toEqual(['meta_0', 'sky'])
  })

  it('reads and writes one cell of a meta', () => {
    const doc = fixture()
    expect(metaTileAt(doc, 0, 1, 1)).toBe(4)
    const painted = setMetaTile(doc, 0, 1, 1, 42)
    expect(metaTileAt(painted, 0, 1, 1)).toBe(42)
    // Untouched metas are the same objects, so a repaint is one cheap history entry.
    expect(painted.metas[1]).toBe(doc.metas[1])
    // Painting the value already there changes nothing at all.
    expect(setMetaTile(painted, 0, 1, 1, 42)).toBe(painted)
    expect(setMetaTile(doc, 0, 2, 0, 1)).toBe(doc)
  })

  it('resizes every meta at once, keeping what still fits', () => {
    const grown = resizeMetas(fixture(), 3, 2)
    expect(grown.width).toBe(3)
    expect(grown.metas[0].tiles).toEqual([1, 2, 0, 3, 4, 0])
    const shrunk = resizeMetas(grown, 1, 1)
    expect(shrunk.metas.map((meta) => meta.tiles)).toEqual([[1], [5]])
  })

  it('adds a blank meta of the set geometry', () => {
    const doc = addMeta(resizeMetas(fixture(), 3, 3))
    expect(doc.metas).toHaveLength(3)
    expect(doc.metas[2]).toEqual({ name: 'meta_2', width: 3, height: 3, tiles: new Array(9).fill(0) })
    expect(renameMeta(doc, 2, 'sky').metas[2].name).toBe('sky')
  })
})

describe('meta-tile remap seams', () => {
  it('replays a tileset reorder into the meta definitions', () => {
    // Tile 1 moves to slot 3: everything that pointed at it has to follow.
    const tiles = normalizeTiles({ mode: 'sc2', count: 10 })
    const { mapping } = reorderTiles(tiles, 1, 3)
    const doc = remapMetaTiles(fixture(), mapping)
    expect(doc.metas[0].tiles).toEqual([mapping[1], mapping[2], mapping[3], mapping[4]])
    expect(doc.metas[0].tiles[0]).toBe(3)
  })

  it('points a meta at tile 0 when the tile it used was deleted', () => {
    const tiles = normalizeTiles({ mode: 'sc2', count: 10 })
    const { mapping } = removeTile(tiles, 3)
    const doc = remapMetaTiles(fixture(), mapping)
    // Tile 3 is gone → 0; tile 4 slides down into its slot.
    expect(doc.metas[0].tiles).toEqual([1, 2, 0, 3])
  })

  it('returns the mapping a map replays when a meta is deleted or moved', () => {
    const doc = fixture()
    const removed = removeMeta(addMeta(doc), 0)
    expect(removed.doc.metas.map((meta) => meta.name)).toEqual(['wall', 'meta_2'])
    // Cells that pointed at the deleted meta fall back to 0, the rest slide down.
    expect(removed.mapping).toEqual([0, 0, 1])

    const moved = reorderMetas(doc, 0, 1)
    expect(moved.doc.metas.map((meta) => meta.name)).toEqual(['wall', 'ground'])
    expect(moved.mapping).toEqual([1, 0])
    expect(reorderMetas(doc, 0, 0).doc).toBe(doc)
  })
})

describe('meta-tile validation', () => {
  it('accepts a normal set and reports a blank one', () => {
    expect(validateMetaTiles(fixture())).toEqual([])
    expect(validateMetaTiles(createMetaTilesDoc(''))).toEqual(['No tileset referenced', 'No meta-tiles defined'])
  })

  it('refuses more metas than a map cell can index', () => {
    const doc = normalizeMetaTiles({
      tileset: 'a.tiles.json',
      metas: Array.from({ length: 300 }, (_, i) => ({ name: `m${i}`, tiles: [0, 0, 0, 0] }))
    })
    // Normalization already caps it, which is the fix rather than the complaint.
    expect(doc.metas).toHaveLength(256)
    expect(validateMetaTiles(doc)).toEqual([])
  })
})
