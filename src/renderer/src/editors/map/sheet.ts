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

import { paletteToRgb } from '../../../../shared/msx/palette'
import { screenPixels, screenRgb, type ScreenDoc } from '../../../../shared/msx/screen'
import { tilePixels, TILE_SIZE, type TilesDoc } from '../../../../shared/msx/tile'
import type { MapCell } from '../../../../shared/msx/map'

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
let cachedSource: TilesDoc | ScreenDoc | null = null
/** An atlas sheet also depends on the map's cell size, which is not part of the screen doc. */
let cachedKey = ''
let cached: Sheet | null = null

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
