/**
 * `*.meta-tiles.json`: a meta-tile that **owns its pixels**.
 *
 * It is what an attached animation already is (`tile-anim.ts`): poses stored as
 * tile bytes, no tileset named, attached to as many tilesets as want it. On top
 * of an animation's fields it has a footprint (`holes`, the cells it never
 * writes) and eight gameplay flags. `version: 3` because the two formats before
 * it held tile numbers into one tileset; neither is read any more.
 *
 * Attaching (`resolveMeta`) turns the art into tile numbers in one tileset —
 * `MetaBinding` in `tile.ts`:
 *
 * - see-through cells are 0;
 * - cells that look the same in every pose are still tiles, found or created
 *   among any identical art already there;
 * - cells that change between poses get a **window** — consecutive slots the
 *   tileset's `_Animate()` rewrites, filed in `TilesDoc.animations` under the
 *   meta's path. Every copy animates in step, on screen or not, for nothing per
 *   copy; a house with a smoking chimney rewrites the chimney, not the house.
 *
 * Bitmap meta-tiles (`.meta-btiles.json`) are the other model — references
 * into one bitmap set, `meta-tile.ts` — because a bitmap mode has no pattern
 * table to attach a window to.
 */

import { defineName, type EmitTable, type HelperC } from './emitC'
import { findOrCreateTile, sameEntry } from './meta-paint'
import { MAX_META_SIZE } from './meta-tile'
import { compactTileset } from './tile-compact'
import { isTileMode, type TileMode } from './modes'
import type { ExportBlock } from './resource'
import {
  ANIM_LOOPS,
  animCells,
  animWindowSlotsIn,
  blankTileEntry,
  isBanked,
  MAX_TILES,
  metaCellSlots,
  normalizeTiles,
  remapAnimBindings,
  remapMetaBindings,
  SC1_GROUP,
  TILE_SIZE,
  type AnimLoop,
  type MetaBinding,
  type TileAnimBinding,
  type TileEntry,
  type TilesDoc
} from './tile'
import {
  animModesCompatible,
  animRefFrom,
  decodeTileEntry,
  DEFAULT_ANIM_DURATION,
  MAX_ANIM_CELLS,
  MAX_ANIM_DURATION,
  MAX_ANIM_FRAMES,
  tileAnimTables,
  withAnimFrame,
  type TileAnimDoc,
  type TileAnimFrame
} from './tile-anim'

export interface OwnedMetaDoc {
  version: 3
  /** The byte format the poses are stored in, as `TileAnimDoc.mode`: sc2/sc4 attach to either, sc1 to sc1. */
  mode: TileMode
  /** In tiles, 1..`MAX_META_SIZE` each — any size, per meta. */
  width: number
  height: number
  /** SCREEN 1 only: the ink/paper pair every pose is drawn in, as `TileAnimDoc.pair`. */
  pair: number
  /**
   * `width * height`, row-major. A see-through cell is never written when the
   * meta is drawn, in any pose, so whatever is under it shows — the only kind
   * of transparency a name table has.
   */
  holes: boolean[]
  /** `frames[0]` is the resting pose. One frame is a still meta; more, an animated one. */
  frames: TileAnimFrame[]
  loop: AnimLoop
  /** Eight gameplay bits for the meta as a whole — what it *means* to the game. */
  flags: number
  export: ExportBlock | null
}

/** True for a version-3 document — the parse result of a `.meta-tiles.json` that owns its pixels. */
export function isOwnedMeta(doc: unknown): doc is OwnedMetaDoc {
  return typeof doc === 'object' && doc !== null && (doc as { version?: unknown }).version === 3
}

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = Math.round(Number(value))
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
}

const byte = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? (value | 0) & 0xff : 0)

/** Fills in everything a hand-edited file is missing; never throws. */
export function normalizeOwnedMeta(raw: unknown): OwnedMetaDoc {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const mode: TileMode = isTileMode(String(input.mode)) ? (input.mode as TileMode) : 'sc2'
  const width = clampInt(input.width, 1, MAX_META_SIZE, 2)
  const height = clampInt(input.height, 1, MAX_META_SIZE, 2)
  const cells = width * height
  const rawFrames = Array.isArray(input.frames) && input.frames.length ? (input.frames as unknown[]) : [{}]
  const frames: TileAnimFrame[] = rawFrames.slice(0, MAX_ANIM_FRAMES).map((frame) => {
    const f = (typeof frame === 'object' && frame !== null ? frame : {}) as { tiles?: unknown[]; duration?: unknown }
    return {
      // Resized to the document's own geometry, as an animation's are: every
      // pose is read at the same stride.
      tiles: Array.from({ length: cells }, (_, i) => decodeTileEntry(f.tiles?.[i], mode)),
      duration: clampInt(f.duration, 1, MAX_ANIM_DURATION, DEFAULT_ANIM_DURATION)
    }
  })
  const holes = Array.isArray(input.holes) ? (input.holes as unknown[]) : []
  return {
    version: 3,
    mode,
    width,
    height,
    pair: input.pair === undefined ? 0xf1 : byte(input.pair),
    holes: Array.from({ length: cells }, (_, i) => holes[i] === true),
    frames,
    loop: ANIM_LOOPS.includes(input.loop as AnimLoop) ? (input.loop as AnimLoop) : 'loop',
    flags: byte(input.flags),
    export: (input.export as ExportBlock | undefined) ?? null
  }
}

export function createOwnedMeta(mode: TileMode = 'sc2', width = 2, height = 2): OwnedMetaDoc {
  return normalizeOwnedMeta({ mode, width, height })
}

/** Tiles in one pose. */
export function ownedMetaCells(doc: OwnedMetaDoc): number {
  return doc.width * doc.height
}

/**
 * The cells whose art differs between poses, in reading order — what a window
 * holds when the meta is attached. A see-through cell never moves: it is not
 * drawn at all.
 */
export function movingCells(doc: OwnedMetaDoc): number[] {
  const first = doc.frames[0]?.tiles ?? []
  const out: number[] = []
  for (let i = 0; i < ownedMetaCells(doc); i++) {
    if (doc.holes[i] || !first[i]) continue
    if (doc.frames.some((frame) => !frame.tiles[i] || !sameEntry(frame.tiles[i], first[i]))) out.push(i)
  }
  return out
}

/**
 * The animation a meta's moving cells make: one row of `movingCells` tiles,
 * every pose, the meta's timing. What its window plays, and what its export's
 * `_Patterns`/`_Colors`/`_Durations` hold. Null for a still meta.
 */
export function metaWindowAnim(doc: OwnedMetaDoc): TileAnimDoc | null {
  const moving = movingCells(doc)
  if (!moving.length) return null
  return {
    version: 1,
    mode: doc.mode,
    width: moving.length,
    height: 1,
    pair: doc.pair,
    frames: doc.frames.map((frame) => ({ duration: frame.duration, tiles: moving.map((i) => frame.tiles[i]) })),
    loop: doc.loop,
    export: doc.export
  }
}

export function validateOwnedMeta(doc: OwnedMetaDoc): string[] {
  const problems: string[] = []
  if (doc.version !== 3) problems.push(`Unsupported version ${doc.version}`)
  if (doc.width < 1 || doc.width > MAX_META_SIZE || doc.height < 1 || doc.height > MAX_META_SIZE) {
    problems.push(`Meta size ${doc.width}×${doc.height} outside 1..${MAX_META_SIZE}`)
  }
  const cells = ownedMetaCells(doc)
  if (doc.holes.length !== cells) problems.push(`${doc.holes.length} see-through flags, expected ${cells}`)
  if (!doc.frames.length) problems.push('A meta-tile needs at least one pose')
  if (doc.frames.length > MAX_ANIM_FRAMES) problems.push(`${doc.frames.length} poses; at most ${MAX_ANIM_FRAMES}`)
  doc.frames.forEach((frame, index) => {
    if (frame.tiles.length !== cells) problems.push(`Pose ${index}: ${frame.tiles.length} tiles, expected ${cells}`)
    if (frame.duration < 1 || frame.duration > MAX_ANIM_DURATION) problems.push(`Pose ${index}: duration ${frame.duration} outside 1..${MAX_ANIM_DURATION}`)
  })
  const moving = movingCells(doc).length
  if (moving > MAX_ANIM_CELLS) {
    problems.push(
      `${moving} tiles change between poses; a meta-tile's window holds at most ${MAX_ANIM_CELLS} — keep what moves smaller, or split the meta`
    )
  }
  return problems
}

// ── attaching to a tileset ──────────────────────────────────────────────────

const fileOf = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** A pose's tile as the tileset stores one: sc1 keeps no per-row colour. */
function fit(entry: TileEntry | undefined, mode: TileMode): TileEntry {
  if (!entry) return blankTileEntry(mode)
  if (mode === 'sc1') return { pattern: entry.pattern.slice(), color: [] }
  return { pattern: entry.pattern.slice(), color: entry.color.length ? entry.color.slice() : new Array<number>(TILE_SIZE).fill(0xf1) }
}

/** Whether every sc1 group a window spans is drawn in `pair` — the colour a group of eight shares. */
function groupsMatch(doc: TilesDoc, slot: number, cells: number, pair: number): boolean {
  if (doc.mode !== 'sc1') return true
  for (let group = slot >> 3; group <= (slot + cells - 1) >> 3; group++) {
    if (doc.groupColors[group] !== pair) return false
  }
  return true
}

/**
 * Where a new window of `cells` slots goes: after everything the set already
 * holds — the common range and every bank's own art, which a common window
 * would write over — and below the shared region. In sc1 it starts a fresh
 * group of eight unless the one it lands in is already drawn in `pair`.
 */
function windowSlot(doc: TilesDoc, cells: number, pair: number): number | null {
  let slot = Math.max(doc.count, ...doc.bankTiles.map((bank) => bank.length))
  if (doc.mode === 'sc1' && slot % SC1_GROUP !== 0 && doc.groupColors[slot >> 3] !== pair) {
    slot = (Math.floor(slot / SC1_GROUP) + 1) * SC1_GROUP
  }
  return slot + cells <= MAX_TILES - doc.sharedTiles ? slot : null
}

/** Grows the common range to `count` tiles, blank, and gives sc1's new groups the meta's pair. */
function growTo(doc: TilesDoc, count: number, pair: number): TilesDoc {
  if (count <= doc.count) return doc
  const tiles = doc.tiles.slice()
  const flags = doc.flags.slice()
  for (let i = doc.count; i < count; i++) {
    tiles[i] = blankTileEntry(doc.mode)
    flags[i] = 0
  }
  let groupColors = doc.groupColors
  if (doc.mode === 'sc1') {
    groupColors = doc.groupColors.slice()
    for (let group = Math.ceil(doc.count / SC1_GROUP); group < Math.ceil(count / SC1_GROUP); group++) groupColors[group] = pair
  }
  return { ...doc, count, tiles, flags, groupColors }
}

/**
 * Whether `tile` still shows `entry` wherever a meta can be drawn — so a
 * refresh keeps it instead of finding another. That is what keeps numbers
 * stable across refreshes, and what keeps a migrated meta at the tiles it had.
 */
function keepsArt(doc: TilesDoc, tile: number, entry: TileEntry, pair: number, windows: ReadonlySet<number>): boolean {
  const shared = isBanked(doc) && tile >= MAX_TILES - doc.sharedTiles
  if (tile === 0 || tile >= MAX_TILES || (tile >= doc.count && !shared) || windows.has(tile)) return false
  const art = doc.tiles[tile]
  if (!art || !sameEntry(art, entry)) return false
  if (tile < doc.count && doc.bankTiles.some((bank) => bank[tile] && !sameEntry(bank[tile], art))) return false
  return doc.mode !== 'sc1' || doc.groupColors[tile >> 3] === pair
}

const sameBinding = (a: MetaBinding, b: MetaBinding): boolean => JSON.stringify(a) === JSON.stringify(b)

export interface ResolvedMeta {
  doc: TilesDoc
  binding: MetaBinding
}

/**
 * Attaches `meta` to `tiles`, or refreshes it there: the window for its moving
 * cells, a tile for every still cell, 0 for every see-through one.
 *
 * The one function both the tile editor (attach, load, the meta saved) and the
 * exporter (before every export of a tileset *or a map drawn with it*) call, so
 * they cannot disagree about which tile a cell shows. Deterministic for that
 * reason: same tileset and same meta, same numbers.
 *
 * A refresh changes as little as it can. A still cell keeps its tile while that
 * tile still holds its art; a window keeps its slot while it is still the right
 * size. Only what no longer fits is found again — appended, never rewritten in
 * place, so nothing else drawn with this tileset changes. Returns `tiles`
 * itself when nothing changed, so a refresh that finds the meta as it was is
 * not an edit.
 *
 * A string is the reason it cannot be done.
 */
export function resolveMeta(tiles: TilesDoc, path: string, meta: OwnedMetaDoc, name: string): ResolvedMeta | string {
  const file = fileOf(path)
  if (!animModesCompatible(meta.mode, tiles.mode)) return `${file} is drawn in ${meta.mode}, which a ${tiles.mode} tileset cannot show.`
  const invalid = validateOwnedMeta(meta)
  if (invalid.length) return `${file}: ${invalid[0]}`

  const pair = meta.pair
  const previous = tiles.metas.find((binding) => binding.path === path)
  const oldWindow = tiles.animations.find((binding) => binding.path === path) ?? null
  const moving = movingCells(meta)
  const windowAnim = metaWindowAnim(meta)
  let doc = tiles
  let window: TileAnimBinding | null = null

  if (windowAnim) {
    const keep =
      oldWindow !== null &&
      oldWindow.bank === null &&
      animCells(oldWindow) === moving.length &&
      groupsMatch(doc, oldWindow.slot, moving.length, pair)
    if (keep) {
      window = animRefFrom(path, windowAnim, name, oldWindow)
      const kept = window
      doc = { ...doc, animations: doc.animations.map((binding) => (binding.path === path ? kept : binding)) }
    } else {
      // A window the wrong size moves rather than grows into whatever follows
      // it. The old slots keep their art, as a detached animation's do.
      if (oldWindow) doc = { ...doc, animations: doc.animations.filter((binding) => binding.path !== path) }
      const slot = windowSlot(doc, moving.length, pair)
      if (slot === null) return `${file} needs ${moving.length} free tiles in a row for the cells that move, and the tileset has no room left.`
      doc = growTo(doc, slot + moving.length, pair)
      window = animRefFrom(path, windowAnim, name, { slot, bank: null })
      doc = { ...doc, animations: [...doc.animations, window] }
    }
    doc = withAnimFrame(doc, window, windowAnim)
  } else if (oldWindow) {
    // Its poses stopped differing: nothing left to play.
    doc = { ...doc, animations: doc.animations.filter((binding) => binding.path !== path) }
  }

  const windows = animWindowSlotsIn(doc, null)
  const first = meta.frames[0].tiles
  const cells: number[] = []
  for (let i = 0; i < ownedMetaCells(meta); i++) {
    if (meta.holes[i]) {
      cells.push(0)
      continue
    }
    const k = moving.indexOf(i)
    if (k >= 0 && window) {
      cells.push(window.slot + k)
      continue
    }
    const entry = fit(first[i], doc.mode)
    const had = previous?.cells[i] ?? 0
    if (keepsArt(doc, had, entry, pair, windows)) {
      cells.push(had)
      continue
    }
    const found = findOrCreateTile(doc, entry, pair, { never0: true })
    if (!found) return `${file} needs more tiles than ${tiles.count >= MAX_TILES ? 'a full' : 'this'} tileset has room for.`
    doc = found.doc
    cells.push(found.index)
  }

  const binding: MetaBinding = {
    path,
    name,
    width: meta.width,
    height: meta.height,
    flags: meta.flags,
    frames: meta.frames.length,
    cells
  }
  const unchanged =
    previous !== undefined &&
    sameBinding(previous, binding) &&
    doc.tiles === tiles.tiles &&
    doc.count === tiles.count &&
    JSON.stringify(doc.animations) === JSON.stringify(tiles.animations)
  if (unchanged) return { doc: tiles, binding: previous }

  const at = doc.metas.findIndex((other) => other.path === path)
  const metas = at >= 0 ? doc.metas.map((other, i) => (i === at ? binding : other)) : [...doc.metas, binding]
  return { doc: { ...doc, metas }, binding }
}

/**
 * Detaches the meta at `path`. Its tiles stay as ordinary art — nothing is
 * lost, and nothing drawn with them changes — and its window stops playing.
 */
export function detachMeta(tiles: TilesDoc, path: string): TilesDoc {
  if (!tiles.metas.some((binding) => binding.path === path) && !tiles.animations.some((binding) => binding.path === path)) return tiles
  return {
    ...tiles,
    metas: tiles.metas.filter((binding) => binding.path !== path),
    animations: tiles.animations.filter((binding) => binding.path !== path)
  }
}

export interface RemovedMeta {
  doc: TilesDoc
  /** The renumbering to publish on the reorder seam, or null when no tile moved. */
  mapping: number[] | null
  /** Tiles dropped with it. */
  removed: number
  /** Why its tiles stayed, when they could not go (sc1 colour groups would not pack). */
  refused?: string
}

/**
 * Detaches the meta at `path` and drops the tiles it brought: its still cells
 * and its window. A tile something else still shows stays — `used` is what
 * the maps drawn with the tileset show, and `compactTileset` keeps blocks,
 * tile 0 and the cells of every other meta (which may share a tile with this
 * one) by itself. Everything else in the set keeps its art; the tiles above a
 * dropped one shift down, so `mapping` has to reach every file drawn with it.
 */
export function removeMeta(tiles: TilesDoc, path: string, used: Iterable<number>): RemovedMeta {
  const detached = detachMeta(tiles, path)
  if (detached === tiles) return { doc: tiles, mapping: null, removed: 0 }
  const own = new Set<number>()
  for (const binding of tiles.metas) if (binding.path === path) for (const tile of binding.cells) if (tile) own.add(tile)
  const window: number[] = []
  for (const binding of tiles.animations) {
    if (binding.path === path && binding.bank === null) for (let i = 0; i < animCells(binding); i++) window.push(binding.slot + i)
  }
  for (const tile of window) own.add(tile)
  if (isBanked(detached)) return removeBanked(detached, own, window, new Set(used))
  const keep = new Set(used)
  for (let i = 0; i < detached.count; i++) if (!own.has(i)) keep.add(i)
  const result = compactTileset(detached, keep)
  if (result.refused) return { doc: detached, mapping: null, removed: 0, refused: result.refused }
  if (result.doc === detached) return { doc: detached, mapping: null, removed: 0 }
  return { doc: result.doc, mapping: result.mapping, removed: result.removed }
}

/**
 * `removeMeta` on a banked tileset, where the common range never renumbers (a
 * bank's own art sits at fixed indices — see `removeTile`). A meta's still
 * tiles live in the shared region at the top instead, the same art in every
 * bank, and that region can close up: the survivors move up to 255 in their
 * order, so only shared indices change, and an index below the region means
 * what it meant. The window is freed only when it is the topmost thing in the
 * common range, by shrinking `count` — nothing moves for that.
 */
function removeBanked(doc: TilesDoc, own: ReadonlySet<number>, window: readonly number[], keep: Set<number>): RemovedMeta {
  for (const tile of metaCellSlots(doc)) keep.add(tile)
  for (const block of doc.blocks) for (const tile of block.tiles) keep.add(tile)
  const drops = (tile: number): boolean => own.has(tile) && !keep.has(tile)
  const mapping = Array.from({ length: MAX_TILES }, (_, i) => i)
  let removed = 0

  let count = doc.count
  const start = window[0]
  const highestBank = Math.max(0, ...doc.bankTiles.map((bank) => bank.length))
  if (window.length && start > 0 && start + window.length === count && start >= highestBank && window.every(drops)) {
    for (const tile of window) mapping[tile] = 0
    count = start
    removed += window.length
  }

  const survivors: number[] = []
  for (let i = MAX_TILES - doc.sharedTiles; i < MAX_TILES; i++) {
    if (!drops(i)) survivors.push(i)
    else {
      mapping[i] = 0
      removed++
    }
  }
  if (!removed) return { doc, mapping: null, removed: 0 }
  const tiles = doc.tiles.slice(0, count)
  const top = MAX_TILES - survivors.length
  survivors.forEach((old, j) => {
    tiles[top + j] = doc.tiles[old]
    mapping[old] = top + j
  })
  const next = normalizeTiles({
    ...doc,
    count,
    tiles,
    flags: doc.flags.slice(0, count),
    sharedTiles: survivors.length,
    blocks: doc.blocks.map((block) => ({ ...block, tiles: block.tiles.map((tile) => mapping[tile] ?? tile) })),
    animations: remapAnimBindings(doc.animations, mapping),
    metas: remapMetaBindings(doc.metas, mapping)
  })
  return { doc: next, mapping, removed }
}

/** A meta read for a refresh, or why it could not be. */
export type LoadedMeta = { meta: OwnedMetaDoc; name: string } | string

/**
 * Re-resolves every attached meta from its file, in attachment order — the
 * order is part of what makes two refreshes of the same files agree.
 *
 * `loaded` maps a binding's path to the meta read from disk. A binding missing
 * from it is left alone; a string is a problem worth reporting, and leaves the
 * binding as it was.
 */
export function refreshMetas(
  tiles: TilesDoc,
  loaded: ReadonlyMap<string, LoadedMeta>
): { doc: TilesDoc; problems: string[]; changed: string[] } {
  let doc = tiles
  const problems: string[] = []
  const changed: string[] = []
  for (const binding of tiles.metas) {
    const entry = loaded.get(binding.path)
    if (entry === undefined) continue
    if (typeof entry === 'string') {
      problems.push(entry)
      continue
    }
    const result = resolveMeta(doc, binding.path, entry.meta, entry.name)
    if (typeof result === 'string') {
      problems.push(result)
      continue
    }
    if (result.doc !== doc) changed.push(binding.path)
    doc = result.doc
  }
  return { doc, problems, changed }
}

// ── export: the meta's own header ────────────────────────────────────────────

/**
 * What a meta-tile's own header holds: its size and flags, and — when it
 * animates — its window's poses, which the `_Animate()` of every tileset it is
 * attached to copies from. Its tile numbers are not here: they belong to each
 * tileset it is attached to, and are in that tileset's `_MetaCells`.
 */
export function ownedMetaTables(doc: OwnedMetaDoc): EmitTable[] {
  const tables: EmitTable[] = [
    {
      suffix: '_Info',
      bytes: Uint8Array.from([doc.width, doc.height, doc.flags]),
      perLine: 3,
      comment: 'Width and height in tiles, then the eight gameplay flags'
    }
  ]
  const window = metaWindowAnim(doc)
  if (window) {
    tables.push(
      ...tileAnimTables(window).map((table) =>
        table.suffix === '_Patterns'
          ? { ...table, comment: `The ${window.width} tile(s) that change between poses, every pose end to end` }
          : table
      )
    )
  }
  return tables
}

export function ownedMetaConstants(doc: OwnedMetaDoc, name: string): string[] {
  const prefix = defineName(name)
  return [
    `#define ${prefix}_W ${doc.width}`,
    `#define ${prefix}_H ${doc.height}`,
    `#define ${prefix}_CELLS ${ownedMetaCells(doc)}`,
    `#define ${prefix}_FRAMES ${doc.frames.length}`,
    `#define ${prefix}_FLAGS 0x${doc.flags.toString(16).padStart(2, '0')}`,
    // The window a tileset gives it: what one pose change rewrites.
    `#define ${prefix}_MOVING ${movingCells(doc).length}`
  ]
}

export function ownedMetaNotes(doc: OwnedMetaDoc): string[] {
  const holes = doc.holes.filter(Boolean).length
  const moving = movingCells(doc).length
  return [
    `Mode: ${doc.mode}`,
    `Size: ${doc.width}×${doc.height} tiles${holes ? `, ${holes} see-through` : ''}`,
    doc.frames.length > 1
      ? `Poses: ${doc.frames.length}, held ${doc.frames.map((frame) => frame.duration).join('/')} VBlanks, ${doc.loop}; ${moving} tile(s) move`
      : 'Poses: 1 (still)',
    ...(doc.flags ? [`Flags: 0x${doc.flags.toString(16).padStart(2, '0')}`] : [])
  ]
}

// ── export: the tileset's meta table ────────────────────────────────────────

/** Bytes per meta in `_MetaInfo`: width, height, flags, then the offset into `_MetaCells`, low byte first. */
export const META_INFO_STRIDE = 5

/** `_MetaInfo` and `_MetaCells`: what a tileset's attached metas are, and the tiles each cell shows. */
export function tilesetMetaTables(doc: TilesDoc): EmitTable[] {
  if (!doc.metas.length) return []
  const info: number[] = []
  const cells: number[] = []
  for (const binding of doc.metas) {
    info.push(binding.width, binding.height, binding.flags, cells.length & 0xff, (cells.length >> 8) & 0xff)
    cells.push(...binding.cells)
  }
  return [
    {
      suffix: '_MetaInfo',
      bytes: Uint8Array.from(info),
      perLine: META_INFO_STRIDE,
      comment: `Attached meta-tiles: ${doc.metas.map((binding) => `${binding.name || binding.path} ${binding.width}×${binding.height}`).join(', ')} — w, h, flags, offset into _MetaCells (lo, hi)`
    },
    {
      suffix: '_MetaCells',
      bytes: Uint8Array.from(cells),
      perLine: Math.min(16, Math.max(...doc.metas.map((binding) => binding.width))),
      comment: 'Each meta’s tiles, row-major, end to end; 0 is a see-through cell'
    }
  ]
}

/** The meta's id in a tileset's constants: its file's own name. */
export function metaBaseName(path: string): string {
  return fileOf(path).replace(/\.meta-tiles\.json$/i, '')
}

export function tilesetMetaConstants(doc: TilesDoc, name: string): string[] {
  if (!doc.metas.length) return []
  const prefix = defineName(name)
  return [
    `#define ${prefix}_METAS ${doc.metas.length}`,
    ...doc.metas.map((binding, index) => `#define ${prefix}_META_${defineName(metaBaseName(binding.path))} ${index}`)
  ]
}

/**
 * The ready-made C that draws one attached meta into the name table.
 *
 * Written as runs, for the reason `metaHelperC` is: a see-through cell is a
 * write *skipped*, and a name table has no other way to show what is under it.
 * Through `VDP_WriteVRAM` at the layout address rather than
 * `VDP_WriteLayout_GM2` — that is what the latter does inside, and it exists
 * only with the GM2/GM3 modes compiled in, which a SCREEN 1 game has no reason
 * to.
 */
export function tilesetMetaHelperC(doc: TilesDoc, name: string): HelperC {
  if (!doc.metas.length) return { header: [], source: [] }
  const prefix = defineName(name)
  const signature = `void ${name}_DrawMeta(u8 meta, u8 x, u8 y)`
  return {
    header: [
      '',
      `// ── ${name}: attached meta-tiles ─────────────────────────────────────`,
      '//',
      `// Draws meta \`meta\` (one of the ${prefix}_META_* indices) with its top-left`,
      '// at tile column/row (x, y). See-through cells are not written, so what is',
      '// already on screen shows through them. A meta that animates needs no',
      `// redraw: ${doc.animations.length ? `${name}_Animate()` : 'the tileset\'s _Animate()'} changes its tiles' art in place.`,
      '//',
      `// ${name}_MetaInfo[meta * ${META_INFO_STRIDE}] holds its width, height and flags, for`,
      '// collision against an object rather than a tile.',
      '//',
      '// Example:',
      `//   ${name}_DrawMeta(${prefix}_META_${defineName(metaBaseName(doc.metas[0].path))}, 10, 5);`,
      `${signature};`
    ],
    source: [
      '',
      signature,
      '{',
      `\tif(meta >= ${prefix}_METAS) return;`,
      `\tconst u8* info = ${name}_MetaInfo + (u16)meta * ${META_INFO_STRIDE};`,
      '\tconst u8 w = info[0];',
      '\tconst u8 h = info[1];',
      `\tconst u8* src = ${name}_MetaCells + (info[3] | ((u16)info[4] << 8));`,
      '\tu16 dst = g_ScreenLayoutLow + ((u16)y << 5) + x;',
      '\tfor(u8 row = 0; row < h; ++row)',
      '\t{',
      '\t\tu8 col = 0;',
      '\t\twhile(col < w)',
      '\t\t{',
      '\t\t\tif(src[col] == 0) { ++col; continue; }',
      '\t\t\tu8 run = col;',
      '\t\t\twhile(run < w && src[run] != 0) ++run;',
      '\t\t\tVDP_WriteVRAM(src + col, dst + col, g_ScreenLayoutHigh, run - col);',
      '\t\t\tcol = run;',
      '\t\t}',
      '\t\tsrc += w;',
      '\t\tdst += 32;',
      '\t}',
      '}'
    ]
  }
}
