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
import { normalizeMap, resizeMap, type MapDoc, type MapLayerKind } from '../../../../shared/msx/map'
import type { TilesDoc } from '../../../../shared/msx/tile'
import { parseResource, serializeResource } from '../../../../shared/msx/resource'
import {
  addLayer as addLayerPure,
  applyStamp,
  canRedo,
  canUndo,
  clearRect,
  copyRect,
  createHistory,
  eraseCells,
  flagBit,
  flagNames,
  floodPoints,
  normalizeSelection,
  paintFlag,
  paintValue,
  pushHistory,
  redo as redoHistory,
  removeLayer as removeLayerPure,
  renameLayer as renameLayerPure,
  replayReorders,
  samePath,
  singleStamp,
  toggleLayerVisible as toggleLayerVisiblePure,
  toggleTileFlag,
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
  tilesetError: string | null
  /** Last tileset `reorderLog` entry (by `at`) this map has folded in; null = never replayed. */
  tilesetReorderSeen: number | null

  activeLayer: number
  tool: MapTool
  filledRect: boolean
  /** The stamp the stamp/paste tool places; `brushTile` is what fill/rect/flood use (its top-left tile). */
  brush: Stamp
  clipboard: Stamp | null

  pickerActive: number
  pickerSelection: number[]
  pickerZoom: number

  zoom: number
  gridVisible: boolean
  screenOutline: boolean
  selection: Rect | null

  flagsMode: boolean
  flagBrush: string | null

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
    tilesetError: null,
    tilesetReorderSeen: null,
    activeLayer: 0,
    tool: 'stamp',
    filledRect: false,
    brush: singleStamp(0),
    clipboard: null,
    pickerActive: 0,
    pickerSelection: [0],
    pickerZoom: 24,
    zoom: 16,
    gridVisible: true,
    screenOutline: true,
    selection: null,
    flagsMode: false,
    flagBrush: null,
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

async function loadTileset(session: MapSession): Promise<void> {
  const tilesetPath = doc(session).tileset
  if (!tilesetPath) {
    session.tileset = null
    session.tilesetError = 'No tileset set — pick one below.'
    return
  }
  try {
    const text = await window.api.invoke('fs:read', { path: tilesetPath })
    const parsed = parseResource(tilesetPath, text)
    if (parsed.kind !== 'tiles') throw new Error(`${tilesetPath} is not a tileset`)
    session.tileset = parsed.doc
    session.tilesetError = null
    await replayPersistedReorders(session, text)
  } catch (error) {
    session.tileset = null
    session.tilesetError = `Couldn't load tileset ${tilesetPath}: ${String(error)}`
  }
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

export async function setTileset(session: MapSession, tilesetPath: string): Promise<void> {
  commit(session, { ...doc(session), tileset: tilesetPath })
  session.tilesetReorderSeen = null
  await loadTileset(session)
}

// ── tool state ───────────────────────────────────────────────────────────

export function setTool(session: MapSession, tool: MapTool): void {
  session.tool = tool
  session.flagsMode = false
}

export function setFlagsMode(session: MapSession, on: boolean): void {
  session.flagsMode = on
  if (!on) return
  session.tool = 'stamp'
  // Jump to the first flags layer, if there is one — painting a flag bit on a tiles layer is a no-op.
  const flagsIndex = doc(session).layers.findIndex((layer) => layer.kind === 'flags')
  if (flagsIndex !== -1) session.activeLayer = flagsIndex
}

export function pickTile(session: MapSession, index: number, indices: number[], stamp: Stamp): void {
  session.pickerActive = index
  session.pickerSelection = indices
  session.brush = stamp
}

// ── painting on the map canvas ───────────────────────────────────────────

/** `points` come from `toolPoints`/`floodPoints` (`from`/`to` in grid cells). Flags mode paints
 *  `session.flagBrush`'s bit instead of a tile; 'erase' clears the bit rather than setting it. */
export function paintDrag(session: MapSession, points: Point[]): void {
  const current = session.preview ?? session.history.present
  const layerIndex = session.activeLayer
  let next: MapDoc
  if (session.flagsMode) {
    const bit = session.flagBrush ? flagBit(current, session.flagBrush) : -1
    next = paintFlag(current, layerIndex, points, bit, session.tool !== 'erase')
  } else if (session.tool === 'stamp') {
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
  const next = session.flagsMode
    ? paintFlag(current, session.activeLayer, points, session.flagBrush ? flagBit(current, session.flagBrush) : -1, true)
    : paintValue(current, session.activeLayer, points, session.brush.tiles[0] ?? 0)
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
  session.tool = 'stamp'
  session.flagsMode = false
}

export function deleteSelection(session: MapSession): void {
  if (!session.selection) return
  commit(session, clearRect(doc(session), session.activeLayer, session.selection))
}

// ── flags ────────────────────────────────────────────────────────────────

export function availableFlags(session: MapSession): string[] {
  return flagNames(doc(session))
}

export function setFlagBrush(session: MapSession, name: string): void {
  session.flagBrush = name
}

export function addFlag(session: MapSession, tileIndex: number, name: string): void {
  const trimmed = name.trim()
  if (!trimmed) return
  commit(session, toggleTileFlag(doc(session), tileIndex, trimmed))
}

export function toggleTileFlagOn(session: MapSession, tileIndex: number, flag: string): void {
  commit(session, toggleTileFlag(doc(session), tileIndex, flag))
}

// ── layers ───────────────────────────────────────────────────────────────

export function addLayer(session: MapSession, kind: MapLayerKind): void {
  const name = kind === 'flags' ? 'collision' : `layer_${doc(session).layers.length}`
  commit(session, addLayerPure(doc(session), kind, name))
}

export function removeLayer(session: MapSession, index: number): void {
  commit(session, removeLayerPure(doc(session), index))
  if (session.activeLayer >= doc(session).layers.length) session.activeLayer = doc(session).layers.length - 1
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
