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
import { sheetCols, type BitmapTilesDoc } from '../../../../shared/msx/bitmap-tile'
import type { TileBlock } from '../../../../shared/msx/tile'
import type { MetaTilesDoc } from '../../../../shared/msx/meta-tile'
import { isMetaKind, parseResource, resourceKindOf, serializeResource } from '../../../../shared/msx/resource'
import { screenPixels } from '../../../../shared/msx/screen'
import { atlasSheet, bitmapTilesetSheet, metaSheet, tilesetSheet, type Sheet } from './sheet'
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
  /** Set when the map draws from a `.btiles.json` — the bitmap tileset proper. */
  bitmapTileset: BitmapTilesDoc | null
  /** Set instead of `tileset` when the map draws in a bitmap mode — see `MapCell`. */
  atlas: ScreenDoc | null
  /**
   * Set when the map draws from a `*.meta-tiles.json` / `*.meta-btiles.json`.
   * The tileset it groups is loaded into `tileset`/`bitmapTileset` as usual, so
   * everything that renders art keeps working; this is only what turns those
   * tiles into the cells the map indexes.
   */
  metaSet: MetaTilesDoc | null
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
    bitmapTileset: null,
    atlas: null,
    metaSet: null,
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
 * Loads whichever kind of tileset the map points at.
 *
 * Four of them now. A `.tiles.json` is the name-table case and carries blocks
 * and a reorder log. A `.btiles.json` is the bitmap tileset: it carries its own
 * tile size, so the map takes its cell geometry from the tileset rather than
 * guessing. A `.screen.json` is the older bitmap path — a picture read as a
 * grid, with anonymous cells and nothing to name. A `.meta-tiles.json` /
 * `.meta-btiles.json` is a meta-tile set, which is not art at all: it is a
 * grouping *over* one of the first two, so the tileset underneath is loaded as
 * well and the map's cells index the groups.
 */
async function loadTileset(session: MapSession): Promise<void> {
  const tilesetPath = doc(session).tileset
  if (!tilesetPath) {
    clearTileset(session)
    session.tilesetError = 'No tileset set — pick one below.'
    return
  }
  try {
    await loadFromPath(session, tilesetPath)
  } catch (error) {
    clearTileset(session)
    session.tilesetError = `Couldn't load tileset ${tilesetPath}: ${String(error)}`
  }
}

function clearTileset(session: MapSession): void {
  session.tileset = null
  session.bitmapTileset = null
  session.atlas = null
  session.metaSet = null
}

/**
 * `meta` is set on the second pass: a meta set names the tileset it groups, and
 * this walks that one link to load the art. It is one level only — a meta set
 * may not reference another meta set, which `validateMetaTiles` has no way to
 * check, so the guard is here.
 */
async function loadFromPath(session: MapSession, path: string, meta: MetaTilesDoc | null = null): Promise<void> {
  const text = await window.api.invoke('fs:read', { path })
  const parsed = parseResource(path, text)
  if (isMetaKind(parsed.kind)) {
    if (meta) throw new Error(`${path} is a meta-tile set of a meta-tile set, which is not a thing`)
    const set = parsed.doc as MetaTilesDoc
    if (!set.tileset) {
      clearTileset(session)
      session.metaSet = set
      session.tilesetError = `${path} does not name a tileset yet — open it and pick one.`
      return
    }
    await loadFromPath(session, set.tileset, set)
    // The map replays the *meta set's* log, because its cells are meta indices.
    // The set replays its own tileset's log, in the meta editor. Two files, two
    // logs, and neither can reach the other's cells.
    if (!session.tilesetError) await replayPersistedReorders(session, text)
    return
  }
  session.metaSet = meta
  if (parsed.kind === 'screen') {
    session.tileset = null
    session.bitmapTileset = null
    session.atlas = parsed.doc
    session.tilesetError = parsed.doc.converted
      ? null
      : `${path} has no converted image yet — open it and run the conversion once.`
    return
  }
  if (parsed.kind === 'btiles') {
    session.tileset = null
    session.bitmapTileset = parsed.doc
    session.atlas = null
    session.tilesetError = null
    reconcileSc3(session, parsed.doc.mode === 'sc3')
    return
  }
  if (parsed.kind !== 'tiles') throw new Error(`${path} is not a tileset`)
  session.tileset = parsed.doc
  session.bitmapTileset = null
  session.atlas = null
  session.tilesetError = null
  // A meta map's cells are metas, so a *tile* reorder must not touch them — the
  // set absorbs it instead, and the map replayed the set's own log above.
  if (!meta) await replayPersistedReorders(session, text)
}

/**
 * Keeps `cell.sc3` honest against the tileset that is actually loaded.
 *
 * `setTileset` mirrors it when the reference changes, but that is the only
 * moment it ever ran — so a map whose tileset was *switched to* SCREEN 3 in the
 * tileset editor, or one written by hand, kept exporting down the V9938 path
 * with nothing on screen to say so. The flag routes the export and the editor
 * has the tileset open in front of it, so it can simply be right.
 *
 * A commit rather than a silent patch: it changes what the file exports, so it
 * belongs in the undo stack and gets saved like any other edit.
 */
function reconcileSc3(session: MapSession, sc3: boolean): void {
  const current = doc(session)
  if (!current.cell || (current.cell.sc3 === true) === sc3) return
  const cell = { ...current.cell }
  if (sc3) cell.sc3 = true
  else delete cell.sc3
  commit(session, { ...current, cell })
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
  const kind = resourceKindOf(tilesetPath)
  const bitmap = kind === 'screen' || kind === 'btiles' || kind === 'metabtiles'
  const current = doc(session)
  // Switching between two tilesets renumbers what the cells point at, which the
  // user can see and fix. Switching *between tiles and metas* changes what a cell
  // means, and every existing value is then meaningless rather than wrong — so
  // that is the one case the grid is cleared (behind `MapSidePanel`'s confirm).
  const nowMeta = isMetaKind(kind)
  const spaceChanged = nowMeta !== (current.meta !== null)
  commit(session, {
    ...current,
    tileset: tilesetPath,
    cell: bitmap ? (current.cell ?? { width: 16, height: 16, cols: 16 }) : null,
    // Read ahead rather than committing a guess and correcting it afterwards:
    // the meta size is the set's own, and two commits would make one action take
    // two undo steps, with the map cleared in the step between.
    meta: nowMeta ? await metaSizeOf(tilesetPath, current.meta) : null,
    layers: spaceChanged
      ? current.layers.map((layer) => ({ ...layer, data: new Array<number>(layer.data.length).fill(0) }))
      : current.layers
  })
  session.tilesetReorderSeen = null
  await loadTileset(session)

  // A bitmap tileset *states* its geometry, so take it rather than guess: the
  // tile size is the tileset's own, and the column count is the sheet's.
  const tiles = session.bitmapTileset
  if (tiles) {
    // `sc3` rides along with the geometry because it *is* geometry as far as the
    // exporter is concerned: a 2×2 SCREEN 3 tile is one name-table entry, so its
    // map is drawn by the VDP rather than blitted, and the exporter never opens
    // the tileset to find that out.
    setCell(session, {
      width: tiles.width,
      height: tiles.height,
      cols: sheetCols(tiles),
      ...(tiles.mode === 'sc3' ? { sc3: true } : {})
    })
    return
  }
  // An atlas only says how many cells fit across it; its cell size is a guess.
  const pixels = session.atlas && screenPixels(session.atlas)
  const cell = doc(session).cell
  if (pixels && cell) setCell(session, { ...cell, cols: Math.max(1, Math.floor(pixels.width / cell.width)) })
}

/**
 * A meta-tile set's size in tiles, read straight from the file. `loadTileset`
 * reads it again a moment later — that is two reads of a few hundred bytes, and
 * cheaper than the alternative, which is committing a placeholder and correcting
 * it. Falls back to what the map had (or 2×2) if the file cannot be read;
 * `loadTileset` is what reports that to the user.
 */
async function metaSizeOf(path: string, fallback: MapDoc['meta']): Promise<MapDoc['meta']> {
  try {
    const parsed = parseResource(path, await window.api.invoke('fs:read', { path }))
    if (!isMetaKind(parsed.kind)) return fallback ?? { width: 2, height: 2 }
    const set = parsed.doc as MetaTilesDoc
    return { width: set.width, height: set.height }
  } catch {
    return fallback ?? { width: 2, height: 2 }
  }
}

/** Cell geometry for a bitmap map. `cols` follows the width unless the caller sets it too. */
export function setCell(session: MapSession, cell: MapCell): void {
  commit(session, { ...doc(session), cell })
}

/** The cell index a layer drawn over another skips; null for "every cell is drawn". */
export function setTransparent(session: MapSession, transparent: number | null): void {
  commit(session, { ...doc(session), transparent })
}

/**
 * What the canvas and the picker draw cells from, whichever kind of tileset
 * loaded — and the one place meta-tiles enter the editor. A meta map's cells are
 * meta indices, so it gets a sheet whose cells *are* the metas, and every pane,
 * tool, selection and undo step above this line stays exactly as it was.
 */
export function sheet(session: MapSession): Sheet | null {
  const cell = doc(session).cell
  const base = session.bitmapTileset
    ? bitmapTilesetSheet(session.bitmapTileset)
    : session.atlas && cell
      ? atlasSheet(session.atlas, cell)
      : session.tileset
        ? tilesetSheet(session.tileset)
        : null
  if (!base) return null
  return session.metaSet ? metaSheet(base, session.metaSet) : base
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
 * The blocks of whichever tileset is loaded. Both kinds carry the same type.
 *
 * None on a meta map: a block's cells are *tile* indices, and this map's cells
 * are meta indices, so stamping one would paint whichever metas happen to share
 * those numbers. The meta set is the grouping a meta map paints with.
 */
export function tilesetBlocks(session: MapSession): TileBlock[] {
  if (session.metaSet) return []
  return (session.tileset ?? session.bitmapTileset)?.blocks ?? []
}

/**
 * Loads one of the tileset's named blocks as the brush. A `TileBlock` *is* a
 * `Stamp` — same width/height/tiles, deliberately — so the design the tile
 * editor drew on one canvas stamps into the map without being converted into
 * anything. The tiles are copied because the brush outlives this tileset copy:
 * a reload replaces it.
 */
export function pickBlock(session: MapSession, index: number): void {
  const block = tilesetBlocks(session)[index]
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
