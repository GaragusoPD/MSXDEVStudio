/**
 * MSX color math: the TMS9918A fixed palette, the V9938's GRB333 (512-color)
 * space, and nearest-color search.
 *
 * A GRB333 entry is stored packed exactly like MSXgl's `RGB16(r,g,b)` macro
 * and the V9938's two palette-register bytes, little-endian:
 *
 *     bits 15..8 = 0000 0GGG      (second byte written to port #9A)
 *     bits  7..0 = 0RRR 0BBB      (first byte)
 *
 * so `emitC` can dump a palette table straight out with no re-packing, and
 * `#include`-ing it next to `VDP_SetPalette()` just works.
 */

export interface Rgb {
  r: number
  g: number
  b: number
}

/** TMS9918A's 16 fixed colors, in openMSX's RGB values. Index 0 is transparent (rendered as the border color). */
export const MSX1_PALETTE_RGB: readonly Rgb[] = [
  { r: 0, g: 0, b: 0 }, // 0 transparent
  { r: 0, g: 0, b: 0 }, // 1 black
  { r: 33, g: 200, b: 66 }, // 2 medium green
  { r: 94, g: 220, b: 120 }, // 3 light green
  { r: 84, g: 85, b: 237 }, // 4 dark blue
  { r: 125, g: 118, b: 252 }, // 5 light blue
  { r: 212, g: 82, b: 77 }, // 6 dark red
  { r: 66, g: 235, b: 245 }, // 7 cyan
  { r: 252, g: 85, b: 84 }, // 8 medium red
  { r: 255, g: 121, b: 120 }, // 9 light red
  { r: 212, g: 193, b: 84 }, // 10 dark yellow
  { r: 230, g: 206, b: 128 }, // 11 light yellow
  { r: 33, g: 176, b: 59 }, // 12 dark green
  { r: 201, g: 91, b: 186 }, // 13 magenta
  { r: 204, g: 204, b: 204 }, // 14 gray
  { r: 255, g: 255, b: 255 } // 15 white
]

export const MSX1_COLOR_NAMES: readonly string[] = [
  'Transparent',
  'Black',
  'Medium green',
  'Light green',
  'Dark blue',
  'Light blue',
  'Dark red',
  'Cyan',
  'Medium red',
  'Light red',
  'Dark yellow',
  'Light yellow',
  'Dark green',
  'Magenta',
  'Gray',
  'White'
]

/** Packs 3-bit components into the GRB333 word described above. */
export function packGrb(r: number, g: number, b: number): number {
  return ((g & 7) << 8) | ((r & 7) << 4) | (b & 7)
}

export function unpackGrb(grb: number): { r: number; g: number; b: number } {
  return { r: (grb >> 4) & 7, g: (grb >> 8) & 7, b: grb & 7 }
}

/** The two bytes the V9938 palette register expects, in write order. */
export function grbToVdpBytes(grb: number): [number, number] {
  return [grb & 0x77, (grb >> 8) & 0x07]
}

/** 3-bit component → 8-bit, the same rounding openMSX uses (0,36,73,109,146,182,219,255). */
function expand3(value: number): number {
  return Math.round((value * 255) / 7)
}

/** 8-bit component → nearest 3-bit level. */
function reduce3(value: number): number {
  return Math.min(7, Math.max(0, Math.round((value * 7) / 255)))
}

export function grbToRgb(grb: number): Rgb {
  const { r, g, b } = unpackGrb(grb)
  return { r: expand3(r), g: expand3(g), b: expand3(b) }
}

/** Nearest point in the 512-color space. Round-trips: `grbToRgb` → `rgbToGrb` is the identity. */
export function rgbToGrb(color: Rgb): number {
  return packGrb(reduce3(color.r), reduce3(color.g), reduce3(color.b))
}

/** True for any value that names a real V9938 palette entry (no bits outside the three 3-bit fields). */
export function isValidGrb(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && (value & ~0x0777) === 0
}

/** MSX1's palette as the V9938 reproduces it — MSXgl's `COLOR16_MSX1_*`. */
export const MSX1_PALETTE_GRB: readonly number[] = [
  packGrb(0, 0, 0),
  packGrb(0, 0, 0),
  packGrb(1, 5, 1),
  packGrb(3, 6, 3),
  packGrb(2, 2, 6),
  packGrb(3, 3, 7),
  packGrb(5, 2, 2),
  packGrb(2, 6, 7),
  packGrb(6, 2, 2),
  packGrb(6, 3, 3),
  packGrb(5, 5, 2),
  packGrb(6, 6, 3),
  packGrb(1, 4, 1),
  packGrb(5, 2, 5),
  packGrb(5, 5, 5),
  packGrb(7, 7, 7)
]

/**
 * Perceptually weighted squared distance (the classic 30/59/11 luma weights).
 * Squared on purpose: only the ordering matters and sqrt costs real time in
 * the quantizer's inner loop.
 */
export function colorDistance(a: Rgb, b: Rgb): number {
  const dr = a.r - b.r
  const dg = a.g - b.g
  const db = a.b - b.b
  return 30 * dr * dr + 59 * dg * dg + 11 * db * db
}

/** Index of the closest entry in `palette`. `skip` hides entries (e.g. index 0 = transparent). */
export function nearestColor(color: Rgb, palette: readonly Rgb[], skip: readonly number[] = []): number {
  let best = -1
  let bestDistance = Infinity
  for (let i = 0; i < palette.length; i++) {
    if (skip.includes(i)) continue
    const distance = colorDistance(color, palette[i])
    if (distance < bestDistance) {
      bestDistance = distance
      best = i
    }
  }
  return best === -1 ? 0 : best
}

/** `#RRGGBB`, for CSS and for MSXimg's `-trans 0xRRGGBB`-style arguments. */
export function toHex(color: Rgb): string {
  const part = (value: number): string => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')
  return `#${part(color.r)}${part(color.g)}${part(color.b)}`
}

export function fromHex(hex: string): Rgb {
  const value = Number.parseInt(hex.replace('#', ''), 16)
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff }
}

/** Resolves a document's `palette` field to displayable RGB: null = the MSX1 fixed palette. */
export function paletteToRgb(palette: readonly number[] | null): Rgb[] {
  if (!palette) return [...MSX1_PALETTE_RGB]
  return palette.map(grbToRgb)
}
