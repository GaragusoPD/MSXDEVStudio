/**
 * Painting a meta-tile in pixels, when a meta-tile owns no pixels.
 *
 * The meta editor shows a canvas; the document underneath holds tile indices.
 * This module is the bridge, and for a meta it works **copy-on-write**: a stroke
 * never edits a tile in place, it derives the tile the cell *would* now look
 * like and then finds or creates that tile in the bank. Two consequences make
 * the whole feature safe:
 *
 * - Nothing that already pointed at a tile can be changed by painting a meta. A
 *   map drawn with tile 12 keeps tile 12; the meta moves to tile 87.
 * - The bank is append-only, so no index ever shifts and no other document ever
 *   needs renumbering. The price is orphans — undo repoints the cell and leaves
 *   the tile behind — which is what the editor's explicit Compact command is
 *   for. It is never automatic: reachability across maps, blocks and metas that
 *   are not open is not knowable from here.
 *
 * The hardware constraint is not reimplemented. `paintPixel` in `tile.ts`
 * already decides whether a pixel fits a row's (or an sc1 group's) two colours,
 * and already reports the conflict when it does not. This module runs it
 * against a **scratch one-tile document** holding a copy of the cell's tile, so
 * the answer is the tile editor's answer, arrived at without touching the real
 * bank.
 *
 * Painting a *screen* wants the other half of the choice as well, so `paintGrid`
 * takes `write`. Under `'edit'` the derived art is written back over the tile the
 * cell already points at instead of being forked into a new one: nothing is
 * allocated, a full tileset cannot refuse the stroke, and every other cell
 * drawn with that tile changes too — which is what someone touching up a
 * converted screen means by painting. The reversal data that costs is
 * `PaintGridResult.tileEdits`. A meta never passes `write`, so nothing above
 * changes for it.
 */

import {
  addBitmapTile,
  MAX_BITMAP_TILES,
  setTileImage,
  tileImage,
  tilePixels as bitmapTilePixels,
  type BitmapTilesDoc
} from './bitmap-tile'
import { metaCells, setFrameTile, type MetaTileDoc } from './meta-tile'
import { BAYER4 } from './quantize'
import type { Point } from '../tile-editor'
import {
  bankCapacityLeft,
  bankTileAt,
  blankTileEntry,
  colorByteAt,
  isBanked,
  MAX_TILES,
  paintPixel,
  SC1_GROUP,
  TILE_SIZE,
  tilePixels,
  type TileEntry,
  type TilesDoc
} from './tile'

export interface PaintMetaResult {
  meta: MetaTileDoc
  tiles: TilesDoc
  /** Indices appended by this stroke — what Compact would reclaim if it is undone. */
  added: number[]
  /** Points the hardware colour limit refused. Reported, never fatal. */
  dropped: number
  /** Set when nothing could be done at all; `meta` and `tiles` come back unchanged. */
  refused?: string
}

/** `SC1_GROUP` is 8, so the group of tile `i` is `i >> 3`. */
const SC1_SHIFT = 3

const sameEntry = (a: TileEntry, b: TileEntry): boolean =>
  a.pattern.every((byte, i) => byte === b.pattern[i]) && a.color.every((byte, i) => byte === b.color[i])

/**
 * The index of a tile identical to `entry`, creating it if the bank has none.
 * `pair` is the sc1 group colour the tile must live under; ignored in the other
 * modes, where colour travels per row in `entry.color`.
 *
 * Null means the bank is full. 256 tiles is a hardware ceiling, not a policy.
 */
export function findOrCreateTile(
  doc: TilesDoc,
  entry: TileEntry,
  pair?: number
): { doc: TilesDoc; index: number } | null {
  const sc1 = doc.mode === 'sc1'
  // When a tileset is banked, shared tiles live at the top (255 down) and fall
  // outside `doc.count`, so the search must reach them. Unbanked tilesets have
  // no shared tiles, so the upper bound is moot there — `doc.count <= MAX_TILES`
  // always, and the extra iterations cost nothing.
  const searchLimit = isBanked(doc) ? MAX_TILES : doc.count
  for (let i = 0; i < searchLimit; i++) {
    const candidate = doc.tiles[i]
    if (!candidate || !sameEntry(candidate, entry)) continue
    // In sc1 the pattern is only half the picture: identical bits under
    // different pairs are different artwork.
    if (sc1 && doc.groupColors[i >> SC1_SHIFT] !== pair) continue
    return { doc, index: i }
  }

  // On a banked tileset a meta's tiles go at the top, mirrored into every bank
  // by the fallback in `bankTileAt`, so one index means one picture wherever it
  // is drawn — which is what lets `_DrawPlacements` stay bank-unaware.
  if (isBanked(doc)) {
    if (Math.min(...doc.bankTiles.map((_, b) => bankCapacityLeft(doc, b))) <= 0) return null
    const index = MAX_TILES - 1 - doc.sharedTiles
    const tiles = doc.tiles.slice()
    tiles[index] = { pattern: entry.pattern.slice(), color: entry.color.slice() }
    return { doc: { ...doc, tiles, sharedTiles: doc.sharedTiles + 1 }, index }
  }

  let index = doc.count
  const groupColors = doc.groupColors.slice()
  if (sc1) {
    // A tile can only be appended at `count`, so it lands in whichever group
    // `count` falls in. If that group already serves a different pair, skip to
    // the next boundary rather than recolour seven tiles that are not ours.
    const group = index >> SC1_SHIFT
    if (index % SC1_GROUP !== 0 && groupColors[group] !== pair) index = (group + 1) * SC1_GROUP
    if (index >= MAX_TILES) return null
    groupColors[index >> SC1_SHIFT] = pair ?? 0xf1
  }
  if (index >= MAX_TILES) return null

  const tiles = doc.tiles.slice()
  // Padding, when sc1 skipped a group boundary. Blank rather than a copy of
  // anything, because these slots belong to no design.
  for (let i = doc.count; i < index; i++) tiles[i] = blankTileEntry(doc.mode)
  tiles[index] = { pattern: entry.pattern.slice(), color: entry.color.slice() }

  const count = index + 1
  const flags = doc.flags.slice()
  for (let i = doc.count; i < count; i++) flags[i] = 0
  return { doc: { ...doc, count, tiles, groupColors, flags }, index }
}

/**
 * The index of a tile identical to `entry` **in `bank`'s view**, appending to
 * that bank's own overrides when it has none.
 *
 * The sibling of `findOrCreateTile` for painting a screen. That one allocates
 * into the shared region, which every bank sees — right for a meta-tile, whose
 * index must mean one picture wherever it is drawn. A screen cell is read in
 * its row's bank only, so paying a slot in all three banks for it wastes the
 * scarcest resource the tileset has.
 *
 * Null means the bank has no room below the shared region.
 */
export function findOrCreateBankTile(
  doc: TilesDoc,
  bank: number,
  entry: TileEntry,
  pair?: number
): { doc: TilesDoc; index: number } | null {
  const sc1 = doc.mode === 'sc1'
  const sharedStart = MAX_TILES - doc.sharedTiles
  const own = doc.bankTiles[bank] ?? []
  for (let i = 0; i < MAX_TILES; i++) {
    // Only a slot something actually fills is a real match — `bankTileAt`
    // answers `blankTileEntry` for every slot past the bank, the common range
    // and the shared region, and a blank probe would match all of them.
    if (!own[i] && i >= doc.count && i < sharedStart) continue
    if (!sameEntry(bankTileAt(doc, bank, i), entry)) continue
    if (sc1 && doc.groupColors[i >> SC1_SHIFT] !== pair) continue
    return { doc, index: i }
  }

  // Never below `count`: a bank override at a common index shadows that common
  // tile for every cell in this bank's rows — including a reserved tile 0.
  const index = Math.max(own.length, doc.count)
  if (index >= sharedStart) return null

  const grown = own.slice()
  // Slots the bank did not have are seeded from what it already showed, so
  // nothing the user is not looking at changes appearance.
  for (let i = grown.length; i < index; i++) grown[i] = bankTileAt(doc, bank, i)
  grown[index] = { pattern: entry.pattern.slice(), color: entry.color.slice() }
  const bankTiles = doc.bankTiles.slice()
  bankTiles[bank] = grown
  return { doc: { ...doc, bankTiles }, index }
}

/**
 * The scratch tile's bytes, with a fully-erased cell collapsed to the canonical
 * blank.
 *
 * An erased cell is every pixel at colour 0, but `paintPixel` has no reason to
 * express that as `blankTileEntry` does — it leaves whatever FG/BG pair the row
 * was carrying, so an erased cell comes out as (say) pattern `0x00` with colour
 * `0x01` rather than pattern `0x00` with colour `0x00`. Those look identical on
 * screen and different to the dedup, so without this the eraser mints a fresh
 * near-duplicate tile every time instead of pointing back at the reserved one.
 */
function canonical(work: TilesDoc): TileEntry {
  const pixels = tilePixels(work, 0)
  if (pixels.every((value) => value === 0)) return blankTileEntry(work.mode)
  return work.tiles[0]
}

/** A one-tile document holding a copy of `tile` as `bank` sees it, for `paintPixel` to work on. */
function scratch(doc: TilesDoc, tile: number, bank: number | null): TilesDoc {
  const entry = bank === null ? (doc.tiles[tile] ?? blankTileEntry(doc.mode)) : bankTileAt(doc, bank, tile)
  return {
    ...doc,
    count: 1,
    tiles: [{ pattern: entry.pattern.slice(), color: entry.color.slice() }],
    groupColors: doc.mode === 'sc1' ? [colorByteAt(doc, tile, 0)] : [],
    flags: [0],
    blocks: [],
    export: null
  }
}

/** A grid of tile references — a meta's frame, or a map layer's `data`. Sizes are in CELLS. */
export interface PaintGrid {
  width: number
  height: number
  tiles: number[]
}

/**
 * One tile's art as it was before an `edit` stroke overwrote it, and as the
 * stroke left it.
 *
 * `after` is what makes the record checkable rather than merely reversible: an
 * undo that finds art it did not write is looking at a tile something else has
 * since changed, and putting `before` back there would destroy that other edit.
 */
export interface TileEdit {
  index: number
  /** Which table it lives in: a bank's overrides, or null for the common set. */
  bank: number | null
  before: TileEntry
  /** The art this stroke left in the slot — its *final* art, when a stroke crossed several cells of one tile. */
  after: TileEntry
  /** sc1 only: the group colour byte the stroke found, which is half the picture there. */
  beforeGroup?: number
  /**
   * sc1 only: the group colour byte the stroke left. `after`'s other half — the
   * pair lives outside `TileEntry`, so a guard comparing art alone cannot see
   * that another editor has since recoloured the group, and would undo over it.
   */
  afterGroup?: number
}

export interface PaintGridResult {
  grid: PaintGrid
  tiles: TilesDoc
  /** Indices appended by this stroke — what Compact would reclaim if it is undone. */
  added: number[]
  /** Points the hardware colour limit refused. Reported, never fatal. */
  dropped: number
  /** Set when nothing could be done at all; `grid` and `tiles` come back unchanged. */
  refused?: string
  /** The bank a full-bank refusal happened against, `null` for an unbanked (or shared-region) refusal. */
  refusedBank?: number | null
  /** Tiles this stroke rewrote in place, one per slot touched. Always present; empty under `fork`. */
  tileEdits: TileEdit[]
}

export interface PaintOptions {
  /**
   * Which bank a cell row is drawn in — the **cell** row
   * (`Math.floor(point.y / TILE_SIZE)`), not the pixel row. Omitted for a meta,
   * whose tiles must mean one picture in every bank.
   */
  bankOf?: (cellRow: number) => number
  /**
   * What a stroke does to the cell it lands on. `fork` (the default) derives the
   * new art and repoints the cell at a found-or-created tile, leaving every
   * other user of the old one alone. `edit` rewrites the tile the cell already
   * points at, which allocates nothing, never runs out of bank — and changes
   * that tile for every cell in every map that references it.
   *
   * A meta-tile must never pass `edit`: its whole safety argument is that
   * painting one cannot disturb art it does not own.
   */
  write?: 'fork' | 'edit'
}

/**
 * Applies a stroke to a grid of tile references, resolving each touched cell
 * into `tiles` — copy-on-write by default, in place under `options.write ===
 * 'edit'`.
 *
 * `points` are in the grid's own **pixel** space — `(0,0)` is its top-left dot.
 * `grid.width`/`height` are in **cells**. Points outside are ignored, so a drag
 * that leaves the canvas needs no clamping by the caller.
 *
 * `role` is which half of the row's colour pair the stroke owns — the mouse
 * button, as in the tile editor. Without one, the second colour a row is asked
 * for is dropped, which reads as an editor that stopped working.
 */
export function paintGrid(
  grid: PaintGrid,
  tiles: TilesDoc,
  points: readonly Point[],
  color: number,
  role?: 'fg' | 'bg',
  options: PaintOptions = {}
): PaintGridResult {
  const byCell = new Map<number, Point[]>()
  for (const point of points) {
    const cx = Math.floor(point.x / TILE_SIZE)
    const cy = Math.floor(point.y / TILE_SIZE)
    if (point.x < 0 || point.y < 0 || cx >= grid.width || cy >= grid.height) continue
    const key = cy * grid.width + cx
    const list = byCell.get(key)
    if (list) list.push(point)
    else byCell.set(key, [point])
  }
  if (!byCell.size) return { grid, tiles, added: [], dropped: 0, tileEdits: [] }

  let nextTiles = tiles
  let nextCells: number[] | null = null
  const added: number[] = []
  const tileEdits: TileEdit[] = []
  let dropped = 0

  for (const key of byCell.keys()) {
    const cellPoints = byCell.get(key)!
    const currentTile = (nextCells ?? grid.tiles)[key] ?? 0
    const cy = Math.floor(key / grid.width)
    const bank = options.bankOf && isBanked(nextTiles) ? options.bankOf(cy) : null
    let work = scratch(nextTiles, currentTile, bank)
    for (const point of cellPoints) {
      const result = paintPixel(work, 0, point.x % TILE_SIZE, point.y % TILE_SIZE, color, role)
      // Only reachable without a role. With one, `paintPixel` recolours that
      // role for the row and can never refuse — which is what makes "change
      // colour and keep drawing" work at all under a two-colours-per-row rule.
      if (!result.ok) {
        dropped++
        continue
      }
      work = result.doc
    }

    const pair = nextTiles.mode === 'sc1' ? work.groupColors[0] : undefined
    const entry = canonical(work)

    // Reserved tile 0 is locked blank and `normalizeTiles` re-blanks it on load,
    // so an in-place write there vanishes on the next open — and until then
    // shows in every transparent cell of every map. Fork instead.
    const editable = options.write === 'edit' && !(currentTile === 0 && nextTiles.reserveTile0)
    if (editable) {
      // An edit has to land where this row's bank actually READS. When the bank
      // overrides the index, `tiles[index]` is art the bank never shows, so
      // writing there would leave the stroke invisible exactly where it was
      // drawn.
      const inBank = bank !== null && !!nextTiles.bankTiles[bank]?.[currentTile]
      const before = inBank ? nextTiles.bankTiles[bank!][currentTile] : nextTiles.tiles[currentTile]
      // A cell pointing at a slot nothing fills has no art to rewrite; forking
      // is the only honest thing left.
      if (before) {
        const sc1 = nextTiles.mode === 'sc1'
        const groupNow = sc1 ? nextTiles.groupColors[currentTile >> SC1_SHIFT] : undefined
        const groupAfter = sc1 ? work.groupColors[0] : undefined
        // An idle repaint — the same colour over pixels that already hold it,
        // or a stroke every point of which was dropped — hands back the SAME
        // document, as the fork path below does. Otherwise a stroke that
        // changed nothing still pushes an undo entry that visibly does nothing.
        // Asked of the running document, because "changed nothing" means
        // nothing beyond what this stroke has already written.
        if (sameEntry(before, entry) && groupNow === groupAfter) continue

        const at = inBank ? bank : null
        const already = tileEdits.find((edit) => edit.index === currentTile && edit.bank === at)
        // A stroke crossing two cells of the same tile writes it twice. The
        // `before` half is the art the stroke found and must survive; the
        // `after` half moves on to whatever the slot holds now — the group
        // byte included, since it is the other half of the same picture.
        if (already) {
          already.after = entry
          if (sc1) already.afterGroup = groupAfter
        } else {
          tileEdits.push({
            index: currentTile,
            bank: at,
            before,
            after: entry,
            // `beforeGroup` comes off the doc the stroke *found*, not the
            // running one: eight tiles share one sc1 group byte, so two cells
            // in one group would otherwise record the first cell's new pair as
            // the second's "before", and only an undo replayed back-to-front
            // would land on the right colour.
            ...(sc1 ? { beforeGroup: tiles.groupColors[currentTile >> SC1_SHIFT], afterGroup: groupAfter } : {})
          })
        }

        if (inBank) {
          const banked = nextTiles.bankTiles[bank!].slice()
          banked[currentTile] = entry
          const bankTiles = nextTiles.bankTiles.slice()
          bankTiles[bank!] = banked
          nextTiles = { ...nextTiles, bankTiles }
        } else {
          const written = nextTiles.tiles.slice()
          written[currentTile] = entry
          // sc1 holds colour per group of eight tiles, not in the entry — a role
          // stroke's recoloured pair is lost without this.
          const groupColors = sc1 ? nextTiles.groupColors.slice() : nextTiles.groupColors
          if (sc1) groupColors[currentTile >> SC1_SHIFT] = work.groupColors[0]
          nextTiles = { ...nextTiles, tiles: written, groupColors }
        }
        continue // an edit changes pixels, never references
      }
    }

    const found =
      bank === null
        ? findOrCreateTile(nextTiles, entry, pair)
        : findOrCreateBankTile(nextTiles, bank, entry, pair)
    if (!found) {
      // A half-drawn stroke against a full bank is worse than no change at all.
      return {
        grid,
        tiles,
        added: [],
        dropped: 0,
        tileEdits: [],
        refusedBank: bank,
        refused:
          bank === null
            ? `The tileset is full — ${MAX_TILES} tiles is the hardware limit. ` +
              'Run "Compact unused tiles", or free a tile in the tile editor.'
            : `Bank ${bank} is full — ${MAX_TILES} tiles is the hardware limit for one bank. ` +
              'Free a tile, or paint on a row served by another bank.'
      }
    }
    // Track newly created tiles for the Compact command. An unbanked allocation
    // appends at `count`, so an index beyond the old count is new. A banked
    // allocation into the shared region takes from the top (count stays put),
    // so a new shared allocation is detected by `sharedTiles` growing instead.
    // A bank-local allocation grows neither — it is detected by the bank's own
    // override array growing.
    const grew =
      bank === null
        ? found.index >= nextTiles.count || found.doc.sharedTiles > nextTiles.sharedTiles
        : (found.doc.bankTiles[bank]?.length ?? 0) > (nextTiles.bankTiles[bank]?.length ?? 0)
    if (grew) added.push(found.index)
    nextTiles = found.doc
    // Only clone once a cell actually moves. A stroke that resolves to the tile
    // already there must return the SAME array, or every caller's
    // reference-equal no-op check (and its undo stack) stops working.
    if (found.index !== currentTile) {
      if (!nextCells) nextCells = grid.tiles.slice()
      nextCells[key] = found.index
    }
  }

  return {
    grid: nextCells ? { ...grid, tiles: nextCells } : grid,
    tiles: nextTiles,
    added,
    dropped,
    tileEdits
  }
}

/**
 * Applies a stroke to one frame of a meta.
 *
 * Points are in the meta's own pixel space — `(0,0)` is the meta's top-left
 * dot, not the tile's. Points outside it are ignored, so a drag that leaves the
 * canvas needs no clamping by the caller.
 *
 * `role` is which half of the row's colour pair the stroke owns — the mouse
 * button, as in the tile editor. It matters because sc2/sc4 hold two colours
 * per 8×1 row and sc1 two per group of eight tiles: without a role, the second
 * colour a row is asked for has nowhere to go and is dropped, which reads as an
 * editor that stopped working. With one, the row's foreground (or background)
 * is *recoloured*, which is how MSX art is actually drawn.
 */
export function paintMeta(
  meta: MetaTileDoc,
  tiles: TilesDoc,
  frame: number,
  points: readonly Point[],
  color: number,
  role?: 'fg' | 'bg'
): PaintMetaResult {
  const frameTiles = meta.frames[frame]
  if (!frameTiles) return { meta, tiles, added: [], dropped: 0 }

  const result = paintGrid(
    { width: meta.width, height: meta.height, tiles: frameTiles.tiles },
    tiles,
    points,
    color,
    role
  )
  if (result.refused) return { meta, tiles, added: [], dropped: 0, refused: result.refused }
  // Nothing moved: hand back the same meta so `pushHistory` no-ops, exactly as
  // `setFrameTile` used to make it. `dropped` still travels — an all-dropped
  // stroke reported its count before and must keep doing so.
  if (result.grid.tiles === frameTiles.tiles)
    return { meta, tiles: result.tiles, added: result.added, dropped: result.dropped }

  const frames = meta.frames.slice()
  frames[frame] = { tiles: result.grid.tiles }
  return { meta: { ...meta, frames }, tiles: result.tiles, added: result.added, dropped: result.dropped }
}

/**
 * The pixels one spray dab covers: a disc, thinned by an ordered Bayer
 * threshold.
 *
 * Ordered rather than random, for two reasons. The same drag twice gives the
 * same art, which is what makes it testable. And the threshold is keyed to
 * *absolute* coordinates, so overlapping dabs agree about every pixel they
 * share — a slow drag builds one coherent dither field instead of the mottle
 * random spray produces.
 *
 * `density` runs 0–16, matching the Bayer matrix's own range.
 */
export function sprayPoints(center: Point, radius: number, density: number): Point[] {
  const points: Point[] = []
  const r = Math.max(0, radius | 0)
  for (let y = center.y - r; y <= center.y + r; y++) {
    for (let x = center.x - r; x <= center.x + r; x++) {
      if (x < 0 || y < 0) continue
      const dx = x - center.x
      const dy = y - center.y
      if (dx * dx + dy * dy > r * r) continue
      if (BAYER4[y & 3][x & 3] >= density) continue
      points.push({ x, y })
    }
  }
  return points
}

/** Every tile index this meta references, across every frame. */
export function usedTiles(doc: MetaTileDoc): Set<number> {
  const used = new Set<number>()
  for (const frame of doc.frames) for (const tile of frame.tiles) used.add(tile)
  return used
}

export { metaCells }

// ── the bitmap counterpart ──────────────────────────────────────────────────

/**
 * The same copy-on-write bridge, over a **bitmap** tileset.
 *
 * Simpler than the pattern path in one way and harder in another. Simpler:
 * every pixel carries its own colour, so nothing can be refused — `dropped` is
 * always 0 and there is no scratch document, because there is no constraint to
 * ask about. Harder: a bitmap tile is any size, so the cell grid is the
 * tileset's `width × height` rather than a fixed 8, and a tile is compared by
 * its whole pixel block rather than by sixteen bytes.
 */
export function paintBitmapMeta(
  meta: MetaTileDoc,
  tiles: BitmapTilesDoc,
  frame: number,
  points: readonly Point[],
  color: number
): {
  meta: MetaTileDoc
  tiles: BitmapTilesDoc
  added: number[]
  dropped: number
  refused?: string
} {
  if (!meta.frames[frame]) return { meta, tiles, added: [], dropped: 0 }
  const { width: cw, height: ch } = tiles

  const byCell = new Map<number, Point[]>()
  for (const point of points) {
    const cx = Math.floor(point.x / cw)
    const cy = Math.floor(point.y / ch)
    if (point.x < 0 || point.y < 0 || cx >= meta.width || cy >= meta.height) continue
    const key = cy * meta.width + cx
    const list = byCell.get(key)
    if (list) list.push(point)
    else byCell.set(key, [point])
  }
  if (!byCell.size) return { meta, tiles, added: [], dropped: 0 }

  let nextMeta = meta
  let nextTiles = tiles
  const added: number[] = []

  for (const [key, cellPoints] of byCell) {
    const cx = key % meta.width
    const cy = Math.floor(key / meta.width)
    const image = Uint8Array.from(tileImage(nextTiles, nextMeta.frames[frame].tiles[key] ?? 0))
    for (const point of cellPoints) image[(point.y % ch) * cw + (point.x % cw)] = color & 0xff

    const found = findOrCreateBitmapTile(nextTiles, image)
    if (!found) {
      return {
        meta,
        tiles,
        added: [],
        dropped: 0,
        refused:
          `The tileset is full — ${MAX_BITMAP_TILES} tiles is the ceiling, because a cell index ` +
          'is one byte. Run "Compact unused tiles", or free a tile in the tileset editor.'
      }
    }
    if (found.index >= nextTiles.count) added.push(found.index)
    nextTiles = found.doc
    nextMeta = setFrameTile(nextMeta, frame, cx, cy, found.index)
  }

  return { meta: nextMeta, tiles: nextTiles, added, dropped: 0 }
}

/**
 * The bitmap `findOrCreateTile`: an exact pixel-block match, or a new tile.
 *
 * Null when the bank is full. As in the pattern path this only ever appends, so
 * no existing index shifts and painting a meta cannot disturb a map.
 */
export function findOrCreateBitmapTile(
  doc: BitmapTilesDoc,
  image: Uint8Array
): { doc: BitmapTilesDoc; index: number } | null {
  const per = doc.width * doc.height
  const bank = bitmapTilePixels(doc)
  for (let i = 0; i < doc.count; i++) {
    let same = true
    for (let p = 0; p < per && same; p++) same = bank[i * per + p] === image[p]
    if (same) return { doc, index: i }
  }
  if (doc.count >= MAX_BITMAP_TILES) return null
  const grown = addBitmapTile(doc)
  return { doc: setTileImage(grown, grown.count - 1, image), index: grown.count - 1 }
}

/** Every tile index a bitmap meta references — `usedTiles`, which is mode-agnostic. */
export { usedTiles as usedBitmapTiles }
