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
import type { ImportResult } from '../../composables/useImageImport'
import { mapFromLayout } from '../../../../shared/msx/map'
import { defaultExport, serializeResource } from '../../../../shared/msx/resource'
import {
  blankTileEntry,
  blockPixels,
  createTilesDoc,
  MAX_BLOCK,
  MAX_TILES,
  convertTileMode,
  normalizeTiles,
  packTiles,
  regroupAfterTile0Shift,
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
  blockColorTargets,
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
import { useTilesetStore } from '../../stores/tilesetStore'

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
  /** "Apply to the whole block" — session-only, not saved with the document. */
  blockWide: boolean
  tool: TileTool
  filledRect: boolean
  /** Palette index the tools paint with. */
  color: number
  /** Canvas pixel size and tileset-grid tile size, both in screen px. */
  zoom: number
  gridZoom: number
  conflict: PendingConflict | null
  status: string
  /** Drops this session's subscription to the shared tileset. */
  stopWatching: (() => void) | null
  /** Doc as it was before the stroke in progress, so one drag = one undo step. */
  strokeBase: TilesDoc | null
  strokeActive: boolean
}

const sessions = new Map<string, TileSession>()

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
    blockWide: false,
    tool: 'pencil',
    filledRect: false,
    color: 15,
    zoom: 32,
    gridZoom: 24,
    conflict: null,
    status: '',
    stopWatching: null,
    strokeBase: null,
    strokeActive: false
  })
  sessions.set(path, session)
  // Another editor — a meta-tile being painted — can append tiles to this same
  // document. Adopt them as a new present rather than merging: redo would
  // otherwise replay onto a bank that has moved on. Safe because painting only
  // ever appends, so the two can never disagree about an existing tile.
  session.stopWatching = useTilesetStore().onExternalChange(path, path, (doc) => {
    // The store speaks both kinds; a `.tiles.json` session only ever hears
    // about its own, so the narrowing here is a fact of the path, not a guess.
    const pattern = doc as TilesDoc
    session.doc = pattern
    session.history = pushHistory(session.history, pattern, 'tiles added elsewhere')
  })
  void load(session)
  return session
}

/** Drops sessions for tabs that were closed. Called by the tab component when the tab set changes. */
export function pruneTileSessions(openPaths: Set<string>): void {
  for (const path of [...sessions.keys()]) {
    if (openPaths.has(path)) continue
    sessions.get(path)?.stopWatching?.()
    sessions.delete(path)
    // The store keeps a dirty document alive: the tab that closed may not be
    // the one that dirtied it.
    useTilesetStore().release(path)
  }
}

async function load(session: TileSession): Promise<void> {
  try {
    // The store owns the document, reads the file, and decides whether a brand
    // new tileset reserves tile 0. This session is one of possibly several
    // readers of it.
    // patternDoc after load, not the load result: this session only ever
    // holds a `.tiles.json`, and the store speaks both kinds.
    await useTilesetStore().load(session.path)
    session.doc = useTilesetStore().patternDoc(session.path) ?? session.doc
    session.history = initHistory(session.doc)
    session.error = null
  } catch (error) {
    session.error = `Couldn't open ${session.path}: ${String(error)}`
  } finally {
    session.loading = false
  }
}

export async function saveSession(session: TileSession): Promise<void> {
  await useTilesetStore().save(session.path)
  session.dirty = false
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
  useTilesetStore().set(session.path, doc, session.path)
  markDirty(session)
}

// ── import (Spec 08's own image import) ─────────────────────────────────────

/**
 * Applies a converted image to the open tileset: packs it, commits the
 * result, saves it, and — unless a `.map.json` already sits beside it —
 * writes the arrangement `packTiles` computed as a map next to it.
 *
 * Extracted out of `TileEditorTab.vue` rather than left inline: this is
 * exactly the kind of branching logic CLAUDE.md keeps out of a component, and
 * `offset`'s ordering below is the likeliest silent defect in the whole
 * import path — worth a test that would actually fail if it regressed, which
 * a comment alone cannot give it.
 */
export async function importImage(
  session: TileSession,
  result: ImportResult,
  mode: 'replace' | 'merge',
  dedup: boolean
): Promise<void> {
  const packed = packTiles(result.indices, result.width, result.height, session.doc.mode, { dedup })
  // Replacing into a bank that already reserves tile 0 would otherwise let
  // `normalizeTiles` blank the freshly imported top-left tile in place below —
  // silently losing it, since `packTiles`'s own layout always starts at index
  // 0. Prepending a blank instead shifts every tile up by one, the same
  // migration `reserveTile0()` performs by hand, so the art survives and the
  // layout's own indices need the same +1.
  const keepsTile0 = mode === 'replace' && session.doc.reserveTile0
  // Read before `commit`, from the pre-import tile count: once commit lands,
  // `session.doc.tiles` is the post-merge count and every index below would be
  // offset by the wrong amount. `count`, not `.tiles.length` — on a banked
  // doc the array's length also covers the shared region far past `count`
  // (see `TilesDoc.sharedTiles`), which a merge must not treat as occupied
  // common space to append after.
  const offset = mode === 'replace' ? (keepsTile0 ? 1 : 0) : session.doc.count
  // How much common room is left once the shared reservation at the top is
  // honored — the ceiling both branches below clamp against, in place of the
  // bare `MAX_TILES` a banked doc would let spill into it.
  const commonCeiling = MAX_TILES - session.doc.sharedTiles
  const commonTiles = (
    mode === 'replace'
      ? keepsTile0
        ? [blankTileEntry(session.doc.mode), ...packed.doc.tiles]
        : packed.doc.tiles
      : [...session.doc.tiles.slice(0, session.doc.count), ...packed.doc.tiles]
  ).slice(0, commonCeiling)
  // The shared region sits at its own hardware index far above `count` in
  // this same sparse `tiles` array (see `TilesDoc.sharedTiles`) — an import
  // never touches it either way. `commonTiles` above only ever spans the
  // common range, so the shared tail has to be reattached at its own index
  // before `normalizeTiles` runs: otherwise its shared-region rebuild would
  // find nothing there and blank a meta's live art while `sharedTiles` still
  // claims it. A no-op for an unbanked doc, where `sharedTiles` is 0 and the
  // loop never runs.
  const tiles = commonTiles.slice()
  for (let i = commonCeiling; i < MAX_TILES; i++) tiles[i] = session.doc.tiles[i]
  const doc = normalizeTiles({
    ...session.doc,
    // sc4 can adopt the converter's optimized palette; MSX1 modes keep the fixed one.
    palette: session.doc.mode === 'sc4' ? (result.palette ?? session.doc.palette) : null,
    count: commonTiles.length,
    tiles,
    groupColors: mode === 'replace' ? packed.doc.groupColors : session.doc.groupColors
  })
  // sc1 shares one color pair across 8 tiles, so the prepend above moves group
  // boundaries the same way `reserveTile0()`'s own shift does, and needs the
  // same fix-up. `packed.doc.groupColors` — not `doc.groupColors`, which
  // `normalizeTiles` just padded with white-on-black defaults for the group the
  // shift added — is the pre-shift array `regroupAfterTile0Shift` expects to
  // extend from.
  const rebucket = keepsTile0 ? regroupAfterTile0Shift({ ...doc, groupColors: packed.doc.groupColors }) : null
  const finalDoc = rebucket ? { ...doc, groupColors: rebucket.doc.groupColors } : doc
  commit(session, finalDoc, 'import image')

  const rebucketed = rebucket?.lossyTiles.length ?? 0
  // Two distinct 256-tile failures. `packTiles` itself may not have placed
  // every source cell — the bank it built alone already hit 256, so `layout`
  // is short. Separately, merging into (or shifting for) an existing bank can
  // drop tiles `packTiles` *did* place, once the combined array is clamped
  // back to `MAX_TILES` above — `dropped` is exactly how many, computed from
  // the pre-clamp total (`offset + packed.doc.count`) against what survived
  // (`doc.count`), not from a boolean "is anything out of range" guess.
  const cols = Math.floor(result.width / TILE_SIZE)
  const rows = Math.floor(result.height / TILE_SIZE)
  const short = cols * rows - packed.layout.length
  const dropped = offset + packed.doc.count - doc.count

  const status =
    `Imported ${packed.doc.count} tiles` +
    (packed.lossyTiles.length ? ` — ${packed.lossyTiles.length} needed color reduction` : '') +
    (rebucketed > 0
      ? `; ${rebucketed} tile${rebucketed === 1 ? '' : 's'} at the reserved-tile-0 shift lost the color pair it was authored with`
      : '') +
    (short > 0 ? `; ${short} cells could not be placed (the bank filled at 256 tiles)` : '') +
    (dropped > 0
      ? `; ${dropped} tile${dropped === 1 ? '' : 's'} could not be added — the bank is full, and this map will not export until it has room for them`
      : '')

  // The map has to describe what a build will actually read — the tileset as
  // it lands on disk, not just the in-memory doc `commit` above updated — so
  // it must not be written until the save succeeds, and never on its own if
  // the save fails: a map paired with the wrong tileset is worse than no map.
  try {
    await saveSession(session)
  } catch (error) {
    session.status = `${status} — failed to save the tileset, so the map was not written: ${String(error)}`
    return
  }

  const mapPath = session.path.replace(/\.tiles\.json$/, '.map.json')
  // A merge just to top up the bank must never silently destroy a map that
  // was already sitting next to it: `demo_msx1/res/intro.tiles.json` ships
  // beside a hand-authored `intro.map.json`, exactly this pairing, and this
  // import used to overwrite it with no prompt and no undo.
  let clobbers: unknown
  try {
    clobbers = await window.api.invoke('fs:stat', { path: mapPath })
  } catch (error) {
    // Fail safe: never write a file this could not confirm was safe to write.
    session.status = `${status} — could not check ${mapPath}, so the map was not written: ${String(error)}`
    return
  }
  if (clobbers) {
    session.status = `${status}; ${mapPath} already exists and was left untouched`
    return
  }

  const map = mapFromLayout(session.path, packed.layout, cols, rows, offset)
  map.export = defaultExport(mapPath)
  session.status = status
  try {
    await window.api.invoke('fs:write', { path: mapPath, content: serializeResource({ kind: 'map', doc: map }) })
  } catch (error) {
    session.status = `${status} — failed to write ${mapPath}: ${String(error)}`
  }
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
      // Left button paints the row's ink, right its paper — the same model as
      // the meta-tile editor, and the reason a second colour lands instead of
      // raising a popover the user has to answer per pixel.
      session.doc = applyRoleStroke(session.doc, tile, tilePoints, session.color, role)
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

/**
 * Opens a named block on the canvas (or `null` to go back to the marquee).
 * Opening one starts on its first tile, but re-opening the block that is
 * already open does nothing: the block row is clickable across its whole width
 * now, so clicking into the name field to rename it would otherwise throw away
 * whichever cell `focusCell` had put the colour and flag controls on.
 */
export function selectBlock(session: TileSession, index: number | null): void {
  if (index !== null && session.block === index) return
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
 * Picks which tile of the open block the colour, swap, flag and transform
 * controls act on — without leaving the block. Deliberately not `select()`,
 * which nulls `session.block` and so would close the block to recolour one of
 * its tiles.
 */
export function focusCell(session: TileSession, tileIndex: number): void {
  if (activeBlock(session)?.tiles.includes(tileIndex)) session.active = tileIndex
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

/**
 * The tiles a colour edit writes: the focused cell alone, or every tile of the
 * open block when "whole block" is ticked, each once. `y` stays a *tile* row
 * either way — the strip is and stays the hardware's eight rows per tile, so on
 * a two-tall block row 3 is canvas rows 3 and 11. The FG/BG pair is a per-tile
 * attribute and a block has no other kind.
 */
function colorTargets(session: TileSession): number[] {
  const block = session.blockWide ? activeBlock(session) : null
  return block ? blockColorTargets(session.doc, block) : [session.active]
}

export function swapRow(session: TileSession, y: number): void {
  // Folded into one `commit`, so the whole block comes back in one undo step.
  const doc = colorTargets(session).reduce((next, tile) => swapRowColors(next, tile, y), session.doc)
  commit(session, doc, 'swap FG/BG')
}

export function setRow(session: TileSession, y: number, fg: number, bg: number): void {
  const doc = colorTargets(session).reduce((next, tile) => setRowColors(next, tile, y, fg, bg), session.doc)
  commit(session, doc, 'row colors')
}

/**
 * The colour strip's "whole block". Session state rather than document state,
 * and left alone when a block closes: `colorTargets` falls back to the focused
 * tile when there is no block to spread over, so a stale tick can't misfire.
 */
export function setBlockWide(session: TileSession, on: boolean): void {
  session.blockWide = on
}

export function setPalette(session: TileSession, index: number, grb: number): void {
  commit(session, setPaletteEntry(session.doc, index, grb), 'palette')
}

export function addTile(session: TileSession): void {
  // Same reservation `createBlock` respects: a new common tile must not land
  // on an index the shared region already owns.
  if (session.doc.count >= MAX_TILES - session.doc.sharedTiles) return
  commit(session, normalizeTiles({ ...session.doc, count: session.doc.count + 1 }), 'add tile')
  select(session, session.doc.count - 1)
}

/**
 * Deletes a tile and renumbers the rest, publishing the remap on the same seam
 * a reorder uses so open maps follow. Cells that pointed at it fall back to
 * tile 0.
 */
export function deleteTile(session: TileSession, index: number): void {
  deleteTiles(session, [index])
}

/**
 * Deletes a whole selection: one renumbering, one undo step, one confirmation.
 *
 * Removing tiles one at a time is not the same operation repeated — each
 * removal renumbers everything above it, so the second index in the caller's
 * list no longer means what it meant when the user picked it. Highest first
 * keeps the lower ones valid, and the per-step mappings compose into the single
 * mapping that maps and blocks replay.
 */
export function deleteTiles(session: TileSession, indices: readonly number[]): void {
  const doomed = [...new Set(indices)]
    .filter((index) => index >= 0 && index < session.doc.count)
    .sort((a, b) => b - a)
  if (!doomed.length) return
  if (doomed.length >= session.doc.count) {
    session.status = 'A tileset needs at least one tile.'
    return
  }

  let next = session.doc
  let mapping = session.doc.tiles.map((_, i) => i)
  for (const index of doomed) {
    const step = removeTile(next, index)
    if (step.doc === next) break
    next = step.doc
    mapping = mapping.map((value) => step.mapping[value] ?? 0)
  }
  if (next === session.doc) return

  publishRemap(session, mapping)
  const label = doomed.length === 1 ? `delete tile ${doomed[0]}` : `delete ${doomed.length} tiles`
  commit(session, next, label, mapping)
  selectBlock(session, null)
  // Land on the lowest index that was removed — where the gap now is.
  select(session, Math.min(doomed[doomed.length - 1], next.count - 1))
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
  // Persisted in the store so it survives the save, and emitted so files that
  // are open renumber now. A file that is closed replays the log on open.
  useTilesetStore().appendReorder(session.path, event)
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
  useTilesetStore().set(session.path, session.doc, session.path)
  session.conflict = null
  session.strokeBase = null
  if (session.active >= session.doc.count) select(session, session.doc.count - 1)
  markDirty(session)
}

export { canRedo, canUndo }
