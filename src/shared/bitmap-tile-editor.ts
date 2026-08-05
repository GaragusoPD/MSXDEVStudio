/**
 * Editing logic for `*.btiles.json`, kept out of the Vue components for the
 * usual reason: it is the part worth testing.
 *
 * The geometry — lines, rectangles — comes straight from `tile-editor.ts`,
 * because a drag is a drag whatever it is painting. The flood fill does not:
 * that one is hard-coded to the 8×8 name-table cell, and a bitmap tile is
 * whatever size its tileset says.
 *
 * Everything here takes and returns a whole `BitmapTilesDoc`, so a stroke is
 * one value the session can push onto `History<T>` — same contract the sprite,
 * map and screen editors use.
 */

import {
  addBitmapTile,
  removeBitmapTile,
  reorderBitmapTiles,
  withPixels,
  type BitmapTilesDoc
} from './msx/bitmap-tile'
import type { TileBlock } from './msx/tile'
import { linePoints, rectPoints, type Point, type TileTool } from './tile-editor'

export type { Point, TileTool }

/** Flood fill across one tile, at that tile's own size. */
export function bitmapFillPoints(
  pixels: ArrayLike<number>,
  start: Point,
  width: number,
  height: number
): Point[] {
  const inside = (p: Point): boolean => p.x >= 0 && p.y >= 0 && p.x < width && p.y < height
  if (!inside(start)) return []
  const target = pixels[start.y * width + start.x]
  const seen = new Set<number>()
  const out: Point[] = []
  const stack = [start]
  while (stack.length) {
    const p = stack.pop() as Point
    const key = p.y * width + p.x
    if (!inside(p) || seen.has(key) || pixels[key] !== target) continue
    seen.add(key)
    out.push(p)
    stack.push({ x: p.x + 1, y: p.y }, { x: p.x - 1, y: p.y }, { x: p.x, y: p.y + 1 }, { x: p.x, y: p.y - 1 })
  }
  return out
}

/** `from` is the drag origin (or the previous pencil sample), `to` the current pixel. */
export function bitmapToolPoints(
  tool: TileTool,
  from: Point,
  to: Point,
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  filled = false
): Point[] {
  switch (tool) {
    case 'fill':
      return bitmapFillPoints(pixels, to, width, height)
    case 'rect':
      return rectPoints(from, to, filled)
    default:
      return linePoints(from, to)
  }
}

/** Paints `points` of one tile in `color`. Points outside the tile are dropped, not clamped. */
export function paintTile(
  doc: BitmapTilesDoc,
  index: number,
  points: readonly Point[],
  color: number
): BitmapTilesDoc {
  if (index < 0 || index >= doc.count || !points.length) return doc
  const per = doc.width * doc.height
  let changed = false
  const next = withPixels(doc, (pixels) => {
    for (const point of points) {
      if (point.x < 0 || point.y < 0 || point.x >= doc.width || point.y >= doc.height) continue
      const at = index * per + point.y * doc.width + point.x
      if (pixels[at] === (color & 0xff)) continue
      pixels[at] = color & 0xff
      changed = true
    }
  })
  return changed ? next : doc
}

/** One gameplay bit of one tile — the same eight bits pattern tiles carry. */
export function setBitmapTileFlagBit(
  doc: BitmapTilesDoc,
  index: number,
  bit: number,
  on: boolean
): BitmapTilesDoc {
  if (index < 0 || index >= doc.count || bit < 0 || bit > 7) return doc
  const flags = doc.flags.slice()
  const mask = 1 << bit
  const next = on ? (flags[index] | mask) & 0xff : flags[index] & ~mask & 0xff
  if (next === flags[index]) return doc
  flags[index] = next
  return { ...doc, flags }
}

export function setBitmapPaletteEntry(doc: BitmapTilesDoc, index: number, grb: number): BitmapTilesDoc {
  if (!doc.palette || index < 0 || index >= doc.palette.length) return doc
  const palette = doc.palette.slice()
  palette[index] = grb & 0x777
  return { ...doc, palette }
}

export { addBitmapTile, removeBitmapTile, reorderBitmapTiles }

// ── blocks ──────────────────────────────────────────────────────────────────

/** A named `width × height` group of tile references. Same type pattern tiles use. */
export function createBitmapBlock(
  doc: BitmapTilesDoc,
  name: string,
  width: number,
  height: number,
  tiles?: readonly number[]
): BitmapTilesDoc {
  const w = Math.max(1, Math.round(width) || 1)
  const h = Math.max(1, Math.round(height) || 1)
  const block: TileBlock = {
    name: name.trim() || `block${doc.blocks.length + 1}`,
    width: w,
    height: h,
    tiles: Array.from({ length: w * h }, (_, i) => (tiles?.[i] ?? 0) & 0xff)
  }
  return { ...doc, blocks: [...doc.blocks, block] }
}

export function removeBitmapBlock(doc: BitmapTilesDoc, index: number): BitmapTilesDoc {
  if (index < 0 || index >= doc.blocks.length) return doc
  return { ...doc, blocks: doc.blocks.filter((_, i) => i !== index) }
}

export function renameBitmapBlock(doc: BitmapTilesDoc, index: number, name: string): BitmapTilesDoc {
  if (index < 0 || index >= doc.blocks.length) return doc
  const blocks = doc.blocks.slice()
  blocks[index] = { ...blocks[index], name: name.trim() || blocks[index].name }
  return { ...doc, blocks }
}

/**
 * A rectangle of the bank grid, named and kept — the bitmap counterpart of
 * `blockFromTiles`. `cols` is how wide the grid is being *shown*, which is what
 * decides which tiles a marquee actually covers.
 */
export function blockFromSelection(
  doc: BitmapTilesDoc,
  name: string,
  cols: number,
  start: number,
  width: number,
  height: number
): BitmapTilesDoc {
  const tiles: number[] = []
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const index = start + row * cols + col
      tiles.push(index < doc.count ? index : 0)
    }
  }
  return createBitmapBlock(doc, name, width, height, tiles)
}
