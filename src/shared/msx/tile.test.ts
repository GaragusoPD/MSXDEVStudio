import { describe, expect, it } from 'vitest'
import {
  blankTileEntry,
  colorByteAt,
  createTilesDoc,
  mergeColorByte,
  normalizeTiles,
  packTiles,
  paintPixel,
  regroupAfterTile0Shift,
  reorderTiles,
  rowColorViolations,
  splitColorByte,
  swapRowColors,
  tileColorBytes,
  tileFromPixels,
  tilePatternBytes,
  tilePixels,
  validateTiles,
  type TilesDoc
} from './tile'

/** A one-tile sc2 document whose row 0 is `pattern` with the given FG/BG. */
function sc2(pattern: number, fg: number, bg: number): TilesDoc {
  return normalizeTiles({
    mode: 'sc2',
    count: 1,
    tiles: [{ pattern: [pattern, 0, 0, 0, 0, 0, 0, 0], color: [mergeColorByte(fg, bg), 0, 0, 0, 0, 0, 0, 0] }]
  })
}

function expectOk(result: ReturnType<typeof paintPixel>): TilesDoc {
  if (!result.ok) throw new Error(`expected success, got conflict ${JSON.stringify(result.conflict)}`)
  return result.doc
}

describe('paintPixel — sc2 (two colors per 8×1 row)', () => {
  it('branch 1a: painting the row FG just sets the bit', () => {
    const doc = sc2(0b10000000, 15, 1)
    const next = expectOk(paintPixel(doc, 0, 1, 0, 15))
    expect(next.tiles[0].pattern[0]).toBe(0b11000000)
    expect(next.tiles[0].color[0]).toBe(mergeColorByte(15, 1))
  })

  it('branch 1b: painting the row BG just clears the bit', () => {
    const doc = sc2(0b11000000, 15, 1)
    const next = expectOk(paintPixel(doc, 0, 0, 0, 1))
    expect(next.tiles[0].pattern[0]).toBe(0b01000000)
    expect(next.tiles[0].color[0]).toBe(mergeColorByte(15, 1))
  })

  it('branch 2: recolors the pixel’s own role when that color is used nowhere else in the row', () => {
    // Only one FG pixel: repainting it with a third color repurposes FG, no popover.
    const doc = sc2(0b10000000, 15, 1)
    const next = expectOk(paintPixel(doc, 0, 0, 0, 7))
    expect(splitColorByte(next.tiles[0].color[0])).toEqual({ fg: 7, bg: 1 })
    expect(next.tiles[0].pattern[0]).toBe(0b10000000)
  })

  it('branch 3: recolors the other role and flips the bit when only that one is free', () => {
    // All 8 pixels are FG, so BG is unused: painting a third color takes BG over.
    const doc = sc2(0xff, 15, 1)
    const next = expectOk(paintPixel(doc, 0, 3, 0, 7))
    expect(splitColorByte(next.tiles[0].color[0])).toEqual({ fg: 15, bg: 7 })
    expect(next.tiles[0].pattern[0]).toBe(0b11101111)
  })

  it('branch 4: reports a row conflict when both colors are still in use', () => {
    const doc = sc2(0b11110000, 15, 1)
    const result = paintPixel(doc, 0, 0, 0, 7)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.conflict).toEqual({ scope: 'row', index: 0, fg: 15, bg: 1, wanted: 7 })
  })

  it('conflicts only bind the painted row, not its neighbours', () => {
    const doc = normalizeTiles({
      mode: 'sc2',
      count: 1,
      tiles: [{ pattern: [0b11110000, 0b11110000, 0, 0, 0, 0, 0, 0], color: [0xf1, 0xf1, 0, 0, 0, 0, 0, 0] }]
    })
    expect(paintPixel(doc, 0, 0, 0, 7).ok).toBe(false)
    const next = expectOk(paintPixel(doc, 0, 0, 0, 7, 'fg'))
    expect(splitColorByte(next.tiles[0].color[0])).toEqual({ fg: 7, bg: 1 })
    expect(splitColorByte(next.tiles[0].color[1])).toEqual({ fg: 15, bg: 1 })
  })

  describe('resolutions produce valid hardware bytes', () => {
    const doc = sc2(0b11110000, 15, 1)

    it('“replace row FG” recolors FG and sets the bit', () => {
      const next = expectOk(paintPixel(doc, 0, 0, 0, 7, 'fg'))
      expect(splitColorByte(next.tiles[0].color[0])).toEqual({ fg: 7, bg: 1 })
      expect(next.tiles[0].pattern[0]).toBe(0b11110000)
      expect(validateTiles(next)).toEqual([])
    })

    it('“replace row BG” recolors BG and clears the bit', () => {
      const next = expectOk(paintPixel(doc, 0, 0, 0, 7, 'bg'))
      expect(splitColorByte(next.tiles[0].color[0])).toEqual({ fg: 15, bg: 7 })
      expect(next.tiles[0].pattern[0]).toBe(0b01110000)
      expect(validateTiles(next)).toEqual([])
    })
  })

  it('never mutates the input document (undo stack safety)', () => {
    const doc = sc2(0b11110000, 15, 1)
    const before = JSON.stringify(doc)
    paintPixel(doc, 0, 0, 0, 7, 'fg')
    paintPixel(doc, 0, 5, 0, 15)
    expect(JSON.stringify(doc)).toBe(before)
  })

  it('rejects out-of-range coordinates', () => {
    expect(() => paintPixel(sc2(0, 15, 1), 0, 8, 0, 1)).toThrow(RangeError)
    expect(() => paintPixel(sc2(0, 15, 1), 5, 0, 0, 1)).toThrow(RangeError)
  })
})

describe('paintPixel — sc1 (two colors per group of 8 tiles)', () => {
  /** 8 tiles sharing one group color, with `patterns` as each tile's row 0. */
  function sc1(patterns: number[], fg = 15, bg = 1): TilesDoc {
    return normalizeTiles({
      mode: 'sc1',
      count: 8,
      tiles: patterns.map((value) => ({ pattern: [value, 0, 0, 0, 0, 0, 0, 0] })),
      groupColors: [mergeColorByte(fg, bg)]
    })
  }

  it('stores one color byte per group, not per row', () => {
    const doc = sc1([0, 0, 0, 0, 0, 0, 0, 0])
    expect(doc.groupColors).toHaveLength(1)
    expect(doc.tiles[0].color).toEqual([])
    expect(colorByteAt(doc, 3, 5)).toBe(mergeColorByte(15, 1))
  })

  it('painting the group FG/BG just moves the bit', () => {
    const doc = sc1([0b10000000, 0, 0, 0, 0, 0, 0, 0])
    expect(expectOk(paintPixel(doc, 4, 0, 0, 15)).tiles[4].pattern[0]).toBe(0b10000000)
    expect(expectOk(paintPixel(doc, 0, 0, 0, 1)).tiles[0].pattern[0]).toBe(0)
  })

  it('scans the whole group, so a color used by a *sibling* tile blocks the silent recolor', () => {
    // Tile 0 has the only FG pixel *in tile 0*, but tile 5 also uses FG — conflict.
    const doc = sc1([0b10000000, 0, 0, 0, 0, 0b00001111, 0, 0])
    const result = paintPixel(doc, 0, 0, 0, 7)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.conflict).toEqual({ scope: 'group', index: 0, fg: 15, bg: 1, wanted: 7 })
  })

  it('recolors silently when the group really has that color spare', () => {
    // FG appears nowhere but this one pixel in the whole group.
    const doc = sc1([0b10000000, 0, 0, 0, 0, 0, 0, 0])
    const next = expectOk(paintPixel(doc, 0, 0, 0, 7))
    expect(splitColorByte(next.groupColors[0])).toEqual({ fg: 7, bg: 1 })
  })

  it('resolving writes the shared group byte, affecting all 8 tiles', () => {
    const doc = sc1([0b10000000, 0, 0, 0, 0, 0b00001111, 0, 0])
    const next = expectOk(paintPixel(doc, 0, 0, 0, 7, 'fg'))
    expect(splitColorByte(next.groupColors[0])).toEqual({ fg: 7, bg: 1 })
    expect(colorByteAt(next, 5, 0)).toBe(mergeColorByte(7, 1))
    expect(validateTiles(next)).toEqual([])
  })

  it('groups are independent: tile 8 belongs to group 1', () => {
    const doc = normalizeTiles({
      mode: 'sc1',
      count: 16,
      tiles: Array.from({ length: 16 }, () => ({ pattern: [0b11110000, 0, 0, 0, 0, 0, 0, 0] })),
      groupColors: [mergeColorByte(15, 1), mergeColorByte(15, 1)]
    })
    const result = paintPixel(doc, 8, 0, 0, 7)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.conflict.index).toBe(1)
    const next = expectOk(paintPixel(doc, 8, 0, 0, 7, 'bg'))
    expect(splitColorByte(next.groupColors[1])).toEqual({ fg: 15, bg: 7 })
    expect(next.groupColors[0]).toBe(mergeColorByte(15, 1)) // group 0 untouched
  })
})

describe('pixels ↔ bytes', () => {
  it('decodes a tile through its row colors', () => {
    const doc = sc2(0b10100000, 6, 4)
    const pixels = tilePixels(doc, 0)
    expect([...pixels.subarray(0, 8)]).toEqual([6, 4, 6, 4, 4, 4, 4, 4])
    expect(pixels[8]).toBe(0) // row 1 carries its own pair (0/0 here), not row 0's
  })

  it('packs pixels back, reducing over-full rows to the two most used colors', () => {
    const pixels = new Uint8Array(64)
    pixels.set([1, 1, 1, 1, 2, 2, 3, 4], 0) // 4 colors in row 0
    const tile = tileFromPixels(pixels)
    expect(tile.lossyRows).toEqual([0])
    expect(splitColorByte(tile.color[0])).toEqual({ fg: 1, bg: 2 })
  })

  it('is deterministic when frequencies tie', () => {
    const pixels = new Uint8Array(64).fill(0)
    pixels.set([5, 5, 5, 5, 9, 9, 9, 9], 0)
    expect(tileFromPixels(pixels).color[0]).toBe(tileFromPixels(pixels).color[0])
    expect(splitColorByte(tileFromPixels(pixels).color[0])).toEqual({ fg: 5, bg: 9 })
  })

  it('cuts an indexed image into tiles and reports the name-table layout', () => {
    const width = 16
    const height = 16
    const indices = new Uint8Array(width * height)
    for (let i = 0; i < indices.length; i++) indices[i] = i % width < 8 ? 1 : 15
    const { doc, layout } = packTiles(indices, width, height, 'sc2')
    expect(doc.count).toBe(4)
    expect(layout).toEqual([0, 1, 2, 3])
    expect(validateTiles(doc)).toEqual([])
  })

  it('dedups identical tiles on request', () => {
    const indices = new Uint8Array(16 * 16).fill(3)
    const { doc, layout } = packTiles(indices, 16, 16, 'sc2', { dedup: true })
    expect(doc.count).toBe(1)
    expect(layout).toEqual([0, 0, 0, 0])
  })
})

describe('regroupAfterTile0Shift — fixing up group colors after a tile-0 shift', () => {
  // Simulates exactly what `reserveTile0()`'s prepend-a-blank-tile shift leaves
  // behind: 16 old tiles (two groups, A and B) become 17 after the shift, but
  // `groupColors` is still the pre-shift, two-entry array — nobody has told it
  // group boundaries moved.
  const shiftedTwoGroupDoc = (groupColors: number[]): TilesDoc => ({
    ...createTilesDoc('sc1', 8),
    count: 17,
    tiles: Array.from({ length: 17 }, () => blankTileEntry('sc1')),
    groupColors
  })

  it('flags the boundary tile lossy when the two old groups differ, and pads the new trailing group from the last', () => {
    const A = mergeColorByte(1, 2)
    const B = mergeColorByte(3, 4)
    const { doc, lossyTiles } = regroupAfterTile0Shift(shiftedTwoGroupDoc([A, B]))
    // Old index 7 (the last tile of group A) is now at new index 8 — the first
    // slot of the shifted group 1 — and renders with B, not the A it was
    // authored with. It is the *only* tile that changed: the other seven tiles
    // now sharing group 1 came from old group B's first seven and still match.
    expect(lossyTiles).toEqual([8])
    // A third group appears (17 tiles need ceil(17/8) = 3), holding only the
    // old bank's very last tile. It has no sibling to disagree with, so it
    // repeats the previous group's pair rather than losing anything.
    expect(doc.groupColors).toEqual([A, B, B])
  })

  it('flags nothing when the old groups already share a pair', () => {
    const A = mergeColorByte(1, 2)
    const { lossyTiles } = regroupAfterTile0Shift(shiftedTwoGroupDoc([A, A]))
    expect(lossyTiles).toEqual([])
  })

  it('is a no-op outside sc1, so both call sites can run it unconditionally', () => {
    const doc = createTilesDoc('sc2', 4)
    const result = regroupAfterTile0Shift(doc)
    expect(result.doc).toBe(doc)
    expect(result.lossyTiles).toEqual([])
  })
})

describe('validators', () => {
  it('accepts a freshly created document in every tile mode', () => {
    for (const mode of ['sc1', 'sc2', 'sc4'] as const) {
      expect(validateTiles(createTilesDoc(mode, 32))).toEqual([])
    }
  })

  it('flags structural damage', () => {
    const doc = createTilesDoc('sc2', 2)
    doc.tiles[0].pattern = [1, 2, 3]
    doc.count = 5
    expect(validateTiles(doc).length).toBeGreaterThanOrEqual(2)
  })

  it('rejects a palette outside the GRB333 space and on MSX1 modes', () => {
    const sc4 = createTilesDoc('sc4', 1)
    sc4.palette = new Array<number>(16).fill(0x888)
    expect(validateTiles(sc4)).toContain('Palette entry outside the GRB333 space')

    const sc2Doc = createTilesDoc('sc2', 1)
    sc2Doc.palette = new Array<number>(16).fill(0)
    expect(validateTiles(sc2Doc)[0]).toMatch(/fixed TMS9918A palette/)
  })

  it('finds 8×1 spans that break the two-color rule', () => {
    const indices = new Uint8Array(16)
    indices.set([1, 2, 3, 1, 1, 1, 1, 1], 0)
    indices.set([4, 4, 4, 4, 5, 5, 5, 5], 8)
    const violations = rowColorViolations(indices, 8, 2)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ x: 0, y: 0 })
  })
})

describe('editing helpers', () => {
  it('swaps FG/BG and inverts the pattern so the tile looks identical', () => {
    const doc = sc2(0b10100000, 6, 4)
    const next = swapRowColors(doc, 0, 0)
    expect(splitColorByte(next.tiles[0].color[0])).toEqual({ fg: 4, bg: 6 })
    expect([...tilePixels(next, 0).subarray(0, 8)]).toEqual([...tilePixels(doc, 0).subarray(0, 8)])
  })

  it('reorders tiles and returns the remap for maps that reference them', () => {
    const doc = normalizeTiles({
      mode: 'sc2',
      count: 4,
      tiles: [0, 1, 2, 3].map((i) => ({ pattern: [i, 0, 0, 0, 0, 0, 0, 0] }))
    })
    const { doc: moved, mapping } = reorderTiles(doc, 0, 2)
    expect(moved.tiles.map((tile) => tile.pattern[0])).toEqual([1, 2, 0, 3])
    expect(mapping).toEqual([2, 0, 1, 3])
  })
})

describe('export bytes', () => {
  it('lays sc2 out as count×8 patterns then count×8 colors', () => {
    const doc = createTilesDoc('sc2', 4)
    expect(tilePatternBytes(doc)).toHaveLength(32)
    expect(tileColorBytes(doc)).toHaveLength(32)
  })

  it('lays sc1 out as count×8 patterns then one color per group of 8', () => {
    const doc = createTilesDoc('sc1', 16)
    expect(tilePatternBytes(doc)).toHaveLength(128)
    expect(tileColorBytes(doc)).toHaveLength(2)
  })
})

describe('reserveTile0', () => {
  it('defaults to false so existing tilesets are untouched', () => {
    const doc = normalizeTiles({ mode: 'sc2', count: 4 })
    expect(doc.reserveTile0).toBe(false)
    // The 0xf1 white-on-black default still applies to tile 0.
    expect(doc.tiles[0].color[0]).toBe(0xf1)
  })

  it('forces tile 0 blank when set, discarding whatever art was there', () => {
    const doc = normalizeTiles({
      mode: 'sc2',
      count: 4,
      reserveTile0: true,
      tiles: [{ pattern: [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], color: new Array(8).fill(0x54) }]
    })
    expect(doc.tiles[0].pattern).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    expect(doc.tiles[0].color).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })

  it('leaves every other tile alone', () => {
    const doc = normalizeTiles({
      mode: 'sc2',
      count: 2,
      reserveTile0: true,
      tiles: [
        { pattern: new Array(8).fill(1), color: [] },
        { pattern: new Array(8).fill(2), color: [] }
      ]
    })
    expect(doc.tiles[1].pattern[0]).toBe(2)
  })

  it('blanks tile 0 in sc1 without touching the group pair, which serves 7 other tiles', () => {
    const doc = normalizeTiles({ mode: 'sc1', count: 8, reserveTile0: true, groupColors: [0x54] })
    expect(doc.tiles[0].pattern).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    expect(doc.groupColors[0]).toBe(0x54)
  })

  it('blankTileEntry is what tile 0 holds', () => {
    const doc = normalizeTiles({ mode: 'sc2', count: 1, reserveTile0: true })
    expect(doc.tiles[0]).toEqual(blankTileEntry('sc2'))
  })

  it('createTilesDoc leaves it off by default, so it agrees with normalizeTiles', () => {
    expect(createTilesDoc('sc2', 16).reserveTile0).toBe(false)
  })

  it('createTilesDoc reserves it on request — what the new-tileset command passes', () => {
    expect(createTilesDoc('sc2', 16, true).reserveTile0).toBe(true)
  })
})

describe('a tileset created from the Resources panel', () => {
  it('is born empty, not full', () => {
    // `{"mode":"sc2"}` is exactly what ResourcesPanel.createResource() writes.
    // Defaulting `count` to MAX_TILES made the bank born at the hardware
    // ceiling, so findOrCreateTile had nowhere to append and the meta editor
    // refused every stroke with "the tileset is full" — against 256 blank tiles.
    const doc = normalizeTiles({ mode: 'sc2' })
    expect(doc.count).toBe(1)
    expect(doc.tiles).toHaveLength(1)
  })

  it('still takes the count a real file states, or the tiles it carries', () => {
    expect(normalizeTiles({ mode: 'sc2', count: 64 }).count).toBe(64)
    expect(normalizeTiles({ mode: 'sc2', tiles: [{}, {}, {}] }).count).toBe(3)
  })
})
