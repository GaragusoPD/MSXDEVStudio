/**
 * `*.map.json` (Spec 10 A): a tilemap over a `*.tiles.json` tileset. Layers
 * are flat `width * height` arrays — either tile indices or per-cell bit
 * layers — which is exactly what gets exported.
 */

import { packRlep } from './compress'
import { defineName, type HelperC } from './emitC'
import type { ExportBlock } from './resource'


export interface MapLayer {
  name: string
  /** Only tile layers exist; gameplay bits live on the tileset (`TilesDoc.flags`). */
  kind: 'tiles'
  /** `width * height` values, row-major. Tile indices, or a flag bitmask per cell. */
  data: number[]
  visible: boolean
}

export interface MapDoc {
  version: 1
  /** Project-relative path of the tileset this map draws with. */
  tileset: string
  width: number
  height: number
  layers: MapLayer[]
  export: ExportBlock | null
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

  const rawLayers = Array.isArray(input.layers) && input.layers.length ? input.layers : [{ name: 'background' }]
  const layers: MapLayer[] = rawLayers.map((entry, index) => {
    const layer = (typeof entry === 'object' && entry !== null ? entry : {}) as Partial<MapLayer>
    const data = new Array<number>(cells).fill(0)
    for (let i = 0; i < cells; i++) data[i] = Number(layer.data?.[i]) || 0
    return {
      name: String(layer.name ?? `layer_${index}`),
      kind: 'tiles',
      data,
      visible: layer.visible !== false
    }
  })


  return {
    version: 1,
    tileset: String(input.tileset ?? ''),
    width,
    height,
    layers,
    export: input.export ?? null
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
    return { ...layer, data }
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

export function validateMap(doc: MapDoc): string[] {
  const problems: string[] = []
  if (doc.version !== 1) problems.push(`Unsupported version ${doc.version}`)
  if (!doc.tileset) problems.push('No tileset referenced')
  if (!doc.layers.length) problems.push('Map has no layers')
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
): { compressed: boolean; layers: { bytes: Uint8Array; unpacked?: number }[] } {
  const raw = doc.layers.map(mapLayerBytes)
  const uncompressed = { compressed: false, layers: raw.map((bytes) => ({ bytes })) }
  if (compress !== 'rlep' || !raw.length) return uncompressed
  const packed = raw.map(packRlep)
  if (!packed.every((bytes, index) => bytes.length < raw[index].length)) return uncompressed
  return { compressed: true, layers: packed.map((bytes, index) => ({ bytes, unpacked: raw[index].length })) }
}

/**
 * The opt-in ready-made C: draw a layer into the name table. Compressed layers
 * unpack into a caller-supplied buffer first — `RLEp_UnpackToRAM` is MSXgl's
 * own, from the `compress` module.
 */
export function mapHelperC(doc: MapDoc, name: string, compressed: boolean, table: string): HelperC {
  const prefix = defineName(name)
  const head = [
    '',
    `// Draws one layer of ${name} into the name table at tile column/row (x, y).`,
    '// Needs MSXgl\'s VDP module (#include "msxgl.h" before this header) built',
    '// with VDP_USE_MODE_G2 or VDP_USE_MODE_G3.'
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
