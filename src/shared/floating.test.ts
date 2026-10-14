import { describe, expect, it } from 'vitest'
import {
  clampFloat,
  composeFloat,
  copyClip,
  fillRect,
  floatFootprint,
  liftFloat,
  normalizeRect,
  placeFloat,
  rectContains,
  type Float
} from './floating'

/** A 4×3 grid numbered 1..12, row-major — every cell distinct, so a move can't hide behind a coincidence. */
function grid(): number[] {
  return Array.from({ length: 12 }, (_, i) => i + 1)
}

describe('selection rectangles', () => {
  it('normalizes reversed corners and clips to the grid', () => {
    expect(normalizeRect({ x: 3, y: 2 }, { x: 1, y: 0 }, 4, 3)).toEqual({ x: 1, y: 0, width: 3, height: 3 })
    expect(normalizeRect({ x: -4, y: 1 }, { x: 9, y: 1 }, 4, 3)).toEqual({ x: 0, y: 1, width: 4, height: 1 })
  })

  it('tests containment on the half-open rectangle', () => {
    const rect = { x: 1, y: 1, width: 2, height: 1 }
    expect(rectContains(rect, { x: 2, y: 1 })).toBe(true)
    expect(rectContains(rect, { x: 3, y: 1 })).toBe(false)
    expect(rectContains(rect, { x: 1, y: 2 })).toBe(false)
  })

  it('copies a clip, reading off-grid cells as 0', () => {
    expect(copyClip(grid(), 4, 3, { x: 2, y: 1, width: 3, height: 2 }).values).toEqual([7, 8, 0, 11, 12, 0])
  })

  it('fills a rectangle and returns the same grid when nothing changes', () => {
    const values = grid()
    const out = fillRect(values, 4, 3, { x: 1, y: 1, width: 2, height: 1 }, 0)
    expect(out).toEqual([1, 2, 3, 4, 5, 0, 0, 8, 9, 10, 11, 12])
    expect(values[5]).toBe(6)
    expect(fillRect(out, 4, 3, { x: 1, y: 1, width: 2, height: 1 }, 0)).toBe(out)
  })
})

describe('floating selection', () => {
  it('moves: lifts a rectangle, clears where it was and writes where it lands', () => {
    const values = grid()
    const float = { ...liftFloat(values, 4, 3, { x: 0, y: 0, width: 2, height: 2 }), x: 2, y: 1 }
    expect(composeFloat(values, 4, 3, float)).toEqual([0, 0, 3, 4, 0, 0, 1, 2, 9, 10, 5, 6])
    // The document it was lifted from is not touched.
    expect(values[0]).toBe(1)
  })

  it('keeps the overlap when moved by less than its own size', () => {
    const float = { ...liftFloat(grid(), 4, 3, { x: 0, y: 0, width: 2, height: 1 }), x: 1 }
    expect(composeFloat(grid(), 4, 3, float).slice(0, 4)).toEqual([0, 1, 2, 4])
  })

  it('copies instead of moving when lifted as a copy', () => {
    const float = { ...liftFloat(grid(), 4, 3, { x: 0, y: 0, width: 1, height: 1 }, true), x: 3, y: 2 }
    const out = composeFloat(grid(), 4, 3, float)
    expect(out[0]).toBe(1)
    expect(out[11]).toBe(1)
  })

  it('clips what hangs off the grid and skips the see-through value', () => {
    const float: Float = { clip: { width: 2, height: 2, values: [5, 0, 7, 8] }, x: -1, y: 2, from: null, transparent: 0 }
    const out = composeFloat(new Uint8Array(12).fill(9), 4, 3, float)
    // Only the clip's right column is on the grid, and only its bottom row is in range: one cell, value 0 → skipped.
    expect([...out]).toEqual(new Array(12).fill(9))
    const opaque = composeFloat(new Uint8Array(12).fill(9), 4, 3, { ...float, x: 0, y: 1 })
    expect([...opaque.slice(4, 6)]).toEqual([5, 9])
    expect([...opaque.slice(8, 10)]).toEqual([7, 8])
  })

  it('returns the input untouched when a paste changes nothing', () => {
    const values = grid()
    expect(composeFloat(values, 4, 3, { clip: { width: 1, height: 1, values: [1] }, x: 0, y: 0, from: null, transparent: null })).toBe(values)
  })

  it('keeps one row and column on the grid however far it is dragged', () => {
    expect(clampFloat({ x: -10, y: 50 }, 3, 2, 4, 3)).toEqual({ x: -2, y: 2 })
    expect(placeFloat({ width: 2, height: 2, values: [1, 1, 1, 1] }, { x: 9, y: -9 }, 4, 3)).toMatchObject({ x: 3, y: -1, from: null })
  })

  it('reports the cells a drop writes at both ends, clipped', () => {
    const float = { ...liftFloat(grid(), 4, 3, { x: 0, y: 0, width: 2, height: 2 }), x: 3, y: 2 }
    expect(floatFootprint(float, 4, 3)).toEqual([
      { x: 0, y: 0, width: 2, height: 2 },
      { x: 3, y: 2, width: 1, height: 1 }
    ])
  })
})
