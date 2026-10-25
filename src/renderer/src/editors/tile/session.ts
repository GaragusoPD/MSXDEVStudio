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
import { defaultExport, parseResource, RESOURCE_DIR, RESOURCE_SUFFIXES, serializeResource } from '../../../../shared/msx/resource'
import {
  animationFromBlock,
  animBaseName,
  animModesCompatible,
  animRefFrom,
  attachAnimation,
  detachAnimation,
  withAnimFrame,
  type TileAnimDoc
} from '../../../../shared/msx/tile-anim'
import { detachMeta, isOwnedMeta, refreshMetas, resolveMeta, type LoadedMeta } from '../../../../shared/msx/meta-owned'
import { onAnimSaved } from '../anim/events'
import { removeMetaFromTileset } from '../meta-removal'
import { useResourcesStore } from '../../stores/resourcesStore'
import {
  bankTileAt,
  BANK_COUNT,
  blankTileEntry,
  blockPixels,
  colorByteAt,
  createTilesDoc,
  isBanked,
  isMetaPath,
  MAX_BLOCK,
  MAX_TILES,
  metaOwning,
  animCells,
  animWindowProblems,
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
  type MetaBinding,
  type PaintConflict,
  type TileAnimBinding,
  type TileBlock,
  type TileEntry,
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
  type StrokeResult,
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
  /** The bank this conflict was raised against, or null for the common set — so
   * resolving it peels the answer back into the same place it was read from. */
  bank: number | null
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
  /**
   * Which of SCREEN 2/4's three pattern banks the grid and canvas show —
   * 0-based (`BANK_COUNT` of them), meaningful only once `isBanked(doc)`; an
   * ordinary tileset ignores it. `active` keeps meaning the same hardware
   * index across a bank switch, since every bank is a view onto the same
   * 0..255 range.
   */
  bank: number
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
    bank: 0,
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
  // Another editor can change this same document: a meta-tile being painted
  // appends tiles to it, and a map painted in edit mode rewrites a tile in
  // place. Adopt the result as a new present rather than merging — redo would
  // otherwise replay onto a bank that has moved on. That used to be loss-free
  // because painting only ever appended, so the two could never disagree about
  // an existing tile; an edit stroke made it not so. An undo here can now
  // revert a map's stroke, visibly, as the step labelled below — and the map
  // guards its own undo against what this tab does since (`map/session.ts`,
  // `swapTileEdits`).
  //
  // What this tab must never do is stack a step on a *replacement*. A map's
  // promotion to banked hands the store a whole new document, and one undo
  // here would push the unbanked snapshot back under a map layer whose bytes
  // are now bank-relative — wrong art, no error, on a document the user just
  // agreed to change. A banked/unbanked flip is that replacement, so the
  // history starts over from it instead.
  session.stopWatching = useTilesetStore().onExternalChange(path, path, (doc) => {
    // The store speaks both kinds; a `.tiles.json` session only ever hears
    // about its own, so the narrowing here is a fact of the path, not a guess.
    const pattern = doc as TilesDoc
    const replaced = isBanked(session.doc) !== isBanked(pattern)
    session.doc = pattern
    if (replaced) {
      session.history = initHistory(pattern)
      session.status =
        `The tileset was switched to ${isBanked(pattern) ? 'banked' : 'unbanked'} elsewhere — ` +
        'undo history starts over from here.'
      return
    }
    session.history = pushHistory(session.history, pattern, 'changed elsewhere')
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
    await refreshMetaBindings(session)
    await refreshAnimations(session)
    // What the Animations panel offers to attach comes from the project's
    // resource list, which nothing has filled if the Resources panel was never shown.
    if (!useResourcesStore().entries.length) void useResourcesStore().refresh()
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
  if (mode === 'replace' && session.doc.metas.length && !(await removeMetasForReplace(session))) return
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
    groupColors: mode === 'replace' ? packed.doc.groupColors : session.doc.groupColors,
    // A replace puts unrelated art at every index, so a window would now name
    // tiles that are not its animation's — and the exporter would write frame 0
    // over the imported picture. Detached; a merge only appends and keeps them.
    animations: mode === 'replace' ? [] : session.doc.animations
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

// ── bank editing (Task 7) ───────────────────────────────────────────────────
//
// A bank's own art is a dense run of hardware indices 0..L-1 — never a sparse
// set (see `bankLoadHelperC` in `shared/msx/tile.ts`, which loads a bank's
// override table as exactly that many tiles from offset 0). So there is no
// way to give one hardware index its own art without every index below it
// also becoming "this bank's own", even when they still look exactly like the
// common tile they used to fall back to. `writeBankTile` is where that
// growth happens; `bankView`/`editBankEntry` are what let every existing
// pixel/row/transform function do the actual edit without knowing banks
// exist at all.

/**
 * The document as the selected bank sees it: `tiles[index]` substituted for
 * that bank's own art at hardware index `index` (`bankTileAt`). Handed to
 * `paintPixel`/`setRowColors`/`swapRowColors`/`transformTile` unchanged, so
 * the two-colors-per-row constraint and every transform work the same as they
 * always have — they only ever read `doc.tiles[index]`, and that's now the
 * bank's entry instead of the common one.
 */
function bankView(doc: TilesDoc, bank: number, index: number): TilesDoc {
  const tiles = doc.tiles.slice()
  tiles[index] = bankTileAt(doc, bank, index)
  return { ...doc, tiles }
}

/**
 * Writes `entry` into bank `bank` at hardware index `index`, growing the
 * override array from wherever it currently ends through `index` — see the
 * section comment for why that growth is unavoidable. Every newly created
 * slot below `index` is seeded from `bankTileAt`, so nothing the user isn't
 * looking at changes appearance; only the bank's own budget shrinks.
 */
function writeBankTile(doc: TilesDoc, bank: number, index: number, entry: TileEntry): TilesDoc {
  const grown = (doc.bankTiles[bank] ?? []).slice()
  for (let i = grown.length; i < index; i++) grown[i] = bankTileAt(doc, bank, i)
  grown[index] = entry
  const bankTiles = doc.bankTiles.slice()
  bankTiles[bank] = grown
  return { ...doc, bankTiles }
}

/**
 * Runs `edit` against the bank's own view of `index` and peels the result back
 * into `bankTiles[bank]`. `edit` returning its input unchanged (the pattern
 * `applyRoleStroke` uses for "nothing actually changed") is passed straight
 * through as `doc`, so a stroke that painted nothing doesn't grow the bank
 * array or manufacture a spurious undo step.
 */
function editBankEntry(doc: TilesDoc, bank: number, index: number, edit: (view: TilesDoc) => TilesDoc): TilesDoc {
  const view = bankView(doc, bank, index)
  const edited = edit(view)
  return edited === view ? doc : writeBankTile(doc, bank, index, edited.tiles[index])
}

/** `applyStroke`, but through the selected bank's own art at `tileIndex` (see `bankView`). */
function applyBankStroke(
  doc: TilesDoc,
  bank: number,
  tileIndex: number,
  points: readonly Point[],
  color: number,
  resolution?: 'fg' | 'bg'
): StrokeResult {
  const result = applyStroke(bankView(doc, bank, tileIndex), tileIndex, points, color, resolution)
  const next = writeBankTile(doc, bank, tileIndex, result.doc.tiles[tileIndex])
  return result.ok
    ? { ok: true, doc: next, changed: result.changed }
    : { ok: false, doc: next, conflict: result.conflict, pending: result.pending }
}

/** The bank the canvas is currently editing, or null on an ordinary (unbanked) tileset. */
function activeBank(session: TileSession): number | null {
  return isBanked(session.doc) ? session.bank : null
}

/**
 * False for a shared (meta-tile) index — editing one from a bank view would
 * silently repaint all three banks while the user is looking at one, which is
 * exactly the lie this editor must not tell — and for index 0 when
 * `reserveTile0` locks it blank in every bank, the same rule the common
 * tileset already enforces.
 */
function bankIndexEditable(doc: TilesDoc, index: number): boolean {
  return index < MAX_TILES - doc.sharedTiles && !(doc.reserveTile0 && index === 0)
}

function bankEditRefusal(doc: TilesDoc, index: number): string {
  return index >= MAX_TILES - doc.sharedTiles
    ? `Tile ${index} is shared meta-tile art — the same picture in every bank. Edit it from the meta-tile editor.`
    : 'Tile 0 is reserved blank in every bank.'
}

/**
 * "bank 1: 180 + 48 shared = 228 / 256" — spells out the arithmetic
 * `bankCapacityLeft` runs, so the budget is visible before a stroke hits the
 * wall rather than only after.
 */
export function bankBudgetLabel(doc: TilesDoc, bank: number): string {
  const overrides = doc.bankTiles[bank]?.length ?? 0
  const shared = doc.sharedTiles
  return `bank ${bank + 1}: ${overrides} + ${shared} shared = ${overrides + shared} / ${MAX_TILES}`
}

/** Chooses which pattern bank the grid and canvas edit — clamped, since the UI only ever offers `BANK_COUNT` of them. */
export function setBank(session: TileSession, bank: number): void {
  const value = Number.isFinite(bank) ? Math.round(bank) : session.bank
  session.bank = Math.max(0, Math.min(BANK_COUNT - 1, value))
}

/**
 * The FG/BG byte tile `index` row `y` shows right now — the selected bank's
 * own byte when banked, so the side panel's strip and the canvas's role-color
 * preview agree with what a stroke is actually about to write.
 */
export function tileColorByte(session: TileSession, index: number, y: number): number {
  const bank = activeBank(session)
  return colorByteAt(bank !== null ? bankView(session.doc, bank, index) : session.doc, index, y)
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
  const bank = activeBank(session)
  // In block mode the points are in block space and can span several tiles, so
  // the stroke becomes one stroke per tile. A conflict stops it there — the
  // popover answers for one tile, and the rest of the stroke is dropped, the
  // same as a single-tile stroke that gets interrupted. Blocks never open on a
  // banked tileset (see `activeBlock`), so a bank stroke is always one tile.
  for (const [tile, tilePoints] of strokesByTile(session, points)) {
    if (bank !== null && !bankIndexEditable(session.doc, tile)) {
      session.status = bankEditRefusal(session.doc, tile)
      continue
    }
    if (refuseDerived(session, [tile])) continue
    if (role) {
      // Left button paints the row's ink, right its paper — the same model as
      // the meta-tile editor, and the reason a second colour lands instead of
      // raising a popover the user has to answer per pixel.
      session.doc =
        bank !== null
          ? editBankEntry(session.doc, bank, tile, (view) => applyRoleStroke(view, tile, tilePoints, session.color, role))
          : applyRoleStroke(session.doc, tile, tilePoints, session.color, role)
      continue
    }
    const result =
      bank !== null
        ? applyBankStroke(session.doc, bank, tile, tilePoints, session.color)
        : applyStroke(session.doc, tile, tilePoints, session.color)
    session.doc = result.doc
    if (!result.ok) {
      session.conflict = { conflict: result.conflict, pending: result.pending, color: session.color, tileIndex: tile, bank }
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
  const result =
    open.bank !== null
      ? applyBankStroke(session.doc, open.bank, open.tileIndex, open.pending, open.color, resolution)
      : applyStroke(session.doc, open.tileIndex, open.pending, open.color, resolution)
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
 *
 * Also null on any banked tileset. A block's tiles are indices into the
 * *common* set (`TileBlock.tiles`), which is not what a bank view shows or
 * edits — spreading one colour edit or transform over several hardware
 * indices at once would either silently touch the common tileset while the
 * user is looking at a bank, or require blocks to mean something per-bank
 * they were never designed to. The grid falls back to single-tile selection
 * whenever `isBanked(doc)`; see `TileGrid.vue`.
 */
export function activeBlock(session: TileSession): TileBlock | null {
  if (isBanked(session.doc)) return null
  if (session.block !== null) return session.doc.blocks[session.block] ?? null
  const marquee = selectionBlock(session.selection, session.columns)
  // Undo can shrink the bank under a selection made before it.
  return marquee?.tiles.every((tile) => tile < session.doc.count) ? marquee : null
}

/** What the canvas draws and the tools flood-fill over: one tile, or a whole block. */
export function activePixels(session: TileSession): Uint8Array {
  const block = activeBlock(session)
  if (block) return blockPixels(session.doc, block)
  const bank = activeBank(session)
  return tilePixels(bank !== null ? bankView(session.doc, bank, session.active) : session.doc, session.active)
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
  // A block is `width × height` references into the *common* set — nothing a
  // bank view shows or lets `activeBlock` open (see its own comment) — so
  // starting one here would create a block nobody can paint from this canvas.
  if (isBanked(session.doc)) {
    session.status = 'Blocks reference the common tileset, which a bank view does not show — not available here.'
    return
  }
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

// ── attached animations ─────────────────────────────────────────────────────

/**
 * The animation whose window holds `index` in the view the canvas shows — the
 * common set, or the selected bank — or null.
 */
export function animationAt(session: TileSession, index: number): TileAnimBinding | null {
  const bank = activeBank(session)
  return (
    session.doc.animations.find(
      (binding) => (binding.bank === null || binding.bank === bank) && index >= binding.slot && index < binding.slot + animCells(binding)
    ) ?? null
  )
}

/**
 * The attached meta-tile a still cell of which shows `index` in the view the
 * canvas shows, or null. A bank's own override at that index is the bank's
 * art, not the meta's.
 */
export function metaAt(session: TileSession, index: number): MetaBinding | null {
  const bank = activeBank(session)
  if (bank !== null && session.doc.bankTiles[bank]?.[index]) return null
  return metaOwning(session.doc, index)
}

/**
 * Why `index` cannot be edited here, or null. A window's art is its
 * animation's frame 0, and a meta-tile's still cells are its own art: both are
 * rebuilt from their files when the tileset opens and before every export, so
 * an edit here would look like it worked and vanish.
 */
function derivedRefusal(session: TileSession, index: number): string | null {
  const binding = animationAt(session, index)
  if (binding) {
    return isMetaPath(binding.path)
      ? `Tile ${index} is a moving part of the meta-tile ${fileOf(binding.path)} — edit its poses there; ` +
          'this tile is rewritten from it at every build.'
      : `Tile ${index} shows the animation ${fileOf(binding.path)} — edit its poses there; ` +
          'this tile is rewritten from it at every build.'
  }
  const meta = metaAt(session, index)
  return meta
    ? `Tile ${index} is part of the meta-tile ${fileOf(meta.path)} — edit it there (open it from the Meta-tiles panel); ` +
        'this tile is rebuilt from it every time the tileset opens and before every build.'
    : null
}

/** Refuses an edit to a derived tile, saying where to make it instead. */
function refuseDerived(session: TileSession, indices: readonly number[]): boolean {
  for (const index of indices) {
    const reason = derivedRefusal(session, index)
    if (reason) {
      session.status = reason
      return true
    }
  }
  return false
}

/**
 * Why these tiles cannot be deleted, or null. A meta-tile's tiles — still
 * cells and window alike — come back the next time it is resolved, so the
 * delete would undo itself; remove the meta from the tileset first, and its
 * tiles become ordinary art. A plain animation's window is detached instead
 * (`deleteTiles`), as it always was.
 */
function deleteRefusal(session: TileSession, indices: readonly number[]): string | null {
  for (const index of indices) {
    const window = animationAt(session, index)
    const meta = window && isMetaPath(window.path) ? window : metaAt(session, index)
    if (meta) {
      return (
        `Tile ${index} is part of the meta-tile ${fileOf(meta.path)}, and would come back the next time the tileset opens. ` +
        'Remove the meta-tile in the Meta-tiles panel first — its tiles then stay as ordinary art you can delete.'
      )
    }
  }
  return null
}

/** Refuses a delete of derived tiles with the reason, before anything asks the user to confirm it. */
export function refuseDelete(session: TileSession, indices: readonly number[]): boolean {
  const reason = deleteRefusal(session, indices)
  if (reason) session.status = reason
  return reason !== null
}

const fileOf = (path: string): string => path.split('/').pop() ?? path

async function readAnimation(path: string): Promise<TileAnimDoc | string> {
  try {
    const parsed = parseResource(path, await window.api.invoke('fs:read', { path }))
    return parsed.kind === 'anim' ? parsed.doc : `${path} is not an animation.`
  } catch (error) {
    return `Couldn't read ${path}: ${String(error)}`
  }
}

/**
 * Attaches the animation at `path` with its window starting at the active
 * tile, in the bank the canvas shows. Refused, with the reason, when the
 * window would write over something it does not own (`animWindowProblems`).
 */
export async function attachAnim(session: TileSession, path: string, slot = session.active): Promise<void> {
  const anim = await readAnimation(path)
  if (typeof anim === 'string') {
    session.status = anim
    return
  }
  if (!animModesCompatible(anim.mode, session.doc.mode)) {
    session.status = `${path.split('/').pop()} holds ${anim.mode} poses, which a ${session.doc.mode} tileset cannot show.`
    return
  }
  const bank = activeBank(session)
  const next = attachAnimation(session.doc, path, anim, { slot, bank, name: anim.export?.name || defaultExport(path).name })
  const problems = animWindowProblems(next)
  if (problems.length) {
    session.status = problems[0]
    return
  }
  commit(session, next, 'attach animation')
  const last = slot + anim.width * anim.height - 1
  session.status = `Attached ${path.split('/').pop()} at tile${last === slot ? ` ${slot}` : `s ${slot}-${last}`}. Call ${defineFor(session)}_AnimReset() once and ${defineFor(session)}_Animate() every frame.`
}

function defineFor(session: TileSession): string {
  return session.doc.export?.name || defaultExport(session.path).name
}

/** Detaches it; the window keeps the pose it shows as ordinary art. */
export function detachAnim(session: TileSession, path: string): void {
  const next = detachAnimation(session.doc, path)
  if (next === session.doc) return
  commit(session, next, 'detach animation')
  session.status = `Detached ${path.split('/').pop()} — its tiles keep the pose they show.`
}

/** The animations in the project this tileset could attach, by path. */
export function attachableAnimations(session: TileSession): string[] {
  // (A meta-tile's window is filed with the animations, under the meta's path;
  // it is attached through the meta, so it never shows up as attachable here.)
  const attached = new Set(session.doc.animations.map((binding) => binding.path))
  return useResourcesStore()
    .entries.filter((entry) => entry.kind === 'anim' && !attached.has(entry.path))
    .map((entry) => entry.path)
}

/**
 * Turns a block used as a pose strip into an animation file and attaches it
 * at `slot` — the migration every project that animated by hand needs, and
 * the one `demo_msx1` went through. The block and its pose tiles are left
 * alone: whether anything else still uses them is the user's call (Remove
 * unused tiles in the map editor's paint mode answers it project-wide).
 */
export async function extractAnimation(
  session: TileSession,
  blockIndex: number,
  frame: { width: number; height: number; duration: number },
  slot: number
): Promise<void> {
  const block = session.doc.blocks[blockIndex]
  if (!block) return
  if (isBanked(session.doc)) {
    session.status = 'Blocks reference the common tileset — extract from an unbanked one.'
    return
  }
  const anim = animationFromBlock(session.doc, block, frame.width, frame.height, frame.duration)
  if (!anim) {
    session.status = `${block.width}×${block.height} does not divide into ${frame.width}×${frame.height} poses.`
    return
  }
  const stem = block.name.replace(/[^A-Za-z0-9_-]/g, '_') || 'anim'
  const path = `${RESOURCE_DIR}/${stem}${RESOURCE_SUFFIXES.anim}`
  if (await window.api.invoke('fs:stat', { path })) {
    session.status = `${path} already exists — rename the block, or attach that file instead.`
    return
  }
  anim.export = defaultExport(path)
  await window.api.invoke('fs:create', { path: RESOURCE_DIR, kind: 'directory' })
  await window.api.invoke('fs:write', { path, content: serializeResource({ kind: 'anim', doc: anim }) })
  await useResourcesStore().refresh()
  await attachAnim(session, path, slot)
}

/**
 * Re-reads every attached animation and refreshes the window's art and the
 * binding's mirror — the editor's half of the rule the exporter keeps too
 * (`refreshTileAnims`), through the same `animRefFrom`. A change is a real
 * edit (the file on disk holds stale art), so it lands as an undo step and
 * dirties the tab, with a status saying why.
 */
async function refreshAnimations(session: TileSession): Promise<void> {
  if (!session.doc.animations.length) return
  const loaded = new Map<string, TileAnimDoc>()
  for (const binding of session.doc.animations) {
    // A meta-tile's window: `refreshMetaBindings` brought it up to date.
    if (isMetaPath(binding.path)) continue
    const anim = await readAnimation(binding.path)
    if (typeof anim !== 'string') loaded.set(binding.path, anim)
  }
  applyAnimations(session, loaded)
}

function applyAnimations(session: TileSession, loaded: ReadonlyMap<string, TileAnimDoc>): void {
  let next = session.doc
  const animations = next.animations.map((binding) => {
    const anim = loaded.get(binding.path)
    return anim ? animRefFrom(binding.path, anim, binding.name || animBaseName(binding.path), binding) : binding
  })
  const mirrorChanged = animations.some((binding, i) => JSON.stringify(binding) !== JSON.stringify(next.animations[i]))
  if (mirrorChanged) next = { ...next, animations }
  for (const binding of next.animations) {
    const anim = loaded.get(binding.path)
    if (anim) next = withAnimFrame(next, binding, anim)
  }
  if (next === session.doc) return
  commit(session, next, 'refresh animation')
  session.status = 'An attached animation changed since this tileset was saved — its window now shows the new first pose.'
}

// One subscription for every open tileset: an animation or a meta-tile saved
// in its editor shows up in the tilesets it is attached to straight away.
onAnimSaved((event) => {
  const { doc } = event
  for (const session of sessions.values()) {
    if (isOwnedMeta(doc)) {
      if (!session.doc.metas.some((binding) => binding.path === event.path)) continue
      applyMetas(session, new Map([[event.path, { meta: doc, name: doc.export?.name || defaultExport(event.path).name }]]))
      continue
    }
    if (!session.doc.animations.some((binding) => binding.path === event.path)) continue
    applyAnimations(session, new Map([[event.path, doc]]))
  }
})

// ── attached meta-tiles ─────────────────────────────────────────────────────

/** A meta-tile file as `refreshMetas` takes it — or why it cannot be attached. */
async function readOwnedMeta(path: string): Promise<LoadedMeta> {
  const file = path.split('/').pop() ?? path
  try {
    const parsed = parseResource(path, await window.api.invoke('fs:read', { path }))
    if (parsed.kind !== 'metatiles') return `${file} is not a meta-tile.`
    return { meta: parsed.doc, name: parsed.doc.export?.name || defaultExport(path).name }
  } catch (error) {
    return `Couldn't read ${path}: ${String(error)}`
  }
}

/**
 * Re-resolves every attached meta from its file — the editor's half of the
 * rule the exporter keeps (`refreshTileMetas`), through the same
 * `refreshMetas`. A meta edited since this tileset was saved gets its new
 * tiles here, as an undo step that dirties the tab, so what the editor shows
 * is what the next build will export.
 */
async function refreshMetaBindings(session: TileSession): Promise<void> {
  if (!session.doc.metas.length) return
  const loaded = new Map<string, LoadedMeta>()
  for (const binding of session.doc.metas) loaded.set(binding.path, await readOwnedMeta(binding.path))
  applyMetas(session, loaded)
}

function applyMetas(session: TileSession, loaded: ReadonlyMap<string, LoadedMeta>): void {
  const { doc, problems, changed } = refreshMetas(session.doc, loaded)
  if (doc !== session.doc) {
    commit(session, doc, 'refresh meta-tile')
    session.status = `${changed.map((path) => path.split('/').pop()).join(', ')} changed since this tileset was saved — its tiles are up to date again.`
  }
  if (problems.length) session.status = problems[0]
}

/**
 * Attaches the meta-tile at `path`: a tile for each still cell (shared with
 * identical art), and a window at the end of the set for the cells that move.
 * Nothing already in the tileset changes.
 */
export async function attachMetaFile(session: TileSession, path: string): Promise<void> {
  const loaded = await readOwnedMeta(path)
  if (typeof loaded === 'string') {
    session.status = loaded
    return
  }
  const result = resolveMeta(session.doc, path, loaded.meta, loaded.name)
  if (typeof result === 'string') {
    session.status = result
    return
  }
  commit(session, result.doc, 'attach meta-tile')
  const window = result.doc.animations.find((binding) => binding.path === path)
  const file = path.split('/').pop()
  session.status = window
    ? `Attached ${file}: tiles ${window.slot}-${window.slot + animCells(window) - 1} move. Call ${defineFor(session)}_AnimReset() once and ${defineFor(session)}_Animate() every frame.`
    : `Attached ${file}. Draw it with ${defineFor(session)}_DrawMeta(), or place it on a map.`
}

/**
 * Removes it from this tileset, and from every map drawn with it that places
 * it (`meta-removal.ts`) — asking first when one does. Its tiles stay as
 * ordinary art and its window stops moving; the tileset's half is one undo
 * step here.
 */
export async function removeMetaFile(session: TileSession, path: string): Promise<void> {
  const status = await removeMetaFromTileset(session.path, path, () => detachStep(session, path))
  if (status !== null) session.status = status
}

/** The tileset's half of a removal: one undo step, false when it was not attached. */
function detachStep(session: TileSession, path: string): boolean {
  const next = detachMeta(session.doc, path)
  if (next === session.doc) return false
  commit(session, next, 'remove meta-tile')
  return true
}

/**
 * Before an import replaces the whole set: removes every attached meta-tile,
 * from the maps that place them too, after one question for all of them. Left
 * attached, each would rebuild its art over the new picture the next time the
 * tileset opens — the import would look like it half-worked. False when the
 * user declined or a removal could not be done; the import stops there.
 */
async function removeMetasForReplace(session: TileSession): Promise<boolean> {
  const names = session.doc.metas.map((binding) => fileOf(binding.path).replace(/\.meta-tiles\.json$/, ''))
  if (
    !window.confirm(
      `Replacing the whole tileset removes its ${names.length === 1 ? 'meta-tile' : `${names.length} meta-tiles`} ` +
        `(${names.join(', ')}), and takes their placements off every map drawn with it — otherwise they would rebuild ` +
        'their art over the new picture the next time the tileset opens. Their art stays in their own files; ' +
        'importing with Merge keeps them attached. Continue?'
    )
  ) {
    session.status = 'Import cancelled — the tileset is unchanged.'
    return false
  }
  for (const { path } of [...session.doc.metas]) {
    const status = await removeMetaFromTileset(session.path, path, () => detachStep(session, path), { persist: true, confirmed: true })
    if (session.doc.metas.some((binding) => binding.path === path)) {
      session.status = status ?? `Couldn't remove ${fileOf(path)}, so nothing was imported.`
      return false
    }
  }
  return true
}

/** The meta-tiles in the project not attached here yet, by path. */
export function attachableMetas(session: TileSession): string[] {
  const attached = new Set(session.doc.metas.map((binding) => binding.path))
  return useResourcesStore()
    .entries.filter((entry) => entry.kind === 'metatiles' && !attached.has(entry.path))
    .map((entry) => entry.path)
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
  // `copyTiles` reads `doc.tiles` — the common set — regardless of which bank
  // the canvas is actually showing. Copying from a bank view would silently
  // copy different pixels than the ones on screen, so it's refused rather
  // than taught to read the bank: nothing here needs a cross-bank clipboard.
  if (isBanked(session.doc)) {
    session.status = 'Copy/paste works on the common tileset — not available from a bank view.'
    return
  }
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
  // See `copySelection`: `pasteTiles` writes into the common set, which a
  // bank view neither shows nor edits.
  if (isBanked(session.doc)) {
    session.status = 'Copy/paste works on the common tileset — not available from a bank view.'
    return
  }
  const mode = session.doc.mode
  const { doc, pasted } = pasteTiles(session.doc, source, session.active, session.columns)
  // A paste that lands on a window would be overwritten by the animation's
  // frame 0 at the next export — say so now, not after the build.
  const landed = doc.tiles.flatMap((tile, index) => (tile !== session.doc.tiles[index] ? [index] : []))
  if (refuseDerived(session, landed)) return
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
  if (refuseDerived(session, [session.active])) return
  const bank = activeBank(session)
  if (bank !== null) {
    if (!bankIndexEditable(session.doc, session.active)) {
      session.status = bankEditRefusal(session.doc, session.active)
      return
    }
    const { doc: editedView, lossyRows } = transformTile(bankView(session.doc, bank, session.active), session.active, op)
    commit(session, writeBankTile(session.doc, bank, session.active, editedView.tiles[session.active]), op)
    session.status = lossyRows.length
      ? `${op}: rows ${lossyRows.join(', ')} had more than two colors and were reduced.`
      : ''
    return
  }
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
  if (refuseDerived(session, colorTargets(session))) return
  const bank = activeBank(session)
  if (bank !== null) {
    if (!bankIndexEditable(session.doc, session.active)) {
      session.status = bankEditRefusal(session.doc, session.active)
      return
    }
    commit(session, editBankEntry(session.doc, bank, session.active, (view) => swapRowColors(view, session.active, y)), 'swap FG/BG')
    return
  }
  // Folded into one `commit`, so the whole block comes back in one undo step.
  const doc = colorTargets(session).reduce((next, tile) => swapRowColors(next, tile, y), session.doc)
  commit(session, doc, 'swap FG/BG')
}

export function setRow(session: TileSession, y: number, fg: number, bg: number): void {
  if (refuseDerived(session, colorTargets(session))) return
  const bank = activeBank(session)
  if (bank !== null) {
    if (!bankIndexEditable(session.doc, session.active)) {
      session.status = bankEditRefusal(session.doc, session.active)
      return
    }
    commit(
      session,
      editBankEntry(session.doc, bank, session.active, (view) => setRowColors(view, session.active, y, fg, bg)),
      'row colors'
    )
    return
  }
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
  // `removeTile` itself now refuses a common-range removal on a banked
  // tileset (see `shared/msx/tile.ts`) — a bank's own overrides are
  // self-contained art anchored at fixed hardware indices, not references
  // into `tiles`, so they never move with a renumber, and that cannot be
  // fixed for `replayReorders` (`shared/map-editor.ts`), which replays a
  // logged mapping onto a map opened later rather than one already open. This
  // guard is no longer the enforcement, only the user-facing message over it:
  // a status the user can read beats the silent no-op `removeTile` would
  // otherwise hand back.
  if (isBanked(session.doc)) {
    session.status = "Deleting renumbers the common tileset, and a bank's own art does not renumber with it — not available on a banked tileset."
    return
  }
  const doomed = [...new Set(indices)]
    .filter((index) => index >= 0 && index < session.doc.count)
    .sort((a, b) => b - a)
  if (!doomed.length) return
  if (doomed.length >= session.doc.count) {
    session.status = 'A tileset needs at least one tile.'
    return
  }
  if (refuseDelete(session, doomed)) return

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
  const detached = session.doc.animations.filter((binding) => !next.animations.some((kept) => kept.path === binding.path))
  commit(session, next, label, mapping)
  if (detached.length) {
    session.status = `Detached ${detached.map((binding) => binding.path.split('/').pop()).join(', ')}: a deleted tile was part of its window.`
  }
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
  // Same reasoning as `deleteTiles`'s guard: `reorderTiles` itself now
  // refuses a banked tileset (see `shared/msx/tile.ts`), so this is the
  // user-facing message over that enforcement, not the enforcement itself.
  if (isBanked(session.doc)) {
    session.status = "Reordering renumbers the common tileset, and a bank's own art does not renumber with it — not available on a banked tileset."
    return
  }
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
  // `active` is a hardware index (0..255) in a bank view, not a position in
  // the common set — `count` on a fully-banked doc is often tiny (a bare
  // `packBankedTiles` import leaves it at 1), so clamping against it here
  // would yank the selection to tile 0 on every undo/redo of a bank edit.
  if (!isBanked(session.doc) && session.active >= session.doc.count) select(session, session.doc.count - 1)
  markDirty(session)
}

export { canRedo, canUndo }
