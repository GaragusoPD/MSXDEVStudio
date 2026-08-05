/**
 * Per-tab state for the map editor (Spec 10 A).
 *
 * Same shape as `editors/tile/session.ts`: a module-level map keyed by tab id
 * (= the project-relative path), so a map keeps its selection, tools and undo
 * stack while the user switches tabs. Every doc mutation goes through the
 * pure functions in `shared/map-editor.ts` and `shared/msx/map.ts` — nothing
 * here knows a hardware rule.
 *
 * Reorder replay (Spec 08's seam, see `shared/tile-editor.ts`): the referenced
 * tileset's `reorderLog` is a sibling key in the raw `.tiles.json`, exactly
 * like the tile editor stores its own log (`normalizeMap` doesn't preserve
 * unknown keys, so the map's "last seen" marker lives the same way — a
 * sibling key on the saved `.map.json`, read/written around `normalizeMap`).
 * Live reorders (while both files happen to be open) are applied immediately
 * via `onTilesReordered`, one subscription for every open map session.
 */

import { shallowReactive } from 'vue'
import { normalizeMap, resizeMap, type MapCell, type MapDoc } from '../../../../shared/msx/map'
import type { ScreenDoc } from '../../../../shared/msx/screen'
import type { TilesDoc } from '../../../../shared/msx/tile'
import { parseResource, resourceKindOf, serializeResource } from '../../../../shared/msx/resource'
import { screenPixels } from '../../../../shared/msx/screen'
import { atlasSheet, tilesetSheet, type Sheet } from './sheet'
import {
  addLayer as addLayerPure,
  applyStamp,
  canRedo,
  canUndo,
  clearRect,
  copyRect,
  createHistory,
  eraseCells,
  floodPoints,
  normalizeSelection,
  paintValue,
  pushHistory,
  redo as redoHistory,
  removeLayer as removeLayerPure,
  renameLayer as renameLayerPure,
  reorderLayer as reorderLayerPure,
  replayReorders,
  samePath,
  singleStamp,
  toggleLayerVisible as toggleLayerVisiblePure,
  toolPoints,
  undo as undoHistory,
  type MapHistory,
  type MapTool,
  type Point,
  type Rect,
  type Stamp
} from '../../../../shared/map-editor'
import { onTilesReordered, type TilesReorderEvent } from '../../../../shared/tile-editor'
import { useTabsStore } from '../../stores/tabsStore'

/** `.map.json` carries the reorder-seen marker as an extra key `normalizeMap` ignores (see module header). */
type SavedMap = MapDoc & { tilesetReorderSeen?: number }

export interface MapSession {
  path: string
  history: MapHistory
  loading: boolean
  error: string | null
  dirty: boolean

  tileset: TilesDoc | null
  /** Set instead of `tileset` when the map draws in a bitmap mode — see `MapCell`. */
  atlas: ScreenDoc | null
  tilesetError: string | null
  /** Last tileset `reorderLog` entry (by `at`) this map has folded in; null = never replayed. */
  tilesetReorderSeen: number | null

  activeLayer: number
  tool: MapTool
  filledRect: boolean
  /** The stamp the stamp/paste tool places; `brushTile` is what fill/rect/flood use (its top-left tile). */
  brush: Stamp
  /** Index into the tileset's `blocks` when the brush came from a named block; null when it came from the picker. */
  brushBlock: number | null
  clipboard: Stamp | null

  pickerActive: number
  pickerSelection: number[]
  pickerZoom: number

  zoom: number
  gridVisible: boolean
  screenOutline: boolean
  selection: Rect | null


  status: string
  /**
   * Doc for the drag in progress; `doc()` reads this over `history.present` so the
   * canvas updates live without touching the undo stack until the drag ends — the
   * same role `SpriteCanvas.vue`'s local `livePreview` plays, just hoisted into the
   * session so both the canvas and picker can react to it.
   */
  preview: MapDoc | null
}

const sessions = new Map<string, MapSession>()

export function mapSession(path: string): MapSession {
  const existing = sessions.get(path)
  if (existing) return existing
  const doc = normalizeMap({})
  const session = shallowReactive<MapSession>({
    path,
    history: createHistory(doc),
    loading: true,
    error: null,
    dirty: false,
    tileset: null,
    atlas: null,
    tilesetError: null,
    tilesetReorderSeen: null,
    activeLayer: 0,
    tool: 'stamp',
    filledRect: false,
    brush: singleStamp(0),
    brushBlock: null,
    clipboard: null,
    pickerActive: 0,
    pickerSelection: [0],
    pickerZoom: 24,
    zoom: 16,
    gridVisible: true,
    screenOutline: true,
    selection: null,
    status: '',
    preview: null
  })
  sessions.set(path, session)
  void load(session)
  return session
}

/** Drops sessions for tabs that were closed. Called by the tab component when the tab set changes. */
export function pruneMapSessions(openPaths: Set<string>): void {
  for (const path of [...sessions.keys()]) if (!openPaths.has(path)) sessions.delete(path)
}

export function doc(session: MapSession): MapDoc {
  return session.preview ?? session.history.present
}

async function load(session: MapSession): Promise<void> {
  try {
    const text = await window.api.invoke('fs:read', { path: session.path })
    // A brand-new file created via the Explorer is empty — that's a fresh map, not an error.
    let raw: unknown = {}
    try {
      raw = text.trim() ? JSON.parse(text) : {}
    } catch {
      raw = {}
    }
    const parsedDoc = normalizeMap(raw)
    session.history = createHistory(parsedDoc)
    session.tilesetReorderSeen = typeof (raw as SavedMap).tilesetReorderSeen === 'number' ? (raw as SavedMap).tilesetReorderSeen! : null
    session.error = null
    await loadTileset(session)
  } catch (error) {
    session.error = `Couldn't open ${session.path}: ${String(error)}`
  } finally {
    session.loading = false
  }
}

/**
 * Loads whichever kind of tileset the map points at. A `.tiles.json` is the
 * name-table case and carries blocks and a reorder log; a `.screen.json` is a
 * bitmap atlas, which has neither — its cells are anonymous rectangles, so
 * there is nothing to reorder and nothing to name.
 */
async function loadTileset(session: MapSession): Promise<void> {
  const tilesetPath = doc(session).tileset
  if (!tilesetPath) {
    session.tileset = null
    session.atlas = null
    session.tilesetError = 'No tileset set — pick one below.'
    return
  }
  try {
    const text = await window.api.invoke('fs:read', { path: tilesetPath })
    const parsed = parseResource(tilesetPath, text)
    if (parsed.kind === 'screen') {
      session.tileset = null
      session.atlas = parsed.doc
      session.tilesetError = parsed.doc.converted
        ? null
        : `${tilesetPath} has no converted image yet — open it and run the conversion once.`
      return
    }
    if (parsed.kind !== 'tiles') throw new Error(`${tilesetPath} is neither a tileset nor a screen`)
    session.tileset = parsed.doc
    session.atlas = null
    session.tilesetError = null
    await replayPersistedReorders(session, text)
  } catch (error) {
    session.tileset = null
    session.atlas = null
    session.tilesetError = `Couldn't load tileset ${tilesetPath}: ${String(error)}`
  }
}

/**
 * Re-reads the tileset from disk. A map draws with its *own* copy of the
 * tileset, loaded when the map was opened, so tiles edited and saved in the
 * tile editor afterwards don't reach it by themselves — this is what fetches
 * them. Any reorders recorded since are replayed on the way in, exactly as they
 * are when a map is opened.
 */
export async function reloadTileset(session: MapSession): Promise<void> {
  await loadTileset(session)
}

/** On open: fold in any tileset reorders this map missed while it wasn't open, behind one confirm dialog. */
async function replayPersistedReorders(session: MapSession, tilesetText: string): Promise<void> {
  const raw = JSON.parse(tilesetText) as { reorderLog?: TilesReorderEvent[] }
  const log = Array.isArray(raw.reorderLog) ? raw.reorderLog : []
  const result = replayReorders(doc(session), log, session.tilesetReorderSeen)
  if (!result.applied) return
  const confirmed = window.confirm(
    `The tileset "${doc(session).tileset}" was reorganized ${result.applied} time${result.applied === 1 ? '' : 's'} ` +
      `since this map was last opened. Renumber this map's tiles to match?`
  )
  if (!confirmed) return
  session.history = createHistory(result.doc)
  session.tilesetReorderSeen = result.seenAt
  markDirty(session)
}

/**
 * Reorders `tileset.tiles` by `mapping` (`mapping[old] = new`) — a live, in-memory refresh of the
 * picker/canvas preview only. The persisted file (and its true group-color layout for sc1) is the
 * source of truth once the tileset is saved and this map is reopened.
 * ponytail: sc1's per-group colors don't remap 1:1 with individual tile moves, so an sc1 tileset's
 * live preview may briefly look off until then — self-heals on the next open, narrow enough to skip
 * a full sc1-aware remap for a cosmetic, transient window.
 */
function remapTilesetPreview(tileset: TilesDoc, mapping: readonly number[]): TilesDoc {
  const tiles = tileset.tiles.slice()
  tileset.tiles.forEach((tile, index) => {
    const to = mapping[index]
    if (to !== undefined) tiles[to] = tile
  })
  return { ...tileset, tiles }
}

/** Live reorders (Spec 08's `onTilesReordered`): applied to every open map that references the tileset, no extra
 *  confirm — the tile editor's own drag-reorder confirm already covers this consequence. One subscription for
 *  every session, matching the `sessions` map pattern used elsewhere in this file. */
onTilesReordered((event) => {
  for (const session of sessions.values()) {
    if (!samePath(doc(session).tileset, event.path)) continue
    const { doc: next } = replayReorders(doc(session), [event], null)
    commit(session, next)
    session.tilesetReorderSeen = event.at
    if (session.tileset) session.tileset = remapTilesetPreview(session.tileset, event.mapping)
  }
})

export async function saveSession(session: MapSession): Promise<void> {
  const content: SavedMap = { ...doc(session) }
  if (session.tilesetReorderSeen !== null) content.tilesetReorderSeen = session.tilesetReorderSeen
  await window.api.invoke('fs:write', { path: session.path, content: serializeResource({ kind: 'map', doc: content }) })
  session.dirty = false
  useTabsStore().setDirty(session.path, false)
  session.status = 'Saved'
}

function markDirty(session: MapSession): void {
  session.dirty = true
  useTabsStore().setDirty(session.path, true)
}

/** Every mutation goes through here: pushes one undo step and marks the tab dirty (no-op if nothing changed). */
export function commit(session: MapSession, next: MapDoc): void {
  const history = pushHistory(session.history, next)
  if (history === session.history) return
  session.history = history
  markDirty(session)
}

/**
 * Points the map at a tileset, and switches it between the name-table and
 * bitmap worlds if the kind changed — `cell` is what tells every other part of
 * the app which one this is, so it has to move with the reference rather than
 * be set separately and forgotten.
 */
export async function setTileset(session: MapSession, tilesetPath: string): Promise<void> {
  const bitmap = resourceKindOf(tilesetPath) === 'screen'
  const current = doc(session)
  commit(session, {
    ...current,
    tileset: tilesetPath,
    cell: bitmap ? (current.cell ?? { width: 16, height: 16, cols: 16 }) : null
  })
  session.tilesetReorderSeen = null
  await loadTileset(session)
  // The atlas image says how many cells fit across it; only its size is a guess.
  const pixels = session.atlas && screenPixels(session.atlas)
  const cell = doc(session).cell
  if (pixels && cell) setCell(session, { ...cell, cols: Math.max(1, Math.floor(pixels.width / cell.width)) })
}

/** Cell geometry for a bitmap map. `cols` follows the width unless the caller sets it too. */
export function setCell(session: MapSession, cell: MapCell): void {
  commit(session, { ...doc(session), cell })
}

/** What the canvas and the picker draw cells from, whichever kind of tileset loaded. */
export function sheet(session: MapSession): Sheet | null {
  const cell = doc(session).cell
  if (session.atlas && cell) return atlasSheet(session.atlas, cell)
  return session.tileset ? tilesetSheet(session.tileset) : null
}

// ── tool state ───────────────────────────────────────────────────────────

export function setTool(session: MapSession, tool: MapTool): void {
  session.tool = tool
}

export function pickTile(session: MapSession, index: number, indices: number[], stamp: Stamp): void {
  session.pickerActive = index
  session.pickerSelection = indices
  session.brush = stamp
  session.brushBlock = null
}

/**
 * Loads one of the tileset's named blocks as the brush. A `TileBlock` *is* a
 * `Stamp` — same width/height/tiles, deliberately — so the design the tile
 * editor drew on one canvas stamps into the map without being converted into
 * anything. The tiles are copied because the brush outlives this tileset copy:
 * a reload replaces it.
 */
export function pickBlock(session: MapSession, index: number): void {
  const block = session.tileset?.blocks[index]
  if (!block) return
  session.brush = { width: block.width, height: block.height, tiles: [...block.tiles] }
  session.pickerActive = block.tiles[0] ?? 0
  session.pickerSelection = [...new Set(block.tiles)]
  session.brushBlock = index
  // Same as pasting: the brush is loaded, now the user clicks to place it.
  session.tool = 'stamp'
}

// ── painting on the map canvas ───────────────────────────────────────────

/** `points` come from `toolPoints`/`floodPoints` (`from`/`to` in grid cells). */
export function paintDrag(session: MapSession, points: Point[]): void {
  const current = session.preview ?? session.history.present
  const layerIndex = session.activeLayer
  let next: MapDoc
  if (session.tool === 'stamp') {
    next = applyStamp(current, layerIndex, session.brush, points)
  } else if (session.tool === 'erase') {
    next = eraseCells(current, layerIndex, points)
  } else {
    next = paintValue(current, layerIndex, points, session.brush.tiles[0] ?? 0)
  }
  session.preview = next
}

/** Ends the drag started by `paintDrag`: folds the preview into one undo step (no-op if nothing changed). */
export function finishDrag(session: MapSession): void {
  const preview = session.preview
  session.preview = null
  if (preview && preview !== session.history.present) commit(session, preview)
}

export function fillAt(session: MapSession, start: Point): void {
  const current = doc(session)
  const layer = current.layers[session.activeLayer]
  if (!layer) return
  const points = floodPoints(current, layer, start)
  if (!points.length) return
  const next = paintValue(current, session.activeLayer, points, session.brush.tiles[0] ?? 0)
  commit(session, next)
}

/** `tool` is whichever of stamp/erase/rect is active — the canvas dispatches 'fill' to `fillAt` instead. */
export function dragPoints(tool: 'stamp' | 'erase' | 'rect', from: Point, to: Point, filled: boolean): Point[] {
  return toolPoints(tool, from, to, filled)
}

// ── selection / clipboard ───────────────────────────────────────────────

export function setSelection(session: MapSession, a: Point, b: Point): void {
  session.selection = normalizeSelection(doc(session), a, b)
}

export function clearSelection(session: MapSession): void {
  session.selection = null
}

export function copySelection(session: MapSession): void {
  const current = doc(session)
  const layer = current.layers[session.activeLayer]
  if (!layer || !session.selection) return
  session.clipboard = copyRect(current, layer, session.selection)
  session.status = `Copied ${session.clipboard.width}×${session.clipboard.height}`
}

/** Loads the clipboard as the current brush and switches to the stamp tool — the user then clicks to place it. */
export function pasteClipboard(session: MapSession): void {
  if (!session.clipboard) return
  session.brush = session.clipboard
  session.brushBlock = null
  session.tool = 'stamp'
}

export function deleteSelection(session: MapSession): void {
  if (!session.selection) return
  commit(session, clearRect(doc(session), session.activeLayer, session.selection))
}

// ── layers ───────────────────────────────────────────────────────────────

export function addLayer(session: MapSession): void {
  commit(session, addLayerPure(doc(session), `layer_${doc(session).layers.length}`))
}

export function removeLayer(session: MapSession, index: number): void {
  commit(session, removeLayerPure(doc(session), index))
  if (session.activeLayer >= doc(session).layers.length) session.activeLayer = doc(session).layers.length - 1
}

/** Keeps the selection on the layer the user was editing, wherever it landed. */
export function reorderLayer(session: MapSession, from: number, to: number): void {
  const active = doc(session).layers[session.activeLayer]
  commit(session, reorderLayerPure(doc(session), from, to))
  session.activeLayer = Math.max(0, doc(session).layers.indexOf(active))
}

export function renameLayer(session: MapSession, index: number, name: string): void {
  commit(session, renameLayerPure(doc(session), index, name))
}

export function toggleLayerVisible(session: MapSession, index: number): void {
  commit(session, toggleLayerVisiblePure(doc(session), index))
}

export function selectLayer(session: MapSession, index: number): void {
  session.activeLayer = index
}

// ── size / validation ──────────────────────────────────────────────────

export function resize(session: MapSession, width: number, height: number): void {
  commit(session, resizeMap(doc(session), width, height))
}

// ── undo/redo ───────────────────────────────────────────────────────────

export function undo(session: MapSession): void {
  const next = undoHistory(session.history)
  if (next === session.history) return
  session.history = next
  session.selection = null
  session.preview = null
  markDirty(session)
}

export function redo(session: MapSession): void {
  const next = redoHistory(session.history)
  if (next === session.history) return
  session.history = next
  session.selection = null
  session.preview = null
  markDirty(session)
}

export { canRedo, canUndo }
