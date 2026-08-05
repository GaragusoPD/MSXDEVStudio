import { describe, expect, it } from 'vitest'
import {
  bitmapBlockBytes,
  bitmapTileBytes,
  createBitmapTilesDoc,
  getTilePixel,
  normalizeBitmapTiles,
  removeBitmapTile,
  reorderBitmapTiles,
  resizeTiles,
  setTileImage,
  setTilePixel,
  sheetCols,
  sheetPixels,
  sliceImage,
  tileImage,
  validateBitmapTiles
} from './bitmap-tile'
import { resourceTables, renderResourceFiles } from './resource'
import { encodeIndices } from './screen'

/** An `w × h` image whose every cell is filled with a distinct colour, cell by cell. */
function checker(cols: number, rows: number, cell: number): { indices: Uint8Array; width: number; height: number } {
  const width = cols * cell
  const height = rows * cell
  const indices = new Uint8Array(width * height)
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const color = (row * cols + col) % 16
      for (let y = 0; y < cell; y++) indices.fill(color, (row * cell + y) * width + col * cell, (row * cell + y) * width + col * cell + cell)
    }
  }
  return { indices, width, height }
}

describe('bitmap tileset', () => {
  it('defaults to a 16×16 sc5 bank and keeps the tile size it is given', () => {
    expect(createBitmapTilesDoc().width).toBe(16)
    const wide = createBitmapTilesDoc('sc5', 32, 8, 4)
    expect([wide.width, wide.height, wide.count]).toEqual([32, 8, 4])
  })

  it('reads and writes single pixels', () => {
    let doc = createBitmapTilesDoc('sc5', 8, 8, 2)
    expect(getTilePixel(doc, 1, 3, 4)).toBe(0)
    doc = setTilePixel(doc, 1, 3, 4, 9)
    expect(getTilePixel(doc, 1, 3, 4)).toBe(9)
    // …and only that pixel, in only that tile.
    expect(getTilePixel(doc, 0, 3, 4)).toBe(0)
    expect(getTilePixel(doc, 1, 4, 4)).toBe(0)
  })

  it('ignores edits outside the bank instead of throwing', () => {
    const doc = createBitmapTilesDoc('sc5', 8, 8, 1)
    expect(setTilePixel(doc, 5, 0, 0, 1)).toBe(doc)
    expect(setTilePixel(doc, 0, 99, 0, 1)).toBe(doc)
    expect(getTilePixel(doc, 0, -1, 0)).toBe(0)
  })

  it('cuts an image into tiles', () => {
    const source = checker(4, 2, 16)
    const { doc, cells, sourceCols, sourceRows } = sliceImage(
      createBitmapTilesDoc('sc5', 16, 16, 1), source.indices, source.width, source.height
    )
    expect([sourceCols, sourceRows]).toEqual([4, 2])
    expect(doc.count).toBe(8)
    expect(cells).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    // Tile 5 is the sixth cell, which the fixture filled with colour 5.
    expect([...tileImage(doc, 5)].every((value) => value === 5)).toBe(true)
  })

  it('collapses repeats when asked, and reports where each cell went', () => {
    const source = checker(4, 2, 8)
    // Make the second row a copy of the first, so half the cells are repeats.
    const half = source.width * 8
    source.indices.set(source.indices.subarray(0, half), half)
    const plain = sliceImage(createBitmapTilesDoc('sc5', 8, 8, 1), source.indices, source.width, source.height)
    const deduped = sliceImage(
      createBitmapTilesDoc('sc5', 8, 8, 1), source.indices, source.width, source.height, { dedupe: true }
    )
    expect(plain.doc.count).toBe(8)
    expect(deduped.doc.count).toBe(4)
    expect(deduped.cells).toEqual([0, 1, 2, 3, 0, 1, 2, 3])
  })

  it('points overflow cells at tile 0 rather than past the end of the bank', () => {
    const source = checker(4, 1, 8)
    const { doc, cells } = sliceImage(
      createBitmapTilesDoc('sc5', 8, 8, 1), source.indices, source.width, source.height, { limit: 2 }
    )
    expect(doc.count).toBe(2)
    expect(cells).toEqual([0, 1, 0, 0])
  })

  it('lays the sheet out as a grid that fits VRAM', () => {
    const doc = createBitmapTilesDoc('sc5', 16, 16, 20)
    expect(sheetCols(doc)).toBe(16)
    const sheet = sheetPixels(doc)
    expect([sheet.width, sheet.height]).toEqual([256, 32])
    // sc5 packs two pixels per byte.
    expect(bitmapTileBytes(doc)).toHaveLength((256 * 32) / 2)
  })

  it('places each tile where the draw helper will look for it', () => {
    let doc = createBitmapTilesDoc('sc5', 16, 16, 20)
    doc = setTileImage(doc, 17, new Uint8Array(16 * 16).fill(7))
    const sheet = sheetPixels(doc)
    // Tile 17 with 16 columns is row 1, column 1 → pixel (16, 16).
    expect(sheet.indices[16 * sheet.width + 16]).toBe(7)
    expect(sheet.indices[0]).toBe(0)
  })

  it('renumbers flags and blocks when a tile is removed', () => {
    let doc = createBitmapTilesDoc('sc5', 8, 8, 4)
    doc = { ...doc, flags: [0, 1, 2, 3], blocks: [{ name: 'gate', width: 2, height: 1, tiles: [1, 3] }] }
    const { doc: after } = removeBitmapTile(doc, 1)
    expect(after.count).toBe(3)
    expect(after.flags).toEqual([0, 2, 3])
    // Tile 3 slid down to 2; the removed tile's reference falls back to 0.
    expect(after.blocks[0].tiles).toEqual([0, 2])
  })

  it('renumbers flags and blocks when a tile moves', () => {
    let doc = createBitmapTilesDoc('sc5', 8, 8, 3)
    doc = setTileImage(doc, 0, new Uint8Array(64).fill(4))
    doc = { ...doc, flags: [1, 0, 0], blocks: [{ name: 'b', width: 1, height: 1, tiles: [0] }] }
    const { doc: after } = reorderBitmapTiles(doc, 0, 2)
    expect([...tileImage(after, 2)].every((v) => v === 4)).toBe(true)
    expect(after.flags).toEqual([0, 0, 1])
    expect(after.blocks[0].tiles).toEqual([2])
  })

  it('crops rather than scaling when the tile size changes', () => {
    let doc = createBitmapTilesDoc('sc5', 16, 16, 1)
    doc = setTilePixel(doc, 0, 2, 2, 6)
    doc = setTilePixel(doc, 0, 12, 12, 5)
    const smaller = resizeTiles(doc, 8, 8)
    expect([smaller.width, smaller.height]).toEqual([8, 8])
    expect(getTilePixel(smaller, 0, 2, 2)).toBe(6)
    // The pixel outside the new tile is gone, not squeezed in.
    expect(getTilePixel(smaller, 0, 7, 7)).toBe(0)
  })

  it('survives a hand-edited file that is short of pixels or flags', () => {
    const doc = normalizeBitmapTiles({ mode: 'sc5', width: 8, height: 8, count: 3, pixels: encodeIndices(new Uint8Array(10)), flags: [5] })
    expect(doc.count).toBe(3)
    expect(doc.flags).toEqual([5, 0, 0])
    expect(getTilePixel(doc, 2, 7, 7)).toBe(0)
  })

  it('reports a colour the mode cannot show, and a block pointing at nothing', () => {
    let doc = createBitmapTilesDoc('sc5', 8, 8, 1)
    doc = setTilePixel(doc, 0, 0, 0, 200)
    doc = { ...doc, blocks: [{ name: 'b', width: 1, height: 1, tiles: [9] }] }
    expect(validateBitmapTiles(doc).join(' ')).toMatch(/cannot show/)
    expect(validateBitmapTiles(doc).join(' ')).toMatch(/no longer exists/)
  })

  it('exports the sheet, and flags only once a tile carries one', () => {
    const doc = createBitmapTilesDoc('sc5', 16, 16, 4)
    expect(resourceTables({ kind: 'btiles', doc }).map((t) => t.suffix)).toEqual(['_Tiles', '_Palette'])
    const flagged = { ...doc, flags: [0, 1, 0, 0] }
    expect(resourceTables({ kind: 'btiles', doc: flagged }).map((t) => t.suffix)).toContain('_Flags')
  })

  it('emits blocks and their placement defines', () => {
    const doc = {
      ...createBitmapTilesDoc('sc5', 16, 16, 4),
      blocks: [{ name: 'door', width: 2, height: 2, tiles: [0, 1, 2, 3] }]
    }
    expect([...bitmapBlockBytes(doc)]).toEqual([0, 1, 2, 3])
    const { header } = renderResourceFiles({ kind: 'btiles', doc }, 'res/wall.btiles.json', {
      name: 'g_Wall', format: 'c', out: 'content/wall.h', helpers: true
    })
    expect(header).toContain('#define G_WALL_TILE_W 16')
    expect(header).toContain('#define G_WALL_COLS 16')
    expect(header).toContain('#define G_WALL_DOOR_BASE 0')
    expect(header).toContain('#define G_WALL_DOOR_W 2')
    // The helper is worth having with no blocks at all, unlike pattern tiles.
    expect(header).toMatch(/void g_Wall_Draw\(u8 tile/)
    expect(header).toMatch(/void g_Wall_Upload\(UY sheetY\)/)
  })
})
