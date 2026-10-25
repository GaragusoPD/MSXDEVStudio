/**
 * A resource's picture for the Resources panel's cards: palette indices and
 * the colours to show them in, decoded with the same functions the editors
 * draw with, so a thumbnail never disagrees with what opening the file shows.
 *
 * Pure: what a thumbnail needs from another file — the tileset a map is drawn
 * with — is passed in. Null for what has no picture of its own (sound, a
 * bitmap meta-tile without its tileset), which the panel shows as an icon.
 */

import { bankForRow, type MapDoc } from './map'
import { isOwnedMeta } from './meta-owned'
import { MODES } from './modes'
import { paletteToRgb, type Rgb } from './palette'
import { rgb332Palette } from './quantize'
import type { ResourceDoc } from './resource'
import { screenPixels } from './screen'
import { compositePixel } from './sprite'
import { swFramePixels } from './swsprite'
import { frameTiles } from './tile-anim'
import { bankTileAt, isBanked, MAX_TILES, tilePixels, TILE_SIZE, type TilesDoc } from './tile'
import { tileImage } from './bitmap-tile'

export interface Thumbnail {
  width: number
  height: number
  /** Row-major; 0 is drawn see-through, as it is in every pattern mode. */
  indices: Uint8Array
  rgb: readonly Rgb[]
}

/** A tileset's sheet shows this many tiles at most, this many across: enough to recognise it. */
const SHEET_TILES = 64
const SHEET_COLUMNS = 8
/** A map bigger than this many tiles is shown by its top-left corner — one screen and a bit. */
const MAP_MAX_COLS = 64
const MAP_MAX_ROWS = 48

const MSX1 = paletteToRgb(null)

export function thumbnailOf(resource: ResourceDoc, tileset: TilesDoc | null = null): Thumbnail | null {
  switch (resource.kind) {
    case 'tiles': {
      const doc = resource.doc
      const banked = isBanked(doc)
      const count = Math.min(SHEET_TILES, banked ? Math.max(doc.count, doc.bankTiles[0].length) : doc.count)
      return grid(count, SHEET_COLUMNS, (i) => (banked ? pixelsOf(bankTileAt(doc, 0, i), doc) : tilePixels(doc, i)), paletteToRgb(doc.palette))
    }
    case 'metatiles':
    case 'anim': {
      const doc = resource.doc
      const scratch = frameTiles(doc, 0)
      const holes = isOwnedMeta(doc) ? doc.holes : []
      return grid(doc.width * doc.height, doc.width, (i) => (holes[i] ? new Uint8Array(TILE_SIZE * TILE_SIZE) : tilePixels(scratch, i)), MSX1)
    }
    case 'map':
      return tileset ? mapThumbnail(resource.doc, tileset) : null
    case 'sprites': {
      const doc = resource.doc
      const character = doc.sprites[0]
      const frame = character?.frames[0]
      if (!character || !frame) return null
      const width = character.cols * doc.size
      const height = character.rows * doc.size
      const indices = new Uint8Array(width * height)
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) indices[y * width + x] = compositePixel(frame.layers, x, y, doc.mode, doc.size)
      }
      return { width, height, indices, rgb: paletteToRgb(doc.palette) }
    }
    case 'swsprites': {
      const doc = resource.doc
      const character = doc.sprites[0]
      if (!character) return null
      return { width: character.width, height: character.height, indices: swFramePixels(doc, 0, 0), rgb: bitmapRgb(doc.mode, doc.palette) }
    }
    case 'screen': {
      const pixels = screenPixels(resource.doc)
      if (!pixels || MODES[resource.doc.mode].palette === 'yjk') return null
      return { ...pixels, rgb: bitmapRgb(resource.doc.mode, resource.doc.converted?.palette ?? null) }
    }
    case 'btiles': {
      const doc = resource.doc
      const count = Math.min(SHEET_TILES, doc.count)
      const columns = Math.max(1, Math.min(SHEET_COLUMNS, Math.floor(64 / doc.width)))
      return cells(count, columns, doc.width, doc.height, (i) => tileImage(doc, i), bitmapRgb(doc.mode, doc.palette))
    }
    default:
      return null
  }
}

/** The colours a bitmap-mode index means: sc8's fixed 256, else the document's 16 (or the boot palette). */
function bitmapRgb(mode: string, palette: readonly number[] | null): readonly Rgb[] {
  return MODES[mode as keyof typeof MODES]?.palette === 'rgb332' ? rgb332Palette() : paletteToRgb(palette)
}

/** A tile entry's pixels, decoded through a one-tile document in `like`'s mode. */
function pixelsOf(entry: TilesDoc['tiles'][number], like: TilesDoc): Uint8Array {
  return tilePixels({ ...like, count: 1, tiles: [entry], groupColors: like.groupColors.slice(0, 1) }, 0)
}

/** `count` 8×8 tiles, `columns` across. */
function grid(count: number, columns: number, pixels: (i: number) => Uint8Array, rgb: readonly Rgb[]): Thumbnail | null {
  return cells(count, columns, TILE_SIZE, TILE_SIZE, pixels, rgb)
}

/** `count` cells of `cw × ch` dots each, `columns` across. */
function cells(
  count: number,
  columns: number,
  cw: number,
  ch: number,
  pixels: (i: number) => Uint8Array,
  rgb: readonly Rgb[]
): Thumbnail | null {
  if (count <= 0) return null
  const across = Math.min(columns, count)
  const width = across * cw
  const height = Math.ceil(count / across) * ch
  const indices = new Uint8Array(width * height)
  for (let i = 0; i < count; i++) {
    const ox = (i % across) * cw
    const oy = Math.floor(i / across) * ch
    const source = pixels(i)
    for (let y = 0; y < ch; y++) indices.set(source.subarray(y * cw, (y + 1) * cw), (oy + y) * width + ox)
  }
  return { width, height, indices, rgb }
}

/**
 * A pattern map as the game draws it: its tile layers in order (the first in
 * full, the others skipping tile 0, which is what erase writes), then each
 * layer's live meta-tile placements from the tile numbers the map mirrors for
 * them, skipping see-through cells. A banked tileset reads each row's bank.
 */
function mapThumbnail(map: MapDoc, tiles: TilesDoc): Thumbnail {
  const cols = Math.min(map.width, MAP_MAX_COLS)
  const rows = Math.min(map.height, MAP_MAX_ROWS)
  const width = cols * TILE_SIZE
  const indices = new Uint8Array(width * rows * TILE_SIZE)
  const banked = isBanked(tiles)
  const stamp = (cx: number, cy: number, tile: number): void => {
    if (cx < 0 || cy < 0 || cx >= cols || cy >= rows || tile >= MAX_TILES) return
    const pixels = banked ? pixelsOf(bankTileAt(tiles, bankForRow(cy % 24), tile), tiles) : tilePixels(tiles, tile)
    for (let y = 0; y < TILE_SIZE; y++) indices.set(pixels.subarray(y * TILE_SIZE, (y + 1) * TILE_SIZE), (cy * TILE_SIZE + y) * width + cx * TILE_SIZE)
  }
  let base = true
  for (const layer of map.layers) {
    if (layer.kind !== 'tiles') continue
    if (!layer.visible) {
      base = false
      continue
    }
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const tile = layer.data[cy * map.width + cx] ?? 0
        if (tile || base) stamp(cx, cy, tile)
      }
    }
    base = false
    for (const placement of layer.placements) {
      const ref = map.metas[placement.slot]
      if (!ref?.cells || placement.baked) continue
      ref.cells.forEach((tile, i) => {
        if (tile) stamp(placement.x + (i % ref.width), placement.y + Math.floor(i / ref.width), tile)
      })
    }
  }
  return { width, height: rows * TILE_SIZE, indices, rgb: paletteToRgb(tiles.palette) }
}
