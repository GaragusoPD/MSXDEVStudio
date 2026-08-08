// A very small drawing kit for the asset generator: an indexed canvas, a
// deterministic noise source, and a 5×7 font.
//
// Indexed, not RGB, because everything here is authored in palette indices —
// the PNG is only the transport into the screen editor, so the last step is
// the one that turns an index into a colour.

import { RGB } from './palette.mjs'

/** Reproducibility matters more than randomness: the same seed must redraw the same rock. */
export function rng(seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

export function canvas(width, height, fill = 0) {
  return { width, height, pixels: new Uint8Array(width * height).fill(fill) }
}

export function put(target, x, y, color) {
  if (x < 0 || y < 0 || x >= target.width || y >= target.height) return
  target.pixels[y * target.width + x] = color
}

export function get(target, x, y) {
  if (x < 0 || y < 0 || x >= target.width || y >= target.height) return 0
  return target.pixels[y * target.width + x]
}

export function fillRect(target, x, y, w, h, color) {
  for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) put(target, x + dx, y + dy, color)
}

export function hLine(target, x, y, w, color) {
  fillRect(target, x, y, w, 1, color)
}

export function vLine(target, x, y, h, color) {
  fillRect(target, x, y, 1, h, color)
}

/** Copies `src` onto `dst` at (x, y). Index 0 in the source is transparent. */
export function blit(dst, src, x, y) {
  for (let sy = 0; sy < src.height; sy++) {
    for (let sx = 0; sx < src.width; sx++) {
      const value = src.pixels[sy * src.width + sx]
      if (value) put(dst, x + sx, y + sy, value)
    }
  }
}

/** Same, but index 0 is copied too — for laying cells into an atlas grid. */
export function stamp(dst, src, x, y) {
  for (let sy = 0; sy < src.height; sy++) {
    for (let sx = 0; sx < src.width; sx++) put(dst, x + sx, y + sy, src.pixels[sy * src.width + sx])
  }
}

/**
 * Art written as text: one character per pixel, hex digit = palette index,
 * '.' = transparent. Used where a shape has to be exact and procedural noise
 * would only get in the way.
 */
export function art(rows) {
  const target = canvas(rows[0].length, rows.length)
  rows.forEach((row, y) => {
    ;[...row].forEach((char, x) => {
      if (char !== '.') put(target, x, y, parseInt(char, 16))
    })
  })
  return target
}

// ── 5×7 font ────────────────────────────────────────────────────────────────
//
// Enough of one to bake the title and credits text into the pictures, which is
// why neither screen needs MSXgl's print module or a font in ROM.

const GLYPHS = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '####.', '#...#', '#...#', '#...#', '####.'],
  C: ['.####', '#....', '#....', '#....', '#....', '#....', '.####'],
  D: ['###..', '#..#.', '#...#', '#...#', '#...#', '#..#.', '###..'],
  E: ['#####', '#....', '####.', '#....', '#....', '#....', '#####'],
  F: ['#####', '#....', '####.', '#....', '#....', '#....', '#....'],
  G: ['.####', '#....', '#....', '#..##', '#...#', '#...#', '.###.'],
  H: ['#...#', '#...#', '#####', '#...#', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  J: ['....#', '....#', '....#', '....#', '#...#', '#...#', '.###.'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '.#.#.', '..#..', '..#..', '..#..', '.#.#.', '#...#'],
  Y: ['#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '....#', '.###.'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  ',': ['.....', '.....', '.....', '.....', '.##..', '.##..', '.#...'],
  "'": ['.#...', '.#...', '.....', '.....', '.....', '.....', '.....'],
  ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '!': ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'],
  '(': ['...#.', '..#..', '.#...', '.#...', '.#...', '..#..', '...#.'],
  ')': ['.#...', '..#..', '...#.', '...#.', '...#.', '..#..', '.#...'],
  '/': ['....#', '....#', '...#.', '..#..', '.#...', '#....', '#....'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  '©': ['.###.', '#...#', '#.##.', '#.#..', '#.##.', '#...#', '.###.']
}

/** The same glyphs, for the sprite sheet generator — see make-data.mjs. */
export const GLYPHS_FOR_SPRITES = GLYPHS

export const GLYPH_W = 6
export const GLYPH_H = 8

/** Draws `text` at (x, y) in `color`, 6 pixels per character. Unknown characters become spaces. */
export function text(target, x, y, string, color, shadow = 0) {
  ;[...string.toUpperCase()].forEach((char, index) => {
    const glyph = GLYPHS[char] ?? GLYPHS[' ']
    const ox = x + index * GLYPH_W
    glyph.forEach((row, gy) => {
      ;[...row].forEach((pixel, gx) => {
        if (pixel !== '#') return
        if (shadow) put(target, ox + gx + 1, y + gy + 1, shadow)
        put(target, ox + gx, y + gy, color)
      })
    })
  })
}

export const textWidth = (string) => string.length * GLYPH_W

/** Centred in a `width`-wide area. */
export function textCentered(target, y, string, color, width, shadow = 0) {
  text(target, Math.round((width - textWidth(string)) / 2), y, string, color, shadow)
}

// ── output ──────────────────────────────────────────────────────────────────

/** Indexed canvas → RGBA, with index 0 fully transparent so the quantizer keeps it there. */
export function toRgba(target) {
  const data = Buffer.alloc(target.width * target.height * 4)
  for (let i = 0; i < target.pixels.length; i++) {
    const index = target.pixels[i]
    const [r, g, b] = RGB[index]
    data[i * 4] = r
    data[i * 4 + 1] = g
    data[i * 4 + 2] = b
    data[i * 4 + 3] = index === 0 ? 0 : 255
  }
  return data
}
