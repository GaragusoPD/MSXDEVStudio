/**
 * Asset sheets — the PNGs of tiles or animation frames that packs ship as —
 * cut into cells.
 *
 * A sheet is a grid: cells of one size, often after a margin and with a gap
 * between them, often drawn at 2× or 3× the size they are meant to be shown
 * at, and often on a flat background colour instead of real transparency.
 * Everything here works on RGBA, before the quantizer: the transparent colour
 * becomes alpha 0, which the quantizer already sends to index 0, so every
 * converter downstream treats a keyed pixel exactly as a transparent PNG
 * pixel.
 *
 * Pure and DOM-free, like the rest of `shared/msx`.
 */

import type { RgbaImage } from './quantize'

/** Where the cells are, in MSX dots — after `scaleDown`. */
export interface SheetGrid {
  cellWidth: number
  cellHeight: number
  /** Dots before the first cell. */
  offsetX: number
  offsetY: number
  /** Dots between two cells. */
  spacingX: number
  spacingY: number
}

export const DEFAULT_GRID: SheetGrid = { cellWidth: 16, cellHeight: 16, offsetX: 0, offsetY: 0, spacingX: 0, spacingY: 0 }

/** The largest pixel scale `detectScale` reports — past that it is not pixel art at 1:1 any more. */
export const MAX_SCALE = 8

/** An RGB colour packed as 0xRRGGBB. */
export type PackedRgb = number

const OPAQUE = 128

function blank(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) }
}

const opaqueAt = (image: RgbaImage, i: number): boolean => image.data[i * 4 + 3] >= OPAQUE

const rgbAt = (image: RgbaImage, i: number): PackedRgb =>
  (image.data[i * 4] << 16) | (image.data[i * 4 + 1] << 8) | image.data[i * 4 + 2]

/** One value per pixel that is equal exactly when two pixels look the same: any transparent pixel is -1. */
function lookAt(image: RgbaImage, i: number): number {
  return opaqueAt(image, i) ? rgbAt(image, i) : -1
}

/** Every `scale × scale` block becomes one dot, read from its top-left pixel. */
export function scaleDown(image: RgbaImage, scale: number): RgbaImage {
  const s = Math.max(1, Math.floor(scale))
  if (s === 1) return image
  const width = Math.floor(image.width / s)
  const height = Math.floor(image.height / s)
  const out = blank(width, height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = ((y * s) * image.width + x * s) * 4
      const to = (y * width + x) * 4
      for (let c = 0; c < 4; c++) out.data[to + c] = image.data[from + c]
    }
  }
  return out
}

/**
 * The image with every pixel of `key` made transparent — within `tolerance` on
 * each channel, for sheets saved with a little noise in their background.
 * Pixels that were already transparent stay so; `key` null changes nothing.
 */
export function applyKey(image: RgbaImage, key: PackedRgb | null, tolerance = 0): RgbaImage {
  if (key === null) return image
  const kr = (key >> 16) & 0xff
  const kg = (key >> 8) & 0xff
  const kb = key & 0xff
  const out: RgbaImage = { width: image.width, height: image.height, data: Uint8ClampedArray.from(image.data) }
  for (let i = 0; i < image.width * image.height; i++) {
    const p = i * 4
    if (
      Math.abs(out.data[p] - kr) <= tolerance &&
      Math.abs(out.data[p + 1] - kg) <= tolerance &&
      Math.abs(out.data[p + 2] - kb) <= tolerance
    ) {
      out.data[p + 3] = 0
    }
  }
  return out
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b]
  return a
}

/**
 * How many sheet pixels make one dot: the largest scale every colour change
 * in the image lines up with. Art drawn at 1:1 has changes at odd positions
 * and comes back 1; art saved at 3× changes only every third pixel.
 */
export function detectScale(image: RgbaImage): number {
  let g = 0
  const { width, height } = image
  for (let y = 0; y < height && g !== 1; y++) {
    for (let x = 1; x < width; x++) {
      if (lookAt(image, y * width + x) !== lookAt(image, y * width + x - 1)) {
        g = gcd(g, x)
        if (g === 1) break
      }
    }
  }
  for (let x = 0; x < width && g !== 1; x++) {
    for (let y = 1; y < height; y++) {
      if (lookAt(image, y * width + x) !== lookAt(image, (y - 1) * width + x)) {
        g = gcd(g, y)
        if (g === 1) break
      }
    }
  }
  return g === 0 ? 1 : Math.min(g, MAX_SCALE)
}

/** True when any pixel is transparent in the PNG itself. */
export function hasAlpha(image: RgbaImage): boolean {
  for (let i = 0; i < image.width * image.height; i++) if (!opaqueAt(image, i)) return true
  return false
}

/**
 * The colour a sheet with no transparency is most likely drawn on: the one all
 * four corners share, or failing that one that fills at least half the border.
 * Null when the image has real transparency, or no colour stands out.
 */
export function detectKey(image: RgbaImage): PackedRgb | null {
  const { width, height } = image
  if (!width || !height || hasAlpha(image)) return null
  const corners = [0, width - 1, (height - 1) * width, height * width - 1].map((i) => rgbAt(image, i))
  if (corners.every((color) => color === corners[0])) return corners[0]
  const counts = new Map<PackedRgb, number>()
  let border = 0
  const count = (i: number): void => {
    const color = rgbAt(image, i)
    counts.set(color, (counts.get(color) ?? 0) + 1)
    border++
  }
  for (let x = 0; x < width; x++) {
    count(x)
    if (height > 1) count((height - 1) * width + x)
  }
  for (let y = 1; y < height - 1; y++) {
    count(y * width)
    if (width > 1) count(y * width + width - 1)
  }
  const [color, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [0, 0]
  return n * 2 >= border ? color : null
}

/** How many whole cells the grid fits across and down. */
export function gridSize(size: { width: number; height: number }, grid: SheetGrid): { cols: number; rows: number } {
  const across = (length: number, offset: number, cell: number, spacing: number): number =>
    cell > 0 ? Math.max(0, Math.floor((length - offset + spacing) / (cell + spacing))) : 0
  return {
    cols: across(size.width, grid.offsetX, grid.cellWidth, grid.spacingX),
    rows: across(size.height, grid.offsetY, grid.cellHeight, grid.spacingY)
  }
}

/** Top-left dot of cell (`col`, `row`). */
export function cellOrigin(grid: SheetGrid, col: number, row: number): { x: number; y: number } {
  return { x: grid.offsetX + col * (grid.cellWidth + grid.spacingX), y: grid.offsetY + row * (grid.cellHeight + grid.spacingY) }
}

/** A `width × height` piece of `image` at (`x`, `y`); anything outside it is transparent. */
export function cropImage(image: RgbaImage, x: number, y: number, width: number, height: number): RgbaImage {
  const out = blank(width, height)
  for (let dy = 0; dy < height; dy++) {
    const sy = y + dy
    if (sy < 0 || sy >= image.height) continue
    for (let dx = 0; dx < width; dx++) {
      const sx = x + dx
      if (sx < 0 || sx >= image.width) continue
      const from = (sy * image.width + sx) * 4
      const to = (dy * width + dx) * 4
      for (let c = 0; c < 4; c++) out.data[to + c] = image.data[from + c]
    }
  }
  return out
}

/** Cell `index` of the grid, in reading order. */
export function cutCell(image: RgbaImage, grid: SheetGrid, index: number): RgbaImage {
  const { cols } = gridSize(image, grid)
  const col = cols ? index % cols : 0
  const row = cols ? Math.floor(index / cols) : 0
  const { x, y } = cellOrigin(grid, col, row)
  return cropImage(image, x, y, grid.cellWidth, grid.cellHeight)
}

/** True when the cell has nothing in it. */
export function isEmpty(image: RgbaImage): boolean {
  for (let i = 0; i < image.width * image.height; i++) if (opaqueAt(image, i)) return false
  return true
}

/**
 * The one box that holds the content of every image — all the same size — so
 * frames cut to it stay aligned with each other. Null when all are empty.
 */
export function contentBox(images: readonly RgbaImage[]): { x: number; y: number; width: number; height: number } | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -1
  let y1 = -1
  for (const image of images) {
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        if (!opaqueAt(image, y * image.width + x)) continue
        x0 = Math.min(x0, x)
        y0 = Math.min(y0, y)
        x1 = Math.max(x1, x)
        y1 = Math.max(y1, y)
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }
}

/**
 * `box` grown outward to the `step`-dot grid of its cell (`stepY` down, for a
 * tile that is not square), clipped to the cell — a trim that keeps art on the
 * tile grid it was drawn on, so a 16×16 coin trimmed for a meta-tile is still
 * the same four tiles, not shifted into the corner of new ones.
 */
export function snapBox(
  box: { x: number; y: number; width: number; height: number },
  step: number,
  cellWidth: number,
  cellHeight: number,
  stepY = step
): { x: number; y: number; width: number; height: number } {
  const x = Math.floor(box.x / step) * step
  const y = Math.floor(box.y / stepY) * stepY
  return {
    x,
    y,
    width: Math.min(cellWidth, Math.ceil((box.x + box.width) / step) * step) - x,
    height: Math.min(cellHeight, Math.ceil((box.y + box.height) / stepY) * stepY) - y
  }
}

/** Rounds `n` up to a multiple of `step`. */
export function roundUp(n: number, step: number): number {
  return Math.ceil(n / step) * step
}

/**
 * The images side by side, left to right — one picture the quantizer converts
 * in one go, so every cell shares one palette. All must be the same size.
 */
export function stripOf(images: readonly RgbaImage[]): RgbaImage {
  const width = images[0]?.width ?? 0
  const height = images[0]?.height ?? 0
  const out = blank(width * images.length, height)
  images.forEach((image, n) => {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const from = (y * width + x) * 4
        const to = (y * out.width + n * width + x) * 4
        for (let c = 0; c < 4; c++) out.data[to + c] = image.data[from + c]
      }
    }
  })
  return out
}

/** `stripOf` undone on the converted indices: one row-major index grid per cell. */
export function splitStrip(indices: ArrayLike<number>, cellWidth: number, cellHeight: number, count: number): Uint8Array[] {
  const stride = cellWidth * count
  return Array.from({ length: count }, (_, n) => {
    const out = new Uint8Array(cellWidth * cellHeight)
    for (let y = 0; y < cellHeight; y++) {
      for (let x = 0; x < cellWidth; x++) out[y * cellWidth + x] = indices[y * stride + n * cellWidth + x] ?? 0
    }
    return out
  })
}

// ── guessing the grid ───────────────────────────────────────────────────────

/** Common cell sizes, largest first — what a sheet with nothing better to go on is cut at. */
const CELL_SIZES = [64, 48, 32, 24, 16, 8]

/**
 * One axis of the grid, from which lines of the image are entirely transparent
 * (`empty`), in order of how much each reading can be trusted:
 *
 * 1. Frames on a transparent background, edge to edge: the smallest common
 *    cell size that divides the length with every boundary between two cells
 *    on empty lines. (Smallest, because every multiple of it passes too.)
 * 2. Gutters: a period whose every gap falls on empty lines, filling the length
 *    exactly (or with the same margin at both ends). Of those, the one with
 *    something in the most of its cells — on a transparent background the
 *    empty space beside a narrow figure passes for gutters too, but cuts cells
 *    with nothing in them — then the most gaps, then the same margin at both
 *    ends and the content centred in its cells, which is how packs are laid
 *    out and what tells a grid apart from the same grid shifted into the
 *    empty space around its figures.
 * 3. A strip of square frames — `square` is the other axis's length, given
 *    only for a sheet with transparency: an opaque 2:1 tileset is not two
 *    frames.
 * 4. The most common tile size that divides the length.
 */
function guessAxis(length: number, empty: boolean[], square: number | null): { cell: number; offset: number; spacing: number } {
  for (const cell of [...CELL_SIZES].reverse()) {
    if (length % cell !== 0 || length / cell < 2) continue
    let clear = true
    for (let boundary = cell; boundary < length && clear; boundary += cell) clear = empty[boundary - 1] && empty[boundary]
    if (clear) return { cell, offset: 0, spacing: 0 }
  }
  let best: { cell: number; offset: number; spacing: number; score: number } | null = null
  for (let spacing = 1; spacing <= 4; spacing++) {
    for (let offset = 0; offset <= 8; offset++) {
      for (let cell = 8; cell <= Math.min(128, length); cell++) {
        let gutters = 0
        let valid = true
        // A gap only counts with a whole cell after it; what follows the last
        // cell is the far margin.
        for (let start = offset + cell; start + spacing + cell <= length; start += cell + spacing) {
          for (let i = start; i < start + spacing; i++) if (!empty[i]) valid = false
          if (!valid) break
          gutters++
        }
        if (!valid || gutters < 1) continue
        const rest = length - offset - (gutters + 1) * cell - gutters * spacing
        if (rest !== 0 && rest !== offset) continue
        let filled = 0
        let offCentre = 0
        for (let k = 0; k <= gutters; k++) {
          const lines = empty.slice(offset + k * (cell + spacing), offset + k * (cell + spacing) + cell)
          const first = lines.indexOf(false)
          if (first < 0) continue
          filled++
          offCentre += Math.abs(first - (cell - 1 - lines.lastIndexOf(false))) / cell
        }
        if (!filled) continue
        const score =
          (filled / (gutters + 1)) * 100 + gutters * 2 + (cell % 8 === 0 ? 1 : 0) + (rest === offset ? 3 : 0) - (offCentre / filled) * 2
        if (!best || score > best.score) best = { cell, offset, spacing, score }
      }
    }
  }
  if (best) return { cell: best.cell, offset: best.offset, spacing: best.spacing }
  if (square && square >= 8 && square <= 128 && length % square === 0 && length / square >= 2) {
    return { cell: square, offset: 0, spacing: 0 }
  }
  const tile = length % 16 === 0 ? 16 : (CELL_SIZES.find((size) => length % size === 0) ?? 16)
  return { cell: tile, offset: 0, spacing: 0 }
}

/**
 * A first guess at the grid of a sheet already scaled down and keyed. Good
 * for the common packs — square tiles, gutters of a dot or two, single-row
 * animation strips — and only ever a starting point in the dialog.
 */
export function guessGrid(image: RgbaImage): SheetGrid {
  const { width, height } = image
  const emptyCol = Array.from({ length: width }, (_, x) => {
    for (let y = 0; y < height; y++) if (opaqueAt(image, y * width + x)) return false
    return true
  })
  const emptyRow = Array.from({ length: height }, (_, y) => {
    for (let x = 0; x < width; x++) if (opaqueAt(image, y * width + x)) return false
    return true
  })
  // A strip of square frames: one row as tall as each frame is wide.
  const transparent = emptyCol.some(Boolean) || hasAlpha(image)
  const across = guessAxis(width, emptyCol, transparent && height <= 128 ? height : null)
  const down = guessAxis(height, emptyRow, null)
  // A single-row strip guessed square across is one cell tall.
  const strip = across.spacing === 0 && across.cell === height && down.spacing === 0
  return {
    cellWidth: across.cell,
    cellHeight: strip ? height : down.cell,
    offsetX: across.offset,
    offsetY: strip ? 0 : down.offset,
    spacingX: across.spacing,
    spacingY: strip ? 0 : down.spacing
  }
}

// ── selection ───────────────────────────────────────────────────────────────

/** Every cell index in the rectangle spanned by cells `a` and `b`, in reading order. */
export function cellsInRect(a: number, b: number, cols: number): number[] {
  if (cols <= 0) return []
  const [c0, c1] = [a % cols, b % cols].sort((p, q) => p - q)
  const [r0, r1] = [Math.floor(a / cols), Math.floor(b / cols)].sort((p, q) => p - q)
  const out: number[] = []
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push(r * cols + c)
  return out
}

/** Every cell from `a` to `b` inclusive in reading order — a shift-click range. */
export function cellsInRange(a: number, b: number): number[] {
  const [from, to] = a <= b ? [a, b] : [b, a]
  return Array.from({ length: to - from + 1 }, (_, i) => from + i)
}

/** The selection split by sheet row, each row in reading order — for *one per row*. */
export function rowsOf(cells: readonly number[], cols: number): number[][] {
  const rows = new Map<number, number[]>()
  for (const cell of [...cells].sort((a, b) => a - b)) {
    const row = Math.floor(cell / Math.max(1, cols))
    rows.set(row, [...(rows.get(row) ?? []), cell])
  }
  return [...rows.keys()].sort((a, b) => a - b).map((row) => rows.get(row)!)
}

/**
 * The bounding rectangle of a selection, in cells — what a map gets: the
 * selection laid out as on the sheet, without the gaps between cells.
 */
export function selectionRect(cells: readonly number[], cols: number): { col: number; row: number; cols: number; rows: number } | null {
  if (!cells.length || cols <= 0) return null
  const xs = cells.map((cell) => cell % cols)
  const ys = cells.map((cell) => Math.floor(cell / cols))
  const col = Math.min(...xs)
  const row = Math.min(...ys)
  return { col, row, cols: Math.max(...xs) - col + 1, rows: Math.max(...ys) - row + 1 }
}
