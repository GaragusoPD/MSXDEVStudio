import { describe, expect, it } from 'vitest'
import { createMapDoc, normalizeMap, mapLayerBytes, remapTiles, type MapDoc } from './msx/map'
import { mergeColorByte, normalizeTiles, reorderTiles, tilePixels, type TilesDoc } from './msx/tile'
import {
  addLayer,
  applyStamp,
  canRedo,
  canUndo,
  clearRect,
  copyRect,
  createHistory,
  eraseCells,
  floodPoints,
  normalizeSelection,
  paintValue,
  pendingReorders,
  pushHistory,
  redo,
  removeLayer,
  renameLayer,
  reorderLayer,
  replayReorders,
  samePath,
  singleStamp,
  stampFromMarquee,
  toggleLayerVisible,
  toolPoints,
  undo,
  type MapEntry,
  type Stamp
} from './map-editor'

/** A `width`×`height` map with one background layer, all cells 0. */
function mapDoc(width = 4, height = 4, tileset = 'art/main.tiles.json'): MapDoc {
  return normalizeMap({ tileset, width, height })
}

describe('stamps', () => {
  it('stamps a multi-tile pattern anchored at each point, clipped to the grid', () => {
    const doc = mapDoc(4, 4)
    const stamp: Stamp = { width: 2, height: 2, tiles: [1, 2, 3, 4] }
    // Anchored at (3,3) — bottom-right corner — the rest is clipped off-grid.
    const next = applyStamp(doc, 0, stamp, [{ x: 3, y: 3 }])
    expect(next.layers[0].data[3 * 4 + 3]).toBe(1)
    expect(next.layers[0].data.filter((v) => v !== 0)).toEqual([1])
  })

  it('a full in-bounds stamp lands exactly', () => {
    const doc = mapDoc(4, 4)
    const stamp: Stamp = { width: 2, height: 1, tiles: [9, 8] }
    const next = applyStamp(doc, 0, stamp, [{ x: 1, y: 1 }])
    expect(next.layers[0].data[1 * 4 + 1]).toBe(9)
    expect(next.layers[0].data[1 * 4 + 2]).toBe(8)
  })

  it('is a no-op (same reference) when nothing changes', () => {
    const doc = mapDoc(4, 4)
    const next = applyStamp(doc, 0, singleStamp(0), [{ x: 0, y: 0 }])
    expect(next).toBe(doc)
  })

  it('returns the doc unchanged for an out-of-range layer index', () => {
    const doc = mapDoc(4, 4)
    expect(applyStamp(doc, 5, singleStamp(1), [{ x: 0, y: 0 }])).toBe(doc)
  })
})

describe('stampFromMarquee', () => {
  it('builds a rectangular stamp from two grid indices, either order', () => {
    // 4-wide grid: indices 5,6 / 9,10 form a 2x2 block starting at (1,1).
    expect(stampFromMarquee(5, 10, 4, 16)).toEqual({ width: 2, height: 2, tiles: [5, 6, 9, 10] })
    expect(stampFromMarquee(10, 5, 4, 16)).toEqual({ width: 2, height: 2, tiles: [5, 6, 9, 10] })
  })

  it('a single index is a 1x1 stamp', () => {
    expect(stampFromMarquee(7, 7, 4, 16)).toEqual({ width: 1, height: 1, tiles: [7] })
  })

  it('slots beyond the tileset count become 0', () => {
    // 4-wide grid, only indices 0..4 exist: row 0 (1,2,3) is valid, row 1 (5,6,7) is not.
    expect(stampFromMarquee(1, 7, 4, 5)).toEqual({ width: 3, height: 2, tiles: [1, 2, 3, 0, 0, 0] })
  })
})

describe('paint / erase', () => {
  it('paints a uniform value over every point, ignoring out-of-bounds ones', () => {
    const doc = mapDoc(4, 4)
    const next = paintValue(doc, 0, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 9, y: 9 }], 7)
    expect(next.layers[0].data.slice(0, 2)).toEqual([7, 7])
    expect(next.layers[0].data.filter((v) => v === 7)).toHaveLength(2)
  })

  it('erase sets cells back to 0', () => {
    const doc = paintValue(mapDoc(4, 4), 0, [{ x: 0, y: 0 }], 5)
    const erased = eraseCells(doc, 0, [{ x: 0, y: 0 }])
    expect(erased.layers[0].data[0]).toBe(0)
  })
})

describe('tool points', () => {
  it('rect (outline) touches only the border', () => {
    const points = toolPoints('rect', { x: 0, y: 0 }, { x: 2, y: 2 }, false)
    expect(points).toHaveLength(8)
  })

  it('rect (filled) touches every cell', () => {
    const points = toolPoints('rect', { x: 0, y: 0 }, { x: 2, y: 2 }, true)
    expect(points).toHaveLength(9)
  })

  it('stamp/erase drag interpolates a line between samples', () => {
    const points = toolPoints('stamp', { x: 0, y: 0 }, { x: 3, y: 0 }, false)
    expect(points).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }])
  })
})

describe('flood fill', () => {
  it('fills the connected region sharing the start cell value', () => {
    // 4x4, cross of value 1 in the middle, everything else 0.
    let doc = mapDoc(4, 4)
    doc = paintValue(doc, 0, [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 2 }], 1)
    const points = floodPoints(doc, doc.layers[0], { x: 0, y: 0 })
    // Everything except the 2x2 block of 1s.
    expect(points).toHaveLength(16 - 4)
    expect(points.some((p) => p.x === 1 && p.y === 1)).toBe(false)
  })

  it('returns nothing for an out-of-bounds start', () => {
    expect(floodPoints(mapDoc(4, 4), mapDoc(4, 4).layers[0], { x: -1, y: 0 })).toEqual([])
  })
})

describe('rectangular select + copy/paste', () => {
  it('copies a rect and pastes it elsewhere unchanged', () => {
    let doc = mapDoc(6, 6)
    doc = applyStamp(doc, 0, { width: 2, height: 2, tiles: [1, 2, 3, 4] }, [{ x: 0, y: 0 }])
    const rect = normalizeSelection(doc, { x: 0, y: 0 }, { x: 1, y: 1 })
    const clip = copyRect(doc, doc.layers[0], rect)
    expect(clip).toEqual({ width: 2, height: 2, tiles: [1, 2, 3, 4] })

    const pasted = applyStamp(doc, 0, clip, [{ x: 3, y: 3 }])
    expect(pasted.layers[0].data[3 * 6 + 3]).toBe(1)
    expect(pasted.layers[0].data[4 * 6 + 4]).toBe(4)
    // Original selection untouched.
    expect(pasted.layers[0].data[0]).toBe(1)
  })

  it('clips the selection to the grid and normalizes reversed corners', () => {
    const doc = mapDoc(4, 4)
    const rect = normalizeSelection(doc, { x: 3, y: 3 }, { x: 10, y: -5 })
    expect(rect).toEqual({ x: 3, y: 0, width: 1, height: 4 })
  })

  it('clears a selected rect', () => {
    let doc = mapDoc(4, 4)
    doc = paintValue(doc, 0, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }], 9)
    const cleared = clearRect(doc, 0, { x: 0, y: 0, width: 2, height: 2 })
    expect(cleared.layers[0].data.every((v) => v === 0)).toBe(true)
  })
})

describe('layer list ops', () => {
  it('adds, renames, toggles visibility, and removes layers', () => {
    let doc = mapDoc(2, 2)
    doc = addLayer(doc, 'foreground')
    expect(doc.layers).toHaveLength(2)
    doc = renameLayer(doc, 1, 'meta')
    expect(doc.layers[1].name).toBe('meta')
    doc = toggleLayerVisible(doc, 1)
    expect(doc.layers[1].visible).toBe(false)
    doc = removeLayer(doc, 1)
    expect(doc.layers).toHaveLength(1)
  })

  it('reorderLayer moves a layer and refuses out-of-range moves', () => {
    let doc = mapDoc(2, 2)
    doc = addLayer(doc, 'foreground')
    doc = addLayer(doc, 'meta')
    const names = (d: MapDoc): string[] => d.layers.map((l) => l.name)
    expect(names(reorderLayer(doc, 2, 0))).toEqual(['meta', 'background', 'foreground'])
    expect(names(reorderLayer(doc, 0, 1))).toEqual(['foreground', 'background', 'meta'])
    expect(reorderLayer(doc, 1, 1)).toBe(doc)
    expect(reorderLayer(doc, 0, 3)).toBe(doc)
  })

  it('refuses to remove the last layer', () => {
    const doc = mapDoc(2, 2)
    expect(removeLayer(doc, 0)).toBe(doc)
  })
})

describe('undo/redo', () => {
  it('round-trips through stamp/fill/erase ops', () => {
    const start = mapDoc(4, 4)
    let history = createHistory(start)
    history = pushHistory(history, paintValue(start, 0, [{ x: 0, y: 0 }], 1))
    history = pushHistory(history, paintValue(history.present, 0, [{ x: 1, y: 0 }], 2))
    expect(history.present.layers[0].data.slice(0, 2)).toEqual([1, 2])

    history = undo(history)
    expect(history.present.layers[0].data.slice(0, 2)).toEqual([1, 0])
    expect(canRedo(history)).toBe(true)

    history = undo(history)
    expect(history.present).toBe(start)
    expect(canUndo(history)).toBe(false)

    history = redo(history)
    history = redo(history)
    expect(history.present.layers[0].data.slice(0, 2)).toEqual([1, 2])
    expect(canRedo(history)).toBe(false)
  })

  it('a no-op commit does not grow the stack', () => {
    const start = mapDoc(4, 4)
    let history = createHistory(start)
    history = pushHistory(history, start)
    expect(canUndo(history)).toBe(false)
  })

  it('a history entry can carry the tiles an edit stroke overwrote', () => {
    const before = { pattern: new Array(8).fill(0x11), color: new Array(8).fill(0xf1) }
    const base: MapEntry = { doc: createMapDoc('res/t.tiles.json') }
    const history = pushHistory(createHistory(base), {
      doc: base.doc,
      tileEdits: [{ index: 4, bank: null, before, after: before }]
    })

    expect(history.present.tileEdits?.[0].before).toBe(before)
    expect(undo(history).present.tileEdits).toBeUndefined()
  })
})

describe('path matching', () => {
  it('ignores case, backslashes and a leading ./', () => {
    expect(samePath('./Art/Main.Tiles.json', 'art/main.tiles.json')).toBe(true)
    expect(samePath('art\\main.tiles.json', 'art/main.tiles.json')).toBe(true)
    expect(samePath('art/other.tiles.json', 'art/main.tiles.json')).toBe(false)
  })
})

describe('tileset reorder replay', () => {
  /** A 3-tile sc2 tileset, reordered so tile 2 moves to the front. */
  function reorderedTileset(): { before: TilesDoc; after: TilesDoc; mapping: number[] } {
    const before = normalizeTiles({
      mode: 'sc2',
      count: 3,
      tiles: [
        { pattern: [0x0f, 0, 0, 0, 0, 0, 0, 0], color: new Array(8).fill(mergeColorByte(1, 2)) },
        { pattern: [0xf0, 0, 0, 0, 0, 0, 0, 0], color: new Array(8).fill(mergeColorByte(3, 4)) },
        { pattern: [0xff, 0, 0, 0, 0, 0, 0, 0], color: new Array(8).fill(mergeColorByte(5, 6)) }
      ]
    })
    const { doc: after, mapping } = reorderTiles(before, 2, 0)
    return { before, after, mapping }
  }

  it('pendingReorders filters by the last-seen marker', () => {
    const log = [{ path: 'a', mapping: [0], at: 10 }, { path: 'a', mapping: [1], at: 20 }]
    expect(pendingReorders(log, null)).toEqual(log)
    expect(pendingReorders(log, 10)).toEqual([log[1]])
    expect(pendingReorders(log, 20)).toEqual([])
  })

  it('replays outstanding events in order and advances the marker', () => {
    const { mapping } = reorderedTileset()
    const doc = normalizeMap({ tileset: 'art/main.tiles.json', width: 2, height: 1, layers: [{ name: 'bg', data: [2, 1] }] })
    const log = [{ path: 'art/main.tiles.json', mapping, at: 100 }]
    const result = replayReorders(doc, log, null)
    expect(result.applied).toBe(1)
    expect(result.seenAt).toBe(100)
    expect(result.doc.layers[0].data).toEqual([mapping[2], mapping[1]])
    // Re-replaying with the advanced marker is a no-op.
    const again = replayReorders(result.doc, log, result.seenAt)
    expect(again.applied).toBe(0)
    expect(again.doc).toBe(result.doc)
  })

  it('acceptance: a tileset reorder round-trip leaves the rendered map visually identical', () => {
    const { before, after, mapping } = reorderedTileset()
    // A tiny map that uses every tile index at least once.
    const doc = normalizeMap({
      tileset: 'art/main.tiles.json',
      width: 3,
      height: 1,
      layers: [{ name: 'bg', data: [0, 1, 2] }]
    })
    const remapped = remapTiles(doc, mapping)
    for (let x = 0; x < 3; x++) {
      const originalTile = doc.layers[0].data[x]
      const remappedTile = remapped.layers[0].data[x]
      expect(tilePixels(after, remappedTile)).toEqual(tilePixels(before, originalTile))
    }
  })
})

describe('acceptance: export a 3-screen-wide map, byte-check a known cell', () => {
  it('mapLayerBytes matches what was stamped, at a specific cell', () => {
    const doc = mapDoc(96, 24, 'art/world.tiles.json') // 3 screens of 32x24
    // Stamp a distinctive 2x2 block at the seam of screen 2 and screen 3 (x=31..32).
    const stamped = applyStamp(doc, 0, { width: 2, height: 2, tiles: [10, 20, 30, 40] }, [{ x: 31, y: 10 }])
    const bytes = mapLayerBytes(stamped.layers[0])
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes[10 * 96 + 31]).toBe(10)
    expect(bytes[10 * 96 + 32]).toBe(20)
    expect(bytes[11 * 96 + 31]).toBe(30)
    expect(bytes[11 * 96 + 32]).toBe(40)
    // Untouched cell elsewhere on the third screen stays 0.
    expect(bytes[0 * 96 + 64]).toBe(0)
  })
})
