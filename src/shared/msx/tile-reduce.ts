/**
 * How many tiles a converted picture needs, and how to bring it down to a
 * budget — the import dialog's tile count and its "Reduce to fit".
 *
 * A tile here is an 8×8 cell of palette indices, counted by what it **looks
 * like**: two cells with the same pixels are one tile, which is how every
 * import packs them (`packTiles` dedups, `placePicture` matches by pixels).
 * Partial cells at the right or bottom edge are not counted, as no packer
 * places them.
 */

import { rgbToOklab, labDistance } from './quantize'
import type { Rgb } from './palette'

const CELL = 8

/** Rows of tiles per pattern bank in SCREEN 2/4: the screen's thirds. */
export const BAND_ROWS = 8

export interface TileCount {
  /** Whole 8×8 cells in the picture. */
  cells: number
  /** Distinct tiles among them — what one set of patterns must hold. */
  distinct: number
  /** Distinct tiles per band of `BAND_ROWS` tile rows, top first: what each SCREEN 2/4 bank must hold, banked. */
  bands: number[]
}

function cellKey(indices: ArrayLike<number>, width: number, cx: number, cy: number): string {
  let key = ''
  for (let y = 0; y < CELL; y++) {
    const row = (cy * CELL + y) * width + cx * CELL
    for (let x = 0; x < CELL; x++) key += (indices[row + x] & 0x0f).toString(16)
  }
  return key
}

/** Counts the picture's tiles, once overall and once per screen third. */
export function countTiles(indices: ArrayLike<number>, width: number, height: number): TileCount {
  const cols = Math.floor(width / CELL)
  const rows = Math.floor(height / CELL)
  const all = new Set<string>()
  const bands: Set<string>[] = []
  for (let cy = 0; cy < rows; cy++) {
    const band = Math.floor(cy / BAND_ROWS)
    bands[band] ??= new Set<string>()
    for (let cx = 0; cx < cols; cx++) {
      const key = cellKey(indices, width, cx, cy)
      all.add(key)
      bands[band].add(key)
    }
  }
  return { cells: cols * rows, distinct: all.size, bands: bands.map((set) => set.size) }
}

/**
 * The picture with at most `budget` distinct tiles: while there are too many,
 * the two that look most alike (summed perceptual distance over their 64
 * pixels, weighted by how often the rarer one is used) become one, keeping the
 * pixels of the more-used. Tiles are replaced whole, never blended, so every
 * 8×1 span still has the colours the conversion gave it.
 *
 * Returns the new indices (the input is not changed) and how many tiles were
 * merged away. A budget the picture already fits returns it as it is.
 */
export function reduceTiles(
  indices: ArrayLike<number>,
  width: number,
  height: number,
  rgb: readonly Rgb[],
  budget: number
): { indices: Uint8Array; merged: number } {
  const out = Uint8Array.from(indices)
  const cols = Math.floor(width / CELL)
  const rows = Math.floor(height / CELL)
  const target = Math.max(1, Math.floor(budget))

  // The distinct tiles, their pixels, how often each is used, and which cells show them.
  const keys = new Map<string, number>()
  const pixels: Uint8Array[] = []
  const uses: number[] = []
  const cellTile: number[] = []
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const key = cellKey(indices, width, cx, cy)
      let tile = keys.get(key)
      if (tile === undefined) {
        tile = pixels.length
        keys.set(key, tile)
        const art = new Uint8Array(CELL * CELL)
        for (let y = 0; y < CELL; y++) {
          for (let x = 0; x < CELL; x++) art[y * CELL + x] = indices[(cy * CELL + y) * width + cx * CELL + x] & 0x0f
        }
        pixels.push(art)
        uses.push(0)
      }
      uses[tile]++
      cellTile.push(tile)
    }
  }
  const count = pixels.length
  if (count <= target) return { indices: out, merged: 0 }

  // Perceptual distance between any two palette entries, once.
  const lab = rgb.map(rgbToOklab)
  const colors = Math.max(16, rgb.length)
  const between = new Float32Array(colors * colors)
  for (let a = 0; a < rgb.length; a++) {
    for (let b = 0; b < rgb.length; b++) between[a * colors + b] = a === b ? 0 : Math.sqrt(labDistance(lab[a], lab[b]))
  }
  const difference = (a: number, b: number): number => {
    const left = pixels[a]
    const right = pixels[b]
    let sum = 0
    for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) sum += between[left[i] * colors + right[i]]
    return sum
  }
  const cost = (a: number, b: number, distance: number): number => distance * Math.min(uses[a], uses[b])

  // Each tile's nearest other tile, kept up to date as tiles merge: O(n²) once,
  // then O(n) per merge for the tiles whose nearest was one of the pair.
  const alive = new Uint8Array(count).fill(1)
  // A table of every pair up to a few screens' worth of tiles (2048² floats is
  // 16 MB); past that, distances are worked out as they are needed.
  const table = count <= 2048 ? new Float32Array(count * count) : null
  if (table) {
    for (let a = 0; a < count; a++) {
      for (let b = a + 1; b < count; b++) {
        const d = difference(a, b)
        table[a * count + b] = d
        table[b * count + a] = d
      }
    }
  }
  const distance = (a: number, b: number): number => (table ? table[a * count + b] : difference(a, b))
  const nearest = new Int32Array(count).fill(-1)
  const nearestCost = new Float64Array(count).fill(Infinity)
  const refresh = (a: number): void => {
    nearest[a] = -1
    nearestCost[a] = Infinity
    for (let b = 0; b < count; b++) {
      if (b === a || !alive[b]) continue
      const c = cost(a, b, distance(a, b))
      if (c < nearestCost[a]) {
        nearestCost[a] = c
        nearest[a] = b
      }
    }
  }
  for (let a = 0; a < count; a++) refresh(a)

  const into = new Int32Array(count).map((_, i) => i)
  let left = count
  while (left > target) {
    let a = -1
    for (let i = 0; i < count; i++) if (alive[i] && nearest[i] >= 0 && (a < 0 || nearestCost[i] < nearestCost[a])) a = i
    if (a < 0) break
    const b = nearest[a]
    // The more-used keeps its pixels; ties keep the earlier, for a stable result.
    const [keep, drop] = uses[a] > uses[b] || (uses[a] === uses[b] && a < b) ? [a, b] : [b, a]
    alive[drop] = 0
    uses[keep] += uses[drop]
    into[drop] = keep
    left--
    for (let i = 0; i < count; i++) if (alive[i] && (i === keep || nearest[i] === keep || nearest[i] === drop)) refresh(i)
  }

  const resolve = (tile: number): number => {
    let at = tile
    while (into[at] !== at) at = into[at]
    return at
  }
  let cell = 0
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const tile = cellTile[cell++]
      const shown = resolve(tile)
      if (shown === tile) continue
      const art = pixels[shown]
      for (let y = 0; y < CELL; y++) out.set(art.subarray(y * CELL, y * CELL + CELL), (cy * CELL + y) * width + cx * CELL)
    }
  }
  return { indices: out, merged: count - left }
}
