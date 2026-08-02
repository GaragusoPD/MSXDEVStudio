/**
 * Tile editor (Spec 08) — the editor-side logic that isn't hardware knowledge:
 * which pixels a tool touches, how a stroke survives a constraint conflict,
 * tile transforms, the undo stack, grid selection, and the reorder seam Spec 10
 * subscribes to.
 *
 * Everything here is pure (or, for the reorder bus, DOM-free), so it lives in
 * `shared/` where Vitest already runs; `editors/tile/*.vue` is a thin shell on
 * top. All *hardware* rules — the two-colors-per-row constraint, byte packing,
 * validation — stay in `shared/msx/tile.ts` and are only ever called from here.
 */

import { MSX1_PALETTE_GRB } from './msx/palette'
import {
  mergeColorByte,
  paintPixel,
  TILE_SIZE,
  tileFromPixels,
  tilePixels,
  type PaintConflict,
  type TilesDoc
} from './msx/tile'

export interface Point {
  x: number
  y: number
}

export type TileTool = 'pencil' | 'line' | 'rect' | 'fill'

const inTile = (p: Point): boolean => p.x >= 0 && p.x < TILE_SIZE && p.y >= 0 && p.y < TILE_SIZE

// ── tools → the pixels they touch ───────────────────────────────────────────

/** Bresenham, endpoints included. Also what a pencil drag uses between two mouse samples. */
export function linePoints(a: Point, b: Point): Point[] {
  const points: Point[] = []
  let { x, y } = a
  const dx = Math.abs(b.x - x)
  const dy = -Math.abs(b.y - y)
  const sx = x < b.x ? 1 : -1
  const sy = y < b.y ? 1 : -1
  let error = dx + dy
  for (;;) {
    points.push({ x, y })
    if (x === b.x && y === b.y) return points
    const doubled = 2 * error
    if (doubled >= dy) {
      error += dy
      x += sx
    }
    if (doubled <= dx) {
      error += dx
      y += sy
    }
  }
}

export function rectPoints(a: Point, b: Point, filled = false): Point[] {
  const x0 = Math.min(a.x, b.x)
  const x1 = Math.max(a.x, b.x)
  const y0 = Math.min(a.y, b.y)
  const y1 = Math.max(a.y, b.y)
  const points: Point[] = []
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (filled || x === x0 || x === x1 || y === y0 || y === y1) points.push({ x, y })
    }
  }
  return points
}

/** 4-way flood over `pixels` (64 palette indices, from `tilePixels`) matching the start pixel's color. */
export function fillPoints(pixels: ArrayLike<number>, start: Point): Point[] {
  if (!inTile(start)) return []
  const target = pixels[start.y * TILE_SIZE + start.x]
  const seen = new Set<number>()
  const out: Point[] = []
  const stack = [start]
  while (stack.length) {
    const p = stack.pop() as Point
    const key = p.y * TILE_SIZE + p.x
    if (!inTile(p) || seen.has(key) || pixels[key] !== target) continue
    seen.add(key)
    out.push(p)
    stack.push({ x: p.x + 1, y: p.y }, { x: p.x - 1, y: p.y }, { x: p.x, y: p.y + 1 }, { x: p.x, y: p.y - 1 })
  }
  return out
}

/** `from` is the drag origin (or the previous pencil sample), `to` the current pixel. */
export function toolPoints(
  tool: TileTool,
  from: Point,
  to: Point,
  pixels: ArrayLike<number>,
  filled = false
): Point[] {
  switch (tool) {
    case 'fill':
      return fillPoints(pixels, to)
    case 'rect':
      return rectPoints(from, to, filled)
    default:
      return linePoints(from, to)
  }
}

// ── stroke dispatch (the conflict popover's other half) ─────────────────────

export type StrokeResult =
  | { ok: true; doc: TilesDoc; changed: boolean }
  /** `doc` holds everything applied before the conflict; `pending` starts with the pixel that hit it. */
  | { ok: false; doc: TilesDoc; conflict: PaintConflict; pending: Point[] }

/**
 * Paints a whole stroke through `paintPixel`, stopping at the first pixel the
 * mode's constraint refuses. The UI shows the popover, then calls this again
 * with `(result.doc, result.pending, color, 'fg' | 'bg')` — the resolution
 * applies to the pixel that stopped it, and the rest of the stroke continues.
 */
export function applyStroke(
  doc: TilesDoc,
  tileIndex: number,
  points: readonly Point[],
  color: number,
  resolution?: 'fg' | 'bg'
): StrokeResult {
  const inside = points.filter(inTile)
  let current = doc
  let changed = false
  for (let i = 0; i < inside.length; i++) {
    const { x, y } = inside[i]
    const result = paintPixel(current, tileIndex, x, y, color, i === 0 ? resolution : undefined)
    if (!result.ok) return { ok: false, doc: current, conflict: result.conflict, pending: inside.slice(i) }
    current = result.doc
    changed = changed || result.changed
  }
  return { ok: true, doc: current, changed }
}

// ── whole-tile transforms ───────────────────────────────────────────────────

export type TileTransform =
  | 'shiftLeft'
  | 'shiftRight'
  | 'shiftUp'
  | 'shiftDown'
  | 'mirrorH'
  | 'mirrorV'
  | 'rotateCW'

function reverseBits(value: number): number {
  let out = 0
  for (let i = 0; i < 8; i++) if (value & (1 << i)) out |= 0x80 >> i
  return out
}

/**
 * Shifts (wrapping), mirrors or rotates one tile.
 *
 * Everything except rotation is exact: horizontal ops only move bits, vertical
 * ops move each row's color byte along with it. Rotation moves pixels *across*
 * rows, which sc2/sc4 can't always express — those go through
 * `tilePixels`/`tileFromPixels`, so the result is the honest two-colors-per-row
 * approximation and `lossyRows` says which rows lost a color. sc1 shares one
 * pair per group, so there rotation is exact too.
 */
export function transformTile(
  doc: TilesDoc,
  index: number,
  op: TileTransform
): { doc: TilesDoc; lossyRows: number[] } {
  const tile = doc.tiles[index]
  if (!tile) return { doc, lossyRows: [] }
  const pattern = tile.pattern.slice()
  const color = tile.color.slice()
  let lossyRows: number[] = []

  switch (op) {
    case 'shiftLeft':
      for (let y = 0; y < TILE_SIZE; y++) pattern[y] = ((pattern[y] << 1) | (pattern[y] >> 7)) & 0xff
      break
    case 'shiftRight':
      for (let y = 0; y < TILE_SIZE; y++) pattern[y] = ((pattern[y] >> 1) | (pattern[y] << 7)) & 0xff
      break
    case 'shiftUp':
      pattern.push(pattern.shift() as number)
      if (color.length) color.push(color.shift() as number)
      break
    case 'shiftDown':
      pattern.unshift(pattern.pop() as number)
      if (color.length) color.unshift(color.pop() as number)
      break
    case 'mirrorH':
      for (let y = 0; y < TILE_SIZE; y++) pattern[y] = reverseBits(pattern[y])
      break
    case 'mirrorV':
      pattern.reverse()
      color.reverse()
      break
    case 'rotateCW':
      if (doc.mode === 'sc1') {
        for (let y = 0; y < TILE_SIZE; y++) {
          let bits = 0
          for (let x = 0; x < TILE_SIZE; x++) if (tile.pattern[7 - x] & (0x80 >> y)) bits |= 0x80 >> x
          pattern[y] = bits
        }
      } else {
        const source = tilePixels(doc, index)
        const rotated = new Uint8Array(TILE_SIZE * TILE_SIZE)
        for (let y = 0; y < TILE_SIZE; y++) {
          for (let x = 0; x < TILE_SIZE; x++) rotated[y * TILE_SIZE + x] = source[(7 - x) * TILE_SIZE + y]
        }
        const fitted = tileFromPixels(rotated)
        pattern.splice(0, TILE_SIZE, ...fitted.pattern)
        color.splice(0, TILE_SIZE, ...fitted.color)
        lossyRows = fitted.lossyRows
      }
      break
  }

  const tiles = doc.tiles.slice()
  tiles[index] = { pattern, color }
  return { doc: { ...doc, tiles }, lossyRows }
}

// ── direct color edits ──────────────────────────────────────────────────────

/** Sets a row's FG/BG pair (the right-hand strip). sc1 writes the tile's group byte instead. */
export function setRowColors(doc: TilesDoc, tileIndex: number, y: number, fg: number, bg: number): TilesDoc {
  const value = mergeColorByte(fg, bg)
  if (doc.mode === 'sc1') {
    const groupColors = doc.groupColors.slice()
    groupColors[tileIndex >> 3] = value
    return { ...doc, groupColors }
  }
  const tiles = doc.tiles.slice()
  const color = tiles[tileIndex].color.slice()
  color[y] = value
  tiles[tileIndex] = { pattern: tiles[tileIndex].pattern, color }
  return { ...doc, tiles }
}

/** sc4 only: replaces one programmable palette entry, snapped to the GRB333 space. */
export function setPaletteEntry(doc: TilesDoc, index: number, grb: number): TilesDoc {
  const palette = (doc.palette ?? [...MSX1_PALETTE_GRB]).map((value, i) => (i === index ? grb & 0x0777 : value))
  return { ...doc, palette }
}

// ── undo/redo ───────────────────────────────────────────────────────────────

/** Deep-ish snapshots are cheap here: every edit helper returns a new doc that shares its untouched tiles. */
export interface TileHistoryEntry {
  doc: TilesDoc
  label: string
  /** Set on reorder steps: the old-index → new-index mapping Spec 10 replays (see `emitTilesReordered`). */
  remap?: number[]
}

export interface TileHistory {
  entries: TileHistoryEntry[]
  index: number
}

const HISTORY_LIMIT = 100

export function initHistory(doc: TilesDoc): TileHistory {
  return { entries: [{ doc, label: 'open' }], index: 0 }
}

export function pushHistory(history: TileHistory, doc: TilesDoc, label: string, remap?: number[]): TileHistory {
  const entries = history.entries.slice(0, history.index + 1)
  entries.push({ doc, label, remap })
  const trimmed = entries.slice(Math.max(0, entries.length - HISTORY_LIMIT))
  return { entries: trimmed, index: trimmed.length - 1 }
}

export function undoHistory(history: TileHistory): TileHistory {
  return history.index > 0 ? { ...history, index: history.index - 1 } : history
}

export function redoHistory(history: TileHistory): TileHistory {
  return history.index < history.entries.length - 1 ? { ...history, index: history.index + 1 } : history
}

export function historyDoc(history: TileHistory): TilesDoc {
  return history.entries[history.index].doc
}

export function canUndo(history: TileHistory): boolean {
  return history.index > 0
}

export function canRedo(history: TileHistory): boolean {
  return history.index < history.entries.length - 1
}

/** `mapping[old] = new` → `inverse[new] = old`. Undoing a reorder replays this over maps. */
export function invertMapping(mapping: readonly number[]): number[] {
  const inverse = mapping.slice()
  mapping.forEach((to, from) => (inverse[to] = from))
  return inverse
}

// ── tileset grid selection ──────────────────────────────────────────────────

/** Every index inside the rectangle spanned by two tiles in a `columns`-wide grid. */
export function marqueeIndices(anchor: number, focus: number, columns: number, count: number): number[] {
  const ax = anchor % columns
  const ay = Math.floor(anchor / columns)
  const fx = focus % columns
  const fy = Math.floor(focus / columns)
  const out: number[] = []
  for (let y = Math.min(ay, fy); y <= Math.max(ay, fy); y++) {
    for (let x = Math.min(ax, fx); x <= Math.max(ax, fx); x++) {
      const index = y * columns + x
      if (index < count) out.push(index)
    }
  }
  return out
}

// ── the Spec 10 remap seam ──────────────────────────────────────────────────

/**
 * Dragging tiles around renumbers them, so every `.map.json` drawn with this
 * tileset has to be replayed through `mapping` (`shared/msx/map.ts` →
 * `remapTiles`). The tile editor deliberately does **not** rewrite map files —
 * Spec 10 owns them. It publishes the reorder two ways instead:
 *
 * 1. **Live** — `emitTilesReordered()` fires on every applied reorder (and with
 *    the inverted mapping when one is undone). The map editor calls
 *    `onTilesReordered()` on mount and applies `remapTiles` to any open map
 *    whose `tileset` is `event.path`.
 * 2. **Persisted** — the same records are appended to a `reorderLog` array in
 *    the saved `.tiles.json` (an extra key `normalizeTiles` ignores, so nothing
 *    else in the pipeline sees it). Maps that weren't open can replay the log
 *    from their last-seen entry; the map editor is free to drop entries once it
 *    has consumed them.
 */
export interface TilesReorderEvent {
  /** Project-relative path of the tileset that moved. */
  path: string
  /** `mapping[oldIndex] = newIndex`, straight from `reorderTiles` — or its inverse when a reorder is undone. */
  mapping: number[]
  /** Epoch ms, so a persisted log entry can be matched against what a map already replayed. */
  at: number
}

type ReorderListener = (event: TilesReorderEvent) => void

const reorderListeners = new Set<ReorderListener>()

/** Subscribe (Spec 10). Returns the unsubscribe function. */
export function onTilesReordered(listener: ReorderListener): () => void {
  reorderListeners.add(listener)
  return () => {
    reorderListeners.delete(listener)
  }
}

export function emitTilesReordered(event: TilesReorderEvent): void {
  for (const listener of [...reorderListeners]) listener(event)
}
