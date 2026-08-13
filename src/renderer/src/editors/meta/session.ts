/**
 * Per-tab state for the meta-tile set editor (`*.meta-tiles.json`,
 * `*.meta-btiles.json`).
 *
 * Same shape as every other resource editor: a module-level map keyed by tab id
 * (= the project-relative path), every mutation through the pure functions in
 * `shared/msx/meta-tile.ts`, and `History<MetaTilesDoc>` from `shared/history.ts`
 * for undo.
 *
 * It borrows the map editor's `sheet.ts` outright, because "the tileset this
 * references, as a grid of images addressed by number" is exactly what that
 * already builds for all three tileset kinds.
 *
 * Two reorder seams meet here and do not touch:
 *
 * - **Incoming**: the referenced tileset's `reorderLog` renumbers the tiles
 *   *inside* the metas (`remapMetaTiles`) — the same replay a map does over its
 *   own cells, and stored the same way (a sibling key on the saved file).
 * - **Outgoing**: deleting or moving a meta renumbers the cells of every map
 *   drawn with this set, so it publishes on `emitTilesReordered` under *this*
 *   file's path. A map replays the log of the file it references, so a map that
 *   draws with plain tiles can never see this, and a meta map can never see the
 *   tileset's.
 */

import { shallowReactive } from 'vue'
import {
  addMeta as addMetaPure,
  metaStride,
  normalizeMetaTiles,
  remapMetaTiles,
  removeMeta as removeMetaPure,
  renameMeta as renameMetaPure,
  reorderMetas as reorderMetasPure,
  resizeMetas as resizeMetasPure,
  setMetaTile,
  type MetaTilesDoc
} from '../../../../shared/msx/meta-tile'
import { parseResource, serializeResource } from '../../../../shared/msx/resource'
import { sheetCols, type BitmapTilesDoc } from '../../../../shared/msx/bitmap-tile'
import type { ScreenDoc } from '../../../../shared/msx/screen'
import type { TilesDoc } from '../../../../shared/msx/tile'
import { screenPixels } from '../../../../shared/msx/screen'
import { atlasSheet, bitmapTilesetSheet, tilesetSheet, type Sheet } from '../map/sheet'
import {
  canRedo,
  canUndo,
  createHistory,
  pushHistory,
  redo as redoHistory,
  undo as undoHistory,
  type History
} from '../../../../shared/history'
import { pendingReorders, samePath } from '../../../../shared/map-editor'
import { emitTilesReordered, onTilesReordered, type TilesReorderEvent } from '../../../../shared/tile-editor'
import { useTabsStore } from '../../stores/tabsStore'

/** The two sibling keys `normalizeMetaTiles` ignores, kept around the parse the way maps do. */
type SavedMetaTiles = MetaTilesDoc & { reorderLog?: TilesReorderEvent[]; tilesetReorderSeen?: number }

export interface MetaSession {
  path: string
  history: History<MetaTilesDoc>
  loading: boolean
  error: string | null
  dirty: boolean

  /** The tileset being grouped, in whichever of the three forms it takes. */
  tileset: TilesDoc | null
  bitmapTileset: BitmapTilesDoc | null
  atlas: ScreenDoc | null
  tilesetError: string | null
  /** Last tileset `reorderLog` entry (by `at`) folded in; null = never replayed. */
  tilesetReorderSeen: number | null
  /** This set's own log — what maps drawn with it replay when a meta is deleted or moved. */
  reorderLog: TilesReorderEvent[]

  /** Which meta the centre pane is editing. */
  active: number
  /** The tile the centre pane paints with, picked from the tileset pane. */
  brush: number
  zoom: number
  gridVisible: boolean
  status: string
}

const sessions = new Map<string, MetaSession>()

export function metaSession(path: string): MetaSession {
  const existing = sessions.get(path)
  if (existing) return existing
  const session = shallowReactive<MetaSession>({
    path,
    history: createHistory(normalizeMetaTiles({})),
    loading: true,
    error: null,
    dirty: false,
    tileset: null,
    bitmapTileset: null,
    atlas: null,
    tilesetError: null,
    tilesetReorderSeen: null,
    reorderLog: [],
    active: 0,
    brush: 0,
    zoom: 32,
    gridVisible: true,
    status: ''
  })
  sessions.set(path, session)
  void load(session)
  return session
}

export function pruneMetaSessions(openPaths: Set<string>): void {
  for (const path of [...sessions.keys()]) if (!openPaths.has(path)) sessions.delete(path)
}

export function doc(session: MetaSession): MetaTilesDoc {
  return session.history.present
}

async function load(session: MetaSession): Promise<void> {
  try {
    const text = await window.api.invoke('fs:read', { path: session.path })
    let raw: unknown = {}
    try {
      raw = text.trim() ? JSON.parse(text) : {}
    } catch {
      raw = {}
    }
    const saved = raw as SavedMetaTiles
    session.history = createHistory(normalizeMetaTiles(raw))
    session.reorderLog = Array.isArray(saved.reorderLog) ? saved.reorderLog : []
    session.tilesetReorderSeen = typeof saved.tilesetReorderSeen === 'number' ? saved.tilesetReorderSeen : null
    session.error = null
    await loadTileset(session)
  } catch (error) {
    session.error = `Couldn't open ${session.path}: ${String(error)}`
  } finally {
    session.loading = false
  }
}

async function loadTileset(session: MetaSession): Promise<void> {
  const tilesetPath = doc(session).tileset
  session.tileset = null
  session.bitmapTileset = null
  session.atlas = null
  if (!tilesetPath) {
    session.tilesetError = 'No tileset set — pick one below.'
    return
  }
  try {
    const text = await window.api.invoke('fs:read', { path: tilesetPath })
    const parsed = parseResource(tilesetPath, text)
    if (parsed.kind === 'tiles') {
      session.tileset = parsed.doc
      session.tilesetError = null
      await replayPersistedReorders(session, text)
      return
    }
    if (parsed.kind === 'btiles') {
      session.bitmapTileset = parsed.doc
      session.tilesetError = null
      await replayPersistedReorders(session, text)
      return
    }
    if (parsed.kind === 'screen') {
      session.atlas = parsed.doc
      session.tilesetError = parsed.doc.converted
        ? null
        : `${tilesetPath} has no converted image yet — open it and run the conversion once.`
      return
    }
    throw new Error(`${tilesetPath} is not a tileset`)
  } catch (error) {
    session.tilesetError = `Couldn't load tileset ${tilesetPath}: ${String(error)}`
  }
}

export async function reloadTileset(session: MetaSession): Promise<void> {
  await loadTileset(session)
}

/** On open: fold in tileset reorders missed while this file wasn't open, behind one confirm. */
async function replayPersistedReorders(session: MetaSession, tilesetText: string): Promise<void> {
  const raw = JSON.parse(tilesetText) as { reorderLog?: TilesReorderEvent[] }
  const pending = pendingReorders(Array.isArray(raw.reorderLog) ? raw.reorderLog : [], session.tilesetReorderSeen)
  if (!pending.length) return
  const confirmed = window.confirm(
    `The tileset "${doc(session).tileset}" was reorganized ${pending.length} time${pending.length === 1 ? '' : 's'} ` +
      `since this meta-tile set was last opened. Renumber the tiles inside the meta-tiles to match?`
  )
  if (!confirmed) return
  let next = doc(session)
  for (const event of pending) next = remapMetaTiles(next, event.mapping)
  session.history = createHistory(next)
  session.tilesetReorderSeen = pending[pending.length - 1].at
  markDirty(session)
}

/** Live tileset reorders, while both files happen to be open. */
onTilesReordered((event) => {
  for (const session of sessions.values()) {
    // Its own outgoing events come back through here; a set does not remap itself.
    if (samePath(session.path, event.path)) continue
    if (!samePath(doc(session).tileset, event.path)) continue
    commit(session, remapMetaTiles(doc(session), event.mapping))
    session.tilesetReorderSeen = event.at
  }
})

export async function saveSession(session: MetaSession): Promise<void> {
  const content: SavedMetaTiles = { ...doc(session) }
  if (session.reorderLog.length) content.reorderLog = session.reorderLog
  if (session.tilesetReorderSeen !== null) content.tilesetReorderSeen = session.tilesetReorderSeen
  await window.api.invoke('fs:write', {
    path: session.path,
    content: serializeResource({ kind: 'metatiles', doc: content })
  })
  session.dirty = false
  useTabsStore().setDirty(session.path, false)
  session.status = 'Saved'
}

function markDirty(session: MetaSession): void {
  session.dirty = true
  useTabsStore().setDirty(session.path, true)
}

export function commit(session: MetaSession, next: MetaTilesDoc): void {
  const history = pushHistory(session.history, next)
  if (history === session.history) return
  session.history = history
  markDirty(session)
}

/**
 * Records and broadcasts a meta renumbering. Every map drawn with this set has
 * that many cells pointing at the wrong meta until it replays this, which is why
 * it is persisted as well as emitted — the map may not be open.
 */
function publishRemap(session: MetaSession, mapping: number[]): void {
  const event: TilesReorderEvent = { path: session.path, mapping, at: Date.now() }
  session.reorderLog = [...session.reorderLog, event]
  emitTilesReordered(event)
}

// ── the tileset reference ─────────────────────────────────────────────────

/**
 * Points the set at a tileset. A bitmap one states its own geometry, so `cell`
 * is taken from it rather than guessed — it is what the exported `_DrawMeta`
 * needs and what nothing else in the file knows.
 */
export async function setTileset(session: MetaSession, tilesetPath: string): Promise<void> {
  commit(session, { ...doc(session), tileset: tilesetPath })
  session.tilesetReorderSeen = null
  await loadTileset(session)
  const tiles = session.bitmapTileset
  if (tiles) {
    commit(session, {
      ...doc(session),
      cell: { width: tiles.width, height: tiles.height, cols: sheetCols(tiles) }
    })
    return
  }
  const pixels = session.atlas && screenPixels(session.atlas)
  if (pixels) {
    const cell = doc(session).cell ?? { width: 16, height: 16, cols: 16 }
    commit(session, { ...doc(session), cell: { ...cell, cols: Math.max(1, Math.floor(pixels.width / cell.width)) } })
    return
  }
  // A pattern tileset's tile is the name table's 8×8 cell, which needs no note.
  commit(session, { ...doc(session), cell: null })
}

/** The tileset's own sheet — what both panes draw a tile from. */
export function sheet(session: MetaSession): Sheet | null {
  if (session.bitmapTileset) return bitmapTilesetSheet(session.bitmapTileset)
  const cell = doc(session).cell
  if (session.atlas && cell) return atlasSheet(session.atlas, cell)
  return session.tileset ? tilesetSheet(session.tileset) : null
}

// ── editing ───────────────────────────────────────────────────────────────

export function selectMeta(session: MetaSession, index: number): void {
  session.active = index
}

export function pickTile(session: MetaSession, tile: number): void {
  session.brush = tile
}

/** Paints the current brush into one cell of the meta being edited. */
export function paintCell(session: MetaSession, tx: number, ty: number): void {
  commit(session, setMetaTile(doc(session), session.active, tx, ty, session.brush))
}

export function addMeta(session: MetaSession): void {
  const next = addMetaPure(doc(session))
  if (next === doc(session)) {
    session.status = 'A map cell is one byte, so a set stops at 256 meta-tiles.'
    return
  }
  commit(session, next)
  session.active = next.metas.length - 1
}

/**
 * Fills a new meta with the tiles already sitting in a rectangle of the tileset
 * sheet — the fast path when the art was drawn as a block in the first place.
 *
 * Clamped to the bank: taking a 2×2 from the last tile would otherwise mint
 * references past the end, which draw as nothing in the editor and as whatever
 * happens to be in the pattern table at runtime.
 */
export function addMetaFromTiles(session: MetaSession, topLeft: number, columns: number): void {
  const current = doc(session)
  const count = sheet(session)?.count ?? 0
  const tiles: number[] = []
  for (let y = 0; y < current.height; y++) {
    for (let x = 0; x < current.width; x++) {
      const tile = topLeft + y * columns + x
      tiles.push(tile < count ? tile : 0)
    }
  }
  const next = addMetaPure(current)
  if (next === current) return
  const metas = next.metas.slice()
  metas[metas.length - 1] = { ...metas[metas.length - 1], tiles: tiles.map((tile) => tile & 0xff) }
  commit(session, { ...next, metas })
  session.active = metas.length - 1
}

export function renameMeta(session: MetaSession, index: number, name: string): void {
  commit(session, renameMetaPure(doc(session), index, name))
}

export function removeMeta(session: MetaSession, index: number): void {
  const { doc: next, mapping } = removeMetaPure(doc(session), index)
  if (next === doc(session)) return
  commit(session, next)
  publishRemap(session, mapping)
  if (session.active >= next.metas.length) session.active = Math.max(0, next.metas.length - 1)
}

export function reorderMetas(session: MetaSession, from: number, to: number): void {
  const { doc: next, mapping } = reorderMetasPure(doc(session), from, to)
  if (next === doc(session)) return
  commit(session, next)
  publishRemap(session, mapping)
  session.active = to
}

/**
 * Changes the size of every meta at once. Maps drawn with this set keep their
 * cell values — a meta's *index* does not move — but the world they describe
 * grows or shrinks, so the map's own `meta` is refreshed when it next loads.
 */
export function resizeMetas(session: MetaSession, width: number, height: number): void {
  commit(session, resizeMetasPure(doc(session), width, height))
}

export { canRedo, canUndo, metaStride }

export function undo(session: MetaSession): void {
  const next = undoHistory(session.history)
  if (next === session.history) return
  session.history = next
  markDirty(session)
}

export function redo(session: MetaSession): void {
  const next = redoHistory(session.history)
  if (next === session.history) return
  session.history = next
  markDirty(session)
}
