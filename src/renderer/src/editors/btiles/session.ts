/**
 * Per-tab state for the bitmap tileset editor.
 *
 * Same shape as the other resource editors: a module-level map keyed by tab id
 * (= the project-relative path), a `History<BitmapTilesDoc>` for undo, and a
 * `preview` doc that a drag writes into so a stroke costs one undo step rather
 * than one per pixel.
 *
 * It uses the plain `History<T>` the sprite, map and screen editors share
 * rather than the tile editor's labelled variant. The tile editor needs labels
 * and a renumbering map in its history because a `.tiles.json` reorder has to
 * be replayed into every map that references it; a bitmap tileset's reorder
 * renumbers its own flags and blocks inside `reorderBitmapTiles`, and the map
 * side of that is the same `reorderLog` seam — not something the undo stack
 * carries.
 */

import { shallowReactive } from 'vue'
import {
  addBitmapTile,
  blockFromSelection,
  blockPixels,
  paintBlock,
  createBitmapBlock,
  paintTile,
  removeBitmapBlock,
  removeBitmapTile,
  renameBitmapBlock,
  reorderBitmapTiles,
  setBitmapPaletteEntry,
  setBitmapTileFlagBit,
  bitmapToolPoints,
  type Point,
  type TileTool
} from '../../../../shared/bitmap-tile-editor'
import {
  MAX_BITMAP_TILES,
  normalizeBitmapTiles,
  resizeTiles,
  sliceImage,
  tileImage,
  type BitmapTilesDoc
} from '../../../../shared/msx/bitmap-tile'
import type { TileBlock } from '../../../../shared/msx/tile'
import type { BitmapMode } from '../../../../shared/msx/modes'
import {
  canRedo as historyCanRedo,
  canUndo as historyCanUndo,
  createHistory,
  pushHistory,
  redo as redoHistory,
  undo as undoHistory,
  type History
} from '../../../../shared/history'
import { defaultExport, serializeResource, type ExportBlock } from '../../../../shared/msx/resource'
import type { ImportResult } from '../../composables/useImageImport'
import { useTabsStore } from '../../stores/tabsStore'

export interface BitmapTileSession {
  path: string
  history: History<BitmapTilesDoc>
  loading: boolean
  error: string | null
  dirty: boolean

  /** Which tile the pixel canvas is showing, when no block is open. */
  selected: number
  /** An open block, drawn on the canvas as one image. Null means a single tile. */
  block: number | null
  tool: TileTool
  color: number
  zoom: number
  filled: boolean
  status: string

  /**
   * A rectangle of the bank grid, in tiles — what "block from selection" names.
   * Null when only one tile is picked, which is the ordinary case.
   */
  selection: { start: number; width: number; height: number } | null

  /** The doc a drag is writing into; `doc()` prefers it over `history.present`. */
  preview: BitmapTilesDoc | null
  /** Where the current drag started, in tile pixels. */
  dragFrom: Point | null
}

const sessions = new Map<string, BitmapTileSession>()

export function bitmapTileSession(path: string): BitmapTileSession {
  const existing = sessions.get(path)
  if (existing) return existing
  const session = shallowReactive<BitmapTileSession>({
    path,
    history: createHistory(normalizeBitmapTiles({})),
    loading: true,
    error: null,
    dirty: false,
    selected: 0,
    block: null,
    tool: 'pencil',
    color: 1,
    zoom: 20,
    filled: false,
    status: '',
    selection: null,
    preview: null,
    dragFrom: null
  })
  sessions.set(path, session)
  void load(session)
  return session
}

export function pruneBitmapTileSessions(openPaths: Set<string>): void {
  for (const path of [...sessions.keys()]) if (!openPaths.has(path)) sessions.delete(path)
}

export function doc(session: BitmapTileSession): BitmapTilesDoc {
  return session.preview ?? session.history.present
}

async function load(session: BitmapTileSession): Promise<void> {
  try {
    const text = await window.api.invoke('fs:read', { path: session.path })
    // A file the Explorer just created is empty — that is a new tileset, not an error.
    let raw: unknown = {}
    try {
      raw = text.trim() ? JSON.parse(text) : {}
    } catch {
      raw = {}
    }
    session.history = createHistory(normalizeBitmapTiles(raw))
    session.error = null
  } catch (error) {
    session.error = `Couldn't open ${session.path}: ${String(error)}`
  } finally {
    session.loading = false
  }
}

export async function saveSession(session: BitmapTileSession): Promise<void> {
  await window.api.invoke('fs:write', {
    path: session.path,
    content: serializeResource({ kind: 'btiles', doc: doc(session) })
  })
  session.dirty = false
  useTabsStore().setDirty(session.path, false)
  session.status = 'Saved'
}

function markDirty(session: BitmapTileSession): void {
  session.dirty = true
  useTabsStore().setDirty(session.path, true)
}

/** Every mutation lands here: one undo step, and the tab goes dirty. No-op when nothing changed. */
export function commit(session: BitmapTileSession, next: BitmapTilesDoc): void {
  const history = pushHistory(session.history, next)
  if (history === session.history) return
  session.history = history
  markDirty(session)
}

export function undo(session: BitmapTileSession): void {
  session.preview = null
  session.history = undoHistory(session.history)
  clampSelection(session)
  markDirty(session)
}

export function redo(session: BitmapTileSession): void {
  session.preview = null
  session.history = redoHistory(session.history)
  clampSelection(session)
  markDirty(session)
}

export const canUndo = (session: BitmapTileSession): boolean => historyCanUndo(session.history)
export const canRedo = (session: BitmapTileSession): boolean => historyCanRedo(session.history)

function clampSelection(session: BitmapTileSession): void {
  session.selected = Math.max(0, Math.min(doc(session).count - 1, session.selected))
}

/** The block on the canvas, if one is open and still exists. */
export function activeBlock(session: BitmapTileSession): TileBlock | null {
  const index = session.block
  if (index === null) return null
  return doc(session).blocks[index] ?? null
}

/** What the canvas draws: one tile, or a whole block composed. */
export function activePixels(session: BitmapTileSession): Uint8Array {
  const block = activeBlock(session)
  const current = doc(session)
  return block ? blockPixels(current, block) : tileImage(current, session.selected)
}

/** Canvas size in pixels — one tile, or `w × h` tiles of them. */
export function activeExtent(session: BitmapTileSession): { width: number; height: number } {
  const block = activeBlock(session)
  const current = doc(session)
  return block
    ? { width: block.width * current.width, height: block.height * current.height }
    : { width: current.width, height: current.height }
}

/**
 * Opens a block on the canvas, or `null` to go back to the selected tile.
 *
 * Opening lands on the block's first cell, because everything the side panel
 * edits per tile — the flags — reads `selected`, and the tile that happened to
 * be picked in the bank need not be one of the block's. Re-selecting a block
 * that is already open does nothing at all: the whole row opens it now, so
 * clicking into the name to rename it would otherwise throw away the cell the
 * user just picked.
 */
export function selectBlock(session: BitmapTileSession, index: number | null): void {
  if (index !== null && session.block === index) return
  const block = index === null ? undefined : doc(session).blocks[index]
  session.block = block ? index : null
  if (block) session.selected = block.tiles[0] ?? session.selected
}

/**
 * Picks which cell of the open block the flags apply to, without leaving the
 * block — deliberately not `selectTile`, which nulls it.
 */
export function focusCell(session: BitmapTileSession, tileIndex: number): void {
  if (activeBlock(session)?.tiles.includes(tileIndex)) session.selected = tileIndex
}

// ── painting ────────────────────────────────────────────────────────────────

/**
 * A drag paints into `preview`, so the whole stroke is one undo step. The
 * pencil samples from the last point rather than the drag origin, or a fast
 * drag would draw a fan of lines back to where the mouse went down.
 */
export function strokeStart(session: BitmapTileSession, point: Point): void {
  session.dragFrom = point
  session.preview = doc(session)
  strokeMove(session, point)
}

export function strokeMove(session: BitmapTileSession, point: Point): void {
  const from = session.dragFrom
  if (!from || !session.preview) return
  const current = session.preview
  const block = activeBlock(session)
  // Tools work in canvas space, which is the block's whole extent when one is
  // open — so the fill sees across tile edges, as it should for one picture.
  const extent = block
    ? { width: block.width * current.width, height: block.height * current.height }
    : { width: current.width, height: current.height }
  const pixels = block ? blockPixels(current, block) : tileImage(current, session.selected)
  const points = bitmapToolPoints(session.tool, from, point, pixels, extent.width, extent.height, session.filled)
  session.preview = block
    ? paintBlock(current, block, points, session.color)
    : paintTile(current, session.selected, points, session.color)
  // Pencil and line differ in what "from" means: a pencil walks, the others rubber-band.
  if (session.tool === 'pencil') session.dragFrom = point
}

export function strokeEnd(session: BitmapTileSession): void {
  const painted = session.preview
  session.preview = null
  session.dragFrom = null
  if (painted) commit(session, painted)
}

// ── the bank ────────────────────────────────────────────────────────────────

export function addTile(session: BitmapTileSession): void {
  const next = addBitmapTile(doc(session))
  commit(session, next)
  session.selected = next.count - 1
}

export function removeTile(session: BitmapTileSession, index: number): void {
  const { doc: next } = removeBitmapTile(doc(session), index)
  commit(session, next)
  clampSelection(session)
}

export function moveTile(session: BitmapTileSession, from: number, to: number): void {
  const { doc: next } = reorderBitmapTiles(doc(session), from, to)
  commit(session, next)
  session.selected = Math.max(0, Math.min(next.count - 1, to))
}

/** The grid marquee. Goes through the session like every other bit of tab state. */
export function setSelection(
  session: BitmapTileSession,
  selection: { start: number; width: number; height: number } | null
): void {
  session.selection = selection
}

export function selectTile(session: BitmapTileSession, index: number): void {
  session.selected = index
  // Picking a tile leaves whatever block was open — the canvas can only show one.
  session.block = null
}

export function setFlagBit(session: BitmapTileSession, bit: number, on: boolean): void {
  commit(session, setBitmapTileFlagBit(doc(session), session.selected, bit, on))
}

export function setPaletteEntry(session: BitmapTileSession, index: number, grb: number): void {
  commit(session, setBitmapPaletteEntry(doc(session), index, grb))
}

export function setTileSize(session: BitmapTileSession, width: number, height: number): void {
  commit(session, resizeTiles(doc(session), width, height))
}

/**
 * Switches the tileset to another mode. The pixels are palette indices either
 * way, so they survive; what changes is how they are packed on export and, for
 * sc3, what a "pixel" means — a 4×4 block rather than a dot.
 *
 * Goes through `normalizeBitmapTiles` rather than a spread, because the mode
 * carries constraints with it: sc3 forces an even width and caps the tile at the
 * screen, and only the V9938 modes keep a palette.
 */
export function setMode(session: BitmapTileSession, mode: BitmapMode): void {
  const current = doc(session)
  if (current.mode === mode) return
  commit(session, normalizeBitmapTiles({ ...current, mode, palette: undefined }))
}

/** The index a masked blit treats as see-through — what turns a tile bank into a software-sprite sheet. */
export function setTransparent(session: BitmapTileSession, transparent: number | null): void {
  commit(session, { ...doc(session), transparent })
}

/** Gives a tileset an export target, named after the file like every other kind. */
export function setupExport(session: BitmapTileSession): void {
  commit(session, { ...doc(session), export: defaultExport(session.path) })
}

export function patchExport(session: BitmapTileSession, patch: Partial<ExportBlock>): void {
  const current = doc(session)
  if (!current.export) return
  commit(session, { ...current, export: { ...current.export, ...patch } })
}

// ── blocks ──────────────────────────────────────────────────────────────────

/**
 * A blank block, on fresh tiles of its own. It grows the bank, so it can run
 * out of room — and saying so beats quietly making something smaller.
 */
export function addBlock(session: BitmapTileSession, name: string, width: number, height: number): void {
  const current = doc(session)
  const next = createBitmapBlock(current, name, width, height)
  if (next === current) {
    session.status = `No room for a ${width}×${height} block — the bank holds ${MAX_BITMAP_TILES} tiles.`
    return
  }
  commit(session, next)
  session.block = next.blocks.length - 1
  session.selected = next.count - width * height
}

/**
 * Names the grid marquee and keeps it — the way a block is actually made.
 *
 * Auto-named rather than asking for a name first, exactly as the pattern tile
 * editor does: the useful moment is while the rectangle is selected, and a name
 * typed before the thing exists is a name typed twice. Rename it in the list.
 */
export function addBlockFromGrid(session: BitmapTileSession, cols: number): void {
  const selection = session.selection
  if (!selection) {
    session.status = 'Drag across the bank to select tiles first.'
    return
  }
  const current = doc(session)
  const name = `block_${current.blocks.length}`
  commit(session, blockFromSelection(current, name, cols, selection.start, selection.width, selection.height))
  // Open it straight away: the reason to keep a selection is to work on it.
  session.block = doc(session).blocks.length - 1
  session.status = `Kept ${selection.width}×${selection.height} as ${name}`
}

export function dropBlock(session: BitmapTileSession, index: number): void {
  if (session.block === index) session.block = null
  else if (session.block !== null && session.block > index) session.block--
  commit(session, removeBitmapBlock(doc(session), index))
}

export function renameBlock(session: BitmapTileSession, index: number, name: string): void {
  commit(session, renameBitmapBlock(doc(session), index, name))
}

// ── import ──────────────────────────────────────────────────────────────────

/**
 * Cuts an imported picture into the bank — the thing a bitmap tileset can do
 * and a pattern tileset cannot.
 *
 * The converted image brings its own palette, and it replaces the tileset's:
 * the tiles about to be cut are indices *into that palette*, so keeping the old
 * one would recolour every one of them.
 */
export function importImage(
  session: BitmapTileSession,
  result: ImportResult,
  dedupe: boolean
): void {
  const current = doc(session)
  const sliced = sliceImage(
    { ...current, palette: result.palette ?? current.palette },
    result.indices,
    result.width,
    result.height,
    { dedupe }
  )
  commit(session, sliced.doc)
  session.selected = 0
  const cells = sliced.sourceCols * sliced.sourceRows
  session.status =
    `Cut ${cells} cells into ${sliced.doc.count} tiles` +
    (dedupe && sliced.doc.count < cells ? ` (${cells - sliced.doc.count} repeats collapsed)` : '')
}
