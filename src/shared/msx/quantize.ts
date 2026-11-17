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
  /**
   * With an array palette: the entries the conversion may *replace* — the
   * ones nothing already drawn uses. They are filled from the picture's own
   * colours (`sharePalette`), every other entry is kept exactly. How several
   * pictures share one screen's sixteen colours without recolouring each other.
   */
  freeEntries?: number[]
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
    const locked = options.palette.slice(0, options.colors)
    const grb = options.freeEntries.length ? sharePalette(image, locked, options.freeEntries) : locked
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

/**
 * `palette` with its `free` entries refilled from `image`: a median cut of the
 * picture's colours that no kept entry already holds exactly, snapped to
 * GRB333 and deduplicated. Every other entry comes back untouched, so a pixel
 * already drawn with one keeps its colour. Free entries the picture does not
 * need are left as they were. Index 0 is never free: it is the transparent one.
 */
export function sharePalette(image: RgbaImage, palette: readonly number[], free: readonly number[]): number[] {
  const out = palette.slice()
  const slots = [...new Set(free)].filter((index) => index > 0 && index < out.length).sort((a, b) => a - b)
  if (!slots.length) return out
  const kept = new Set(out.filter((_, index) => !slots.includes(index)))
  const wanted = new Map<number, number>()
  for (const [key, count] of histogramOf(image)) {
    const packed = rgbToGrb({ r: (key >> 16) & 0xff, g: (key >> 8) & 0xff, b: key & 0xff })
    if (!kept.has(packed)) wanted.set(key, count)
  }
  if (!wanted.size) return out
  const added: number[] = []
  for (const color of medianCut(wanted, slots.length)) {
    const packed = rgbToGrb(color)
    if (!kept.has(packed) && !added.includes(packed)) added.push(packed)
  }
  added.forEach((packed, i) => (out[slots[i]] = packed))
  return out
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
    ditherStrength: options.ditherStrength ?? 32,
    freeEntries: options.freeEntries ?? []
  }
  const { rgb, grb } = resolvePalette(image, settings)
  const skip = settings.reserveTransparent && rgb.length > 1 ? [0] : []

  // Two colours per 8×1 span: the pair is chosen from the picture itself, not
  // cut afterwards out of a free sixteen-colour result (see `fitSpans`).
  if (info.colorModel === 'row2' || info.colorModel === 'group2') {
    const fitted = fitSpans(image, rgb, skip, settings)
    return { width: image.width, height: image.height, indices: fitted.indices, palette: grb, rgb, report: fitted.report }
  }

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

  return { width, height, indices, palette: grb, rgb, report }
}

// ── perceptual colour (OKLab) ───────────────────────────────────────────────

export interface Lab {
  L: number
  a: number
  b: number
  /** Chroma, `hypot(a, b)`: how far from gray. Kept because `labDistance` needs it for every pair it compares. */
  C: number
}

/** sRGB 0-255 → linear light 0-1, on the way to OKLab. */
export function srgbToLinear(value: number): number {
  const c = value / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** Linear light → OKLab (Björn Ottosson's), where equal distances look about equally different. */
export function linearToOklab(r: number, g: number, b: number): Lab {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return { L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, a, b: bb, C: Math.sqrt(a * a + bb * bb) }
}

export function rgbToOklab(color: Rgb): Lab {
  return linearToOklab(srgbToLinear(color.r), srgbToLinear(color.g), srgbToLinear(color.b))
}

/**
 * How much more a wrong hue costs than a wrong lightness. The MSX1 palette has
 * nothing between black and a lightness of 0.54 (dark blue), and no mid gray,
 * dark green, dark yellow or brown, so most of a picture falls between entries.
 * Weighted 1 (plain OKLab, or the luma-weighted RGB this replaced), a dark
 * green or a mid gray goes to whichever entry has the closest *lightness*,
 * which is a blue or a red, and the whole picture turns blue.
 */
export const HUE_WEIGHT = 4

/**
 * And what colour costs on top when the source is a **gray**: a gray that comes
 * out red or blue is the most visible error there is. It fades out by
 * `GRAY_CHROMA`, so a dull colour (an olive tentacle, a worn gold) still picks
 * its own hue rather than whichever entry is least saturated. Together with
 * `HUE_WEIGHT`: grays stay black, gray or white, browns warm, olives green.
 */
export const GRAY_KEEP = 4
/** The OKLab chroma below which a source counts as gray, more so the closer to 0. */
const GRAY_CHROMA = 0.04

/** `p` the source colour, `q` a palette entry: not symmetric, see `GRAY_KEEP`. */
export function labDistance(p: Lab, q: Lab): number {
  const dL = p.L - q.L
  const da = p.a - q.a
  const db = p.b - q.b
  const distance = dL * dL + HUE_WEIGHT * (da * da + db * db)
  if (p.C >= GRAY_CHROMA) return distance
  const gray = 1 - p.C / GRAY_CHROMA
  return distance + GRAY_KEEP * gray * q.C * q.C
}

/** Gamma-encoded 0-1 → linear, tabulated: the pair search converts every candidate mix of every span. */
const LINEAR_STEPS = 4096
const LINEAR_TABLE = Float32Array.from({ length: LINEAR_STEPS + 1 }, (_, i) => srgbToLinear((i * 255) / LINEAR_STEPS))

/** Gamma-encoded 0-1 → OKLab. Dithering mixes in this space: see `fitSpans`. */
function gammaToOklab(r: number, g: number, b: number): Lab {
  return linearToOklab(
    LINEAR_TABLE[Math.round(r * LINEAR_STEPS)],
    LINEAR_TABLE[Math.round(g * LINEAR_STEPS)],
    LINEAR_TABLE[Math.round(b * LINEAR_STEPS)]
  )
}

/**
 * What a dithered mix of two colours costs beyond its error: a pattern of two
 * far-apart colours (red dots on green for a brown) reads as noise, not as the
 * colour between them, so a pair is charged for how far apart it is, most at an
 * even mix. Small enough that black and white still make a mid gray.
 */
const MIX_NOISE = 0.15

// ── the two-colours-per-span fit (SCREEN 1/2/4) ─────────────────────────────

interface Pair {
  a: number
  b: number
}

/**
 * Converts a picture for a pattern mode, where every 8×1 span shows at most two
 * colours: each span gets the **pair of palette entries that best reproduces
 * its own source pixels**, and each pixel then takes one of the two.
 *
 * The old way matched every pixel to its nearest of all sixteen first and only
 * then cut each span down to its two most frequent results (`fitRowConstraint`).
 * That lost twice: the nearest entry was often a wrong hue, and the cut kept
 * whichever wrong hue was most common, so a picture came out in four or five
 * colours. Dithering made it worse: the error spread over all sixteen colours,
 * and the cut left a rainbow speckle.
 *
 * - `none`: the pair that minimises each pixel's distance to the nearer of the two.
 * - `floyd`: the pair whose *mixes* come closest (a pixel between black and
 *   white is a mid gray, not an error), then Floyd–Steinberg between those two
 *   only, so the dither survives the constraint.
 * - `bayer4`: the same pair, then an ordered pattern placing each pixel by how
 *   far along the pair it falls.
 *
 * Mixes and dither error are in gamma-encoded RGB, not linear light. Linear
 * light is the physically right average, but on pixels this big it reads as a
 * few bright dots on black: a mid gold became sparse yellow specks. Mixing in
 * gamma gives the even, bright patterns pixel art uses.
 *
 * A span with transparent pixels keeps index 0 as one of its two colours.
 * Deterministic: ties break on palette order.
 */
export function fitSpans(
  image: RgbaImage,
  rgb: readonly Rgb[],
  skip: readonly number[],
  options: { dither: DitherMode; reserveTransparent: boolean }
): { indices: Uint8Array; report: LossReport } {
  const { width, height, data } = image
  const count = width * height
  const indices = new Uint8Array(count)
  const candidates = rgb.map((_, index) => index).filter((index) => !skip.includes(index))
  const pairs: Pair[] = []
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i; j < candidates.length; j++) pairs.push({ a: candidates[i], b: candidates[j] })
  }
  const gamma = rgb.map((color) => [color.r / 255, color.g / 255, color.b / 255])
  const lab = rgb.map(rgbToOklab)
  const dither = options.dither

  // The source, gamma-encoded 0-1; Floyd–Steinberg adds its error into it.
  const work = new Float32Array(count * 3)
  const transparent = new Uint8Array(count)
  for (let i = 0; i < count; i++) {
    work[i * 3] = data[i * 4] / 255
    work[i * 3 + 1] = data[i * 4 + 1] / 255
    work[i * 3 + 2] = data[i * 4 + 2] / 255
    transparent[i] = options.reserveTransparent && data[i * 4 + 3] < 128 ? 1 : 0
  }
  const unit = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value)
  const nearest = (p: Lab): number => {
    let best = candidates[0] ?? 0
    let bestDistance = Infinity
    for (const index of candidates) {
      const distance = labDistance(p, lab[index])
      if (distance < bestDistance) {
        bestDistance = distance
        best = index
      }
    }
    return best
  }

  const sources = new Map<number, Set<number>>()
  let rowsAltered = 0
  let pixelsChanged = 0
  const spanGamma: number[][] = []
  const spanLab: Lab[] = []
  const spanNearest: number[] = []

  for (let y = 0; y < height; y++) {
    for (let x0 = 0; x0 < width; x0 += 8) {
      const span = Math.min(8, width - x0)
      let opaque = 0
      const wanted = new Set<number>()
      for (let i = 0; i < span; i++) {
        const at = y * width + x0 + i
        if (transparent[at]) {
          wanted.add(0)
          continue
        }
        spanGamma[i] = [unit(work[at * 3]), unit(work[at * 3 + 1]), unit(work[at * 3 + 2])]
        spanLab[i] = gammaToOklab(spanGamma[i][0], spanGamma[i][1], spanGamma[i][2])
        spanNearest[i] = nearest(spanLab[i])
        wanted.add(spanNearest[i])
        opaque++
      }
      // A span that would have shown more than two colours on its own: what
      // the dialog reports as "rows constrained".
      if (wanted.size > 2) rowsAltered++
      if (opaque === 0) continue // indices are already 0

      let pair: Pair
      if (opaque < span) {
        // Index 0 is one of the two; the other is the one colour that best
        // stands for every opaque pixel.
        let best = candidates[0] ?? 0
        let bestCost = Infinity
        for (const index of candidates) {
          let cost = 0
          for (let i = 0; i < span; i++) if (!transparent[y * width + x0 + i]) cost += labDistance(spanLab[i], lab[index])
          if (cost < bestCost) {
            bestCost = cost
            best = index
          }
        }
        pair = { a: best, b: best }
      } else {
        pair = pairs[0]
        let bestCost = Infinity
        for (const candidate of pairs) {
          const cost =
            dither === 'none'
              ? splitCost(spanLab, span, lab[candidate.a], lab[candidate.b])
              : mixCost(spanLab, spanGamma, span, gamma[candidate.a], gamma[candidate.b], lab[candidate.a], lab[candidate.b])
          if (cost < bestCost) {
            bestCost = cost
            pair = candidate
          }
        }
      }

      for (let i = 0; i < span; i++) {
        const x = x0 + i
        const at = y * width + x
        if (transparent[at]) continue
        let chosen: number
        if (pair.a === pair.b) {
          chosen = pair.a
        } else if (dither === 'floyd') {
          // The pair was chosen on the error carried into the span; each pixel
          // also sees what its left neighbours in the span pushed on since.
          const here = gammaToOklab(unit(work[at * 3]), unit(work[at * 3 + 1]), unit(work[at * 3 + 2]))
          chosen = labDistance(here, lab[pair.a]) <= labDistance(here, lab[pair.b]) ? pair.a : pair.b
        } else if (dither === 'bayer4') {
          const t = mixFraction(spanGamma[i], gamma[pair.a], gamma[pair.b])
          chosen = t > (BAYER4[y & 3][x & 3] + 0.5) / 16 ? pair.b : pair.a
        } else {
          chosen = labDistance(spanLab[i], lab[pair.a]) <= labDistance(spanLab[i], lab[pair.b]) ? pair.a : pair.b
        }
        indices[at] = chosen
        if (chosen !== spanNearest[i]) pixelsChanged++

        const pixel = at * 4
        const key = (data[pixel] << 16) | (data[pixel + 1] << 8) | data[pixel + 2]
        const set = sources.get(chosen) ?? new Set<number>()
        set.add(key)
        sources.set(chosen, set)

        if (dither === 'floyd') diffuse01(work, transparent, width, height, x, y, gamma[chosen])
      }
    }
  }

  return {
    indices,
    report: {
      colorsUsed: new Set(indices).size,
      colorsMerged: [...sources.values()].reduce((sum, set) => sum + Math.max(0, set.size - 1), 0),
      rowsAltered,
      pixelsChanged
    }
  }
}

/** Each pixel to the nearer of the two: what a pair costs with no dithering. */
function splitCost(spanLab: Lab[], span: number, a: Lab, b: Lab): number {
  let cost = 0
  for (let i = 0; i < span; i++) cost += Math.min(labDistance(spanLab[i], a), labDistance(spanLab[i], b))
  return cost
}

/** Where `p` falls between `a` (0) and `b` (1), all gamma-encoded: the share of `b` a dither pattern should show. */
function mixFraction(p: readonly number[], a: readonly number[], b: readonly number[]): number {
  const ab0 = b[0] - a[0]
  const ab1 = b[1] - a[1]
  const ab2 = b[2] - a[2]
  const length = ab0 * ab0 + ab1 * ab1 + ab2 * ab2
  if (length === 0) return 0
  const t = ((p[0] - a[0]) * ab0 + (p[1] - a[1]) * ab1 + (p[2] - a[2]) * ab2) / length
  return t < 0 ? 0 : t > 1 ? 1 : t
}

/** Each pixel to the closest *mix* of the two, plus the noise that mix costs: what a pair costs when dithering. */
function mixCost(
  spanLab: Lab[],
  spanGamma: number[][],
  span: number,
  a: readonly number[],
  b: readonly number[],
  labA: Lab,
  labB: Lab
): number {
  const apart = labDistance(labA, labB)
  let cost = 0
  for (let i = 0; i < span; i++) {
    const p = spanLab[i]
    const t = mixFraction(spanGamma[i], a, b)
    const mix = gammaToOklab(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)
    cost += labDistance(p, mix) + MIX_NOISE * t * (1 - t) * apart
    // Red and cyan dots average to a gray, but the eye sees red and cyan dots:
    // over a gray source, the colour of each dot costs, by how many there are.
    if (p.C < GRAY_CHROMA) cost += GRAY_KEEP * (1 - p.C / GRAY_CHROMA) * ((1 - t) * labA.C * labA.C + t * labB.C * labB.C)
  }
  return cost
}

/**
 * Floyd–Steinberg over gamma-encoded 0-1 values (7/16 right, 3/16 down-left, 5/16 down,
 * 1/16 down-right), damped a little so flat areas do not crawl, and never into
 * a transparent pixel.
 */
function diffuse01(
  work: Float32Array,
  transparent: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  got: readonly number[]
): void {
  const at = (y * width + x) * 3
  const damp = 0.85
  const dr = (Math.min(1, Math.max(0, work[at])) - got[0]) * damp
  const dg = (Math.min(1, Math.max(0, work[at + 1])) - got[1]) * damp
  const db = (Math.min(1, Math.max(0, work[at + 2])) - got[2]) * damp
  const spread = (dx: number, dy: number, weight: number): void => {
    const nx = x + dx
    const ny = y + dy
    if (nx < 0 || ny < 0 || nx >= width || ny >= height || transparent[ny * width + nx]) return
    const to = (ny * width + nx) * 3
    work[to] += dr * weight
    work[to + 1] += dg * weight
    work[to + 2] += db * weight
  }
  spread(1, 0, 7 / 16)
  spread(-1, 1, 3 / 16)
  spread(0, 1, 5 / 16)
  spread(1, 1, 1 / 16)
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
