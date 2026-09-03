/**
 * What the map editor draws a cell from, whichever kind of tileset the map
 * references.
 *
 * A name-table map (SCREEN 1/2/4) and a bitmap map (SCREEN 5 and up) differ in
 * what a cell *means* — an index the VDP resolves against a pattern table, or
 * a rectangle of pixels the game copies — but not in what the editor has to
 * put on screen: a grid of same-sized images addressed by number. So both
 * collapse to one `Sheet`, and `MapCanvas`/`MapPicker` never branch on which
 * they got.
 *
 * The sheet is cached against the document it was built from, because both
 * panes ask for it on every redraw and rebuilding a 256-tile sheet per frame
 * is visible.
 */

import { sheetCols, sheetPixels, type BitmapTilesDoc } from '../../../../shared/msx/bitmap-tile'
import { paletteToRgb } from '../../../../shared/msx/palette'
import { screenPixels, screenRgb, type ScreenDoc } from '../../../../shared/msx/screen'
import { bankedSheetPixels, BANK_COUNT, isBanked, MAX_TILES, tilePixels, TILE_SIZE, type TilesDoc } from '../../../../shared/msx/tile'
import type { MapCell } from '../../../../shared/msx/map'
import type { MetaTileDoc } from '../../../../shared/msx/meta-tile'

export interface Sheet {
  canvas: HTMLCanvasElement
  /** Cell size in the sheet's own pixels — 8×8 for a tileset, the map's cell for an atlas. */
  cellW: number
  cellH: number
  /** Cells per row, so cell `n` is at `(n % cols * cellW, n / cols * cellH)`. */
  cols: number
  /** How many cells the sheet actually holds; anything past this draws as nothing. */
  count: number
}

const TILESET_COLUMNS = 16

/** Rebuilt only when the source document changes identity — both panes share one cache. */
let cachedSource: TilesDoc | ScreenDoc | BitmapTilesDoc | null = null
/** An atlas sheet also depends on the map's cell size, which is not part of the screen doc. */
let cachedKey = ''
let cached: Sheet | null = null

export function tilesetSheet(tileset: TilesDoc): Sheet {
  // A banked tileset's real art lives in `bankTiles[b]`, which the loop below
  // never reads — painting `count` cells of the common set alone is how a
  // banked map used to render blank. Its own function, its own cache key: the
  // unbanked path below is otherwise untouched, cache key included, because
  // most tilesets never bank and this must cost them nothing.
  if (isBanked(tileset)) return bankedTilesetSheet(tileset)
  if (cachedSource === tileset && cachedKey === '' && cached) return cached
  const rows = Math.max(1, Math.ceil(tileset.count / TILESET_COLUMNS))
  const canvas = document.createElement('canvas')
  canvas.width = TILESET_COLUMNS * TILE_SIZE
  canvas.height = rows * TILE_SIZE
  const sheet: Sheet = { canvas, cellW: TILE_SIZE, cellH: TILE_SIZE, cols: TILESET_COLUMNS, count: tileset.count }
  const ctx = canvas.getContext('2d')
  if (!ctx) return sheet
  const rgb = paletteToRgb(tileset.palette)
  const image = new ImageData(canvas.width, canvas.height)
  for (let index = 0; index < tileset.count; index++) {
    const pixels = tilePixels(tileset, index)
    const ox = (index % TILESET_COLUMNS) * TILE_SIZE
    const oy = Math.floor(index / TILESET_COLUMNS) * TILE_SIZE
    for (let y = 0; y < TILE_SIZE; y++) {
      for (let x = 0; x < TILE_SIZE; x++) {
        const color = rgb[pixels[y * TILE_SIZE + x]] ?? { r: 0, g: 0, b: 0 }
        const at = ((oy + y) * image.width + ox + x) * 4
        image.data[at] = color.r
        image.data[at + 1] = color.g
        image.data[at + 2] = color.b
        image.data[at + 3] = 255
      }
    }
  }
  ctx.putImageData(image, 0, 0)
  cachedSource = tileset
  cachedKey = ''
  cached = sheet
  return sheet
}

/**
 * The banked branch of `tilesetSheet`: paints from `bankedSheetPixels` — the
 * shared, testable layout — rather than looping over `tiles`/`bankTiles` here.
 * Same shape as `bitmapTilesetSheet` below: the layout function decides which
 * cell holds which tile, this only converts palette indices to RGB.
 */
function bankedTilesetSheet(tileset: TilesDoc): Sheet {
  if (cachedSource === tileset && cachedKey === 'banked' && cached) return cached
  const pixels = bankedSheetPixels(tileset)
  const canvas = document.createElement('canvas')
  canvas.width = pixels.width
  canvas.height = pixels.height
  const sheet: Sheet = {
    canvas,
    cellW: TILE_SIZE,
    cellH: TILE_SIZE,
    cols: TILESET_COLUMNS,
    count: BANK_COUNT * MAX_TILES
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return sheet
  const rgb = paletteToRgb(tileset.palette)
  const image = new ImageData(canvas.width, canvas.height)
  for (let i = 0; i < pixels.indices.length; i++) {
    const color = rgb[pixels.indices[i]] ?? { r: 0, g: 0, b: 0 }
    image.data[i * 4] = color.r
    image.data[i * 4 + 1] = color.g
    image.data[i * 4 + 2] = color.b
    image.data[i * 4 + 3] = 255
  }
  ctx.putImageData(image, 0, 0)
  cachedSource = tileset
  cachedKey = 'banked'
  cached = sheet
  return sheet
}

/**
 * A bitmap atlas needs no cutting up: the converted image already *is* the
 * grid, so the sheet is the picture and the geometry comes from the map's
 * `cell`. That is why an atlas is a plain image and not a set of
 * `ScreenFragment`s — fragments are named cut-outs of whatever size suits
 * them, and a tilemap wants the opposite.
 */
/**
 * A bitmap tileset's own sheet. Unlike `atlasSheet` this needs nothing from the
 * map: the tile size and the sheet's shape belong to the tileset, which is the
 * whole difference between a tileset and a picture being read as a grid.
 */
export function bitmapTilesetSheet(tileset: BitmapTilesDoc): Sheet {
  if (cachedSource === tileset && cachedKey === 'btiles' && cached) return cached
  const pixels = sheetPixels(tileset)
  const canvas = document.createElement('canvas')
  canvas.width = pixels.width
  canvas.height = pixels.height
  const sheet: Sheet = {
    canvas,
    cellW: tileset.width,
    cellH: tileset.height,
    cols: sheetCols(tileset),
    count: tileset.count
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return sheet
  const rgb = paletteToRgb(tileset.palette)
  const image = new ImageData(canvas.width, canvas.height)
  for (let i = 0; i < pixels.indices.length; i++) {
    const color = rgb[pixels.indices[i]] ?? { r: 0, g: 0, b: 0 }
    image.data[i * 4] = color.r
    image.data[i * 4 + 1] = color.g
    image.data[i * 4 + 2] = color.b
    image.data[i * 4 + 3] = 255
  }
  ctx.putImageData(image, 0, 0)
  cachedSource = tileset
  cachedKey = 'btiles'
  cached = sheet
  return sheet
}

/**
 * One meta-tile's frame, drawn from the sheet of the tileset it references —
 * the thumbnail the map's meta picker shows, and the image the map canvas
 * stamps where a placement sits.
 *
 * Composed by copying out of `base` rather than re-rendering the art, so it
 * costs nothing per palette and works the same over a pattern tileset, a
 * bitmap tileset or an atlas.
 *
 * Tile 0 is left untouched, so whatever is behind the meta shows through it.
 * That is the editor's half of the same rule the emitted C follows by skipping
 * the write.
 */
export function metaThumbnail(base: Sheet, meta: MetaTileDoc, frame = 0): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = base.cellW * meta.width
  canvas.height = base.cellH * meta.height
  const ctx = canvas.getContext('2d')
  const tiles = meta.frames[frame]?.tiles
  if (!ctx || !tiles) return canvas
  ctx.imageSmoothingEnabled = false
  for (let ty = 0; ty < meta.height; ty++) {
    for (let tx = 0; tx < meta.width; tx++) {
      const tile = tiles[ty * meta.width + tx] ?? 0
      if (tile === 0) continue
      ctx.drawImage(
        base.canvas,
        (tile % base.cols) * base.cellW,
        Math.floor(tile / base.cols) * base.cellH,
        base.cellW,
        base.cellH,
        tx * base.cellW,
        ty * base.cellH,
        base.cellW,
        base.cellH
      )
    }
  }
  return canvas
}

export function atlasSheet(screen: ScreenDoc, cell: MapCell): Sheet {
  const key = `${cell.width}x${cell.height}/${cell.cols}`
  if (cachedSource === screen && cachedKey === key && cached) return cached
  const pixels = screenPixels(screen)
  const canvas = document.createElement('canvas')
  canvas.width = pixels?.width ?? cell.width
  canvas.height = pixels?.height ?? cell.height
  const rows = pixels ? Math.floor(pixels.height / cell.height) : 0
  const sheet: Sheet = {
    canvas,
    cellW: cell.width,
    cellH: cell.height,
    cols: cell.cols,
    // A cell index is one byte, so nothing past 255 is reachable anyway.
    count: Math.min(256, cell.cols * rows)
  }
  const ctx = canvas.getContext('2d')
  if (!ctx || !pixels) return sheet
  const rgb = screenRgb(screen)
  const image = new ImageData(canvas.width, canvas.height)
  for (let i = 0; i < pixels.indices.length; i++) {
    const color = rgb[pixels.indices[i]] ?? { r: 0, g: 0, b: 0 }
    image.data[i * 4] = color.r
    image.data[i * 4 + 1] = color.g
    image.data[i * 4 + 2] = color.b
    image.data[i * 4 + 3] = 255
  }
  ctx.putImageData(image, 0, 0)
  cachedSource = screen
  cachedKey = key
  cached = sheet
  return sheet
}
