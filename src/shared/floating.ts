/**
 * Rectangular selection and the **floating selection**, for the editors that
 * draw on a grid: the screen editor's dots and the map editor's cells.
 *
 * One idea serves move, paste and import alike. A float is a rectangle of
 * values held *above* the document, not in it: dragging it changes two numbers
 * and nothing else, so it can be pushed around as often as the user likes and
 * still lands as one undo step. Moving a selection lifts its values and
 * remembers where they came from (`from`), which is cleared on the drop; a
 * paste or an import has no `from` and leaves nothing behind.
 *
 * Until it is dropped the document does not know it exists. The canvas shows
 * `composeFloat` of the document instead of the document, so an edit made
 * elsewhere while something floats — a palette entry, an export setting — is
 * an edit to the real document, and the drop lands on top of it rather than
 * on a copy taken when the float was made.
 *
 * Pure grid arithmetic over row-major `values`: what a value *means* (a palette
 * index, a tile number) is the caller's business, as is the unit (`x`/`y` are
 * dots on a screen and cells on a map).
 */

import type { Point } from './tile-editor'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** A rectangle of grid values, lifted out of a document or about to go into one. */
export interface Clip {
  width: number
  height: number
  /** `width * height` values, row-major. */
  values: ArrayLike<number>
}

export interface Float {
  clip: Clip
  /** Where its top-left sits, in grid units. Negative is fine: a float may hang off the top or left edge. */
  x: number
  y: number
  /** The rectangle it was lifted from, cleared when it drops. Null for a paste, an import or a copy-drag. */
  from: Rect | null
  /** The value the float never writes, so what is under it shows through; null when every value is drawn. */
  transparent: number | null
}

/** Two dragged corners as a rectangle, inclusive of both and clipped to a `width × height` grid. */
export function normalizeRect(a: Point, b: Point, width: number, height: number): Rect {
  const x0 = Math.max(0, Math.min(a.x, b.x))
  const y0 = Math.max(0, Math.min(a.y, b.y))
  const x1 = Math.min(width - 1, Math.max(a.x, b.x))
  const y1 = Math.min(height - 1, Math.max(a.y, b.y))
  return { x: x0, y: y0, width: Math.max(1, x1 - x0 + 1), height: Math.max(1, y1 - y0 + 1) }
}

export function rectContains(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.y >= rect.y && point.x < rect.x + rect.width && point.y < rect.y + rect.height
}

/** The values under `rect`, as a clip. Anything outside the grid reads as 0. */
export function copyClip(values: ArrayLike<number>, width: number, height: number, rect: Rect): Clip {
  const out = new Array<number>(rect.width * rect.height)
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      const gx = rect.x + x
      const gy = rect.y + y
      out[y * rect.width + x] = gx >= 0 && gy >= 0 && gx < width && gy < height ? (values[gy * width + gx] ?? 0) : 0
    }
  }
  return { width: rect.width, height: rect.height, values: out }
}

/** Where a float stands, as a rectangle — what the canvas outlines and what a click is tested against. */
export function floatRect(float: Pick<Float, 'clip' | 'x' | 'y'>): Rect {
  return { x: float.x, y: float.y, width: float.clip.width, height: float.clip.height }
}

/**
 * Keeps at least one row and one column of a `clipWidth × clipHeight` float on
 * the grid. Past that it would be dropped onto nothing — and could not be
 * grabbed back, since only the part on the canvas can be clicked.
 */
export function clampFloat(
  at: Point,
  clipWidth: number,
  clipHeight: number,
  width: number,
  height: number
): Point {
  return {
    x: Math.min(width - 1, Math.max(1 - clipWidth, at.x)),
    y: Math.min(height - 1, Math.max(1 - clipHeight, at.y))
  }
}

/**
 * Lifts `rect` into a float standing where it was. `copy` leaves the original
 * in place — a drag that duplicates instead of moves.
 */
export function liftFloat(
  values: ArrayLike<number>,
  width: number,
  height: number,
  rect: Rect,
  copy = false
): Float {
  return { clip: copyClip(values, width, height, rect), x: rect.x, y: rect.y, from: copy ? null : rect, transparent: null }
}

/** A float of `clip` at `at`, with nothing to clear behind it: a paste or an import. */
export function placeFloat(clip: Clip, at: Point, width: number, height: number, transparent: number | null = null): Float {
  return { clip, ...clampFloat(at, clip.width, clip.height, width, height), from: null, transparent }
}

/** `values` with every cell of `rect` set to `fill`, clipped to the grid. Returns the input when nothing changes. */
export function fillRect<T extends number[] | Uint8Array>(values: T, width: number, height: number, rect: Rect, fill = 0): T {
  let out: T | null = null
  for (let y = Math.max(0, rect.y); y < Math.min(height, rect.y + rect.height); y++) {
    for (let x = Math.max(0, rect.x); x < Math.min(width, rect.x + rect.width); x++) {
      const at = y * width + x
      if (values[at] === fill) continue
      out ??= values.slice() as T
      out[at] = fill
    }
  }
  return out ?? values
}

/**
 * The grid as it would be with `float` dropped: its `from` filled with `fill`,
 * then its values written at its position, clipped to the grid and skipping
 * the transparent value. Returns the input when nothing changes.
 *
 * Clearing comes first, so a float dropped half over the place it came from
 * keeps the half it overlaps — which is what moving something a little means.
 */
export function composeFloat<T extends number[] | Uint8Array>(values: T, width: number, height: number, float: Float, fill = 0): T {
  let out = float.from ? fillRect(values, width, height, float.from, fill) : values
  const { clip } = float
  for (let y = 0; y < clip.height; y++) {
    const gy = float.y + y
    if (gy < 0 || gy >= height) continue
    for (let x = 0; x < clip.width; x++) {
      const gx = float.x + x
      if (gx < 0 || gx >= width) continue
      const value = clip.values[y * clip.width + x] ?? 0
      if (value === float.transparent) continue
      const at = gy * width + gx
      if (out[at] === value) continue
      if (out === values) out = values.slice() as T
      out[at] = value
    }
  }
  return out
}

/** The cells a drop writes, `from` included — what has to stop claiming to be a baked meta-tile. */
export function floatFootprint(float: Float, width: number, height: number): Rect[] {
  const rects = float.from ? [float.from] : []
  rects.push(floatRect(float))
  return rects.map((rect) => clipRect(rect, width, height)).filter((rect): rect is Rect => rect !== null)
}

/** `rect` clipped to a `width × height` grid, or null when none of it is on it. */
export function clipRect(rect: Rect, width: number, height: number): Rect | null {
  const x0 = Math.max(0, rect.x)
  const y0 = Math.max(0, rect.y)
  const x1 = Math.min(width, rect.x + rect.width)
  const y1 = Math.min(height, rect.y + rect.height)
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/** True when `inner` lies wholly inside `outer`. */
export function rectInside(inner: Rect, outer: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  )
}
