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
import { paintBitmapMeta, paintMeta, usedTiles } from '../../../../shared/msx/meta-paint'
import { parseResource, serializeResource, resourceKindOf } from '../../../../shared/msx/resource'
import { blankTileEntry, MAX_TILES, mergeColorByte, removeTile, TILE_SIZE, type TilesDoc } from '../../../../shared/msx/tile'
import type { BitmapTilesDoc } from '../../../../shared/msx/bitmap-tile'
import {
  MAX_BITMAP_TILES,
  normalizeBitmapTiles,
  removeBitmapTile,
  sheetCols,
  tilePixels as bitmapTilePixels
} from '../../../../shared/msx/bitmap-tile'
import { encodeIndices } from '../../../../shared/msx/screen'
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
import { watchResourceFile } from '../external-changes'
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
  /**
   * The screen-as-atlas form, which no editor writes and so is not shared.
   * Both real tilesets live in `useTilesetStore` — see `bitmapTiles`.
   */
  atlas: ScreenDoc | null
  tilesetError: string | null
  /** Last tileset `reorderLog` entry (by `at`) folded in; null = never replayed. */
  tilesetReorderSeen: number | null

  /** Which frame the canvas is editing. */
  frame: number
  /**
   * The cell the last stroke touched, in the meta's own tile coordinates.
   *
   * Only SCREEN 1 needs it, and needs it badly: colour there belongs to a group
   * of eight tiles, so "which colours may I use" has a different answer per
   * cell. Keying the palette to cell (0,0) would silently drop every pixel
   * painted into a cell whose tile lives in another group.
   */
  activeCell: { x: number; y: number }
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
  /**
   * The stroke in progress, if any.
   *
   * A drag samples the pointer dozens of times, and resolving each sample
   * against the bank would mint a tile per sample — the intermediate states of
   * one line, none of which the user asked to keep. So a stroke accumulates its
   * points and is resolved *once*, on release, always against the document as
   * it was when the drag began. `preview*` is what the canvas draws meanwhile:
   * real pixels, not yet in the bank.
   */
  strokePoints: Point[]
  strokeRole: 'fg' | 'bg'
  strokeActive: boolean
  previewMeta: MetaTileDoc | null
  previewTiles: TilesDoc | BitmapTilesDoc | null
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
    atlas: null,
    tilesetError: null,
    tilesetReorderSeen: null,
    frame: 0,
    activeCell: { x: 0, y: 0 },
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
    strokePoints: [],
    strokeRole: 'fg',
    strokeActive: false,
    previewMeta: null,
    previewTiles: null,
    stopWatching: null
  })
  sessions.set(path, session)
  // Byte-for-byte what `saveSession` writes, sibling key included. The tileset
  // this meta references is watched separately, by the tileset store.
  session.stopWatching = watchResourceFile(path, {
    serialize: () => {
      const content: SavedMetaTile = { ...session.history.present }
      if (session.tilesetReorderSeen !== null) content.tilesetReorderSeen = session.tilesetReorderSeen
      return serializeResource({ kind: session.kind, doc: content })
    },
    reload: () => void load(session),
    isDirty: () => session.dirty
  })
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
  return session.previewMeta ?? session.history.present
}

/** The committed document, ignoring any stroke in progress — the stroke's base. */
function committed(session: MetaSession): MetaTileDoc {
  return session.history.present
}

/** The tileset as one `TilesDoc`, or null in a bitmap mode / before it loads. */
export function tiles(session: MetaSession): TilesDoc | null {
  if (session.kind !== 'metatiles') return null
  return (session.previewTiles as TilesDoc | null) ?? useTilesetStore().patternDoc(session.tilesetPath)
}

/**
 * The bitmap tileset, from the same store.
 *
 * It goes through the store for exactly the reason the pattern one does: the
 * bitmap tileset editor has its own tab and its own undo stack over the same
 * file, so a copy here would mean whichever saved last silently discarded the
 * other's work.
 */
export function bitmapTiles(session: MetaSession): BitmapTilesDoc | null {
  if (session.kind !== 'metabtiles') return null
  return (session.previewTiles as BitmapTilesDoc | null) ?? useTilesetStore().bitmapDoc(session.tilesetPath)
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
  // Pointing the meta somewhere else gives up the hold on where it used to
  // point, or the old document is pinned in the store for the session's life.
  if (session.tilesetPath && session.tilesetPath !== tilesetPath) {
    useTilesetStore().release(session.tilesetPath)
  }
  session.tilesetPath = tilesetPath
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
    if (resourceKindOf(tilesetPath) === 'btiles') {
      await useTilesetStore().load(tilesetPath)
      session.tilesetError = null
      return
    }
    const text = await window.api.invoke('fs:read', { path: tilesetPath })
    const parsed = parseResource(tilesetPath, text)
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
  // Dead tiles this session minted while experimenting must not reach the file.
  const reclaimed = reclaimOrphans(session)
  const content: SavedMetaTile = { ...committed(session) }
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
  session.status = reclaimed ? `Saved — reclaimed ${reclaimed} unused tile${reclaimed === 1 ? '' : 's'}.` : 'Saved'
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

  const bitmap = bitmapTiles(session)
  if (bitmap) {
    commit(session, {
      ...doc(session),
      cell: { width: bitmap.width, height: bitmap.height, cols: sheetCols(bitmap) },
      transparent: bitmap.transparent
    })
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
/**
 * Reserves tile 0 on a *bitmap* tileset.
 *
 * Shifts rather than blanks, exactly as the pattern path does: the art in tile
 * 0 moves to tile 1 and everything after it follows, so nothing is destroyed.
 * The mapping goes out on the same reorder seam a drag reorder uses, so maps
 * and metas drawn with this tileset renumber — live if they are open, on their
 * next open if they are not.
 */
export function reserveBitmapTile0(session: MetaSession): void {
  const store = useTilesetStore()
  const tileset = store.bitmapDoc(session.tilesetPath)
  if (!tileset || tileset.reserveTile0) return
  if (tileset.count >= MAX_BITMAP_TILES) {
    session.status = `The tileset is full, so tile 0 cannot be shifted out of the way. Free a tile first.`
    return
  }
  if (
    !window.confirm(
      `Reserve tile 0 in "${session.tilesetPath}" for transparency? Every tile shifts up by one, ` +
        'and the maps and meta-tiles drawn with it are renumbered to match.'
    )
  ) {
    return
  }

  const per = tileset.width * tileset.height
  const old = bitmapTilePixels(tileset)
  const pixels = new Uint8Array((tileset.count + 1) * per)
  // A blank first tile, then the whole old bank one slot along.
  pixels.set(old, per)
  const shifted = normalizeBitmapTiles({
    ...tileset,
    reserveTile0: true,
    count: tileset.count + 1,
    pixels: encodeIndices(pixels),
    flags: [0, ...tileset.flags],
    blocks: tileset.blocks.map((block) => ({ ...block, tiles: block.tiles.map((tile) => tile + 1) }))
  })

  store.set(session.tilesetPath, shifted, session.path)
  const event: TilesReorderEvent = {
    path: session.tilesetPath,
    mapping: Array.from({ length: tileset.count }, (_, i) => i + 1),
    at: Date.now()
  }
  store.appendReorder(session.tilesetPath, event)
  emitTilesReordered(event)
  session.status = 'Tile 0 reserved.'
}

export function reserveTile0(session: MetaSession): void {
  const store = useTilesetStore()
  const tileset = store.patternDoc(session.tilesetPath)
  if (!tileset || tileset.reserveTile0) return
  if (tileset.count >= MAX_TILES) {
    session.status = 'The tileset is full, so tile 0 cannot be shifted out of the way. Free a tile first.'
    return
  }
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
  // Shift by prepending a genuinely blank tile: every old index i becomes i + 1.
  // `normalizeTiles` would blank it on the next load anyway; doing it here keeps
  // the in-memory doc honest, because `tilesetStore.set()` does not normalize.
  // No truncation: the guard above already refused a bank with no room.
  const shifted: TilesDoc = {
    ...tileset,
    reserveTile0: true,
    count: tileset.count + 1,
    tiles: [blankTileEntry(tileset.mode), ...tileset.tiles],
    flags: [0, ...tileset.flags],
    blocks: tileset.blocks.map((block) => ({ ...block, tiles: block.tiles.map((tile) => tile + 1) }))
  }
  const mapping = tileset.tiles.map((_, i) => i + 1)
  store.set(session.tilesetPath, { ...shifted, tiles: shifted.tiles.slice() }, session.path)
  const event: TilesReorderEvent = { path: session.tilesetPath, mapping, at: Date.now() }
  store.appendReorder(session.tilesetPath, event)
  emitTilesReordered(event)
  session.status = 'Tile 0 reserved.'
}

/** The tileset's own sheet — what the frame strip and the canvas draw a tile from. */
export function sheet(session: MetaSession): Sheet | null {
  const bitmap = bitmapTiles(session)
  if (bitmap) return bitmapTilesetSheet(bitmap)
  const cell = doc(session).cell
  if (session.atlas && cell) return atlasSheet(session.atlas, cell)
  const tileset = tiles(session)
  return tileset ? tilesetSheet(tileset) : null
}

// ── editing ───────────────────────────────────────────────────────────────

/** The pixel size of one cell — 8×8 in a pattern mode, the tileset's own otherwise. */
export function cellSize(session: MetaSession): { width: number; height: number } {
  const bitmap = bitmapTiles(session)
  if (bitmap) return { width: bitmap.width, height: bitmap.height }
  return { width: TILE_SIZE, height: TILE_SIZE }
}

/**
 * Applies a stroke to the current frame, in the meta's own pixel space.
 *
 * Both documents move: the meta gets a repointed cell, the tileset gets any
 * tile the stroke had to create. Which of the two engines runs depends on
 * whether the tileset is patterns or pixels — the shapes are the same, the
 * constraints are not.
 */
export function beginStroke(session: MetaSession, role: 'fg' | 'bg' = 'fg'): void {
  session.strokeRole = role
  session.strokePoints = []
  session.previewMeta = null
  session.previewTiles = null
  session.strokeActive = true
}

/**
 * Adds points to the stroke in progress and re-renders the preview.
 *
 * Always resolved against the *committed* document, never against the previous
 * preview: a drag is one edit, and deriving it from its own intermediate states
 * is what produced a tile per pointer sample. Nothing here touches the bank —
 * `endStroke` does that, once.
 *
 * Called with no stroke open (a programmatic paint, or a one-shot tool) it
 * opens and closes one itself, so a caller that does not care still gets a
 * single undo step and a single append.
 */
export function paint(session: MetaSession, points: Point[], role: 'fg' | 'bg' = 'fg'): void {
  if (!session.strokeActive) {
    beginStroke(session, role)
    extendStroke(session, points)
    endStroke(session)
    return
  }
  extendStroke(session, points)
}

function extendStroke(session: MetaSession, points: Point[]): void {
  if (!points.length) return
  session.strokePoints = [...session.strokePoints, ...points]
  const all = session.strokePoints

  const first = all[0]
  const { width: cw, height: ch } = cellSize(session)
  if (first) {
    session.activeCell = {
      x: Math.min(committed(session).width - 1, Math.max(0, Math.floor(first.x / cw))),
      y: Math.min(committed(session).height - 1, Math.max(0, Math.floor(first.y / ch)))
    }
  }

  const store = useTilesetStore()
  if (session.kind === 'metabtiles') {
    const base = store.bitmapDoc(session.tilesetPath)
    if (!base) return void noTileset(session)
    const result = paintBitmapMeta(committed(session), base, session.frame, all, session.color)
    if (result.refused) {
      session.status = result.refused
      return
    }
    session.previewMeta = result.meta
    session.previewTiles = result.tiles
    session.status = ''
    return
  }

  const base = store.patternDoc(session.tilesetPath)
  if (!base) return void noTileset(session)
  // Deliberately not gated on `reserveTile0`: that buys transparency, not the
  // right to draw.
  const result = paintMeta(committed(session), base, session.frame, all, session.color, session.strokeRole)
  if (result.refused) {
    session.status = result.refused
    return
  }
  session.previewMeta = result.meta
  session.previewTiles = result.tiles
  session.status = result.dropped
    ? `${result.dropped} pixel${result.dropped === 1 ? '' : 's'} dropped: colour limit`
    : ''
}

function noTileset(session: MetaSession): void {
  // Silent refusal reads as a broken editor. Say which of the two it is.
  session.status = session.tilesetPath
    ? `Still loading ${session.tilesetPath} — or it failed to open; see the side panel.`
    : 'Pick a tileset in the side panel before drawing.'
}

/**
 * Resolves the stroke: one set of tiles into the bank, one undo step.
 *
 * This is the only place the tileset grows while drawing. A drag that visited
 * forty intermediate shapes contributes only the tiles its final shape needs.
 */
export function endStroke(session: MetaSession): void {
  if (!session.strokeActive) return
  session.strokeActive = false
  const meta = session.previewMeta
  const tileset = session.previewTiles
  session.previewMeta = null
  session.previewTiles = null
  session.strokePoints = []
  if (!meta || !tileset) return

  const store = useTilesetStore()
  const before =
    session.kind === 'metabtiles' ? store.bitmapDoc(session.tilesetPath) : store.patternDoc(session.tilesetPath)
  if (before && tileset !== before) {
    store.set(session.tilesetPath, tileset, session.path)
    const grew = countOf(tileset) - countOf(before)
    if (grew > 0) {
      session.appended = [...session.appended, ...Array.from({ length: grew }, (_, i) => countOf(before) + i)]
    }
  }
  commit(session, meta)
}

const countOf = (doc: TilesDoc | BitmapTilesDoc): number => doc.count

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

/** The tile under `activeCell`, and the sc1 colour group it belongs to. */
export function activeGroup(session: MetaSession): number {
  const tile = frameTileAt(doc(session), session.frame, session.activeCell.x, session.activeCell.y)
  return tile >> 3
}

/**
 * Rewrites the colour pair of the group the active cell's tile belongs to.
 *
 * SCREEN 1 only, and it is the one way to use a colour a group does not already
 * spend — the palette offers nothing else, because anything else would just be
 * dropped. It recolours all eight tiles in the group, which is the hardware, so
 * the caller confirms first.
 */
export function setGroupPair(session: MetaSession, fg: number, bg: number): void {
  const store = useTilesetStore()
  const tileset = store.patternDoc(session.tilesetPath)
  if (!tileset || tileset.mode !== 'sc1') return
  const group = activeGroup(session)
  const groupColors = tileset.groupColors.slice()
  const next = mergeColorByte(fg, bg)
  if (groupColors[group] === next) return
  groupColors[group] = next
  store.set(session.tilesetPath, { ...tileset, groupColors }, session.path)
  session.status = `Group ${group} recoloured — all 8 tiles in it changed.`
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
  const reclaimed = reclaimOrphans(session)
  session.status = reclaimed ? `Reclaimed ${reclaimed} tile${reclaimed === 1 ? '' : 's'}.` : 'Nothing to compact.'
}

/**
 * Removes the tiles this session created and no longer uses; returns how many.
 *
 * Run automatically on save, which is what keeps a session's experiments out of
 * the file: a stroke redrawn ten times leaves nine dead tiles behind and none
 * of them should reach disk. Safe without asking precisely because the set is
 * limited to what *this session* appended — nothing that existed when the file
 * was opened can be touched, so no closed map can be stranded.
 *
 * Removal renumbers, so the mapping goes out on the reorder seam: live for
 * files that are open, persisted for files that are not.
 */
export function reclaimOrphans(session: MetaSession): number {
  const store = useTilesetStore()
  const orphans = orphansOf(session)
  if (!orphans.length) return 0
  // Highest first, so each removal leaves the lower indices alone and the
  // mappings compose in one pass.
  const descending = [...orphans].sort((a, b) => b - a)

  if (session.kind === 'metabtiles') {
    const tileset = store.bitmapDoc(session.tilesetPath)
    if (!tileset) return 0
    let next = tileset
    let mapping = Array.from({ length: tileset.count }, (_, i) => i)
    for (const tile of descending) {
      const step = removeBitmapTile(next, tile)
      if (step.doc === next) continue
      next = step.doc
      mapping = mapping.map((index) => step.remap[index] ?? 0)
    }
    if (next === tileset) return 0
    publishReclaim(session, next, mapping)
    return orphans.length
  }

  const tileset = store.patternDoc(session.tilesetPath)
  if (!tileset) return 0
  let next = tileset
  let mapping = tileset.tiles.map((_, i) => i)
  for (const tile of descending) {
    const step = removeTile(next, tile)
    if (step.doc === next) continue
    next = step.doc
    mapping = mapping.map((index) => step.mapping[index] ?? 0)
  }
  if (next === tileset) return 0
  publishReclaim(session, next, mapping)
  return orphans.length
}

function publishReclaim(session: MetaSession, next: TilesDoc | BitmapTilesDoc, mapping: number[]): void {
  const store = useTilesetStore()
  store.set(session.tilesetPath, next, session.path)
  const event: TilesReorderEvent = { path: session.tilesetPath, mapping, at: Date.now() }
  store.appendReorder(session.tilesetPath, event)
  // This session's own document is renumbered by the listener below, along with
  // every other meta over the same tileset — *not* here as well. Doing both
  // applied the mapping twice, which sent the surviving tile to 0. The emit is
  // synchronous, so the document is correct by the time this returns.
  emitTilesReordered(event)
  session.appended = []
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
