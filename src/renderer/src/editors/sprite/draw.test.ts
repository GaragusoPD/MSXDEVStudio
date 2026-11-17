/**
 * How `drawIndices` maps dots to canvas pixels, against a context that records
 * what it is asked to do. It draws every thumbnail of the sprite list and the
 * animation bar, so a dot that rounds to nothing is a dot missing from all of
 * them.
 */

import { describe, expect, it } from 'vitest'
import type { Rgb } from '../../../../shared/msx/palette'
import { drawIndices } from './draw'

interface Rect {
  style: string
  x: number
  y: number
  w: number
  h: number
}

function recorder(): { ctx: CanvasRenderingContext2D; rects: Rect[]; styleSets: () => number } {
  const rects: Rect[] = []
  let style = ''
  let sets = 0
  const ctx = {
    get fillStyle(): string {
      return style
    },
    set fillStyle(value: string) {
      style = value
      sets++
    },
    fillRect(x: number, y: number, w: number, h: number): void {
      rects.push({ style, x, y, w, h })
    }
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, rects, styleSets: () => sets }
}

const RGB: Rgb[] = Array.from({ length: 16 }, (_, i) => ({ r: i * 16, g: 255 - i * 16, b: i }))

/** A 4×4 metasprite of 16×16 sprites: 64 dots a side, every one painted. */
const solid = (side: number, index = 1): Uint8Array => new Uint8Array(side * side).fill(index)

describe('drawIndices', () => {
  it('below scale 1 every dot keeps its own fractional square, so none rounds away', () => {
    // 64 dots into a 48-pixel thumbnail: snapping lost every fourth row and column.
    const { ctx, rects } = recorder()
    drawIndices(ctx, solid(64), 64, 0.75, RGB)
    expect(rects).toHaveLength(64 * 64)
    expect(rects.every((r) => r.w === 0.75 && r.h === 0.75)).toBe(true)
    expect(new Set(rects.map((r) => r.y)).size).toBe(64)
    expect(rects[64 * 3 + 5]).toMatchObject({ x: 5 * 0.75, y: 3 * 0.75 })
  })

  it('from scale 1 up, edges snap to whole pixels and every dot gets at least one', () => {
    const { ctx, rects } = recorder()
    drawIndices(ctx, solid(8), 8, 1.5, RGB)
    expect(rects).toHaveLength(64)
    for (const r of rects) {
      expect(Number.isInteger(r.x) && Number.isInteger(r.y) && Number.isInteger(r.w) && Number.isInteger(r.h)).toBe(true)
      expect(r.w).toBeGreaterThanOrEqual(1)
      expect(r.h).toBeGreaterThanOrEqual(1)
    }
    // Adjacent dots meet exactly: no seam, no overlap.
    const row = rects.slice(0, 8)
    for (let i = 1; i < row.length; i++) expect(row[i].x).toBe(row[i - 1].x + row[i - 1].w)
    expect(row[7].x + row[7].w).toBe(12)
  })

  it('at a whole scale draws each dot as a scale-sized square', () => {
    const { ctx, rects } = recorder()
    drawIndices(ctx, solid(4), 4, 3, RGB)
    expect(rects[5]).toMatchObject({ x: 3, y: 3, w: 3, h: 3 })
  })

  it('skips index 0, and sets the colour only when it changes', () => {
    const { ctx, rects, styleSets } = recorder()
    drawIndices(ctx, Uint8Array.from([1, 1, 2, 2, 0, 1, 1, 3]), 8, 2, RGB)
    expect(rects.map((r) => r.style)).toEqual(['rgb(16, 239, 1)', 'rgb(16, 239, 1)', 'rgb(32, 223, 2)', 'rgb(32, 223, 2)', 'rgb(16, 239, 1)', 'rgb(16, 239, 1)', 'rgb(48, 207, 3)'])
    expect(rects.map((r) => r.x)).toEqual([0, 2, 4, 6, 10, 12, 14])
    expect(styleSets()).toBe(4)
  })

  it('an index past the palette draws magenta, so a bad index is visible', () => {
    const { ctx, rects } = recorder()
    drawIndices(ctx, Uint8Array.from([20]), 1, 1, RGB)
    expect(rects[0].style).toBe('rgb(255, 0, 255)')
  })

  it('draws nothing at scale 0', () => {
    const { ctx, rects } = recorder()
    drawIndices(ctx, solid(4), 4, 0, RGB)
    expect(rects).toHaveLength(0)
  })
})
