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

import { cellIndex, getCell, remapTiles, type MapDoc, type MapLayer, type MetaPlacement } from './msx/map'
import type { TileEdit } from './msx/meta-paint'
import { linePoints, rectPoints, type Point, type TilesReorderEvent } from './tile-editor'
import type { History } from './history'
import {
  composeFloat,
  fillRect,
  floatFootprint,
  normalizeRect,
  rectInside,
  rectsOverlap,
  type Float,
  type Rect
} from './floating'

export type { Point, Rect }

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

/** `select` drags a rectangle and moves it — see `shared/floating.ts`; the others paint. */
export type MapTool = 'stamp' | 'fill' | 'rect' | 'erase' | 'select'

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

/** Normalizes two dragged corners into a rect clipped to the grid (inclusive of both corners). */
export function normalizeSelection(doc: MapDoc, a: Point, b: Point): Rect {
  return normalizeRect(a, b, doc.width, doc.height)
}

/** Copies a rect of one layer into a `Stamp` — paste is just `applyStamp` with this. */
export function copyRect(doc: MapDoc, layer: MapLayer, rect: Rect): Stamp {
  const tiles: number[] = []
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) tiles.push(getCell(layer, doc, x, y))
  }
  return { width: rect.width, height: rect.height, tiles }
}

/**
 * Clears every cell in `rect` on `layerIndex` — the rect-select "delete" —
 * and drops the record of every baked meta-tile whose cells that wiped.
 */
export function clearRect(doc: MapDoc, layerIndex: number, rect: Rect): MapDoc {
  const layer = doc.layers[layerIndex]
  if (!layer) return doc
  const data = fillRect(layer.data, doc.width, doc.height, rect, 0)
  return withoutBakedIn(data === layer.data ? doc : withLayerData(doc, layerIndex, data), layerIndex, [rect]).doc
}

// ── the floating selection ───────────────────────────────────────────────────

/** Where a placed meta-tile stands, as a rectangle of cells; null when its slot names no meta. */
function placementRect(doc: MapDoc, placement: MetaPlacement): Rect | null {
  const ref = doc.metas[placement.slot]
  return ref ? { x: placement.x, y: placement.y, width: ref.width, height: ref.height } : null
}

/**
 * Drops the record of every baked placement whose footprint meets one of
 * `rects`, except those in `keep`.
 *
 * A baked placement is a receipt: it says the grid holds the meta's tiles at
 * its cells. Once something else has been written there it is a lie, and the
 * next unbake would wipe art the user put down afterwards. Live placements are
 * left alone — writing under one is writing the hole it shows through.
 */
export function withoutBakedIn(
  doc: MapDoc,
  layerIndex: number,
  rects: readonly Rect[],
  keep: ReadonlySet<number> = new Set()
): { doc: MapDoc; dropped: number } {
  const layer = doc.layers[layerIndex]
  if (!layer?.placements.some((placement) => placement.baked)) return { doc, dropped: 0 }
  const placements = layer.placements.filter((placement, index) => {
    if (!placement.baked || keep.has(index)) return true
    const rect = placementRect(doc, placement)
    return !rect || !rects.some((touched) => rectsOverlap(rect, touched))
  })
  const dropped = layer.placements.length - placements.length
  if (!dropped) return { doc, dropped: 0 }
  const layers = doc.layers.slice()
  layers[layerIndex] = { ...layer, placements }
  return { doc: { ...doc, layers }, dropped }
}

export interface MapFloatDrop {
  doc: MapDoc
  /** Baked placements whose cells the drop overwrote, and whose records it dropped. */
  dropped: number
  /** Placements carried by a move whose corner ended up off the map, and so were removed. */
  lost: number
}

/**
 * Drops a float of cells onto one layer.
 *
 * A move (a float with `from`) takes along every meta-tile placed wholly
 * inside the rectangle it came from — they ride the tiles they sit on, baked or
 * live, and keep their stacking order. One whose corner lands off the map is
 * removed, because a placement cannot stand outside it. A paste or a copy-drag
 * carries tiles only, like the clipboard does.
 *
 * Every other baked placement the drop writes over, at either end, loses its
 * record (`withoutBakedIn`).
 */
export function dropMapFloat(doc: MapDoc, layerIndex: number, float: Float): MapFloatDrop {
  const layer = doc.layers[layerIndex]
  if (!layer) return { doc, dropped: 0, lost: 0 }
  const data = composeFloat(layer.data, doc.width, doc.height, float, 0)
  const dx = float.x - (float.from?.x ?? float.x)
  const dy = float.y - (float.from?.y ?? float.y)
  const moved = new Set<number>()
  let lost = 0
  const placements: MetaPlacement[] = []
  for (const placement of layer.placements) {
    const rect = float.from && placementRect(doc, placement)
    if (!rect || !rectInside(rect, float.from!)) {
      placements.push(placement)
      continue
    }
    const x = placement.x + dx
    const y = placement.y + dy
    if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) {
      lost++
      continue
    }
    moved.add(placements.length)
    placements.push({ ...placement, x, y })
  }
  if (data === layer.data && !moved.size && !lost) return { doc, dropped: 0, lost: 0 }
  const layers = doc.layers.slice()
  layers[layerIndex] = { ...layer, data, placements }
  const next = { ...doc, layers }
  const touched = floatFootprint(float, doc.width, doc.height)
  const { doc: settled, dropped } = withoutBakedIn(next, layerIndex, touched, moved)
  return { doc: settled, dropped, lost }
}

/** The placements a move of `rect` would carry — what the canvas outlines as part of the float. */
export function placementsInside(doc: MapDoc, layerIndex: number, rect: Rect): number[] {
  const layer = doc.layers[layerIndex]
  if (!layer) return []
  const out: number[] = []
  layer.placements.forEach((placement, index) => {
    const at = placementRect(doc, placement)
    if (at && rectInside(at, rect)) out.push(index)
  })
  return out
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

/**
 * One undo step: the map, plus the tiles an `edit` stroke overwrote to get
 * here. Absent on every step that only moved cell references — a `fork` stroke
 * appends and never destroys art, so it needs no inverse (its orphans are
 * Compact's job, exactly as in the meta editor).
 */
export interface MapEntry {
  doc: MapDoc
  tileEdits?: TileEdit[]
}

/** The shared past/present/future stack, over this editor's document. */
export type MapHistory = History<MapEntry>
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
