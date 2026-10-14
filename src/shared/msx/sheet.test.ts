import { describe, expect, it } from 'vitest'
import type { RgbaImage } from './quantize'
import {
  applyKey,
  cellsInRange,
  cellsInRect,
  contentBox,
  cutCell,
  detectKey,
  detectScale,
  gridSize,
  guessGrid,
  isEmpty,
  rowsOf,
  scaleDown,
  selectionRect,
  snapBox,
  splitStrip,
  stripOf,
  type SheetGrid
} from './sheet'

const MAGENTA = 0xff00ff
const RED = 0xff0000
const BLUE = 0x0000ff

/** An image painted by `at(x, y)`: a packed RGB, or null for transparent. */
function image(width: number, height: number, at: (x: number, y: number) => number | null): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = at(x, y)
      const p = (y * width + x) * 4
      if (color === null) continue
      data[p] = (color >> 16) & 0xff
      data[p + 1] = (color >> 8) & 0xff
      data[p + 2] = color & 0xff
      data[p + 3] = 255
    }
  }
  return { width, height, data }
}

const rgb = (img: RgbaImage, x: number, y: number): number | null => {
  const p = (y * img.width + x) * 4
  return img.data[p + 3] < 128 ? null : (img.data[p] << 16) | (img.data[p + 1] << 8) | img.data[p + 2]
}

describe('pixel scale', () => {
  it('finds the scale a 1:1 picture was blown up by, and undoes it', () => {
    // A 4×2 dot picture with a checker, saved at 3×.
    const dots = (x: number, y: number): number => ((x + y) % 2 ? RED : BLUE)
    const big = image(12, 6, (x, y) => dots(Math.floor(x / 3), Math.floor(y / 3)))
    expect(detectScale(big)).toBe(3)
    const small = scaleDown(big, 3)
    expect([small.width, small.height]).toEqual([4, 2])
    for (let y = 0; y < 2; y++) for (let x = 0; x < 4; x++) expect(rgb(small, x, y)).toBe(dots(x, y))
  })

  it('is 1 for art at its own size, and for a flat image', () => {
    expect(detectScale(image(8, 8, (x) => (x === 3 ? RED : BLUE)))).toBe(1)
    expect(detectScale(image(8, 8, () => RED))).toBe(1)
  })

  it('treats every transparent pixel alike, whatever colour the PNG hides under it', () => {
    const big = image(8, 4, (x) => (x < 4 ? null : RED))
    // Transparent pixels with different hidden RGB must not break the 4× reading.
    big.data[0] = 99
    expect(detectScale(big)).toBe(4)
  })
})

describe('the transparent colour', () => {
  it('keys out the background colour exactly, leaving the art', () => {
    const sheet = image(4, 1, (x) => (x === 1 ? RED : MAGENTA))
    const keyed = applyKey(sheet, MAGENTA)
    expect([0, 1, 2, 3].map((x) => rgb(keyed, x, 0))).toEqual([null, RED, null, null])
    // The original is not touched.
    expect(rgb(sheet, 0, 0)).toBe(MAGENTA)
  })

  it('takes a tolerance for backgrounds saved with noise', () => {
    const sheet = image(2, 1, (x) => (x ? 0xfd02fe : MAGENTA))
    expect(rgb(applyKey(sheet, MAGENTA, 0), 1, 0)).toBe(0xfd02fe)
    expect(rgb(applyKey(sheet, MAGENTA, 3), 1, 0)).toBeNull()
  })

  it('is guessed from the corners of a sheet with no alpha', () => {
    const sheet = image(16, 16, (x, y) => (x > 4 && x < 10 && y > 4 && y < 10 ? RED : MAGENTA))
    expect(detectKey(sheet)).toBe(MAGENTA)
  })

  it('is guessed from the border when a tile in a corner is in the way', () => {
    const sheet = image(16, 16, (x, y) => (x < 3 && y < 3 ? RED : MAGENTA))
    expect(detectKey(sheet)).toBe(MAGENTA)
  })

  it('is not guessed when the PNG has real transparency, or nothing stands out', () => {
    expect(detectKey(image(8, 8, (x) => (x ? RED : null)))).toBeNull()
    expect(detectKey(image(8, 8, (x, y) => [RED, BLUE, MAGENTA, 0x00ff00][(x + y) % 4]))).toBeNull()
  })
})

describe('the grid', () => {
  const grid = (over: Partial<SheetGrid>): SheetGrid => ({ cellWidth: 16, cellHeight: 16, offsetX: 0, offsetY: 0, spacingX: 0, spacingY: 0, ...over })

  it('counts whole cells only, after the margin and between the gaps', () => {
    // 1-dot margin, 16-dot cells, 1-dot gaps: 1 + 16 + 1 + 16 + 1 + 16 = 51.
    expect(gridSize({ width: 51, height: 33 }, grid({ offsetX: 1, spacingX: 1, offsetY: 1, spacingY: 1 }))).toEqual({ cols: 3, rows: 1 })
    expect(gridSize({ width: 52, height: 35 }, grid({ offsetX: 1, spacingX: 1, offsetY: 1, spacingY: 1 }))).toEqual({ cols: 3, rows: 2 })
  })

  it('cuts a cell from its own place, gaps skipped', () => {
    const g = grid({ cellWidth: 2, cellHeight: 2, offsetX: 1, offsetY: 1, spacingX: 1, spacingY: 1 })
    // Cell (1, 1) starts at 1 + 1 * 3 = 4 on both axes.
    const sheet = image(10, 10, (x, y) => (x >= 4 && x < 6 && y >= 4 && y < 6 ? RED : null))
    const { cols } = gridSize(sheet, g)
    expect(cols).toBe(3)
    const cell = cutCell(sheet, g, 1 * cols + 1)
    expect([cell.width, cell.height]).toEqual([2, 2])
    expect([rgb(cell, 0, 0), rgb(cell, 1, 1)]).toEqual([RED, RED])
    expect(isEmpty(cutCell(sheet, g, 0))).toBe(true)
  })

  describe('guessGrid', () => {
    it('reads gutters: 16-dot tiles with 1-dot gaps, opaque art', () => {
      const sheet = image(4 * 17 - 1, 2 * 17 - 1, (x, y) => (x % 17 === 16 || y % 17 === 16 ? null : RED))
      expect(guessGrid(sheet)).toEqual(grid({ spacingX: 1, spacingY: 1 }))
    })

    it('reads gutters with a margin as wide as them', () => {
      const sheet = image(1 + 3 * 17, 1 + 2 * 17, (x, y) => (x % 17 === 0 || y % 17 === 0 ? null : RED))
      expect(guessGrid(sheet)).toEqual(grid({ offsetX: 1, offsetY: 1, spacingX: 1, spacingY: 1 }))
    })

    it('reads frames on a transparent background, not the empty space between them as gutters', () => {
      // Four 32×32 frames, each a 20×24 figure centred in its cell.
      const sheet = image(128, 32, (x, y) => (x % 32 >= 6 && x % 32 < 26 && y >= 4 && y < 28 ? RED : null))
      expect(guessGrid(sheet)).toEqual(grid({ cellWidth: 32, cellHeight: 32 }))
    })

    it('reads gaps around frames of narrow figures, not the space beside each figure', () => {
      // 1-dot margin, 24-dot frames, 2-dot gaps, an 8-dot-wide figure in the middle of each.
      const width = 1 + 4 * 24 + 3 * 2 + 1
      const height = 1 + 2 * 24 + 2 + 1
      const sheet = image(width, height, (x, y) => {
        const fx = (x - 1) % 26
        const fy = (y - 1) % 26
        return x >= 1 && y >= 1 && fx >= 8 && fx < 16 && fy >= 4 && fy < 20 ? RED : null
      })
      expect(guessGrid(sheet)).toEqual(grid({ cellWidth: 24, cellHeight: 24, offsetX: 1, offsetY: 1, spacingX: 2, spacingY: 2 }))
    })

    it('reads a strip of square frames that touch', () => {
      // Figures as wide as their cells, on a transparent background.
      const sheet = image(24 * 5, 24, (x, y) => (y < 2 ? null : x % 2 ? RED : BLUE))
      expect(guessGrid(sheet)).toEqual(grid({ cellWidth: 24, cellHeight: 24 }))
    })

    it('falls back to 16-dot tiles on an opaque tileset', () => {
      expect(guessGrid(image(128, 64, (x, y) => ((x * 7 + y * 3) % 5 ? RED : BLUE)))).toEqual(grid({}))
    })
  })
})

describe('cells into one picture and back', () => {
  it('lays cells side by side and splits the converted indices the same way', () => {
    const a = image(2, 2, () => RED)
    const b = image(2, 2, () => BLUE)
    const strip = stripOf([a, b])
    expect([strip.width, strip.height]).toEqual([4, 2])
    expect([rgb(strip, 1, 1), rgb(strip, 2, 0)]).toEqual([RED, BLUE])
    const indices = Uint8Array.from([1, 1, 2, 2, 1, 1, 2, 2])
    expect(splitStrip(indices, 2, 2, 2).map((cell) => [...cell])).toEqual([
      [1, 1, 1, 1],
      [2, 2, 2, 2]
    ])
  })

  it('finds one box around the content of every frame', () => {
    const one = image(8, 8, (x, y) => (x === 2 && y === 3 ? RED : null))
    const two = image(8, 8, (x, y) => (x === 5 && y === 6 ? RED : null))
    expect(contentBox([one, two])).toEqual({ x: 2, y: 3, width: 4, height: 4 })
    expect(contentBox([image(4, 4, () => null)])).toBeNull()
  })

  it('snaps a trim to the tile grid of the cell, so art stays on its tiles', () => {
    // A 9×9 coin at (4,4) in a 16×16 cell keeps all four tiles; one in the
    // top-left quarter only keeps that tile.
    expect(snapBox({ x: 4, y: 4, width: 9, height: 9 }, 8, 16, 16)).toEqual({ x: 0, y: 0, width: 16, height: 16 })
    expect(snapBox({ x: 2, y: 1, width: 5, height: 6 }, 8, 16, 16)).toEqual({ x: 0, y: 0, width: 8, height: 8 })
    // A cell that is not a whole number of tiles is never grown past itself.
    expect(snapBox({ x: 9, y: 0, width: 3, height: 4 }, 8, 12, 12)).toEqual({ x: 8, y: 0, width: 4, height: 8 })
  })
})

describe('selection', () => {
  it('a dragged rectangle and a shift-click range, in reading order', () => {
    expect(cellsInRect(7, 1, 5)).toEqual([1, 2, 6, 7])
    expect(cellsInRange(7, 4)).toEqual([4, 5, 6, 7])
  })

  it('splits by sheet row, and bounds a selection', () => {
    expect(rowsOf([7, 0, 6, 1], 5)).toEqual([
      [0, 1],
      [6, 7]
    ])
    expect(selectionRect([7, 0, 6, 1], 5)).toEqual({ col: 0, row: 0, cols: 3, rows: 2 })
    expect(selectionRect([], 5)).toBeNull()
  })
})
