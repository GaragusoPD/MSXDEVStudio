import { describe, expect, it } from 'vitest'
import { createMetaTileDoc, frameTileAt } from './meta-tile'
import {
  findOrCreateBankTile,
  findOrCreateTile,
  paintBitmapMeta,
  paintGrid,
  paintMeta,
  sprayPoints,
  usedTiles
} from './meta-paint'
import { normalizeBitmapTiles, tileImage, type BitmapTilesDoc } from './bitmap-tile'
import {
  bankTileAt,
  blankTileEntry,
  createTilesDoc,
  MAX_TILES,
  mergeColorByte,
  normalizeTiles,
  tilePixels,
  type TileEntry,
  type TilesDoc
} from './tile'

const bank = (over: Record<string, unknown> = {}): TilesDoc =>
  normalizeTiles({ mode: 'sc2', count: 4, reserveTile0: true, ...over })

const solid = (byte: number, color = 0x21): { pattern: number[]; color: number[] } => ({
  pattern: new Array(8).fill(byte),
  color: new Array(8).fill(color)
})

describe('findOrCreateTile', () => {
  it('reuses an identical tile rather than appending — this is the dedup', () => {
    const doc = bank()
    const first = findOrCreateTile(doc, solid(0x3c))!
    const second = findOrCreateTile(first.doc, solid(0x3c))!
    expect(second.index).toBe(first.index)
    expect(second.doc.count).toBe(first.doc.count)
  })

  it('appends when the pattern is new, and never disturbs an existing index', () => {
    const doc = bank()
    const before = tilePixels(doc, 1)
    const result = findOrCreateTile(doc, solid(0x99))!
    expect(result.index).toBe(4)
    expect(result.doc.count).toBe(5)
    expect(tilePixels(result.doc, 1)).toEqual(before)
  })

  it('distinguishes tiles that share a pattern but not a colour', () => {
    const doc = bank()
    const a = findOrCreateTile(doc, solid(0x3c, 0x21))!
    const b = findOrCreateTile(a.doc, solid(0x3c, 0x54))!
    expect(b.index).not.toBe(a.index)
  })

  it('returns null when the bank is full — the caller refuses the whole stroke', () => {
    expect(findOrCreateTile(bank({ count: 256 }), solid(0xaa))).toBeNull()
  })

  it('matches the reserved blank at index 0 instead of appending a second blank', () => {
    expect(findOrCreateTile(bank(), blankTileEntry('sc2'))!.index).toBe(0)
  })

  it('sc1: reuses a tile only when its group pair matches too', () => {
    const doc = normalizeTiles({ mode: 'sc1', count: 16, reserveTile0: true, groupColors: [0x21, 0x54] })
    const entry = { pattern: new Array(8).fill(3), color: [] }
    const made = findOrCreateTile(doc, entry, 0x21)!
    // Same bits under a different pair is a different picture, not the same one.
    const other = findOrCreateTile(made.doc, entry, 0x54)!
    expect(other.index).not.toBe(made.index)
  })

  it('sc1: pads to the next group boundary when the current group serves another pair', () => {
    // count 12 means the next append lands at 12, inside group 1, whose pair is 0x54.
    const doc = normalizeTiles({ mode: 'sc1', count: 12, reserveTile0: true, groupColors: [0x21, 0x54] })
    const made = findOrCreateTile(doc, { pattern: new Array(8).fill(7), color: [] }, 0x21)!
    expect(made.index).toBe(16)
    expect(made.doc.groupColors[2]).toBe(0x21)
    // The padding is blank, and belongs to no design.
    expect(made.doc.tiles[13].pattern).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })

  it('sc1: appends in place when the current group already serves that pair', () => {
    const doc = normalizeTiles({ mode: 'sc1', count: 12, reserveTile0: true, groupColors: [0x21, 0x54] })
    expect(findOrCreateTile(doc, { pattern: new Array(8).fill(7), color: [] }, 0x54)!.index).toBe(12)
  })
})

describe('paintMeta', () => {
  const meta = createMetaTileDoc('t.tiles.json', 2, 1)

  it('paints a pixel by creating a tile and repointing the cell — copy on write', () => {
    const doc = bank()
    const result = paintMeta(meta, doc, 0, [{ x: 0, y: 0 }], 5)
    expect(result.dropped).toBe(0)
    expect(result.added).toHaveLength(1)
    expect(frameTileAt(result.meta, 0, 0, 0)).toBe(result.added[0])
    // Tile 0 is untouched, so nothing else pointing at it has changed.
    expect(tilePixels(result.tiles, 0)).toEqual(tilePixels(doc, 0))
  })

  it('leaves the cells the stroke did not touch alone', () => {
    expect(frameTileAt(paintMeta(meta, bank(), 0, [{ x: 0, y: 0 }], 5).meta, 0, 1, 0)).toBe(0)
  })

  it('drops a pixel that would need a third colour in its row, and counts it', () => {
    // Row 0 of tile 1 spends both of its pair: 0x21 is fg 2 / bg 1, pattern 0xf0.
    const doc = normalizeTiles({
      mode: 'sc2',
      count: 2,
      reserveTile0: true,
      tiles: [{ pattern: [], color: [] }, { pattern: [0xf0, 0, 0, 0, 0, 0, 0, 0], color: new Array(8).fill(0x21) }]
    })
    const seeded = { ...meta, frames: [{ tiles: [1, 0] }] }
    const result = paintMeta(seeded, doc, 0, [{ x: 0, y: 0 }], 7)
    expect(result.dropped).toBe(1)
    expect(result.added).toEqual([])
    expect(frameTileAt(result.meta, 0, 0, 0)).toBe(1)
  })

  it('refuses the whole stroke when the bank is full, changing nothing', () => {
    const full = bank({ count: 256 })
    const result = paintMeta(meta, full, 0, [{ x: 0, y: 0 }], 5)
    expect(result.refused).toMatch(/256/)
    expect(result.meta).toBe(meta)
    expect(result.tiles).toBe(full)
  })

  it('erasing a whole cell resolves back to tile 0 through ordinary dedup', () => {
    const painted = paintMeta(meta, bank(), 0, [{ x: 0, y: 0 }], 5)
    const cell = Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => ({ x, y }))).flat()
    expect(frameTileAt(paintMeta(painted.meta, painted.tiles, 0, cell, 0).meta, 0, 0, 0)).toBe(0)
  })

  it('two cells painted identically share one tile', () => {
    const result = paintMeta(meta, bank(), 0, [{ x: 0, y: 0 }, { x: 8, y: 0 }], 5)
    expect(frameTileAt(result.meta, 0, 0, 0)).toBe(frameTileAt(result.meta, 0, 1, 0))
    expect(result.added).toHaveLength(1)
  })

  it('ignores points outside the meta, so a drag off the canvas needs no clamping', () => {
    expect(paintMeta(meta, bank(), 0, [{ x: 99, y: 99 }, { x: -1, y: 0 }], 5).meta).toBe(meta)
  })

  it('returns the same meta and tiles by reference when an in-bounds stroke repaints the tile already there', () => {
    // Points are strictly in bounds (0,0 is cell 0 of a 2x1 meta), so the
    // off-canvas early return cannot be what makes this pass — that path is
    // already covered above. This is `pushHistory`'s reference-equal no-op
    // check: a second, idle stroke must not look like an edit.
    const first = paintMeta(meta, bank(), 0, [{ x: 0, y: 0 }], 5)
    const second = paintMeta(first.meta, first.tiles, 0, [{ x: 0, y: 0 }], 5)
    expect(second.meta).toBe(first.meta)
    expect(second.tiles).toBe(first.tiles)
    expect(second.added).toEqual([])
  })

  it('is a no-op on a frame that does not exist', () => {
    expect(paintMeta(meta, bank(), 9, [{ x: 0, y: 0 }], 5).meta).toBe(meta)
  })

  it('paints only the frame it is given', () => {
    const two = { ...meta, frames: [{ tiles: [0, 0] }, { tiles: [0, 0] }] }
    const result = paintMeta(two, bank(), 1, [{ x: 0, y: 0 }], 5)
    expect(frameTileAt(result.meta, 0, 0, 0)).toBe(0)
    expect(frameTileAt(result.meta, 1, 0, 0)).not.toBe(0)
  })
})

describe('paintGrid', () => {
  it('paints a dot into a plain grid and forks a tile for it', () => {
    const tiles = createTilesDoc('sc2', 1)
    const grid = { width: 2, height: 1, tiles: [0, 0] }

    const result = paintGrid(grid, tiles, [{ x: 1, y: 1 }], 7)

    expect(result.grid.tiles[0]).not.toBe(0)
    expect(result.grid.tiles[1]).toBe(0)
    expect(result.added).toEqual([result.grid.tiles[0]])
    expect(result.refused).toBeUndefined()
  })

  it('indexes by CELL, so a point in the second cell row uses the grid width as stride', () => {
    const tiles = createTilesDoc('sc2', 1)
    const grid = { width: 4, height: 4, tiles: new Array(16).fill(0) }

    // Pixel (0, 8) is cell (0, 1) — index 4 with a stride of 4.
    const result = paintGrid(grid, tiles, [{ x: 0, y: 8 }], 7)

    expect(result.grid.tiles[4]).not.toBe(0)
    expect(result.grid.tiles[0]).toBe(0)
  })

  it('ignores points outside the grid, so a drag off-canvas needs no clamping', () => {
    const tiles = createTilesDoc('sc2', 1)
    const grid = { width: 1, height: 1, tiles: [0] }

    const result = paintGrid(grid, tiles, [{ x: 99, y: 0 }, { x: -1, y: 0 }], 7)

    expect(result.grid).toBe(grid)
    expect(result.tiles).toBe(tiles)
  })

  it('returns the same grid by reference when a stroke resolves to the tiles already there', () => {
    const tiles = createTilesDoc('sc2', 1)
    const grid = { width: 1, height: 1, tiles: [0] }
    const once = paintGrid(grid, tiles, [{ x: 1, y: 1 }], 7)

    const twice = paintGrid(once.grid, once.tiles, [{ x: 1, y: 1 }], 7)

    expect(twice.grid).toBe(once.grid)
    expect(twice.tiles).toBe(once.tiles)
    expect(twice.added).toEqual([])
  })
})

describe("paintGrid write: 'edit'", () => {
  it("edit mode rewrites the cell's own tile and repoints nothing", () => {
    const tiles = createTilesDoc('sc2', 4)
    const grid = { width: 2, height: 1, tiles: [2, 2] }

    const result = paintGrid(grid, tiles, [{ x: 1, y: 1 }], 7, undefined, { write: 'edit' })

    expect(result.grid.tiles).toEqual([2, 2])
    expect(result.tiles.tiles[2]).not.toEqual(tiles.tiles[2])
    expect(result.added).toEqual([])
    expect(result.tiles.count).toBe(tiles.count)
    expect(result.tileEdits).toEqual([
      { index: 2, bank: null, before: tiles.tiles[2], after: result.tiles.tiles[2] }
    ])
  })

  it('edit mode never refuses on a full tileset, because it allocates nothing', () => {
    const full = createTilesDoc('sc2', MAX_TILES)
    const grid = { width: 1, height: 1, tiles: [5] }

    const result = paintGrid(grid, full, [{ x: 0, y: 0 }], 7, undefined, { write: 'edit' })

    expect(result.refused).toBeUndefined()
    expect(result.tiles.tiles[5]).not.toEqual(full.tiles[5])
  })

  it('edit mode writes into the bank that shows the tile, not the common set', () => {
    const solid = (byte: number) => ({
      pattern: new Array(8).fill(byte),
      color: new Array(8).fill(mergeColorByte(15, 4))
    })
    const tiles = normalizeTiles({
      mode: 'sc2',
      count: 1,
      bankTiles: [[solid(0xff)], [solid(0x0f)], []],
      sharedTiles: 0
    })
    const grid = { width: 32, height: 24, tiles: new Array(32 * 24).fill(0) }

    const result = paintGrid(grid, tiles, [{ x: 0, y: 0 }], 0, 'bg', {
      write: 'edit',
      bankOf: (row) => row >> 3
    })

    expect(result.tiles.bankTiles[0][0].pattern[0]).toBe(0x7f)
    expect(result.tiles.bankTiles[1][0]).toEqual(solid(0x0f)) // untouched
    expect(result.tileEdits[0].bank).toBe(0)
  })

  it("edit mode writes the common tile when the row's own bank does not override it", () => {
    const solid = (byte: number) => ({
      pattern: new Array(8).fill(byte),
      color: new Array(8).fill(mergeColorByte(15, 4))
    })
    // Uneven banks over a real shared region: bank 0 overrides tiles 0–2,
    // bank 1 only tile 0, bank 2 nothing at all.
    const tiles = normalizeTiles({
      mode: 'sc2',
      count: 3,
      tiles: [solid(0x11), solid(0x22), solid(0xff)],
      bankTiles: [[solid(0x44), solid(0x55), solid(0x66)], [solid(0x77)], []],
      sharedTiles: 2
    })
    const grid = { width: 32, height: 24, tiles: new Array(32 * 24).fill(2) }

    // Cell row 16 is bank 2's, and bank 2 shows the common tile 2 there.
    const result = paintGrid(grid, tiles, [{ x: 0, y: 16 * 8 }], 0, 'bg', {
      write: 'edit',
      bankOf: (row) => row >> 3
    })

    expect(result.tiles.tiles[2].pattern[0]).toBe(0x7f)
    expect(result.tiles.bankTiles[0][2]).toEqual(solid(0x66)) // bank 0 keeps its own art
    expect(result.tileEdits[0].bank).toBeNull()
    expect(result.tiles.sharedTiles).toBe(2)
    expect(result.tiles.bankTiles[2]).toEqual([])
  })

  it('edit mode forks instead of overwriting a reserved tile 0', () => {
    const tiles = createTilesDoc('sc2', 4, true)
    const grid = { width: 1, height: 1, tiles: [0] }

    const result = paintGrid(grid, tiles, [{ x: 1, y: 1 }], 7, undefined, { write: 'edit' })

    expect(result.tiles.tiles[0]).toEqual(tiles.tiles[0]) // still blank
    expect(result.grid.tiles[0]).not.toBe(0) // forked instead
    expect(result.tileEdits).toEqual([])
  })

  it('fork mode records no tileEdits', () => {
    const tiles = createTilesDoc('sc2', 4)
    const result = paintGrid({ width: 1, height: 1, tiles: [2] }, tiles, [{ x: 0, y: 0 }], 7)

    expect(result.tileEdits).toEqual([])
  })

  it('sc1: an edit rewrites the group colour too, since that is half the picture', () => {
    const tiles = normalizeTiles({ mode: 'sc1', count: 16, groupColors: [0x21, 0x54] })
    const grid = { width: 1, height: 1, tiles: [9] }

    const result = paintGrid(grid, tiles, [{ x: 0, y: 0 }], 7, 'fg', { write: 'edit' })

    // Tile 9 is in group 1, so only group 1's pair moves.
    expect(result.tiles.groupColors[1]).toBe(mergeColorByte(7, 4))
    expect(result.tiles.groupColors[0]).toBe(0x21)
    expect(result.tiles.tiles[9].pattern[0]).toBe(0x80)
    expect(result.tileEdits[0].beforeGroup).toBe(0x54)
  })

  it('sc1: beforeGroup is the pair the stroke found, not the one the cell before it left', () => {
    // Tiles 8 and 9 share group 1 — adjacent cells on a converted screen. The
    // first cell's write moves the pair, so reading `beforeGroup` off the
    // running document would record the *first write's* colour as the second
    // tile's "before", and an undo replayed front-to-back would land on it.
    const tiles = normalizeTiles({ mode: 'sc1', count: 16, groupColors: [0x21, 0x54] })
    const grid = { width: 2, height: 1, tiles: [8, 9] }

    const result = paintGrid(grid, tiles, [{ x: 0, y: 0 }, { x: 8, y: 0 }], 7, 'fg', { write: 'edit' })

    expect(result.tileEdits).toHaveLength(2)
    expect(result.tileEdits.map((edit) => edit.beforeGroup)).toEqual([0x54, 0x54])
  })

  it('records one edit per tile, holding the art from before and after the whole stroke', () => {
    const tiles = createTilesDoc('sc2', 4)
    const grid = { width: 2, height: 1, tiles: [2, 2] }

    // Two cells, one tile. The second write must not overwrite the first's
    // `before`, and `after` must be the art the tile ends the stroke with —
    // a rebase guard comparing against a stale `after` refuses every
    // multi-cell stroke.
    const result = paintGrid(grid, tiles, [{ x: 1, y: 1 }, { x: 8, y: 3 }], 7, 'fg', { write: 'edit' })

    expect(result.tileEdits).toHaveLength(1)
    expect(result.tileEdits[0].before).toEqual({
      pattern: new Array(8).fill(0),
      color: new Array(8).fill(0xf1)
    })
    expect(result.tileEdits[0].after).toBe(result.tiles.tiles[2])
    expect(result.tiles.tiles[2].pattern[1]).toBe(0x40)
    expect(result.tiles.tiles[2].pattern[3]).toBe(0x80)
  })

  it('an idle edit repaint hands back the same document and records nothing', () => {
    const tiles = createTilesDoc('sc2', 4)
    const grid = { width: 1, height: 1, tiles: [2] }
    const once = paintGrid(grid, tiles, [{ x: 1, y: 1 }], 7, undefined, { write: 'edit' })

    const twice = paintGrid(once.grid, once.tiles, [{ x: 1, y: 1 }], 7, undefined, { write: 'edit' })

    expect(twice.tiles).toBe(once.tiles)
    expect(twice.grid).toBe(once.grid)
    expect(twice.tileEdits).toEqual([])
  })
})

describe('findOrCreateBankTile', () => {
  const solid = (byte: number) => ({
    pattern: new Array(8).fill(byte),
    color: new Array(8).fill(mergeColorByte(15, 4))
  })

  /** Uneven banks, a real shared region with real art, and count > 0. */
  function banked(): TilesDoc {
    const doc = normalizeTiles({
      mode: 'sc2',
      count: 2,
      tiles: [solid(0x11), solid(0x22)],
      bankTiles: [[solid(0x33), solid(0x44), solid(0x55)], [solid(0x66)], []],
      sharedTiles: 2
    })
    // normalizeTiles leaves the shared region blank; blank matches everything,
    // so give it art or the "finds the shared region" test proves nothing.
    const tiles = doc.tiles.slice()
    tiles[MAX_TILES - 2] = solid(0xaa)
    tiles[MAX_TILES - 1] = solid(0xbb)
    return { ...doc, tiles }
  }

  it('appends above the common range, never shadowing a common tile', () => {
    const doc = banked()
    // Bank 2 has NO overrides and count is 2 — appending at 0 would shadow
    // common tiles 0 and 1 for every cell in the bottom third of the screen.
    const found = findOrCreateBankTile(doc, 2, solid(0x7e))

    expect(found!.index).toBe(2)
    expect(bankTileAt(found!.doc, 2, 0)).toEqual(bankTileAt(doc, 2, 0))
    expect(bankTileAt(found!.doc, 2, 1)).toEqual(bankTileAt(doc, 2, 1))
  })

  it('appends into the named bank and leaves the other two alone', () => {
    const doc = banked()
    const found = findOrCreateBankTile(doc, 0, solid(0x7e))

    expect(found!.index).toBe(3)
    expect(found!.doc.bankTiles[1]).toHaveLength(1)
    expect(found!.doc.bankTiles[2]).toHaveLength(0)
    expect(found!.doc.sharedTiles).toBe(2)
  })

  it('reuses an identical tile already in that bank', () => {
    const doc = banked()
    const found = findOrCreateBankTile(doc, 0, doc.bankTiles[0][1])

    expect(found!.index).toBe(1)
    expect(found!.doc).toBe(doc)
  })

  it('finds the shared region too, since every bank shows it', () => {
    const doc = banked()
    const found = findOrCreateBankTile(doc, 1, doc.tiles[MAX_TILES - 1])

    expect(found!.index).toBe(MAX_TILES - 1)
    expect(found!.doc).toBe(doc)
  })

  it('returns null when the bank has no room below the shared region', () => {
    const doc = normalizeTiles({
      mode: 'sc2',
      count: 1,
      bankTiles: [Array.from({ length: MAX_TILES - 2 }, (_, i) => solid(i & 0xff)), [], []],
      sharedTiles: 2
    })
    // A probe that is NOT in the fill: solid(0x7e) collides with fill entry 126.
    const probe = { pattern: [1, 2, 3, 4, 5, 6, 7, 8], color: new Array(8).fill(mergeColorByte(15, 4)) }

    expect(findOrCreateBankTile(doc, 0, probe)).toBeNull()
  })
})

it("paintGrid with bankOf derives from the bank's art, not the common set", () => {
  const solid = (byte: number) => ({
    pattern: new Array(8).fill(byte),
    color: new Array(8).fill(mergeColorByte(15, 4))
  })
  // The shape a real import produces: count 1, art only in the banks.
  const tiles = normalizeTiles({
    mode: 'sc2',
    count: 1,
    bankTiles: [[solid(0xff)], [solid(0x0f)], []],
    sharedTiles: 0
  })
  const grid = { width: 32, height: 24, tiles: new Array(32 * 24).fill(0) }

  const result = paintGrid(grid, tiles, [{ x: 0, y: 0 }], 0, 'bg', { bankOf: (row) => row >> 3 })

  // Derived from bank 0's solid(0xff) with one dot cleared — NOT from a blank.
  const painted = bankTileAt(result.tiles, 0, result.grid.tiles[0])
  expect(painted.pattern[0]).toBe(0x7f)
})

describe('sprayPoints', () => {
  it('is deterministic — the same call twice gives the same art', () => {
    expect(sprayPoints({ x: 10, y: 10 }, 3, 8)).toEqual(sprayPoints({ x: 10, y: 10 }, 3, 8))
  })

  it('stays inside the brush radius', () => {
    for (const p of sprayPoints({ x: 10, y: 10 }, 3, 16)) {
      expect((p.x - 10) ** 2 + (p.y - 10) ** 2).toBeLessThanOrEqual(9)
    }
  })

  it('density 0 paints nothing and 16 paints more than 8', () => {
    expect(sprayPoints({ x: 10, y: 10 }, 2, 0)).toEqual([])
    expect(sprayPoints({ x: 10, y: 10 }, 2, 16).length).toBeGreaterThan(sprayPoints({ x: 10, y: 10 }, 2, 8).length)
  })

  it('is keyed to absolute coordinates, so overlapping dabs form one dither field', () => {
    const a = sprayPoints({ x: 8, y: 8 }, 4, 8)
    const b = sprayPoints({ x: 10, y: 8 }, 4, 8)
    const bHas = (p: { x: number; y: number }): boolean => b.some((q) => q.x === p.x && q.y === p.y)
    // Every point of `a` that lies inside b's disc is also on in b — the two
    // dabs agree about every pixel they share, rather than mottling it.
    const shared = a.filter((p) => (p.x - 10) ** 2 + (p.y - 8) ** 2 <= 16)
    expect(shared.length).toBeGreaterThan(0)
    for (const p of shared) expect(bHas(p)).toBe(true)
  })

  it('never returns a negative coordinate', () => {
    for (const p of sprayPoints({ x: 1, y: 1 }, 4, 16)) {
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('usedTiles', () => {
  it('collects every index across every frame', () => {
    const doc = { ...createMetaTileDoc('t', 2, 1), frames: [{ tiles: [1, 2] }, { tiles: [2, 3] }] }
    expect([...usedTiles(doc)].sort((a, b) => a - b)).toEqual([1, 2, 3])
  })
})

describe('allocating into a banked tileset', () => {
  const solid = (byte: number): TileEntry => ({ pattern: new Array(8).fill(byte), color: new Array(8).fill(0xf1) })

  it('takes the top index down, so a meta means one picture in every bank', () => {
    const doc = normalizeTiles({ mode: 'sc2', count: 256, bankTiles: [[solid(1)], [], []], sharedTiles: 0 })
    const first = findOrCreateTile(doc, solid(0xaa))
    expect(first?.index).toBe(255)
    expect(first?.doc.sharedTiles).toBe(1)

    const second = findOrCreateTile(first!.doc, solid(0xbb))
    // Downward, and the one already placed does not move — a shifted meta index
    // would renumber every map drawn with this tileset.
    expect(second?.index).toBe(254)
    expect(second!.doc.tiles[255].pattern).toEqual(new Array(8).fill(0xaa))
  })

  it('finds a shared tile it already placed instead of taking another slot', () => {
    const doc = normalizeTiles({ mode: 'sc2', count: 256, bankTiles: [[solid(1)], [], []], sharedTiles: 0 })
    const first = findOrCreateTile(doc, solid(0xaa))!
    const again = findOrCreateTile(first.doc, solid(0xaa))!
    expect(again.index).toBe(255)
    expect(again.doc.sharedTiles).toBe(1)
  })

  it('refuses when the fullest bank has no room left for another shared tile', () => {
    const doc = normalizeTiles({
      mode: 'sc2',
      count: 256,
      bankTiles: [[], new Array(250).fill(solid(2)), []],
      sharedTiles: 6
    })
    // Bank 1 holds 250 + 6 shared = 256. One more shared tile would collide.
    expect(findOrCreateTile(doc, solid(0xcc))).toBeNull()
  })

  it('an unbanked tileset still appends at count, exactly as before', () => {
    const doc = normalizeTiles({ mode: 'sc2', count: 4 })
    const result = findOrCreateTile(doc, solid(0xaa))
    expect(result?.index).toBe(4)
    expect(result?.doc.sharedTiles).toBe(0)
  })

  it('dedup finds shared tiles even when count < 256', () => {
    // A banked tileset with count:4 allocates shared tiles at 255, 254, etc.
    // The old search loop `for (let i = 0; i < doc.count; i++)` would never
    // reach them, so the second paint would think tile 255 is new and mint tile
    // 254, wasting space. The fix searches to MAX_TILES on banked tilesets.
    const doc = normalizeTiles({ mode: 'sc2', count: 4, bankTiles: [[solid(1)], [], []], sharedTiles: 0 })
    const first = findOrCreateTile(doc, solid(0xaa))!
    expect(first.index).toBe(255)
    const second = findOrCreateTile(first.doc, solid(0xaa))!
    expect(second.index).toBe(255)
    expect(second.doc.sharedTiles).toBe(1)
  })
})

describe('paintBitmapMeta', () => {
  const bank = (over: Record<string, unknown> = {}): BitmapTilesDoc =>
    normalizeBitmapTiles({ mode: 'sc5', width: 8, height: 8, count: 1, reserveTile0: true, ...over })

  const meta = createMetaTileDoc('t.btiles.json', 2, 1)

  it('paints a pixel by creating a tile and repointing the cell', () => {
    const tiles = bank()
    const result = paintBitmapMeta(meta, tiles, 0, [{ x: 0, y: 0 }], 5)
    expect(result.added).toHaveLength(1)
    expect(frameTileAt(result.meta, 0, 0, 0)).toBe(result.added[0])
    // Tile 0 is the reserved blank and is left alone.
    expect([...tileImage(result.tiles, 0)].every((p) => p === 0)).toBe(true)
  })

  it('never drops a pixel — a bitmap mode has no per-row colour limit', () => {
    const points = Array.from({ length: 8 }, (_, i) => ({ x: i, y: 0 }))
    let result = paintBitmapMeta(meta, bank(), 0, points, 3)
    result = paintBitmapMeta(result.meta, result.tiles, 0, [{ x: 0, y: 0 }], 11)
    expect(result.dropped).toBe(0)
    expect(tileImage(result.tiles, frameTileAt(result.meta, 0, 0, 0))[0]).toBe(11)
  })

  it('two cells painted identically share one tile', () => {
    const result = paintBitmapMeta(meta, bank(), 0, [{ x: 0, y: 0 }, { x: 8, y: 0 }], 5)
    expect(frameTileAt(result.meta, 0, 0, 0)).toBe(frameTileAt(result.meta, 0, 1, 0))
    expect(result.added).toHaveLength(1)
  })

  it('uses the tileset geometry for the cell grid, not 8x8', () => {
    // A 16-wide tile means x=8 is still cell 0, where an 8x8 grid would say 1.
    const wide = bank({ width: 16, height: 16 })
    const result = paintBitmapMeta(meta, wide, 0, [{ x: 8, y: 0 }], 5)
    expect(frameTileAt(result.meta, 0, 1, 0)).toBe(0)
    expect(frameTileAt(result.meta, 0, 0, 0)).not.toBe(0)
  })

  it('erasing a cell back to all-zero resolves to the reserved blank', () => {
    const painted = paintBitmapMeta(meta, bank(), 0, [{ x: 0, y: 0 }], 5)
    const whole = Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => ({ x, y }))).flat()
    const erased = paintBitmapMeta(painted.meta, painted.tiles, 0, whole, 0)
    expect(frameTileAt(erased.meta, 0, 0, 0)).toBe(0)
  })

  it('refuses the whole stroke when the bank is full, changing nothing', () => {
    const full = bank({ count: 256 })
    const result = paintBitmapMeta(meta, full, 0, [{ x: 0, y: 0 }], 5)
    expect(result.refused).toMatch(/256/)
    expect(result.meta).toBe(meta)
    expect(result.tiles).toBe(full)
  })

  it('ignores points outside the meta', () => {
    expect(paintBitmapMeta(meta, bank(), 0, [{ x: 99, y: 99 }], 5).meta).toBe(meta)
  })
})
