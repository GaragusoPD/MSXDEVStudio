/**
 * `*.tiles.json` (Spec 08): the pattern-mode tileset model, stored as the
 * hardware bytes so export is a memcpy, plus the constraint logic that makes
 * illegal tiles impossible.
 *
 * Hardware recap:
 * - **sc2 / sc4** — 8 pattern bytes per tile (bit set = foreground) and 8
 *   color bytes, one per 8×1 row, packed `FG<<4 | BG`.
 * - **sc1** — same 8 pattern bytes, but one color byte per *group of 8 tiles*
 *   (32 bytes for a 256-tile bank). Every pixel of all 8 tiles in the group
 *   shares that FG/BG pair.
 */

import type { HelperC } from './emitC'
import { MSX1_PALETTE_GRB } from './palette'
import { isTileMode, type TileMode } from './modes'
import type { ExportBlock } from './resource'

export const TILE_SIZE = 8
export const MAX_TILES = 256
/** sc1 shares one color byte across this many consecutive tiles. */
export const SC1_GROUP = 8

export interface TileEntry {
  /** 8 bytes, one per row, MSB = leftmost pixel. */
  pattern: number[]
  /** 8 bytes `FG<<4 | BG`, one per row. Empty in sc1 (see `groupColors`). */
  color: number[]
}

export interface TilesDoc {
  version: 1
  mode: TileMode
  /**
   * Reserves tile 0 as "nothing": locked all-blank, drawn as a checkerboard,
   * and skipped when a meta-tile is stamped over it. That last part is the
   * point — a name table has no holes, so the only way to see through a cell
   * is not to write it, and a meta-tile needs exactly that to be transparent.
   *
   * False in every file written before meta-tiles became objects, because tile
   * 0 is real art in real projects: `demo_msx1`'s tileset holds a solid block
   * there and its background map draws it 274 times. True for newly created
   * tilesets. Turning it on for an existing one is a migration — every index
   * shifts by one — not a toggle.
   */
  reserveTile0: boolean
  /** MSX1 modes: null (fixed TMS9918A palette). sc4: 16 packed GRB333 entries. */
  palette: number[] | null
  count: number
  tiles: TileEntry[]
  /** sc1 only: `ceil(count / 8)` bytes, one FG/BG pair per group of 8 tiles. */
  groupColors: number[]
  /**
   * Eight gameplay bits per tile, one byte each, in the manner of PICO-8's
   * sprite flags: what a tile *means* to the game rather than how it looks.
   * Meaning is entirely the game's to decide (bit 0 solid, bit 1 collectable,
   * and so on). Exported as a table indexed by tile id, so collision is a
   * lookup rather than a chain of comparisons.
   */
  flags: number[]
  /** Named multi-tile designs over the tiles above. Empty in files that predate them. */
  blocks: TileBlock[]
  export: ExportBlock | null
  /**
   * Per-bank overrides for SCREEN 2/4's three pattern banks, `[bank0, bank1,
   * bank2]`. `bankTiles[b][i]`, when present, is the art bank `b` shows at
   * hardware index `i` instead of `tiles[i]`.
   *
   * Empty in every file that predates banking and in every tileset that does
   * not need it — which is most of them: a game that draws the same tile at any
   * screen height wants one bank replicated, which is what falling back to
   * `tiles` gives it, and what `VDP_LoadPattern_GM2` already does.
   */
  bankTiles: TileEntry[][]

  /**
   * How many indices, counting down from 255, are reserved for meta-tiles —
   * shared, so a meta's index means the same art in every bank. Stored rather
   * than derived: an all-blank tile is legitimate art, so "the trailing shared
   * entries" cannot be read off the data.
   */
  sharedTiles: number
}

/**
 * A design bigger than one tile — a door, a tree, a boss face — authored on
 * one canvas instead of as N separate 8×8 cells the user has to assemble in
 * their head.
 *
 * A block owns no pixels: it is `width × height` *references* into `tiles`,
 * so painting a block paints the tiles it points at, and the same tile may
 * appear in several blocks (or in none). Structurally this is `map-editor`'s
 * `Stamp` plus a name, deliberately — a block can be handed to `applyStamp`
 * as-is.
 */
export interface TileBlock {
  name: string
  /** In tiles, not pixels. */
  width: number
  height: number
  /** `width * height` tile indices, row-major. */
  tiles: number[]
}

/** How many gameplay bits a tile carries. Eight, so one byte per tile. */
export const TILE_FLAG_COUNT = 8

/** Tiles per axis in a block. 8 × 8 tiles = 64 × 64 px, past any practical design. */
/**
 * Widest and tallest a block may be, per axis. There is no hardware unit here —
 * a block is just references into the bank — so the limit is what the generated
 * C can express: `_DrawBlock` takes the width and height as `u8`. The table
 * offset is a `u16`, so many large blocks are fine; it is the axes that cap.
 *
 * Anything past 32x24 cannot be stamped onto the screen in one call, but the
 * data is still valid, so that is left to judgement rather than enforced.
 */
export const MAX_BLOCK = 255

const zeros = (n: number): number[] => new Array<number>(n).fill(0)

/**
 * What tile 0 holds under `reserveTile0` — pattern and colour both zero, not
 * the `0xf1` white-on-black every other blank tile gets. Colour 0 is the MSX's
 * transparent palette entry, so this renders through the checkerboard path
 * `TileCanvas.vue` already has for index 0, with no new drawing code.
 */
export function blankTileEntry(mode: TileMode): TileEntry {
  return { pattern: zeros(TILE_SIZE), color: mode === 'sc1' ? [] : zeros(TILE_SIZE) }
}

/** SCREEN 2/4's pattern table is three banks of 256; SCREEN 1's is one. */
export const BANK_COUNT = 3

/** True once any bank carries art of its own. Never true in sc1. */
export function isBanked(doc: TilesDoc): boolean {
  return doc.bankTiles.some((bank) => bank.length > 0)
}

/**
 * The art a name-table byte means, for a cell in the given bank.
 *
 * The one place the override rule lives, so the editors, the map renderer and
 * the exporter cannot disagree about what a screen actually shows.
 */
export function bankTileAt(doc: TilesDoc, bank: number, index: number): TileEntry {
  return doc.bankTiles[bank]?.[index] ?? doc.tiles[index] ?? blankTileEntry(doc.mode)
}

/**
 * How many more tiles this bank can take before its own art would collide with
 * the shared reservation at the top. The shared tiles cost every bank, which is
 * the price of a meta index meaning one picture everywhere.
 */
export function bankCapacityLeft(doc: TilesDoc, bank: number): number {
  return MAX_TILES - (doc.bankTiles[bank]?.length ?? 0) - doc.sharedTiles
}

/**
 * `reserveTile0` defaults to **false** here, matching `normalizeTiles`, so the
 * factory and the normalizer never disagree about a document neither was told
 * anything about. Reserving is a decision the *new-tileset command* makes and
 * passes in — not something a low-level factory does to every caller, most of
 * which are tests building a bank to assert on.
 */
export function createTilesDoc(mode: TileMode = 'sc2', count = 256, reserveTile0 = false): TilesDoc {
  return normalizeTiles({ mode, count, reserveTile0 })
}

function byte(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? ((value | 0) & 0xff) : 0
}

/** Fills in everything a hand-edited or older file is missing; never throws. */
export function normalizeTiles(raw: unknown): TilesDoc {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<TilesDoc>
  const mode: TileMode = isTileMode(String(input.mode)) ? (input.mode as TileMode) : 'sc2'
  const rawTiles = Array.isArray(input.tiles) ? input.tiles : []
  // `count` is how many tiles the bank *holds*, not how many it could — every
  // append lands at `count` and is refused past `MAX_TILES`. So a document with
  // neither a count nor any tiles is an empty bank (1 tile), not a full one:
  // defaulting to MAX_TILES here made every tileset created from `{"mode":…}`
  // — which is exactly what the Resources panel writes — born at the ceiling,
  // so the first stroke against it was refused as "the tileset is full".
  const count = Math.max(1, Math.min(MAX_TILES, Number(input.count) || rawTiles.length || 1))
  const perRowColor = mode !== 'sc1'
  // sc1's pattern table is one bank of 256 — there is nowhere for a shared,
  // grow-from-255 reservation to live, so the field is clamped the same way
  // `rawBanks` below clamps `bankTiles`. Without this, a doc converted from a
  // banked sc2/sc4 to sc1 would carry a stale nonzero `sharedTiles` forward
  // with no bank data left to justify it.
  const sharedTiles = mode === 'sc1' ? 0 : Math.max(0, Math.min(MAX_TILES, Number(input.sharedTiles) || 0))
  const sharedStart = MAX_TILES - sharedTiles

  const decodeEntry = (i: number): TileEntry => {
    const entry = (rawTiles[i] ?? {}) as Partial<TileEntry>
    const pattern = zeros(TILE_SIZE)
    const color = perRowColor ? zeros(TILE_SIZE) : []
    for (let y = 0; y < TILE_SIZE; y++) {
      pattern[y] = byte(entry.pattern?.[y])
      // A blank tile with color 0x00 would be invisible-on-invisible; white-on-black
      // is the useful default and matches what the editor shows for a fresh bank.
      if (perRowColor) color[y] = entry.color?.[y] === undefined ? 0xf1 : byte(entry.color[y])
    }
    return { pattern, color }
  }

  const tiles: TileEntry[] = []
  for (let i = 0; i < count; i++) tiles.push(decodeEntry(i))
  // Meta-tiles allocate shared slots at MAX_TILES - sharedTiles .. MAX_TILES - 1,
  // far above `count` (see `TilesDoc.sharedTiles`) — `findOrCreateTile` writes
  // them straight into `doc.tiles` without going through this function. Every
  // *other* caller (a file load, the export mirror-refresh, a mode conversion,
  // `removeTile`'s own re-normalize) does funnel back through here, so without
  // this second pass the loop above — bounded to `count` — would silently drop
  // the entire shared region on every one of them. That is the corruption
  // three rounds of `removeTile` fixes kept rediscovering one caller at a time:
  // the producer never knew the shared region existed. Rebuilt at each tile's
  // own hardware index, so a meta's reference never renumbers. When `count`
  // already reaches into this range (an accounting-only fixture, not a state
  // any editor produces) the two passes just decode the same bytes twice.
  for (let i = sharedStart; i < MAX_TILES; i++) tiles[i] = decodeEntry(i)

  // Enforced here rather than at the call sites, so a hand-edited file cannot
  // present artwork in tile 0 while also claiming the flag. Ordered after the
  // shared-region rebuild above so it always wins: a degenerate `sharedTiles
  // === MAX_TILES` doc has `sharedStart === 0`, and rebuilding tile 0 as a
  // shared entry must not un-blank it.
  const reserveTile0 = input.reserveTile0 === true
  if (reserveTile0 && tiles[0]) tiles[0] = blankTileEntry(mode)

  const groupCount = Math.ceil(count / SC1_GROUP)
  const groupColors = mode === 'sc1' ? zeros(groupCount) : []
  if (mode === 'sc1') {
    for (let g = 0; g < groupCount; g++) {
      groupColors[g] = input.groupColors?.[g] === undefined ? 0xf1 : byte(input.groupColors[g])
    }
  }

  const palette =
    Array.isArray(input.palette) && input.palette.length
      ? Array.from({ length: 16 }, (_, i) => Number(input.palette?.[i]) || 0)
      : null

  // Absent in files written before tile flags existed, so default to none.
  const rawFlags = Array.isArray(input.flags) ? input.flags : []

  // sc1's pattern table is one bank of 256, so banking cannot apply — a file
  // claiming otherwise is wrong rather than interesting.
  const rawBanks = mode === 'sc1' || !Array.isArray(input.bankTiles) ? [] : input.bankTiles
  const bankTiles: TileEntry[][] = Array.from({ length: BANK_COUNT }, (_, b) => {
    const bank = Array.isArray(rawBanks[b]) ? rawBanks[b] : []
    return bank.slice(0, MAX_TILES).map((entry) => {
      const source = (entry ?? {}) as Partial<TileEntry>
      const pattern = zeros(TILE_SIZE)
      const color = perRowColor ? zeros(TILE_SIZE) : []
      for (let y = 0; y < TILE_SIZE; y++) {
        pattern[y] = byte(source.pattern?.[y])
        if (perRowColor) color[y] = source.color?.[y] === undefined ? 0xf1 : byte(source.color[y])
      }
      return { pattern, color }
    })
  })

  return {
    version: 1,
    mode,
    reserveTile0,
    palette: mode === 'sc4' ? palette : null,
    count,
    tiles,
    groupColors,
    flags: Array.from({ length: count }, (_, i) => (Number(rawFlags[i]) || 0) & 0xff),
    blocks: normalizeBlocks(input.blocks, count),
    export: (input.export as ExportBlock | undefined) ?? null,
    bankTiles,
    sharedTiles
  }
}

/** Clamps a block list to the grid limits and to tiles that actually exist. */
function normalizeBlocks(raw: unknown, count: number): TileBlock[] {
  if (!Array.isArray(raw)) return []
  const extent = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(MAX_BLOCK, Math.max(1, value | 0)) : 1
  return raw.map((entry, index) => {
    const block = (typeof entry === 'object' && entry !== null ? entry : {}) as Partial<TileBlock>
    const width = extent(block.width)
    const height = extent(block.height)
    return {
      name: String(block.name ?? `block_${index}`),
      width,
      height,
      // A reference past the end of the bank would paint nothing; tile 0 is the blank one.
      tiles: Array.from({ length: width * height }, (_, i) => {
        const tile = Number(block.tiles?.[i]) || 0
        return tile >= 0 && tile < count ? tile : 0
      })
    }
  })
}

// ── color-pair access ───────────────────────────────────────────────────────

/** The FG/BG byte governing tile `index` row `y` — per row in sc2/sc4, per group in sc1. */
export function colorByteAt(doc: TilesDoc, index: number, y: number): number {
  return doc.mode === 'sc1' ? (doc.groupColors[index >> 3] ?? 0) : (doc.tiles[index]?.color[y] ?? 0)
}

export function splitColorByte(value: number): { fg: number; bg: number } {
  return { fg: (value >> 4) & 0x0f, bg: value & 0x0f }
}

export function mergeColorByte(fg: number, bg: number): number {
  return ((fg & 0x0f) << 4) | (bg & 0x0f)
}

// ── pixels ↔ bytes ──────────────────────────────────────────────────────────

/** Decodes one tile to 64 palette indices, row-major. */
export function tilePixels(doc: TilesDoc, index: number): Uint8Array {
  const out = new Uint8Array(TILE_SIZE * TILE_SIZE)
  const tile = doc.tiles[index]
  if (!tile) return out
  for (let y = 0; y < TILE_SIZE; y++) {
    const { fg, bg } = splitColorByte(colorByteAt(doc, index, y))
    const bits = tile.pattern[y]
    for (let x = 0; x < TILE_SIZE; x++) out[y * TILE_SIZE + x] = bits & (0x80 >> x) ? fg : bg
  }
  return out
}

/** A block's pixels as one image, `width*8 × height*8` palette indices, row-major. */
export function blockPixels(doc: TilesDoc, block: TileBlock): Uint8Array {
  const width = block.width * TILE_SIZE
  const out = new Uint8Array(width * block.height * TILE_SIZE)
  for (let cy = 0; cy < block.height; cy++) {
    for (let cx = 0; cx < block.width; cx++) {
      const pixels = tilePixels(doc, block.tiles[cy * block.width + cx] ?? 0)
      for (let y = 0; y < TILE_SIZE; y++) {
        out.set(pixels.subarray(y * TILE_SIZE, y * TILE_SIZE + TILE_SIZE), (cy * TILE_SIZE + y) * width + cx * TILE_SIZE)
      }
    }
  }
  return out
}

/** The tile a block-space pixel belongs to, and where it lands inside it. Null outside the block. */
export function blockTileAt(block: TileBlock, x: number, y: number): { tile: number; tx: number; ty: number } | null {
  const cx = Math.floor(x / TILE_SIZE)
  const cy = Math.floor(y / TILE_SIZE)
  if (x < 0 || y < 0 || cx >= block.width || cy >= block.height) return null
  return { tile: block.tiles[cy * block.width + cx] ?? 0, tx: x % TILE_SIZE, ty: y % TILE_SIZE }
}

/**
 * Packs 64 palette indices into sc2/sc4 hardware bytes, reducing any row that
 * uses more than two colors to its two most frequent ones. `lossyRows` lists
 * the rows that had to be reduced — the import dialog reports them.
 */
export function tileFromPixels(pixels: ArrayLike<number>): TileEntry & { lossyRows: number[] } {
  const pattern = zeros(TILE_SIZE)
  const color = zeros(TILE_SIZE)
  const lossyRows: number[] = []

  for (let y = 0; y < TILE_SIZE; y++) {
    const counts = new Map<number, number>()
    for (let x = 0; x < TILE_SIZE; x++) {
      const value = (pixels[y * TILE_SIZE + x] ?? 0) & 0x0f
      counts.set(value, (counts.get(value) ?? 0) + 1)
    }
    // Sort by frequency, then by index so identical input always yields identical bytes.
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([value]) => value)
    if (ranked.length > 2) lossyRows.push(y)
    const fg = ranked[0] ?? 0
    const bg = ranked[1] ?? (fg === 0 ? 1 : 0)
    color[y] = mergeColorByte(fg, bg)
    let bits = 0
    for (let x = 0; x < TILE_SIZE; x++) {
      // Anything that isn't BG becomes FG — nearest of the two survivors would need
      // RGB context this function doesn't have; the quantizer's fit pass does that.
      if (((pixels[y * TILE_SIZE + x] ?? 0) & 0x0f) !== bg) bits |= 0x80 >> x
    }
    pattern[y] = bits
  }
  return { pattern, color, lossyRows }
}

export interface PackResult {
  doc: TilesDoc
  /** Tile index per source cell, row-major over `width/8 × height/8`. */
  layout: number[]
  /** Tiles whose rows (sc2/sc4) or groups (sc1) had to drop colors. */
  lossyTiles: number[]
}

/**
 * Cuts an indexed image into 8×8 tiles for `mode`. `dedup` folds identical
 * tiles together (the import option in Spec 08) and the returned `layout` is
 * exactly the name table Spec 10's map editor wants.
 */
export function packTiles(
  indices: ArrayLike<number>,
  width: number,
  height: number,
  mode: TileMode,
  options: { dedup?: boolean } = {}
): PackResult {
  const cols = Math.floor(width / TILE_SIZE)
  const rows = Math.floor(height / TILE_SIZE)
  const tiles: TileEntry[] = []
  const layout: number[] = []
  const lossyTiles: number[] = []
  const seen = new Map<string, number>()

  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const pixels = new Uint8Array(TILE_SIZE * TILE_SIZE)
      for (let y = 0; y < TILE_SIZE; y++) {
        for (let x = 0; x < TILE_SIZE; x++) {
          pixels[y * TILE_SIZE + x] = indices[(ty * TILE_SIZE + y) * width + tx * TILE_SIZE + x] ?? 0
        }
      }
      const { pattern, color, lossyRows } = tileFromPixels(pixels)
      const key = options.dedup ? `${pattern.join(',')}|${color.join(',')}` : ''
      const existing = options.dedup ? seen.get(key) : undefined
      if (existing !== undefined) {
        layout.push(existing)
        continue
      }
      const index = tiles.length
      if (options.dedup) seen.set(key, index)
      tiles.push({ pattern, color })
      layout.push(index)
      if (lossyRows.length) lossyTiles.push(index)
      if (tiles.length >= MAX_TILES) break
    }
    if (tiles.length >= MAX_TILES) break
  }

  const doc = normalizeTiles({ mode, count: Math.max(1, tiles.length), tiles })
  // sc1 can only keep one pair per group of 8 tiles: take each group's first row pair
  // and re-derive the patterns against it, so the stored bytes really are displayable.
  if (mode === 'sc1') {
    for (let g = 0; g < doc.groupColors.length; g++) {
      const first = tiles[g * SC1_GROUP]
      doc.groupColors[g] = first ? first.color[0] : 0xf1
      for (let t = g * SC1_GROUP; t < Math.min(doc.count, (g + 1) * SC1_GROUP); t++) {
        const source = tiles[t]
        if (!source) continue
        if (source.color.some((value) => value !== doc.groupColors[g]) && !lossyTiles.includes(t)) lossyTiles.push(t)
      }
    }
  }
  return { doc, layout, lossyTiles }
}

/**
 * Fixes up `groupColors` after prepending exactly one blank tile at index 0
 * (`reserveTile0`'s migration, and the tile editor's own import into a bank
 * that already reserves it) — **only** valid immediately after that specific
 * shift, not as a general sc1 sanity check.
 *
 * The shift moves every old tile up by one, so group boundaries move too: new
 * group `g` (for `g >= 1`) is the *last* tile of old group `g - 1` followed by
 * the first seven tiles of old group `g`. Seven of eight tiles keep the pair
 * they were authored with — `doc.groupColors[g]`, untouched, is already right
 * for them — so this does not re-derive every tile against a chosen "first"
 * one the way `packTiles`'s own sc1 loop does: that convention picks whichever
 * tile sits at the group's first slot, which after this shift is always the
 * *foreign* tile from the old group before it. Anchoring there would flag the
 * seven tiles that already agree instead of the one that does not — the
 * opposite of "one tile in eight" lossy. What can genuinely change is only
 * that one carried-over tile at each new group's first slot (index `g *
 * SC1_GROUP`): it renders with `groupColors[g]` now, not the `groupColors[g -
 * 1]` it was authored with, so it is lossy exactly when those two differ — a
 * fact both sides of the comparison already have, read straight off the
 * unmodified array, no history beyond `doc` itself required.
 *
 * A group with no old sibling to inherit from (the bank grew past a new
 * multiple of eight) repeats the previous group's pair: its one tile is not
 * competing with anything, so it costs nothing.
 *
 * `blankTileEntry` never lands in a comparison: group 0 has no "group -1" to
 * differ from, so the prepended blank is never counted lossy, and the 7
 * genuine tiles behind it keep `groupColors[0]` exactly as before.
 *
 * A no-op outside sc1, so both call sites can run it unconditionally.
 */
export function regroupAfterTile0Shift(doc: TilesDoc): { doc: TilesDoc; lossyTiles: number[] } {
  if (doc.mode !== 'sc1') return { doc, lossyTiles: [] }
  const groupCount = Math.ceil(doc.count / SC1_GROUP)
  const groupColors = new Array<number>(groupCount)
  for (let g = 0; g < groupCount; g++) {
    groupColors[g] = g < doc.groupColors.length ? doc.groupColors[g] : (groupColors[g - 1] ?? 0xf1)
  }
  const lossyTiles: number[] = []
  for (let g = 1; g < groupCount; g++) {
    if (groupColors[g - 1] !== groupColors[g]) lossyTiles.push(g * SC1_GROUP)
  }
  return { doc: { ...doc, groupColors }, lossyTiles }
}

// ── paint with conflict resolution (the Spec 08 core) ───────────────────────

export interface PaintConflict {
  /** sc2/sc4 constrain one 8×1 pattern row; sc1 constrains a whole group of 8 tiles. */
  scope: 'row' | 'group'
  /** Row index 0–7 within the tile, or the group index (`tileIndex >> 3`). */
  index: number
  /** The pair currently in force. */
  fg: number
  bg: number
  /** The color the user tried to paint. */
  wanted: number
}

export type PaintResult = { ok: true; doc: TilesDoc; changed: boolean } | { ok: false; conflict: PaintConflict }

/** Shallow-clones just enough of `doc` that the caller's previous value stays intact (undo stack). */
function cloneForEdit(doc: TilesDoc, index: number): TilesDoc {
  const tiles = doc.tiles.slice()
  const tile = tiles[index]
  tiles[index] = { pattern: tile.pattern.slice(), color: tile.color.slice() }
  return { ...doc, tiles, groupColors: doc.groupColors.slice() }
}

/**
 * Sets a pixel to whichever color its row already carries: `fg` sets the
 * pattern bit, `bg` clears it. This is the plain pixel-art edit, and unlike
 * `paintPixel` it can never ask the row for a third color, so it never
 * conflicts. Returns `doc` unchanged when the bit is already what was asked.
 */
export function setPixelRole(
  doc: TilesDoc,
  tileIndex: number,
  x: number,
  y: number,
  role: 'fg' | 'bg'
): TilesDoc {
  if (!doc.tiles[tileIndex] || x < 0 || x > 7 || y < 0 || y > 7) return doc
  const bit = 0x80 >> x
  const pattern = doc.tiles[tileIndex].pattern
  const next = role === 'fg' ? pattern[y] | bit : pattern[y] & ~bit & 0xff
  if (next === pattern[y]) return doc
  const edited = cloneForEdit(doc, tileIndex)
  edited.tiles[tileIndex].pattern[y] = next
  return edited
}

/** Is FG (bit set) / BG (bit clear) still used anywhere in the constrained area, ignoring the pixel being painted? */
function rolesInUse(
  doc: TilesDoc,
  index: number,
  x: number,
  y: number
): { fgUsed: boolean; bgUsed: boolean } {
  const bit = 0x80 >> x
  let fgUsed = false
  let bgUsed = false
  const scan = (tileIndex: number, row: number): void => {
    const bits = doc.tiles[tileIndex]?.pattern[row] ?? 0
    const mask = tileIndex === index && row === y ? 0xff & ~bit : 0xff
    if (bits & mask) fgUsed = true
    if (~bits & mask & 0xff) bgUsed = true
  }
  if (doc.mode === 'sc1') {
    const first = (index >> 3) * SC1_GROUP
    for (let t = first; t < Math.min(doc.count, first + SC1_GROUP); t++) {
      for (let row = 0; row < TILE_SIZE; row++) scan(t, row)
    }
  } else {
    scan(index, y)
  }
  return { fgUsed, bgUsed }
}

function writeColorByte(doc: TilesDoc, index: number, y: number, value: number): void {
  if (doc.mode === 'sc1') doc.groupColors[index >> 3] = value
  else doc.tiles[index].color[y] = value
}

/**
 * Paints one pixel, enforcing the mode's two-colors-per-row (sc2/sc4) or
 * per-group (sc1) rule.
 *
 * Resolution order — the first branch that holds wins:
 * 1. the color already *is* the row's FG or BG → just set/clear the bit;
 * 2. the pixel's current role (FG if the bit is set, BG if not) is used
 *    nowhere else in the constrained area → recolor that role, keep the bit;
 * 3. the *other* role is unused → recolor it and flip the bit;
 * 4. both are still in use → a real conflict; the caller must re-call with
 *    `resolution: 'fg' | 'bg'` (the popover's two choices).
 *
 * Never mutates `doc`; on success it returns a new document.
 */
export function paintPixel(
  doc: TilesDoc,
  tileIndex: number,
  x: number,
  y: number,
  colorIndex: number,
  resolution?: 'fg' | 'bg'
): PaintResult {
  if (!doc.tiles[tileIndex] || x < 0 || x > 7 || y < 0 || y > 7) {
    throw new RangeError(`paintPixel out of range: tile ${tileIndex}, pixel ${x},${y}`)
  }
  const wanted = colorIndex & 0x0f
  const bit = 0x80 >> x
  const current = colorByteAt(doc, tileIndex, y)
  const { fg, bg } = splitColorByte(current)
  const isSet = (doc.tiles[tileIndex].pattern[y] & bit) !== 0

  const apply = (role: 'fg' | 'bg', recolor: boolean): PaintResult => {
    const next = cloneForEdit(doc, tileIndex)
    if (recolor) {
      writeColorByte(next, tileIndex, y, role === 'fg' ? mergeColorByte(wanted, bg) : mergeColorByte(fg, wanted))
    }
    const pattern = next.tiles[tileIndex].pattern
    pattern[y] = role === 'fg' ? pattern[y] | bit : pattern[y] & ~bit & 0xff
    const changed = recolor || pattern[y] !== doc.tiles[tileIndex].pattern[y]
    return { ok: true, doc: next, changed }
  }

  if (resolution) return apply(resolution, true)
  if (wanted === fg) return apply('fg', false)
  if (wanted === bg) return apply('bg', false)

  const { fgUsed, bgUsed } = rolesInUse(doc, tileIndex, x, y)
  const currentRole = isSet ? 'fg' : 'bg'
  const currentUsed = isSet ? fgUsed : bgUsed
  const otherUsed = isSet ? bgUsed : fgUsed
  if (!currentUsed) return apply(currentRole, true)
  if (!otherUsed) return apply(isSet ? 'bg' : 'fg', true)

  return {
    ok: false,
    conflict: {
      scope: doc.mode === 'sc1' ? 'group' : 'row',
      index: doc.mode === 'sc1' ? tileIndex >> 3 : y,
      fg,
      bg,
      wanted
    }
  }
}

/** Swaps a row's (or group's) FG and BG, inverting the affected patterns. Spec 08's "FG/BG swap". */
export function swapRowColors(doc: TilesDoc, tileIndex: number, y: number): TilesDoc {
  const next = cloneForEdit(doc, tileIndex)
  const { fg, bg } = splitColorByte(colorByteAt(doc, tileIndex, y))
  writeColorByte(next, tileIndex, y, mergeColorByte(bg, fg))
  if (doc.mode === 'sc1') {
    const first = (tileIndex >> 3) * SC1_GROUP
    for (let t = first; t < Math.min(doc.count, first + SC1_GROUP); t++) {
      next.tiles[t] = { pattern: doc.tiles[t].pattern.map((v) => ~v & 0xff), color: doc.tiles[t].color.slice() }
    }
  } else {
    next.tiles[tileIndex].pattern[y] = ~next.tiles[tileIndex].pattern[y] & 0xff
  }
  return next
}

/**
 * Moves tile `from` to position `to`. Returns the new document plus the
 * old-index → new-index mapping Spec 10 replays over maps that reference it.
 */
export function reorderTiles(doc: TilesDoc, from: number, to: number): { doc: TilesDoc; mapping: number[] } {
  // A shared tile's index must never move — every meta that references it
  // means that index specifically, the same invariant `removeTile` refuses to
  // break. There is no reorder UI over the shared region yet (the tile grid
  // only shows 0..count-1), but nothing else stops a caller from asking.
  const sharedStart = MAX_TILES - doc.sharedTiles
  if (from >= sharedStart || to >= sharedStart) return { doc, mapping: doc.tiles.map((_, i) => i) }
  const tiles = doc.tiles.slice()
  const [moved] = tiles.splice(from, 1)
  tiles.splice(to, 0, moved)
  const flags = doc.flags.slice()
  const [movedFlag] = flags.splice(from, 1)
  flags.splice(to, 0, movedFlag)
  const mapping = doc.tiles.map((_, index) => {
    if (index === from) return to
    if (from < to) return index > from && index <= to ? index - 1 : index
    return index >= to && index < from ? index + 1 : index
  })
  // Flags travel with the tile — that is the whole point of them, so a
  // re-arranged tileset doesn't break the game. `groupColors` deliberately
  // stay put: in sc1 the colour belongs to the *position*, not the tile.
  return { doc: applyTileMapping({ ...doc, tiles, flags }, mapping), mapping }
}

/**
 * Deletes a tile and renumbers everything above it. The tiles that referenced
 * the deleted one — map cells, block cells — fall back to tile 0, the blank
 * one, since there is nothing else honest to point them at.
 *
 * Returns `mapping[oldIndex] = newIndex` for the same Spec 10 remap seam a
 * reorder uses, so open maps renumber the same way.
 */
export function removeTile(doc: TilesDoc, index: number): { doc: TilesDoc; mapping: number[] } {
  const identity = doc.tiles.map((_, i) => i)
  if (doc.count <= 1 || !doc.tiles[index]) return { doc, mapping: identity }

  // Shared tiles (on a banked tileset) live at MAX_TILES - sharedTiles down to
  // MAX_TILES - 1. They must only be removed from the newest (lowest index) one,
  // and only by decrementing sharedTiles — removing from anywhere else would
  // renumber shared indices and break every map drawn with the tileset.
  const sharedStart = MAX_TILES - doc.sharedTiles
  if (index >= sharedStart) {
    // Refuse to remove a shared tile unless it is the newest one.
    if (index !== sharedStart) return { doc, mapping: identity }

    // Removing the newest shared tile: decrement sharedTiles, do not renumber.
    // The tile stays in the tiles array (at a now-unreachable index), and nothing
    // else shifts.
    const mapping = identity.map((i) => (i === index ? 0 : i))
    return {
      doc: {
        ...doc,
        sharedTiles: doc.sharedTiles - 1
      },
      mapping
    }
  }

  // Common tiles (banked or unbanked): renumber as before. Remap *before*
  // normalizing: normalizeTiles clamps block references against the new,
  // smaller count, so an un-remapped reference to the last tile would be
  // clamped to 0 instead of following the tile down a slot.
  //
  // The shared region sits at sharedStart..255 in this same sparse `tiles`
  // array, far above `count`, but it is real, live art a meta may be the only
  // reference to. A whole-array `.filter` here — the bug this function exists
  // to fix — compacts those entries down into the gap this removal opens, and
  // normalizeTiles's count-bounded rebuild loop then discards them outright:
  // removing one ordinary tile destroyed every shared tile, including ones
  // this removal never touched. So both the index shift and `mapping` below
  // are bounded to `[0, commonEnd)` — the common range this removal can
  // actually affect — leaving the shared region, and any reference to it,
  // exactly where they were.
  const commonEnd = Math.min(doc.count, sharedStart)
  const mapping = identity.map((i) => (i === index ? 0 : i > index && i < commonEnd ? i - 1 : i))
  const remapped = applyTileMapping(doc, mapping)
  const tiles: TileEntry[] = []
  for (let i = 0; i < index; i++) tiles[i] = doc.tiles[i]
  for (let i = index; i < commonEnd - 1; i++) tiles[i] = doc.tiles[i + 1]
  for (let i = sharedStart; i < MAX_TILES; i++) tiles[i] = doc.tiles[i]
  return {
    doc: normalizeTiles({
      ...remapped,
      count: doc.count - 1,
      tiles,
      flags: doc.flags.filter((_, i) => i !== index),
      // sc1 colours belong to positions, so the tail slides up a slot with the tiles.
      groupColors: doc.groupColors
    }),
    mapping
  }
}

/** Rewrites every tile reference inside the document itself — today that means blocks. */
function applyTileMapping(doc: TilesDoc, mapping: readonly number[]): TilesDoc {
  if (!doc.blocks.length) return doc
  return {
    ...doc,
    blocks: doc.blocks.map((block) => ({ ...block, tiles: block.tiles.map((tile) => mapping[tile] ?? 0) }))
  }
}

// ── mode conversion ─────────────────────────────────────────────────────────

/**
 * True when the target mode can't hold what this tileset already says about
 * colour: sc2/sc4 give every row its own pair, sc1 gives one pair per group of
 * eight tiles, so going to sc1 keeps one row's colours per group and drops the
 * rest.
 */
export function tileModeConversionLossy(doc: TilesDoc, mode: TileMode): boolean {
  if (doc.mode === mode || mode !== 'sc1') return false
  // sc1 has one pattern table, not three — a banked tileset (or one still
  // holding shared meta slots) has no sc1 equivalent at all: every bank
  // override and the whole shared reservation would simply vanish. That is
  // real loss on its own, reported the same way a colour-per-row loss is,
  // and it sidesteps the group-base lookup below: index - (index % SC1_GROUP)
  // for a shared tile at (say) 255 lands on 248, which is a hole whenever
  // `count` is small — real art has never lived at a "group" that far past
  // the common range.
  if (isBanked(doc) || doc.sharedTiles > 0) return true
  return doc.tiles.some((tile, index) => {
    const first = tile.color[0]
    // Differs down the tile, or differs from the tile that will own the group.
    return tile.color.some((value) => value !== first) || first !== doc.tiles[index - (index % SC1_GROUP)].color[0]
  })
}

/**
 * Switches the tileset's mode, keeping every pattern byte. Colour follows the
 * target's model: sc1 → sc2/sc4 spreads each group's pair over its tiles' rows,
 * sc2/sc4 → sc1 keeps the first tile of each group's row 0 (see
 * `tileModeConversionLossy`), and sc2 ↔ sc4 differ only by the palette.
 */
export function convertTileMode(doc: TilesDoc, mode: TileMode): TilesDoc {
  if (doc.mode === mode) return doc
  const toGroups = mode === 'sc1'
  const tiles = doc.tiles.map((tile, index) => ({
    pattern: tile.pattern.slice(),
    color: toGroups ? [] : doc.mode === 'sc1' ? zeros(TILE_SIZE).map(() => colorByteAt(doc, index, 0)) : tile.color.slice()
  }))
  const groupColors = toGroups
    ? Array.from({ length: Math.ceil(doc.count / SC1_GROUP) }, (_, group) => doc.tiles[group * SC1_GROUP]?.color[0] ?? 0xf1)
    : []
  return normalizeTiles({
    ...doc,
    mode,
    tiles,
    groupColors,
    // sc4 is the only mode with a programmable palette; the MSX1 modes drop it.
    palette: mode === 'sc4' ? (doc.palette ?? [...MSX1_PALETTE_GRB]) : null
  })
}

// ── validation ──────────────────────────────────────────────────────────────

/** Structural check of a document. Empty array = valid. */
// ── block export ────────────────────────────────────────────────────────────

/** Where each block starts in the flat `_Blocks` table, for the emitted `#define`s. */
export interface BlockPlacement {
  name: string
  base: number
  width: number
  height: number
}

export function blockPlacements(doc: TilesDoc): BlockPlacement[] {
  let base = 0
  return doc.blocks.map((block) => {
    const placement = { name: block.name, base, width: block.width, height: block.height }
    base += block.tiles.length
    return placement
  })
}

/** Every block's tile indices, row-major, concatenated in block order. */
export function blockBytes(doc: TilesDoc): Uint8Array {
  return Uint8Array.from(doc.blocks.flatMap((block) => block.tiles.map((tile) => tile & 0xff)))
}

/**
 * The ready-made C for blocks: stamps a block's `width × height` tile indices
 * into the name table in one call. Opt-in (`ExportBlock.helpers`) because it
 * calls MSXgl's VDP module.
 *
 * `VDP_WriteLayout_GM2` is the engine's own rectangle writer — it walks the
 * 32-column name table, so it serves sc1 as well as sc2/sc4, but it compiles
 * only when the project enables `VDP_USE_MODE_G2` or `VDP_USE_MODE_G3`.
 */
export function tileHelperC(doc: TilesDoc, name: string): HelperC {
  const prefix = name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()
  const first = doc.blocks[0]?.name ?? 'BLOCK'
  const id = `${prefix}_${first.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`
  const signature = `void ${name}_DrawBlock(u8 x, u8 y, u16 base, u8 w, u8 h)`
  return {
    header: [
      '',
      `// Stamps one block of ${name} into the name table at tile column/row (x, y).`,
      '// Needs MSXgl\'s VDP module (#include "msxgl.h" before this header) built',
      '// with VDP_USE_MODE_G2 or VDP_USE_MODE_G3.',
      '//',
      '// Example:',
      `//   ${name}_DrawBlock(10, 5, ${id}_BASE, ${id}_W, ${id}_H);`,
      `${signature};`
    ],
    source: ['', signature, '{', `\tVDP_WriteLayout_GM2(${name}_Blocks + base, x, y, w, h);`, '}']
  }
}

export function validateTiles(doc: TilesDoc): string[] {
  const problems: string[] = []
  if (doc.version !== 1) problems.push(`Unsupported version ${doc.version}`)
  if (!isTileMode(doc.mode)) problems.push(`Unknown mode "${doc.mode}"`)
  if (doc.count < 1 || doc.count > MAX_TILES) problems.push(`count ${doc.count} outside 1..${MAX_TILES}`)
  // On a banked doc `tiles` also holds the shared region far above `count`
  // (see `TilesDoc.sharedTiles`), so its `.length` legitimately runs past
  // `count` — only *fewer* entries than claimed is an actual problem.
  if (doc.tiles.length < doc.count) problems.push(`count ${doc.count} but only ${doc.tiles.length} tiles`)

  const inRange = (values: number[]): boolean =>
    values.every((value) => Number.isInteger(value) && value >= 0 && value <= 0xff)

  doc.tiles.forEach((tile, index) => {
    if (tile.pattern.length !== TILE_SIZE || !inRange(tile.pattern)) problems.push(`Tile ${index}: bad pattern bytes`)
    if (doc.mode === 'sc1') {
      if (tile.color.length) problems.push(`Tile ${index}: sc1 tiles carry no per-row color`)
    } else if (tile.color.length !== TILE_SIZE || !inRange(tile.color)) {
      problems.push(`Tile ${index}: bad color bytes`)
    }
  })

  if (doc.mode === 'sc1') {
    const expected = Math.ceil(doc.count / SC1_GROUP)
    if (doc.groupColors.length !== expected) {
      problems.push(`sc1 needs ${expected} group colors, found ${doc.groupColors.length}`)
    }
    if (!inRange(doc.groupColors)) problems.push('sc1 group colors out of byte range')
  } else if (doc.groupColors.length) {
    problems.push(`${doc.mode} does not use group colors`)
  }

  doc.blocks.forEach((block, index) => {
    const label = `Block ${index} (${block.name})`
    if (block.width < 1 || block.width > MAX_BLOCK || block.height < 1 || block.height > MAX_BLOCK) {
      problems.push(`${label}: ${block.width}×${block.height} outside 1..${MAX_BLOCK}`)
    }
    if (block.tiles.length !== block.width * block.height) {
      problems.push(`${label}: ${block.width}×${block.height} needs ${block.width * block.height} tiles, found ${block.tiles.length}`)
    }
    if (block.tiles.some((tile) => tile < 0 || tile >= doc.count)) {
      problems.push(`${label}: references a tile outside the bank`)
    }
  })

  if (doc.palette) {
    if (doc.mode !== 'sc4') problems.push(`${doc.mode} uses the fixed TMS9918A palette; palette must be null`)
    if (doc.palette.length !== 16) problems.push(`Palette must hold 16 entries, found ${doc.palette.length}`)
    if (doc.palette.some((value) => (value & ~0x0777) !== 0)) problems.push('Palette entry outside the GRB333 space')
  }
  return problems
}

/**
 * Checks an indexed *image* against a row-constrained mode: every 8-pixel span
 * on every scanline must use at most two colors. Returns the offending spans
 * (`{x, y}` = the span's top-left), so the quantizer's constraint-fit pass can
 * be verified end-to-end.
 */
export function rowColorViolations(
  indices: ArrayLike<number>,
  width: number,
  height: number
): { x: number; y: number; colors: number[] }[] {
  const out: { x: number; y: number; colors: number[] }[] = []
  for (let y = 0; y < height; y++) {
    for (let x = 0; x + TILE_SIZE <= width; x += TILE_SIZE) {
      const colors = new Set<number>()
      for (let i = 0; i < TILE_SIZE; i++) colors.add(indices[y * width + x + i] ?? 0)
      if (colors.size > 2) out.push({ x, y, colors: [...colors] })
    }
  }
  return out
}

// ── export bytes ────────────────────────────────────────────────────────────

export function tilePatternBytes(doc: TilesDoc): Uint8Array {
  const out = new Uint8Array(doc.count * TILE_SIZE)
  // A bounded loop, not `.forEach`: on a banked doc `tiles` also holds the
  // shared region far past `count` (see `TilesDoc.sharedTiles`), and
  // `.forEach` walks every populated index, not just the common range this
  // table exports — `.set` at a shared tile's own offset then throws, since
  // `out` is sized for `count` tiles only. The shared/per-bank tables are a
  // banked export's own job, not this one's.
  for (let index = 0; index < doc.count; index++) out.set(doc.tiles[index].pattern, index * TILE_SIZE)
  return out
}

/** sc2/sc4: 8 bytes per tile. sc1: one byte per group of 8 tiles. */
export function tileColorBytes(doc: TilesDoc): Uint8Array {
  if (doc.mode === 'sc1') return Uint8Array.from(doc.groupColors)
  const out = new Uint8Array(doc.count * TILE_SIZE)
  // See `tilePatternBytes`: bounded to `count` for the same reason.
  for (let index = 0; index < doc.count; index++) out.set(doc.tiles[index].color, index * TILE_SIZE)
  return out
}
