import { describe, expect, it } from 'vitest'
import { MSX1_PALETTE_RGB } from './palette'
import { countTiles, reduceTiles } from './tile-reduce'

/** A picture of `cols × rows` cells, each filled with the colour `fill(cx, cy)`, plus one dot of `dot(cx, cy)` at its top-left. */
function picture(cols: number, rows: number, fill: (cx: number, cy: number) => number, dot?: (cx: number, cy: number) => number): Uint8Array {
  const width = cols * 8
  const out = new Uint8Array(width * rows * 8)
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) out[(cy * 8 + y) * width + cx * 8 + x] = fill(cx, cy)
      if (dot) out[cy * 8 * width + cx * 8] = dot(cx, cy)
    }
  }
  return out
}

describe('countTiles', () => {
  it('counts tiles by their pixels, once each, and per screen third', () => {
    // 32×24 cells: a sky of one tile, and 24 rows of ground below, every cell its own.
    const indices = picture(32, 24, (cx, cy) => (cy < 8 ? 5 : 12), (cx, cy) => (cy < 8 ? 5 : 1 + ((cx + cy * 32) % 15)))
    const count = countTiles(indices, 256, 192)
    expect(count.cells).toBe(768)
    expect(count.bands).toHaveLength(3)
    expect(count.bands[0]).toBe(1)
    expect(count.distinct).toBeLessThan(768)
  })

  it('ignores a partial cell at the edge, as the packers do', () => {
    expect(countTiles(new Uint8Array(12 * 8), 12, 8)).toEqual({ cells: 1, distinct: 1, bands: [1] })
  })
})

describe('reduceTiles', () => {
  it('brings a picture down to the budget, replacing whole tiles', () => {
    // 20 tiles that differ by one dot's colour: the rarest and most alike go first.
    const indices = picture(20, 1, () => 1, (cx) => (cx % 15) + 1)
    expect(countTiles(indices, 160, 8).distinct).toBe(15)
    const { indices: reduced, merged } = reduceTiles(indices, 160, 8, MSX1_PALETTE_RGB, 6)
    expect(countTiles(reduced, 160, 8).distinct).toBe(6)
    expect(merged).toBe(9)
    // Every cell shows one of the original tiles, untouched.
    const originals = new Set(Array.from({ length: 20 }, (_, cx) => (cx % 15) + 1))
    for (let cx = 0; cx < 20; cx++) expect(originals.has(reduced[cx * 8])).toBe(true)
    for (let i = 0; i < reduced.length; i++) if (i % 8 !== 0 || i >= 160) expect(reduced[i]).toBe(1)
  })

  it('keeps the more-used of two alike tiles', () => {
    // Nine cells of a plain black tile and one with a single white dot.
    const indices = picture(10, 1, () => 1, (cx) => (cx === 9 ? 15 : 1))
    const { indices: reduced } = reduceTiles(indices, 80, 8, MSX1_PALETTE_RGB, 1)
    expect(reduced.every((index) => index === 1)).toBe(true)
  })

  it('leaves a picture that fits as it is', () => {
    const indices = picture(4, 1, (cx) => cx + 1)
    const { indices: reduced, merged } = reduceTiles(indices, 32, 8, MSX1_PALETTE_RGB, 256)
    expect(merged).toBe(0)
    expect([...reduced]).toEqual([...indices])
  })
})
