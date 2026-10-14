import { describe, expect, it } from 'vitest'
import { bankTilePixels, MAX_TILES, normalizeTiles, TILE_SIZE, tilePixels, type TileEntry, type TilesDoc } from './tile'
import { cellEntry, compactTileset, composePicture, pictureExtent, placePicture } from './tile-compact'

/** A tile whose first row's pattern is `mark` — distinct art per mark, ink 15 on paper 1. */
function tile(mark: number): TileEntry {
  return { pattern: [mark, 0, 0, 0, 0, 0, 0, 0], color: new Array(8).fill(0xf1) }
}

function doc(entries: TileEntry[], extra: Partial<TilesDoc> = {}): TilesDoc {
  return normalizeTiles({ mode: 'sc2', count: entries.length, tiles: entries, ...extra })
}

const pixels = (d: TilesDoc, i: number): string => tilePixels(d, i).join(',')

describe('compactTileset', () => {
  it('drops unused tiles, keeps order, and maps the survivors down', () => {
    const before = doc([tile(1), tile(2), tile(3), tile(4), tile(5)])
    const result = compactTileset(before, [0, 2, 4])
    expect(result.refused).toBeUndefined()
    expect(result.removed).toBe(2)
    expect(result.doc.count).toBe(3)
    expect(result.mapping.slice(0, 5)).toEqual([0, 0, 1, 0, 2])
    for (const old of [0, 2, 4]) expect(pixels(result.doc, result.mapping[old])).toBe(pixels(before, old))
  })

  it('returns the same document when there is nothing to do', () => {
    const before = doc([tile(1), tile(2)])
    const result = compactTileset(before, [0, 1], { merge: true })
    expect(result.doc).toBe(before)
    expect(result.removed + result.merged).toBe(0)
  })

  it('merges tiles that draw the same pixels even when their bytes differ', () => {
    // Solid colour 15 two ways: all-ink and all-paper.
    const ink: TileEntry = { pattern: new Array(8).fill(0xff), color: new Array(8).fill(0xf1) }
    const paper: TileEntry = { pattern: new Array(8).fill(0), color: new Array(8).fill(0x1f) }
    const before = doc([tile(1), ink, paper, tile(3)])
    const result = compactTileset(before, [0, 1, 2, 3], { merge: true })
    expect(result.merged).toBe(1)
    expect(result.doc.count).toBe(3)
    expect(result.mapping[2]).toBe(result.mapping[1])
    expect(result.mapping[3]).toBe(2)
  })

  it('does not merge look-alikes that mean different things to the game', () => {
    const before = doc([tile(1), tile(1)], { flags: [0, 1] })
    expect(compactTileset(before, [0, 1], { merge: true }).merged).toBe(0)
  })

  it('without merge, leaves duplicates alone', () => {
    const before = doc([tile(1), tile(1), tile(2)])
    const result = compactTileset(before, [0, 1, 2])
    expect(result.doc).toBe(before)
  })

  it('keeps a reserved tile 0 and every tile a block references', () => {
    const before = doc([tile(0), tile(1), tile(2), tile(3)], {
      reserveTile0: true,
      blocks: [{ name: 'b', width: 1, height: 1, tiles: [3] }]
    })
    const result = compactTileset(before, [])
    expect(result.doc.count).toBe(2)
    expect(result.mapping[0]).toBe(0)
    expect(result.mapping[3]).toBe(1)
    expect(result.doc.blocks[0].tiles).toEqual([1])
  })

  it('carries flags with their tiles', () => {
    const before = doc([tile(1), tile(2), tile(3)], { flags: [0, 4, 9] })
    const result = compactTileset(before, [0, 2])
    expect(result.doc.flags).toEqual([0, 9])
  })

  it("keeps an attached animation's window, even unused and identical to another tile", () => {
    const before = doc([tile(1), tile(2), tile(2), tile(3)], {
      animations: [{ path: 'res/a.anim-tiles.json', slot: 2, bank: null, name: 'g_A', width: 1, height: 1, frames: 2, colorsVary: false, loop: 'loop' }]
    })
    const result = compactTileset(before, [0, 1], { merge: true })
    // Tile 3 goes; tile 2 stays itself (not merged into 1) and moves nowhere.
    expect(result.doc.count).toBe(3)
    expect(result.mapping[2]).toBe(2)
    expect(result.doc.animations[0].slot).toBe(2)
  })

  it('moves a window down with the tiles under it', () => {
    const before = doc([tile(1), tile(2), tile(3), tile(4)], {
      animations: [{ path: 'res/a.anim-tiles.json', slot: 3, bank: null, name: 'g_A', width: 1, height: 1, frames: 2, colorsVary: false, loop: 'loop' }]
    })
    const result = compactTileset(before, [0])
    expect(result.doc.animations[0].slot).toBe(1)
  })

  it('refuses a banked tileset', () => {
    const before = normalizeTiles({ mode: 'sc2', count: 1, bankTiles: [[tile(1)], [], []] })
    const result = compactTileset(before, [])
    expect(result.refused).toMatch(/banked/)
    expect(result.doc).toBe(before)
  })

  describe('SCREEN 1, where colour belongs to groups of eight', () => {
    function sc1(count: number, groupColors: number[]): TilesDoc {
      return normalizeTiles({
        mode: 'sc1',
        count,
        tiles: Array.from({ length: count }, (_, i) => ({ pattern: [i + 1, 0, 0, 0, 0, 0, 0, 0], color: [] })),
        groupColors
      })
    }

    it('never moves a tile into a group with another pair', () => {
      // Group 0 is red-on-black, group 1 green-on-black; drop most of group 0.
      const before = sc1(16, [0x81, 0x21])
      const used = [0, 8, 9, 10]
      const result = compactTileset(before, used)
      expect(result.refused).toBeUndefined()
      for (const old of used) expect(pixels(result.doc, result.mapping[old])).toBe(pixels(before, old))
      // Tile 0 stays in group 0; the green ones start a fresh group.
      expect(result.mapping[8]).toBe(8)
      expect(result.doc.count).toBe(11)
    })

    it('packs tiles that share a pair into one group', () => {
      const before = sc1(16, [0x81, 0x81])
      const result = compactTileset(before, [0, 8, 9])
      expect(result.mapping[8]).toBe(1)
      expect(result.doc.count).toBe(3)
    })
  })
})

describe('compactTileset with meta-tiles attached', () => {
  const blank = (): TileEntry => ({ pattern: new Array(TILE_SIZE).fill(0), color: new Array(TILE_SIZE).fill(0) })
  const mark = (value: number): TileEntry => ({ pattern: new Array(TILE_SIZE).fill(value), color: new Array(TILE_SIZE).fill(0xf1) })

  it('keeps every tile an attached meta shows, renumbers its cells, and never packs one onto tile 0', () => {
    // Tile 0 unused and unreserved; tiles 1-2 unused; 3 and 4 are the meta's,
    // 4 an opaque blank identical to tile 0.
    const doc = normalizeTiles({
      mode: 'sc2',
      count: 5,
      tiles: [blank(), mark(1), mark(2), mark(3), blank()],
      metas: [{ path: 'res/rock.meta-tiles.json', name: 'g_Rock', width: 3, height: 1, flags: 0, frames: 1, cells: [3, 0, 4] }]
    })
    const result = compactTileset(doc, [], { merge: true })
    expect(result.refused).toBeUndefined()
    expect(result.doc.count).toBe(3)
    expect(result.doc.metas[0].cells).toEqual([1, 0, 2])
    expect(result.doc.tiles[1].pattern[0]).toBe(3)
  })
})

describe('cellEntry', () => {
  it('turns an empty cell into the canonical blank', () => {
    const cell = cellEntry(new Uint8Array(64), 'sc2')
    expect(cell.entry.pattern.every((b) => b === 0)).toBe(true)
    expect(cell.entry.color.every((b) => b === 0)).toBe(true)
  })

  it('reports the pixels the hardware will actually draw', () => {
    const input = new Uint8Array(64)
    input[0] = 15
    input[1] = 4
    input[2] = 6 // a third colour in row 0: lossy
    const cell = cellEntry(input, 'sc2')
    expect(cell.lossy).toBe(true)
    expect(new Set(cell.pixels.subarray(0, 8)).size).toBeLessThanOrEqual(2)
  })

  it('gives SCREEN 1 one pair for the whole cell', () => {
    const input = new Uint8Array(64).fill(4)
    input[0] = 15
    const cell = cellEntry(input, 'sc1')
    expect(cell.pair).toBe(0x4f)
    expect(cell.entry.color).toEqual([])
    expect(cell.pixels[0]).toBe(15)
    expect(cell.pixels[1]).toBe(4)
  })
})

describe('pictures', () => {
  it('pictureExtent covers partial cells and clips to the grid', () => {
    expect(pictureExtent({ width: 4, height: 4 }, { width: 12, height: 40, indices: [] })).toEqual({ x: 0, y: 0, cols: 2, rows: 4 })
  })

  it('pictureExtent starts where the picture was dropped and clips at every edge', () => {
    const picture = { width: 24, height: 16, indices: [] }
    expect(pictureExtent({ width: 10, height: 10 }, picture, { x: 3, y: 2 })).toEqual({ x: 3, y: 2, cols: 3, rows: 2 })
    expect(pictureExtent({ width: 10, height: 10 }, picture, { x: 8, y: 9 })).toEqual({ x: 8, y: 9, cols: 2, rows: 1 })
    expect(pictureExtent({ width: 10, height: 10 }, picture, { x: -2, y: -1 })).toEqual({ x: 0, y: 0, cols: 1, rows: 1 })
  })

  it('composePicture keeps the base where the picture does not reach', () => {
    const base = { width: 16, height: 8, indices: new Uint8Array(128).fill(7) }
    const out = composePicture(base, { width: 4, height: 2, indices: new Uint8Array(8).fill(3) })
    expect(out[0]).toBe(3)
    expect(out[4]).toBe(7)
    expect(out[16 * 2]).toBe(7)
  })

  it('composePicture lays the picture at an offset, clipped, and lets the see-through value show the base', () => {
    const base = { width: 16, height: 8, indices: new Uint8Array(128).fill(7) }
    const indices = new Uint8Array([3, 0, 3, 3])
    const out = composePicture(base, { width: 2, height: 2, indices }, { x: 15, y: 7 }, 0)
    // Only the top-left dot of the picture lands on the base.
    expect(out[7 * 16 + 15]).toBe(3)
    expect([...out].filter((v) => v === 3)).toHaveLength(1)
    const holes = composePicture(base, { width: 2, height: 2, indices }, { x: 4, y: 2 }, 0)
    expect(holes[2 * 16 + 4]).toBe(3)
    expect(holes[2 * 16 + 5]).toBe(7)
    // Without a see-through value, 0 is just a colour.
    expect(composePicture(base, { width: 2, height: 2, indices }, { x: 4, y: 2 })[2 * 16 + 5]).toBe(0)
  })
})

describe('placePicture', () => {
  /** A `cols × rows` cell picture where each cell is solid in the colour `colorOf(cx, cy)`. */
  function solid(cols: number, rows: number, colorOf: (cx: number, cy: number) => number): Uint8Array {
    const width = cols * TILE_SIZE
    const out = new Uint8Array(width * rows * TILE_SIZE)
    for (let y = 0; y < rows * TILE_SIZE; y++) {
      for (let x = 0; x < width; x++) out[y * width + x] = colorOf(Math.floor(x / TILE_SIZE), Math.floor(y / TILE_SIZE))
    }
    return out
  }

  it('dedups the picture and reuses art the tileset already has', () => {
    const tiles = normalizeTiles({
      mode: 'sc2',
      count: 2,
      reserveTile0: true,
      tiles: [tile(0), { pattern: new Array(8).fill(0), color: new Array(8).fill(0x1c) }]
    })
    const grid = { width: 4, height: 2, tiles: new Array(8).fill(0) }
    // Colours: 12 (already tile 1), 0 (tile 0), 5 (new) twice.
    const pic = solid(4, 2, (cx, cy) => [12, 0, 5, 5][cx] * (cy === 0 ? 1 : 0))
    const result = placePicture(grid, tiles, pic, 4, 2)
    expect(result.refused).toBeUndefined()
    expect(result.added).toBe(1)
    expect(result.grid.tiles.slice(0, 4)).toEqual([1, 0, 2, 2])
    expect(result.grid.tiles.slice(4)).toEqual([0, 0, 0, 0])
    expect(tilePixels(result.tiles, 2).every((v) => v === 5)).toBe(true)
  })

  it('only touches the cells it was given', () => {
    const tiles = normalizeTiles({ mode: 'sc2', count: 1 })
    const grid = { width: 3, height: 1, tiles: [9, 9, 9] }
    const result = placePicture(grid, tiles, solid(3, 1, () => 4), 2, 1)
    expect(result.grid.tiles[2]).toBe(9)
  })

  it('places the block at the origin it is given, and nowhere else', () => {
    const tiles = normalizeTiles({ mode: 'sc2', count: 1 })
    const grid = { width: 4, height: 3, tiles: new Array(12).fill(9) }
    // The whole-grid rendering: cell (2,1) solid 5, everything else 0.
    const pic = solid(4, 3, (cx, cy) => (cx === 2 && cy === 1 ? 5 : 0))
    const result = placePicture(grid, tiles, pic, 1, 1, { origin: { x: 2, y: 1 } })
    expect(result.refused).toBeUndefined()
    expect(result.added).toBe(1)
    expect(result.grid.tiles.filter((t) => t !== 9)).toHaveLength(1)
    expect(tilePixels(result.tiles, result.grid.tiles[1 * 4 + 2]).every((v) => v === 5)).toBe(true)
  })

  it('is all or nothing when the tileset runs out', () => {
    const tiles = normalizeTiles({ mode: 'sc2', count: MAX_TILES - 1 })
    const grid = { width: 4, height: 1, tiles: [0, 0, 0, 0] }
    // Four distinct, new tiles; room for one.
    const pic = new Uint8Array(32 * 8)
    for (let cx = 0; cx < 4; cx++) pic[cx * 8] = 2 + cx
    const result = placePicture(grid, tiles, pic, 4, 1)
    expect(result.refused).toMatch(/ran out of room/)
    expect(result.tiles).toBe(tiles)
    expect(result.grid).toBe(grid)
  })

  it("allocates in the row's own bank on a banked tileset", () => {
    const blank: TileEntry = { pattern: new Array(8).fill(0), color: new Array(8).fill(0) }
    const tiles = normalizeTiles({ mode: 'sc2', count: 1, bankTiles: [[blank], [blank], [blank]] })
    const grid = { width: 1, height: 24, tiles: new Array(24).fill(0) }
    const pic = solid(1, 24, (_, cy) => (cy === 10 ? 6 : 0))
    const bankOf = (row: number): number => Math.floor(row / 8)
    const result = placePicture(grid, tiles, pic, 1, 24, { bankOf })
    expect(result.refused).toBeUndefined()
    expect(result.tiles.bankTiles[1].length).toBe(2)
    expect(result.tiles.bankTiles[0].length).toBe(1)
    expect(result.tiles.sharedTiles).toBe(0)
    expect(bankTilePixels(result.tiles, 1, result.grid.tiles[10]).every((v) => v === 6)).toBe(true)
  })
})
