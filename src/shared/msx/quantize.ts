/**
 * RGBA → indexed conversion for the import dialogs: a fixed or median-cut
 * palette, optional dithering, and the hardware **constraint-fit** passes
 * (two colors per 8×1 span for sc1/sc2/sc4). Everything is deterministic —
 * same input, same bytes — and reports what it had to give up.
 *
 * Pure math, no DOM: the renderer hands it an `ImageData`, Vitest hands it a
 * hand-built RGBA buffer.
 */

import { MODES, type ScreenMode } from './modes'
import { colorDistance, grbToRgb, MSX1_PALETTE_RGB, nearestColor, rgbToGrb, type Rgb } from './palette'

export type DitherMode = 'none' | 'bayer4' | 'floyd'
/** 'msx1' = the fixed TMS9918A palette · 'optimized' = median cut · an array locks explicit GRB333 entries. */
export type PaletteChoice = 'msx1' | 'optimized' | number[]

export interface RgbaImage {
  width: number
  height: number
  /** RGBA bytes, 4 per pixel. */
  data: Uint8ClampedArray | Uint8Array
}

export interface QuantizeOptions {
  mode: ScreenMode
  palette?: PaletteChoice
  dither?: DitherMode
  /** Overrides the mode's color count (e.g. 15 to keep index 0 free). */
  colors?: number
  /** Keep palette index 0 for transparency: alpha < 128 maps there and no opaque pixel does. */
  reserveTransparent?: boolean
  /** Ordered/error-diffusion amplitude in 8-bit units. */
  ditherStrength?: number
}

export interface LossReport {
  /** Distinct palette indices present in the output. */
  colorsUsed: number
  /** Distinct source colors that ended up sharing a palette entry. */
  colorsMerged: number
  /** 8×1 spans the constraint-fit pass had to reduce (row-constrained modes only). */
  rowsAltered: number
  /** Pixels the constraint-fit pass moved to a different color. */
  pixelsChanged: number
}

export interface QuantizeResult {
  width: number
  height: number
  /** One palette index per pixel, row-major. */
  indices: Uint8Array
  /** Packed GRB333 entries, or null when the mode's palette is fixed in hardware. */
  palette: number[] | null
  /** The same palette as RGB, for canvas preview. */
  rgb: Rgb[]
  report: LossReport
}

export const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5]
]

/** SCREEN 8's fixed 256 colors: `[G:3|R:3|B:2]`, exactly MSXgl's `RGB8()`. */
export function rgb332Palette(): Rgb[] {
  const level = (value: number, bits: number): number => Math.round((value * 255) / ((1 << bits) - 1))
  return Array.from({ length: 256 }, (_, i) => ({
    r: level((i >> 2) & 7, 3),
    g: level((i >> 5) & 7, 3),
    b: level(i & 3, 2)
  }))
}

// ── median cut ──────────────────────────────────────────────────────────────

interface Box {
  colors: { color: Rgb; count: number }[]
  range: number
  channel: 'r' | 'g' | 'b'
}

function measure(colors: { color: Rgb; count: number }[]): { range: number; channel: 'r' | 'g' | 'b' } {
  const min = { r: 255, g: 255, b: 255 }
  const max = { r: 0, g: 0, b: 0 }
  for (const { color } of colors) {
    for (const channel of ['r', 'g', 'b'] as const) {
      if (color[channel] < min[channel]) min[channel] = color[channel]
      if (color[channel] > max[channel]) max[channel] = color[channel]
    }
  }
  // Weighted like the luma coefficients so a green ramp splits before a blue one.
  const spans: [number, 'r' | 'g' | 'b'][] = [
    [(max.r - min.r) * 30, 'r'],
    [(max.g - min.g) * 59, 'g'],
    [(max.b - min.b) * 11, 'b']
  ]
  spans.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]))
  return { range: spans[0][0], channel: spans[0][1] }
}

/** Classic median cut over the image histogram. Deterministic: ties break on channel/value order. */
export function medianCut(histogram: Map<number, number>, count: number): Rgb[] {
  const entries = [...histogram.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([key, n]) => ({ color: { r: (key >> 16) & 0xff, g: (key >> 8) & 0xff, b: key & 0xff }, count: n }))
  if (!entries.length) return [{ r: 0, g: 0, b: 0 }]

  const boxes: Box[] = [{ colors: entries, ...measure(entries) }]
  while (boxes.length < count) {
    // Split the box with the widest weighted span; stop when nothing can be split.
    let target = -1
    let best = 0
    boxes.forEach((box, index) => {
      if (box.colors.length > 1 && box.range > best) {
        best = box.range
        target = index
      }
    })
    if (target === -1) break

    const box = boxes[target]
    const sorted = box.colors.slice().sort((a, b) => a.color[box.channel] - b.color[box.channel])
    const total = sorted.reduce((sum, entry) => sum + entry.count, 0)
    let running = 0
    let split = 0
    for (; split < sorted.length - 1; split++) {
      running += sorted[split].count
      if (running * 2 >= total) break
    }
    // When one color holds more than half the pixels the median never lands
    // before the end — clamp so both halves stay non-empty and the box count
    // really does grow every iteration.
    split = Math.min(split, sorted.length - 2)
    const left = sorted.slice(0, split + 1)
    const right = sorted.slice(split + 1)
    boxes.splice(target, 1, { colors: left, ...measure(left) }, { colors: right, ...measure(right) })
  }

  return boxes.map(({ colors }) => {
    let total = 0
    let r = 0
    let g = 0
    let b = 0
    for (const entry of colors) {
      total += entry.count
      r += entry.color.r * entry.count
      g += entry.color.g * entry.count
      b += entry.color.b * entry.count
    }
    return { r: Math.round(r / total), g: Math.round(g / total), b: Math.round(b / total) }
  })
}

// ── palette resolution ──────────────────────────────────────────────────────

function histogramOf(image: RgbaImage): Map<number, number> {
  const histogram = new Map<number, number>()
  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i + 3] < 128) continue
    const key = (image.data[i] << 16) | (image.data[i + 1] << 8) | image.data[i + 2]
    histogram.set(key, (histogram.get(key) ?? 0) + 1)
  }
  return histogram
}

interface ResolvedPalette {
  rgb: Rgb[]
  /** Packed GRB333, or null when the hardware palette is fixed. */
  grb: number[] | null
}

function resolvePalette(image: RgbaImage, options: Required<QuantizeOptions>): ResolvedPalette {
  const info = MODES[options.mode]
  if (info.palette === 'rgb332' || info.palette === 'yjk') return { rgb: rgb332Palette(), grb: null }
  if (info.palette === 'fixed' || options.palette === 'msx1') return { rgb: [...MSX1_PALETTE_RGB], grb: null }

  if (Array.isArray(options.palette)) {
    const grb = options.palette.slice(0, options.colors)
    return { rgb: grb.map(grbToRgb), grb }
  }

  // Optimized: median-cut, then snap every entry onto the 512-color grid the
  // V9938 can actually show. Two boxes can land on the same entry — dedupe so
  // the reported palette really is what the hardware will hold.
  const wanted = options.reserveTransparent ? options.colors - 1 : options.colors
  const cut = medianCut(histogramOf(image), Math.max(1, wanted))
  const grb: number[] = options.reserveTransparent ? [0] : []
  for (const color of cut) {
    const packed = rgbToGrb(color)
    if (!grb.includes(packed)) grb.push(packed)
  }
  while (grb.length < options.colors) grb.push(grb[grb.length - 1] ?? 0)
  return { rgb: grb.map(grbToRgb), grb }
}

// ── main entry ──────────────────────────────────────────────────────────────

export function quantize(image: RgbaImage, options: QuantizeOptions): QuantizeResult {
  const info = MODES[options.mode]
  const settings: Required<QuantizeOptions> = {
    mode: options.mode,
    palette: options.palette ?? 'optimized',
    dither: options.dither ?? 'none',
    colors: options.colors ?? Math.min(256, info.colors),
    reserveTransparent: options.reserveTransparent ?? info.palette !== 'rgb332',
    ditherStrength: options.ditherStrength ?? 32
  }
  const { rgb, grb } = resolvePalette(image, settings)
  const skip = settings.reserveTransparent && rgb.length > 1 ? [0] : []

  const { width, height } = image
  const indices = new Uint8Array(width * height)
  const error = settings.dither === 'floyd' ? new Float32Array(width * height * 3) : null
  const sources = new Map<number, Set<number>>()

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = (y * width + x) * 4
      if (image.data[pixel + 3] < 128 && settings.reserveTransparent) {
        indices[y * width + x] = 0
        continue
      }
      let r = image.data[pixel]
      let g = image.data[pixel + 1]
      let b = image.data[pixel + 2]
      const key = (r << 16) | (g << 8) | b

      if (settings.dither === 'bayer4') {
        const bias = (BAYER4[y & 3][x & 3] / 16 - 0.5) * settings.ditherStrength
        r += bias
        g += bias
        b += bias
      } else if (error) {
        const at = (y * width + x) * 3
        r += error[at]
        g += error[at + 1]
        b += error[at + 2]
      }

      const wanted = { r: clamp(r), g: clamp(g), b: clamp(b) }
      const index = nearestColor(wanted, rgb, skip)
      indices[y * width + x] = index

      const set = sources.get(index) ?? new Set<number>()
      set.add(key)
      sources.set(index, set)

      if (error) diffuse(error, width, height, x, y, wanted, rgb[index])
    }
  }

  const report: LossReport = {
    colorsUsed: new Set(indices).size,
    colorsMerged: [...sources.values()].reduce((sum, set) => sum + Math.max(0, set.size - 1), 0),
    rowsAltered: 0,
    pixelsChanged: 0
  }

  if (info.colorModel === 'row2' || info.colorModel === 'group2') {
    const fit = fitRowConstraint(indices, width, height, rgb)
    report.rowsAltered = fit.rowsAltered
    report.pixelsChanged = fit.pixelsChanged
    report.colorsUsed = new Set(indices).size
  }

  return { width, height, indices, palette: grb, rgb, report }
}

function clamp(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value)
}

/** Floyd–Steinberg: 7/16 right, 3/16 down-left, 5/16 down, 1/16 down-right. */
function diffuse(
  error: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
  wanted: Rgb,
  got: Rgb
): void {
  const dr = wanted.r - got.r
  const dg = wanted.g - got.g
  const db = wanted.b - got.b
  const spread = (dx: number, dy: number, weight: number): void => {
    const nx = x + dx
    const ny = y + dy
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) return
    const at = (ny * width + nx) * 3
    error[at] += dr * weight
    error[at + 1] += dg * weight
    error[at + 2] += db * weight
  }
  spread(1, 0, 7 / 16)
  spread(-1, 1, 3 / 16)
  spread(0, 1, 5 / 16)
  spread(1, 1, 1 / 16)
}

/**
 * Constraint fit for the pattern modes: every 8-pixel span on every scanline
 * keeps at most two colors — the two most-used — and every other pixel moves
 * to whichever survivor is closer in RGB. Mutates `indices` in place and
 * reports what changed, which is what the import dialog shows as "lossy rows".
 */
export function fitRowConstraint(
  indices: Uint8Array,
  width: number,
  height: number,
  rgb: readonly Rgb[]
): { rowsAltered: number; pixelsChanged: number } {
  let rowsAltered = 0
  let pixelsChanged = 0

  for (let y = 0; y < height; y++) {
    for (let x = 0; x + 8 <= width; x += 8) {
      const counts = new Map<number, number>()
      for (let i = 0; i < 8; i++) {
        const value = indices[y * width + x + i]
        counts.set(value, (counts.get(value) ?? 0) + 1)
      }
      if (counts.size <= 2) continue

      const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([value]) => value)
      const [keepA, keepB] = ranked
      for (let i = 0; i < 8; i++) {
        const at = y * width + x + i
        const value = indices[at]
        if (value === keepA || value === keepB) continue
        const a = colorDistance(rgb[value] ?? rgb[0], rgb[keepA] ?? rgb[0])
        const b = colorDistance(rgb[value] ?? rgb[0], rgb[keepB] ?? rgb[0])
        indices[at] = a <= b ? keepA : keepB
        pixelsChanged++
      }
      rowsAltered++
    }
  }
  return { rowsAltered, pixelsChanged }
}
