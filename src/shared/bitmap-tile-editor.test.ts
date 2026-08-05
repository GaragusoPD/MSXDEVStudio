import { describe, expect, it } from 'vitest'
import {
  addBitmapTile,
  blockPixels,
  blockTileAt,
  paintBlock,
  bitmapFillPoints,
  bitmapToolPoints,
  blockFromSelection,
  createBitmapBlock,
  paintTile,
  removeBitmapBlock,
  renameBitmapBlock,
  setBitmapPaletteEntry,
  setBitmapTileFlagBit
} from './bitmap-tile-editor'
import { createBitmapTilesDoc, getTilePixel, tileImage } from './msx/bitmap-tile'

describe('bitmap tile editing', () => {
  it('fills at the tile\'s own size, not the 8×8 name-table cell', () => {
    // A 16-wide tile: a fill from one corner must reach the far side.
    const pixels = new Uint8Array(16 * 4)
    const points = bitmapFillPoints(pixels, { x: 0, y: 0 }, 16, 4)
    expect(points).toHaveLength(16 * 4)
    expect(points.some((p) => p.x === 15)).toBe(true)
  })

  it('stops a fill at a different colour', () => {
    const pixels = new Uint8Array(16 * 2)
    for (let y = 0; y < 2; y++) pixels[y * 16 + 8] = 3
    const points = bitmapFillPoints(pixels, { x: 0, y: 0 }, 16, 2)
    expect(points).toHaveLength(16)
    expect(points.every((p) => p.x < 8)).toBe(true)
  })

  it('routes each tool to its geometry', () => {
    const pixels = new Uint8Array(8 * 8)
    expect(bitmapToolPoints('rect', { x: 0, y: 0 }, { x: 2, y: 2 }, pixels, 8, 8)).toHaveLength(8)
    expect(bitmapToolPoints('line', { x: 0, y: 0 }, { x: 3, y: 0 }, pixels, 8, 8)).toHaveLength(4)
    expect(bitmapToolPoints('fill', { x: 0, y: 0 }, { x: 0, y: 0 }, pixels, 8, 8)).toHaveLength(64)
  })

  it('paints only inside the tile and reports no change when nothing moved', () => {
    const doc = createBitmapTilesDoc('sc5', 8, 8, 2)
    const painted = paintTile(doc, 1, [{ x: 1, y: 1 }, { x: 99, y: 0 }], 5)
    expect(getTilePixel(painted, 1, 1, 1)).toBe(5)
    // Painting the same colour again is not an edit — the session relies on this
    // to keep a no-op drag out of the undo stack.
    expect(paintTile(painted, 1, [{ x: 1, y: 1 }], 5)).toBe(painted)
  })

  it('sets and clears one flag bit', () => {
    let doc = createBitmapTilesDoc('sc5', 8, 8, 2)
    doc = setBitmapTileFlagBit(doc, 1, 0, true)
    doc = setBitmapTileFlagBit(doc, 1, 3, true)
    expect(doc.flags[1]).toBe(0b1001)
    doc = setBitmapTileFlagBit(doc, 1, 0, false)
    expect(doc.flags[1]).toBe(0b1000)
    expect(doc.flags[0]).toBe(0)
  })

  it('grows the bank at the end so nothing renumbers', () => {
    let doc = createBitmapTilesDoc('sc5', 8, 8, 2)
    doc = paintTile(doc, 0, [{ x: 0, y: 0 }], 7)
    doc = { ...doc, blocks: [{ name: 'b', width: 1, height: 1, tiles: [1] }] }
    const grown = addBitmapTile(doc)
    expect(grown.count).toBe(3)
    expect(grown.flags).toHaveLength(3)
    expect(getTilePixel(grown, 0, 0, 0)).toBe(7)
    expect(grown.blocks[0].tiles).toEqual([1])
    expect([...tileImage(grown, 2)].every((v) => v === 0)).toBe(true)
  })

  it('keeps a palette edit inside the palette', () => {
    const doc = createBitmapTilesDoc('sc5', 8, 8, 1)
    expect(setBitmapPaletteEntry(doc, 2, 0x777).palette?.[2]).toBe(0x777)
    // Out of range is ignored rather than growing the array.
    expect(setBitmapPaletteEntry(doc, 99, 1)).toBe(doc)
  })

  it('adds, renames and removes blocks', () => {
    let doc = createBitmapTilesDoc('sc5', 8, 8, 4)
    doc = createBitmapBlock(doc, 'door', 2, 2)
    // A new block gets tiles of its own, appended to the bank — not four
    // references to tile 0, which would repeat one tile across the whole block
    // and make painting any cell paint all of them.
    expect(doc.count).toBe(8)
    expect(doc.blocks[0]).toMatchObject({ name: 'door', width: 2, height: 2, tiles: [4, 5, 6, 7] })
    expect(new Set(doc.blocks[0].tiles).size).toBe(4)
    doc = renameBitmapBlock(doc, 0, 'gate')
    expect(doc.blocks[0].name).toBe('gate')
    doc = removeBitmapBlock(doc, 0)
    expect(doc.blocks).toHaveLength(0)
  })

  it('cuts a block out of the bank grid at the shown column count', () => {
    const doc = createBitmapTilesDoc('sc5', 8, 8, 32)
    // A 2×2 starting at tile 5 of a 16-wide grid is 5, 6, 21, 22.
    const next = blockFromSelection(doc, 'corner', 16, 5, 2, 2)
    expect(next.blocks[0].tiles).toEqual([5, 6, 21, 22])
  })

  it('points a block cell past the end of the bank at tile 0', () => {
    const doc = createBitmapTilesDoc('sc5', 8, 8, 4)
    const next = blockFromSelection(doc, 'edge', 16, 3, 2, 1)
    expect(next.blocks[0].tiles).toEqual([3, 0])
  })

  it('names a marquee that runs past the end of a grid row', () => {
    const doc = createBitmapTilesDoc('sc5', 16, 16, 48)
    // 2×2 from tile 30 of a 16-wide grid: 30, 31, 46, 47 — the wrap is the grid's.
    expect(blockFromSelection(doc, 'edge', 16, 30, 2, 2).blocks[0].tiles).toEqual([30, 31, 46, 47])
  })

  it('falls back to a default name when none is given', () => {
    const doc = createBitmapTilesDoc('sc5', 8, 8, 4)
    expect(createBitmapBlock(doc, '   ', 1, 1).blocks[0].name).toBe('block1')
  })

  it('finds which tile of a block a point lands in', () => {
    const doc = createBitmapTilesDoc('sc5', 8, 8, 4)
    const block = { name: 'b', width: 2, height: 2, tiles: [0, 1, 2, 3] }
    expect(blockTileAt(doc, block, 0, 0)).toEqual({ tile: 0, tx: 0, ty: 0 })
    expect(blockTileAt(doc, block, 9, 2)).toEqual({ tile: 1, tx: 1, ty: 2 })
    expect(blockTileAt(doc, block, 3, 11)).toEqual({ tile: 2, tx: 3, ty: 3 })
    // Outside the block is not clamped into it.
    expect(blockTileAt(doc, block, 16, 0)).toBeNull()
    expect(blockTileAt(doc, block, -1, 0)).toBeNull()
  })

  it('composes a block into one image', () => {
    let doc = createBitmapTilesDoc('sc5', 8, 8, 4)
    doc = paintTile(doc, 1, [{ x: 0, y: 0 }], 6)
    const pixels = blockPixels(doc, { name: 'b', width: 2, height: 1, tiles: [0, 1] })
    // Tile 1 starts at x = 8 of a 16-wide composite.
    expect(pixels).toHaveLength(16 * 8)
    expect(pixels[8]).toBe(6)
    expect(pixels[0]).toBe(0)
  })

  it('splits a stroke across the tiles a block spans', () => {
    let doc = createBitmapTilesDoc('sc5', 8, 8, 4)
    const block = { name: 'b', width: 2, height: 1, tiles: [0, 1] }
    doc = paintBlock(doc, block, [{ x: 7, y: 0 }, { x: 8, y: 0 }], 3)
    // One point either side of the seam: the last column of tile 0 and the
    // first of tile 1.
    expect(getTilePixel(doc, 0, 7, 0)).toBe(3)
    expect(getTilePixel(doc, 1, 0, 0)).toBe(3)
  })

  it('paints every place a repeated tile is used, because a block is references', () => {
    let doc = createBitmapTilesDoc('sc5', 8, 8, 2)
    // The same tile twice in one block: painting one copy paints the tile.
    doc = paintBlock(doc, { name: 'b', width: 2, height: 1, tiles: [1, 1] }, [{ x: 0, y: 0 }], 4)
    expect(getTilePixel(doc, 1, 0, 0)).toBe(4)
  })

  it('paints one cell of a new block without touching the others', () => {
    let doc = createBitmapBlock(createBitmapTilesDoc('sc5', 8, 8, 1), 'b', 2, 1)
    const block = doc.blocks[0]
    doc = paintBlock(doc, block, [{ x: 0, y: 0 }], 5)
    expect(getTilePixel(doc, block.tiles[0], 0, 0)).toBe(5)
    expect(getTilePixel(doc, block.tiles[1], 0, 0)).toBe(0)
  })

  it('refuses a block the bank has no room for', () => {
    const doc = createBitmapTilesDoc('sc5', 8, 8, 255)
    expect(createBitmapBlock(doc, 'huge', 2, 2)).toBe(doc)
  })
})
