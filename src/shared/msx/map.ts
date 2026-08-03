/**
 * `*.map.json` (Spec 10 A): a tilemap over a `*.tiles.json` tileset. Layers
 * are flat `width * height` arrays — either tile indices or per-cell bit
 * layers — which is exactly what gets exported.
 */

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
