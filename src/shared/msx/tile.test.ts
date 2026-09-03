import { describe, expect, it } from 'vitest'
import {
  BANK_COUNT,
  bankCapacityLeft,
  bankColorBytes,
  bankedSheetPixels,
  bankPatternBytes,
  bankTileAt,
  bankTilePixels,
  blankTileEntry,
  colorByteAt,
  createTilesDoc,
  isBanked,
  MAX_TILES,
  mergeColorByte,
  normalizeTiles,
  packBankedTiles,
  packTiles,
  paintPixel,
  regroupAfterTile0Shift,
  removeTile,
  reorderTiles,
  rowColorViolations,
  sharedColorBytes,
  sharedPatternBytes,
  splitColorByte,
  swapRowColors,
  tileColorBytes,
  TILE_SIZE,
  tileFromPixels,
  tilePatternBytes,
  tilePixels,
  validateTiles,
  type TileEntry,
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

describe('pattern banks', () => {
  const solid = (byte: number) => ({ pattern: new Array(8).fill(byte), color: new Array(8).fill(0xf1) })

  it('a file that predates banking normalizes to no overrides', () => {
    // The feature's central promise: today's files mean exactly what they meant.
    const doc = normalizeTiles({ mode: 'sc2', count: 4, tiles: [solid(0x11), solid(0x22), solid(0x33), solid(0x44)] })
    expect(doc.bankTiles).toEqual([[], [], []])
    expect(doc.sharedTiles).toBe(0)
    expect(isBanked(doc)).toBe(false)
    // Every bank shows the common set, which is what VDP_LoadPattern_GM2 does.
    for (let bank = 0; bank < BANK_COUNT; bank++) {
      expect(bankTileAt(doc, bank, 2).pattern).toEqual(new Array(8).fill(0x33))
    }
  })

  it('a bank override wins over the common set, and only for that bank', () => {
    const doc = normalizeTiles({
      mode: 'sc2',
      count: 4,
      tiles: [solid(0x11), solid(0x22), solid(0x33), solid(0x44)],
      bankTiles: [[], [solid(0xaa)], []]
    })
    expect(isBanked(doc)).toBe(true)
    expect(bankTileAt(doc, 1, 0).pattern).toEqual(new Array(8).fill(0xaa))
    expect(bankTileAt(doc, 0, 0).pattern).toEqual(new Array(8).fill(0x11))
    expect(bankTileAt(doc, 2, 0).pattern).toEqual(new Array(8).fill(0x11))
    // Past its own overrides, a bank falls back to the common set again.
    expect(bankTileAt(doc, 1, 1).pattern).toEqual(new Array(8).fill(0x22))
  })

  it('an index nothing defines is the blank tile, not undefined', () => {
    const doc = normalizeTiles({ mode: 'sc2', count: 1 })
    expect(bankTileAt(doc, 0, 200).pattern).toEqual(new Array(8).fill(0))
  })

  it('bankTilePixels decodes exactly what bankTileAt resolves for that hardware index', () => {
    const doc = normalizeTiles({
      mode: 'sc2',
      count: 4,
      tiles: [solid(0x11), solid(0x22), solid(0x33), solid(0x44)],
      bankTiles: [[], [solid(0xaa)], []]
    })
    // Bank 1's own override at index 0 — same bytes `tilePixels` would decode
    // if that override sat in `tiles[0]` directly.
    expect(bankTilePixels(doc, 1, 0)).toEqual(tilePixels({ ...doc, tiles: [solid(0xaa)] }, 0))
    // Bank 0 has no override at index 0, so it falls back to the common tile —
    // the same pixels the ordinary (unbanked) grid shows there.
    expect(bankTilePixels(doc, 0, 0)).toEqual(tilePixels(doc, 0))
  })

  it('capacity is per bank, and the shared reservation costs every bank', () => {
    const doc = normalizeTiles({
      mode: 'sc2',
      count: 256,
      bankTiles: [new Array(180).fill(solid(1)), new Array(204).fill(solid(2)), []],
      sharedTiles: 48
    })
    expect(bankCapacityLeft(doc, 0)).toBe(256 - 180 - 48)
    expect(bankCapacityLeft(doc, 1)).toBe(256 - 204 - 48)
    expect(bankCapacityLeft(doc, 2)).toBe(256 - 0 - 48)
  })

  it('sc1 is never banked — it has one pattern table, not three', () => {
    const doc = normalizeTiles({ mode: 'sc1', count: 8, bankTiles: [[solid(9)], [], []] })
    expect(doc.bankTiles).toEqual([[], [], []])
    expect(isBanked(doc)).toBe(false)
  })

  it('sc1 also clamps a stale sharedTiles carried over from a banked sc2/sc4 file', () => {
    const doc = normalizeTiles({ mode: 'sc1', count: 8, sharedTiles: 3 })
    expect(doc.sharedTiles).toBe(0)
  })

  it('survives a save/reload round trip — the single most load-bearing test this feature has', () => {
    // The shared region lives at MAX_TILES - sharedTiles .. 255, far above
    // `count`. Before this fix, `normalizeTiles`'s rebuild loop only ever
    // reached `count`, so this exact round trip — the ordinary path every
    // file takes through `tilesetStore.load()` and every export's
    // mirror-refresh in `resources.ts` — silently dropped the entire shared
    // region on the very first reload, no editing required.
    const doc = normalizeTiles({ mode: 'sc2', count: 4, bankTiles: [[solid(1)], [], []], sharedTiles: 0 })
    const painted = { ...doc, tiles: doc.tiles.slice(), sharedTiles: 1 }
    painted.tiles[255] = solid(0xaa)

    const reloaded = normalizeTiles(JSON.parse(JSON.stringify(painted)))
    expect(reloaded.sharedTiles).toBe(1)
    expect(reloaded.tiles[255]).toBeDefined()
    expect(reloaded.tiles[255].pattern).toEqual(new Array(8).fill(0xaa))
    // The common region the reload also has to get right, unchanged.
    expect(reloaded.count).toBe(4)
    expect(reloaded.tiles[0].pattern).toEqual(new Array(8).fill(0))
  })

  it('does not crash exporting a bank whose tiles array reaches past count into the shared region', () => {
    // `tilePatternBytes`/`tileColorBytes` used to walk the sparse array with
    // `.forEach`, which visits every populated index — including the shared
    // ones far past `count` — and `.set()` at that offset threw, because the
    // output buffer is sized for `count` tiles only.
    const rawTiles: unknown[] = [solid(1), solid(2), solid(3), solid(4)]
    rawTiles[255] = solid(0xaa)
    const doc = normalizeTiles({ mode: 'sc2', count: 4, tiles: rawTiles, sharedTiles: 1 })
    expect(() => tilePatternBytes(doc)).not.toThrow()
    expect(() => tileColorBytes(doc)).not.toThrow()
    expect(tilePatternBytes(doc)).toHaveLength(4 * 8)
  })

  it('validateTiles does not flag a banked tiles array for reaching past count', () => {
    const rawTiles: unknown[] = [solid(1), solid(2), solid(3), solid(4)]
    rawTiles[255] = solid(0xaa)
    const doc = normalizeTiles({ mode: 'sc2', count: 4, tiles: rawTiles, sharedTiles: 1 })
    expect(validateTiles(doc)).toEqual([])
  })

  it('bankPatternBytes/bankColorBytes are just that bank\'s own overrides, from index 0', () => {
    const doc = normalizeTiles({
      mode: 'sc2',
      count: 4,
      tiles: [solid(0x11), solid(0x22), solid(0x33), solid(0x44)],
      bankTiles: [[solid(0xaa), solid(0xbb)], [], []]
    })
    expect(bankPatternBytes(doc, 0)).toEqual(Uint8Array.from([...new Array(8).fill(0xaa), ...new Array(8).fill(0xbb)]))
    expect(bankColorBytes(doc, 0)).toEqual(Uint8Array.from(new Array(16).fill(0xf1)))
    // A bank with no overrides has no bytes of its own — the common set covers it.
    expect(bankPatternBytes(doc, 1)).toHaveLength(0)
  })

  it('sharedPatternBytes/sharedColorBytes read the top of the array, not the bottom', () => {
    const rawTiles: unknown[] = [solid(1), solid(2)]
    rawTiles[254] = solid(0xaa)
    rawTiles[255] = solid(0xbb)
    // A bank override, so this is genuinely banked — `normalizeTiles` clamps
    // `sharedTiles` to 0 without one (see the "incoherent state" tests below).
    const doc = normalizeTiles({ mode: 'sc2', count: 2, tiles: rawTiles, bankTiles: [[solid(9)], [], []], sharedTiles: 2 })
    expect(sharedPatternBytes(doc)).toEqual(Uint8Array.from([...new Array(8).fill(0xaa), ...new Array(8).fill(0xbb)]))
    expect(sharedColorBytes(doc)).toEqual(Uint8Array.from(new Array(16).fill(0xf1)))
  })

  it('a stray sharedTiles with no bank to justify it clamps to 0 — an unbanked doc has no shared/common split', () => {
    // On an unbanked document every bank already falls back to `tiles`, so
    // there is nothing for `sharedTiles` to mean. Without this clamp, the
    // three export-side consumers of `sharedTiles`/`isBanked` (see
    // `resource.ts`) would disagree about whether this state is banked at
    // all.
    const rawTiles: unknown[] = [solid(1), solid(2)]
    rawTiles[255] = solid(0xaa)
    const doc = normalizeTiles({ mode: 'sc2', count: 2, tiles: rawTiles, sharedTiles: 1 })
    expect(doc.sharedTiles).toBe(0)
    expect(isBanked(doc)).toBe(false)
    // The shared region was never decoded, so it isn't just unreachable via
    // `sharedTiles` — it never entered `doc.tiles` in the first place, the
    // same as any other index past `count` on an unbanked tileset.
    expect(doc.tiles).toHaveLength(2)
  })

  describe('a banked common range never renumbers', () => {
    // Banks at different lengths and a non-zero sharedTiles, deliberately not
    // a uniform `count: 256` — Task 9's brief notes four earlier defects on
    // this branch survived review because fixtures were too dense to show the
    // bug they were meant to catch.
    const banked = () =>
      normalizeTiles({
        mode: 'sc2',
        count: 6,
        tiles: [0, 1, 2, 3, 4, 5].map((i) => solid(0x10 + i)),
        bankTiles: [[solid(0xaa), solid(0xbb), solid(0xcc)], [solid(0xdd)], []],
        sharedTiles: 2
      })

    it('reorderTiles refuses on a banked doc, returning the identity mapping and the same doc', () => {
      const doc = banked()
      const result = reorderTiles(doc, 0, 2)
      expect(result.doc).toBe(doc)
      expect(result.mapping[0]).toBe(0)
      expect(result.mapping[2]).toBe(2)
      expect(result.mapping[5]).toBe(5)
    })

    it('removeTile refuses a common index on a banked doc, returning the identity mapping and the same doc', () => {
      const doc = banked()
      const result = removeTile(doc, 2)
      expect(result.doc).toBe(doc)
      expect(result.mapping[2]).toBe(2)
      expect(doc.count).toBe(6)
      expect(doc.bankTiles.map((b) => b.length)).toEqual([3, 1, 0])
    })

    it('removeTile still reclaims the newest shared index on a banked doc, decrementing sharedTiles without renumbering', () => {
      const doc = banked()
      const sharedStart = MAX_TILES - doc.sharedTiles
      const result = removeTile(doc, sharedStart)
      expect(result.doc).not.toBe(doc)
      expect(result.doc.sharedTiles).toBe(1)
      // The common range and the bank overrides are untouched by a shared-only reclaim.
      expect(result.doc.count).toBe(6)
      expect(result.doc.bankTiles.map((b) => b.length)).toEqual([3, 1, 0])
      expect(result.doc.tiles[0].pattern[0]).toBe(0x10)
    })

    it('unbanked docs are unaffected: reorderTiles and removeTile still renumber the common range', () => {
      const doc = normalizeTiles({
        mode: 'sc2',
        count: 4,
        tiles: [0, 1, 2, 3].map((i) => solid(0x10 + i))
      })
      expect(isBanked(doc)).toBe(false)

      const reordered = reorderTiles(doc, 0, 2)
      expect(reordered.doc).not.toBe(doc)
      expect(reordered.mapping).toEqual([2, 0, 1, 3])

      const removed = removeTile(doc, 1)
      expect(removed.doc).not.toBe(doc)
      expect(removed.doc.count).toBe(3)
      expect(removed.mapping).toEqual([0, 0, 1, 2])
    })
  })
})

describe('bankedSheetPixels — the map editor\'s stacked 768-cell layout', () => {
  const solid = (byte: number) => ({ pattern: new Array(8).fill(byte), color: new Array(8).fill(0xf1) })

  // Banks at different lengths and a non-zero sharedTiles, deliberately not a
  // uniform `count: 256` — Task 10's brief notes four earlier defects on this
  // branch survived review because fixtures were too dense to show the bug
  // they were meant to catch. bank 0 overrides 0..2, bank 1 overrides only 0,
  // bank 2 overrides nothing at all (a pure fallback-to-common bank).
  const rawTiles: unknown[] = [0, 1, 2, 3, 4, 5].map((i) => solid(0x10 + i))
  rawTiles[254] = solid(0xee)
  rawTiles[255] = solid(0xff)
  const doc = normalizeTiles({
    mode: 'sc2',
    count: 6,
    tiles: rawTiles,
    bankTiles: [[solid(0xaa), solid(0xbb), solid(0xcc)], [solid(0xdd)], []],
    sharedTiles: 2
  })

  /** The 8×8 palette-index block the stacked sheet holds at cell `cell` (16 columns). */
  function cellPixels(sheet: { width: number; indices: Uint8Array }, cell: number): number[] {
    const cols = 16
    const ox = (cell % cols) * TILE_SIZE
    const oy = Math.floor(cell / cols) * TILE_SIZE
    const out: number[] = []
    for (let y = 0; y < TILE_SIZE; y++) {
      for (let x = 0; x < TILE_SIZE; x++) out.push(sheet.indices[(oy + y) * sheet.width + ox + x])
    }
    return out
  }

  it('sizes the sheet at 16 columns × 768 cells (48 rows of 8px tiles)', () => {
    const sheet = bankedSheetPixels(doc)
    expect(sheet.width).toBe(16 * TILE_SIZE)
    expect(sheet.height).toBe(48 * TILE_SIZE)
    expect(sheet.indices).toHaveLength(sheet.width * sheet.height)
  })

  it('places bank b\'s tile i at cell b * 256 + i — not i * 3 + b, the transposition that looks plausible on screen', () => {
    const sheet = bankedSheetPixels(doc)
    // A representative index from each bank, an overridden one and a
    // fallen-through one, covering all three banks including the one with no
    // overrides at all.
    const cases: Array<[bank: number, index: number]> = [
      [0, 0], // overridden (0xaa)
      [0, 5], // falls through to the common tile (0x15)
      [1, 0], // overridden (0xdd)
      [1, 2], // falls through to the common tile (0x12)
      [2, 0], // bank 2 has no overrides at all — pure fallback
      [2, 5]
    ]
    for (const [bank, index] of cases) {
      const cell = bank * MAX_TILES + index
      expect(cellPixels(sheet, cell)).toEqual(Array.from(bankTilePixels(doc, bank, index)))
    }
  })

  it('a bank with no overrides falls through to the common tile at every index it is asked for', () => {
    const sheet = bankedSheetPixels(doc)
    for (const index of [0, 1, 4, 5, 100, 253]) {
      const cell = 2 * MAX_TILES + index
      expect(cellPixels(sheet, cell)).toEqual(Array.from(tilePixels(doc, index)))
    }
  })

  it('the shared region reads identically in all three banks', () => {
    const sheet = bankedSheetPixels(doc)
    for (const index of [254, 255]) {
      const bank0 = cellPixels(sheet, 0 * MAX_TILES + index)
      const bank1 = cellPixels(sheet, 1 * MAX_TILES + index)
      const bank2 = cellPixels(sheet, 2 * MAX_TILES + index)
      expect(bank1).toEqual(bank0)
      expect(bank2).toEqual(bank0)
      expect(bank0).toEqual(Array.from(tilePixels(doc, index)))
    }
  })
})

describe('packBankedTiles — the importer\'s own three-bank path', () => {
  const solid = (byte: number): TileEntry => ({ pattern: new Array(8).fill(byte), color: new Array(8).fill(0xf1) })

  it('packs a full screen into three banks, bank-relative', () => {
    // 256x192 of three distinct horizontal bands: each third needs one tile, and
    // each gets index 0 in its own bank — the same byte, three pictures.
    const indices = new Uint8Array(256 * 192)
    for (let y = 0; y < 192; y++) indices.fill(y < 64 ? 1 : y < 128 ? 2 : 3, y * 256, y * 256 + 256)
    const { doc, layout, unplaced } = packBankedTiles(indices, 256, 192, 'sc2')
    expect(doc.bankTiles.map((b) => b.length)).toEqual([1, 1, 1])
    expect(layout.every((index) => index === 0)).toBe(true)
    expect(unplaced).toEqual([0, 0, 0])
  })

  it('reports per bank when a third will not fit, because the budget is per bank', () => {
    // Every cell of the top third distinct: 32*8 = 256 cells, and the bank holds
    // 256 — so it just fits; 257 would not. Bands below stay unaffected.
    const indices = new Uint8Array(256 * 192)
    for (let i = 0; i < 256 * 64; i++) indices[i] = i % 15
    const { unplaced } = packBankedTiles(indices, 256, 192, 'sc2')
    expect(unplaced[1]).toBe(0)
    expect(unplaced[2]).toBe(0)
  })

  /**
   * A top band whose 256 cells (32 cols × 8 tile-rows) are genuinely all
   * distinct — unlike the `i % 15` fixture the brief's own Step 1 test uses,
   * which (its comment's claim notwithstanding) only produces 15 distinct
   * tiles: a solid-color 8×8 tile collapses to one of a handful of patterns
   * regardless of which of the 16 palette indices fills it, since
   * `tileFromPixels` derives the pattern from *which pixels differ from the
   * row's background*, not from the color value itself. Genuine variety needs
   * the *bit pattern* to differ per tile, not just the color — so each tile's
   * own row 0 encodes its linear index `p` (0..255) as 8 bits, two fixed
   * colors marking 1/0, and the other seven rows stay blank (untouched
   * zeros), contributing the same constant suffix to every tile's dedup key
   * without threatening the uniqueness row 0 alone already guarantees.
   */
  function fullyDistinctTopBand(): Uint8Array {
    const indices = new Uint8Array(256 * 192)
    for (let p = 0; p < 256; p++) {
      const tx = p % 32
      const ty = Math.floor(p / 32)
      const rowStart = ty * 8 * 256 + tx * 8
      for (let x = 0; x < 8; x++) indices[rowStart + x] = (p >> (7 - x)) & 1 ? 5 : 3
    }
    return indices
  }

  it('a full band with no shared reservation always fits — a band has exactly as many cells as a bank has room', () => {
    // 32 cols * 8 tile-rows = 256 cells, exactly MAX_TILES: with sharedTiles at
    // its default of 0, a full band can never overflow, no matter how varied its
    // art is.
    const { doc, unplaced } = packBankedTiles(fullyDistinctTopBand(), 256, 192, 'sc2')
    expect(doc.bankTiles[0]).toHaveLength(256)
    expect(unplaced[0]).toBe(0)
  })

  it('carries an existing shared (meta-tile) region through unchanged, and caps every bank below it', () => {
    // Simulates importing over a tileset that already backs 20 real meta-tile
    // entries — not just a count, the art itself, each a distinct byte so a
    // specific one can be checked for exact survival rather than mere
    // presence. The same fully-distinct top band from the previous test now
    // has nowhere for its last 20 cells to go, proving the cap is load-bearing
    // and that a bank can never grow into the shared region reserved at the
    // top of its 256 slots.
    const shared = Array.from({ length: 20 }, (_, i) => solid(0x40 + i))
    const { doc, unplaced } = packBankedTiles(fullyDistinctTopBand(), 256, 192, 'sc2', { shared })
    expect(doc.bankTiles[0]).toHaveLength(MAX_TILES - 20)
    expect(unplaced[0]).toBe(20)
    // Bands below are untouched by the top band's own art — an all-zero source,
    // one tile each — but the shared cap still applies to every bank equally.
    expect(doc.bankTiles[1]).toHaveLength(1)
    expect(doc.bankTiles[2]).toHaveLength(1)
    expect(doc.sharedTiles).toBe(20)
    // sharedStart = 256 - 20 = 236, so hardware index 251 is shared[15] — the
    // reviewer's own probe: real art at a shared index must come back exactly
    // as given, not blanked by a doc this function never actually received.
    expect(doc.tiles[251]).toEqual(shared[15])
    expect(doc.tiles[236]).toEqual(shared[0])
    expect(doc.tiles[255]).toEqual(shared[19])
  })

  it('with no existing shared region passed in, the returned doc has none to preserve', () => {
    // The honest complement to the test above: called the way every caller
    // today actually calls it (no `options` at all), there is no shared art
    // to carry through, so the doc's shared region is simply absent —
    // `sharedTiles` stays 0 and every bank's budget is the full MAX_TILES.
    const { doc } = packBankedTiles(fullyDistinctTopBand(), 256, 192, 'sc2')
    expect(doc.sharedTiles).toBe(0)
    expect(doc.bankTiles[0]).toHaveLength(MAX_TILES)
  })

  it('keeps a partial fixture partial: dedup counts differ per band and stay independent', () => {
    // A sparse fixture, not a dense one: each band gets a handful of distinct
    // 8x8 tiles (not 256, not 1), and a different count per band — the shape a
    // real screenshot actually has, and the shape that would catch a bug where
    // one bank's dedup map bled into another's.
    const width = 256
    const height = 192
    const cols = width / 8
    const indices = new Uint8Array(width * height)
    for (let band = 0; band < 3; band++) {
      // Band `band` gets `band + 2` distinct solid-color tiles, striped by
      // column so most of the band re-matches a tile already seen — exercising
      // the dedup path, not just first-sight placement.
      const distinct = band + 2
      for (let ty = 0; ty < 8; ty++) {
        for (let tx = 0; tx < cols; tx++) {
          const value = (tx % distinct) + 1
          const absTileRow = band * 8 + ty
          for (let y = 0; y < 8; y++) {
            for (let x = 0; x < 8; x++) {
              indices[(absTileRow * 8 + y) * width + tx * 8 + x] = value
            }
          }
        }
      }
    }
    const { doc, layout, unplaced } = packBankedTiles(indices, width, height, 'sc2')
    expect(doc.bankTiles.map((b) => b.length)).toEqual([2, 3, 4])
    expect(unplaced).toEqual([0, 0, 0])
    expect(layout).toHaveLength(cols * 24)
    // Bank 0's first tile-row cycles two colors over its 32 columns: 0,1,0,1,…
    expect(layout.slice(0, 4)).toEqual([0, 1, 0, 1])
    expect(isBanked(doc)).toBe(true)
    expect(validateTiles(doc)).toEqual([])
  })
})
