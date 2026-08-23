import { describe, expect, it } from 'vitest'
import { quantize } from './msx/quantize'
import { parseResource, renderResourceFiles, serializeResource } from './msx/resource'
import {
  blockPixels,
  blockTileAt,
  convertTileMode,
  createTilesDoc,
  MAX_BLOCK,
  mergeColorByte,
  normalizeTiles,
  packTiles,
  removeTile,
  reorderTiles,
  rowColorViolations,
  swapRowColors,
  tileModeConversionLossy,
  splitColorByte,
  tilePixels,
  validateTiles,
  type TilesDoc
} from './msx/tile'
import {
  applyRoleStroke,
  applyStroke,
  blockColorGroupWarning,
  blockColorTargets,
  blockFromTiles,
  canRedo,
  canUndo,
  createBlock,
  copyTiles,
  emitTilesReordered,
  fillPoints,
  fitColumns,
  GRID_COLUMNS,
  historyDoc,
  initHistory,
  invertMapping,
  linePoints,
  marqueeIndices,
  onTilesReordered,
  pushHistory,
  rectPoints,
  redoHistory,
  pasteTiles,
  removeBlock,
  selectionBlock,
  splitBlockPoints,
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

describe('selectionBlock', () => {
  it('reads a marquee as the block the canvas edits', () => {
    expect(selectionBlock(marqueeIndices(0, 17, 16, 256), 16)).toEqual({
      name: 'selection',
      width: 2,
      height: 2,
      tiles: [0, 1, 16, 17]
    })
  })

  it('is null for a single tile, which the canvas shows the plain way', () => {
    expect(selectionBlock([5], 16)).toBeNull()
  })

  it('follows the column count, so a rewrapped sheet spans different tiles', () => {
    expect(selectionBlock([0, 1, 8, 9], 8)).toEqual({ name: 'selection', width: 2, height: 2, tiles: [0, 1, 8, 9] })
    // The same indices at 16 columns are one row with a hole in it, which is no rectangle at all.
    expect(selectionBlock([0, 1, 8, 9], 16)).toBeNull()
  })

  it('drops the ragged tail a short last row leaves', () => {
    // 20 tiles, 16 per row: the marquee's second row only has columns 0..3.
    expect(selectionBlock(marqueeIndices(0, 17, 16, 20), 16)).toEqual({
      name: 'selection',
      width: 2,
      height: 2,
      tiles: [0, 1, 16, 17]
    })
    expect(selectionBlock(marqueeIndices(4, 21, 16, 20), 16)).toEqual({
      name: 'selection',
      width: 2,
      height: 1,
      tiles: [4, 5]
    })
  })
})

describe('the tile clipboard', () => {
  /** A bank whose tile `i` has pattern byte `i` on every row and flags `i`. */
  const bank = (count: number): TilesDoc =>
    normalizeTiles({
      mode: 'sc2',
      count,
      tiles: Array.from({ length: count }, (_, i) => ({ pattern: new Array(8).fill(i), color: new Array(8).fill(0xf1) })),
      flags: Array.from({ length: count }, (_, i) => i)
    })

  it('copies pixels, colours and flags — a copy of the tile, not just its picture', () => {
    const doc = bank(40)
    const clip = copyTiles(doc, [5], 16)
    expect(clip).toMatchObject({ width: 1, height: 1, mode: 'sc2' })
    expect(clip?.tiles[0].entry.pattern).toEqual(new Array(8).fill(5))
    expect(clip?.tiles[0].flags).toBe(5)
  })

  it('copies a marquee as a rectangle and pastes it somewhere else', () => {
    const doc = bank(40)
    const clip = copyTiles(doc, marqueeIndices(0, 17, 16, 40), 16) // 2×2 of tiles 0, 1, 16, 17
    expect(clip).toMatchObject({ width: 2, height: 2 })

    const { doc: pasted, pasted: count } = pasteTiles(doc, clip!, 20, 16)
    expect(count).toBe(4)
    expect(pasted.tiles[20].pattern[0]).toBe(0)
    expect(pasted.tiles[21].pattern[0]).toBe(1)
    expect(pasted.tiles[36].pattern[0]).toBe(16)
    expect(pasted.tiles[37].pattern[0]).toBe(17)
    expect(pasted.flags[37]).toBe(17)
    // Everything outside the paste is untouched.
    expect(pasted.tiles[22].pattern[0]).toBe(22)
  })

  it('clips at the right edge instead of wrapping into the next row', () => {
    const doc = bank(40)
    const clip = copyTiles(doc, marqueeIndices(0, 2, 16, 40), 16) // 3 wide
    // Pasted at column 14: two cells fit, the third would wrap.
    const { doc: pasted, pasted: count } = pasteTiles(doc, clip!, 14, 16)
    expect(count).toBe(2)
    expect(pasted.tiles[14].pattern[0]).toBe(0)
    expect(pasted.tiles[15].pattern[0]).toBe(1)
    expect(pasted.tiles[16].pattern[0]).toBe(16) // the next row, left alone
  })

  it('drops cells past the end of the bank, and changes nothing when none land', () => {
    const doc = bank(18)
    const clip = copyTiles(doc, marqueeIndices(0, 17, 16, 18), 16)
    const { pasted } = pasteTiles(doc, clip!, 17, 16)
    expect(pasted).toBe(1) // only the top-left cell is inside the bank
    expect(pasteTiles(doc, clip!, 18, 16)).toMatchObject({ pasted: 0, doc })
  })

  it('refuses a ragged selection, which is no rectangle to copy', () => {
    expect(copyTiles(bank(40), [0, 1, 8, 9], 16)).toBeNull()
  })

  it('normalizes what the destination cannot carry, pasting sc2 into sc1', () => {
    const source = bank(20)
    const clip = copyTiles(source, [3], 16)!
    const target = normalizeTiles({ mode: 'sc1', count: 16 })
    const { doc, pasted } = pasteTiles(target, clip, 0, 16)
    expect(pasted).toBe(1)
    expect(doc.tiles[0].pattern).toEqual(new Array(8).fill(3)) // pixels travel
    expect(doc.tiles[0].color).toEqual([]) // sc1 colour lives on the group
    expect(validateTiles(doc)).toEqual([])
  })
})

describe('fitColumns', () => {
  it('wraps the sheet into the pane instead of running off the side of it', () => {
    expect(fitColumns(200, 24, 256)).toBe(8)
    expect(fitColumns(0, 24, 256)).toBe(GRID_COLUMNS) // not measured yet
    expect(fitColumns(20, 24, 256)).toBe(1) // narrower than one tile
    expect(fitColumns(400, 24, 3)).toBe(3) // never more columns than tiles
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

    const header = renderResourceFiles(reloaded, 'imported.tiles.json', doc.export).source ?? ''
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

describe('multi-tile blocks', () => {
  it('appends its own tiles and points at them, row-major', () => {
    const doc = createBlock(createTilesDoc('sc2', 4), 'door', 2, 3)
    expect(doc.count).toBe(4 + 6)
    expect(doc.blocks).toHaveLength(1)
    expect(doc.blocks[0]).toMatchObject({ name: 'door', width: 2, height: 3 })
    expect(doc.blocks[0].tiles).toEqual([4, 5, 6, 7, 8, 9])
    expect(validateTiles(doc)).toEqual([])
  })

  it('starts an sc1 block on a colour-group boundary so it owns its colours', () => {
    // 5 tiles used, so a block starting at 5 would share group 0 with tiles 0-4.
    const doc = createBlock(createTilesDoc('sc1', 5), 'sign', 2, 2)
    expect(doc.blocks[0].tiles).toEqual([8, 9, 10, 11])
    expect(blockColorGroupWarning(doc, doc.blocks[0])).toContain('12, 13, 14, 15')

    // A block filling whole groups shares with nobody.
    const clean = createBlock(createTilesDoc('sc1', 8), 'wall', 4, 2)
    expect(clean.blocks[0].tiles).toEqual([8, 9, 10, 11, 12, 13, 14, 15])
    expect(blockColorGroupWarning(clean, clean.blocks[0])).toBeNull()
  })

  it('names each tile a block-wide colour edit touches once, however often the block lists it', () => {
    const doc = blockFromTiles(createTilesDoc('sc2', 8), 'reused', 2, 2, [5, 5, 6, 7])
    expect(blockColorTargets(doc, doc.blocks[0])).toEqual([5, 6, 7])
  })

  it('collapses an sc1 block onto one target per group of eight', () => {
    const inside = createBlock(createTilesDoc('sc1', 8), 'sign', 2, 2) // tiles 8-11, all group 1
    expect(blockColorTargets(inside, inside.blocks[0])).toEqual([8])

    const straddling = blockFromTiles(createTilesDoc('sc1', 16), 'wide', 2, 2, [6, 7, 14, 15])
    expect(blockColorTargets(straddling, straddling.blocks[0])).toEqual([6, 14])
  })

  it('swaps an sc1 block’s pair exactly once — swapping it four times would look untouched', () => {
    const doc = setRowColors(createBlock(createTilesDoc('sc1', 8), 'sign', 2, 2), 8, 0, 7, 1)
    const swapped = blockColorTargets(doc, doc.blocks[0]).reduce((d, tile) => swapRowColors(d, tile, 0), doc)
    expect(splitColorByte(swapped.groupColors[1])).toEqual({ fg: 1, bg: 7 })
  })

  it('never warns outside sc1, where colour is per row', () => {
    const doc = createBlock(createTilesDoc('sc2', 3), 'x', 2, 2)
    expect(blockColorGroupWarning(doc, doc.blocks[0])).toBeNull()
  })

  it('refuses a block the bank has no room for', () => {
    const full = createTilesDoc('sc2', 250)
    expect(createBlock(full, 'huge', 4, 4)).toBe(full)
  })

  it('clamps the grid and names an existing rectangle of tiles', () => {
    const doc = blockFromTiles(createTilesDoc('sc2', 8), 'reused', MAX_BLOCK + 5, 2, [0, 1, 2, 3])
    expect(doc.blocks[0].width).toBe(MAX_BLOCK)
    // Short input pads with tile 0, and the tile count always matches w*h.
    expect(doc.blocks[0].tiles).toHaveLength(MAX_BLOCK * 2)
    expect(doc.count).toBe(8) // names existing tiles, adds none
    expect(validateTiles(doc)).toEqual([])
  })

  it('names a selection far bigger than one screen — the old 8x8 cap was invented', () => {
    // 12 wide by 10 tall: refused before, and nothing about the format minded.
    const doc = createTilesDoc('sc2', 200)
    const tiles = Array.from({ length: 120 }, (_, i) => i)
    const named = blockFromTiles(doc, 'landscape', 12, 10, tiles)
    expect(named.blocks[0]).toMatchObject({ width: 12, height: 10 })
    expect(named.blocks[0].tiles).toHaveLength(120)
    expect(validateTiles(named)).toEqual([])
  })

  it('drops a block without touching the tiles it pointed at', () => {
    const doc = createBlock(createTilesDoc('sc2', 2), 'x', 2, 2)
    const removed = removeBlock(doc, 0)
    expect(removed.blocks).toEqual([])
    expect(removed.count).toBe(doc.count)
  })

  it('maps block-space pixels to the tile that owns them', () => {
    const doc = createBlock(createTilesDoc('sc2', 0 + 1), 'x', 2, 2)
    const block = doc.blocks[0]
    expect(blockTileAt(block, 0, 0)).toEqual({ tile: block.tiles[0], tx: 0, ty: 0 })
    expect(blockTileAt(block, 9, 3)).toEqual({ tile: block.tiles[1], tx: 1, ty: 3 })
    expect(blockTileAt(block, 4, 12)).toEqual({ tile: block.tiles[2], tx: 4, ty: 4 })
    expect(blockTileAt(block, 16, 0)).toBeNull() // past the right edge
  })

  it('splits one stroke into per-tile strokes in tile-local coordinates', () => {
    const doc = createBlock(createTilesDoc('sc2', 1), 'x', 2, 1)
    const block = doc.blocks[0]
    // A horizontal run crossing the seam at x = 8.
    const points: Point[] = [6, 7, 8, 9].map((x) => ({ x, y: 2 }))
    const split = splitBlockPoints(block, points)
    expect([...split.keys()]).toEqual(block.tiles)
    expect(split.get(block.tiles[0])).toEqual([{ x: 6, y: 2 }, { x: 7, y: 2 }])
    expect(split.get(block.tiles[1])).toEqual([{ x: 0, y: 2 }, { x: 1, y: 2 }])
  })

  it('composes the block into one image, tile by tile', () => {
    let doc = createBlock(createTilesDoc('sc2', 1), 'x', 2, 1)
    const block = doc.blocks[0]
    // Paint the whole of the right-hand tile's row 0.
    doc = applyStroke(doc, block.tiles[1], Array.from({ length: 8 }, (_, x) => ({ x, y: 0 })), 6).doc
    const pixels = blockPixels(doc, block)
    expect(pixels).toHaveLength(16 * 8)
    expect([...pixels.subarray(8, 16)]).toEqual(new Array(8).fill(6))
    expect([...pixels.subarray(0, 8)]).not.toContain(6)
  })

  it('survives a save/load round-trip', () => {
    const doc = createBlock(createTilesDoc('sc2', 2), 'door', 2, 2)
    const reloaded = parseResource('x.tiles.json', serializeResource({ kind: 'tiles', doc }))
    expect(reloaded.doc).toEqual(doc)
  })

  it('drops a block reference to a tile that no longer exists', () => {
    const doc = createBlock(createTilesDoc('sc2', 2), 'x', 2, 1)
    const shrunk = normalizeTiles({ ...doc, count: 2 })
    expect(shrunk.blocks[0].tiles).toEqual([0, 0])
    expect(validateTiles(shrunk)).toEqual([])
  })
})

describe('delete and mode conversion', () => {
  it('carries a tile’s flags with it through a reorder', () => {
    let doc = createTilesDoc('sc2', 4)
    doc = setTileFlagBit(doc, 2, 0, true) // tile 2 is solid
    const { doc: moved, mapping } = reorderTiles(doc, 2, 0)
    expect(mapping[2]).toBe(0)
    // The flag belongs to the tile, not to the slot it used to sit in.
    expect(moved.flags[0]).toBe(1)
    expect(moved.flags[3]).toBe(0)
  })

  it('renumbers blocks through a reorder so they keep pointing at their own tiles', () => {
    const doc = createBlock(createTilesDoc('sc2', 2), 'x', 2, 1) // tiles 2, 3
    const { doc: moved } = reorderTiles(doc, 3, 0)
    expect(moved.blocks[0].tiles).toEqual([3, 0])
  })

  it('deletes a tile, shifting everything above it down', () => {
    let doc = createTilesDoc('sc2', 4)
    doc = setTileFlagBit(doc, 3, 1, true)
    const { doc: next, mapping } = removeTile(doc, 1)
    expect(next.count).toBe(3)
    expect(mapping).toEqual([0, 0, 1, 2]) // the deleted one falls back to tile 0
    expect(next.flags[2]).toBe(2) // tile 3's flags followed it down to index 2
    expect(validateTiles(next)).toEqual([])
  })

  it('points a block cell at tile 0 when the tile under it is deleted', () => {
    const doc = createBlock(createTilesDoc('sc2', 2), 'x', 2, 1) // tiles 2, 3
    const { doc: next } = removeTile(doc, 2)
    expect(next.blocks[0].tiles).toEqual([0, 2])
    expect(validateTiles(next)).toEqual([])
  })

  it('refuses to empty the bank', () => {
    const solo = createTilesDoc('sc2', 1)
    expect(removeTile(solo, 0).doc).toBe(solo)
  })

  it('spreads sc1 group colours over rows going to sc2, keeping patterns', () => {
    let doc = createTilesDoc('sc1', 16)
    doc = { ...doc, groupColors: [mergeColorByte(7, 1), mergeColorByte(2, 3)] }
    // Painting in sc1 rewrites the whole group's pair, so read it back rather
    // than assuming it survived.
    doc = applyStroke(doc, 9, [{ x: 0, y: 0 }], 15).doc // a pattern bit in group 1
    const converted = convertTileMode(doc, 'sc2')
    expect(converted.mode).toBe('sc2')
    expect(converted.tiles[0].color).toEqual(new Array(8).fill(mergeColorByte(7, 1)))
    expect(converted.tiles[9].color).toEqual(new Array(8).fill(doc.groupColors[1]))
    expect(converted.tiles[9].pattern).toEqual(doc.tiles[9].pattern)
    expect(converted.groupColors).toEqual([])
    expect(validateTiles(converted)).toEqual([])
  })

  it('collapses to one pair per group going to sc1, and says so first', () => {
    let doc = createTilesDoc('sc2', 16)
    doc = setRowColors(doc, 0, 0, 7, 1)
    expect(tileModeConversionLossy(doc, 'sc1')).toBe(true)
    const converted = convertTileMode(doc, 'sc1')
    expect(converted.groupColors).toHaveLength(2)
    expect(converted.groupColors[0]).toBe(mergeColorByte(7, 1)) // tile 0's row 0 owns the group
    expect(converted.tiles[0].color).toEqual([])
    expect(validateTiles(converted)).toEqual([])
  })

  it('calls sc2 → sc1 lossless when every tile already agrees', () => {
    const doc = createTilesDoc('sc2', 16) // uniform white-on-black
    expect(tileModeConversionLossy(doc, 'sc1')).toBe(false)
    expect(tileModeConversionLossy(doc, 'sc4')).toBe(false)
  })

  it('sc2 ↔ sc4 differ only by the palette', () => {
    const doc = createTilesDoc('sc2', 8)
    const sc4 = convertTileMode(doc, 'sc4')
    expect(sc4.palette).toHaveLength(16)
    expect(sc4.tiles).toEqual(doc.tiles)
    expect(convertTileMode(sc4, 'sc2').palette).toBeNull()
  })
})

describe('fillPoints beyond one tile', () => {
  it('floods a buffer wider than a tile, crossing the seams', () => {
    // The meta canvas floods a picture, not a cell: a shape drawn across two
    // tiles is one shape to the user.
    const pixels = new Uint8Array(16 * 8)
    expect(fillPoints(pixels, { x: 0, y: 0 }, 16, 8)).toHaveLength(128)
  })

  it('still defaults to one 8x8 tile, so the tile editor is unchanged', () => {
    expect(fillPoints(new Uint8Array(64), { x: 0, y: 0 })).toHaveLength(64)
  })

  it('stops at a colour boundary', () => {
    const pixels = new Uint8Array(16 * 8)
    for (let y = 0; y < 8; y++) pixels[y * 16 + 8] = 1
    expect(fillPoints(pixels, { x: 0, y: 0 }, 16, 8)).toHaveLength(64)
  })
})
