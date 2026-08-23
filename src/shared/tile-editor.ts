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

import type { TileMode } from './msx/modes'
import { MSX1_PALETTE_GRB } from './msx/palette'
import {
  blockTileAt,
  MAX_BLOCK,
  MAX_TILES,
  mergeColorByte,
  normalizeTiles,
  paintPixel,
  SC1_GROUP,
  TILE_SIZE,
  tileFromPixels,
  tilePixels,
  setPixelRole,
  TILE_FLAG_COUNT,
  type PaintConflict,
  type TileBlock,
  type TileEntry,
  type TilesDoc
} from './msx/tile'

export interface Point {
  x: number
  y: number
}

export type TileTool = 'pencil' | 'line' | 'rect' | 'fill' | 'spray'

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

/**
 * Paints each point with the row's own foreground or background, which is what
 * left and right mouse buttons do on the canvas. Because it only ever sets or
 * clears pattern bits it cannot introduce a third color into a row, so it has
 * no failure case and no conflict to resolve.
 */
export function applyRoleStroke(
  doc: TilesDoc,
  tileIndex: number,
  points: readonly Point[],
  role: 'fg' | 'bg'
): TilesDoc {
  let current = doc
  for (const { x, y } of points.filter(inTile)) {
    current = setPixelRole(current, tileIndex, x, y, role)
  }
  return current
}

/**
 * Flips one of a tile's eight gameplay bits. What each bit means is the game's
 * business; the editor only stores them, which is why they are numbered rather
 * than named.
 */
export function setTileFlagBit(doc: TilesDoc, tileIndex: number, bit: number, on: boolean): TilesDoc {
  if (tileIndex < 0 || tileIndex >= doc.flags.length || bit < 0 || bit >= TILE_FLAG_COUNT) return doc
  const mask = 1 << bit
  const current = doc.flags[tileIndex]
  const next = on ? current | mask : current & ~mask & 0xff
  if (next === current) return doc
  const flags = doc.flags.slice()
  flags[tileIndex] = next
  return { ...doc, flags }
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

// ── multi-tile blocks ───────────────────────────────────────────────────────

const clampBlock = (value: number): number => Math.min(MAX_BLOCK, Math.max(1, value | 0))

/**
 * Appends `width × height` fresh tiles and names them as a block, so a design
 * bigger than one tile is drawn on one canvas. Returns `doc` unchanged when the
 * bank has no room left.
 *
 * In sc1 the block starts on a `SC1_GROUP` boundary: eight consecutive tiles
 * share one FG/BG pair there, so a block starting mid-group would fight
 * unrelated tiles over colour every time it's recoloured. Up to seven tiles are
 * skipped to buy that; `blockColorGroupWarning` reports the case a block can't
 * avoid.
 */
export function createBlock(doc: TilesDoc, name: string, width: number, height: number): TilesDoc {
  const w = clampBlock(width)
  const h = clampBlock(height)
  const start = doc.mode === 'sc1' ? Math.ceil(doc.count / SC1_GROUP) * SC1_GROUP : doc.count
  if (start + w * h > MAX_TILES) return doc
  const grown = normalizeTiles({ ...doc, count: start + w * h })
  const block: TileBlock = { name, width: w, height: h, tiles: Array.from({ length: w * h }, (_, i) => start + i) }
  return { ...grown, blocks: [...grown.blocks, block] }
}

/** Names an existing rectangle of tiles as a block — the tile grid's marquee, kept. */
export function blockFromTiles(doc: TilesDoc, name: string, width: number, height: number, tiles: readonly number[]): TilesDoc {
  const w = clampBlock(width)
  const h = clampBlock(height)
  const block: TileBlock = {
    name,
    width: w,
    height: h,
    tiles: Array.from({ length: w * h }, (_, i) => {
      const tile = tiles[i] ?? 0
      return tile >= 0 && tile < doc.count ? tile : 0
    })
  }
  return { ...doc, blocks: [...doc.blocks, block] }
}

/** Drops the block. The tiles it pointed at stay in the bank — other blocks or maps may use them. */
export function removeBlock(doc: TilesDoc, index: number): TilesDoc {
  if (!doc.blocks[index]) return doc
  return { ...doc, blocks: doc.blocks.filter((_, i) => i !== index) }
}

export function renameBlock(doc: TilesDoc, index: number, name: string): TilesDoc {
  if (!doc.blocks[index]) return doc
  return { ...doc, blocks: doc.blocks.map((block, i) => (i === index ? { ...block, name } : block)) }
}

/**
 * Splits block-space points into one stroke per tile, in tile-local
 * coordinates. A tile that appears twice in the block collects both cells'
 * points — that is the truth of it: they are one tile.
 */
export function splitBlockPoints(block: TileBlock, points: readonly Point[]): Map<number, Point[]> {
  const out = new Map<number, Point[]>()
  for (const point of points) {
    const hit = blockTileAt(block, point.x, point.y)
    if (!hit) continue
    const list = out.get(hit.tile) ?? []
    list.push({ x: hit.tx, y: hit.ty })
    out.set(hit.tile, list)
  }
  return out
}

/**
 * sc1 only: the colour-group collision the mode can't avoid. Eight consecutive
 * tiles share one FG/BG pair, so a block that doesn't own every tile of every
 * group it touches recolours tiles outside itself.
 *
 * Slots past the current `count` count as shared too: they are empty *today*,
 * but the next tile added lands there and inherits the block's colours, which
 * is the same surprise arriving later.
 */
export function blockColorGroupWarning(doc: TilesDoc, block: TileBlock): string | null {
  if (doc.mode !== 'sc1') return null
  const owned = new Set(block.tiles)
  const shared: number[] = []
  for (const group of new Set(block.tiles.map((tile) => Math.floor(tile / SC1_GROUP)))) {
    for (let tile = group * SC1_GROUP; tile < (group + 1) * SC1_GROUP; tile++) {
      if (!owned.has(tile)) shared.push(tile)
    }
  }
  if (!shared.length) return null
  return `sc1: eight tiles share one FG/BG pair. This block doesn't own tile${shared.length > 1 ? 's' : ''} ${shared.join(', ')} of the group${shared.length > 1 ? 's' : ''} it sits in, so recolouring a row here recolours those too. Size it to whole groups of 8 to avoid it.`
}

/**
 * The tiles a block-wide colour edit must touch, each once. A block may list the
 * same tile twice, and in sc1 eight tiles share one byte — writing that byte
 * twice is harmless, but `swapRowColors` also *inverts the patterns* of the
 * whole group, so a second visit undoes the first.
 */
export function blockColorTargets(doc: TilesDoc, block: TileBlock): number[] {
  const seen = new Set<number>()
  const out: number[] = []
  for (const tile of block.tiles) {
    const key = doc.mode === 'sc1' ? Math.floor(tile / SC1_GROUP) : tile
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tile)
  }
  return out
}

// ── tileset grid selection ──────────────────────────────────────────────────

/** Tiles per row in the tileset sheet before it has been measured — the shape a marquee is a rectangle of. */
export const GRID_COLUMNS = 16

/**
 * How many tiles fit across `width` px at `cell` px each: the sheet wraps into
 * the pane it's given instead of running off the side of it. Never more columns
 * than the bank has tiles, and never fewer than one.
 */
export function fitColumns(width: number, cell: number, count: number): number {
  if (width <= 0) return GRID_COLUMNS
  return Math.max(1, Math.min(Math.max(1, count), Math.floor(width / Math.max(1, cell))))
}

/**
 * The marquee, as a block the canvas can edit directly: select a rectangle of
 * tiles in the sheet and they *are* one image, with no naming step and no copy.
 * Like every group here it owns no pixels, so painting across it paints the
 * tiles themselves — `blockPixels` and `splitBlockPoints` don't care that this
 * one is transient.
 *
 * Null for a single tile, which the canvas shows the plain way. Only the sheet's
 * last row can be short, so a marquee that runs into it keeps the rows it has
 * whole and drops the ragged tail.
 */
export function selectionBlock(selection: readonly number[], columns = GRID_COLUMNS): TileBlock | null {
  if (selection.length < 2) return null
  const xs = selection.map((index) => index % columns)
  const ys = selection.map((index) => Math.floor(index / columns))
  const left = Math.min(...xs)
  const width = Math.max(...xs) - left + 1
  const has = new Set(selection)
  const tiles: number[] = []
  let height = 0
  for (let y = Math.min(...ys); y <= Math.max(...ys); y++) {
    const row = Array.from({ length: width }, (_, i) => y * columns + left + i)
    if (!row.every((tile) => has.has(tile))) break
    tiles.push(...row)
    height++
  }
  return height && tiles.length > 1 ? { name: 'selection', width, height, tiles } : null
}

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

// ── clipboard ───────────────────────────────────────────────────────────────

/**
 * Tiles lifted out of the sheet: their pixels, their per-row colours where the
 * mode has them, and their gameplay flags — a copy of the *tile*, not just its
 * picture. `mode` records where they came from, because sc1 keeps colour per
 * group of eight rather than per tile, so what a paste can carry depends on
 * both ends.
 */
export interface TileClipboard {
  width: number
  height: number
  mode: TileMode
  /** Row-major, `width * height` of them. */
  tiles: { entry: TileEntry; flags: number }[]
}

/** The selection as a rectangle. A single tile is a 1×1 one; a ragged selection is none. */
export function selectionRect(
  selection: readonly number[],
  columns = GRID_COLUMNS
): { width: number; height: number; tiles: number[] } | null {
  if (selection.length === 1) return { width: 1, height: 1, tiles: [...selection] }
  const block = selectionBlock(selection, columns)
  return block && { width: block.width, height: block.height, tiles: block.tiles }
}

export function copyTiles(doc: TilesDoc, selection: readonly number[], columns = GRID_COLUMNS): TileClipboard | null {
  const rect = selectionRect(selection, columns)
  if (!rect) return null
  return {
    width: rect.width,
    height: rect.height,
    mode: doc.mode,
    tiles: rect.tiles.map((index) => ({
      entry: {
        pattern: [...(doc.tiles[index]?.pattern ?? [])],
        color: [...(doc.tiles[index]?.color ?? [])]
      },
      flags: doc.flags[index] ?? 0
    }))
  }
}

/**
 * Writes the clipboard into the bank with its top-left at `at`. Cells that
 * would run past the right edge of the row, or past the end of the bank, are
 * dropped rather than wrapping into the next row — a 3-wide stamp pasted two
 * columns from the edge pastes two columns, not one and a wrapped stray.
 *
 * `normalizeTiles` finishes the job, which is what makes a cross-mode paste
 * safe: colours the destination cannot carry are replaced by its defaults
 * rather than left in an impossible state.
 */
export function pasteTiles(
  doc: TilesDoc,
  clipboard: TileClipboard,
  at: number,
  columns = GRID_COLUMNS
): { doc: TilesDoc; pasted: number } {
  const tiles = doc.tiles.map((tile) => ({ pattern: [...tile.pattern], color: [...tile.color] }))
  const flags = [...doc.flags]
  const left = at % columns
  let pasted = 0
  for (let y = 0; y < clipboard.height; y++) {
    for (let x = 0; x < clipboard.width; x++) {
      const target = at + y * columns + x
      if (left + x >= columns || target >= doc.count) continue
      const source = clipboard.tiles[y * clipboard.width + x]
      if (!source) continue
      tiles[target] = { pattern: [...source.entry.pattern], color: [...source.entry.color] }
      flags[target] = source.flags
      pasted++
    }
  }
  return { doc: pasted ? normalizeTiles({ ...doc, tiles, flags }) : doc, pasted }
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
