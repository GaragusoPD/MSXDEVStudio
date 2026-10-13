import { describe, expect, it } from 'vitest'
import {
  addMetaRef,
  decodeIndexedStream,
  expandIndexedLayer,
  indexedLayerHelperC,
  indexedLayerStream,
  mapExport,
  metaCellTables,
  normalizeMap,
  overlappingPlacement,
  placeMeta,
  placementBytes,
  placementCount,
  setLayerIndexed,
  setPlacementBaked,
  validateMap,
  type MapDoc,
  type MetaRef
} from './map'
import { renderResourceFiles } from './resource'

/** A meta that owns its pixels, as a map mirrors it: `cells` are its tiles in the map's tileset. */
function ref(name: string, width: number, height: number, cells?: number[]): MetaRef {
  return {
    path: `res/${name}.meta-tiles.json`,
    name: `g_${name}`,
    width,
    height,
    frames: 1,
    flags: 0,
    cells: cells ?? Array.from({ length: width * height }, (_, i) => 10 + i)
  }
}

/** A map with one indexed layer and the given metas. */
function indexedMap(width: number, height: number, metas: MetaRef[]): MapDoc {
  let doc = normalizeMap({ tileset: 'res/main.tiles.json', width, height, layers: [{ name: 'terrain' }] })
  for (const meta of metas) doc = addMetaRef(doc, meta)
  return setLayerIndexed(doc, 0, true)
}

/** A deterministic pseudo-random sequence, so a failure reproduces. */
function rng(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state / 0x7fffffff
  }
}

describe('the indexed layer stream', () => {
  it('is one byte per meta-tile: a screen of 2×2 metas is 192 bytes', () => {
    let doc = indexedMap(32, 24, [ref('block', 2, 2)])
    for (let y = 0; y < 24; y += 2) for (let x = 0; x < 32; x += 2) doc = placeMeta(doc, 0, 0, x, y)
    const stream = indexedLayerStream(doc, doc.layers[0])
    expect(stream.length).toBe(192)
    expect([...stream].every((byte) => byte === 1)).toBe(true)
  })

  it('takes any mix of sizes, with empty cells between, and reads back to the same placements', () => {
    const metas = [ref('a', 1, 1), ref('b', 2, 1), ref('c', 1, 3), ref('d', 3, 2), ref('e', 4, 4)]
    for (let seed = 1; seed <= 40; seed++) {
      const random = rng(seed)
      let doc = indexedMap(20, 12, metas)
      for (let attempt = 0; attempt < 60; attempt++) {
        const slot = Math.floor(random() * metas.length)
        const x = Math.floor(random() * (20 - metas[slot].width + 1))
        const y = Math.floor(random() * (12 - metas[slot].height + 1))
        const rect = { x, y, width: metas[slot].width, height: metas[slot].height }
        if (overlappingPlacement(doc, 0, rect) === null) doc = placeMeta(doc, 0, slot, x, y)
      }
      const stream = indexedLayerStream(doc, doc.layers[0])
      const byPosition = (p: { x: number; y: number }): number => p.y * 20 + p.x
      const expected = doc.layers[0].placements.map(({ slot, x, y }) => ({ slot, x, y })).sort((p, q) => byPosition(p) - byPosition(q))
      expect(decodeIndexedStream(doc, stream)).toEqual(expected)
      // Every cell is read once, as a meta's top-left or an empty one.
      const covered = expected.reduce((sum, p) => sum + metas[p.slot].width * metas[p.slot].height, 0)
      expect(stream.length).toBe(20 * 12 - covered + expected.length)
    }
  })

  it('a meta whose top-left is covered by an earlier one cannot be encoded — which is why they must not overlap', () => {
    let doc = indexedMap(8, 4, [ref('wide', 3, 1), ref('dot', 1, 1)])
    doc = placeMeta(placeMeta(doc, 0, 0, 0, 0), 0, 1, 1, 0)
    expect(decodeIndexedStream(doc, indexedLayerStream(doc, doc.layers[0]))).toEqual([{ slot: 0, x: 0, y: 0 }])
    expect(validateMap(doc).join()).toMatch(/overlaps "g_wide"|overlaps "g_dot"/)
  })
})

describe('expanding an indexed layer', () => {
  it('writes each meta-tile’s tiles, keeps what was under see-through and empty cells, and says which object covers a cell', () => {
    // A 2×2 rock whose top-right cell is see-through.
    let doc = indexedMap(4, 3, [ref('rock', 2, 2, [5, 0, 6, 7])])
    doc = placeMeta(doc, 0, 0, 1, 1)
    const under = new Array(12).fill(1)
    const { tiles, objects } = expandIndexedLayer(doc, doc.layers[0], under)
    expect(tiles).toEqual([1, 1, 1, 1, 1, 5, 1, 1, 1, 6, 7, 1])
    expect(objects).toEqual([0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0])
  })
})

describe('indexed layers in the editor model', () => {
  it('making a layer indexed clears its grid and unbakes its metas; making it ordinary again loses nothing', () => {
    let doc = normalizeMap({ tileset: 'res/main.tiles.json', width: 4, height: 4, layers: [{ name: 'bg', data: new Array(16).fill(3) }] })
    doc = placeMeta(addMetaRef(doc, ref('rock', 2, 2)), 0, 0, 0, 0)
    doc = setPlacementBaked(doc, 0, 0, true)
    const indexed = setLayerIndexed(doc, 0, true)
    expect(indexed.layers[0].indexed).toBe(true)
    expect(indexed.layers[0].data.every((tile) => tile === 0)).toBe(true)
    expect(indexed.layers[0].placements[0].baked).toBeUndefined()
    const plain = setLayerIndexed(indexed, 0, false)
    expect(plain.layers[0].indexed).toBeUndefined()
    expect(plain.layers[0].placements).toEqual(indexed.layers[0].placements)
  })

  it('round-trips through the file', () => {
    const doc = placeMeta(indexedMap(4, 4, [ref('rock', 2, 2)]), 0, 0, 1, 1)
    const again = normalizeMap(JSON.parse(JSON.stringify(doc)))
    expect(again.layers[0].indexed).toBe(true)
    expect(again.metas[0].cells).toEqual(doc.metas[0].cells)
  })

  it('refuses a meta that references its tileset’s tiles, and an indexed layer on a bitmap map', () => {
    let doc = indexedMap(8, 8, [{ ...ref('old', 1, 1), cells: undefined }])
    doc = placeMeta(doc, 0, 0, 0, 0)
    expect(validateMap(doc).join()).toMatch(/own their pixels/)
    const bitmap = { ...indexedMap(8, 8, []), cell: { width: 16, height: 16, cols: 16 } }
    expect(validateMap(bitmap).join()).toMatch(/needs a map drawn through the name table/)
  })

  it('its metas are not placements: they are in its stream, not in the placement table', () => {
    let doc = normalizeMap({ tileset: 'res/main.tiles.json', width: 8, height: 8, layers: [{ name: 'bg' }, { name: 'objects' }] })
    doc = addMetaRef(doc, ref('rock', 2, 2))
    doc = placeMeta(placeMeta(doc, 0, 0, 0, 0), 1, 0, 4, 4)
    doc = setLayerIndexed(doc, 0, true)
    expect(placementCount(doc)).toBe(1)
    expect([...placementBytes(doc)]).toEqual([0, 4, 4])
  })
})

describe('export', () => {
  function level(): MapDoc {
    let doc = normalizeMap({
      tileset: 'res/main.tiles.json',
      width: 32,
      height: 24,
      layers: [{ name: 'background', data: new Array(768).fill(2) }, { name: 'terrain' }]
    })
    doc = addMetaRef(addMetaRef(doc, ref('rock', 2, 2, [5, 0, 6, 7])), ref('brick', 4, 1, [8, 8, 9, 9]))
    doc = placeMeta(placeMeta(doc, 1, 0, 3, 3), 1, 1, 10, 20)
    return setLayerIndexed(doc, 1, true)
  }

  it('ships the stream raw while the tile layers are packed', () => {
    const exported = mapExport(level(), 'rlep')
    expect(exported.compressed).toBe(true)
    expect(exported.layers[0].unpacked).toBe(768)
    expect(exported.layers[1].indexed).toBe(true)
    expect(exported.layers[1].unpacked).toBeUndefined()
    expect(exported.layers[1].bytes.length).toBe(768 - 4 - 4 + 2)
  })

  it('states each slot’s tiles and where they start', () => {
    const { cells, at } = metaCellTables(level())
    expect([...cells]).toEqual([5, 0, 6, 7, 8, 8, 9, 9])
    expect([...at]).toEqual([0, 0, 4, 0])
  })

  it('emits the expander with the tables it reads', () => {
    const files = renderResourceFiles({ kind: 'map', doc: level() }, 'res/level.map.json', {
      name: 'g_Level',
      format: 'c',
      out: 'content/level.h',
      helpers: true
    })
    expect(files.header).toContain('void g_Level_Expand(const u8* layer, u8* tiles, u8* objects);')
    expect(files.source).toContain('g_Level_MetaCells[]')
    expect(files.source).toContain('g_Level_MetaCellsAt[]')
    expect(files.source).toContain('g_Level_Terrain[]')
    // No placement runtime: every meta is on the indexed layer.
    expect(files.source).not.toContain('_DrawPlacements')
  })

  it('counts columns and rows in 16 bits on a map wider than 255 tiles', () => {
    const wide = setLayerIndexed(normalizeMap({ tileset: 'res/main.tiles.json', width: 300, height: 2 }), 0, true)
    const c = indexedLayerHelperC(addMetaRef(wide, ref('a', 1, 1)), 'g_World').source.join('\n')
    expect(c).toContain('for(u16 x = 0; x < G_WORLD_W; ++x)')
    expect(c).toContain('for(u8 y = 0; y < G_WORLD_H; ++y)')
  })
})
