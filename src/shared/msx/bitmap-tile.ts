/**
 * `*.btiles.json`: the **bitmap-mode tileset** — the SCREEN 5/6/7/8 counterpart
 * of `*.tiles.json`, and a different thing from `*.screen.json`.
 *
 * A screen is one picture, used as it is. A tileset is a bank of small images
 * addressed by number, which a map indexes and a game blits. Pattern modes have
 * had one since Spec 08; bitmap modes had only the screen, so a bitmap tilemap
 * ended up pointing its `tileset` at a picture and reading it as an implicit
 * grid. That works, but it costs everything a tileset is *for*: no gameplay
 * flags, so collision falls back to comparing tile numbers against ranges; no
 * blocks; and the tile order becomes load-bearing, because it is the only thing
 * carrying meaning.
 *
 * So this is deliberately shaped like `TilesDoc` — same `count`, `flags`,
 * `blocks` and `export` fields, and it reuses `TileBlock` outright — and
 * differs only where the hardware does:
 *
 * - **Pixels, not patterns.** A pattern tile is 8 pattern bytes plus colour
 *   attributes; a bitmap tile is one palette index per pixel, packed at export
 *   to whatever the mode holds (two per byte in SCREEN 5, four in SCREEN 6…).
 * - **Any size.** A pattern tile is 8×8 because the name table says so. Nothing
 *   in a bitmap mode cares, so the size is the tileset's own property — 16×16
 *   for a chunky canyon, 8×8 for a fine one, 32×16 if that is what the art
 *   wants.
 * - **Imported as well as drawn.** Pattern tiles are authored pixel by pixel.
 *   A bitmap tileset can be *cut from an image* — which is what makes it usable
 *   for art that came from outside, and `sliceImage` is that operation.
 *
 * The VRAM layout is a grid rather than one long strip, because a strip of
 * fifty 16-dot tiles is 800 dots wide and VRAM is 256. `sheetCols` is how many
 * fit, and it is what `_Upload` uploads and `_Draw` indexes into.
 */

import { defineName, type HelperC } from './emitC'
import { isBitmapMode, MODES, type BitmapMode } from './modes'
import type { TileBlock } from './tile'
import { MAX_BLOCK } from './tile'
import { decodeIndices, encodeIndices, packBitmap } from './screen'
import { sc3PatternBytes, sc3TileBytes, sc3TileHelperC, SC3_COLS, SC3_ROWS, SC3_TILE_BLOCKS } from './sc3'
import type { ExportBlock } from './resource'

/** VRAM is this many dots across in every bitmap mode, so it caps a sheet row. */
export const SHEET_WIDTH = 256
/** The same ceiling pattern tiles use: a tile index has to fit in a byte. */
export const MAX_BITMAP_TILES = 256
/** Past this a "tile" is a picture; the cap only exists to keep a bad file from allocating forever. */
export const MAX_TILE_SIZE = 64

export interface BitmapTilesDoc {
  version: 1
  mode: BitmapMode
  /** 16 packed GRB333 entries for sc5/6/7; null for sc8, which has no palette. */
  palette: number[] | null
  /** Tile size in pixels. The whole point of a bitmap tileset is that this varies. */
  width: number
  height: number
  count: number
  /**
   * Base64, one palette index per pixel, tiles end to end: tile `n` starts at
   * `n * width * height`, row-major within the tile.
   *
   * Base64 rather than an array of numbers because a 48-tile 16×16 bank is
   * 12,288 pixels, and as JSON numbers that is a 60 KB file that no one can
   * diff anyway. Same reason `ScreenDoc` stores its conversion this way.
   */
  pixels: string
  /** Eight gameplay bits per tile, one byte each. Exactly `TilesDoc.flags`. */
  flags: number[]
  /** Named multi-tile designs, exactly `TilesDoc.blocks` — the same type. */
  blocks: TileBlock[]
  /**
   * The index a blit treats as see-through, or null for an opaque tileset.
   *
   * Exactly `MapDoc.transparent`, for exactly its reason: an index is a colour
   * like any other and none of them can be *assumed* to mean nothing. It is what
   * turns a tile bank into a software-sprite sheet — with it, `_DrawTileMasked`
   * puts a character over a background instead of a rectangle over it.
   *
   * Only sc3 reads it today: the V9938 modes blit with the command engine, whose
   * transparency comes from the logical operation rather than from the data.
   */
  transparent: number | null
  export: ExportBlock | null
}

const zeros = (n: number): number[] => new Array<number>(n).fill(0)

/**
 * How many tiles fit across a VRAM row — and so the shape of the exported sheet.
 *
 * sc3 has no sheet: its tiles are read out of ROM by the CPU (or loaded into the
 * pattern table), never parked in VRAM as an image. The number is still what the
 * editors lay the bank out with, so it returns a readable grid rather than the
 * 128 the dot arithmetic would give for a 2-block tile.
 */
export function sheetCols(doc: BitmapTilesDoc): number {
  if (doc.mode === 'sc3') return 16
  return Math.max(1, Math.floor(SHEET_WIDTH / doc.width))
}

/** How many rows of tiles the sheet needs. */
export function sheetRows(doc: BitmapTilesDoc): number {
  return Math.ceil(doc.count / sheetCols(doc))
}

export function createBitmapTilesDoc(mode: BitmapMode = 'sc5', width = 16, height = 16, count = 16): BitmapTilesDoc {
  return normalizeBitmapTiles({ mode, width, height, count })
}

function size(value: unknown, fallback: number): number {
  const n = Math.round(Number(value))
  return Number.isFinite(n) && n >= 1 ? Math.min(MAX_TILE_SIZE, n) : fallback
}

/** Fills in everything a hand-edited or older file is missing; never throws. */
export function normalizeBitmapTiles(raw: unknown): BitmapTilesDoc {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<BitmapTilesDoc>
  const mode: BitmapMode = isBitmapMode(String(input.mode)) ? (input.mode as BitmapMode) : 'sc5'
  const width = sc3Size(mode, size(input.width, mode === 'sc3' ? SC3_TILE_BLOCKS : 16), SC3_COLS, true)
  const height = sc3Size(mode, size(input.height, mode === 'sc3' ? SC3_TILE_BLOCKS : 16), SC3_ROWS, false)
  const count = Math.max(1, Math.min(MAX_BITMAP_TILES, Math.round(Number(input.count)) || 16))
  const per = width * height

  // Whatever the file holds, trimmed or zero-filled to exactly `count` tiles —
  // a short `pixels` is the normal case for a file someone shrank by hand.
  const stored = typeof input.pixels === 'string' ? decodeIndices(input.pixels) : new Uint8Array(0)
  const pixels = new Uint8Array(count * per)
  pixels.set(stored.subarray(0, pixels.length))

  const rawFlags = Array.isArray(input.flags) ? input.flags : []
  const rawBlocks = Array.isArray(input.blocks) ? input.blocks : []

  return {
    version: 1,
    mode,
    palette: Array.isArray(input.palette) ? input.palette.slice(0, 16).map((v) => Number(v) || 0) : defaultPalette(mode),
    width,
    height,
    count,
    pixels: encodeIndices(pixels),
    flags: Array.from({ length: count }, (_, i) => (Number(rawFlags[i]) || 0) & 0xff),
    blocks: rawBlocks.map(normalizeBlock).filter((block): block is TileBlock => block !== null),
    transparent:
      typeof input.transparent === 'number' && Number.isFinite(input.transparent)
        ? Math.max(0, Math.min(15, input.transparent | 0))
        : null,
    export: (input.export as ExportBlock) ?? null
  }
}

/**
 * sc3 tiles are measured in 4×4 blocks, not dots, so they are small and the
 * limits are the screen. The width is forced **even** because two blocks share a
 * VRAM byte and the blitter copies bytes — an odd width would start the next row
 * mid-byte and could not be drawn.
 *
 * 2×2 is the default and the interesting size: that is exactly one name-table
 * entry, which is what lets a sc3 tileset also be a real tilemap.
 */
function sc3Size(mode: BitmapMode, value: number, limit: number, even: boolean): number {
  if (mode !== 'sc3') return value
  const clamped = Math.max(1, Math.min(limit, value))
  return even ? Math.max(2, clamped - (clamped % 2)) : clamped
}

/**
 * Only the V9938's programmable modes have a palette to hold. sc8 is RGB332 and
 * sc3 is the TMS9918A's fixed sixteen — both read their colours from the index
 * itself, so storing sixteen zeroes for them would render everything black.
 */
function defaultPalette(mode: BitmapMode): number[] | null {
  return MODES[mode].palette === 'grb333' ? zeros(16) : null
}

function normalizeBlock(raw: unknown): TileBlock | null {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<TileBlock>
  const width = Math.max(1, Math.min(MAX_BLOCK, Math.round(Number(input.width)) || 1))
  const height = Math.max(1, Math.min(MAX_BLOCK, Math.round(Number(input.height)) || 1))
  const tiles = Array.isArray(input.tiles) ? input.tiles : []
  return {
    name: String(input.name ?? 'block'),
    width,
    height,
    tiles: Array.from({ length: width * height }, (_, i) => (Number(tiles[i]) || 0) & 0xff)
  }
}

// ── pixels ──────────────────────────────────────────────────────────────────

/** The whole bank decoded: one index per pixel, tile by tile. */
export function tilePixels(doc: BitmapTilesDoc): Uint8Array {
  const pixels = new Uint8Array(doc.count * doc.width * doc.height)
  pixels.set(decodeIndices(doc.pixels).subarray(0, pixels.length))
  return pixels
}

/** One tile's pixels, as its own `width × height` block. */
export function tileImage(doc: BitmapTilesDoc, index: number): Uint8Array {
  const per = doc.width * doc.height
  return tilePixels(doc).subarray(index * per, index * per + per)
}

/**
 * `doc` with `mutate` applied to a decoded copy of the bank. Every pixel edit
 * goes through here so the base64 is written back in exactly one place.
 */
export function withPixels(doc: BitmapTilesDoc, mutate: (pixels: Uint8Array) => void): BitmapTilesDoc {
  const pixels = tilePixels(doc)
  mutate(pixels)
  return { ...doc, pixels: encodeIndices(pixels) }
}

/** One pixel of one tile. Out-of-range reads give 0 rather than throwing. */
export function getTilePixel(doc: BitmapTilesDoc, index: number, x: number, y: number): number {
  if (index < 0 || index >= doc.count || x < 0 || y < 0 || x >= doc.width || y >= doc.height) return 0
  return tilePixels(doc)[index * doc.width * doc.height + y * doc.width + x]
}

export function setTilePixel(
  doc: BitmapTilesDoc,
  index: number,
  x: number,
  y: number,
  color: number
): BitmapTilesDoc {
  if (index < 0 || index >= doc.count || x < 0 || y < 0 || x >= doc.width || y >= doc.height) return doc
  return withPixels(doc, (pixels) => {
    pixels[index * doc.width * doc.height + y * doc.width + x] = color & 0xff
  })
}

/** Replaces one tile's pixels wholesale — what a paste or an import of a single cell does. */
export function setTileImage(doc: BitmapTilesDoc, index: number, image: Uint8Array): BitmapTilesDoc {
  if (index < 0 || index >= doc.count) return doc
  const per = doc.width * doc.height
  return withPixels(doc, (pixels) => pixels.set(image.subarray(0, per), index * per))
}

// ── importing an image ──────────────────────────────────────────────────────

export interface SliceOptions {
  /** Drop tiles identical to one already taken, and report where each cell went. */
  dedupe?: boolean
  /** Stop after this many tiles. Defaults to the bank ceiling. */
  limit?: number
}

export interface SliceResult {
  doc: BitmapTilesDoc
  /** For each cell of the source image, row-major, which tile it became. */
  cells: number[]
  /** Cells the source held, before any dedupe. */
  sourceCols: number
  sourceRows: number
}

/**
 * Cuts an indexed image into tiles — the operation a screen cannot do, and the
 * reason a bitmap tileset is worth having.
 *
 * `cells` comes back so the caller can build a map straight from the picture:
 * import a screenshot of a level, and the tileset *and* its tilemap fall out of
 * the same pass. With `dedupe` on, identical cells collapse to one tile, which
 * is what makes that map worth storing — a hand-drawn level is mostly repeats.
 */
export function sliceImage(
  doc: BitmapTilesDoc,
  indices: Uint8Array,
  imageWidth: number,
  imageHeight: number,
  options: SliceOptions = {}
): SliceResult {
  const limit = Math.max(1, Math.min(MAX_BITMAP_TILES, options.limit ?? MAX_BITMAP_TILES))
  const cols = Math.floor(imageWidth / doc.width)
  const rows = Math.floor(imageHeight / doc.height)
  const per = doc.width * doc.height

  const taken: Uint8Array[] = []
  const seen = new Map<string, number>()
  const cells: number[] = []

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const tile = new Uint8Array(per)
      for (let y = 0; y < doc.height; y++) {
        const from = (row * doc.height + y) * imageWidth + col * doc.width
        tile.set(indices.subarray(from, from + doc.width), y * doc.width)
      }
      const key = options.dedupe ? tile.join(',') : null
      const already = key === null ? undefined : seen.get(key)
      if (already !== undefined) {
        cells.push(already)
        continue
      }
      if (taken.length >= limit) {
        // Out of room: the cell still has to point somewhere, and tile 0 is the
        // only index that is always valid.
        cells.push(0)
        continue
      }
      const index = taken.length
      taken.push(tile)
      if (key !== null) seen.set(key, index)
      cells.push(index)
    }
  }

  const count = Math.max(1, taken.length)
  const pixels = new Uint8Array(count * per)
  taken.forEach((tile, index) => pixels.set(tile, index * per))

  return {
    doc: normalizeBitmapTiles({ ...doc, count, pixels: encodeIndices(pixels), flags: doc.flags.slice(0, count) }),
    cells,
    sourceCols: cols,
    sourceRows: rows
  }
}

// ── editing the bank ────────────────────────────────────────────────────────

/** Appends a blank tile. The bank grows at the end, so nothing renumbers. */
export function addBitmapTile(doc: BitmapTilesDoc): BitmapTilesDoc {
  if (doc.count >= MAX_BITMAP_TILES) return doc
  const per = doc.width * doc.height
  const pixels = new Uint8Array((doc.count + 1) * per)
  pixels.set(tilePixels(doc))
  return { ...doc, count: doc.count + 1, pixels: encodeIndices(pixels), flags: [...doc.flags, 0] }
}

/**
 * Removes a tile, and takes the flags and blocks with it — the same remap seam
 * `tile.ts` uses, for the same reason: an index that moved and a reference that
 * did not is a silent corruption.
 */
export function removeBitmapTile(doc: BitmapTilesDoc, index: number): { doc: BitmapTilesDoc; remap: number[] } {
  if (doc.count <= 1 || index < 0 || index >= doc.count) return { doc, remap: identity(doc.count) }
  const per = doc.width * doc.height
  const pixels = tilePixels(doc)
  const kept = new Uint8Array((doc.count - 1) * per)
  kept.set(pixels.subarray(0, index * per))
  kept.set(pixels.subarray((index + 1) * per), index * per)

  const remap = identity(doc.count).map((_, i) => (i === index ? 0 : i > index ? i - 1 : i))
  const flags = doc.flags.slice()
  flags.splice(index, 1)
  return {
    doc: {
      ...doc,
      count: doc.count - 1,
      pixels: encodeIndices(kept),
      flags,
      blocks: doc.blocks.map((block) => ({ ...block, tiles: block.tiles.map((tile) => remap[tile] ?? 0) }))
    },
    remap
  }
}

/** Moves a tile, renumbering flags and blocks so nothing points at the wrong art. */
export function reorderBitmapTiles(doc: BitmapTilesDoc, from: number, to: number): { doc: BitmapTilesDoc; remap: number[] } {
  const last = doc.count - 1
  if (from === to || from < 0 || to < 0 || from > last || to > last) return { doc, remap: identity(doc.count) }
  const per = doc.width * doc.height
  const pixels = tilePixels(doc)
  const order = identity(doc.count)
  const [moved] = order.splice(from, 1)
  order.splice(to, 0, moved)

  const next = new Uint8Array(pixels.length)
  order.forEach((source, target) => next.set(pixels.subarray(source * per, source * per + per), target * per))

  const remap = identity(doc.count)
  order.forEach((source, target) => { remap[source] = target })
  const flags = order.map((source) => doc.flags[source] ?? 0)
  return {
    doc: {
      ...doc,
      pixels: encodeIndices(next),
      flags,
      blocks: doc.blocks.map((block) => ({ ...block, tiles: block.tiles.map((tile) => remap[tile] ?? 0) }))
    },
    remap
  }
}

/**
 * Re-cuts the bank at a new tile size, keeping the top-left of each tile.
 *
 * Resizing is destructive at the edges and there is no honest way around that,
 * so it crops rather than scaling: a 16×16 tile taken down to 8×8 keeps its
 * top-left quarter, which is at least recognisable while the user undoes it.
 */
export function resizeTiles(doc: BitmapTilesDoc, width: number, height: number): BitmapTilesDoc {
  const w = size(width, doc.width)
  const h = size(height, doc.height)
  if (w === doc.width && h === doc.height) return doc
  const from = tilePixels(doc)
  const next = new Uint8Array(doc.count * w * h)
  for (let index = 0; index < doc.count; index++) {
    for (let y = 0; y < Math.min(h, doc.height); y++) {
      for (let x = 0; x < Math.min(w, doc.width); x++) {
        next[index * w * h + y * w + x] = from[index * doc.width * doc.height + y * doc.width + x]
      }
    }
  }
  return { ...doc, width: w, height: h, pixels: encodeIndices(next) }
}

function identity(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i)
}

// ── export ──────────────────────────────────────────────────────────────────

/**
 * The bank as one image, laid out the way it will sit in VRAM: `sheetCols`
 * tiles across, padded to a full grid.
 *
 * A grid rather than one row because VRAM is 256 dots wide, and it is padded
 * because `_Upload` is a single `HMMC` — a ragged last row would need a second
 * call and a special case in the helper for nothing.
 */
export function sheetPixels(doc: BitmapTilesDoc): { width: number; height: number; indices: Uint8Array } {
  const cols = sheetCols(doc)
  const rows = sheetRows(doc)
  const width = cols * doc.width
  const height = rows * doc.height
  const indices = new Uint8Array(width * height)
  const pixels = tilePixels(doc)
  for (let index = 0; index < doc.count; index++) {
    const ox = (index % cols) * doc.width
    const oy = Math.floor(index / cols) * doc.height
    for (let y = 0; y < doc.height; y++) {
      const from = index * doc.width * doc.height + y * doc.width
      indices.set(pixels.subarray(from, from + doc.width), (oy + y) * width + ox)
    }
  }
  return { width, height, indices }
}

/**
 * The sheet, packed for the mode — what `_Tiles` holds.
 *
 * sc3 does not go through the sheet at all. The sheet exists so one `HMMC` can
 * park every tile in VRAM and each draw is then a VDP-to-VDP copy; sc3 has no
 * command engine, so its tiles are blitted out of ROM by the CPU and are laid
 * out for that reader — each tile on its own, `ceil(width / 2)` bytes per row.
 */
export function bitmapTileBytes(doc: BitmapTilesDoc): Uint8Array {
  if (doc.mode === 'sc3') {
    return sc3NameTableCapable(doc)
      ? sc3PatternBytes(tilePixels(doc), doc.count)
      : sc3TileBytes(tilePixels(doc), doc.count, doc.width, doc.height)
  }
  const sheet = sheetPixels(doc)
  return packBitmap(sheet.indices, sheet.width, sheet.height, doc.mode)
}

/** True when this sc3 tileset's tiles are one name-table entry each, so a map can draw it through the VDP. */
export function sc3NameTableCapable(doc: BitmapTilesDoc): boolean {
  return doc.mode === 'sc3' && doc.width === SC3_TILE_BLOCKS && doc.height === SC3_TILE_BLOCKS
}

/** The table suffix a sc3 tileset exports under — `_Patterns` when it can also be a name-table map. */
export function sc3TableSuffix(doc: BitmapTilesDoc): string {
  return sc3NameTableCapable(doc) ? '_Patterns' : '_Tiles'
}

/** Blocks flattened to tile indices, row-major, in declaration order. */
export function bitmapBlockBytes(doc: BitmapTilesDoc): Uint8Array {
  const bytes: number[] = []
  for (const block of doc.blocks) bytes.push(...block.tiles.map((tile) => tile & 0xff))
  return Uint8Array.from(bytes)
}

/** Where each block starts in the flat `_Blocks` table, for the emitted `#define`s. */
export function bitmapBlockOffsets(doc: BitmapTilesDoc): number[] {
  const offsets: number[] = []
  let at = 0
  for (const block of doc.blocks) {
    offsets.push(at)
    at += block.width * block.height
  }
  return offsets
}

export function validateBitmapTiles(doc: BitmapTilesDoc): string[] {
  const problems: string[] = []
  const colors = MODES[doc.mode].colors
  const pixels = tilePixels(doc)
  if (pixels.some((value) => value >= colors)) {
    problems.push(`A tile uses a colour past ${colors - 1}, which ${MODES[doc.mode].label} cannot show.`)
  }
  if (doc.blocks.some((block) => block.tiles.some((tile) => tile >= doc.count))) {
    problems.push('A block points at a tile that no longer exists.')
  }
  if (sheetRows(doc) * doc.height > 1024) {
    problems.push('The sheet is taller than VRAM: use fewer or smaller tiles.')
  }
  return problems
}

/**
 * Upload, draw, and stamp — the bitmap counterpart of `tileHelperC`.
 *
 * The sheet is parked in a VRAM page the display never shows and every draw is
 * a VDP-to-VDP copy, which is the whole reason a bitmap tileset is worth having
 * over blitting from ROM: the CPU writes coordinates, not pixels.
 */
export function bitmapTileHelperC(doc: BitmapTilesDoc, name: string): HelperC {
  // No command engine on an MSX1: sc3 blits with the CPU, into the shadow buffer
  // the screen resource flushes. `sc3.ts` emits that, plus the pattern-table
  // upload when the tiles are 2×2 and so can be a name-table map as well.
  if (doc.mode === 'sc3') {
    return sc3TileHelperC(name, doc.width, doc.height, doc.count, doc.transparent)
  }
  const prefix = defineName(name)
  const cols = sheetCols(doc)
  const drawSignature = `void ${name}_Draw(u8 tile, UX x, UY y, UY sheetY)`
  const blockSignature = `void ${name}_DrawBlock(const u8* block, u8 w, u8 h, UX x, UY y, UY sheetY)`

  const header = [
    '',
    `// ── ${name}: bitmap tiles ─────────────────────────────────────────────`,
    '//',
    `// ${doc.count} tiles of ${doc.width}×${doc.height}, held as a ${cols}-wide sheet.`,
    '// Park the sheet once in a page the display never shows, then every draw is',
    '// one VDP block copy — the CPU writes coordinates, never pixels.',
    '//',
    '// Needs MSXgl\'s VDP command engine: MSX2 or later with VDP_USE_COMMAND,',
    '// and "msxgl.h" included before this header.',
    '//',
    '// Example:',
    `//   ${name}_Upload(256);              // sheet parked at VRAM row 256`,
    `//   ${name}_Draw(cell, x, y, 256);    // one tile onto the screen`,
    '',
    `void ${name}_Upload(UY sheetY);`,
    `${drawSignature};`,
    `${blockSignature};`
  ]

  const source = [
    '',
    `void ${name}_Upload(UY sheetY)`,
    '{',
    `\tVDP_CommandHMMC(${name}_Tiles, 0, sheetY, ${prefix}_SHEET_W, ${prefix}_SHEET_H);`,
    '}',
    '',
    drawSignature,
    '{',
    `\tVDP_CommandHMMM((tile % ${prefix}_COLS) * ${prefix}_TILE_W,`,
    `\t\tsheetY + (tile / ${prefix}_COLS) * ${prefix}_TILE_H,`,
    `\t\tx, y, ${prefix}_TILE_W, ${prefix}_TILE_H);`,
    '}',
    '',
    '// Row by row, because a block is tile *references* — the art it points at is',
    '// wherever those tiles happen to sit in the sheet.',
    blockSignature,
    '{',
    '\tfor(u8 row = 0; row < h; ++row)',
    '\t{',
    '\t\tfor(u8 col = 0; col < w; ++col)',
    `\t\t\t${name}_Draw(block[row * w + col], x + col * ${prefix}_TILE_W,`,
    `\t\t\t\ty + row * ${prefix}_TILE_H, sheetY);`,
    '\t}',
    '}'
  ]

  return { header, source }
}
