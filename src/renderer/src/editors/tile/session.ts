/**
 * Per-tab state for the tile editor (Spec 08).
 *
 * Same shape as `editors/monaco-models.ts`: a module-level map keyed by tab id
 * (= the project-relative path), so a tileset keeps its selection, tools and
 * undo stack while the user switches tabs. Every mutation goes through the
 * pure functions in `shared/tile-editor.ts` and `shared/msx/tile.ts` — nothing
 * here knows a hardware rule.
 */

import { shallowReactive, shallowRef } from 'vue'
import type { TileMode } from '../../../../shared/msx/modes'
import { parseResource, serializeResource } from '../../../../shared/msx/resource'
import {
  blockPixels,
  createTilesDoc,
  MAX_BLOCK,
  MAX_TILES,
  convertTileMode,
  normalizeTiles,
  removeTile,
  reorderTiles,
  swapRowColors,
  TILE_SIZE,
  tileModeConversionLossy,
  tilePixels,
  type PaintConflict,
  type TileBlock,
  type TilesDoc
} from '../../../../shared/msx/tile'
import {
  applyRoleStroke,
  applyStroke,
  blockFromTiles,
  copyTiles,
  pasteTiles,
  canRedo,
  createBlock,
  GRID_COLUMNS,
  removeBlock,
  selectionBlock,
  splitBlockPoints,
  canUndo,
  emitTilesReordered,
  historyDoc,
  initHistory,
  invertMapping,
  pushHistory,
  redoHistory,
  setPaletteEntry,
  setRowColors,
  setTileFlagBit,
  transformTile,
  undoHistory,
  type Point,
  type TileClipboard,
  type TileHistory,
  type TileTool,
  type TileTransform,
  type TilesReorderEvent
} from '../../../../shared/tile-editor'
import { useTabsStore } from '../../stores/tabsStore'

/** A conflict waiting on the popover's answer, plus what still has to be painted after it. */
export interface PendingConflict {
  conflict: PaintConflict
  pending: Point[]
  color: number
  tileIndex: number
}

export interface TileSession {
  path: string
  doc: TilesDoc
  history: TileHistory
  loading: boolean
  error: string | null
  dirty: boolean
  /** Selected tiles in the grid; `active` is the one the row/flag controls act on. */
  selection: number[]
  active: number
  /** Tiles per row in the sheet — the grid wraps to its pane, so this is measured, not fixed. */
  columns: number
  /**
   * Index into `doc.blocks` when the canvas is editing a multi-tile design
   * rather than a single tile. The tiles are the same tiles either way — a
   * block is only a bigger window onto them.
   */
  block: number | null
  tool: TileTool
  filledRect: boolean
  /** Palette index the tools paint with. */
  color: number
  /** Canvas pixel size and tileset-grid tile size, both in screen px. */
  zoom: number
  gridZoom: number
  conflict: PendingConflict | null
  /** Reorders applied in this file, persisted on save — see `shared/tile-editor.ts` for the Spec 10 seam. */
  reorderLog: TilesReorderEvent[]
  status: string
  /** Doc as it was before the stroke in progress, so one drag = one undo step. */
  strokeBase: TilesDoc | null
  strokeActive: boolean
}

const sessions = new Map<string, TileSession>()

/** `.tiles.json` carries the reorder log as an extra key `normalizeTiles` ignores. */
type SavedTiles = TilesDoc & { reorderLog?: TilesReorderEvent[] }

export function tileSession(path: string): TileSession {
  const existing = sessions.get(path)
  if (existing) return existing
  const session = shallowReactive<TileSession>({
    path,
    doc: createTilesDoc('sc2', 1),
    history: initHistory(createTilesDoc('sc2', 1)),
    loading: true,
    error: null,
    dirty: false,
    selection: [0],
    active: 0,
    columns: GRID_COLUMNS,
    block: null,
    tool: 'pencil',
    filledRect: false,
    color: 15,
    zoom: 32,
    gridZoom: 24,
    conflict: null,
    reorderLog: [],
    status: '',
    strokeBase: null,
    strokeActive: false
  })
  sessions.set(path, session)
  void load(session)
  return session
}

/** Drops sessions for tabs that were closed. Called by the tab component when the tab set changes. */
export function pruneTileSessions(openPaths: Set<string>): void {
  for (const path of [...sessions.keys()]) if (!openPaths.has(path)) sessions.delete(path)
}

async function load(session: TileSession): Promise<void> {
  try {
    const text = await window.api.invoke('fs:read', { path: session.path })
    const parsed = parseResource(session.path, text) as { kind: 'tiles'; doc: TilesDoc }
    const raw = JSON.parse(text) as SavedTiles
    session.doc = parsed.doc
    session.reorderLog = Array.isArray(raw.reorderLog) ? raw.reorderLog : []
    session.history = initHistory(parsed.doc)
    session.error = null
  } catch (error) {
    session.error = `Couldn't open ${session.path}: ${String(error)}`
  } finally {
    session.loading = false
  }
}

export async function saveSession(session: TileSession): Promise<void> {
  const doc: SavedTiles = { ...session.doc }
  if (session.reorderLog.length) doc.reorderLog = session.reorderLog
  await window.api.invoke('fs:write', { path: session.path, content: serializeResource({ kind: 'tiles', doc }) })
  session.dirty = false
  useTabsStore().setDirty(session.path, false)
  session.status = 'Saved'
}

function markDirty(session: TileSession): void {
  session.dirty = true
  useTabsStore().setDirty(session.path, true)
}

/** Replaces the document and pushes one undo step. `remap` is set for reorders only. */
export function commit(session: TileSession, doc: TilesDoc, label: string, remap?: number[]): void {
  session.doc = doc
  session.history = pushHistory(session.history, doc, label, remap)
  markDirty(session)
}

// ── painting ────────────────────────────────────────────────────────────────

export function beginStroke(session: TileSession): void {
  if (session.conflict) return
  if (!session.strokeBase) session.strokeBase = session.doc
  session.strokeActive = true
}

/** Applies `points` with the current color, parking the stroke if the mode's constraint refuses a pixel. */
/**
 * `role` is the mouse button: left paints the row's foreground, right its
 * background, which is a plain bit edit and can never conflict. Without a role
 * (the palette's "paint this color" path) a third color in a row still raises
 * the conflict popover.
 */
export function paint(session: TileSession, points: Point[], role?: 'fg' | 'bg'): void {
  if (session.conflict) return
  // In block mode the points are in block space and can span several tiles, so
  // the stroke becomes one stroke per tile. A conflict stops it there — the
  // popover answers for one tile, and the rest of the stroke is dropped, the
  // same as a single-tile stroke that gets interrupted.
  for (const [tile, tilePoints] of strokesByTile(session, points)) {
    if (role) {
      session.doc = applyRoleStroke(session.doc, tile, tilePoints, role)
      continue
    }
    const result = applyStroke(session.doc, tile, tilePoints, session.color)
    session.doc = result.doc
    if (!result.ok) {
      session.conflict = { conflict: result.conflict, pending: result.pending, color: session.color, tileIndex: tile }
      return
    }
  }
}

/** The active tile alone, or one entry per tile the block-space points touch. */
function strokesByTile(session: TileSession, points: Point[]): Map<number, Point[]> {
  const block = activeBlock(session)
  return block ? splitBlockPoints(block, points) : new Map([[session.active, points]])
}

export function endStroke(session: TileSession, label: string): void {
  session.strokeActive = false
  if (!session.conflict) finishStroke(session, label)
}

function finishStroke(session: TileSession, label: string): void {
  const base = session.strokeBase
  session.strokeBase = null
  if (base && session.doc !== base) commit(session, session.doc, label)
}

/** The popover's "replace row FG" / "replace row BG". */
export function resolveConflict(session: TileSession, resolution: 'fg' | 'bg'): void {
  const open = session.conflict
  if (!open) return
  session.conflict = null
  const result = applyStroke(session.doc, open.tileIndex, open.pending, open.color, resolution)
  session.doc = result.doc
  if (!result.ok) {
    session.conflict = { ...open, conflict: result.conflict, pending: result.pending }
    return
  }
  if (!session.strokeActive) finishStroke(session, 'paint')
}

/** The popover's "cancel": the whole stroke is rolled back, so nothing half-painted survives. */
export function cancelConflict(session: TileSession): void {
  session.conflict = null
  if (session.strokeBase) session.doc = session.strokeBase
  session.strokeBase = null
  session.strokeActive = false
}

/**
 * The block the canvas is editing: a named one when the user opened it, and
 * otherwise the grid marquee itself — selecting a rectangle of tiles is all it
 * takes to edit them as one image. Null when a single tile is selected.
 */
export function activeBlock(session: TileSession): TileBlock | null {
  if (session.block !== null) return session.doc.blocks[session.block] ?? null
  const marquee = selectionBlock(session.selection, session.columns)
  // Undo can shrink the bank under a selection made before it.
  return marquee?.tiles.every((tile) => tile < session.doc.count) ? marquee : null
}

/** What the canvas draws and the tools flood-fill over: one tile, or a whole block. */
export function activePixels(session: TileSession): Uint8Array {
  const block = activeBlock(session)
  return block ? blockPixels(session.doc, block) : tilePixels(session.doc, session.active)
}

/** Canvas size in pixels — `8 × 8` for a tile, `w*8 × h*8` for a block. */
export function activeExtent(session: TileSession): { width: number; height: number } {
  const block = activeBlock(session)
  return block
    ? { width: block.width * TILE_SIZE, height: block.height * TILE_SIZE }
    : { width: TILE_SIZE, height: TILE_SIZE }
}

/** Opens a named block on the canvas (or `null` to go back to the marquee). */
export function selectBlock(session: TileSession, index: number | null): void {
  const block = index === null ? null : session.doc.blocks[index]
  if (!block) {
    session.block = null
    return
  }
  // `select` clears `session.block`, so the open block is set after it.
  select(session, block.tiles[0] ?? 0, block.tiles)
  session.block = index
}

/**
 * Names the current marquee as a block, so it survives the selection and can be
 * exported. The tiles stay where they are — nothing is copied.
 */
export function nameSelection(session: TileSession): void {
  const marquee = activeBlock(session)
  if (!marquee) return
  if (marquee.width > MAX_BLOCK || marquee.height > MAX_BLOCK) {
    session.status = `Blocks are at most ${MAX_BLOCK}×${MAX_BLOCK} tiles; this selection is ${marquee.width}×${marquee.height}.`
    return
  }
  const name = `block_${session.doc.blocks.length}`
  commit(session, blockFromTiles(session.doc, name, marquee.width, marquee.height, marquee.tiles), 'name block')
  selectBlock(session, session.doc.blocks.length - 1)
}

export function addBlock(session: TileSession, name: string, width: number, height: number): void {
  const next = createBlock(session.doc, name, width, height)
  if (next === session.doc) {
    session.status = `No room for a ${width}×${height} block — the bank holds ${MAX_TILES} tiles.`
    return
  }
  commit(session, next, 'add block')
  selectBlock(session, next.blocks.length - 1)
}

export function deleteBlock(session: TileSession, index: number): void {
  const next = removeBlock(session.doc, index)
  if (next === session.doc) return
  commit(session, next, 'remove block')
  selectBlock(session, null)
}

// ── clipboard ───────────────────────────────────────────────────────────────

/**
 * One clipboard for every open tileset, deliberately: copying a tile out of one
 * bank and into another is the case worth supporting, and a per-session
 * clipboard would be the one thing that couldn't do it. A `ref` rather than a
 * plain variable so the toolbar's paste button can be disabled until there is
 * something to paste.
 */
const clipboard = shallowRef<TileClipboard | null>(null)

export function tileClipboard(): TileClipboard | null {
  return clipboard.value
}

/** Copies the selection — pixels, per-row colours where the mode has them, and gameplay flags. */
export function copySelection(session: TileSession): void {
  const copied = copyTiles(session.doc, session.selection, session.columns)
  if (!copied) {
    session.status = 'Select a tile, or drag a rectangle, before copying.'
    return
  }
  clipboard.value = copied
  session.status = `Copied ${copied.width}×${copied.height} tile${copied.width * copied.height === 1 ? '' : 's'}`
}

/** Pastes with the clipboard's top-left on the active tile. */
export function pasteClipboard(session: TileSession): void {
  const source = clipboard.value
  if (!source) return
  const mode = session.doc.mode
  const { doc, pasted } = pasteTiles(session.doc, source, session.active, session.columns)
  if (!pasted) {
    session.status = 'Nothing pasted — that corner leaves no room for the clipboard.'
    return
  }
  commit(session, doc, `paste ${source.width}×${source.height}`)
  // sc1 keeps colour per group of eight tiles rather than per tile, so pixels
  // travel and colours stay behind. Better said than silently observed.
  session.status =
    source.mode === mode && mode !== 'sc1'
      ? `Pasted ${pasted} tile${pasted === 1 ? '' : 's'}`
      : `Pasted ${pasted} tile${pasted === 1 ? '' : 's'} — patterns only; ${mode === 'sc1' ? 'sc1 colours belong to the group of eight' : `colours don't carry from ${source.mode}`}.`
}

// ── the rest of the toolbar ─────────────────────────────────────────────────

export function transform(session: TileSession, op: TileTransform): void {
  const { doc, lossyRows } = transformTile(session.doc, session.active, op)
  commit(session, doc, op)
  session.status = lossyRows.length
    ? `${op}: rows ${lossyRows.join(', ')} had more than two colors and were reduced.`
    : ''
}

export function swapRow(session: TileSession, y: number): void {
  commit(session, swapRowColors(session.doc, session.active, y), 'swap FG/BG')
}

export function setRow(session: TileSession, y: number, fg: number, bg: number): void {
  commit(session, setRowColors(session.doc, session.active, y, fg, bg), 'row colors')
}

export function setPalette(session: TileSession, index: number, grb: number): void {
  commit(session, setPaletteEntry(session.doc, index, grb), 'palette')
}

export function addTile(session: TileSession): void {
  if (session.doc.count >= MAX_TILES) return
  commit(session, normalizeTiles({ ...session.doc, count: session.doc.count + 1 }), 'add tile')
  select(session, session.doc.count - 1)
}

/**
 * Deletes a tile and renumbers the rest, publishing the remap on the same seam
 * a reorder uses so open maps follow. Cells that pointed at it fall back to
 * tile 0.
 */
export function deleteTile(session: TileSession, index: number): void {
  const { doc, mapping } = removeTile(session.doc, index)
  if (doc === session.doc) {
    session.status = 'A tileset needs at least one tile.'
    return
  }
  publishRemap(session, mapping)
  commit(session, doc, `delete tile ${index}`, mapping)
  selectBlock(session, null)
  select(session, Math.min(index, doc.count - 1))
}

/**
 * Switches the tileset's colour model. Returns false when the caller should
 * confirm first: going to sc1 collapses per-row colours onto one pair per
 * group of eight tiles.
 */
export function changeMode(session: TileSession, mode: TileMode, force = false): boolean {
  if (mode === session.doc.mode) return true
  if (!force && tileModeConversionLossy(session.doc, mode)) return false
  commit(session, convertTileMode(session.doc, mode), `mode ${mode}`)
  return true
}

/** Flips one of the active tile's eight gameplay bits (the flag squares). */
export function toggleFlag(session: TileSession, bit: number): void {
  const current = session.doc.flags[session.active] ?? 0
  const next = setTileFlagBit(session.doc, session.active, bit, (current & (1 << bit)) === 0)
  if (next !== session.doc) commit(session, next, `flag ${bit + 1}`)
}

export function setColor(session: TileSession, index: number): void {
  session.color = index
}

/** The bank's zoom. A session function because `TileGrid` gets the session as a prop. */
export function setGridZoom(session: TileSession, value: number): void {
  session.gridZoom = Math.max(8, Math.min(64, Math.round(value) || session.gridZoom))
}

export function setTool(session: TileSession, tool: TileTool): void {
  session.tool = tool
}

/**
 * Picks what the canvas edits. A selection of one tile shows that tile, several
 * show the rectangle they span — and either way it leaves the named-block view,
 * so a click in the grid is never swallowed by a block someone opened earlier.
 */
export function select(session: TileSession, index: number, indices?: number[]): void {
  session.active = index
  session.selection = indices ?? [index]
  session.block = null
}

/**
 * The sheet wraps to its pane, so the view measures the column count and tells
 * the session: `activeBlock` reads the selection as a rectangle that many tiles
 * wide. A rewrap changes what a marquee spans, so it collapses to the active
 * tile rather than leaving one the user never drew. An open block owns explicit
 * tiles and doesn't care.
 */
export function setColumns(session: TileSession, columns: number): void {
  if (session.columns === columns) return
  session.columns = columns
  if (session.block === null && session.selection.length > 1) select(session, session.active)
}

/**
 * Moves a tile and publishes the renumbering both ways (live event + persisted
 * log). Rewriting the `.map.json` files themselves is Spec 10's job — see
 * `shared/tile-editor.ts`.
 */
export function reorder(session: TileSession, from: number, to: number): void {
  if (from === to) return
  const { doc, mapping } = reorderTiles(session.doc, from, to)
  publishRemap(session, mapping)
  commit(session, doc, `move tile ${from} → ${to}`, mapping)
  select(session, to)
}

function publishRemap(session: TileSession, mapping: number[]): void {
  const event: TilesReorderEvent = { path: session.path, mapping, at: Date.now() }
  session.reorderLog = [...session.reorderLog, event]
  emitTilesReordered(event)
}

// ── undo/redo ───────────────────────────────────────────────────────────────

export function undo(session: TileSession): void {
  if (!canUndo(session.history)) return
  // Undoing a reorder has to renumber maps back, so the seam gets the inverse mapping.
  const leaving = session.history.entries[session.history.index]
  if (leaving.remap) publishRemap(session, invertMapping(leaving.remap))
  session.history = undoHistory(session.history)
  applyHistory(session)
}

export function redo(session: TileSession): void {
  if (!canRedo(session.history)) return
  session.history = redoHistory(session.history)
  const entered = session.history.entries[session.history.index]
  if (entered.remap) publishRemap(session, entered.remap)
  applyHistory(session)
}

function applyHistory(session: TileSession): void {
  session.doc = historyDoc(session.history)
  session.conflict = null
  session.strokeBase = null
  if (session.active >= session.doc.count) select(session, session.doc.count - 1)
  markDirty(session)
}

export { canRedo, canUndo }
