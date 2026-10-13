/**
 * Housekeeping for a tileset a screen was painted into, and putting a picture
 * onto one.
 *
 * Painting a tiled screen allocates as it goes (`paintGrid`), and nothing ever
 * gives a tile back: a stroke drawn over, undone or repainted leaves its old
 * tiles behind, and two strokes that happen to arrive at the same art leave two
 * copies. Three operations close that loop, all pure:
 *
 * - `compactTileset` — drop the tiles nothing uses and, optionally, fold
 *   duplicates together. It returns the old → new `mapping`, so the caller can
 *   publish it on the reorder seam (`shared/tile-editor.ts`) and every map,
 *   meta-tile and block drawn with the tileset follows — the same path a
 *   tile-editor delete already takes. Unbanked only: a bank's own art sits at
 *   fixed hardware indices the seam cannot renumber (see `removeTile`).
 * - `pictureCells` — cut a picture into the tiles it needs, one per cell.
 * - `placePicture` — find or create each of those tiles in the tileset and
 *   point the grid at it, all or nothing.
 *
 * "The same tile" means the same *pixels*, not the same bytes: a solid block
 * can be stored as ink with an all-ones pattern or as paper with an all-zero
 * one, and the hardware draws both alike. Comparing decoded pixels is what
 * lets a picture find art the tile editor drew by hand, and what lets two
 * strokes' worth of identical tiles collapse into one.
 */

import {
  bankTilePixels,
  blankTileEntry,
  isBanked,
  MAX_TILES,
  mergeColorByte,
  normalizeTiles,
  SC1_GROUP,
  TILE_SIZE,
  tileFromPixels,
  tilePixels,
  type TileEntry,
  type TilesDoc
} from './tile'
import { findOrCreateBankTile, findOrCreateTile, type PaintGrid } from './meta-paint'

const TILE_AREA = TILE_SIZE * TILE_SIZE

const pixelKey = (pixels: ArrayLike<number>): string => Array.prototype.join.call(pixels, ',')

export interface CompactResult {
  doc: TilesDoc
  /**
   * `mapping[oldIndex] = newIndex` over the whole hardware range, for
   * `remapTiles`/`remapMetaTiles`. A dropped tile maps to 0 — nothing that is
   * still in use is ever dropped, so nothing lands there by accident.
   */
  mapping: number[]
  /** Tiles dropped because nothing used them. */
  removed: number
  /** Tiles folded into an identical one earlier in the bank. */
  merged: number
  /** Set when nothing was done; `doc` comes back unchanged. */
  refused?: string
}

/**
 * Drops every common tile that is not in `used`, and with `merge` folds tiles
 * that draw the same pixels (and carry the same gameplay flags) into the first
 * of them. The survivors keep their order, so a tileset that only lost tiles
 * looks the same in the tile editor, minus the gaps.
 *
 * Always kept, whatever `used` says: a reserved tile 0 (the see-through every
 * meta-tile relies on), every tile a named block references (a block is a
 * design someone kept on purpose), and the shared meta-tile region at the top,
 * which this never renumbers. `used` is the caller's to assemble — every map
 * and meta-tile drawn with the tileset — because only a layer with file access
 * can see the ones that are not open.
 *
 * Flags take part in the duplicate test because two tiles that look alike can
 * still mean different things to the game (a wall and a painted wall); merging
 * them would silently change collision.
 *
 * SCREEN 1 keeps its colour per group of eight tiles, so closing a gap can move
 * a tile into a group with another colour pair. Survivors are therefore placed
 * the way `findOrCreateTile` appends: into the next slot whose group already
 * has their pair or has none yet, skipping to the next group boundary (and
 * leaving blank padding) otherwise. Every kept tile is checked afterwards to
 * draw exactly the pixels it drew before, so a compaction can never change
 * what a screen looks like.
 */
export function compactTileset(
  doc: TilesDoc,
  used: Iterable<number>,
  options: { merge?: boolean } = {}
): CompactResult {
  const identity = Array.from({ length: MAX_TILES }, (_, i) => i)
  const unchanged = (refused?: string): CompactResult => ({ doc, mapping: identity, removed: 0, merged: 0, refused })
  if (isBanked(doc)) {
    return unchanged(
      "A banked tileset's own art sits at fixed hardware indices, so it is rebuilt from the screen instead of compacted."
    )
  }

  const sharedStart = MAX_TILES - doc.sharedTiles
  const end = Math.min(doc.count, sharedStart)
  const keep = new Set<number>()
  for (const tile of used) if (tile >= 0 && tile < end) keep.add(tile)
  if (doc.reserveTile0) keep.add(0)
  for (const block of doc.blocks) for (const tile of block.tiles) if (tile < end) keep.add(tile)
  // A tileset needs at least one tile, and tile 0 is what a dropped reference falls back to.
  if (!keep.size) keep.add(0)

  // Old index → the earlier old index it is a duplicate of.
  const duplicateOf = new Map<number, number>()
  if (options.merge) {
    const seen = new Map<string, number>()
    for (let i = 0; i < end; i++) {
      if (!keep.has(i)) continue
      const key = `${pixelKey(tilePixels(doc, i))}|${doc.flags[i] ?? 0}`
      const first = seen.get(key)
      if (first === undefined) seen.set(key, i)
      else duplicateOf.set(i, first)
    }
  }

  const survivors: number[] = []
  for (let i = 0; i < end; i++) if (keep.has(i) && !duplicateOf.has(i)) survivors.push(i)
  const removed = end - keep.size
  const merged = duplicateOf.size
  if (!removed && !merged) return unchanged()

  const sc1 = doc.mode === 'sc1'
  const groupOf = (index: number): number => Math.floor(index / SC1_GROUP)
  const tiles: TileEntry[] = []
  const flags: number[] = []
  const groupColors: number[] = []
  const mapping = identity.slice()
  let cursor = 0
  for (const old of survivors) {
    if (sc1) {
      const pair = doc.groupColors[groupOf(old)] ?? 0xf1
      const assigned = groupColors[groupOf(cursor)]
      if (assigned !== undefined && assigned !== pair) cursor = (groupOf(cursor) + 1) * SC1_GROUP
      groupColors[groupOf(cursor)] = pair
    }
    if (cursor >= sharedStart) {
      return unchanged(
        'SCREEN 1 colours are shared by groups of eight tiles, and these tiles cannot be packed closer ' +
          'without moving one into a group with another colour pair.'
      )
    }
    // Padding left by a group skip: blank, belonging to no design.
    for (let i = tiles.length; i < cursor; i++) {
      tiles[i] = blankTileEntry(doc.mode)
      flags[i] = 0
    }
    const entry = doc.tiles[old] ?? blankTileEntry(doc.mode)
    tiles[cursor] = { pattern: entry.pattern.slice(), color: entry.color.slice() }
    flags[cursor] = doc.flags[old] ?? 0
    mapping[old] = cursor
    cursor++
  }
  const count = Math.max(1, cursor)
  for (let i = 0; i < end; i++) {
    if (duplicateOf.has(i)) mapping[i] = mapping[duplicateOf.get(i)!]
    else if (!keep.has(i)) mapping[i] = 0
  }
  // The shared region stays exactly where it is — a meta names it by index.
  for (let i = sharedStart; i < MAX_TILES; i++) if (doc.tiles[i]) tiles[i] = doc.tiles[i]
  // Groups the packing never reached keep a sensible default rather than a hole.
  for (let g = 0; g < Math.ceil(count / SC1_GROUP); g++) groupColors[g] ??= 0xf1

  const next = normalizeTiles({
    ...doc,
    count,
    tiles,
    flags,
    groupColors: sc1 ? groupColors : [],
    blocks: doc.blocks.map((block) => ({ ...block, tiles: block.tiles.map((tile) => mapping[tile] ?? 0) }))
  })

  // The contract, checked rather than trusted: every tile still in use draws
  // what it drew before, wherever it moved to.
  for (const old of keep) {
    if (pixelKey(tilePixels(next, mapping[old])) !== pixelKey(tilePixels(doc, old))) {
      return unchanged(`Compacting would change how tile ${old} looks, so nothing was removed.`)
    }
  }
  return { doc: next, mapping, removed, merged }
}

/** One cell of a picture, as the tile it needs. `pair` is the sc1 group colour; undefined elsewhere. */
export interface PictureCell {
  entry: TileEntry
  pair?: number
  /** The 64 pixels the tile has to draw — what `placePicture` matches existing art against. */
  pixels: Uint8Array
  /** True when the mode's colour rule had to drop a colour from this cell. */
  lossy: boolean
}

/**
 * One cell's 64 pixels as hardware bytes.
 *
 * An all-zero cell becomes the canonical blank, so it finds a reserved tile 0
 * rather than minting a near-duplicate of it. SCREEN 1 has one colour pair for
 * the whole tile (its group's), so the pair is the cell's two most common
 * colours and every other pixel goes to the nearer by count — the same rule
 * `tileFromPixels` applies per row in the other modes.
 */
export function cellEntry(pixels: Uint8Array, mode: TilesDoc['mode']): PictureCell {
  if (pixels.every((value) => value === 0)) return { entry: blankTileEntry(mode), pixels, lossy: false, ...(mode === 'sc1' ? { pair: 0 } : {}) }
  if (mode !== 'sc1') {
    const { pattern, color, lossyRows } = tileFromPixels(pixels)
    return { entry: { pattern, color }, pixels: decode(pattern, color), lossy: lossyRows.length > 0 }
  }
  const counts = new Map<number, number>()
  for (const value of pixels) counts.set(value & 0x0f, (counts.get(value & 0x0f) ?? 0) + 1)
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([value]) => value)
  const fg = ranked[0] ?? 0
  const bg = ranked[1] ?? (fg === 0 ? 1 : 0)
  const pattern: number[] = []
  for (let y = 0; y < TILE_SIZE; y++) {
    let bits = 0
    for (let x = 0; x < TILE_SIZE; x++) if ((pixels[y * TILE_SIZE + x] & 0x0f) !== bg) bits |= 0x80 >> x
    pattern.push(bits)
  }
  const pair = mergeColorByte(fg, bg)
  return { entry: { pattern, color: [] }, pair, pixels: decode(pattern, new Array(TILE_SIZE).fill(pair)), lossy: ranked.length > 2 }
}

function decode(pattern: number[], color: number[]): Uint8Array {
  const out = new Uint8Array(TILE_AREA)
  for (let y = 0; y < TILE_SIZE; y++) {
    const fg = (color[y] >> 4) & 0x0f
    const bg = color[y] & 0x0f
    for (let x = 0; x < TILE_SIZE; x++) out[y * TILE_SIZE + x] = pattern[y] & (0x80 >> x) ? fg : bg
  }
  return out
}

/** A picture in palette indices, one byte per dot, row-major. */
export interface Picture {
  width: number
  height: number
  indices: ArrayLike<number>
}

/** The cells a picture at the grid's origin covers, partly or wholly, clipped to the grid. */
export function pictureExtent(grid: { width: number; height: number }, picture: Picture): { cols: number; rows: number } {
  return {
    cols: Math.min(grid.width, Math.ceil(picture.width / TILE_SIZE)),
    rows: Math.min(grid.height, Math.ceil(picture.height / TILE_SIZE))
  }
}

/**
 * Lays `picture` over `base` (a rendering of the whole grid, `grid.width × 8`
 * dots wide) at the origin. A cell the picture only partly covers keeps the
 * base's dots in the part it does not, so an image that is not a multiple of
 * eight does not paint a black fringe.
 */
export function composePicture(base: Picture, picture: Picture): Uint8Array {
  const out = Uint8Array.from(base.indices as ArrayLike<number>)
  const width = Math.min(base.width, picture.width)
  const height = Math.min(base.height, picture.height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) out[y * base.width + x] = picture.indices[y * picture.width + x] ?? 0
  }
  return out
}

export interface PlacePictureResult {
  grid: PaintGrid
  tiles: TilesDoc
  /** Distinct tiles appended for the picture. */
  added: number
  /** Cells whose art matched a tile the tileset already had. */
  reused: number
  /** Cells the mode's colour rule made lossy. */
  lossy: number
  /** Set when the picture did not fit; `grid` and `tiles` come back unchanged. */
  refused?: string
}

/**
 * Points every cell in `cols × rows` at a tile drawing what `pixels` shows
 * there (`pixels` is the whole grid, `grid.width × 8` dots wide), finding the
 * tile in the tileset or appending it.
 *
 * All or nothing: a picture half-placed is a screen nobody asked for, so when
 * the tileset runs out the whole thing is refused, naming how far it got.
 *
 * `bankOf` is the same per-row rule `paintGrid` takes: on a banked tileset a
 * cell's tile is found and appended in the bank its row draws from, never in
 * the shared region every bank pays for.
 */
export function placePicture(
  grid: PaintGrid,
  tiles: TilesDoc,
  pixels: ArrayLike<number>,
  cols: number,
  rows: number,
  options: { bankOf?: (cellRow: number) => number } = {}
): PlacePictureResult {
  const banked = options.bankOf !== undefined && isBanked(tiles)
  const width = grid.width * TILE_SIZE
  let doc = tiles
  const data = grid.tiles.slice()
  let added = 0
  let reused = 0
  let lossy = 0

  // What each bank (or the one common set) already draws, by pixels — the
  // match `findOrCreateTile` would miss when the bytes differ.
  const known = new Map<string, number>()
  const index = (bank: number | null): void => {
    const sharedStart = MAX_TILES - doc.sharedTiles
    const own = bank === null ? [] : (doc.bankTiles[bank] ?? [])
    const limit = bank === null ? doc.count : MAX_TILES
    for (let i = limit - 1; i >= 0; i--) {
      if (bank !== null && !own[i] && i >= doc.count && i < sharedStart) continue
      const art = bank === null ? tilePixels(doc, i) : bankTilePixels(doc, bank, i)
      known.set(`${bank ?? '-'}|${pixelKey(art)}`, i)
    }
  }
  const indexed = new Set<number | null>()

  for (let cy = 0; cy < rows; cy++) {
    const bank = banked ? options.bankOf!(cy) : null
    if (!indexed.has(bank)) {
      index(bank)
      indexed.add(bank)
    }
    for (let cx = 0; cx < cols; cx++) {
      const cellPixels = new Uint8Array(TILE_AREA)
      for (let y = 0; y < TILE_SIZE; y++) {
        for (let x = 0; x < TILE_SIZE; x++) {
          cellPixels[y * TILE_SIZE + x] = (pixels[(cy * TILE_SIZE + y) * width + cx * TILE_SIZE + x] ?? 0) & 0x0f
        }
      }
      const cell = cellEntry(cellPixels, doc.mode)
      if (cell.lossy) lossy++
      const key = `${bank ?? '-'}|${pixelKey(cell.pixels)}`
      const match = known.get(key)
      if (match !== undefined) {
        data[cy * grid.width + cx] = match
        reused++
        continue
      }
      const found = bank === null ? findOrCreateTile(doc, cell.entry, cell.pair) : findOrCreateBankTile(doc, bank, cell.entry, cell.pair)
      if (!found) {
        const where = bank === null ? 'The tileset' : `Bank ${bank + 1}`
        return {
          grid,
          tiles,
          added: 0,
          reused: 0,
          lossy: 0,
          refused:
            `${where} ran out of room after ${added} new tile${added === 1 ? '' : 's'} — ` +
            `the picture needs more than the ${MAX_TILES} the hardware has.`
        }
      }
      if (found.doc !== doc) added++
      else reused++
      doc = found.doc
      known.set(key, found.index)
      data[cy * grid.width + cx] = found.index
    }
  }
  return { grid: { ...grid, tiles: data }, tiles: doc, added, reused, lossy }
}

