/**
 * Per-tab state for the meta-tile editor (`*.meta-tiles.json`,
 * `*.meta-btiles.json`).
 *
 * Same shape as every other resource editor: a module-level map keyed by tab id
 * (= the project-relative path), every mutation through the pure functions in
 * `shared/msx/meta-tile.ts` and `shared/msx/meta-paint.ts`, and
 * `History<MetaTileDoc>` for undo.
 *
 * What is different here is that painting writes into **another document**. The
 * meta owns no pixels, so a stroke resolves to a tile index that the same
 * stroke found or created in the referenced `.tiles.json` — which is why the
 * tileset lives in `useTilesetStore` rather than in this session. Two documents
 * move together and are saved together; a meta pointing at a tile the tileset
 * has not saved yet is a broken pair of files.
 *
 * The reorder seam runs one way now. A meta *replays* its tileset's log, live
 * while both are open and on open for what it missed. It no longer publishes
 * one: there are no metas-within-a-set left to renumber, and a map's own
 * `metas` list is local to the map.
 */

import { shallowReactive } from 'vue'
import {
  addFrame as addFramePure,
  createMetaTileDoc,
  frameTileAt,
  metaCells,
  normalizeMetaTile,
  remapMetaTiles,
  removeFrame as removeFramePure,
  reorderFrames as reorderFramesPure,
  resizeMeta as resizeMetaPure,
  META_FLAG_COUNT,
  type MetaTileDoc
} from '../../../../shared/msx/meta-tile'
import { paintMeta, usedTiles } from '../../../../shared/msx/meta-paint'
import { parseResource, serializeResource, resourceKindOf } from '../../../../shared/msx/resource'
import { removeTile, type TilesDoc } from '../../../../shared/msx/tile'
import type { BitmapTilesDoc } from '../../../../shared/msx/bitmap-tile'
import { sheetCols } from '../../../../shared/msx/bitmap-tile'
import type { ScreenDoc } from '../../../../shared/msx/screen'
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
import { pendingReorders, samePath, type Point } from '../../../../shared/map-editor'
import { emitTilesReordered, onTilesReordered, type TileTool, type TilesReorderEvent } from '../../../../shared/tile-editor'
import { useTabsStore } from '../../stores/tabsStore'
import { useTilesetStore } from '../../stores/tilesetStore'

/** The one sibling key `normalizeMetaTile` ignores, kept around the parse the way maps do. */
type SavedMetaTile = MetaTileDoc & { tilesetReorderSeen?: number }

export interface MetaSession {
  path: string
  /**
   * `metatiles` or `metabtiles`. Stage 1 paints pattern modes only — a bitmap
   * tileset is not a `TilesDoc` and is not in the tileset store at all — so
   * this is what gates the pixel canvas.
   */
  kind: 'metatiles' | 'metabtiles'
  history: History<MetaTileDoc>
  loading: boolean
  error: string | null
  dirty: boolean

  /** Project-relative path of the tileset. Its document lives in the store. */
  tilesetPath: string
  /** The bitmap forms, which the store does not hold. Null in a pattern mode. */
  bitmapTileset: BitmapTilesDoc | null
  atlas: ScreenDoc | null
  tilesetError: string | null
  /** Last tileset `reorderLog` entry (by `at`) folded in; null = never replayed. */
  tilesetReorderSeen: number | null

  /** Which frame the canvas is editing. */
  frame: number
  tool: TileTool
  /** Rect tool draws an outline unless this is set. */
  filledRect: boolean
  /** Palette index the tools paint with. 0 is transparent. */
  color: number
  /** Spray radius in pixels, and its Bayer threshold (0–16). */
  brushRadius: number
  density: number
  onionSkin: boolean
  playing: boolean
  zoom: number
  gridVisible: boolean
  status: string
  /**
   * Tiles this session appended, in order. Compact reclaims the ones no longer
   * referenced — and only these, because a tile that existed before this
   * session opened may be referenced by a file nobody has open.
   */
  appended: number[]
  stopWatching: (() => void) | null
}

const sessions = new Map<string, MetaSession>()

export function metaSession(path: string): MetaSession {
  const existing = sessions.get(path)
  if (existing) return existing
  const kind = resourceKindOf(path) === 'metabtiles' ? 'metabtiles' : 'metatiles'
  const session = shallowReactive<MetaSession>({
    path,
    kind,
    history: createHistory(createMetaTileDoc('')),
    loading: true,
    error: null,
    dirty: false,
    tilesetPath: '',
    bitmapTileset: null,
    atlas: null,
    tilesetError: null,
    tilesetReorderSeen: null,
    frame: 0,
    tool: 'pencil',
    filledRect: false,
    color: 15,
    brushRadius: 3,
    density: 8,
    onionSkin: false,
    playing: false,
    zoom: 16,
    gridVisible: true,
    status: '',
    appended: [],
    stopWatching: null
  })
  sessions.set(path, session)
  void load(session)
  return session
}

export function pruneMetaSessions(openPaths: Set<string>): void {
  for (const path of [...sessions.keys()]) {
    if (openPaths.has(path)) continue
    const session = sessions.get(path)
    session?.stopWatching?.()
    if (session?.tilesetPath) useTilesetStore().release(session.tilesetPath)
    sessions.delete(path)
  }
}

export function doc(session: MetaSession): MetaTileDoc {
  return session.history.present
}

/** The tileset as one `TilesDoc`, or null in a bitmap mode / before it loads. */
export function tiles(session: MetaSession): TilesDoc | null {
  return session.kind === 'metatiles' ? useTilesetStore().doc(session.tilesetPath) : null
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
    const saved = raw as SavedMetaTile
    session.history = createHistory(normalizeMetaTile(raw))
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
  session.tilesetPath = tilesetPath
  session.bitmapTileset = null
  session.atlas = null
  if (!tilesetPath) {
    session.tilesetError = 'No tileset set — pick one in the side panel.'
    return
  }
  try {
    if (session.kind === 'metatiles') {
      await useTilesetStore().load(tilesetPath)
      session.tilesetError = null
      await replayPersistedReorders(session)
      return
    }
    const text = await window.api.invoke('fs:read', { path: tilesetPath })
    const parsed = parseResource(tilesetPath, text)
    if (parsed.kind === 'btiles') {
      session.bitmapTileset = parsed.doc
      session.tilesetError = null
      return
    }
    if (parsed.kind === 'screen') {
      session.atlas = parsed.doc
      session.tilesetError = parsed.doc.converted
        ? null
        : `${tilesetPath} has no converted image yet — open it and run the conversion once.`
      return
    }
    throw new Error(`${tilesetPath} is not a bitmap tileset`)
  } catch (error) {
    session.tilesetError = `Couldn't load tileset ${tilesetPath}: ${String(error)}`
  }
}

export async function reloadTileset(session: MetaSession): Promise<void> {
  await loadTileset(session)
}

/** On open: fold in tileset reorders missed while this file wasn't open, behind one confirm. */
async function replayPersistedReorders(session: MetaSession): Promise<void> {
  const pending = pendingReorders(useTilesetStore().reorderLog(session.tilesetPath), session.tilesetReorderSeen)
  if (!pending.length) return
  const confirmed = window.confirm(
    `The tileset "${session.tilesetPath}" was reorganized ${pending.length} time${pending.length === 1 ? '' : 's'} ` +
      'since this meta-tile was last opened. Renumber the tiles inside it to match?'
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
    if (!samePath(session.tilesetPath, event.path)) continue
    commit(session, remapMetaTiles(doc(session), event.mapping))
    session.tilesetReorderSeen = event.at
  }
})

export async function saveSession(session: MetaSession): Promise<void> {
  const content: SavedMetaTile = { ...doc(session) }
  if (session.tilesetReorderSeen !== null) content.tilesetReorderSeen = session.tilesetReorderSeen
  await window.api.invoke('fs:write', {
    path: session.path,
    content: serializeResource({ kind: session.kind, doc: content })
  })
  // The pair is saved together on purpose. A meta that points at a tile its
  // tileset has not written yet is a dangling index the next open cannot fix.
  const store = useTilesetStore()
  if (session.tilesetPath && store.isDirty(session.tilesetPath)) await store.save(session.tilesetPath)
  session.dirty = false
  useTabsStore().setDirty(session.path, false)
  session.status = 'Saved'
}

function markDirty(session: MetaSession): void {
  session.dirty = true
  useTabsStore().setDirty(session.path, true)
}

export function commit(session: MetaSession, next: MetaTileDoc): void {
  const history = pushHistory(session.history, next)
  if (history === session.history) return
  session.history = history
  markDirty(session)
}

// ── the tileset reference ─────────────────────────────────────────────────

/**
 * Points the meta at a tileset.
 *
 * A pattern tileset has to reserve tile 0 before a meta can be transparent, and
 * turning that on for a tileset that already has art in tile 0 is a migration:
 * every index shifts by one. It goes through the same reorder seam a drag
 * reorder does, so open maps and metas renumber and closed ones replay on open.
 */
export async function setTileset(session: MetaSession, tilesetPath: string): Promise<void> {
  commit(session, { ...doc(session), tileset: tilesetPath })
  session.tilesetReorderSeen = null
  await loadTileset(session)

  if (session.kind === 'metatiles') {
    const store = useTilesetStore()
    const tileset = store.doc(tilesetPath)
    if (tileset && !tileset.reserveTile0) session.status = 'This tileset does not reserve tile 0 — a meta cannot be transparent until it does.'
    commit(session, { ...doc(session), cell: null })
    return
  }

  const bitmap = session.bitmapTileset
  if (bitmap) {
    commit(session, { ...doc(session), cell: { width: bitmap.width, height: bitmap.height, cols: sheetCols(bitmap) } })
    return
  }
  const pixels = session.atlas && screenPixels(session.atlas)
  if (pixels) {
    const cell = doc(session).cell ?? { width: 16, height: 16, cols: 16 }
    commit(session, { ...doc(session), cell: { ...cell, cols: Math.max(1, Math.floor(pixels.width / cell.width)) } })
  }
}

/**
 * Reserves tile 0 on the referenced tileset, shifting every existing index up
 * by one and publishing the mapping so everything drawn with it follows.
 */
export function reserveTile0(session: MetaSession): void {
  const store = useTilesetStore()
  const tileset = store.doc(session.tilesetPath)
  if (!tileset || tileset.reserveTile0) return
  const used = tileset.tiles.some((tile) => tile.pattern.some((byte) => byte !== 0))
  if (
    used &&
    !window.confirm(
      `"${session.tilesetPath}" uses tile 0 as artwork. Reserving it for transparency shifts every ` +
        'tile up by one. Maps and meta-tiles drawn with it will be renumbered to match. Continue?'
    )
  ) {
    return
  }
  // Shift by prepending a blank: every old index i becomes i + 1.
  const shifted: TilesDoc = {
    ...tileset,
    reserveTile0: true,
    count: Math.min(256, tileset.count + 1),
    tiles: [tileset.tiles[0], ...tileset.tiles].slice(0, 256),
    flags: [0, ...tileset.flags].slice(0, 256),
    blocks: tileset.blocks.map((block) => ({ ...block, tiles: block.tiles.map((tile) => tile + 1) }))
  }
  const mapping = tileset.tiles.map((_, i) => Math.min(255, i + 1))
  store.set(session.tilesetPath, { ...shifted, tiles: shifted.tiles.slice() }, session.path)
  const event: TilesReorderEvent = { path: session.tilesetPath, mapping, at: Date.now() }
  store.appendReorder(session.tilesetPath, event)
  emitTilesReordered(event)
  session.status = 'Tile 0 reserved.'
}

/** The tileset's own sheet — what the frame strip and the canvas draw a tile from. */
export function sheet(session: MetaSession): Sheet | null {
  if (session.bitmapTileset) return bitmapTilesetSheet(session.bitmapTileset)
  const cell = doc(session).cell
  if (session.atlas && cell) return atlasSheet(session.atlas, cell)
  const tileset = tiles(session)
  return tileset ? tilesetSheet(tileset) : null
}

// ── editing ───────────────────────────────────────────────────────────────

/**
 * Applies a stroke to the current frame, in the meta's own pixel space.
 *
 * Both documents move: the meta gets a repointed cell, the tileset gets any
 * tile the stroke had to create.
 */
export function paint(session: MetaSession, points: Point[]): void {
  // Stage 1 paints pattern modes only. A bitmap meta still stamps cells.
  if (session.kind !== 'metatiles') return
  const store = useTilesetStore()
  const tileset = store.doc(session.tilesetPath)
  if (!tileset) return
  if (!tileset.reserveTile0) {
    session.status = 'This tileset does not reserve tile 0, so a meta cannot be transparent. Reserve it in the side panel.'
    return
  }

  const result = paintMeta(doc(session), tileset, session.frame, points, session.color)
  if (result.refused) {
    session.status = result.refused
    return
  }
  if (result.tiles !== tileset) store.set(session.tilesetPath, result.tiles, session.path)
  if (result.added.length) session.appended = [...session.appended, ...result.added]
  commit(session, result.meta)
  session.status = result.dropped
    ? `${result.dropped} pixel${result.dropped === 1 ? '' : 's'} dropped: colour limit`
    : ''
}

export function setFrame(session: MetaSession, index: number): void {
  if (doc(session).frames[index]) session.frame = index
}

export function addFrame(session: MetaSession, copyOf?: number): void {
  const next = addFramePure(doc(session), copyOf)
  if (next === doc(session)) return
  commit(session, next)
  session.frame = next.frames.length - 1
}

export function removeFrame(session: MetaSession, index: number): void {
  const next = removeFramePure(doc(session), index)
  if (next === doc(session)) {
    session.status = 'A meta-tile needs at least one frame.'
    return
  }
  commit(session, next)
  if (session.frame >= next.frames.length) session.frame = next.frames.length - 1
}

export function reorderFrames(session: MetaSession, from: number, to: number): void {
  const next = reorderFramesPure(doc(session), from, to)
  if (next === doc(session)) return
  commit(session, next)
  session.frame = to
}

export function resize(session: MetaSession, width: number, height: number): void {
  commit(session, resizeMetaPure(doc(session), width, height))
}

export function toggleFlag(session: MetaSession, bit: number): void {
  if (bit < 0 || bit >= META_FLAG_COUNT) return
  commit(session, { ...doc(session), flags: doc(session).flags ^ (1 << bit) })
}

/**
 * How many tiles this meta references, and how full the bank is — the readout
 * that tells you when painting is about to hit the ceiling.
 */
export function tileUsage(session: MetaSession): { used: number; total: number; orphans: number } {
  const used = usedTiles(doc(session))
  const tileset = tiles(session)
  return { used: used.size, total: tileset?.count ?? 0, orphans: orphansOf(session).length }
}

/**
 * Tiles this session appended and then stopped referencing — undo's leavings.
 *
 * Deliberately *not* "every tile nothing open refers to". Reachability across
 * files that are closed is not knowable from here, and a tile used only by a
 * map nobody has opened would look exactly as unused as a real orphan. These
 * did not exist when the session started, so nothing else can point at them.
 */
function orphansOf(session: MetaSession): number[] {
  const used = usedTiles(doc(session))
  return session.appended.filter((tile) => !used.has(tile))
}

/**
 * Reclaims this session's orphans. Removing a tile renumbers everything above
 * it, so the mapping goes through the same seam a drag reorder uses: emitted
 * for files that are open, persisted for files that are not.
 */
export function compact(session: MetaSession): void {
  const store = useTilesetStore()
  const tileset = store.doc(session.tilesetPath)
  const orphans = orphansOf(session)
  if (!tileset || !orphans.length) {
    session.status = 'Nothing to compact.'
    return
  }
  if (!window.confirm(`Remove ${orphans.length} tile${orphans.length === 1 ? '' : 's'} this session created and no longer uses?`)) {
    return
  }

  // Highest first, so each removal leaves the lower indices alone and the
  // mappings compose in one pass.
  let next = tileset
  let mapping = tileset.tiles.map((_, i) => i)
  for (const tile of [...orphans].sort((a, b) => b - a)) {
    const step = removeTile(next, tile)
    if (step.doc === next) continue
    next = step.doc
    mapping = mapping.map((index) => step.mapping[index] ?? 0)
  }
  if (next === tileset) return

  store.set(session.tilesetPath, next, session.path)
  const event: TilesReorderEvent = { path: session.tilesetPath, mapping, at: Date.now() }
  store.appendReorder(session.tilesetPath, event)
  emitTilesReordered(event)
  session.appended = []
  session.status = `Reclaimed ${orphans.length} tile${orphans.length === 1 ? '' : 's'}.`
}

export { canRedo, canUndo, frameTileAt, metaCells }

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

// ── view state ──────────────────────────────────────────────────────────────
// Exported setters rather than direct field writes from the components: every
// other mutation in this module goes through a function, and Vue's lint rules
// forbid a child component assigning into a prop.

export function setTool(session: MetaSession, tool: TileTool): void {
  session.tool = tool
}

export function setColor(session: MetaSession, color: number): void {
  session.color = color & 0x0f
}

export function setZoom(session: MetaSession, zoom: number): void {
  session.zoom = Math.max(2, Math.min(48, zoom | 0))
}

export function togglePlaying(session: MetaSession): void {
  session.playing = !session.playing
}

export function setOnionSkin(session: MetaSession, on: boolean): void {
  session.onionSkin = on
}

export function setGridVisible(session: MetaSession, on: boolean): void {
  session.gridVisible = on
}

export function setFilledRect(session: MetaSession, on: boolean): void {
  session.filledRect = on
}

export function setBrush(session: MetaSession, radius: number, density: number): void {
  session.brushRadius = Math.max(1, Math.min(16, radius | 0))
  session.density = Math.max(0, Math.min(16, density | 0))
}
