/**
 * `*.meta-tiles.json` / `*.meta-btiles.json`: a **meta-tile set** — same-sized
 * groups of tiles that a map may index *instead of* indexing tiles.
 *
 * MSX art is built from repeating clumps: a brick wall, a pine tree, a platform
 * end. The tile editor has always been able to name one (`TileBlock`) and stamp
 * it into a map, but a stamp is expanded where it is painted, so the clump lives
 * in the editor and nowhere in the ROM. A 32×24 screen costs 768 bytes either
 * way.
 *
 * A meta-tile set is the same idea kept as data. Every meta is exactly
 * `width × height` tiles, so a map cell can be a meta *index*: the same screen
 * built from 2×2 metas is 192 bytes, before RLEp, which still applies on top.
 * The map's own export emits the C that expands one back into tiles.
 *
 * **This is a resource you choose to create, not a change to an existing one.**
 * `.tiles.json` and `.btiles.json` are untouched — a meta set *references* one,
 * the way a map does. Blocks keep doing what they always did. Two suffixes share
 * this one document; the kind only says whether the referenced tileset is a
 * pattern or a bitmap one, which changes the emitted helper and nothing else.
 *
 * Why a hyphen in the suffix: `resourceKindOf` matches by `endsWith` over
 * `RESOURCE_SUFFIXES`, so `foo.meta.tiles.json` would resolve to `tiles` and
 * silently open the wrong editor. `foo.meta-tiles.json` cannot.
 */

import { defineName, type HelperC } from './emitC'
import type { MapCell } from './map'
import { MAX_TILES, type TileBlock } from './tile'
import type { ExportBlock } from './resource'

/** A map cell is a byte, so a set past this could not be indexed. */
export const MAX_METAS = MAX_TILES
/**
 * Tiles per axis in a meta. Nothing in the hardware says so — the cap keeps a
 * hand-edited file from asking for a 255×255 meta, which is 65,025 tiles for one
 * cell. A 16×16 meta is already 128×128 dots.
 */
export const MAX_META_SIZE = 16

export interface MetaTilesDoc {
  version: 1
  /**
   * Project-relative path of the tileset these group: `.tiles.json` for
   * `.meta-tiles.json`, `.btiles.json` for `.meta-btiles.json`.
   */
  tileset: string
  /** Meta size in tiles. Every meta in the set is exactly this. */
  width: number
  height: number
  /**
   * Pixel geometry of one *tile*, for a bitmap set; null in a pattern mode,
   * where a tile is the name table's 8×8 cell.
   *
   * Mirrored from the referenced `.btiles.json` for the same reason `MapDoc`
   * mirrors it: the exporter renders one resource at a time and never reads
   * another file, so anything the emitted C needs has to be here.
   */
  cell: MapCell | null
  /**
   * The metas, in index order — `TileBlock` verbatim, so a meta is also a
   * `Stamp` and `blockPixels` renders its thumbnail with no new code.
   */
  metas: TileBlock[]
  export: ExportBlock | null
}

export function createMetaTilesDoc(tileset: string, width = 2, height = 2, cell: MapCell | null = null): MetaTilesDoc {
  return normalizeMetaTiles({ tileset, width, height, cell })
}

function extent(value: unknown, fallback: number): number {
  const n = Math.round(Number(value))
  return Number.isFinite(n) && n >= 1 ? Math.min(MAX_META_SIZE, n) : fallback
}

/** Fills in everything a hand-edited or older file is missing; never throws. */
export function normalizeMetaTiles(raw: unknown): MetaTilesDoc {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<MetaTilesDoc>
  const width = extent(input.width, 2)
  const height = extent(input.height, 2)
  const cells = width * height
  const rawMetas = Array.isArray(input.metas) ? input.metas : []

  return {
    version: 1,
    tileset: String(input.tileset ?? ''),
    width,
    height,
    cell: normalizeCell(input.cell),
    // Resized to the set's own geometry rather than kept as authored: every meta
    // is the same size by definition, and the export reads the table at a fixed
    // stride, so one odd entry would shift every meta after it.
    metas: rawMetas.slice(0, MAX_METAS).map((entry, index) => {
      const meta = (typeof entry === 'object' && entry !== null ? entry : {}) as Partial<TileBlock>
      return {
        name: String(meta.name ?? `meta_${index}`),
        width,
        height,
        tiles: Array.from({ length: cells }, (_, i) => (Number(meta.tiles?.[i]) || 0) & 0xff)
      }
    }),
    export: (input.export as ExportBlock | undefined) ?? null
  }
}

function normalizeCell(raw: unknown): MapCell | null {
  if (typeof raw !== 'object' || raw === null) return null
  const cell = raw as Partial<MapCell>
  const at = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 1 ? value | 0 : fallback
  return { width: at(cell.width, 16), height: at(cell.height, 16), cols: at(cell.cols, 16) }
}

/** Tiles per meta — the stride of the exported table, and what the helpers index by. */
export function metaStride(doc: MetaTilesDoc): number {
  return doc.width * doc.height
}

/** The tile at `(tx, ty)` inside meta `index`. */
export function metaTileAt(doc: MetaTilesDoc, index: number, tx: number, ty: number): number {
  return doc.metas[index]?.tiles[ty * doc.width + tx] ?? 0
}

/** Every meta's tile indices, row-major, concatenated in index order. */
export function metaBytes(doc: MetaTilesDoc): Uint8Array {
  return Uint8Array.from(doc.metas.flatMap((meta) => meta.tiles.map((tile) => tile & 0xff)))
}

/** Replaces one meta's cells — the editor's paint step. */
export function setMetaTile(doc: MetaTilesDoc, index: number, tx: number, ty: number, tile: number): MetaTilesDoc {
  const meta = doc.metas[index]
  if (!meta || tx < 0 || ty < 0 || tx >= doc.width || ty >= doc.height) return doc
  const at = ty * doc.width + tx
  if (meta.tiles[at] === tile) return doc
  const tiles = meta.tiles.slice()
  tiles[at] = tile & 0xff
  const metas = doc.metas.slice()
  metas[index] = { ...meta, tiles }
  return { ...doc, metas }
}

export function addMeta(doc: MetaTilesDoc, name?: string): MetaTilesDoc {
  if (doc.metas.length >= MAX_METAS) return doc
  const meta: TileBlock = {
    name: name ?? `meta_${doc.metas.length}`,
    width: doc.width,
    height: doc.height,
    tiles: new Array<number>(metaStride(doc)).fill(0)
  }
  return { ...doc, metas: [...doc.metas, meta] }
}

export function renameMeta(doc: MetaTilesDoc, index: number, name: string): MetaTilesDoc {
  if (!doc.metas[index]) return doc
  const metas = doc.metas.slice()
  metas[index] = { ...metas[index], name }
  return { ...doc, metas }
}

/**
 * Resizes every meta, keeping the tiles that still fit (top-left anchored).
 * Growing fills with tile 0.
 */
export function resizeMetas(doc: MetaTilesDoc, width: number, height: number): MetaTilesDoc {
  const w = Math.min(MAX_META_SIZE, Math.max(1, width | 0))
  const h = Math.min(MAX_META_SIZE, Math.max(1, height | 0))
  if (w === doc.width && h === doc.height) return doc
  const metas = doc.metas.map((meta) => {
    const tiles = new Array<number>(w * h).fill(0)
    for (let y = 0; y < Math.min(h, doc.height); y++) {
      for (let x = 0; x < Math.min(w, doc.width); x++) tiles[y * w + x] = meta.tiles[y * doc.width + x] ?? 0
    }
    return { ...meta, width: w, height: h, tiles }
  })
  return { ...doc, width: w, height: h, metas }
}

/**
 * Deletes a meta and renumbers the ones above it, returning
 * `mapping[oldIndex] = newIndex` for the same remap seam a tileset reorder uses
 * — a map drawn with this set replays it so its cells still point at the same
 * art. Cells that referenced the deleted meta fall back to meta 0, since there
 * is nothing else honest to point them at.
 */
export function removeMeta(doc: MetaTilesDoc, index: number): { doc: MetaTilesDoc; mapping: number[] } {
  const identity = doc.metas.map((_, i) => i)
  if (!doc.metas[index]) return { doc, mapping: identity }
  return {
    doc: { ...doc, metas: doc.metas.filter((_, i) => i !== index) },
    mapping: identity.map((i) => (i === index ? 0 : i > index ? i - 1 : i))
  }
}

/** Moves meta `from` to position `to`, with the mapping maps replay. */
export function reorderMetas(doc: MetaTilesDoc, from: number, to: number): { doc: MetaTilesDoc; mapping: number[] } {
  const identity = doc.metas.map((_, i) => i)
  if (from === to || !doc.metas[from] || !doc.metas[to]) return { doc, mapping: identity }
  const metas = doc.metas.slice()
  metas.splice(to, 0, ...metas.splice(from, 1))
  const mapping = identity.map((index) => {
    if (index === from) return to
    if (from < to) return index > from && index <= to ? index - 1 : index
    return index >= to && index < from ? index + 1 : index
  })
  return { doc: { ...doc, metas }, mapping }
}

/**
 * Applies a *tileset* reorder to every meta's references — what a meta set
 * replays after a drag-reorder in the tile editor, exactly as a map does.
 *
 * The two directions cannot be confused, because a document only ever replays
 * the log of the file it references: a meta set reads its tileset's, a map drawn
 * with a meta set reads the meta set's.
 */
export function remapMetaTiles(doc: MetaTilesDoc, mapping: readonly number[]): MetaTilesDoc {
  if (!doc.metas.length) return doc
  return { ...doc, metas: doc.metas.map((meta) => ({ ...meta, tiles: meta.tiles.map((tile) => mapping[tile] ?? 0) })) }
}

export function validateMetaTiles(doc: MetaTilesDoc): string[] {
  const problems: string[] = []
  if (doc.version !== 1) problems.push(`Unsupported version ${doc.version}`)
  if (!doc.tileset) problems.push('No tileset referenced')
  if (doc.width < 1 || doc.width > MAX_META_SIZE || doc.height < 1 || doc.height > MAX_META_SIZE) {
    problems.push(`Meta size ${doc.width}×${doc.height} outside 1..${MAX_META_SIZE}`)
  }
  // A map cell is one byte, so a 257th meta could be defined but never painted.
  if (doc.metas.length > MAX_METAS) problems.push(`${doc.metas.length} metas, but a map cell can only index ${MAX_METAS}`)
  if (!doc.metas.length) problems.push('No meta-tiles defined')
  const stride = metaStride(doc)
  doc.metas.forEach((meta, index) => {
    if (meta.tiles.length !== stride) {
      problems.push(`Meta ${index} "${meta.name}": ${meta.tiles.length} tiles, expected ${stride}`)
    }
  })
  return problems
}

/** `#define`s locating each *named* meta, so game code says the name, not the number. */
export function metaConstants(doc: MetaTilesDoc, name: string): string[] {
  const prefix = defineName(name)
  const out = [
    `#define ${prefix}_META_W ${doc.width}`,
    `#define ${prefix}_META_H ${doc.height}`,
    `#define ${prefix}_COUNT ${doc.metas.length}`
  ]
  if (doc.cell) {
    out.push(
      `#define ${prefix}_CELL_W ${doc.cell.width}`,
      `#define ${prefix}_CELL_H ${doc.cell.height}`,
      `#define ${prefix}_ATLAS_COLS ${doc.cell.cols}`
    )
  }
  // Auto-named metas would emit `_META_0 0`, which says nothing the index doesn't.
  doc.metas.forEach((meta, index) => {
    if (!/^meta_\d+$/.test(meta.name)) out.push(`#define ${prefix}_${defineName(meta.name)} ${index}`)
  })
  return out
}

/**
 * The opt-in ready-made C: stamp one meta where a block would go. This is the
 * runtime counterpart of the map's expansion helpers — a door that opens, a
 * block that breaks — and it is the same shape as the tileset's own
 * `_DrawBlock`, except that a meta's size is known at compile time so the caller
 * does not pass it.
 *
 * Expanding a whole *map* is not here: that needs the map's dimensions, so it
 * lives on the map resource (`metaMapHelperC` in `map.ts`).
 */
export function metaHelperC(doc: MetaTilesDoc, name: string): HelperC {
  const prefix = defineName(name)
  const stride = metaStride(doc)
  const first = doc.metas.find((meta) => !/^meta_\d+$/.test(meta.name))
  const example = first ? `${prefix}_${defineName(first.name)}` : '0'
  if (doc.cell) return bitmapMetaHelperC(doc, name, prefix, example)

  const signature = `void ${name}_DrawMeta(u8 x, u8 y, u8 meta)`
  return {
    header: [
      '',
      `// Stamps one meta-tile of ${name} into the name table at tile column/row (x, y).`,
      `// A meta is ${doc.width}×${doc.height} tiles, so it covers that much of the screen.`,
      '// Needs MSXgl\'s VDP module (#include "msxgl.h" before this header) built',
      '// with VDP_USE_MODE_G2 or VDP_USE_MODE_G3.',
      '//',
      '// Example:',
      `//   ${name}_DrawMeta(10, 5, ${example});`,
      `${signature};`
    ],
    source: [
      '',
      signature,
      '{',
      `\tVDP_WriteLayout_GM2(${name} + ((u16)meta * ${stride}), x, y, ${prefix}_META_W, ${prefix}_META_H);`,
      '}'
    ]
  }
}

/**
 * The bitmap counterpart: there is no name table, so a meta is stamped as
 * `width × height` copies out of the atlas, one `HMMM` each — the same blit the
 * map's `_DrawRow` uses, and the same one `stage.h` has always emitted.
 */
function bitmapMetaHelperC(doc: MetaTilesDoc, name: string, prefix: string, example: string): HelperC {
  const stride = metaStride(doc)
  const signature = `void ${name}_DrawMeta(UX x, UY y, u8 meta, UY atlasY)`
  return {
    header: [
      '',
      `// ── ${name}: meta-tiles in a bitmap mode ──────────────────────────────`,
      '//',
      `// Stamps one meta-tile — ${doc.width}×${doc.height} cells of ${doc.cell!.width}×${doc.cell!.height} dots — at dot`,
      '// position (x, y). Cells come from an atlas image parked at (0, `atlasY`)',
      `// in VRAM, ${doc.cell!.cols} to a row, the same atlas the map draws from.`,
      '//',
      '// Needs MSXgl\'s VDP command engine: MSX2 or later with VDP_USE_COMMAND,',
      '// and "msxgl.h" included before this header.',
      '//',
      '// Example:',
      `//   ${name}_DrawMeta(64, 32, ${example}, ATLAS_Y);`,
      `${signature};`
    ],
    source: [
      '',
      signature,
      '{',
      `\tconst u8* src = ${name} + ((u16)meta * ${stride});`,
      `\tfor(u8 row = 0; row < ${prefix}_META_H; ++row)`,
      '\t{',
      `\t\tfor(u8 col = 0; col < ${prefix}_META_W; ++col)`,
      '\t\t{',
      '\t\t\tu8 cell = *src++;',
      `\t\t\tVDP_CommandHMMM((u16)(cell % ${prefix}_ATLAS_COLS) * ${prefix}_CELL_W,`,
      `\t\t\t                atlasY + ((cell / ${prefix}_ATLAS_COLS) * ${prefix}_CELL_H),`,
      `\t\t\t                x + (col * ${prefix}_CELL_W), y + (row * ${prefix}_CELL_H),`,
      `\t\t\t                ${prefix}_CELL_W, ${prefix}_CELL_H);`,
      '\t\t}',
      '\t}',
      '}'
    ]
  }
}
