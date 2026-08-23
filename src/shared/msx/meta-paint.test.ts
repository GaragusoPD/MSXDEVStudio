import { describe, expect, it } from 'vitest'
import { createMetaTileDoc, frameTileAt } from './meta-tile'
import { findOrCreateTile, paintBitmapMeta, paintMeta, sprayPoints, usedTiles } from './meta-paint'
import { normalizeBitmapTiles, tileImage, type BitmapTilesDoc } from './bitmap-tile'
import { blankTileEntry, normalizeTiles, tilePixels, type TilesDoc } from './tile'

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
