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
import {
  addMetaRef,
  bankForRow,
  MAX_MAP_METAS,
  metaSlotOf,
  movePlacement,
  normalizeMap,
  placeMeta,
  placementAt,
  placementCount,
  metaRefFrom,
  removePlacement,
  resizeMap,
  SCREEN_ROWS,
  type MetaRef,
  setPlacementBaked,
  type MapCell,
  type MapDoc
} from '../../../../shared/msx/map'
import type { ScreenDoc } from '../../../../shared/msx/screen'
import {
  BANK_COUNT,
  bankTilePixels,
  blankTileEntry,
  isBanked,
  MAX_TILES,
  normalizeTiles,
  packBankedTiles,
  TILE_SIZE,
  tilePixels,
  type TileEntry,
  type TilesDoc
} from '../../../../shared/msx/tile'
import { sheetCols, type BitmapTilesDoc } from '../../../../shared/msx/bitmap-tile'
import type { TileBlock } from '../../../../shared/msx/tile'
import { normalizeMetaTile, type MetaTileDoc } from '../../../../shared/msx/meta-tile'
import {
  paintGrid,
  sameEntry,
  sprayPoints,
  type PaintGridResult,
  type TileEdit
} from '../../../../shared/msx/meta-paint'
import { defaultExport, parseResource, resourceKindOf, serializeResource } from '../../../../shared/msx/resource'
import { screenPixels } from '../../../../shared/msx/screen'
import { atlasSheet, bitmapTilesetSheet, tilesetSheet, type Sheet } from './sheet'
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
// `toolPoints` under an alias: `map-editor` exports a cell-space one of the
// same name (imported above), and the two take different arguments.
import {
  fillPoints,
  onTilesReordered,
  toolPoints as pixelToolPoints,
  type TileTool
} from '../../../../shared/tile-editor'
import { bankBudgetLabel } from '../tile/session'
import { useResourcesStore } from '../../stores/resourcesStore'
import { useTabsStore } from '../../stores/tabsStore'
import { useTilesetStore } from '../../stores/tilesetStore'
import { watchResourceFile } from '../external-changes'

/** `.map.json` carries the reorder-seen marker as an extra key `normalizeMap` ignores (see module header). */
type SavedMap = MapDoc & { tilesetReorderSeen?: number }

export interface MapSession {
  path: string
  /** Drops this session's file watch. */
  stopWatching: (() => void) | null
  history: MapHistory
  loading: boolean
  error: string | null
  dirty: boolean

  /**
   * Drops this session's subscription to the shared tileset (`useTilesetStore`).
   * Re-established every time `loadFromPath` loads a `.tiles.json` — the path it
   * points at moves with `setTileset`, unlike the map's own file. Null whenever
   * the map has no pattern tileset loaded (a bitmap tileset, an atlas, or none).
   */
  stopWatchingTileset: (() => void) | null
  tileset: TilesDoc | null
  /** Set when the map draws from a `.btiles.json` — the bitmap tileset proper. */
  bitmapTileset: BitmapTilesDoc | null
  /** Set instead of `tileset` when the map draws in a bitmap mode — see `MapCell`. */
  atlas: ScreenDoc | null
  /**
   * The `.meta-tiles.json` files over this map's tileset, by path — what the
   * sidebar's lower half offers and what the canvas draws a placement from.
   *
   * Read from disk rather than taken from the resources store, which knows only
   * `{ path, kind, out }` and cannot say which tileset a meta references.
   */
  metaDocs: Map<string, MetaTileDoc>
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
  /**
   * Path of the meta-tile the next click will place, or null when the brush is
   * ordinary tiles. Picking a meta and picking a tile are the two halves of the
   * sidebar, and choosing one clears the other.
   */
  brushMeta: string | null
  /** Index into the active layer's `placements` of the selected one, or null. */
  selectedPlacement: number | null
  /** Cells touched by the drag in progress, for the baked-record check on release. */
  paintedPoints: Point[]
  clipboard: Stamp | null

  pickerActive: number
  pickerSelection: number[]
  pickerZoom: number
  /**
   * Which of SCREEN 2/4's three pattern banks the picker shows — UI state,
   * not a history entry, exactly like the tile editor's own `bank`
   * (`tile/session.ts`). Ignored on an unbanked tileset, where it stays 0 and
   * every cell is already the sheet index (see `bankSheetOffset`).
   */
  bank: number

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

  /**
   * Which tool set is live — the cell tools above, or the pixel tools below.
   * UI state, not a history step, like `bank`.
   */
  mode: 'tiles' | 'paint'
  paintTool: TileTool
  paintColor: number
  /** Per stroke, because neither is a safe default: see the spec's write-mode table. */
  paintWrite: 'fork' | 'edit'
  /** Spray radius in dots, and its Bayer threshold (0–16) — `sprayPoints`' own units. */
  brushRadius: number
  brushDensity: number
  /** Accumulated across a drag; resolved into the tileset once, on release. */
  paintPoints: Point[]
  /**
   * Where the drag started. A line or a rect is drawn from here to the latest
   * sample whatever `from` that segment carried, so a caller feeding
   * pencil-style segments still gets one line, not the last piece of one.
   */
  paintOrigin: Point | null
  paintRole: 'fg' | 'bg'
  paintActive: boolean
  /** Set once the user declines promotion, so the offer is made once per session. */
  promotionDeclined: boolean
  /**
   * The offer itself: raised by a refused stroke on a screen that could be
   * banked, shown by `MapPaintPanel.vue`, cleared by `promoteToBanked` or
   * `declinePromotion`. UI state, like `mode`.
   */
  promptPromote: boolean
}

const sessions = new Map<string, MapSession>()

export function mapSession(path: string): MapSession {
  const existing = sessions.get(path)
  if (existing) return existing
  const doc = normalizeMap({})
  const session = shallowReactive<MapSession>({
    path,
    stopWatching: null,
    history: createHistory({ doc }),
    loading: true,
    error: null,
    dirty: false,
    stopWatchingTileset: null,
    tileset: null,
    bitmapTileset: null,
    atlas: null,
    metaDocs: new Map(),
    tilesetError: null,
    tilesetReorderSeen: null,
    activeLayer: 0,
    tool: 'stamp',
    filledRect: false,
    brush: singleStamp(0),
    brushBlock: null,
    brushMeta: null,
    selectedPlacement: null,
    paintedPoints: [],
    clipboard: null,
    pickerActive: 0,
    pickerSelection: [0],
    pickerZoom: 24,
    bank: 0,
    zoom: 16,
    gridVisible: true,
    screenOutline: true,
    selection: null,
    status: '',
    preview: null,
    mode: 'tiles',
    paintTool: 'pencil',
    // 15, not 1: a fresh tileset's rows decode as fg 15 on bg 1, so colour 1
    // is black on black — a first stroke that shows nothing and still mints a
    // tile. The meta editor defaults to 15 for the same reason.
    paintColor: 15,
    paintWrite: 'fork',
    brushRadius: 2,
    brushDensity: 8,
    paintPoints: [],
    paintOrigin: null,
    paintRole: 'fg',
    paintActive: false,
    promotionDeclined: false,
    promptPromote: false
  })
  sessions.set(path, session)
  // `serialize` must produce byte-for-byte what `saveSession` writes, sibling
  // key included — otherwise the editor's own save reads back as an outside
  // edit and reloads over the user's work.
  session.stopWatching = watchResourceFile(path, {
    serialize: () => {
      // `session.history.present.doc`, not `doc(session)`: a local `doc` shadows
      // the accessor in this scope, and the preview is not what a save writes anyway.
      const content: SavedMap = { ...session.history.present.doc }
      if (session.tilesetReorderSeen !== null) content.tilesetReorderSeen = session.tilesetReorderSeen
      return serializeResource({ kind: 'map', doc: content })
    },
    reload: () => void load(session),
    isDirty: () => session.dirty
  })
  void load(session)
  return session
}

/** Drops sessions for tabs that were closed. Called by the tab component when the tab set changes. */
export function pruneMapSessions(openPaths: Set<string>): void {
  for (const path of [...sessions.keys()]) {
    if (openPaths.has(path)) continue
    const session = sessions.get(path)
    session?.stopWatchingTileset?.()
    // Whatever this session's own tileset reference last resolved to — a
    // no-op release if it was never the store's (a bitmap tileset, an atlas,
    // or none), since `release` on an untracked path is harmless.
    const tilesetPath = session ? doc(session).tileset : null
    if (tilesetPath) useTilesetStore().release(tilesetPath)
    sessions.delete(path)
  }
}

export function doc(session: MapSession): MapDoc {
  return session.preview ?? session.history.present.doc
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
    session.history = createHistory({ doc: parsedDoc })
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
 * Three of them. A `.tiles.json` is the name-table case and carries blocks and
 * a reorder log. A `.btiles.json` is the bitmap tileset: it carries its own tile
 * size, so the map takes its cell geometry from the tileset rather than
 * guessing. A `.screen.json` is the older bitmap path — a picture read as a
 * grid, with anonymous cells and nothing to name.
 *
 * Meta-tiles are not among them: a map draws with a tileset and *places* metas
 * over the grid, rather than indexing them instead of tiles. `loadMetaDocs`
 * finds the ones that apply.
 */
async function loadTileset(session: MapSession): Promise<void> {
  const tilesetPath = doc(session).tileset
  if (!tilesetPath) {
    clearTileset(session)
    session.tilesetError = 'No tileset set — pick one below.'
    leavePaintIfUnpaintable(session)
    return
  }
  try {
    await loadFromPath(session, tilesetPath)
  } catch (error) {
    clearTileset(session)
    session.tilesetError = `Couldn't load tileset ${tilesetPath}: ${String(error)}`
  }
  leavePaintIfUnpaintable(session)
  await loadMetaDocs(session)
}

/**
 * Paint mode needs a pattern tileset, and `loadTileset` is the one place the
 * map can lose one — switched to a `.btiles.json`, cleared to "— choose —", or
 * a load that failed. Left in paint mode it is a dead canvas: the paint overlay
 * is gated on `canPaint`, the cell handlers step aside for any mode but
 * `'tiles'`, and the toggle that would bring the user back is hidden for the
 * same reason. Called on *every* exit of `loadTileset`, the early one included.
 * Conditional, so a reload or a swap to another pattern tileset keeps the mode
 * the user chose.
 */
function leavePaintIfUnpaintable(session: MapSession): void {
  if (session.mode === 'paint' && !canPaint(session)) session.mode = 'tiles'
}

function clearTileset(session: MapSession): void {
  session.stopWatchingTileset?.()
  session.stopWatchingTileset = null
  session.tileset = null
  session.bitmapTileset = null
  session.atlas = null
}

/**
 * Every `.meta-tiles.json` in the project drawn over *this map's* tileset.
 *
 * Metas over another tileset are not offered: their indices name tiles that do
 * not exist here, so placing one would paint garbage. A file that is malformed
 * or half-written is skipped rather than allowed to break the picker.
 */
async function loadMetaDocs(session: MapSession): Promise<void> {
  const tilesetPath = doc(session).tileset
  const found = new Map<string, MetaTileDoc>()
  // A pattern map takes pattern metas, a bitmap map takes bitmap ones. The
  // suffix already says which, so no file has to be opened to find out.
  const wanted = doc(session).cell ? 'metabtiles' : 'metatiles'
  if (tilesetPath) {
    for (const entry of useResourcesStore().entries) {
      if (entry.kind !== wanted) continue
      try {
        const text = await window.api.invoke('fs:read', { path: entry.path })
        const parsed = normalizeMetaTile(JSON.parse(text))
        if (samePath(parsed.tileset, tilesetPath)) found.set(entry.path, parsed)
      } catch {
        // Not a reason to break the picker.
      }
    }
  }
  session.metaDocs = found
  refreshMetaRefs(session)
}

/**
 * Re-syncs the map's mirror from the meta files it references.
 *
 * `MetaRef` exists only because the exporter reads one resource at a time, so
 * it is *derived* data — and derived data that is only refreshed when the user
 * happens to re-pick a meta goes stale silently. Whenever the real documents
 * are in hand, they win: a meta renamed, resized, or given a frame since this
 * map was last opened is corrected here rather than exported wrong.
 */
function refreshMetaRefs(session: MapSession): void {
  const current = doc(session)
  if (!current.metas.length) return
  let next = current
  for (const ref of current.metas) {
    const meta = session.metaDocs.get(ref.path)
    if (meta) next = addMetaRef(next, refFor(ref.path, meta))
  }
  // Silent: this is a correction, not an edit the user made, so it must not
  // dirty the tab or land on the undo stack. The rewrap keeps the present
  // step's own fields (`tileEdits` included) — `{ doc: next }` alone would
  // silently drop them.
  if (next !== current) session.history = { ...session.history, present: { ...session.history.present, doc: next } }
}

export async function reloadMetaDocs(session: MapSession): Promise<void> {
  await loadMetaDocs(session)
}

async function loadFromPath(session: MapSession, path: string): Promise<void> {
  const text = await window.api.invoke('fs:read', { path })
  const parsed = parseResource(path, text)
  // Whichever kind this turns out to be, any subscription from a *previous*
  // tileset (this map may have pointed somewhere else a moment ago, via
  // `setTileset`) is stale the instant we're loading a new one.
  session.stopWatchingTileset?.()
  session.stopWatchingTileset = null
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
  // Through the shared store, not the bare parse above: a `.tiles.json` open
  // in a tile tab, another map, or a meta being painted is one document, and
  // `sheet.ts` caches its rendered sheet on that document's *identity* — a
  // private copy here would leave the canvas drawing art that no longer
  // exists the moment anything else writes to it.
  await useTilesetStore().load(path)
  session.tileset = useTilesetStore().patternDoc(path)
  session.bitmapTileset = null
  session.atlas = null
  session.tilesetError = null
  // Another editor can change this same document from here on. Adopt it:
  // replacing `session.tileset` wholesale, never mutating it, for the same
  // identity-caching reason as above.
  session.stopWatchingTileset = useTilesetStore().onExternalChange(path, session.path, (next) => {
    // The store speaks both kinds; a resource this file already confirmed is
    // `'tiles'` only ever hears about its own, so the narrowing is a fact of
    // the path, not a guess.
    session.tileset = next as TilesDoc
  })
  await replayPersistedReorders(session)
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

/**
 * On open: fold in any tileset reorders this map missed while it wasn't open,
 * behind one confirm dialog.
 *
 * The store's log, not the file's. `session.tileset` is the store's live
 * document, and a reorder made in a tile tab and not yet saved is in that
 * document and in the store's log — and in neither the file's text nor its
 * `reorderLog`. Read against the file, this map would renumber for every
 * *saved* reorder and miss the unsaved one, leaving cells pointing at the old
 * indices of a document that has already moved on. The meta editor reads the
 * same log for the same reason.
 */
async function replayPersistedReorders(session: MapSession): Promise<void> {
  const log = useTilesetStore().reorderLog(doc(session).tileset)
  const result = replayReorders(doc(session), log, session.tilesetReorderSeen)
  if (!result.applied) return
  const confirmed = window.confirm(
    `The tileset "${doc(session).tileset}" was reorganized ${result.applied} time${result.applied === 1 ? '' : 's'} ` +
      `since this map was last opened. Renumber this map's tiles to match?`
  )
  if (!confirmed) return
  session.history = createHistory({ doc: result.doc })
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
  // The pair is saved together: a map pointing at tiles the tileset hasn't
  // flushed yet would be pointing at art nobody wrote to disk. `store.save`,
  // not a manual write — it's what actually clears the dirty flag and it
  // carries the reorder log along (`meta/session.ts:361-362` is the same call).
  const tilesetPath = doc(session).tileset
  const store = useTilesetStore()
  if (tilesetPath && store.isDirty(tilesetPath)) await store.save(tilesetPath)
  session.dirty = false
  useTabsStore().setDirty(session.path, false)
  session.status = 'Saved'
}

function markDirty(session: MapSession): void {
  session.dirty = true
  useTabsStore().setDirty(session.path, true)
}

/**
 * Every mutation goes through here: pushes one undo step and marks the tab
 * dirty (no-op if nothing changed). `tileEdits` — Task 6 passes these — is the
 * art an `edit` stroke overwrote to reach `next`, for `undo`/`redo` to swap
 * back in.
 */
export function commit(session: MapSession, next: MapDoc, tileEdits?: TileEdit[]): void {
  // `pushHistory` compares by reference and a fresh entry is never the present,
  // so guard on the document — otherwise every no-op stroke pushes a step.
  if (next === session.history.present.doc && !tileEdits?.length) return
  session.history = pushHistory(session.history, tileEdits?.length ? { doc: next, tileEdits } : { doc: next })
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
  const bitmap = kind === 'screen' || kind === 'btiles'
  const current = doc(session)
  // Placements name metas by slot into this map's own list, and those metas are
  // drawn over the *old* tileset's tiles. Pointing the map somewhere else makes
  // every one of them meaningless rather than merely wrong.
  commit(session, {
    ...current,
    tileset: tilesetPath,
    cell: bitmap ? (current.cell ?? { width: 16, height: 16, cols: 16 }) : null,
    metas: [],
    layers: current.layers.map((layer) => ({ ...layer, placements: [] }))
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
  return base
}

/**
 * Chooses which pattern bank the picker shows — UI state, not a history
 * entry, exactly like the tile editor's own `setBank` (`tile/session.ts`).
 * Clamped since the UI only ever offers `BANK_COUNT` of them.
 *
 * This only steers which art the picker offers to paint with; it does not
 * follow the brush onto the canvas. A byte picked from bank 1 and painted on
 * row 3 shows bank 0's art there — one name-table byte means different art in
 * different thirds of the screen, and the canvas already tells the truth
 * about it (`bankSheetOffset`). That is the hardware, not a bug: no warning,
 * conversion, or restriction to add here.
 */
export function setBank(session: MapSession, bank: number): void {
  const value = Number.isFinite(bank) ? Math.round(bank) : session.bank
  session.bank = Math.max(0, Math.min(BANK_COUNT - 1, value))
}

/**
 * The stacked sheet's offset for a cell on this map row: the row's own bank
 * slice (`bankForRow(row) * MAX_TILES`) when the tileset is banked, `0`
 * otherwise. A name-table byte is 0-255 regardless of banking — this is what
 * turns it into the right cell of `tilesetSheet`'s stacked layout.
 * `MapCanvas.vue` adds this to the cell byte before computing `sx`/`sy`; it is
 * the only banking-aware arithmetic that file needs.
 *
 * `bankForRow` only knows a *screen* row, 0-23 — `validateMap` refuses to
 * export a banked map that isn't exactly `SCREEN_ROWS` tall, since banks are
 * chosen by row and row 24 has none. But that check runs at export time, not
 * while painting: `resize()` lets the canvas show a taller banked map for as
 * long as the user leaves it that way, and without the `% SCREEN_ROWS` below,
 * row 24 and up would index a cell past the stacked sheet's 768 and
 * `drawImage` would silently draw nothing there — the exact bug class this
 * function exists to fix, reappearing below the first screen. Wrapping every
 * screen's worth of rows back onto banks 0-2 keeps the editor honest (if
 * still unexportable) instead of quietly going blank.
 */
export function bankSheetOffset(session: MapSession, row: number): number {
  return session.tileset && isBanked(session.tileset) ? bankForRow(row % SCREEN_ROWS) * MAX_TILES : 0
}

/**
 * The stacked sheet's offset for whichever bank `MapPicker.vue` currently
 * shows: `session.bank * MAX_TILES` when the tileset is banked, `0`
 * otherwise. `session.bank` is session state, not tileset state — it does
 * not reset itself when `setTileset`/`reloadTileset` swaps in an unbanked
 * tileset (or one that lost its last override), so the `isBanked` guard has
 * to live here rather than being assumed away: without it, a stale non-zero
 * `bank` left over from a banked tileset would offset the picker's draw loop
 * past the end of the new, small unbanked sheet, and every cell would
 * silently draw nothing — the same failure this task exists to close.
 */
export function pickerBankOffset(session: MapSession): number {
  return session.tileset && isBanked(session.tileset) ? session.bank * MAX_TILES : 0
}

/**
 * One `bankSheetOffset` per row of a meta-tile thumbnail, `height` entries
 * long — what `sheet.ts`'s `metaThumbnail` adds to each of its rows before
 * indexing the stacked sheet.
 *
 * A placement at map row `baseRow` spans rows `baseRow .. baseRow + height -
 * 1`, and a meta taller than one bank-row band (8 screen rows) can straddle
 * two or three banks — the cell at meta row `ty` belongs to the bank of map
 * row `baseRow + ty`, not to whichever bank row `baseRow` itself is in. A
 * single offset for the whole thumbnail was Defect B: it always read bank 0,
 * which happened to be harmless only for as long as every meta cell held
 * either tile 0 or a shared-region index (identical in every bank) — an
 * assumption `findOrCreateTile` and `addTile`'s missing `isBanked` guard both
 * make false in practice.
 *
 * `baseRow === null` is `MapMetaPicker`'s browsing grid, which has no
 * placement to anchor to and should keep showing whichever bank the picker
 * currently has selected — the same bank `MapPicker`'s own tile grid shows.
 * `bankSheetOffset` already wraps every `SCREEN_ROWS` (Task 10's fix for the
 * editor allowing a taller-than-one-screen banked map); calling it per row
 * here inherits that wrap for free.
 */
export function metaRowOffsets(session: MapSession, baseRow: number | null, height: number): number[] {
  if (baseRow === null) return new Array(height).fill(pickerBankOffset(session))
  return Array.from({ length: height }, (_, ty) => bankSheetOffset(session, baseRow + ty))
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
  session.brushMeta = null
}

/** The blocks of whichever tileset is loaded. Both kinds carry the same type. */
export function tilesetBlocks(session: MapSession): TileBlock[] {
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
  const current = session.preview ?? session.history.present.doc
  const layerIndex = session.activeLayer
  // Collected across the whole drag so the baked-record check runs once, on
  // release, rather than per pointer move.
  session.paintedPoints.push(...points)
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
  const painted = session.paintedPoints
  session.preview = null
  session.paintedPoints = []
  if (!preview || preview === session.history.present.doc) return
  // One commit, not two: dropping the stale records and the paint that made
  // them stale are the same edit as far as undo is concerned.
  const { doc: next, dropped } = withoutBakedAt(preview, session.activeLayer, painted)
  commit(session, next)
  if (dropped) {
    session.selectedPlacement = null
    session.status = `Painted over ${dropped} baked meta-tile${dropped === 1 ? '' : 's'} — their placement records were dropped.`
  }
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

// ── painting pixels: paint mode ──────────────────────────────────────────

/**
 * Switches tool sets, ending whatever drag is open in either one first.
 *
 * A flip mid-drag (a keyboard toggle, a second pointer) would otherwise leave
 * the old mode's stroke half-made: a cell drag's `preview` is what `doc()`
 * answers with, so the next paint stroke would resolve against — and commit —
 * a document nobody released; a paint stroke's points would sit until the next
 * `endPaint` folded them into an unrelated drag. Both are resolved rather than
 * dropped, the way the paint overlay's own unmount already resolves its stroke,
 * and both are no-ops when nothing is open. The canvas resets its own pointer
 * bookkeeping on the mode change (`MapCanvas.vue`).
 */
export function setMode(session: MapSession, mode: 'tiles' | 'paint'): void {
  finishDrag(session)
  endPaint(session)
  session.mode = mode
}

/**
 * Whether paint mode has anything to paint into.
 *
 * A stroke resolves into a pattern tileset. A map over a `.btiles.json` or a
 * `.screen.json` has none — `session.tileset` is null there, `endPaint` drops
 * the stroke without a word and `paintBudgetLabel` reads `''`. Those maps have
 * the screen editor. The `cell` check is the same fact read from the map's own
 * side: a map with cell geometry exports down the bitmap path whatever file it
 * happens to point at, so painting patterns into it would be painting art the
 * exporter never reads.
 *
 * The one predicate the paint layer and the mode toggle both ask, so they can
 * never disagree about which maps offer paint mode.
 */
export function canPaint(session: MapSession): boolean {
  return session.tileset !== null && doc(session).cell === null
}

export function setPaintTool(session: MapSession, tool: TileTool): void {
  session.paintTool = tool
}

export function setPaintColor(session: MapSession, color: number): void {
  session.paintColor = color
}

export function setPaintWrite(session: MapSession, write: 'fork' | 'edit'): void {
  session.paintWrite = write
}

/**
 * The screen as it currently looks, one byte per dot — what `fill` floods
 * against and what promotion repacks.
 *
 * Bank-aware: a cell in rows 8-15 draws from bank 1, so a common-set read would
 * flood against art the screen is not showing.
 */
export function renderMapPixels(
  map: MapDoc,
  tiles: TilesDoc,
  layerIndex: number
): { width: number; height: number; indices: Uint8Array } {
  const width = map.width * TILE_SIZE
  const height = map.height * TILE_SIZE
  const indices = new Uint8Array(width * height)
  const layer = map.layers[layerIndex]
  if (!layer) return { width, height, indices }
  const banked = isBanked(tiles)
  for (let cy = 0; cy < map.height; cy++) {
    const bank = banked ? bankForRow(cy % SCREEN_ROWS) : 0
    for (let cx = 0; cx < map.width; cx++) {
      const tile = layer.data[cy * map.width + cx] ?? 0
      const pixels = banked ? bankTilePixels(tiles, bank, tile) : tilePixels(tiles, tile)
      for (let y = 0; y < TILE_SIZE; y++) {
        indices.set(pixels.subarray(y * TILE_SIZE, (y + 1) * TILE_SIZE), (cy * TILE_SIZE + y) * width + cx * TILE_SIZE)
      }
    }
  }
  return { width, height, indices }
}

/**
 * Canvas offset to a dot. `session.zoom` is pixels per CELL (`MapCanvas.vue`
 * sizes its stage by it), so a dot is that over `TILE_SIZE`. Not clamped: a
 * captured drag can leave the canvas, and `paintGrid` drops what falls
 * outside. Lives here, not in the `.vue`, because only this layer is tested.
 */
export function paintPointAt(session: MapSession, offsetX: number, offsetY: number): Point {
  return {
    x: Math.floor((offsetX * TILE_SIZE) / session.zoom),
    y: Math.floor((offsetY * TILE_SIZE) / session.zoom)
  }
}

/**
 * Which bank a cell row is drawn in, or null when the tileset is not banked.
 * Wrapped by `SCREEN_ROWS` for the same reason `bankSheetOffset` is: a taller
 * map is editable in progress even though `validateMap` refuses it at export.
 * The wrap is also what keeps the answer in `0..BANK_COUNT - 1` without a
 * clamp — `paintGrid` only ever asks about rows inside the grid.
 */
export function paintBankOf(session: MapSession): ((cellRow: number) => number) | null {
  const tileset = session.tileset
  if (!tileset || !isBanked(tileset)) return null
  return (cellRow) => bankForRow(cellRow % SCREEN_ROWS)
}

export function beginPaint(session: MapSession, role: 'fg' | 'bg'): void {
  session.paintRole = role
  session.paintPoints = []
  session.paintOrigin = null
  session.paintActive = true
}

/**
 * Takes one drag segment, `from` the previous pointer sample `to` the current
 * one. Resolution happens once, in `endPaint`.
 *
 * A pencil or spray is the path the pointer took, so its segments accumulate.
 * A line or a rect is a shape between where the drag started and where the
 * pointer is now, so the latest sample *replaces* what came before —
 * accumulating those would bake every intermediate shape into the tileset,
 * which is the failure this whole stroke model exists to avoid.
 *
 * A fill is decided where the button went down, as it is in the tile and meta
 * editors: the first segment floods from there and every later sample is
 * ignored. Flooding from the latest sample instead meant pressing on one
 * region and releasing on another filled the wrong one — and re-rendered the
 * whole map on every pointer move on the way.
 *
 * Reassigned rather than pushed: the session is `shallowReactive`, so a
 * preview watching the array only notices a new one.
 */
export function extendPaint(session: MapSession, from: Point, to: Point): void {
  if (!session.paintActive) return
  const first = session.paintOrigin === null
  session.paintOrigin ??= from
  if (session.paintTool === 'fill' && !first) return
  const points = pointsFor(session, from, to)
  session.paintPoints =
    session.paintTool === 'pencil' || session.paintTool === 'spray' ? [...session.paintPoints, ...points] : points
}

function pointsFor(session: MapSession, from: Point, to: Point): Point[] {
  if (session.paintTool === 'spray') return sprayPoints(to, session.brushRadius, session.brushDensity)
  if (session.paintTool === 'fill') {
    const tileset = session.tileset
    if (!tileset) return []
    // The whole picture, not `fillPoints`' default 8×8: the user drew one
    // shape across cell seams, and a flood has to cross them too.
    const { width, height, indices } = renderMapPixels(doc(session), tileset, session.activeLayer)
    return fillPoints(indices, session.paintOrigin ?? from, width, height)
  }
  const origin = session.paintTool === 'pencil' ? from : (session.paintOrigin ?? from)
  return pixelToolPoints(session.paintTool, origin, to, [], session.filledRect)
}

/**
 * Resolves the whole drag into the tileset as one undo step.
 *
 * The grid handed to `paintGrid` is in CELLS — `paintGrid` divides the pixel
 * points by `TILE_SIZE` itself. A pixel width here makes the row stride wrong
 * and writes past the layer, and a single-cell stroke passes either way.
 */
export function endPaint(session: MapSession): void {
  if (!session.paintActive) return
  session.paintActive = false
  const points = session.paintPoints
  session.paintPoints = []
  session.paintOrigin = null
  const tileset = session.tileset
  const current = doc(session)
  const layer = current.layers[session.activeLayer]
  if (!tileset || !layer || !points.length) return

  const result = paintGrid(
    { width: current.width, height: current.height, tiles: layer.data },
    tileset,
    points,
    session.paintColor,
    session.paintRole,
    { write: session.paintWrite, bankOf: paintBankOf(session) ?? undefined }
  )
  if (result.refused) {
    session.status = result.refused
    offerPromotion(session, result)
    return
  }

  // `paintGrid` hands back the same arrays when a stroke changed nothing — the
  // same colour over pixels that already hold it. `{ ...current, layers }` is
  // always a fresh object, so the identity guard in `commit` cannot see that
  // by itself, and every idle repaint would push a step that undoes nothing.
  const cellsMoved = result.grid.tiles !== layer.data
  let next = current
  let droppedBaked = 0
  if (cellsMoved) {
    const layers = current.layers.slice()
    layers[session.activeLayer] = { ...layer, data: result.grid.tiles }
    // A fork repoints cells, and a cell repointed inside a baked meta makes
    // its receipt a lie — exactly as a stamped cell does (`finishDrag`). An
    // `edit` moves no reference, so there is nothing to drop there.
    const moved = changedCells(layer.data, result.grid.tiles, current.width)
    ;({ doc: next, dropped: droppedBaked } = withoutBakedAt({ ...current, layers }, session.activeLayer, moved))
  }
  if (result.tiles !== tileset) publishTileset(session, result.tiles)
  if (cellsMoved || result.tileEdits.length) commit(session, next, result.tileEdits)

  if (droppedBaked) {
    session.selectedPlacement = null
    session.status = `Painted over ${droppedBaked} baked meta-tile${droppedBaked === 1 ? '' : 's'} — their placement records were dropped.`
  } else {
    session.status = result.dropped
      ? `${result.dropped} pixel${result.dropped === 1 ? '' : 's'} dropped: colour limit`
      : ''
  }
}

/** The cells whose reference a stroke moved, as grid points. */
function changedCells(before: readonly number[], after: readonly number[], width: number): Point[] {
  const points: Point[] = []
  for (let i = 0; i < after.length; i++) {
    if (after[i] !== before[i]) points.push({ x: i % width, y: Math.floor(i / width) })
  }
  return points
}

/**
 * Publishes a tileset this session changed, and adopts it. `store.set` skips
 * the writer's own listener — the one `loadFromPath` registered under
 * `session.path` — so without the assignment the session would keep drawing,
 * and resolving the next stroke against, a document the store no longer holds.
 */
function publishTileset(session: MapSession, next: TilesDoc): void {
  useTilesetStore().set(doc(session).tileset, next, session.path)
  session.tileset = next
}

/**
 * On an unbanked tileset that just hit 256 tiles, raises the one-time offer to
 * repack the screen into three banks — or says why that is not on the table.
 *
 * Branches on `refusedBank`, never on the message: only a whole-*tileset*
 * refusal (`null`) can be solved by banking. A full *bank* is the ceiling of a
 * screen that is banked already; run through the blocker it would come back
 * as "already banked" — an answer about promotion in place of the one that
 * names the bank. The refusal message `endPaint` set stays in place for that
 * case.
 *
 * The triggering stroke is discarded, not replayed: promotion renumbers every
 * tile, so its cell indices are stale by the time it completes. The user
 * draws it again on a screen that now has room.
 */
function offerPromotion(session: MapSession, result: PaintGridResult): void {
  if (result.refusedBank !== null || session.promotionDeclined) return
  const blocker = promotionBlocker(session)
  if (blocker === null) {
    session.promptPromote = true
    return
  }
  session.status = `This screen is out of tiles. ${blocker}`
}

/**
 * Why this screen cannot be switched to banked right now, or null when it can.
 * The one decision point behind the offer, the accept and the refusal message,
 * so the three can never disagree — `promoteToBanked` re-asks it, because the
 * map can change between the offer being raised and the button being pressed.
 *
 * Promotion is only legal at exactly 32×24: `packBankedTiles` takes a 256×192
 * image, and `validateMap` refuses a banked map that is not `SCREEN_ROWS`
 * tall. SCREEN 1 has one pattern table, not three — `normalizeTiles` strips
 * `bankTiles` from an sc1 document, so banks packed into one would survive
 * exactly until the next load. Only the active layer is repacked, so a second
 * layer's indices would be stale after renumbering; a placement's meta names
 * tiles by number the same way, and a baked one's receipt would claim the grid
 * holds tiles it no longer does. Those last two are this map's own references,
 * which is why they refuse rather than merely warn the way the prompt warns
 * about other files.
 */
export function promotionBlocker(session: MapSession): string | null {
  const tileset = session.tileset
  const current = doc(session)
  if (!tileset || !canPaint(session)) return 'This map has no pattern tileset to bank.'
  if (isBanked(tileset)) return 'This tileset is already banked.'
  if (tileset.mode === 'sc1') return 'SCREEN 1 has one pattern table, so it cannot be banked — that is SCREEN 2/4 only.'
  if (current.width !== 32 || current.height !== SCREEN_ROWS) {
    return (
      `Switching to banked needs a map exactly 32 wide and ${SCREEN_ROWS} rows tall — ` +
      `this one is ${current.width}×${current.height}.`
    )
  }
  if (current.layers.length > 1) {
    return (
      `Switching to banked repacks one layer, and this map has ${current.layers.length} — ` +
      'the others would keep the old tile numbering. Remove or merge them first.'
    )
  }
  if (placementCount(current) > 0) {
    return (
      'Switching to banked renumbers every tile, and this map places meta-tiles that name tiles by number. ' +
      'Remove the placements first.'
    )
  }
  return null
}

export function canPromoteToBanked(session: MapSession): boolean {
  return promotionBlocker(session) === null
}

/**
 * What the offer says. Here rather than in the `.vue` because it makes claims
 * about behaviour, and claims are tested: nothing emits a reorder event for a
 * promotion, so no other file is touched — an open map keeps its old cell
 * indices and draws them against the new banks, which is wrong art, not a
 * rewrite.
 */
export const PROMOTION_PROMPT =
  `This screen is out of tiles. Switch to banked (three banks of ${MAX_TILES})? ` +
  'This renumbers every tile in the tileset: any other map or meta-tile drawn with it will show ' +
  'wrong art until it is repainted, and the tileset\'s named blocks and tile flags are cleared. ' +
  'The stroke that hit the limit is not kept — draw it again afterwards.'

/** The user said no. Once per session: the next refused stroke does not re-ask. */
export function declinePromotion(session: MapSession): void {
  session.promotionDeclined = true
  session.promptPromote = false
}

/**
 * Switches the screen to three banks of 256.
 *
 * Re-uses the importer rather than inventing a redistributor: the screen is
 * already fully described by tileset + map, so it is rendered to a 256×192
 * bitmap and handed to `packBankedTiles`, which is tested and ROM-verified.
 * The packer returns a *fresh* document, so everything it does not know about
 * is re-threaded here: `mode` (its own argument), `palette`, `reserveTile0`
 * and `export` — losing `export` alone would leave the tileset unbuilt.
 * `flags` and `blocks` are deliberately *not* carried: both name tiles by
 * number and every number changes. `normalizeTiles` would clamp them against
 * the new `count` of 1 on the next load anyway, and until then a carried block
 * would stamp old-numbering indices as bank art through `pickBlock`. The
 * prompt says so before the user accepts.
 *
 * `reserveTile0` is honoured the way `importImage` honours it: the packer
 * numbers each bank from 0, so a blank is prepended per bank and every layout
 * index shifts by one — a cell that *was* tile 0 stays tile 0, so its
 * see-through survives. A bank that had all 256 slots in use loses its last
 * tile to the shift; that is counted as unplaced, never silent.
 *
 * Renumbering makes every earlier history entry a lie — its cells index a
 * numbering that no longer exists, and its `tileEdits` would write art into
 * common slots the banks now hide — so the history restarts here, as it does
 * after a replayed reorder. Both documents are left dirty for the pair-save,
 * not written: this is an edit, and Save is what writes edits.
 */
export function promoteToBanked(session: MapSession): void {
  session.promptPromote = false
  const blocker = promotionBlocker(session)
  if (blocker !== null) {
    session.status = blocker
    return
  }
  const tileset = session.tileset!
  const current = doc(session)
  const layer = current.layers[session.activeLayer]
  if (!layer) return

  const { width, height, indices } = renderMapPixels(current, tileset, session.activeLayer)
  const packed = packBankedTiles(indices, width, height, tileset.mode)

  const reserve = tileset.reserveTile0
  const unplaced = packed.unplaced.slice()
  const bankTiles = packed.doc.bankTiles.map((bank) =>
    reserve ? [blankTileEntry(tileset.mode), ...bank].slice(0, MAX_TILES) : bank
  )
  const data = packed.layout.map((index, cell) => {
    if (!reserve) return index
    if (layer.data[cell] === 0) return 0
    const shifted = index + 1
    if (shifted < MAX_TILES) return shifted
    // The 257th tile the shift pushed out. Placed as tile 0 and counted, the
    // way the packer itself treats a cell it has no room for.
    unplaced[bankForRow(Math.floor(cell / current.width))]++
    return 0
  })

  // Through `normalizeTiles`, so what the session holds is byte-for-byte what
  // the next load will read back — it is what blanks common tile 0 under
  // `reserveTile0`, sizes `flags` to the new count, and keeps `palette` only
  // where the mode has one.
  const merged = normalizeTiles({
    ...packed.doc,
    bankTiles,
    palette: tileset.palette,
    reserveTile0: tileset.reserveTile0,
    export: tileset.export
  })
  const layers = current.layers.map((entry, i) => (i === session.activeLayer ? { ...entry, data } : entry))

  publishTileset(session, merged)
  // `metas: []` as `setTileset` does: a meta picked but not yet placed (the
  // blocker only refuses placements) names tiles by the old numbering.
  session.history = createHistory({ doc: { ...current, layers, metas: [] } })
  session.selection = null
  markDirty(session)
  // Everything else on the session that names a tile by number. No precedent
  // covers these (`setTileset` clears only metas and placements); they stand
  // on the defect itself: the brush and clipboard would stamp old indices as
  // bank art on the next click, `brushBlock` indexes a `blocks` that is now
  // empty, and the picker's highlight points at art that moved.
  session.brush = singleStamp(0)
  session.brushBlock = null
  session.brushMeta = null
  session.clipboard = null
  session.pickerActive = 0
  session.pickerSelection = [0]
  session.selectedPlacement = null

  const counts = merged.bankTiles.map((bank) => bank.length).join('/')
  const short = unplaced.reduce((sum, count) => sum + count, 0)
  session.status =
    `Switched to banked — ${counts} tiles in banks 1-3.` +
    (short ? ` ${short} cells could not be placed.` : '') +
    ' Draw the last stroke again.'
}

/**
 * The tile budget, phrased as the tile editor phrases it (`bankBudgetLabel`
 * is 1-based: "bank 1: 3 + 2 shared = 5 / 256"), so the two editors never
 * disagree about the arithmetic.
 */
export function paintBudgetLabel(session: MapSession): string {
  const tileset = session.tileset
  if (!tileset) return ''
  if (!isBanked(tileset)) return `tiles: ${tileset.count}/${MAX_TILES}`
  return tileset.bankTiles.map((_, bank) => bankBudgetLabel(tileset, bank)).join('   ')
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

/**
 * Puts back the tiles an `edit` stroke overwrote — or, on redo, the art it
 * painted — and returns the displaced entries, so the caller can store them
 * as the inverse of the step it just moved. Without that swap, redo would
 * write `before` a second time and the painted pixels would be lost while
 * history claims the step is applied.
 *
 * Guarded, because the tileset is shared and `edit` rewrites in place: a tile
 * tab, a meta, or another map can have changed the same slot since this step
 * was made. A slot that no longer holds what this step left there — `after`,
 * and in sc1 `afterGroup` too, since the group byte is the other half of the
 * picture and lives outside the entry — is left alone, dropped from the step
 * so redo does not try it either, and counted into the status. The tileset
 * store's premise that two editors "never disagree about an existing tile"
 * held only while painting appended; this is what stands in for it now.
 *
 * Publishes only when something was applied: `store.set` compares by
 * reference, so re-setting an identical document would dirty the tileset and
 * push a step into every other tab on it.
 */
function swapTileEdits(session: MapSession, edits: TileEdit[] | undefined): TileEdit[] | undefined {
  if (!edits?.length) return edits
  const store = useTilesetStore()
  const path = doc(session).tileset
  const tileset = store.patternDoc(path)
  // No document to write into: nothing applied, so nothing for redo either.
  if (!tileset) return []
  const tiles = tileset.tiles.slice()
  const bankTiles = tileset.bankTiles.map((bank) => bank.slice())
  const groupColors = tileset.groupColors.slice()
  const displaced: TileEdit[] = []
  let skipped = 0
  for (const edit of edits) {
    // `?.` on the bank: a `bank: n` edit can meet a tileset that has since
    // lost its banks, and an empty slot is a slot that no longer holds ours.
    const current: TileEntry | undefined = edit.bank === null ? tiles[edit.index] : bankTiles[edit.bank]?.[edit.index]
    // Off `tileset.groupColors` — the untouched snapshot — not the mutable
    // `groupColors` copy this loop is writing into: eight tiles share one sc1
    // group byte, so a second edit touching the same group would otherwise
    // read back the first edit's just-written value as its own "current",
    // and redo would leave the group on the wrong colour.
    const currentGroup = tileset.groupColors[edit.index >> 3]
    const ours =
      current !== undefined &&
      sameEntry(current, edit.after) &&
      (edit.afterGroup === undefined || currentGroup === edit.afterGroup)
    if (!ours) {
      skipped++
      continue
    }
    if (edit.bank === null) tiles[edit.index] = edit.before
    else bankTiles[edit.bank][edit.index] = edit.before
    if (edit.beforeGroup !== undefined) groupColors[edit.index >> 3] = edit.beforeGroup
    displaced.push({
      index: edit.index,
      bank: edit.bank,
      before: current,
      // `after` is what the slot holds once this swap has run — `edit.before`,
      // since that's what was just written into it. It is what the next swap
      // back checks against.
      after: edit.before,
      ...(edit.beforeGroup !== undefined ? { beforeGroup: currentGroup, afterGroup: edit.beforeGroup } : {})
    })
  }
  if (skipped) {
    session.status =
      `${skipped} tile${skipped === 1 ? '' : 's'} left as ${skipped === 1 ? 'it is' : 'they are'}: ` +
      'changed elsewhere since this stroke.'
  }
  if (displaced.length) publishTileset(session, { ...tileset, tiles, bankTiles, groupColors })
  return displaced
}

export function undo(session: MapSession): void {
  if (!canUndo(session.history)) return
  const leaving = session.history.present
  const displaced = swapTileEdits(session, leaving.tileEdits)
  const next = undoHistory(session.history)
  session.history = displaced
    ? { ...next, future: [{ ...leaving, tileEdits: displaced }, ...next.future.slice(1)] }
    : next
  session.selection = null
  session.preview = null
  markDirty(session)
}

export function redo(session: MapSession): void {
  if (!canRedo(session.history)) return
  const entering = session.history.future[0]
  const displaced = swapTileEdits(session, entering.tileEdits)
  const next = redoHistory(session.history)
  session.history = displaced ? { ...next, present: { ...next.present, tileEdits: displaced } } : next
  session.selection = null
  session.preview = null
  markDirty(session)
}

export { canRedo, canUndo }

// ── placed meta-tiles ───────────────────────────────────────────────────────

/**
 * Arms the brush with a meta-tile. The next click on the canvas places it.
 *
 * The meta joins the map's own `metas` table here rather than at place time, so
 * the mirror is refreshed — size, frames, flags — every time the user reaches
 * for it, which is the moment they are most likely to have just edited it.
 */
export function pickMeta(session: MapSession, path: string): void {
  const meta = session.metaDocs.get(path)
  if (!meta) return
  const next = addMetaRef(doc(session), refFor(path, meta))
  if (next === doc(session) && metaSlotOf(doc(session), path) < 0) {
    session.status = `A map can place ${MAX_MAP_METAS} different meta-tiles.`
    return
  }
  commit(session, next)
  session.brushMeta = path
  session.selectedPlacement = null
}

/**
 * The mirror of one meta, for this session.
 *
 * The shared builder, not a local one: the exporter refreshes the same mirror
 * from the same function, and the last time these two had independent rules
 * they disagreed about the symbol name and every map with helpers on failed to
 * link.
 */
function refFor(path: string, meta: MetaTileDoc): MetaRef {
  return metaRefFrom(path, meta, defaultExport(path).name)
}

export function placeMetaAt(session: MapSession, x: number, y: number): void {
  const path = session.brushMeta
  if (!path) return
  const slot = metaSlotOf(doc(session), path)
  if (slot < 0) return
  const next = placeMeta(doc(session), session.activeLayer, slot, x, y)
  if (next === doc(session)) return
  commit(session, next)
  session.selectedPlacement = next.layers[session.activeLayer].placements.length - 1
}

/** Selects the topmost placement under a cell, or clears the selection. */
export function selectPlacementAt(session: MapSession, x: number, y: number): number | null {
  session.selectedPlacement = placementAt(doc(session), session.activeLayer, x, y)
  return session.selectedPlacement
}

export function movePlacementTo(session: MapSession, x: number, y: number): void {
  if (session.selectedPlacement === null) return
  commit(session, movePlacement(doc(session), session.activeLayer, session.selectedPlacement, x, y))
}

export function deleteSelectedPlacement(session: MapSession): void {
  if (session.selectedPlacement === null) return
  const index = session.selectedPlacement
  const placement = doc(session).layers[session.activeLayer]?.placements[index]
  // Unbake first, so a baked meta's tiles leave the grid with it rather than
  // being left behind as anonymous artwork nobody can select.
  if (placement?.baked) setBaked(session, false)
  commit(session, removePlacement(doc(session), session.activeLayer, index))
  session.selectedPlacement = null
}

/**
 * Bakes or unbakes the selected placement.
 *
 * Baking writes frame 0's tiles into the grid, so the layer write already draws
 * it and it costs nothing at runtime; unbaking clears those cells back to tile
 * 0. Transparent cells are skipped either way — a meta's holes are not its
 * business to paint.
 */
export function setBaked(session: MapSession, baked: boolean): void {
  const index = session.selectedPlacement
  if (index === null) return
  const current = doc(session)
  const placement = current.layers[session.activeLayer]?.placements[index]
  const ref = placement && current.metas[placement.slot]
  const meta = ref && session.metaDocs.get(ref.path)
  if (!placement || !ref || !meta) return

  const tiles = meta.frames[0]?.tiles ?? []
  const points: Point[] = []
  const values: number[] = []
  // The *meta's* geometry, not the mirror's: `tiles` is the meta's array, so
  // only the meta's width is a valid stride into it. They agree after a
  // refresh, and reading one with the other's stride when they do not is how a
  // stale mirror would silently bake the wrong tiles.
  for (let ty = 0; ty < meta.height; ty++) {
    for (let tx = 0; tx < meta.width; tx++) {
      const tile = tiles[ty * meta.width + tx] ?? 0
      if (tile === 0) continue
      points.push({ x: placement.x + tx, y: placement.y + ty })
      values.push(baked ? tile : 0)
    }
  }

  let next = setPlacementBaked(current, session.activeLayer, index, baked)
  points.forEach((point, i) => {
    next = paintValue(next, session.activeLayer, [point], values[i])
  })
  commit(session, next)
  session.status = baked ? 'Baked into the layer.' : 'Unbaked.'
}

/**
 * Drops the record of any baked placement the given cells fall inside.
 *
 * Painting a tile inside a baked meta makes its receipt a lie: the grid no
 * longer holds what the meta says it does. Better to stop claiming it than to
 * silently re-stamp over the user's edit later. A *live* placement is not
 * touched — painting under it is painting the hole it shows through.
 */
function withoutBakedAt(
  current: MapDoc,
  layerIndex: number,
  points: readonly Point[]
): { doc: MapDoc; dropped: number } {
  const layer = current.layers[layerIndex]
  if (!layer?.placements.some((placement) => placement.baked)) return { doc: current, dropped: 0 }
  const hit = new Set<number>()
  for (const point of points) {
    const index = placementAt(current, layerIndex, point.x, point.y)
    if (index !== null && layer.placements[index].baked) hit.add(index)
  }
  if (!hit.size) return { doc: current, dropped: 0 }
  let next = current
  // Highest first, so the lower indices stay valid as they are removed.
  for (const index of [...hit].sort((a, b) => b - a)) next = removePlacement(next, layerIndex, index)
  return { doc: next, dropped: hit.size }
}
