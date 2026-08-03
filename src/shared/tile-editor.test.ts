import { describe, expect, it } from 'vitest'
import { quantize } from './msx/quantize'
import { parseResource, renderResource, serializeResource } from './msx/resource'
import {
  createTilesDoc,
  mergeColorByte,
  normalizeTiles,
  packTiles,
  reorderTiles,
  rowColorViolations,
  splitColorByte,
  tilePixels,
  validateTiles,
  type TilesDoc
} from './msx/tile'
import {
  applyRoleStroke,
  applyStroke,
  canRedo,
  canUndo,
  emitTilesReordered,
  fillPoints,
  historyDoc,
  initHistory,
  invertMapping,
  linePoints,
  marqueeIndices,
  onTilesReordered,
  pushHistory,
  rectPoints,
  redoHistory,
  setPaletteEntry,
  setTileFlagBit,
  setRowColors,
  transformTile,
  undoHistory,
  type Point
} from './tile-editor'

/** A one-tile sc2 document whose row 0 is `pattern` with the given FG/BG. */
function sc2(pattern: number, fg: number, bg: number): TilesDoc {
  return normalizeTiles({
    mode: 'sc2',
    count: 1,
    tiles: [{ pattern: [pattern, 0, 0, 0, 0, 0, 0, 0], color: [mergeColorByte(fg, bg), 0, 0, 0, 0, 0, 0, 0] }]
  })
}

describe('tools → pixels', () => {
  it('draws a diagonal line inclusive of both endpoints', () => {
    expect(linePoints({ x: 0, y: 0 }, { x: 3, y: 3 })).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 }
    ])
  })

  it('draws a horizontal line regardless of direction', () => {
    expect(linePoints({ x: 5, y: 2 }, { x: 2, y: 2 }).map((p) => p.x)).toEqual([5, 4, 3, 2])
  })

  it('outlines a rect, or fills it when asked', () => {
    expect(rectPoints({ x: 1, y: 1 }, { x: 3, y: 3 })).toHaveLength(8)
    expect(rectPoints({ x: 1, y: 1 }, { x: 3, y: 3 }, true)).toHaveLength(9)
  })

  it('floods only the contiguous same-colored region', () => {
    // Row 0 is FG (15), the rest BG (1): filling a BG pixel must not cross into row 0.
    const pixels = tilePixels(sc2(0xff, 15, 1), 0)
    expect(fillPoints(pixels, { x: 0, y: 1 })).toHaveLength(56)
    expect(fillPoints(pixels, { x: 0, y: 0 })).toHaveLength(8)
  })
})

describe('applyStroke — constraint conflicts', () => {
  /** Row 0 = 4 px of color 15 then 4 px of color 1; painting a third color there is a real conflict. */
  const twoToneRow = (): TilesDoc => sc2(0b11110000, 15, 1)

  it('stops at the conflicting pixel and reports what is pending', () => {
    const points: Point[] = [
      { x: 0, y: 1 },
      { x: 0, y: 0 },
      { x: 1, y: 0 }
    ]
    const result = applyStroke(twoToneRow(), 0, points, 7)
    if (result.ok) throw new Error('expected a conflict')
    expect(result.conflict).toEqual({ scope: 'row', index: 0, fg: 15, bg: 1, wanted: 7 })
    expect(result.pending).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 }
    ])
    // Row 1 was painted before the stop, so partial work is kept, not lost.
    expect(result.doc.tiles[0].pattern[1]).not.toBe(0)
  })

  it('“replace row FG” finishes the stroke and leaves validator-clean bytes', () => {
    const first = applyStroke(twoToneRow(), 0, rectPoints({ x: 0, y: 0 }, { x: 1, y: 0 }, true), 7)
    if (first.ok) throw new Error('expected a conflict')
    const resolved = applyStroke(first.doc, 0, first.pending, 7, 'fg')
    if (!resolved.ok) throw new Error('expected the resolution to succeed')
    expect(splitColorByte(resolved.doc.tiles[0].color[0])).toEqual({ fg: 7, bg: 1 })
    expect(tilePixels(resolved.doc, 0)[0]).toBe(7)
    expect(validateTiles(resolved.doc)).toEqual([])
  })

  it('“replace row BG” finishes the stroke and leaves validator-clean bytes', () => {
    const first = applyStroke(twoToneRow(), 0, rectPoints({ x: 0, y: 0 }, { x: 1, y: 0 }, true), 7)
    if (first.ok) throw new Error('expected a conflict')
    const resolved = applyStroke(first.doc, 0, first.pending, 7, 'bg')
    if (!resolved.ok) throw new Error('expected the resolution to succeed')
    expect(splitColorByte(resolved.doc.tiles[0].color[0])).toEqual({ fg: 15, bg: 7 })
    expect(tilePixels(resolved.doc, 0)[0]).toBe(7)
    expect(validateTiles(resolved.doc)).toEqual([])
  })

  it('resolves an sc1 group conflict without breaking the per-group byte layout', () => {
    const doc = normalizeTiles({
      mode: 'sc1',
      count: 8,
      groupColors: [mergeColorByte(15, 1)],
      tiles: Array.from({ length: 8 }, () => ({ pattern: [0xf0, 0, 0, 0, 0, 0, 0, 0] }))
    })
    const conflicted = applyStroke(doc, 0, [{ x: 0, y: 0 }], 7)
    if (conflicted.ok) throw new Error('expected a group conflict')
    expect(conflicted.conflict.scope).toBe('group')
    const resolved = applyStroke(conflicted.doc, 0, conflicted.pending, 7, 'fg')
    if (!resolved.ok) throw new Error('expected the resolution to succeed')
    expect(resolved.doc.groupColors).toEqual([mergeColorByte(7, 1)])
    expect(validateTiles(resolved.doc)).toEqual([])
  })

  it('ignores pixels dragged outside the tile instead of throwing', () => {
    const result = applyStroke(sc2(0, 15, 1), 0, [{ x: -3, y: 4 }, { x: 9, y: 0 }], 15)
    expect(result.ok).toBe(true)
    expect((result as { changed: boolean }).changed).toBe(false)
  })
})

describe('applyRoleStroke — the left/right mouse buttons', () => {
  /** Row 0 already holds two colors, which is exactly where applyStroke would conflict. */
  const twoToneRow = (): TilesDoc => sc2(0b11110000, 15, 1)

  it('sets pattern bits for fg and clears them for bg, without touching colors', () => {
    const before = twoToneRow()
    const fg = applyRoleStroke(before, 0, [{ x: 5, y: 0 }], 'fg')
    expect(fg.tiles[0].pattern[0]).toBe(0b11110100)
    const bg = applyRoleStroke(fg, 0, [{ x: 0, y: 0 }], 'bg')
    expect(bg.tiles[0].pattern[0]).toBe(0b01110100)
    // The row's palette is untouched by either button.
    expect(bg.tiles[0].color[0]).toBe(before.tiles[0].color[0])
  })

  it('never conflicts on a row that already uses two colors', () => {
    // The same stroke through applyStroke with a third color is a conflict...
    const conflicting = applyStroke(twoToneRow(), 0, [{ x: 5, y: 0 }], 7)
    expect(conflicting.ok).toBe(false)
    // ...but painting the row's own roles always succeeds.
    expect(() => applyRoleStroke(twoToneRow(), 0, [{ x: 5, y: 0 }], 'fg')).not.toThrow()
  })

  it('paints each row with that row\'s own colors across a multi-row stroke', () => {
    let doc = normalizeTiles({
      mode: 'sc2',
      count: 1,
      tiles: [{ pattern: [0, 0, 0, 0, 0, 0, 0, 0], color: [mergeColorByte(4, 5), mergeColorByte(6, 7), 0, 0, 0, 0, 0, 0] }]
    })
    doc = applyRoleStroke(doc, 0, [{ x: 0, y: 0 }, { x: 0, y: 1 }], 'fg')
    // Both bits set; each pixel resolves to its own row's foreground.
    expect(tilePixels(doc, 0)[0]).toBe(4)
    expect(tilePixels(doc, 0)[8]).toBe(6)   // 8 px per row, so index 8 is row 1
  })

  it('ignores points outside the tile and returns the same document when nothing changes', () => {
    const doc = twoToneRow()
    expect(applyRoleStroke(doc, 0, [{ x: -1, y: 0 }, { x: 9, y: 0 }], 'fg')).toBe(doc)
    // x=0 is already foreground, so asking for foreground again is a no-op.
    expect(applyRoleStroke(doc, 0, [{ x: 0, y: 0 }], 'fg')).toBe(doc)
  })
})

describe('tile flags', () => {
  it('toggles bits independently and leaves other tiles alone', () => {
    let doc = createTilesDoc('sc2', 3)
    expect(doc.flags).toEqual([0, 0, 0])

    doc = setTileFlagBit(doc, 1, 0, true)      // flag 1
    doc = setTileFlagBit(doc, 1, 3, true)      // flag 4
    expect(doc.flags).toEqual([0, 0b1001, 0])

    doc = setTileFlagBit(doc, 1, 0, false)
    expect(doc.flags).toEqual([0, 0b1000, 0])
  })

  it('returns the same document when nothing changes or the target is out of range', () => {
    const doc = setTileFlagBit(createTilesDoc('sc2', 2), 0, 2, true)
    expect(setTileFlagBit(doc, 0, 2, true)).toBe(doc)   // already set
    expect(setTileFlagBit(doc, 9, 0, true)).toBe(doc)   // no such tile
    expect(setTileFlagBit(doc, 0, 8, true)).toBe(doc)   // only eight bits exist
    expect(setTileFlagBit(doc, 0, -1, true)).toBe(doc)
  })

  it('survives a JSON round-trip, and older files without flags load as zero', () => {
    let doc = createTilesDoc('sc2', 2)
    doc = setTileFlagBit(doc, 0, 7, true)
    expect(normalizeTiles(JSON.parse(JSON.stringify(doc))).flags).toEqual([0b10000000, 0])

    const legacy = { mode: 'sc2', count: 2 }   // written before flags existed
    expect(normalizeTiles(legacy).flags).toEqual([0, 0])
  })
})

describe('transformTile', () => {
  const doc = sc2(0b10000000, 15, 1)

  it('wraps shifts and keeps the row colors attached to their rows', () => {
    expect(transformTile(doc, 0, 'shiftRight').doc.tiles[0].pattern[0]).toBe(0b01000000)
    expect(transformTile(doc, 0, 'shiftLeft').doc.tiles[0].pattern[0]).toBe(0b00000001)
    const down = transformTile(doc, 0, 'shiftDown').doc
    expect(down.tiles[0].pattern[1]).toBe(0b10000000)
    expect(down.tiles[0].color[1]).toBe(mergeColorByte(15, 1))
    expect(transformTile(down, 0, 'shiftUp').doc).toEqual(doc)
  })

  it('mirrors exactly, colors included', () => {
    expect(transformTile(doc, 0, 'mirrorH').doc.tiles[0].pattern[0]).toBe(0b00000001)
    const flipped = transformTile(doc, 0, 'mirrorV').doc
    expect(flipped.tiles[0].pattern[7]).toBe(0b10000000)
    expect(flipped.tiles[0].color[7]).toBe(mergeColorByte(15, 1))
  })

  it('rotates through the pixel grid and stays valid, reporting rows that lost a color', () => {
    // Two rows with different pairs: rotating mixes them, so the fit is lossy.
    const mixed = normalizeTiles({
      mode: 'sc2',
      count: 1,
      tiles: [
        {
          pattern: [0xff, 0x0f, 0, 0, 0, 0, 0, 0],
          color: [mergeColorByte(15, 1), mergeColorByte(7, 4), 0xf1, 0xf1, 0xf1, 0xf1, 0xf1, 0xf1]
        }
      ]
    })
    const rotated = transformTile(mixed, 0, 'rotateCW')
    expect(validateTiles(rotated.doc)).toEqual([])
    expect(rotated.lossyRows.length).toBeGreaterThan(0)
  })

  it('rotates sc1 exactly (one pair for the whole group)', () => {
    const group = normalizeTiles({
      mode: 'sc1',
      count: 8,
      groupColors: [mergeColorByte(15, 1)],
      tiles: [{ pattern: [0xff, 0, 0, 0, 0, 0, 0, 0] }]
    })
    const rotated = transformTile(group, 0, 'rotateCW')
    expect(rotated.doc.tiles[0].pattern).toEqual([0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01])
    expect(rotated.lossyRows).toEqual([])
    expect(validateTiles(rotated.doc)).toEqual([])
  })
})

describe('direct color edits', () => {
  it('writes a row pair without touching the pattern', () => {
    const next = setRowColors(sc2(0b10101010, 15, 1), 0, 0, 4, 11)
    expect(splitColorByte(next.tiles[0].color[0])).toEqual({ fg: 4, bg: 11 })
    expect(next.tiles[0].pattern[0]).toBe(0b10101010)
    expect(validateTiles(next)).toEqual([])
  })

  it('writes the group byte in sc1', () => {
    const doc = normalizeTiles({ mode: 'sc1', count: 16 })
    expect(setRowColors(doc, 9, 0, 2, 3).groupColors[1]).toBe(mergeColorByte(2, 3))
  })

  it('snaps a palette entry into the GRB333 space', () => {
    const doc = createTilesDoc('sc4', 1)
    const next = setPaletteEntry(doc, 3, 0xffff)
    expect(next.palette?.[3]).toBe(0x0777)
    expect(validateTiles(next)).toEqual([])
  })
})

describe('undo/redo', () => {
  it('stays consistent across paint, reorder and palette steps', () => {
    const start = createTilesDoc('sc4', 4)
    let history = initHistory(start)
    expect(canUndo(history)).toBe(false)

    const painted = applyStroke(start, 0, [{ x: 0, y: 0 }], 15)
    if (!painted.ok) throw new Error('unexpected conflict')
    history = pushHistory(history, painted.doc, 'pencil')

    const { doc: reordered, mapping } = reorderTiles(painted.doc, 0, 3)
    history = pushHistory(history, reordered, 'reorder', mapping)

    const recolored = setPaletteEntry(reordered, 1, 0x0123)
    history = pushHistory(history, recolored, 'palette')

    expect(historyDoc(history).palette?.[1]).toBe(0x0123)
    history = undoHistory(history)
    expect(historyDoc(history).palette?.[1]).not.toBe(0x0123)
    expect(historyDoc(history).tiles[3].pattern[0]).toBe(0x80)

    // The reorder step carries the mapping so undo can replay its inverse over maps.
    expect(history.entries[history.index].remap).toEqual(mapping)
    history = undoHistory(history)
    expect(historyDoc(history).tiles[0].pattern[0]).toBe(0x80)

    history = undoHistory(history)
    expect(historyDoc(history)).toBe(start)
    expect(canUndo(history)).toBe(false)
    expect(canRedo(history)).toBe(true)

    // Redo all the way back up.
    history = redoHistory(redoHistory(redoHistory(history)))
    expect(historyDoc(history)).toBe(recolored)
    expect(canRedo(history)).toBe(false)

    // A new edit after an undo drops the redo branch.
    history = pushHistory(undoHistory(history), start, 'reset')
    expect(canRedo(history)).toBe(false)
    expect(historyDoc(history)).toBe(start)
  })

  it('keeps a reorder mapping on its entry and can invert it', () => {
    const doc = createTilesDoc('sc2', 4)
    const { mapping } = reorderTiles(doc, 0, 2)
    expect(mapping).toEqual([2, 0, 1, 3])
    expect(invertMapping(mapping)).toEqual([1, 2, 0, 3])
    const history = pushHistory(initHistory(doc), doc, 'reorder', mapping)
    expect(history.entries[history.index].remap).toEqual(mapping)
  })
})

describe('marqueeIndices', () => {
  it('selects the rectangle between two tiles and stops at the tile count', () => {
    expect(marqueeIndices(0, 17, 16, 256)).toEqual([0, 1, 16, 17])
    expect(marqueeIndices(17, 0, 16, 256)).toEqual([0, 1, 16, 17])
    expect(marqueeIndices(0, 17, 16, 17)).toEqual([0, 1, 16])
  })
})

describe('the Spec 10 remap seam', () => {
  it('delivers reorders to subscribers until they unsubscribe', () => {
    const seen: number[][] = []
    const off = onTilesReordered((event) => seen.push(event.mapping))
    emitTilesReordered({ path: 'art/hero.tiles.json', mapping: [1, 0], at: 1 })
    off()
    emitTilesReordered({ path: 'art/hero.tiles.json', mapping: [1, 0], at: 2 })
    expect(seen).toEqual([[1, 0]])
  })
})

describe('image import → save → export round-trip', () => {
  /** A 32×16 RGBA test image: vertical color bands, so tiles differ and some repeat. */
  function bands(width: number, height: number): Uint8ClampedArray {
    const data = new Uint8ClampedArray(width * height * 4)
    const colors = [
      [0, 0, 0],
      [255, 255, 255],
      [212, 82, 77],
      [33, 200, 66]
    ]
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [r, g, b] = colors[Math.floor(x / 8) % colors.length]
        const i = (y * width + x) * 4
        data[i] = r
        data[i + 1] = g
        data[i + 2] = b
        data[i + 3] = 255
      }
    }
    return data
  }

  it('quantizes, packs, saves and re-parses into bytes the validator accepts', () => {
    const width = 32
    const height = 16
    const converted = quantize({ width, height, data: bands(width, height) }, { mode: 'sc2', palette: 'msx1' })
    expect(rowColorViolations(converted.indices, width, height)).toEqual([])

    const { doc, layout, lossyTiles } = packTiles(converted.indices, width, height, 'sc2', { dedup: true })
    expect(lossyTiles).toEqual([])
    // Two identical rows of 4 distinct bands: dedup must fold the second row onto the first.
    expect(layout).toHaveLength(8)
    expect(doc.count).toBeLessThan(8)

    doc.export = { name: 'g_Imported', format: 'c', out: 'content/imported.h' }
    const text = serializeResource({ kind: 'tiles', doc })
    const reloaded = parseResource('imported.tiles.json', text)
    expect(reloaded.kind).toBe('tiles')
    expect(reloaded.doc).toEqual(doc)
    expect(validateTiles(reloaded.doc as TilesDoc)).toEqual([])

    const header = new TextDecoder().decode(renderResource(reloaded, 'imported.tiles.json', doc.export))
    expect(header).toContain('g_Imported_Patterns')
    expect(header).toContain('g_Imported_Colors')
  })

  it('survives an edit after import: conflict resolution keeps the exported bytes legal', () => {
    const width = 8
    const height = 8
    const converted = quantize({ width, height, data: bands(width, height) }, { mode: 'sc2', palette: 'msx1' })
    const { doc } = packTiles(converted.indices, width, height, 'sc2')
    let edited = doc
    // Paint every pixel of the tile with a third color, resolving each conflict as "replace FG".
    for (let y = 0; y < 8; y++) {
      let pending: Point[] = rectPoints({ x: 0, y }, { x: 7, y }, true)
      let resolution: 'fg' | 'bg' | undefined
      for (let guard = 0; pending.length && guard < 4; guard++) {
        const result = applyStroke(edited, 0, pending, 9, resolution)
        edited = result.doc
        if (result.ok) break
        pending = result.pending
        resolution = 'fg'
      }
    }
    expect(validateTiles(edited)).toEqual([])
    expect([...tilePixels(edited, 0)].every((value) => value === 9)).toBe(true)
  })
})
