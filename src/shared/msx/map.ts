/**
 * `*.map.json` (Spec 10 A): a tilemap over a `*.tiles.json` or `*.btiles.json`
 * tileset. Layers
 * are flat `width * height` arrays — either tile indices or per-cell bit
 * layers — which is exactly what gets exported.
 *
 * A map can also be drawn in a **bitmap** mode, where the tileset is a
 * `*.screen.json` instead: see `MapCell`.
 */

import { packRlep } from './compress'
import { defineName, type HelperC } from './emitC'
// Type-only, so it erases: `meta-tile.ts` takes `MapCell` from here the same
// way, and neither import exists at runtime.
import type { MetaTileDoc } from './meta-tile'
// Type-only as well: a meta that owns its pixels, and its attachment to a tileset.
import type { OwnedMetaDoc } from './meta-owned'
import type { MetaBinding } from './tile'
import type { ExportBlock } from './resource'


export interface MapLayer {
  name: string
  /** Only tile layers exist; gameplay bits live on the tileset's `flags`. */
  kind: 'tiles'
  /** `width * height` values, row-major. Tile indices, or a flag bitmask per cell. */
  data: number[]
  visible: boolean
  /** Meta-tiles dropped on this layer. Z-order is list order. */
  placements: MetaPlacement[]
  /**
   * An **indexed** layer is made of meta-tiles and nothing else: its
   * placements, which never overlap, are its whole content, and it exports as
   * one byte per meta-tile (`indexedLayerStream`) rather than one per cell.
   * The game expands it into a tile map in RAM (`_Expand`). Its `data` is
   * unused and kept at 0. Written only when true.
   */
  indexed?: boolean
}

/**
 * A meta-tile this map places, mirrored from its own file. See `MapDoc.metas`.
 */
export interface MetaRef {
  /** Project-relative path of the `.meta-tiles.json`. */
  path: string
  /** Its export symbol — what the emitted helper `extern`s. */
  name: string
  width: number
  height: number
  frames: number
  flags: number
  /**
   * True when this meta's tileset nominates colour 0 as transparent, so its
   * cells can be blitted with `VDP_OP_TIMP` and keep a ragged silhouette.
   * Bitmap maps only, and mirrored for the reason everything else here is.
   */
  masked?: boolean
  /**
   * Set for a meta that owns its pixels (`*.meta-tiles.json` version 3): the
   * tile each cell shows in *this map's tileset* — its `MetaBinding.cells`,
   * 0 for a see-through cell. Such a meta has no tile numbers of its own to
   * `extern`, so the map carries these and draws from them.
   *
   * Empty when the meta is not attached to the map's tileset, which
   * `validateMap` refuses to export.
   */
  cells?: number[]
}

/**
 * One meta-tile dropped on a layer.
 *
 * A placement is a **live reference**: the tiles stay in the meta's file, the
 * grid underneath holds tile 0, and the emitted C draws it at runtime — which
 * is what lets an animated meta animate where it stands, and what makes editing
 * the meta update every map that placed it.
 *
 * `baked` is the opposite bargain, for static scenery. Frame 0's tiles are
 * written into the grid as well, so the layer write already draws it and it
 * costs nothing per frame. The record is kept so the editor can re-stamp it
 * when the meta changes, and so the game can still find it.
 */
export interface MetaPlacement {
  /** Index into `MapDoc.metas`. */
  slot: number
  /** Top-left corner, in tiles, on the map's own grid. */
  x: number
  y: number
  baked?: boolean
}

/**
 * The most metas one map may place. `placementBytes` spends bit 7 of the slot
 * byte on `baked`, so a slot is seven bits and a 128th meta would silently
 * alias onto slot 0 with `baked` set. The 256-tile bank underneath could not
 * feed anything near this many anyway.
 */
export const MAX_MAP_METAS = 128

/**
 * What a cell is when the map is drawn over a **screen** read as a grid.
 *
 * This is the older of the two bitmap paths. A `*.btiles.json` tileset carries
 * its own tile size and needs none of this; `cell` exists for maps whose
 * `tileset` still names a `*.screen.json`.
 *
 * There is no name table in those modes, so a cell is not an index the VDP
 * resolves — it is a rectangle of pixels the game copies. The atlas is the
 * screen's converted image read as a plain grid: cell `n` sits at
 * `(n % cols * width, n / cols * height)`. That is deliberately *not* the
 * fragment machinery `ScreenFragment` provides — fragments are named cut-outs
 * of arbitrary size, and a tilemap wants the opposite: anonymous cells that
 * are all the same size, addressed by number.
 */
export interface MapCell {
  width: number
  height: number
  /** Cells per row in the atlas image. A power of two turns the helper's divide into a shift. */
  cols: number
  /**
   * Set when the tileset is a SCREEN 3 one, mirrored here by `setTileset` for
   * the reason `cell` and `meta` are mirrored: the exporter renders one resource
   * at a time and never opens the tileset to ask.
   *
   * It routes the export, not the editors. A 2×2 sc3 tileset is one name-table
   * entry per tile, so its map draws with `VDP_WriteLayout_GM2` exactly as a
   * SCREEN 1/2 map does — 768 bytes for a whole screen, which is what makes
   * SCREEN 3 scroll. Any other sc3 tile size has no name-table shape, so its map
   * blits cells into the shadow buffer instead.
   *
   * `cell` stays set either way, so the map editor keeps rendering from the
   * bitmap-tileset atlas with nothing to change.
   */
  sc3?: boolean
}

export interface MapDoc {
  version: 1
  /**
   * Project-relative path of the tileset this map draws with: `.tiles.json` in
   * a pattern mode, `.btiles.json` in a bitmap one — or a `.screen.json` read
   * as a grid, which is what bitmap maps had to do before bitmap tilesets
   * existed and is kept working for the maps that still point at one.
   */
  tileset: string
  width: number
  height: number
  /** Pixel geometry for a bitmap-mode map; null means the 8×8 name-table cell of SCREEN 1/2/4. */
  cell: MapCell | null
  /**
   * The meta-tiles this map places, mirrored from their own files.
   *
   * Mirrored for the reason `MapCell` is: the exporter renders one resource at
   * a time and never opens another file, so everything the emitted C needs —
   * the symbol to `extern`, the size to advance by, the frame count, the flags
   * a game tests — has to be in the document in front of it.
   *
   * Empty in every map that places none, which is every map written before
   * meta-tiles became objects. Those export exactly what they always did.
   */
  metas: MetaRef[]
  /**
   * The cell index that means "draw nothing", for maps that stack layers.
   *
   * Bitmap-mode only, and null unless the user asks for one — a cell index is
   * an atlas position like any other, so there is no value that can be assumed
   * to mean empty. `0` is a perfectly ordinary cell (demo_msx2's canyon uses it
   * 449 times), which is why this is `number | null` and not a count with 0 as
   * a sentinel.
   *
   * In a pattern mode the name table has no "nothing" either, but the layer is
   * written with one `VDP_WriteLayout_GM2` covering the whole rectangle — there
   * is no per-cell decision to hook, so this stays null there.
   */
  transparent: number | null
  layers: MapLayer[]
  export: ExportBlock | null
}

/** A SCREEN 3 map whose cells are name-table entries, so the VDP draws it rather than the CPU. */
export function isSc3NameTable(doc: MapDoc): boolean {
  return doc.cell?.sc3 === true && doc.cell.width === 2 && doc.cell.height === 2
}

/**
 * Which pattern bank a screen row reads from. SCREEN 2/4 splits its 768
 * patterns into three banks of 256, one per eight rows, so a name-table byte
 * means different art depending on how far down the screen it sits.
 */
export function bankForRow(row: number): number {
  return row >> 3
}

/** One screen's worth of cells — the outline overlay the map editor draws. */
export const SCREEN_COLS = 32
export const SCREEN_ROWS = 24

export function createMapDoc(tileset: string, width = SCREEN_COLS, height = SCREEN_ROWS): MapDoc {
  return normalizeMap({ tileset, width, height })
}

export function normalizeMap(raw: unknown): MapDoc {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<MapDoc>
  const width = Math.max(1, Number(input.width) || SCREEN_COLS)
  const height = Math.max(1, Number(input.height) || SCREEN_ROWS)
  const cells = width * height

  const metas = normalizeMetaRefs(input.metas)
  const rawLayers = Array.isArray(input.layers) && input.layers.length ? input.layers : [{ name: 'background' }]
  const layers: MapLayer[] = rawLayers.map((entry, index) => {
    const layer = (typeof entry === 'object' && entry !== null ? entry : {}) as Partial<MapLayer>
    const data = new Array<number>(cells).fill(0)
    for (let i = 0; i < cells; i++) data[i] = Number(layer.data?.[i]) || 0
    const out: MapLayer = {
      name: String(layer.name ?? `layer_${index}`),
      kind: 'tiles',
      data,
      visible: layer.visible !== false,
      placements: normalizePlacements(layer.placements, width, height, metas.length)
    }
    if (layer.indexed === true) out.indexed = true
    return out
  })


  const cell = normalizeCell(input.cell)
  return {
    version: 1,
    tileset: String(input.tileset ?? ''),
    width,
    height,
    cell,
    transparent: normalizeTransparent(input.transparent, cell),
      metas,
    layers,
    export: input.export ?? null
  }
}

/**
 * The map that rebuilds an imported picture.
 *
 * `packTiles` already returns the tile index per source cell; until this
 * existed every caller destructured that `layout` away, so converting an image
 * to a SCREEN 1/2/4 tileset produced a bank with no record of how to arrange
 * it. `offset` is the pre-existing tile count when the import *appended* to a
 * bank rather than replacing it — the layout counts from the tiles it added.
 *
 * A short `layout` pads with tile 0: `packTiles` breaks out mid-row once the
 * bank hits 256 tiles, and the cells it never reached have no index to give.
 */
export function mapFromLayout(
  tileset: string,
  layout: readonly number[],
  cols: number,
  rows: number,
  offset = 0
): MapDoc {
  return normalizeMap({
    tileset,
    width: cols,
    height: rows,
    layers: [{ name: 'background', data: layout.map((tile) => tile + offset) }]
  })
}

/** The map's size in tiles. Its own grid — a cell is one tile again. */
export function mapTileSize(doc: MapDoc): { width: number; height: number } {
  return { width: doc.width, height: doc.height }
}

/** Empty in every map that places no meta-tiles, which is the default. */
function normalizeMetaRefs(raw: unknown): MetaRef[] {
  if (!Array.isArray(raw)) return []
  const at = (value: unknown, fallback: number): number =>
    Number.isFinite(Number(value)) && Number(value) >= 1 ? Number(value) | 0 : fallback
  return raw.slice(0, MAX_MAP_METAS).map((entry) => {
    const ref = (typeof entry === 'object' && entry !== null ? entry : {}) as Partial<MetaRef>
    const out: MetaRef = {
      path: String(ref.path ?? ''),
      name: String(ref.name ?? 'meta'),
      width: at(ref.width, 1),
      height: at(ref.height, 1),
      frames: at(ref.frames, 1),
      flags: (Number(ref.flags) || 0) & 0xff
    }
    if (ref.masked === true) out.masked = true
    if (Array.isArray(ref.cells)) out.cells = ref.cells.map((tile) => (Number(tile) || 0) & 0xff)
    return out
  })
}

function normalizePlacements(raw: unknown, width: number, height: number, slots: number): MetaPlacement[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry) => {
      const p = (typeof entry === 'object' && entry !== null ? entry : {}) as Partial<MetaPlacement>
      return { slot: Number(p.slot) | 0, x: Number(p.x) | 0, y: Number(p.y) | 0, baked: p.baked === true }
    })
    // A placement whose slot or origin is gone would draw at an arbitrary spot
    // from a table that no longer has that entry.
    .filter((p) => p.slot >= 0 && p.slot < slots && p.x >= 0 && p.y >= 0 && p.x < width && p.y < height)
    // `baked` is written only when true, so a plain placement round-trips as
    // the three keys it actually has.
    .map((p) => (p.baked ? p : { slot: p.slot, x: p.x, y: p.y }))
}

/** A cell index, or null — including for every pattern-mode map, which has no use for one. */
function normalizeTransparent(raw: unknown, cell: MapCell | null): number | null {
  if (!cell || typeof raw !== 'number' || !Number.isFinite(raw)) return null
  const index = raw | 0
  return index >= 0 && index <= 255 ? index : null
}

/** Absent in every map written before bitmap modes were supported, so default to the name table. */
function normalizeCell(raw: unknown): MapCell | null {
  if (typeof raw !== 'object' || raw === null) return null
  const cell = raw as Partial<MapCell>
  const at = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 1 ? value | 0 : fallback
  return {
    width: at(cell.width, 16),
    height: at(cell.height, 16),
    cols: at(cell.cols, 16),
    // Round-trips, or reopening a SCREEN 3 map would silently export it as a
    // V9938 one — which compiles, and draws nothing.
    ...(cell.sc3 === true ? { sc3: true } : {})
  }
}

export function cellIndex(doc: MapDoc, x: number, y: number): number {
  return y * doc.width + x
}

export function getCell(layer: MapLayer, doc: MapDoc, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return 0
  return layer.data[cellIndex(doc, x, y)] ?? 0
}

/**
 * Resizes the grid, keeping the cells that still fit (top-left anchored).
 * Growing fills with 0.
 */
export function resizeMap(doc: MapDoc, width: number, height: number): MapDoc {
  const layers = doc.layers.map((layer) => {
    const data = new Array<number>(width * height).fill(0)
    for (let y = 0; y < Math.min(height, doc.height); y++) {
      for (let x = 0; x < Math.min(width, doc.width); x++) data[y * width + x] = layer.data[y * doc.width + x] ?? 0
    }
    // A placement whose origin fell off the new grid has nowhere to be, and
    // `normalizePlacements` would drop it on the next load anyway — better to
    // agree with that now than to save a file that changes when reopened.
    return { ...layer, data, placements: layer.placements.filter((p) => p.x < width && p.y < height) }
  })
  return { ...doc, width, height, layers }
}

/**
 * Applies a tileset reorder (`reorderTiles`' mapping) to every tile layer —
 * what Spec 10 replays after a Spec 08 drag-reorder so maps look unchanged.
 */
export function remapTiles(doc: MapDoc, mapping: readonly number[]): MapDoc {
  const layers = doc.layers.map((layer) =>
    layer.kind === 'tiles' ? { ...layer, data: layer.data.map((value) => mapping[value] ?? value) } : layer
  )
  return { ...doc, layers }
}

export function validateMap(doc: MapDoc, options: { banked?: boolean } = {}): string[] {
  const problems: string[] = []
  if (doc.version !== 1) problems.push(`Unsupported version ${doc.version}`)
  if (!doc.tileset) problems.push('No tileset referenced')
  if (!doc.layers.length) problems.push('Map has no layers')
  // HMMM addresses whole bytes, and every bitmap mode packs at least two dots
  // into one, so an odd cell width cannot be copied at all.
  if (doc.cell && doc.cell.width % 2 !== 0) {
    problems.push(`Cell width ${doc.cell.width} is odd — VDP copies whole bytes, so it must be even (4 in SCREEN 6)`)
  }
  if (doc.cell && doc.cell.cols * doc.cell.width > 512) {
    problems.push(`Atlas would be ${doc.cell.cols * doc.cell.width} dots wide — wider than VRAM allows`)
  }
  // Nothing is wrong with the data — but `_DrawRow` blits every cell, so a
  // second layer drawn with it paints its empty cells rather than leaving them,
  // and the only sign is a screen that looks wrong. Say so where the map is.
  if (doc.cell && doc.layers.length > 1 && doc.transparent === null) {
    problems.push(
      `${doc.layers.length} layers but no transparent cell — a layer drawn over another needs one, or its empty cells blit cell 0`
    )
  }
  // SCREEN 3 has no command engine, so a bitmap-shaped sc3 map has no way to
  // blit a placement. Its 2×2 form does — that map draws through the name
  // table like any SCREEN 1/2 map — so only the other tile sizes are refused.
  // Blocking the export is the honest failure: the alternative is a header full
  // of VDP_CommandHMMM that compiles, links, and does nothing on an MSX1.
  if (doc.cell?.sc3 && !isSc3NameTable(doc) && placementCount(doc)) {
    problems.push(
      'Meta-tiles cannot be placed on this SCREEN 3 map — it blits its cells, and an MSX1 has no ' +
        'command engine. Use a 2×2 tileset so the map draws through the name table instead.'
    )
  }

  // Banks are chosen by screen row, so a wide map scrolls horizontally without
  // trouble — but row 24 has no bank, and exporting one would put art in the
  // wrong third with nothing to show for it but a wrong picture.
  if (options.banked && doc.height !== SCREEN_ROWS) {
    problems.push(
      `A banked tileset needs a map exactly ${SCREEN_ROWS} rows tall — this one is ${doc.height}. ` +
        'Width is free: banks are picked by row, so horizontal scrolling is fine.'
    )
  }

  // A meta that owns its pixels is drawn from the tiles its attachment to this
  // map's tileset gives it. Without one there is nothing to draw with, and the
  // only other outcome is a table of zeros that draws nothing at runtime.
  for (const ref of doc.metas) {
    // On a pattern map every meta owns its pixels and is drawn with its
    // attachment's tiles; a bitmap map's metas carry their own tables instead.
    if (!doc.cell && (!ref.cells || ref.cells.length !== ref.width * ref.height)) {
      problems.push(`"${ref.name}" (${ref.path}) is not attached to ${doc.tileset || 'this map\'s tileset'} — attach it in the tile editor, or place it again from the map editor`)
    }
  }

  problems.push(...indexedLayerProblems(doc))

  // A placement's *origin* is inside the grid — `placeMeta` and
  // `normalizePlacements` both enforce that — but its far edge need not be, and
  // a meta hanging off the right of the map writes into the next row of the
  // name table at runtime. Warned rather than clamped: cropping someone's tree
  // silently is worse than telling them half of it is off the level.
  for (const layer of doc.layers) {
    for (const placement of layer.placements) {
      const ref = doc.metas[placement.slot]
      if (!ref) continue
      if (placement.x + ref.width > doc.width || placement.y + ref.height > doc.height) {
        problems.push(
          `"${ref.name}" at ${placement.x},${placement.y} on layer "${layer.name}" extends past the map`
        )
      }
    }
  }

  const cells = doc.width * doc.height
  doc.layers.forEach((layer) => {
    if (layer.data.length !== cells) {
      problems.push(`Layer "${layer.name}": ${layer.data.length} cells, expected ${cells}`)
    }
    if (layer.kind === 'tiles' && layer.data.some((value) => value < 0 || value > 255)) {
      problems.push(`Layer "${layer.name}": tile index outside 0..255`)
    }
  })
  return problems

}

/** One layer as raw bytes — the name table (or flag table) MSXgl reads. */
export function mapLayerBytes(layer: MapLayer): Uint8Array {
  return Uint8Array.from(layer.data, (value) => value & 0xff)
}

/**
 * What this map's layers export as. A name table is mostly runs of the same
 * tile, so RLEp usually cuts it to a fraction — but a busy layer can pack
 * *larger* than it started (a header per 64 literal bytes), and shipping that
 * would be worse than shipping nothing.
 *
 * All or nothing across the layers, deliberately: one `_DrawLayer()` serves
 * every layer, so it cannot unpack some of them and not others. One layer that
 * doesn't shrink therefore costs the whole map its compression — which is the
 * safe way round, since the alternative is a helper that is wrong for one of
 * the tables sitting next to it.
 *
 * This is the single decision point. `compressed` is what the helper C reads,
 * `unpacked` what the `_UNPACKED_SIZE` define reads; neither recomputes it.
 */
export function mapExport(
  doc: MapDoc,
  compress: ExportBlock['compress']
): { compressed: boolean; layers: { bytes: Uint8Array; unpacked?: number; indexed?: true }[] } {
  // An indexed layer is its stream, raw whatever is asked: `_Expand` reads it
  // byte by byte, and it is a byte per meta-tile already. The all-or-nothing
  // rule is about the layers one `_DrawLayer()` serves, which it is not.
  const raw = doc.layers.map((layer) => (layer.indexed ? indexedLayerStream(doc, layer) : mapLayerBytes(layer)))
  const plain = (bytes: Uint8Array, index: number): { bytes: Uint8Array; indexed?: true } =>
    doc.layers[index].indexed ? { bytes, indexed: true } : { bytes }
  const uncompressed = { compressed: false, layers: raw.map(plain) }
  const tileLayers = raw.filter((_, index) => !doc.layers[index].indexed)
  if (compress !== 'rlep' || !tileLayers.length) return uncompressed
  const packed = raw.map((bytes, index) => (doc.layers[index].indexed ? bytes : packRlep(bytes)))
  if (!packed.every((bytes, index) => doc.layers[index].indexed || bytes.length < raw[index].length)) return uncompressed
  return {
    compressed: true,
    layers: packed.map((bytes, index) => (doc.layers[index].indexed ? plain(bytes, index) : { bytes, unpacked: raw[index].length }))
  }
}

/**
 * The opt-in ready-made C: draw a layer into the name table. Compressed layers
 * unpack into a caller-supplied buffer first — `RLEp_UnpackToRAM` is MSXgl's
 * own, from the `compress` module.
 */
export function mapHelperC(doc: MapDoc, name: string, compressed: boolean, table: string): HelperC {
  // A SCREEN 3 map over 2×2 tiles is a name-table map: one tile is one name
  // entry, and `VDP_WriteLayout_GM2` is address arithmetic over the layout base,
  // which `VDP_SetModeMultiColor` sets correctly. So it takes the path below,
  // unchanged — the same call, the same bytes, at a quarter of the cost of
  // blitting. Larger sc3 tiles have no name-table shape and blit.
  if (doc.cell && !isSc3NameTable(doc)) return bitmapMapHelperC(doc, name, compressed, table)
  const prefix = defineName(name)
  const sc3 = isSc3NameTable(doc)
  const head = [
    '',
    `// Draws one layer of ${name} into the name table at tile column/row (x, y).`,
    ...(sc3
      ? [
          '// SCREEN 3: each cell is one name-table entry — 2×2 blocks, 8×8 dots — so',
          '// a whole screen is 768 bytes and a scroll edge is a couple of dozen.',
          `// Upload the tileset's patterns first (its _Upload()), and set the mode`,
          '// with VDP_SetMode(VDP_MODE_SCREEN3) — *not* the framebuffer _InitScreen(),',
          '// whose boilerplate name table is what this one replaces.',
          '// Needs VDP_USE_MODE_MC TRUE, and VDP_USE_MODE_G2 TRUE as well: that is',
          '// what compiles VDP_WriteLayout_GM2, which is mode-agnostic in body.'
        ]
      : [
          '// Needs MSXgl\'s VDP module (#include "msxgl.h" before this header) built',
          '// with VDP_USE_MODE_G2 or VDP_USE_MODE_G3.'
        ])
  ]
  if (!compressed) {
    const signature = `void ${name}_DrawLayer(const u8* layer, u8 x, u8 y)`
    return {
      header: [
      ...head,
      '//',
      '// Example:',
      `//   ${name}_DrawLayer(${table}, 0, 0);`,
      `${signature};`
      ],
      source: ['', signature, '{', `\tVDP_WriteLayout_GM2(layer, x, y, ${prefix}_W, ${prefix}_H);`, '}']
    }
  }
  const signature = `void ${name}_DrawLayer(const u8* layer, u8* buffer, u8 x, u8 y)`
  return {
    header: [
    ...head,
    '// The layers are RLEp-compressed, so this also needs the "compress" library',
    '// module and COMPRESS_USE_RLEP TRUE / COMPRESS_USE_RLEP_DEFAULT TRUE in',
    '// msxgl_config.h (the values MSXgl\'s project template ships with).',
    '//',
    `// \`buffer\` must hold ..._UNPACKED_SIZE bytes (${doc.width * doc.height} here); one`,
    '// scratch buffer can serve every layer, since it is emptied into VRAM at once.',
    '//',
    '// Example:',
    `//   u8 buffer[${defineName(table)}_UNPACKED_SIZE];`,
    `//   ${name}_DrawLayer(${table}, buffer, 0, 0);`,
    `${signature};`
    ],
    source: [
      '',
      signature,
      '{',
      '\tRLEp_UnpackToRAM(layer, buffer);',
      `\tVDP_WriteLayout_GM2(buffer, x, y, ${prefix}_W, ${prefix}_H);`,
      '}'
    ]
  }
}

/**
 * The bitmap-mode counterpart: a row of cells copied out of an atlas already
 * sitting in VRAM, one `HMMM` per cell.
 *
 * A row at a time rather than a whole layer, because that is the unit a
 * scrolling game actually draws — SCREEN 5's page is 256 lines tall against
 * 212 displayed, so a vertical scroller fills the hidden lines one row ahead
 * of the display and never redraws anything else.
 *
 * Coordinates are `UX`/`UY`, MSXgl's own aliases for whatever `VDP_UNIT` was
 * configured as, so the atlas can sit in a VRAM page the screen never shows
 * (which needs `VDP_UNIT_U16` — a `u8` Y cannot name a row past 255).
 */
function bitmapMapHelperC(doc: MapDoc, name: string, compressed: boolean, table: string): HelperC {
  const prefix = defineName(name)
  const cell = doc.cell!
  if (cell.sc3) return sc3MapHelperC(doc, name, compressed, table)
  const overlay = bitmapOverlayC(doc, name, prefix)
  const signature = `void ${name}_DrawRow(const u8* layer, u8 row, UY atlasY, UY destY)`
  return {
    header: [
    '',
    `// ── ${name}: a tilemap in a bitmap mode ───────────────────────────────`,
    '//',
    `// Draws map row \`row\` as ${doc.width} cells of ${cell.width}×${cell.height} dots, starting at`,
    '// dot column 0 of VRAM row `destY`. Cells come from an atlas image parked',
    '// at (0, `atlasY`) in VRAM — upload it once with a single HMMC:',
    '//',
    `//   VDP_CommandHMMC(g_Atlas, 0, atlasY, ATLAS_W, ATLAS_H);`,
    '//',
    `// Cell n is the atlas's nth ${cell.width}×${cell.height} block, read left to right and top to`,
    `// bottom, ${cell.cols} to a row. There is no name table in these modes, so this`,
    '// copies pixels: the map is the same bytes it always was, but a cell is a',
    '// rectangle rather than an index the VDP resolves for you.',
    '//',
    '// A vertical scroller calls this for the one row about to scroll into the',
    '// hidden lines below the display, and leaves the rest alone. Mask `destY`',
    '// yourself if you want it to wrap inside a page — the VDP addresses all of',
    '// VRAM as one tall column, so 256 is the next page, not row 0 again.',
    '//',
    '// Needs MSXgl\'s VDP command engine: MSX2 or later with VDP_USE_COMMAND,',
    '// and "msxgl.h" included before this header.',
    ...(compressed
      ? [
          '//',
          `// The layers are RLEp-packed, so \`layer\` must be a RAM buffer of`,
          `// ..._UNPACKED_SIZE bytes you filled with RLEp_UnpackToRAM first — this`,
          '// reads rows in any order and cannot unpack per call.'
        ]
      : []),
    '//',
    '// Example:',
    `//   ${name}_DrawRow(${table}, row, ATLAS_Y, (u8)(row * ${cell.height}));`,
    `${signature};`,
    ...overlay.header
    ],
    source: [
    '',
    signature,
    '{',
    `\tconst u8* src = layer + ((u16)row * ${prefix}_W);`,
    '\tu16 dx = 0;',
    `\tu8 col = ${prefix}_W;`,
    '\twhile(col--)',
    '\t{',
    '\t\tu8 cell = *src++;',
    // cols is a literal, so a power-of-two atlas costs a shift and a mask here
    // rather than SDCC's division routine.
    `\t\tVDP_CommandHMMM((u16)(cell % ${prefix}_ATLAS_COLS) * ${prefix}_CELL_W,`,
    `\t\t                atlasY + ((cell / ${prefix}_ATLAS_COLS) * ${prefix}_CELL_H),`,
    `\t\t                dx, destY, ${prefix}_CELL_W, ${prefix}_CELL_H);`,
    `\t\tdx += ${prefix}_CELL_W;`,
    '\t}',
    '}',
    ...overlay.source
    ]
  }
}

/**
 * A SCREEN 3 map whose cells are bigger than a name-table entry, so the CPU
 * draws them: a row of tiles blitted into the shadow buffer the screen
 * resource flushes.
 *
 * `tiles` is a parameter rather than a symbol this file names, for the same
 * reason `_DrawView` takes `metas`: the tileset is a different resource in a
 * different header, and the exporter renders one at a time. Pass the tileset's
 * `_Tiles` table.
 *
 * A row at a time, because that is the unit a scrolling playfield redraws — and
 * because the whole point of the dirty-strip flush is not touching the rest.
 */
function sc3MapHelperC(doc: MapDoc, name: string, compressed: boolean, table: string): HelperC {
  const prefix = defineName(name)
  const cell = doc.cell!
  const rowBytes = Math.ceil(cell.width / 2)
  const signature = `void ${name}_DrawRow(u8* buf, const u8* tiles, const u8* layer, u8 row, u8 x, u8 y)`
  return {
    header: [
      '',
      `// ── ${name}: a SCREEN 3 tilemap, blitted ──────────────────────────────`,
      '//',
      `// Draws map row \`row\` as ${doc.width} cells of ${cell.width}×${cell.height} blocks into \`buf\`, the`,
      '// shadow buffer, starting at block (x, y). Nothing reaches the screen until',
      `// the screen resource's _Flush(); this only marks nothing, so call its`,
      `// _Mark(x, y, ${doc.width * cell.width}, ${cell.height}) after, or _FlushAll for a whole redraw.`,
      '//',
      '// `x` must be even: two blocks share a VRAM byte and this copies bytes.',
      '//',
      `// The tiles are ${cell.width}×${cell.height} blocks, which is more than one name-table entry`,
      '// holds — a 2×2 tileset would export a real `_DrawLayer` instead and let the',
      '// VDP do this, at a quarter of the cost. Worth knowing if this map scrolls.',
      ...(compressed
        ? [
            '//',
            '// The layers are RLEp-packed, so `layer` must be a RAM buffer of',
            '// ..._UNPACKED_SIZE bytes you filled with RLEp_UnpackToRAM first — this',
            '// reads rows in any order and cannot unpack per call.'
          ]
        : []),
      '//',
      '// Example:',
      `//   for(u8 r = 0; r < ${prefix}_H; ++r)`,
      `//     ${name}_DrawRow(g_Screen, g_Tiles_Tiles, ${table}, r, 0, r * ${cell.height});`,
      `${signature};`
    ],
    source: [
      '',
      `static u16 ${name}_Offset(u8 x, u8 y)`,
      '{',
      '\treturn ((u16)(y & 0xF8) << 5) | ((u16)(x >> 1) << 3) | (y & 7);',
      '}',
      '',
      signature,
      '{',
      `\tconst u8* src = layer + ((u16)row * ${prefix}_W);`,
      `\tu8 col = ${prefix}_W;`,
      '\twhile(col--)',
      '\t{',
      `\t\tconst u8* t = tiles + ((u16)(*src++) * ${rowBytes * cell.height});`,
      '\t\tu8 r, c;',
      `\t\tfor(r = 0; r < ${cell.height}; ++r)`,
      '\t\t{',
      `\t\t\tu16 d = ${name}_Offset(x, y + r);`,
      `\t\t\tfor(c = 0; c < ${rowBytes}; ++c)`,
      '\t\t\t\tbuf[d + ((u16)c << 3)] = *t++;',
      '\t\t}',
      `\t\tx += ${cell.width};`,
      '\t}',
      '}'
    ]
  }
}

/**
 * The overlay counterpart of `_DrawRow`: same walk, but a cell equal to
 * `transparent` is skipped so whatever is underneath shows through. The
 * background layer wants every cell drawn, including that index.
 *
 * Two functions rather than one with a flag: the background row is the one that
 * runs on every scroll step, and it should not pay a compare per cell for a
 * decision it never makes. Skipping drops the *blit*, never the column, so the
 * two walk the row in step.
 */
function bitmapOverlayC(doc: MapDoc, name: string, prefix: string): HelperC {
  if (doc.transparent === null) return { header: [], source: [] }
  const signature = `void ${name}_DrawRowOver(const u8* layer, u8 row, UY atlasY, UY destY)`
  return {
    header: [
    '',
    `// Same, for a layer drawn *over* one already on screen: cell`,
    `// ${prefix}_TRANSPARENT (${doc.transparent}) is skipped instead of blitted, so`,
    '// whatever is underneath shows through. Draw the background row first.',
    `${signature};`
    ],
    source: [
    '',
    signature,
    '{',
    `\tconst u8* src = layer + ((u16)row * ${prefix}_W);`,
    '\tu16 dx = 0;',
    `\tu8 col = ${prefix}_W;`,
    '\twhile(col--)',
    '\t{',
    '\t\tu8 cell = *src++;',
    `\t\tif(cell != ${prefix}_TRANSPARENT)`,
    `\t\t\tVDP_CommandHMMM((u16)(cell % ${prefix}_ATLAS_COLS) * ${prefix}_CELL_W,`,
    `\t\t\t                atlasY + ((cell / ${prefix}_ATLAS_COLS) * ${prefix}_CELL_H),`,
    `\t\t\t                dx, destY, ${prefix}_CELL_W, ${prefix}_CELL_H);`,
    `\t\tdx += ${prefix}_CELL_W;`,
    '\t}',
    '}'
    ]
  }
}

// ── indexed layers ──────────────────────────────────────────────────────────

/** True for a layer made of meta-tiles only, exported as one byte each. */
export function isIndexedLayer(layer: MapLayer | undefined): boolean {
  return layer?.indexed === true
}

/** Whether any layer is indexed — what decides the expander and its tables. */
export function hasIndexedLayers(doc: MapDoc): boolean {
  return doc.layers.some((layer) => layer.indexed)
}

/**
 * Makes a layer indexed, or ordinary again.
 *
 * On: the grid is cleared — an indexed layer is its meta-tiles — and baked
 * placements become live, since baking is writing into the grid it no longer
 * has. Off: lossless; the meta-tiles stay as live placements over an empty
 * grid.
 */
export function setLayerIndexed(doc: MapDoc, layerIndex: number, on: boolean): MapDoc {
  const layer = doc.layers[layerIndex]
  if (!layer || isIndexedLayer(layer) === on) return doc
  const layers = doc.layers.slice()
  if (on) {
    layers[layerIndex] = {
      ...layer,
      indexed: true,
      data: new Array<number>(layer.data.length).fill(0),
      placements: layer.placements.map((p) => ({ slot: p.slot, x: p.x, y: p.y }))
    }
  } else {
    const { indexed: _indexed, ...plain } = layer
    void _indexed
    layers[layerIndex] = plain
  }
  return { ...doc, layers }
}

/** A placement on an indexed layer, with what its encoding needs to know. */
interface Stacked {
  placement: MetaPlacement
  ref: MetaRef
  /** Its place in the layer's list, which is its place in the stack: later is on top. */
  z: number
  /** The map cells it writes — every cell of its rectangle but the see-through ones. */
  opaque: Set<number>
}

/**
 * How an indexed layer is encoded: which meta-tiles go in the one-byte stream,
 * and which need a record of their own after it.
 *
 * The stream walks the cells in reading order and, at each cell no earlier meta
 * covers, names the meta that starts there — or 0, for an empty cell. That is a
 * byte a meta, and it draws them in the reading order of their top-left
 * corners. Two things it cannot say: a meta that starts *inside* another's
 * rectangle (the walk skips that cell), and a stacking order that disagrees
 * with reading order where two metas really overlap. Those metas are
 * **overlays**: a record each after the stream (slot + 1, x, y), drawn after it,
 * in the order they were placed. So meta-tiles may overlap freely and still
 * stack exactly as the editor shows them.
 *
 * Only opaque overlaps count. Where one of the two is see-through, the order
 * they are drawn in changes nothing — so the common cases stay a byte a meta:
 * metas side by side, or one tucked into another's see-through corner.
 *
 * Found by moving metas to the overlays until nothing contradicts. Overlays only
 * ever grow, so it ends, and what it ends on is always right — if not always
 * the smallest encoding there is.
 */
export function indexedLayerPlan(doc: MapDoc, layer: MapLayer): { stream: MetaPlacement[]; overlays: MetaPlacement[] } {
  const width = doc.width
  const stacked: Stacked[] = []
  layer.placements.forEach((placement, z) => {
    const ref = doc.metas[placement.slot]
    if (!ref) return
    const opaque = new Set<number>()
    for (let r = 0; r < ref.height; r++) {
      for (let c = 0; c < ref.width; c++) {
        const x = placement.x + c
        const y = placement.y + r
        if (x >= width || y >= doc.height) continue
        if ((ref.cells?.[r * ref.width + c] ?? 1) !== 0) opaque.add(y * width + x)
      }
    }
    stacked.push({ placement, ref, z, opaque })
  })
  // The pairs whose drawing order shows: they share an opaque cell. Lower first.
  const conflicts: [Stacked, Stacked][] = []
  for (let i = 0; i < stacked.length; i++) {
    for (let j = i + 1; j < stacked.length; j++) {
      const [lower, upper] = [stacked[i], stacked[j]]
      for (const cell of lower.opaque) {
        if (!upper.opaque.has(cell)) continue
        conflicts.push([lower, upper])
        break
      }
    }
  }

  const overlay = new Set<Stacked>()
  for (;;) {
    // Which metas the stream can name, walking it as the decoder will.
    const starts = new Map<number, Stacked[]>()
    for (const entry of stacked) {
      if (overlay.has(entry)) continue
      const at = entry.placement.y * width + entry.placement.x
      starts.set(at, [...(starts.get(at) ?? []), entry])
    }
    const rank = new Map<Stacked, number>()
    const cover = new Array<number>(width).fill(0)
    let moved = false
    for (let y = 0; y < doc.height; y++) {
      for (let x = 0; x < width; x++) {
        const here = starts.get(y * width + x) ?? []
        if (cover[x]) {
          // Starts inside another meta's rectangle: the walk never stops here.
          for (const entry of here) overlay.add(entry)
          moved ||= here.length > 0
          continue
        }
        if (!here.length) continue
        const [first, ...rest] = here
        for (const entry of rest) overlay.add(entry)
        moved ||= rest.length > 0
        rank.set(first, rank.size)
        for (let c = 0; c < first.ref.width && x + c < width; c++) cover[x + c] = Math.max(cover[x + c], first.ref.height)
      }
      for (let x = 0; x < width; x++) if (cover[x]) cover[x]--
    }
    if (moved) continue
    // Then the stack: an upper meta drawn before a lower one it overlaps moves
    // to the overlays, which are drawn after the stream, in placing order.
    const drawn = (entry: Stacked): number => rank.get(entry) ?? rank.size + entry.z
    for (const [lower, upper] of conflicts) {
      if (drawn(upper) > drawn(lower)) continue
      overlay.add(upper)
      moved = true
    }
    if (moved) continue
    return {
      stream: [...rank.keys()].map((entry) => entry.placement),
      overlays: stacked.filter((entry) => overlay.has(entry)).map((entry) => entry.placement)
    }
  }
}

/** Bytes an overlay's x and y take: one each, or two (low first) on a map wider or taller than 256 tiles. */
function coordinateBytes(doc: MapDoc): { x: number; y: number } {
  return { x: doc.width > 256 ? 2 : 1, y: doc.height > 256 ? 2 : 1 }
}

/**
 * An indexed layer as the game reads it, in two parts:
 *
 * - **the stream**, one byte per meta-tile, any mix of sizes: walking the cells
 *   in reading order, at each cell no earlier meta covers, the slot + 1 of the
 *   meta whose top-left is there — or 0, an empty 1×1 cell. Unambiguous because
 *   a meta's top-left is the first of its cells the walk meets, so the decoder
 *   always meets it before any cell it covers, and knows to skip those;
 * - **the overlays**, the meta-tiles the stream cannot carry (`indexedLayerPlan`):
 *   slot + 1, x, y each, ended by a 0.
 *
 * Runs of 0 are what RLEp packs best, though this table ships raw: the expander
 * reads it byte by byte.
 */
export function indexedLayerStream(doc: MapDoc, layer: MapLayer): Uint8Array {
  const width = doc.width
  const { stream, overlays } = indexedLayerPlan(doc, layer)
  const origin = new Map<number, MetaPlacement>()
  for (const placement of stream) origin.set(placement.y * width + placement.x, placement)
  const out: number[] = []
  const cover = new Array<number>(width).fill(0)
  for (let y = 0; y < doc.height; y++) {
    for (let x = 0; x < width; x++) {
      if (cover[x]) continue
      const placement = origin.get(y * width + x)
      const ref = placement && doc.metas[placement.slot]
      if (!placement || !ref) {
        out.push(0)
        continue
      }
      out.push(placement.slot + 1)
      for (let c = 0; c < ref.width && x + c < width; c++) cover[x + c] = Math.max(cover[x + c], ref.height)
    }
    for (let x = 0; x < width; x++) if (cover[x]) cover[x]--
  }
  const bytes = coordinateBytes(doc)
  const word = (value: number, size: number): number[] => (size === 2 ? [value & 0xff, (value >> 8) & 0xff] : [value & 0xff])
  for (const placement of overlays) out.push(placement.slot + 1, ...word(placement.x, bytes.x), ...word(placement.y, bytes.y))
  out.push(0)
  return Uint8Array.from(out)
}

/**
 * The stream read back into placements, in the order they are drawn — the
 * proof the encoding loses nothing. Walks it exactly as the generated
 * `_Expand` does: a counter per column says how many more rows an earlier meta
 * covers it for; then the overlays, until a 0.
 */
export function decodeIndexedStream(doc: MapDoc, stream: ArrayLike<number>): MetaPlacement[] {
  const placements: MetaPlacement[] = []
  const cover = new Array<number>(doc.width).fill(0)
  let read = 0
  for (let y = 0; y < doc.height; y++) {
    for (let x = 0; x < doc.width; x++) {
      if (cover[x]) continue
      const m = stream[read++] ?? 0
      const ref = m ? doc.metas[m - 1] : undefined
      if (!ref) continue
      placements.push({ slot: m - 1, x, y })
      for (let c = 0; c < ref.width && x + c < doc.width; c++) cover[x + c] = Math.max(cover[x + c], ref.height)
    }
    for (let x = 0; x < doc.width; x++) if (cover[x]) cover[x]--
  }
  const bytes = coordinateBytes(doc)
  const take = (size: number): number => {
    const low = stream[read++] ?? 0
    return size === 2 ? low | ((stream[read++] ?? 0) << 8) : low
  }
  for (;;) {
    const m = stream[read++] ?? 0
    if (!m) break
    const x = take(bytes.x)
    const y = take(bytes.y)
    if (doc.metas[m - 1]) placements.push({ slot: m - 1, x, y })
  }
  return placements
}

/**
 * What `_Expand` leaves in RAM: the layer's meta-tiles written into `under`
 * (another layer's tiles, or zeros), in the order they are drawn, and which
 * slot + 1 drew each cell last. See-through cells and empty ones keep what was
 * under them. Pure, and the same walk as the C — what the tests hold the
 * generated code to.
 */
export function expandIndexedLayer(
  doc: MapDoc,
  layer: MapLayer,
  under: readonly number[] = new Array<number>(doc.width * doc.height).fill(0)
): { tiles: number[]; objects: number[] } {
  const tiles = under.slice()
  const objects = new Array<number>(doc.width * doc.height).fill(0)
  for (const placement of decodeIndexedStream(doc, indexedLayerStream(doc, layer))) {
    const ref = doc.metas[placement.slot]
    const cells = ref?.cells ?? []
    for (let r = 0; r < ref.height; r++) {
      for (let c = 0; c < ref.width; c++) {
        const tile = cells[r * ref.width + c] ?? 0
        if (!tile) continue
        const at = (placement.y + r) * doc.width + placement.x + c
        tiles[at] = tile
        objects[at] = placement.slot + 1
      }
    }
  }
  return { tiles, objects }
}

/**
 * What would make an indexed layer expand to something other than what the
 * editor shows — or not expand at all.
 */
function indexedLayerProblems(doc: MapDoc): string[] {
  const problems: string[] = []
  doc.layers.forEach((layer) => {
    if (!layer.indexed) return
    const label = `Layer "${layer.name}"`
    if (doc.cell) {
      problems.push(`${label} is indexed, which needs a map drawn through the name table with a pattern tileset`)
      return
    }
    for (const placement of layer.placements) {
      const ref = doc.metas[placement.slot]
      if (ref && placement.baked) {
        problems.push(`${label}: "${ref.name}" at ${placement.x},${placement.y} is baked, and an indexed layer has no grid to bake into`)
      }
    }
  })
  return problems
}

/**
 * Each slot's tiles, end to end, as the expander reads them — and where each
 * slot starts, two bytes a slot, low first.
 */
export function metaCellTables(doc: MapDoc): { cells: Uint8Array; at: Uint8Array } {
  const cells: number[] = []
  const at: number[] = []
  for (const ref of doc.metas) {
    at.push(cells.length & 0xff, (cells.length >> 8) & 0xff)
    if (ref.cells) cells.push(...ref.cells)
  }
  // An empty table is not valid C; a map with no cells to expand has one byte.
  return { cells: Uint8Array.from(cells.length ? cells : [0]), at: Uint8Array.from(at) }
}

/**
 * The ready-made C that expands an indexed layer into a tile map in RAM — the
 * runtime half of `indexedLayerStream`, walking it as `decodeIndexedStream`
 * does. The expanded map is what the game already keeps for a level it can
 * change (`demo_msx1`'s `g_Map`): drawn with the same layout write, read for
 * collision, rewritten when something is taken.
 *
 * Animated meta-tiles need nothing here: their moving cells are window tiles,
 * so expanding them writes window numbers, and the tileset's `_Animate()` moves
 * every copy — on screen or scrolled in later.
 */
export function indexedLayerHelperC(doc: MapDoc, name: string): HelperC {
  if (!hasIndexedLayers(doc) || doc.cell) return { header: [], source: [] }
  const prefix = defineName(name)
  const first = doc.layers.find((layer) => layer.indexed)!
  const xType = doc.width > 255 ? 'u16' : 'u8'
  const yType = doc.height > 255 ? 'u16' : 'u8'
  const bytes = coordinateBytes(doc)
  const coordinate = (axis: 'x' | 'y', size: number, type: string): string[] =>
    size === 2
      ? [`\t\t${type} ${axis} = *layer++;`, `\t\t${axis} |= (u16)(*layer++) << 8;`]
      : [`\t\t${type} ${axis} = *layer++;`]
  const signature = `void ${name}_Expand(const u8* layer, u8* tiles, u8* objects)`
  return {
    header: [
      '',
      `// ── ${name}: indexed layers ───────────────────────────────────────────`,
      '//',
      '// Expands an indexed layer — one byte per meta-tile — into a tile map in',
      `// RAM: ${prefix}_W * ${prefix}_H bytes, row-major, which VDP_WriteLayout_GM2 draws as it is.`,
      '//',
      '// Only the cells a meta-tile draws are written. See-through cells and empty',
      '// ones keep what `tiles` held, so expanding a layer over another one',
      '// composes them: expand the lower layer first, into the same buffer.',
      '// Meta-tiles that overlap stack as they were placed in the editor.',
      '//',
      '// `objects`, unless NULL, gets the slot + 1 of the meta-tile that drew each',
      `// cell — ${prefix}_META_<NAME> + 1 — for collision against the object`,
      `// rather than its tiles: ${name}_MetaInfo[(objects[i] - 1) * 3 + 2] is its flags.`,
      '//',
      '// RAM is not cleared at boot on a ROM target: fill `tiles` (and zero',
      '// `objects`) before the first expand, or the cells no meta covers are',
      '// whatever the machine powered up with.',
      '//',
      '// Example:',
      `//   u8 map[${prefix}_W * ${prefix}_H];`,
      `//   for(u16 i = 0; i < sizeof(map); ++i) map[i] = 0;`,
      `//   ${name}_Expand(${name}_${pascalName(first.name)}, map, NULL);`,
      `//   VDP_WriteLayout_GM2(map, 0, 0, ${prefix}_W, ${prefix}_H);`,
      `${signature};`
    ],
    source: [
      '',
      `// Writes meta \`m\` (0-based) with its top-left at offset \`dst\`, skipping see-through cells.`,
      `static void ${name}_Stamp(u8 m, u16 dst, u8* tiles, u8* objects)`,
      '{',
      `\tconst u8* info = ${name}_MetaInfo + (u16)m * 3;`,
      '\tconst u8 w = info[0];',
      '\tconst u8 h = info[1];',
      `\tconst u8* src = ${name}_MetaCells + (${name}_MetaCellsAt[m * 2] | ((u16)${name}_MetaCellsAt[m * 2 + 1] << 8));`,
      '\tfor(u8 r = 0; r < h; ++r)',
      '\t{',
      '\t\tfor(u8 c = 0; c < w; ++c)',
      '\t\t{',
      '\t\t\tconst u8 t = src[c];',
      '\t\t\tif(!t) continue;',
      '\t\t\ttiles[dst + c] = t;',
      '\t\t\tif(objects) objects[dst + c] = m + 1;',
      '\t\t}',
      '\t\tsrc += w;',
      `\t\tdst += ${prefix}_W;`,
      '\t}',
      '}',
      '',
      signature,
      '{',
      `\t// Per column: how many more rows an earlier meta-tile covers it for.`,
      `\tu8 cover[${prefix}_W];`,
      `\tfor(${xType} x = 0; x < ${prefix}_W; ++x) cover[x] = 0;`,
      '\tu16 row = 0;',
      `\tfor(${yType} y = 0; y < ${prefix}_H; ++y)`,
      '\t{',
      `\t\tfor(${xType} x = 0; x < ${prefix}_W; ++x)`,
      '\t\t{',
      '\t\t\tif(cover[x]) continue;',
      '\t\t\tu8 m = *layer++;',
      `\t\t\tif(m == 0 || m > ${prefix}_METAS) continue;`,
      '\t\t\t--m;',
      `\t\t\t${name}_Stamp(m, row + x, tiles, objects);`,
      `\t\t\tconst u8* info = ${name}_MetaInfo + (u16)m * 3;`,
      '\t\t\tfor(u8 c = 0; c < info[0]; ++c)',
      '\t\t\t\tif(cover[x + c] < info[1]) cover[x + c] = info[1];',
      '\t\t}',
      `\t\tfor(${xType} x = 0; x < ${prefix}_W; ++x) if(cover[x]) --cover[x];`,
      `\t\trow += ${prefix}_W;`,
      '\t}',
      '\t// Then the meta-tiles placed over others, in the order they were placed.',
      '\twhile(1)',
      '\t{',
      '\t\tconst u8 m = *layer++;',
      '\t\tif(m == 0) break;',
      ...coordinate('x', bytes.x, xType),
      ...coordinate('y', bytes.y, yType),
      `\t\tif(m <= ${prefix}_METAS) ${name}_Stamp(m - 1, (u16)y * ${prefix}_W + x, tiles, objects);`,
      '\t}',
      '}'
    ]
  }
}

/** A layer name as the table suffix `resourceTables` gives it — `pascal` there, repeated so this file needs no import. */
function pascalName(name: string): string {
  return (
    name
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('') || 'Layer'
  )
}

// ── placed meta-tiles ───────────────────────────────────────────────────────

/**
 * Adds a meta to the map's table, or refreshes the mirror if it is already
 * there — the meta may have been resized or gained a frame since this map last
 * saw it.
 */
/**
 * The mirror of one meta, built from the meta itself.
 *
 * Pure, and shared by everything that has a `MetaTileDoc` in hand: the map
 * editor when a meta is picked or a map is opened, and the exporter before it
 * renders. Both used to build this independently, which is how they came to
 * disagree about the one field that has to match a real C symbol.
 */
export function metaRefFrom(
  path: string,
  meta: MetaTileDoc | OwnedMetaDoc,
  fallbackName: string,
  binding?: MetaBinding | null
): MetaRef {
  if (meta.version === 3) {
    // Its tiles are the attachment's, and it animates through the tileset's
    // window rather than by frame, so to the map it is always one frame.
    return {
      path,
      name: meta.export?.name || fallbackName,
      width: meta.width,
      height: meta.height,
      frames: 1,
      flags: meta.flags,
      cells: binding && binding.width === meta.width && binding.height === meta.height ? binding.cells.slice() : []
    }
  }
  return {
    path,
    // Its own export block first; the name it *will* take otherwise. Never one
    // invented from the file name — `defaultExport` appends the resource kind,
    // so any independent rule disagrees with the symbol the meta really emits.
    name: meta.export?.name || fallbackName,
    width: meta.width,
    height: meta.height,
    frames: meta.frames.length,
    flags: meta.flags,
    // Only colour 0 can be blitted transparently — the V9938 hardwires
    // VDP_OP_TIMP to it — so this is a yes/no, not the index itself.
    ...(meta.transparent === 0 ? { masked: true } : {})
  }
}

export function addMetaRef(doc: MapDoc, ref: MetaRef): MapDoc {
  const existing = doc.metas.findIndex((meta) => meta.path === ref.path)
  if (existing >= 0) {
    const metas = doc.metas.slice()
    metas[existing] = ref
    return { ...doc, metas }
  }
  if (doc.metas.length >= MAX_MAP_METAS) return doc
  return { ...doc, metas: [...doc.metas, ref] }
}

/** Where a meta sits in the table, or -1. */
export function metaSlotOf(doc: MapDoc, path: string): number {
  return doc.metas.findIndex((meta) => meta.path === path)
}

/**
 * Drops a meta from the map, with every placement that used it, and renumbers
 * the slots above it.
 *
 * This is a *local* renumber — `metas` is this map's own list — so unlike a
 * tileset reorder it needs no event and no other document hears about it.
 */
export function removeMetaRef(doc: MapDoc, slot: number): MapDoc {
  if (!doc.metas[slot]) return doc
  return {
    ...doc,
    metas: doc.metas.filter((_, i) => i !== slot),
    layers: doc.layers.map((layer) => ({
      ...layer,
      placements: layer.placements
        .filter((placement) => placement.slot !== slot)
        .map((placement) => (placement.slot > slot ? { ...placement, slot: placement.slot - 1 } : placement))
    }))
  }
}

export function placeMeta(doc: MapDoc, layerIndex: number, slot: number, x: number, y: number): MapDoc {
  const layer = doc.layers[layerIndex]
  if (!layer || !doc.metas[slot] || x < 0 || y < 0 || x >= doc.width || y >= doc.height) return doc
  const layers = doc.layers.slice()
  layers[layerIndex] = { ...layer, placements: [...layer.placements, { slot, x, y }] }
  return { ...doc, layers }
}

export function removePlacement(doc: MapDoc, layerIndex: number, index: number): MapDoc {
  const layer = doc.layers[layerIndex]
  if (!layer?.placements[index]) return doc
  const layers = doc.layers.slice()
  layers[layerIndex] = { ...layer, placements: layer.placements.filter((_, i) => i !== index) }
  return { ...doc, layers }
}

export function movePlacement(doc: MapDoc, layerIndex: number, index: number, x: number, y: number): MapDoc {
  const layer = doc.layers[layerIndex]
  const placement = layer?.placements[index]
  if (!placement || x < 0 || y < 0 || x >= doc.width || y >= doc.height) return doc
  if (placement.x === x && placement.y === y) return doc
  const placements = layer.placements.slice()
  placements[index] = { ...placement, x, y }
  const layers = doc.layers.slice()
  layers[layerIndex] = { ...layer, placements }
  return { ...doc, layers }
}

export function setPlacementBaked(doc: MapDoc, layerIndex: number, index: number, baked: boolean): MapDoc {
  const layer = doc.layers[layerIndex]
  const placement = layer?.placements[index]
  if (!placement || placement.baked === baked) return doc
  const placements = layer.placements.slice()
  placements[index] = baked
    ? { ...placement, baked: true }
    : { slot: placement.slot, x: placement.x, y: placement.y }
  const layers = doc.layers.slice()
  layers[layerIndex] = { ...layer, placements }
  return { ...doc, layers }
}

/**
 * The topmost placement covering a cell, or null. Later placements draw over
 * earlier ones, so the search runs backwards — what the user sees on top is
 * what a click should select.
 */
export function placementAt(doc: MapDoc, layerIndex: number, x: number, y: number): number | null {
  const layer = doc.layers[layerIndex]
  if (!layer) return null
  for (let i = layer.placements.length - 1; i >= 0; i--) {
    const placement = layer.placements[i]
    const ref = doc.metas[placement.slot]
    if (!ref) continue
    if (x >= placement.x && y >= placement.y && x < placement.x + ref.width && y < placement.y + ref.height) return i
  }
  return null
}

/**
 * How many placements the placement table holds — what `_PLACEMENTS` counts
 * and `_DrawPlacements` draws. An indexed layer's meta-tiles are not among
 * them: they are its stream, drawn by expanding it.
 */
export function placementCount(doc: MapDoc): number {
  return doc.layers.reduce((sum, layer) => sum + (layer.indexed ? 0 : layer.placements.length), 0)
}

/** Every meta-tile on the map, indexed layers included — what renumbering tiles would disturb. */
export function metaUseCount(doc: MapDoc): number {
  return doc.layers.reduce((sum, layer) => sum + layer.placements.length, 0)
}

/**
 * The exported placement table: three bytes each, every layer in order.
 *
 * `baked` rides in bit 7 of the slot byte so a placement stays three bytes,
 * which is why `MAX_MAP_METAS` is 128.
 */
export function placementBytes(doc: MapDoc): Uint8Array {
  const out: number[] = []
  for (const layer of doc.layers) {
    if (layer.indexed) continue
    for (const placement of layer.placements) {
      out.push((placement.slot & 0x7f) | (placement.baked ? 0x80 : 0), placement.x & 0xff, placement.y & 0xff)
    }
  }
  return Uint8Array.from(out)
}

/**
 * What each meta slot *is*, rather than where its copies are: width, height and
 * flags, three bytes a slot, indexed by the slot byte a placement carries.
 *
 * `_DrawPlacements` mirrors the same sizes into a private table, but this is
 * data rather than helper C on purpose. Collision is not a drawing concern: a
 * game that never ticks *Export ready-made C* still has to know that a house is
 * 3x3 and solid, and reaching into each meta's own header to find that out is
 * exactly what stops a second meta from being free to add — the include, the
 * hand-written row, and the hand-kept agreement with this map's slot order.
 */
export function metaInfoBytes(doc: MapDoc): Uint8Array {
  const out: number[] = []
  for (const meta of doc.metas) out.push(meta.width & 0xff, meta.height & 0xff, meta.flags & 0xff)
  return Uint8Array.from(out)
}

/**
 * The runtime side of placed meta-tiles: walk the table and draw each live one.
 *
 * Baked placements are skipped — their tiles are already in the layer the map
 * just wrote, which is the whole point of baking them. They stay in the table
 * so the game can still find them, and so the editor can re-stamp them.
 *
 * Each meta row is written as runs of non-transparent cells, for the reason
 * `metaHelperC` does it: tile 0 means "skip this write", and a name table has
 * no other way to be see-through.
 */
export function placementHelperC(doc: MapDoc, name: string): HelperC {
  if (!placementCount(doc) || !doc.metas.length) return { header: [], source: [] }
  // A bitmap map has no name table: a cell is a rectangle the game copies, so
  // the placement runtime is the command engine rather than a layout write.
  // A SCREEN 3 map that is *not* 2×2 has neither, and is refused in validateMap.
  if (doc.cell && !isSc3NameTable(doc)) return bitmapPlacementHelperC(doc, name)
  if (!doc.cell) return patternPlacementHelperC(doc, name)
  return sc3PlacementHelperC(doc, name)
}

/**
 * Placed meta-tiles on a pattern map. Every one owns its pixels, so what it
 * draws is the tiles its attachment to this map's tileset gives it — the map's
 * own `_MetaCells` — and it is always the same picture: one that animates does
 * it in place, through the tileset's `_Animate()`, so there is no frame to
 * pass and nothing to redraw.
 *
 * Through `VDP_WriteVRAM` at the layout address, as `_DrawMeta` does, so a
 * SCREEN 1 game needs no GM2 mode compiled in for it.
 */
function patternPlacementHelperC(doc: MapDoc, name: string): HelperC {
  const prefix = defineName(name)
  const count = placementCount(doc)
  const index = count > 255 ? 'u16' : 'u8'
  const signature = `void ${name}_DrawPlacements(void)`
  return {
    header: [
      '',
      `// ── ${name}: placed meta-tiles ────────────────────────────────────────`,
      '//',
      `// Draws the ${count} meta-tile${count === 1 ? '' : 's'} this map places, over the layers already on`,
      '// screen. See-through cells are not written. A meta that animates needs no',
      "// redraw — the tileset's _Animate() changes its tiles' art in place.",
      '//',
      '// Baked placements are skipped: their tiles are already in the layer.',
      '//',
      '// Example:',
      `//   ${name}_DrawLayer(${name}_${pascalName(doc.layers[0]?.name ?? 'background')}, 0, 0);`,
      `//   ${name}_DrawPlacements();`,
      `${signature};`
    ],
    source: [
      '',
      signature,
      '{',
      `	const u8* p = ${name}_Placements;`,
      `	for(${index} i = 0; i < ${prefix}_PLACEMENTS; ++i)`,
      '	{',
      '		const u8 slot = *p++;',
      '		const u8 px = *p++;',
      '		const u8 py = *p++;',
      '		if(slot & 0x80) continue;',
      `		const u8* info = ${name}_MetaInfo + (u16)slot * 3;`,
      '		const u8 w = info[0];',
      '		const u8 h = info[1];',
      `		const u8* src = ${name}_MetaCells + (${name}_MetaCellsAt[slot * 2] | ((u16)${name}_MetaCellsAt[slot * 2 + 1] << 8));`,
      '		u16 dst = g_ScreenLayoutLow + ((u16)py << 5) + px;',
      '		for(u8 row = 0; row < h; ++row)',
      '		{',
      '			u8 col = 0;',
      '			while(col < w)',
      '			{',
      '				if(src[col] == 0) { ++col; continue; }',
      '				u8 run = col;',
      '				while(run < w && src[run] != 0) ++run;',
      '				VDP_WriteVRAM(src + col, dst + col, g_ScreenLayoutHigh, run - col);',
      '				col = run;',
      '			}',
      '			src += w;',
      '			dst += 32;',
      '		}',
      '	}',
      '}'
    ]
  }
}

/**
 * Placed meta-tiles on a SCREEN 3 map over 2×2 blocks: a name-table map, so
 * they are written like a pattern map's — but its meta-tiles are bitmap ones,
 * each with its own table of frames, redrawn per copy.
 */
function sc3PlacementHelperC(doc: MapDoc, name: string): HelperC {
  const prefix = defineName(name)
  const signature = `void ${name}_DrawPlacements(const u8* frames)`
  return {
    header: [
      '',
      `// ── ${name}: placed meta-tiles ────────────────────────────────────────`,
      '//',
      `// Draws the ${placementCount(doc)} meta-tile${placementCount(doc) === 1 ? '' : 's'} this map places.`,
      '// `frames` is one byte per meta — frames[slot] is the frame that meta is',
      '// currently showing — so animating them is a matter of advancing that',
      '// array and calling this again.',
      '//',
      '// Baked placements are skipped: their tiles are already in the layer.',
      '//',
      '// Example:',
      `//   u8 frames[${prefix}_METAS] = { 0 };`,
      `//   ${name}_DrawPlacements(frames);`,
      `${signature};`
    ],
    source: [
      '',
      ...doc.metas.map((meta) => `extern const u8 ${meta.name}[];`),
      '',
      "// Mirrored from each meta-tile's own file, so this compiles without",
      '// including their headers.',
      `static const struct { const u8* tiles; u8 w; u8 h; u8 cells; u8 frames; } ${name}_Metas[${prefix}_METAS] = {`,
      ...doc.metas.map(
        (meta) => `\t{ ${meta.name}, ${meta.width}, ${meta.height}, ${meta.width * meta.height}, ${meta.frames} },`
      ),
      '};',
      '',
      signature,
      '{',
      `\tconst u8* p = ${name}_Placements;`,
      `\tfor(u8 i = 0; i < ${prefix}_PLACEMENTS; ++i)`,
      '\t{',
      '\t\tu8 slot = *p++;',
      '\t\tu8 px = *p++;',
      '\t\tu8 py = *p++;',
      '\t\tif(slot & 0x80) continue;',
      `\t\tconst u8 w = ${name}_Metas[slot].w;`,
      '\t\t// Clamped, because `frames` belongs to the caller and an',
      '\t\t// uninitialised global is boot garbage on a ROM target, not zero.',
      '\t\t// Unclamped, a stray index reads a whole frame past the end of the',
      '\t\t// table and draws whatever followed in ROM — deterministically, so',
      '\t\t// it looks like art rather than like a bug.',
      `\t\tu8 f = frames[slot];`,
      `\t\tif(f >= ${name}_Metas[slot].frames) f = 0;`,
      `\t\tconst u8* src = ${name}_Metas[slot].tiles + ((u16)f * ${name}_Metas[slot].cells);`,
      `\t\tfor(u8 row = 0; row < ${name}_Metas[slot].h; ++row)`,
      '\t\t{',
      '\t\t\tu8 col = 0;',
      '\t\t\twhile(col < w)',
      '\t\t\t{',
      '\t\t\t\tif(src[col] == 0) { ++col; continue; }',
      '\t\t\t\tu8 run = col;',
      '\t\t\t\twhile(run < w && src[run] != 0) ++run;',
      '\t\t\t\tVDP_WriteLayout_GM2(src + col, px + col, py + row, run - col, 1);',
      '\t\t\t\tcol = run;',
      '\t\t\t}',
      '\t\t\tsrc += w;',
      '\t\t}',
      '\t}',
      '}'
    ]
  }
}

/**
 * Placed meta-tiles in a bitmap mode.
 *
 * Same table, same skipped-baked rule, different blit: there is no name table,
 * so each cell is copied out of the atlas. Cells holding tile 0 are skipped
 * entirely; the rest go through `LMMM` with `VDP_OP_TIMP` when the meta's
 * tileset nominates colour 0 as transparent, and the faster `HMMM` when it does
 * not. Both kinds can appear in one map, so the choice is per meta.
 */
function bitmapPlacementHelperC(doc: MapDoc, name: string): HelperC {
  const prefix = defineName(name)
  const cell = doc.cell!
  const anyMasked = doc.metas.some((meta) => meta.masked)
  const signature = `void ${name}_DrawPlacements(const u8* frames, UY atlasY)`

  return {
    header: [
      '',
      `// ── ${name}: placed meta-tiles (bitmap mode) ──────────────────────────`,
      '//',
      `// Draws the ${placementCount(doc)} meta-tile${placementCount(doc) === 1 ? '' : 's'} this map places, out of the atlas`,
      '// parked at (0, `atlasY`). `frames` is one byte per meta — frames[slot] is',
      '// the frame that meta is currently showing.',
      '//',
      '// Baked placements are skipped: their cells are already in the layer.',
      anyMasked
        ? '// Metas whose tileset nominates colour 0 as transparent are blitted with'
        : '// No meta here uses per-pixel transparency, so every blit is an opaque',
      anyMasked ? '// VDP_OP_TIMP, so their silhouettes can be any shape.' : '// HMMM. A cell holding tile 0 is skipped whatever the meta.',
      '//',
      '// Needs MSXgl\'s VDP command engine: MSX2 or later with VDP_USE_COMMAND.',
      '//',
      '// Example:',
      `//   u8 frames[${prefix}_METAS] = { 0 };`,
      `//   ${name}_DrawPlacements(frames, ATLAS_Y);`,
      `${signature};`
    ],
    source: [
      '',
      ...doc.metas.map((meta) => `extern const u8 ${meta.name}[];`),
      '',
      "// Mirrored from each meta-tile's own file, so this compiles without",
      '// including their headers. `masked` is whether its cells blit with',
      '// transparency.',
      `static const struct { const u8* tiles; u8 w; u8 h; u8 cells; u8 frames; u8 masked; } ${name}_Metas[${prefix}_METAS] = {`,
      ...doc.metas.map(
        (meta) =>
          `\t{ ${meta.name}, ${meta.width}, ${meta.height}, ${meta.width * meta.height}, ` +
          `${meta.frames}, ${meta.masked ? 1 : 0} },`
      ),
      '};',
      '',
      signature,
      '{',
      `\tconst u8* p = ${name}_Placements;`,
      `\tfor(u8 i = 0; i < ${prefix}_PLACEMENTS; ++i)`,
      '\t{',
      '\t\tu8 slot = *p++;',
      '\t\tu8 px = *p++;',
      '\t\tu8 py = *p++;',
      '\t\tif(slot & 0x80) continue;',
      `\t\tconst u8 w = ${name}_Metas[slot].w;`,
      '\t\t// Clamped, because `frames` belongs to the caller and an',
      '\t\t// uninitialised global is boot garbage on a ROM target, not zero.',
      '\t\t// Unclamped, a stray index reads a whole frame past the end of the',
      '\t\t// table and draws whatever followed in ROM — deterministically, so',
      '\t\t// it looks like art rather than like a bug.',
      `\t\tu8 f = frames[slot];`,
      `\t\tif(f >= ${name}_Metas[slot].frames) f = 0;`,
      `\t\tconst u8* src = ${name}_Metas[slot].tiles + ((u16)f * ${name}_Metas[slot].cells);`,
      `\t\tfor(u8 row = 0; row < ${name}_Metas[slot].h; ++row)`,
      '\t\t{',
      '\t\t\tfor(u8 col = 0; col < w; ++col)',
      '\t\t\t{',
      '\t\t\t\tu8 cell = *src++;',
      '\t\t\t\tif(cell == 0) continue;',
      `\t\t\t\tconst UX sx = (u16)(cell % ${prefix}_ATLAS_COLS) * ${cell.width};`,
      `\t\t\t\tconst UY sy = atlasY + ((cell / ${prefix}_ATLAS_COLS) * ${cell.height});`,
      `\t\t\t\tconst UX dx = ((UX)px + col) * ${cell.width};`,
      `\t\t\t\tconst UY dy = ((UY)py + row) * ${cell.height};`,
      `\t\t\t\tif(${name}_Metas[slot].masked)`,
      `\t\t\t\t\tVDP_CommandLMMM(sx, sy, dx, dy, ${cell.width}, ${cell.height}, VDP_OP_TIMP);`,
      '\t\t\t\telse',
      `\t\t\t\t\tVDP_CommandHMMM(sx, sy, dx, dy, ${cell.width}, ${cell.height});`,
      '\t\t\t}',
      '\t\t}',
      '\t}',
      '}'
    ]
  }
}
