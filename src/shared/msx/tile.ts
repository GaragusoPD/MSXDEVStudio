/**
 * `*.tiles.json` (Spec 08): the pattern-mode tileset model, stored as the
 * hardware bytes so export is a memcpy, plus the constraint logic that makes
 * illegal tiles impossible.
 *
 * Hardware recap:
 * - **sc2 / sc4** — 8 pattern bytes per tile (bit set = foreground) and 8
 *   color bytes, one per 8×1 row, packed `FG<<4 | BG`.
 * - **sc1** — same 8 pattern bytes, but one color byte per *group of 8 tiles*
 *   (32 bytes for a 256-tile bank). Every pixel of all 8 tiles in the group
 *   shares that FG/BG pair.
 */

import { isTileMode, type TileMode } from './modes'
import type { ExportBlock } from './resource'

export const TILE_SIZE = 8
export const MAX_TILES = 256
/** sc1 shares one color byte across this many consecutive tiles. */
export const SC1_GROUP = 8

export interface TileEntry {
  /** 8 bytes, one per row, MSB = leftmost pixel. */
  pattern: number[]
  /** 8 bytes `FG<<4 | BG`, one per row. Empty in sc1 (see `groupColors`). */
  color: number[]
}

export interface TilesDoc {
  version: 1
  mode: TileMode
  /** MSX1 modes: null (fixed TMS9918A palette). sc4: 16 packed GRB333 entries. */
  palette: number[] | null
  count: number
  tiles: TileEntry[]
  /** sc1 only: `ceil(count / 8)` bytes, one FG/BG pair per group of 8 tiles. */
  groupColors: number[]
  export: ExportBlock | null
}

const zeros = (n: number): number[] => new Array<number>(n).fill(0)

export function createTilesDoc(mode: TileMode = 'sc2', count = 256): TilesDoc {
  return normalizeTiles({ mode, count })
}

function byte(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? ((value | 0) & 0xff) : 0
}

/** Fills in everything a hand-edited or older file is missing; never throws. */
export function normalizeTiles(raw: unknown): TilesDoc {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<TilesDoc>
  const mode: TileMode = isTileMode(String(input.mode)) ? (input.mode as TileMode) : 'sc2'
  const rawTiles = Array.isArray(input.tiles) ? input.tiles : []
  const count = Math.max(1, Math.min(MAX_TILES, Number(input.count) || rawTiles.length || MAX_TILES))
  const perRowColor = mode !== 'sc1'

  const tiles: TileEntry[] = []
  for (let i = 0; i < count; i++) {
    const entry = (rawTiles[i] ?? {}) as Partial<TileEntry>
    const pattern = zeros(TILE_SIZE)
    const color = perRowColor ? zeros(TILE_SIZE) : []
    for (let y = 0; y < TILE_SIZE; y++) {
      pattern[y] = byte(entry.pattern?.[y])
      // A blank tile with color 0x00 would be invisible-on-invisible; white-on-black
      // is the useful default and matches what the editor shows for a fresh bank.
      if (perRowColor) color[y] = entry.color?.[y] === undefined ? 0xf1 : byte(entry.color[y])
    }
    tiles.push({ pattern, color })
  }

  const groupCount = Math.ceil(count / SC1_GROUP)
  const groupColors = mode === 'sc1' ? zeros(groupCount) : []
  if (mode === 'sc1') {
    for (let g = 0; g < groupCount; g++) {
      groupColors[g] = input.groupColors?.[g] === undefined ? 0xf1 : byte(input.groupColors[g])
    }
  }

  const palette =
    Array.isArray(input.palette) && input.palette.length
      ? Array.from({ length: 16 }, (_, i) => Number(input.palette?.[i]) || 0)
      : null

  return {
    version: 1,
    mode,
    palette: mode === 'sc4' ? palette : null,
    count,
    tiles,
    groupColors,
    export: (input.export as ExportBlock | undefined) ?? null
  }
}

// ── color-pair access ───────────────────────────────────────────────────────

/** The FG/BG byte governing tile `index` row `y` — per row in sc2/sc4, per group in sc1. */
export function colorByteAt(doc: TilesDoc, index: number, y: number): number {
  return doc.mode === 'sc1' ? (doc.groupColors[index >> 3] ?? 0) : (doc.tiles[index]?.color[y] ?? 0)
}

export function splitColorByte(value: number): { fg: number; bg: number } {
  return { fg: (value >> 4) & 0x0f, bg: value & 0x0f }
}

export function mergeColorByte(fg: number, bg: number): number {
  return ((fg & 0x0f) << 4) | (bg & 0x0f)
}

// ── pixels ↔ bytes ──────────────────────────────────────────────────────────

/** Decodes one tile to 64 palette indices, row-major. */
export function tilePixels(doc: TilesDoc, index: number): Uint8Array {
  const out = new Uint8Array(TILE_SIZE * TILE_SIZE)
  const tile = doc.tiles[index]
  if (!tile) return out
  for (let y = 0; y < TILE_SIZE; y++) {
    const { fg, bg } = splitColorByte(colorByteAt(doc, index, y))
    const bits = tile.pattern[y]
    for (let x = 0; x < TILE_SIZE; x++) out[y * TILE_SIZE + x] = bits & (0x80 >> x) ? fg : bg
  }
  return out
}

/**
 * Packs 64 palette indices into sc2/sc4 hardware bytes, reducing any row that
 * uses more than two colors to its two most frequent ones. `lossyRows` lists
 * the rows that had to be reduced — the import dialog reports them.
 */
export function tileFromPixels(pixels: ArrayLike<number>): TileEntry & { lossyRows: number[] } {
  const pattern = zeros(TILE_SIZE)
  const color = zeros(TILE_SIZE)
  const lossyRows: number[] = []

  for (let y = 0; y < TILE_SIZE; y++) {
    const counts = new Map<number, number>()
    for (let x = 0; x < TILE_SIZE; x++) {
      const value = (pixels[y * TILE_SIZE + x] ?? 0) & 0x0f
      counts.set(value, (counts.get(value) ?? 0) + 1)
    }
    // Sort by frequency, then by index so identical input always yields identical bytes.
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([value]) => value)
    if (ranked.length > 2) lossyRows.push(y)
    const fg = ranked[0] ?? 0
    const bg = ranked[1] ?? (fg === 0 ? 1 : 0)
    color[y] = mergeColorByte(fg, bg)
    let bits = 0
    for (let x = 0; x < TILE_SIZE; x++) {
      // Anything that isn't BG becomes FG — nearest of the two survivors would need
      // RGB context this function doesn't have; the quantizer's fit pass does that.
      if (((pixels[y * TILE_SIZE + x] ?? 0) & 0x0f) !== bg) bits |= 0x80 >> x
    }
    pattern[y] = bits
  }
  return { pattern, color, lossyRows }
}

export interface PackResult {
  doc: TilesDoc
  /** Tile index per source cell, row-major over `width/8 × height/8`. */
  layout: number[]
  /** Tiles whose rows (sc2/sc4) or groups (sc1) had to drop colors. */
  lossyTiles: number[]
}

/**
 * Cuts an indexed image into 8×8 tiles for `mode`. `dedup` folds identical
 * tiles together (the import option in Spec 08) and the returned `layout` is
 * exactly the name table Spec 10's map editor wants.
 */
export function packTiles(
  indices: ArrayLike<number>,
  width: number,
  height: number,
  mode: TileMode,
  options: { dedup?: boolean } = {}
): PackResult {
  const cols = Math.floor(width / TILE_SIZE)
  const rows = Math.floor(height / TILE_SIZE)
  const tiles: TileEntry[] = []
  const layout: number[] = []
  const lossyTiles: number[] = []
  const seen = new Map<string, number>()

  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const pixels = new Uint8Array(TILE_SIZE * TILE_SIZE)
      for (let y = 0; y < TILE_SIZE; y++) {
        for (let x = 0; x < TILE_SIZE; x++) {
          pixels[y * TILE_SIZE + x] = indices[(ty * TILE_SIZE + y) * width + tx * TILE_SIZE + x] ?? 0
        }
      }
      const { pattern, color, lossyRows } = tileFromPixels(pixels)
      const key = options.dedup ? `${pattern.join(',')}|${color.join(',')}` : ''
      const existing = options.dedup ? seen.get(key) : undefined
      if (existing !== undefined) {
        layout.push(existing)
        continue
      }
      const index = tiles.length
      if (options.dedup) seen.set(key, index)
      tiles.push({ pattern, color })
      layout.push(index)
      if (lossyRows.length) lossyTiles.push(index)
      if (tiles.length >= MAX_TILES) break
    }
    if (tiles.length >= MAX_TILES) break
  }

  const doc = normalizeTiles({ mode, count: Math.max(1, tiles.length), tiles })
  // sc1 can only keep one pair per group of 8 tiles: take each group's first row pair
  // and re-derive the patterns against it, so the stored bytes really are displayable.
  if (mode === 'sc1') {
    for (let g = 0; g < doc.groupColors.length; g++) {
      const first = tiles[g * SC1_GROUP]
      doc.groupColors[g] = first ? first.color[0] : 0xf1
      for (let t = g * SC1_GROUP; t < Math.min(doc.count, (g + 1) * SC1_GROUP); t++) {
        const source = tiles[t]
        if (!source) continue
        if (source.color.some((value) => value !== doc.groupColors[g]) && !lossyTiles.includes(t)) lossyTiles.push(t)
      }
    }
  }
  return { doc, layout, lossyTiles }
}

// ── paint with conflict resolution (the Spec 08 core) ───────────────────────

export interface PaintConflict {
  /** sc2/sc4 constrain one 8×1 pattern row; sc1 constrains a whole group of 8 tiles. */
  scope: 'row' | 'group'
  /** Row index 0–7 within the tile, or the group index (`tileIndex >> 3`). */
  index: number
  /** The pair currently in force. */
  fg: number
  bg: number
  /** The color the user tried to paint. */
  wanted: number
}

export type PaintResult = { ok: true; doc: TilesDoc; changed: boolean } | { ok: false; conflict: PaintConflict }

/** Shallow-clones just enough of `doc` that the caller's previous value stays intact (undo stack). */
function cloneForEdit(doc: TilesDoc, index: number): TilesDoc {
  const tiles = doc.tiles.slice()
  const tile = tiles[index]
  tiles[index] = { pattern: tile.pattern.slice(), color: tile.color.slice() }
  return { ...doc, tiles, groupColors: doc.groupColors.slice() }
}

/** Is FG (bit set) / BG (bit clear) still used anywhere in the constrained area, ignoring the pixel being painted? */
function rolesInUse(
  doc: TilesDoc,
  index: number,
  x: number,
  y: number
): { fgUsed: boolean; bgUsed: boolean } {
  const bit = 0x80 >> x
  let fgUsed = false
  let bgUsed = false
  const scan = (tileIndex: number, row: number): void => {
    const bits = doc.tiles[tileIndex]?.pattern[row] ?? 0
    const mask = tileIndex === index && row === y ? 0xff & ~bit : 0xff
    if (bits & mask) fgUsed = true
    if (~bits & mask & 0xff) bgUsed = true
  }
  if (doc.mode === 'sc1') {
    const first = (index >> 3) * SC1_GROUP
    for (let t = first; t < Math.min(doc.count, first + SC1_GROUP); t++) {
      for (let row = 0; row < TILE_SIZE; row++) scan(t, row)
    }
  } else {
    scan(index, y)
  }
  return { fgUsed, bgUsed }
}

function writeColorByte(doc: TilesDoc, index: number, y: number, value: number): void {
  if (doc.mode === 'sc1') doc.groupColors[index >> 3] = value
  else doc.tiles[index].color[y] = value
}

/**
 * Paints one pixel, enforcing the mode's two-colors-per-row (sc2/sc4) or
 * per-group (sc1) rule.
 *
 * Resolution order — the first branch that holds wins:
 * 1. the color already *is* the row's FG or BG → just set/clear the bit;
 * 2. the pixel's current role (FG if the bit is set, BG if not) is used
 *    nowhere else in the constrained area → recolor that role, keep the bit;
 * 3. the *other* role is unused → recolor it and flip the bit;
 * 4. both are still in use → a real conflict; the caller must re-call with
 *    `resolution: 'fg' | 'bg'` (the popover's two choices).
 *
 * Never mutates `doc`; on success it returns a new document.
 */
export function paintPixel(
  doc: TilesDoc,
  tileIndex: number,
  x: number,
  y: number,
  colorIndex: number,
  resolution?: 'fg' | 'bg'
): PaintResult {
  if (!doc.tiles[tileIndex] || x < 0 || x > 7 || y < 0 || y > 7) {
    throw new RangeError(`paintPixel out of range: tile ${tileIndex}, pixel ${x},${y}`)
  }
  const wanted = colorIndex & 0x0f
  const bit = 0x80 >> x
  const current = colorByteAt(doc, tileIndex, y)
  const { fg, bg } = splitColorByte(current)
  const isSet = (doc.tiles[tileIndex].pattern[y] & bit) !== 0

  const apply = (role: 'fg' | 'bg', recolor: boolean): PaintResult => {
    const next = cloneForEdit(doc, tileIndex)
    if (recolor) {
      writeColorByte(next, tileIndex, y, role === 'fg' ? mergeColorByte(wanted, bg) : mergeColorByte(fg, wanted))
    }
    const pattern = next.tiles[tileIndex].pattern
    pattern[y] = role === 'fg' ? pattern[y] | bit : pattern[y] & ~bit & 0xff
    const changed = recolor || pattern[y] !== doc.tiles[tileIndex].pattern[y]
    return { ok: true, doc: next, changed }
  }

  if (resolution) return apply(resolution, true)
  if (wanted === fg) return apply('fg', false)
  if (wanted === bg) return apply('bg', false)

  const { fgUsed, bgUsed } = rolesInUse(doc, tileIndex, x, y)
  const currentRole = isSet ? 'fg' : 'bg'
  const currentUsed = isSet ? fgUsed : bgUsed
  const otherUsed = isSet ? bgUsed : fgUsed
  if (!currentUsed) return apply(currentRole, true)
  if (!otherUsed) return apply(isSet ? 'bg' : 'fg', true)

  return {
    ok: false,
    conflict: {
      scope: doc.mode === 'sc1' ? 'group' : 'row',
      index: doc.mode === 'sc1' ? tileIndex >> 3 : y,
      fg,
      bg,
      wanted
    }
  }
}

/** Swaps a row's (or group's) FG and BG, inverting the affected patterns. Spec 08's "FG/BG swap". */
export function swapRowColors(doc: TilesDoc, tileIndex: number, y: number): TilesDoc {
  const next = cloneForEdit(doc, tileIndex)
  const { fg, bg } = splitColorByte(colorByteAt(doc, tileIndex, y))
  writeColorByte(next, tileIndex, y, mergeColorByte(bg, fg))
  if (doc.mode === 'sc1') {
    const first = (tileIndex >> 3) * SC1_GROUP
    for (let t = first; t < Math.min(doc.count, first + SC1_GROUP); t++) {
      next.tiles[t] = { pattern: doc.tiles[t].pattern.map((v) => ~v & 0xff), color: doc.tiles[t].color.slice() }
    }
  } else {
    next.tiles[tileIndex].pattern[y] = ~next.tiles[tileIndex].pattern[y] & 0xff
  }
  return next
}

/**
 * Moves tile `from` to position `to`. Returns the new document plus the
 * old-index → new-index mapping Spec 10 replays over maps that reference it.
 */
export function reorderTiles(doc: TilesDoc, from: number, to: number): { doc: TilesDoc; mapping: number[] } {
  const tiles = doc.tiles.slice()
  const [moved] = tiles.splice(from, 1)
  tiles.splice(to, 0, moved)
  const mapping = doc.tiles.map((_, index) => {
    if (index === from) return to
    if (from < to) return index > from && index <= to ? index - 1 : index
    return index >= to && index < from ? index + 1 : index
  })
  return { doc: { ...doc, tiles }, mapping }
}

// ── validation ──────────────────────────────────────────────────────────────

/** Structural check of a document. Empty array = valid. */
export function validateTiles(doc: TilesDoc): string[] {
  const problems: string[] = []
  if (doc.version !== 1) problems.push(`Unsupported version ${doc.version}`)
  if (!isTileMode(doc.mode)) problems.push(`Unknown mode "${doc.mode}"`)
  if (doc.count < 1 || doc.count > MAX_TILES) problems.push(`count ${doc.count} outside 1..${MAX_TILES}`)
  if (doc.tiles.length !== doc.count) problems.push(`count ${doc.count} but ${doc.tiles.length} tiles`)

  const inRange = (values: number[]): boolean =>
    values.every((value) => Number.isInteger(value) && value >= 0 && value <= 0xff)

  doc.tiles.forEach((tile, index) => {
    if (tile.pattern.length !== TILE_SIZE || !inRange(tile.pattern)) problems.push(`Tile ${index}: bad pattern bytes`)
    if (doc.mode === 'sc1') {
      if (tile.color.length) problems.push(`Tile ${index}: sc1 tiles carry no per-row color`)
    } else if (tile.color.length !== TILE_SIZE || !inRange(tile.color)) {
      problems.push(`Tile ${index}: bad color bytes`)
    }
  })

  if (doc.mode === 'sc1') {
    const expected = Math.ceil(doc.count / SC1_GROUP)
    if (doc.groupColors.length !== expected) {
      problems.push(`sc1 needs ${expected} group colors, found ${doc.groupColors.length}`)
    }
    if (!inRange(doc.groupColors)) problems.push('sc1 group colors out of byte range')
  } else if (doc.groupColors.length) {
    problems.push(`${doc.mode} does not use group colors`)
  }

  if (doc.palette) {
    if (doc.mode !== 'sc4') problems.push(`${doc.mode} uses the fixed TMS9918A palette; palette must be null`)
    if (doc.palette.length !== 16) problems.push(`Palette must hold 16 entries, found ${doc.palette.length}`)
    if (doc.palette.some((value) => (value & ~0x0777) !== 0)) problems.push('Palette entry outside the GRB333 space')
  }
  return problems
}

/**
 * Checks an indexed *image* against a row-constrained mode: every 8-pixel span
 * on every scanline must use at most two colors. Returns the offending spans
 * (`{x, y}` = the span's top-left), so the quantizer's constraint-fit pass can
 * be verified end-to-end.
 */
export function rowColorViolations(
  indices: ArrayLike<number>,
  width: number,
  height: number
): { x: number; y: number; colors: number[] }[] {
  const out: { x: number; y: number; colors: number[] }[] = []
  for (let y = 0; y < height; y++) {
    for (let x = 0; x + TILE_SIZE <= width; x += TILE_SIZE) {
      const colors = new Set<number>()
      for (let i = 0; i < TILE_SIZE; i++) colors.add(indices[y * width + x + i] ?? 0)
      if (colors.size > 2) out.push({ x, y, colors: [...colors] })
    }
  }
  return out
}

// ── export bytes ────────────────────────────────────────────────────────────

export function tilePatternBytes(doc: TilesDoc): Uint8Array {
  const out = new Uint8Array(doc.count * TILE_SIZE)
  doc.tiles.forEach((tile, index) => out.set(tile.pattern, index * TILE_SIZE))
  return out
}

/** sc2/sc4: 8 bytes per tile. sc1: one byte per group of 8 tiles. */
export function tileColorBytes(doc: TilesDoc): Uint8Array {
  if (doc.mode === 'sc1') return Uint8Array.from(doc.groupColors)
  const out = new Uint8Array(doc.count * TILE_SIZE)
  doc.tiles.forEach((tile, index) => out.set(tile.color, index * TILE_SIZE))
  return out
}
