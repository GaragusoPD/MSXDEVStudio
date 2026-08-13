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
import { tilePixels, TILE_SIZE, type TilesDoc } from '../../../../shared/msx/tile'
import type { MapCell } from '../../../../shared/msx/map'
import type { MetaTilesDoc } from '../../../../shared/msx/meta-tile'

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
/** How wide the composed meta sheet is. Only the picker's own wrapping is user-visible. */
const METASHEET_COLUMNS = 8

/** Rebuilt only when the source document changes identity — both panes share one cache. */
let cachedSource: TilesDoc | ScreenDoc | BitmapTilesDoc | null = null
/** An atlas sheet also depends on the map's cell size, which is not part of the screen doc. */
let cachedKey = ''
let cached: Sheet | null = null

/** `metaSheet`'s own slot — see the note there. */
let metaCacheBase: HTMLCanvasElement | null = null
let metaCacheSource: MetaTilesDoc | null = null
let metaCached: Sheet | null = null

export function tilesetSheet(tileset: TilesDoc): Sheet {
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
 * A meta-tile set as a sheet, composed from the sheet of the tileset it groups.
 *
 * This is the whole of the map editor's meta support: a meta map's cells index
 * metas instead of tiles, and since both panes only ever ask `sheet()` for "cell
 * `n` as an image", handing them a sheet whose cells *are* the metas leaves the
 * picker, the canvas, the tools, the clipboard and the undo stack untouched.
 *
 * Composed by copying out of `base` rather than re-rendering the art, so it
 * costs nothing per palette and works the same over a pattern tileset, a bitmap
 * tileset or an atlas.
 */
export function metaSheet(base: Sheet, metas: MetaTilesDoc): Sheet {
  // Its own cache slot, not the shared one: a meta sheet is built *from* another
  // sheet, so sharing would have the two evict each other on every redraw.
  if (metaCacheBase === base.canvas && metaCacheSource === metas && metaCached) return metaCached
  const cellW = base.cellW * metas.width
  const cellH = base.cellH * metas.height
  const cols = Math.max(1, Math.min(METASHEET_COLUMNS, metas.metas.length))
  const rows = Math.max(1, Math.ceil(metas.metas.length / cols))
  const canvas = document.createElement('canvas')
  canvas.width = cols * cellW
  canvas.height = rows * cellH
  const sheet: Sheet = { canvas, cellW, cellH, cols, count: metas.metas.length }
  const ctx = canvas.getContext('2d')
  if (!ctx) return sheet
  ctx.imageSmoothingEnabled = false
  metas.metas.forEach((meta, index) => {
    const ox = (index % cols) * cellW
    const oy = Math.floor(index / cols) * cellH
    for (let ty = 0; ty < metas.height; ty++) {
      for (let tx = 0; tx < metas.width; tx++) {
        const tile = meta.tiles[ty * metas.width + tx] ?? 0
        ctx.drawImage(
          base.canvas,
          (tile % base.cols) * base.cellW,
          Math.floor(tile / base.cols) * base.cellH,
          base.cellW,
          base.cellH,
          ox + tx * base.cellW,
          oy + ty * base.cellH,
          base.cellW,
          base.cellH
        )
      }
    }
  })
  // Keyed on both: the art changes when the tileset is reloaded (a new base
  // canvas), and the layout changes when a meta is edited (a new doc).
  metaCacheBase = base.canvas
  metaCacheSource = metas
  metaCached = sheet
  return sheet
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
