/**
 * Map editor (Spec 10 A) — the editor-side logic that isn't hardware
 * knowledge: what a tool touches, stamp/fill/rect/erase application,
 * rectangular select + copy/paste (copy is just a `Stamp`), undo/redo, and the
 * reorder-replay seam that consumes Spec 08's `tilesetReordered` events.
 *
 * Gameplay bits are not here: they belong to the tileset as `TilesDoc.flags`,
 * eight per tile, so every map drawn with that tileset agrees about which tiles
 * are solid.
 *
 * Everything here is pure, so it lives in `shared/` where Vitest already
 * runs; `editors/map/*.vue` is a thin shell on top. All *hardware* rules —
 * layer shape, tile-index range, byte export — stay in `shared/msx/map.ts`
 * and are only ever called from here.
 */

import { cellIndex, getCell, remapTiles, type MapDoc, type MapLayer } from './msx/map'
import { linePoints, rectPoints, type Point, type TilesReorderEvent } from './tile-editor'
import type { History } from './history'

export type { Point }

// ── stamps (tile-picker marquee, clipboard, single-tile brush) ─────────────

export interface Stamp {
  width: number
  height: number
  /** `width*height` tile indices, row-major. */
  tiles: number[]
}

export function singleStamp(tile: number): Stamp {
  return { width: 1, height: 1, tiles: [tile] }
}

/** Builds a `Stamp` from a tile-picker marquee: `anchor`/`focus` are tile indices in a `columns`-wide grid. Slots beyond `count` become 0. */
export function stampFromMarquee(anchor: number, focus: number, columns: number, count: number): Stamp {
  const ax = anchor % columns
  const ay = Math.floor(anchor / columns)
  const fx = focus % columns
  const fy = Math.floor(focus / columns)
  const x0 = Math.min(ax, fx)
  const x1 = Math.max(ax, fx)
  const y0 = Math.min(ay, fy)
  const y1 = Math.max(ay, fy)
  const tiles: number[] = []
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const index = y * columns + x
      tiles.push(index < count ? index : 0)
    }
  }
  return { width: x1 - x0 + 1, height: y1 - y0 + 1, tiles }
}

// ── layer mutation primitives ───────────────────────────────────────────────

function withLayerData(doc: MapDoc, layerIndex: number, data: number[]): MapDoc {
  const layer = doc.layers[layerIndex]
  if (!layer) return doc
  const layers = doc.layers.slice()
  layers[layerIndex] = { ...layer, data }
  return { ...doc, layers }
}

/** Stamps `stamp`'s top-left corner at each of `points`, clipped to the grid. Later points win where they overlap. */
export function applyStamp(doc: MapDoc, layerIndex: number, stamp: Stamp, points: readonly Point[]): MapDoc {
  const layer = doc.layers[layerIndex]
  if (!layer) return doc
  const data = layer.data.slice()
  let changed = false
  for (const p of points) {
    for (let sy = 0; sy < stamp.height; sy++) {
      const y = p.y + sy
      if (y < 0 || y >= doc.height) continue
      for (let sx = 0; sx < stamp.width; sx++) {
        const x = p.x + sx
        if (x < 0 || x >= doc.width) continue
        const value = stamp.tiles[sy * stamp.width + sx] ?? 0
        const index = cellIndex(doc, x, y)
        if (data[index] !== value) {
          data[index] = value
          changed = true
        }
      }
    }
  }
  return changed ? withLayerData(doc, layerIndex, data) : doc
}

/** Sets every point in `points` to one `value` — the fill/rect/erase tools (a uniform tile index). */
export function paintValue(doc: MapDoc, layerIndex: number, points: readonly Point[], value: number): MapDoc {
  const layer = doc.layers[layerIndex]
  if (!layer) return doc
  const data = layer.data.slice()
  let changed = false
  for (const p of points) {
    if (p.x < 0 || p.y < 0 || p.x >= doc.width || p.y >= doc.height) continue
    const index = cellIndex(doc, p.x, p.y)
    if (data[index] !== value) {
      data[index] = value
      changed = true
    }
  }
  return changed ? withLayerData(doc, layerIndex, data) : doc
}

export function eraseCells(doc: MapDoc, layerIndex: number, points: readonly Point[]): MapDoc {
  return paintValue(doc, layerIndex, points, 0)
}

// ── tools → the cells they touch ────────────────────────────────────────────

export type MapTool = 'stamp' | 'fill' | 'rect' | 'erase'

/**
 * `from` is the drag origin (or previous drag sample), `to` the current cell.
 * `linePoints`/`rectPoints` (`shared/tile-editor.ts`) are grid-size agnostic,
 * so the map editor reuses them as-is rather than re-deriving Bresenham/rect
 * math. Flood fill needs the layer's data, so it's `floodPoints` below.
 */
export function toolPoints(tool: 'stamp' | 'erase' | 'rect', from: Point, to: Point, filled: boolean): Point[] {
  return tool === 'rect' ? rectPoints(from, to, filled) : linePoints(from, to)
}

/** 4-connected flood over one layer's current values, matching the start cell. */
export function floodPoints(doc: MapDoc, layer: MapLayer, start: Point): Point[] {
  if (start.x < 0 || start.y < 0 || start.x >= doc.width || start.y >= doc.height) return []
  const target = getCell(layer, doc, start.x, start.y)
  const seen = new Set<number>()
  const out: Point[] = []
  const stack: Point[] = [start]
  while (stack.length) {
    const p = stack.pop() as Point
    if (p.x < 0 || p.y < 0 || p.x >= doc.width || p.y >= doc.height) continue
    const key = cellIndex(doc, p.x, p.y)
    if (seen.has(key) || getCell(layer, doc, p.x, p.y) !== target) continue
    seen.add(key)
    out.push(p)
    stack.push({ x: p.x + 1, y: p.y }, { x: p.x - 1, y: p.y }, { x: p.x, y: p.y + 1 }, { x: p.x, y: p.y - 1 })
  }
  return out
}

// ── rectangular select + copy/paste ─────────────────────────────────────────

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Normalizes two dragged corners into a rect clipped to the grid (inclusive of both corners). */
export function normalizeSelection(doc: MapDoc, a: Point, b: Point): Rect {
  const x0 = Math.max(0, Math.min(a.x, b.x))
  const y0 = Math.max(0, Math.min(a.y, b.y))
  const x1 = Math.min(doc.width - 1, Math.max(a.x, b.x))
  const y1 = Math.min(doc.height - 1, Math.max(a.y, b.y))
  return { x: x0, y: y0, width: Math.max(1, x1 - x0 + 1), height: Math.max(1, y1 - y0 + 1) }
}

/** Copies a rect of one layer into a `Stamp` — paste is just `applyStamp` with this. */
export function copyRect(doc: MapDoc, layer: MapLayer, rect: Rect): Stamp {
  const tiles: number[] = []
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) tiles.push(getCell(layer, doc, x, y))
  }
  return { width: rect.width, height: rect.height, tiles }
}

/** Clears every cell in `rect` on `layerIndex` — the rect-select "delete". */
export function clearRect(doc: MapDoc, layerIndex: number, rect: Rect): MapDoc {
  const points: Point[] = []
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) points.push({ x, y })
  }
  return paintValue(doc, layerIndex, points, 0)
}

// ── layer list ops ───────────────────────────────────────────────────────────

export function addLayer(doc: MapDoc, name: string): MapDoc {
  const data = new Array<number>(doc.width * doc.height).fill(0)
  return { ...doc, layers: [...doc.layers, { name, kind: 'tiles', data, visible: true, placements: [] }] }
}

/** Refuses to drop the last layer — a map with zero layers has nothing to paint. */
export function removeLayer(doc: MapDoc, index: number): MapDoc {
  if (doc.layers.length <= 1 || !doc.layers[index]) return doc
  return { ...doc, layers: doc.layers.filter((_, i) => i !== index) }
}

/** Array order is the draw order (layer 0 is the opaque base) and the order the tables export in. */
export function reorderLayer(doc: MapDoc, from: number, to: number): MapDoc {
  if (from === to || !doc.layers[from] || !doc.layers[to]) return doc
  const layers = doc.layers.slice()
  layers.splice(to, 0, ...layers.splice(from, 1))
  return { ...doc, layers }
}

export function renameLayer(doc: MapDoc, index: number, name: string): MapDoc {
  if (!doc.layers[index]) return doc
  const layers = doc.layers.slice()
  layers[index] = { ...layers[index], name }
  return { ...doc, layers }
}

export function toggleLayerVisible(doc: MapDoc, index: number): MapDoc {
  if (!doc.layers[index]) return doc
  const layers = doc.layers.slice()
  layers[index] = { ...layers[index], visible: !layers[index].visible }
  return { ...doc, layers }
}

// ── undo/redo ───────────────────────────────────────────────────────────────

/** The shared past/present/future stack, over this editor's document. */
export type MapHistory = History<MapDoc>
export { createHistory, pushHistory, undo, redo, canUndo, canRedo } from './history'

// ── the Spec 08 reorder-replay seam ──────────────────────────────────────────

/** Case/slash/`./`-insensitive project-relative path comparison — matches `TileMapPreview.vue`'s own normalization. */
export function normalizeRelPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
}

export function samePath(a: string, b: string): boolean {
  return normalizeRelPath(a) === normalizeRelPath(b)
}

/** Events in `log` not yet folded into the map: every event newer than `seenAt`, or all of them when `seenAt` is null. */
export function pendingReorders(log: readonly TilesReorderEvent[], seenAt: number | null): TilesReorderEvent[] {
  return seenAt === null ? [...log] : log.filter((event) => event.at > seenAt)
}

/**
 * Applies every pending mapping (oldest first) via `remapTiles`. Returns the
 * updated doc, the new "seen" marker (`seenAt` unchanged when nothing was
 * pending), and how many events were applied — the caller uses the count to
 * decide whether the one confirm dialog Spec 10 promises even needs to show.
 */
export function replayReorders(
  doc: MapDoc,
  log: readonly TilesReorderEvent[],
  seenAt: number | null
): { doc: MapDoc; seenAt: number | null; applied: number } {
  const pending = pendingReorders(log, seenAt)
  let next = doc
  for (const event of pending) next = remapTiles(next, event.mapping)
  return { doc: next, seenAt: pending.length ? pending[pending.length - 1].at : seenAt, applied: pending.length }
}
