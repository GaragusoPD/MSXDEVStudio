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
  MAX_BITMAP_TILES,
  tileImage,
  tilePixels,
  addBitmapTile,
  removeBitmapTile,
  reorderBitmapTiles,
  withPixels,
  type BitmapTilesDoc
} from './msx/bitmap-tile'
import { encodeIndices } from './msx/screen'
import { MAX_BLOCK, type TileBlock } from './msx/tile'
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

// ── editing a block as one image ────────────────────────────────────────────

/**
 * Which tile of `block` a point on the block canvas lands in, and where inside
 * that tile.
 *
 * This is what lets a block be drawn on as a single picture. A block owns no
 * pixels — it is references — so a stroke across it has to be taken apart and
 * delivered to whichever tiles it crossed.
 */
export function blockTileAt(
  doc: BitmapTilesDoc,
  block: TileBlock,
  x: number,
  y: number
): { tile: number; tx: number; ty: number } | null {
  if (x < 0 || y < 0) return null
  const col = Math.floor(x / doc.width)
  const row = Math.floor(y / doc.height)
  if (col >= block.width || row >= block.height) return null
  const tile = block.tiles[row * block.width + col]
  if (tile === undefined || tile >= doc.count) return null
  return { tile, tx: x % doc.width, ty: y % doc.height }
}

/** The block composed into one image, for the canvas to draw. */
export function blockPixels(doc: BitmapTilesDoc, block: TileBlock): Uint8Array {
  const width = block.width * doc.width
  const out = new Uint8Array(width * block.height * doc.height)
  block.tiles.forEach((tile, index) => {
    if (tile >= doc.count) return
    const ox = (index % block.width) * doc.width
    const oy = Math.floor(index / block.width) * doc.height
    const pixels = tileImage(doc, tile)
    for (let y = 0; y < doc.height; y++) {
      out.set(pixels.subarray(y * doc.width, y * doc.width + doc.width), (oy + y) * width + ox)
    }
  })
  return out
}

/**
 * Paints a stroke that was drawn across a block, tile by tile.
 *
 * The same tile may appear in a block more than once, and painting it is
 * painting *the tile* — so both copies change. That is the point of a block
 * being references rather than pixels, and it is worth knowing before it
 * surprises someone.
 */
export function paintBlock(
  doc: BitmapTilesDoc,
  block: TileBlock,
  points: readonly Point[],
  color: number
): BitmapTilesDoc {
  const byTile = new Map<number, Point[]>()
  for (const point of points) {
    const hit = blockTileAt(doc, block, point.x, point.y)
    if (!hit) continue
    const list = byTile.get(hit.tile) ?? []
    list.push({ x: hit.tx, y: hit.ty })
    byTile.set(hit.tile, list)
  }
  let next = doc
  for (const [tile, local] of byTile) next = paintTile(next, tile, local, color)
  return next
}

// ── blocks ──────────────────────────────────────────────────────────────────

/**
 * A new block, on `width × height` *fresh* tiles taken from the end of the
 * bank — the same thing `createBlock` does for pattern tiles.
 *
 * It has to allocate. A block is references, so filling one with tile 0 would
 * point every cell at the same tile: the canvas would show that tile repeated,
 * and painting any cell would paint all of them. A new block is meant to be a
 * blank surface, which means blank tiles of its own.
 *
 * Returns `doc` unchanged when the bank cannot grow that far, so the caller can
 * say so rather than silently making something smaller than asked for.
 */
export function createBitmapBlock(
  doc: BitmapTilesDoc,
  name: string,
  width: number,
  height: number
): BitmapTilesDoc {
  const w = Math.max(1, Math.min(MAX_BLOCK, Math.round(width) || 1))
  const h = Math.max(1, Math.min(MAX_BLOCK, Math.round(height) || 1))
  const start = doc.count
  if (start + w * h > MAX_BITMAP_TILES) return doc
  const per = doc.width * doc.height
  const pixels = new Uint8Array((start + w * h) * per)
  pixels.set(tilePixels(doc))
  const block: TileBlock = {
    name: name.trim() || `block${doc.blocks.length + 1}`,
    width: w,
    height: h,
    tiles: Array.from({ length: w * h }, (_, i) => start + i)
  }
  return {
    ...doc,
    count: start + w * h,
    pixels: encodeIndices(pixels),
    flags: [...doc.flags, ...new Array<number>(w * h).fill(0)],
    blocks: [...doc.blocks, block]
  }
}

/** Names an existing rectangle of tiles as a block — the bank's marquee, kept. */
export function blockFromBitmapTiles(
  doc: BitmapTilesDoc,
  name: string,
  width: number,
  height: number,
  tiles: readonly number[]
): BitmapTilesDoc {
  const w = Math.max(1, Math.min(MAX_BLOCK, Math.round(width) || 1))
  const h = Math.max(1, Math.min(MAX_BLOCK, Math.round(height) || 1))
  const block: TileBlock = {
    name: name.trim() || `block${doc.blocks.length + 1}`,
    width: w,
    height: h,
    tiles: Array.from({ length: w * h }, (_, i) => {
      const tile = tiles[i] ?? 0
      return tile >= 0 && tile < doc.count ? tile : 0
    })
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
  return blockFromBitmapTiles(doc, name, width, height, tiles)
}
