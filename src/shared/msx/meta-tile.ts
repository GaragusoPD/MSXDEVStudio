/**
 * `*.meta-tiles.json` / `*.meta-btiles.json`: **one meta-tile** — a design
 * bigger than the hardware's 8×8 cell, authored as a picture and stored as
 * references into a tileset.
 *
 * This is the third instance of the pattern CLAUDE.md calls "a named group that
 * owns no pixels": like `TileBlock` and `SpriteCharacter`, a meta holds indices,
 * not art. What is new is that the *editor* presents it as a canvas — painting
 * a pixel resolves, through `meta-paint.ts`, to a tile index the same stroke
 * created or found in the bank. So the invariant survives a pixel-level editor:
 * the meta still owns nothing, and there is still no second copy to keep in
 * sync.
 *
 * One file is one meta because a meta is now an object a level *places* — a
 * tree, a door, a coin — not a row in a compression table. Its size is its own,
 * its frames are its own, and its eight gameplay bits are its own, exactly as a
 * tile's are. What a map records is a placement; see `MetaPlacement` in
 * `map.ts`.
 *
 * Why a hyphen in the suffix: `resourceKindOf` matches by `endsWith` over
 * `RESOURCE_SUFFIXES`, so `foo.meta.tiles.json` would resolve to `tiles` and
 * silently open the wrong editor. `foo.meta-tiles.json` cannot.
 */

import { defineName, type HelperC } from './emitC'
import type { MapCell } from './map'
import type { ExportBlock } from './resource'

/**
 * Tiles per axis in a meta. Nothing in the hardware says so — the cap keeps a
 * hand-edited file from asking for a 255×255 meta, which is 65,025 tiles for
 * one design. A 16×16 meta is already 128×128 dots.
 */
export const MAX_META_SIZE = 16
/** Gameplay bits per meta — eight, so one byte, exactly `TILE_FLAG_COUNT`. */
export const META_FLAG_COUNT = 8
/** Frames per meta. The emitted C indexes them with a byte. */
export const MAX_FRAMES = 255

/** One animation pose: the whole meta's tile indices, row-major. */
export interface MetaFrame {
  tiles: number[]
}

export interface MetaTileDoc {
  version: 2
  /**
   * Project-relative path of the tileset whose tiles this meta references:
   * `.tiles.json` for `.meta-tiles.json`, `.btiles.json` for `.meta-btiles.json`.
   */
  tileset: string
  /** This meta's size in tiles. Every frame is exactly this. */
  width: number
  height: number
  /**
   * Pixel geometry of one *tile*, for a bitmap set; null in a pattern mode,
   * where a tile is the name table's 8×8 cell.
   *
   * Mirrored from the referenced `.btiles.json` for the reason `MapDoc` mirrors
   * it: the exporter renders one resource at a time and never reads another
   * file, so anything the emitted C needs has to be here.
   */
  cell: MapCell | null
  /** `frames[0]` is the resting pose, as in `SpritesDoc`. Never empty. */
  frames: MetaFrame[]
  /**
   * Eight gameplay bits for the meta as a whole — what it *means* to the game,
   * in the manner of `TilesDoc.flags`. Independent of the flags on the tiles
   * underneath it: a game walking the tile grid reads tile flags, a game
   * walking a map's placement table reads these, and neither overrides the
   * other.
   */
  flags: number
  export: ExportBlock | null
}

export function createMetaTileDoc(tileset: string, width = 2, height = 2, cell: MapCell | null = null): MetaTileDoc {
  return normalizeMetaTile({ tileset, width, height, cell })
}

function extent(value: unknown, fallback: number): number {
  const n = Math.round(Number(value))
  return Number.isFinite(n) && n >= 1 ? Math.min(MAX_META_SIZE, n) : fallback
}

/** Fills in everything a hand-edited or older file is missing; never throws. */
export function normalizeMetaTile(raw: unknown): MetaTileDoc {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const width = extent(input.width, 2)
  const height = extent(input.height, 2)
  const cells = width * height

  // Version 1 held a *set*; its first meta is the only one that can survive as
  // this file's meta, and there is nowhere to put the others. No project has
  // one — the set model lived for a single commit — so this exists to keep an
  // in-flight working copy openable, not to preserve anyone's data.
  const legacy = Array.isArray(input.metas) ? (input.metas[0] as { tiles?: unknown } | undefined) : undefined
  const rawFrames =
    Array.isArray(input.frames) && input.frames.length
      ? (input.frames as { tiles?: unknown }[])
      : [{ tiles: legacy?.tiles }]

  const frames: MetaFrame[] = rawFrames.slice(0, MAX_FRAMES).map((frame) => ({
    // Resized to the document's own geometry rather than kept as authored:
    // the exported table is read at a fixed stride, so one odd frame would
    // shift every frame after it.
    tiles: Array.from({ length: cells }, (_, i) => (Number((frame?.tiles as number[] | undefined)?.[i]) || 0) & 0xff)
  }))

  return {
    version: 2,
    tileset: String(input.tileset ?? ''),
    width,
    height,
    cell: normalizeCell(input.cell),
    frames: frames.length ? frames : [{ tiles: new Array<number>(cells).fill(0) }],
    flags: (Number(input.flags) || 0) & 0xff,
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

/** Tiles per frame — the stride of the exported table. */
export function metaCells(doc: MetaTileDoc): number {
  return doc.width * doc.height
}

/** The tile at `(tx, ty)` in one frame. */
export function frameTileAt(doc: MetaTileDoc, frame: number, tx: number, ty: number): number {
  return doc.frames[frame]?.tiles[ty * doc.width + tx] ?? 0
}

/** Every frame's tile indices, row-major, concatenated in frame order. */
export function metaBytes(doc: MetaTileDoc): Uint8Array {
  return Uint8Array.from(doc.frames.flatMap((frame) => frame.tiles.map((tile) => tile & 0xff)))
}

/** Repoints one cell of one frame — what `meta-paint` calls once it has a tile. */
export function setFrameTile(doc: MetaTileDoc, frame: number, tx: number, ty: number, tile: number): MetaTileDoc {
  const current = doc.frames[frame]
  if (!current || tx < 0 || ty < 0 || tx >= doc.width || ty >= doc.height) return doc
  const at = ty * doc.width + tx
  if (current.tiles[at] === tile) return doc
  const tiles = current.tiles.slice()
  tiles[at] = tile & 0xff
  const frames = doc.frames.slice()
  frames[frame] = { tiles }
  return { ...doc, frames }
}

/** Appends a frame, copying `copyOf` when given — animation starts from a pose. */
export function addFrame(doc: MetaTileDoc, copyOf?: number): MetaTileDoc {
  if (doc.frames.length >= MAX_FRAMES) return doc
  const source = copyOf === undefined ? undefined : doc.frames[copyOf]
  const tiles = source ? source.tiles.slice() : new Array<number>(metaCells(doc)).fill(0)
  return { ...doc, frames: [...doc.frames, { tiles }] }
}

/** Removes a frame. The last one cannot go: a meta with no pose is not drawable. */
export function removeFrame(doc: MetaTileDoc, index: number): MetaTileDoc {
  if (doc.frames.length <= 1 || !doc.frames[index]) return doc
  return { ...doc, frames: doc.frames.filter((_, i) => i !== index) }
}

export function reorderFrames(doc: MetaTileDoc, from: number, to: number): MetaTileDoc {
  if (from === to || !doc.frames[from] || !doc.frames[to]) return doc
  const frames = doc.frames.slice()
  frames.splice(to, 0, ...frames.splice(from, 1))
  return { ...doc, frames }
}

/**
 * Resizes the meta, keeping the tiles that still fit (top-left anchored).
 * Grown cells get tile 0 — the transparent one — so a meta that gets bigger
 * does not sprout opaque artwork along its new edge.
 */
export function resizeMeta(doc: MetaTileDoc, width: number, height: number): MetaTileDoc {
  const w = Math.min(MAX_META_SIZE, Math.max(1, width | 0))
  const h = Math.min(MAX_META_SIZE, Math.max(1, height | 0))
  if (w === doc.width && h === doc.height) return doc
  const frames = doc.frames.map((frame) => {
    const tiles = new Array<number>(w * h).fill(0)
    for (let y = 0; y < Math.min(h, doc.height); y++) {
      for (let x = 0; x < Math.min(w, doc.width); x++) tiles[y * w + x] = frame.tiles[y * doc.width + x] ?? 0
    }
    return { tiles }
  })
  return { ...doc, width: w, height: h, frames }
}

/**
 * Applies a *tileset* reorder to every frame's references — what a meta replays
 * after a drag-reorder or a compaction in the tile editor, exactly as a map
 * does over its own cells.
 */
export function remapMetaTiles(doc: MetaTileDoc, mapping: readonly number[]): MetaTileDoc {
  return { ...doc, frames: doc.frames.map((frame) => ({ tiles: frame.tiles.map((tile) => mapping[tile] ?? 0) })) }
}

export function validateMetaTile(doc: MetaTileDoc): string[] {
  const problems: string[] = []
  if (doc.version !== 2) problems.push(`Unsupported version ${doc.version}`)
  if (!doc.tileset) problems.push('No tileset referenced')
  if (doc.width < 1 || doc.width > MAX_META_SIZE || doc.height < 1 || doc.height > MAX_META_SIZE) {
    problems.push(`Meta size ${doc.width}×${doc.height} outside 1..${MAX_META_SIZE}`)
  }
  if (!doc.frames.length) problems.push('No frames')
  const cells = metaCells(doc)
  doc.frames.forEach((frame, index) => {
    if (frame.tiles.length !== cells) problems.push(`Frame ${index}: ${frame.tiles.length} tiles, expected ${cells}`)
  })
  return problems
}

/** `#define`s locating this meta in its exported table. */
export function metaConstants(doc: MetaTileDoc, name: string): string[] {
  const prefix = defineName(name)
  const out = [
    `#define ${prefix}_META_W ${doc.width}`,
    `#define ${prefix}_META_H ${doc.height}`,
    `#define ${prefix}_CELLS ${metaCells(doc)}`,
    `#define ${prefix}_FRAMES ${doc.frames.length}`,
    `#define ${prefix}_FLAGS 0x${doc.flags.toString(16).padStart(2, '0')}`
  ]
  if (doc.cell) {
    out.push(
      `#define ${prefix}_CELL_W ${doc.cell.width}`,
      `#define ${prefix}_CELL_H ${doc.cell.height}`,
      `#define ${prefix}_ATLAS_COLS ${doc.cell.cols}`
    )
  }
  return out
}

/**
 * The opt-in ready-made C: stamp one frame of this meta into the name table.
 *
 * Written as runs rather than one `VDP_WriteLayout_GM2` over the whole
 * rectangle, because a meta is *transparent* where it holds tile 0 and a name
 * table has no holes — the only way to see through a cell is not to write it.
 * Each row becomes one call per opaque run, which for the usual case (a solid
 * meta) is still one call per row.
 *
 * A poke per cell would be the obvious alternative and is wrong twice:
 * `VDP_Poke_16K` takes `(value, dest)`, and it is 16K addressing only, so it
 * cannot write a SCREEN 4 name table at all.
 */
export function metaHelperC(doc: MetaTileDoc, name: string): HelperC {
  const prefix = defineName(name)
  if (doc.cell) return bitmapMetaHelperC(doc, name, prefix)

  const signature = `void ${name}_Draw(u8 x, u8 y, u8 frame)`
  return {
    header: [
      '',
      `// ── ${name}: a meta-tile ──────────────────────────────────────────────`,
      '//',
      `// Stamps frame \`frame\` at tile column/row (x, y). The meta is`,
      `// ${doc.width}×${doc.height} tiles${doc.frames.length > 1 ? `, with ${doc.frames.length} frames` : ''}.`,
      '//',
      '// Cells holding tile 0 are skipped, so whatever is already on screen',
      '// shows through them. That is what makes a meta-tile transparent, and it',
      '// needs the tileset to reserve tile 0.',
      '//',
      '// Needs MSXgl\'s VDP module (#include "msxgl.h" before this header) built',
      '// with VDP_USE_MODE_G2 or VDP_USE_MODE_G3.',
      '//',
      '// Example:',
      `//   ${name}_Draw(10, 5, 0);`,
      `${signature};`
    ],
    source: [
      '',
      signature,
      '{',
      `\tconst u8* src = ${name} + ((u16)frame * ${prefix}_CELLS);`,
      `\tfor(u8 row = 0; row < ${prefix}_META_H; ++row)`,
      '\t{',
      '\t\tu8 col = 0;',
      `\t\twhile(col < ${prefix}_META_W)`,
      '\t\t{',
      '\t\t\tif(src[col] == 0) { ++col; continue; }',
      '\t\t\tu8 run = col;',
      `\t\t\twhile(run < ${prefix}_META_W && src[run] != 0) ++run;`,
      '\t\t\tVDP_WriteLayout_GM2(src + col, x + col, y + row, run - col, 1);',
      '\t\t\tcol = run;',
      '\t\t}',
      `\t\tsrc += ${prefix}_META_W;`,
      '\t}',
      '}'
    ]
  }
}

/**
 * The bitmap counterpart: there is no name table, so a meta is stamped as
 * `width × height` copies out of the atlas, one `HMMM` each — the same blit the
 * map's `_DrawRow` uses.
 *
 * Transparency is the command engine's business here rather than a skipped
 * write, so unlike the pattern path this copies every cell.
 */
function bitmapMetaHelperC(doc: MetaTileDoc, name: string, prefix: string): HelperC {
  const signature = `void ${name}_Draw(UX x, UY y, u8 frame, UY atlasY)`
  return {
    header: [
      '',
      `// ── ${name}: a meta-tile in a bitmap mode ─────────────────────────────`,
      '//',
      `// Stamps frame \`frame\` — ${doc.width}×${doc.height} cells of ${doc.cell!.width}×${doc.cell!.height} dots — at dot`,
      '// position (x, y). Cells come from an atlas image parked at (0, `atlasY`)',
      `// in VRAM, ${doc.cell!.cols} to a row, the same atlas the map draws from.`,
      '//',
      '// Needs MSXgl\'s VDP command engine: MSX2 or later with VDP_USE_COMMAND,',
      '// and "msxgl.h" included before this header.',
      '//',
      '// Example:',
      `//   ${name}_Draw(64, 32, 0, ATLAS_Y);`,
      `${signature};`
    ],
    source: [
      '',
      signature,
      '{',
      `\tconst u8* src = ${name} + ((u16)frame * ${prefix}_CELLS);`,
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
