import { describe, expect, it } from 'vitest'
import { MSX1_PALETTE_RGB } from './palette'
import { createBitmapTilesDoc, tileImage } from './bitmap-tile'
import {
  cellsToBitmapMeta,
  cellsToBitmapTiles,
  cellsToOwnedMeta,
  cellsToSprite,
  cellsToSwSprite,
  cellsToTileAnim,
  cellsToTiles,
  layoutCells,
  selectionPicture,
  unusedEntries,
  type SheetCell
} from './sheet-convert'
import { normalizeSwSprites, swFramePixels } from './swsprite'
import { compositeFrame } from './sprite'
import { MAX_TILES, normalizeTiles, tilePixels, TILE_SIZE } from './tile'

/** A cell painted by `at(x, y)` → palette index (0 transparent). */
function cell(width: number, height: number, at: (x: number, y: number) => number): SheetCell {
  const indices = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) indices[y * width + x] = at(x, y)
  return { width, height, indices }
}

/** A deterministic pseudo-random sequence, so a failing case can be replayed. */
function random(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state / 0x7fffffff
  }
}

describe('cells into a tileset', () => {
  const tileset = () => normalizeTiles({ mode: 'sc2', count: 1, reserveTile0: true })

  it('draws each cell back exactly, sharing the tiles two cells have in common', () => {
    // Two 16×16 cells: a brick, and the same brick with its bottom row of tiles
    // replaced by plain red.
    const brick = (x: number, y: number): number => ((x + (y >> 2)) % 4 === 0 ? 6 : 8)
    const a = cell(16, 16, brick)
    const b = cell(16, 16, (x, y) => (y < 8 ? brick(x, y) : 8))
    const result = cellsToTiles(tileset(), [a, b], ['brick', 'brick_top'])
    expect(result.refused).toBeUndefined()
    // a: 4 distinct tiles at most; b's top row reuses a's, its bottom row is one red tile twice.
    expect(result.cellTiles[1].slice(0, 2)).toEqual(result.cellTiles[0].slice(0, 2))
    expect(result.cellTiles[1][2]).toBe(result.cellTiles[1][3])
    for (const [n, source] of [a, b].entries()) {
      result.cellTiles[n].forEach((tile, i) => {
        const art = tilePixels(result.doc, tile)
        const ox = (i % 2) * TILE_SIZE
        const oy = Math.floor(i / 2) * TILE_SIZE
        for (let y = 0; y < TILE_SIZE; y++) for (let x = 0; x < TILE_SIZE; x++) expect(art[y * TILE_SIZE + x]).toBe(source.indices[(oy + y) * 16 + ox + x])
      })
    }
    expect(result.doc.blocks.map((block) => [block.name, block.width, block.height, block.tiles])).toEqual([
      ['brick', 2, 2, result.cellTiles[0]],
      ['brick_top', 2, 2, result.cellTiles[1]]
    ])
  })

  it('sends a transparent tile to the reserved blank tile 0', () => {
    const result = cellsToTiles(tileset(), [cell(16, 8, (x) => (x < 8 ? 0 : 15))])
    expect(result.cellTiles[0][0]).toBe(0)
    expect(result.cellTiles[0][1]).not.toBe(0)
  })

  it('refuses a selection the tileset has no room for, changing nothing', () => {
    const full = normalizeTiles({ mode: 'sc2', count: MAX_TILES - 1 })
    const next = random(1)
    const cells = [cell(32, 8, () => 1 + Math.floor(next() * 15))]
    const result = cellsToTiles(full, cells)
    expect(result.refused).toMatch(/ran out of room/)
    expect(result.doc).toBe(full)
  })

  it('lays the cells out as on the sheet, for a map beside a new tileset', () => {
    // Cells at sheet (0,0) and (2,1), each one tile.
    expect(layoutCells([[5], [7]], [{ col: 0, row: 0 }, { col: 2, row: 1 }], 1, 1)).toEqual({
      width: 3,
      height: 2,
      tiles: [5, 0, 0, 0, 0, 7]
    })
  })

  it('lays the cells out as one picture for a map, see-through where nothing was selected', () => {
    const picture = selectionPicture([cell(2, 2, () => 3), cell(2, 2, () => 4)], [{ col: 1, row: 0 }, { col: 0, row: 1 }])
    expect([picture.width, picture.height]).toEqual([4, 4])
    expect(Array.from(picture.indices)).toEqual([0, 0, 3, 3, 0, 0, 3, 3, 4, 4, 0, 0, 4, 4, 0, 0])
  })
})

describe('cells into poses', () => {
  it('an animated tile: one pose per cell, the cell its window', () => {
    const frames = [0x18, 0x3c, 0x7e].map((mark) => cell(16, 8, (x, y) => (x < 8 && (mark & (0x80 >> x)) ? 9 : y < 4 ? 1 : 4)))
    const result = cellsToTileAnim('sc2', frames, 6)
    if (typeof result === 'string') throw new Error(result)
    expect([result.doc.width, result.doc.height, result.doc.frames.length]).toEqual([2, 1, 3])
    // Which colour is ink is the encoder's choice; what the top row draws is not.
    const drawn = (tile: { pattern: number[]; color: number[] }, y: number): number[] =>
      Array.from({ length: 8 }, (_, x) => (tile.pattern[y] & (0x80 >> x) ? tile.color[y] >> 4 : tile.color[y] & 0x0f))
    result.doc.frames.forEach((frame, f) => expect(drawn(frame.tiles[0], 0)).toEqual(Array.from({ length: 8 }, (_, x) => frames[f].indices[x])))
    expect(result.doc.frames.every((frame) => frame.duration === 6)).toBe(true)
    expect(result.lossy).toBe(0)
  })

  it('an animated tile is refused past an animation window, and pointed at meta-tiles', () => {
    expect(cellsToTileAnim('sc2', [cell(40, 32, () => 1)])).toMatch(/at most 16.*meta-tile/)
  })

  it('SCREEN 1 poses share one ink and paper, transparent as the paper', () => {
    const result = cellsToTileAnim('sc1', [cell(8, 8, (x) => (x < 3 ? 11 : 0)), cell(8, 8, (x) => (x < 5 ? 11 : 0))])
    if (typeof result === 'string') throw new Error(result)
    expect(result.doc.pair).toBe(0xb0)
    expect(result.doc.frames.map((frame) => frame.tiles[0].pattern[0])).toEqual([0xe0, 0xf8])
  })

  it('a meta-tile: a tile transparent in every pose is see-through; one that moves into it is not', () => {
    // 2×2 tiles. Top-right empty in both poses; bottom-right empty in pose 0 only.
    const pose = (reach: boolean) => cell(16, 16, (x, y) => (x < 8 ? 6 : y >= 8 && reach ? 6 : 0))
    const result = cellsToOwnedMeta('sc2', [pose(false), pose(true)])
    if (typeof result === 'string') throw new Error(result)
    expect(result.doc.holes).toEqual([false, true, false, false])
    expect(result.doc.frames).toHaveLength(2)
  })

  it('a meta-tile of nothing is refused', () => {
    expect(cellsToOwnedMeta('sc2', [cell(16, 16, () => 0)])).toMatch(/empty/)
  })
})

describe('cells into a sprite character', () => {
  const options = { palette: MSX1_PALETTE_RGB, name: 'hero', maxPlanes: 4 }

  it('mode 2: any figure with no more colours on a line than planes comes out exactly, frame after frame', () => {
    const next = random(7)
    for (let trial = 0; trial < 20; trial++) {
      // Each line uses up to three of six colours.
      const colours = [2, 4, 6, 8, 10, 15]
      const frames = Array.from({ length: 3 }, () => {
        const lines = Array.from({ length: 16 }, () => colours.filter(() => next() < 0.5).slice(0, 3))
        return cell(16, 16, (x, y) => (next() < 0.3 || !lines[y].length ? 0 : lines[y][Math.floor(next() * lines[y].length)]))
      })
      const result = cellsToSprite(frames, { ...options, mode: 2, size: 16, maxPlanes: 3 })
      if (typeof result === 'string') throw new Error(result)
      expect(result.merged).toBe(0)
      const planes = result.character.frames[0].layers.length
      expect(planes).toBeLessThanOrEqual(3)
      result.character.frames.forEach((frame, f) => {
        expect(frame.layers).toHaveLength(planes)
        expect([...compositeFrame(frame.layers, 2, 16)]).toEqual([...frames[f].indices])
      })
    }
  })

  it('mode 2 spends planes per line: six colours, two to a line, are two planes', () => {
    const frame = cell(16, 16, (x, y) => [2, 4, 6, 8, 10, 15][(Math.floor(y / 6) * 2 + (x < 8 ? 0 : 1)) % 6])
    const result = cellsToSprite([frame], { ...options, mode: 2, size: 16 })
    if (typeof result === 'string') throw new Error(result)
    expect(result.character.frames[0].layers).toHaveLength(2)
    expect([...compositeFrame(result.character.frames[0].layers, 2, 16)]).toEqual([...frame.indices])
  })

  it('mode 1: a plane per colour, and a colour past the planes goes to the nearest one kept', () => {
    // Dark red (6) everywhere but one dot of medium red (8) — 8 has no plane.
    const frame = cell(16, 16, (x, y) => (x === 0 && y === 0 ? 8 : x < 4 ? 6 : x < 8 ? 15 : 0))
    const result = cellsToSprite([frame], { ...options, mode: 1, size: 16, maxPlanes: 2 })
    if (typeof result === 'string') throw new Error(result)
    expect(result.character.frames[0].layers.map((layer) => layer.color).sort((a, b) => a - b)).toEqual([6, 15])
    expect(result.merged).toBe(1)
    expect(compositeFrame(result.character.frames[0].layers, 1, 16)[0]).toBe(6)
  })

  it('a frame bigger than a sprite is a metasprite grid, and only occupied cells cost planes', () => {
    // 32×24: a 2×2 grid of 16×16 sprites; the bottom-right quarter is empty.
    const frame = cell(32, 24, (x, y) => (x >= 16 && y >= 16 ? 0 : 15))
    const result = cellsToSprite([frame], { ...options, mode: 2, size: 16 })
    if (typeof result === 'string') throw new Error(result)
    expect([result.character.cols, result.character.rows]).toEqual([2, 2])
    expect(result.character.frames[0].layers.map((layer) => [layer.cx, layer.cy])).toEqual([
      [0, 0],
      [1, 0],
      [0, 1]
    ])
    // Two sprites side by side on the top band.
    expect(result.spritesPerLine).toBe(2)
    const shown = compositeFrame(result.character.frames[0].layers, 2, 16, 2, 2)
    for (let y = 0; y < 24; y++) for (let x = 0; x < 32; x++) expect(shown[y * 32 + x]).toBe(frame.indices[y * 32 + x])
  })

  it('pads every frame to the same planes, so the export can step by one stride', () => {
    const one = cell(16, 16, (x) => (x < 8 ? 15 : 0))
    const three = cell(16, 16, (x) => (x < 4 ? 15 : x < 8 ? 6 : x < 12 ? 2 : 0))
    const result = cellsToSprite([one, three], { ...options, mode: 1, size: 16 })
    if (typeof result === 'string') throw new Error(result)
    expect(result.character.frames.map((frame) => frame.layers.length)).toEqual([3, 3])
    expect([...compositeFrame(result.character.frames[0].layers, 1, 16)]).toEqual([...one.indices])
  })

  it('refuses a frame past a 4×4 grid', () => {
    expect(cellsToSprite([cell(80, 16, () => 15)], { ...options, mode: 2, size: 16 })).toMatch(/at most 4×4/)
  })
})

describe('MSX2: cells into a bitmap tileset', () => {
  const bank = (over: Record<string, unknown> = {}) => ({ ...createBitmapTilesDoc('sc5', 16, 16, 1), reserveTile0: true, ...over })

  it('a cell the tileset\u2019s size is one tile, matched to the pixel, and a repeat is shared', () => {
    const a = cell(16, 16, (x, y) => ((x + y) % 3) + 2)
    const result = cellsToBitmapTiles(bank(), [a, a, cell(16, 16, () => 7)], ['a', 'b', 'c'])
    if (typeof result === 'string') throw new Error(result)
    expect(result.cellTiles).toEqual([[1], [1], [2]])
    expect([result.added, result.reused]).toEqual([2, 1])
    expect([...tileImage(result.doc, 1)]).toEqual([...a.indices])
    expect(result.doc.blocks.map((block) => [block.name, block.width, block.height])).toEqual([
      ['a', 1, 1],
      ['b', 1, 1],
      ['c', 1, 1]
    ])
  })

  it('a cell twice the tile size is four tiles, and an empty one is the reserved tile 0', () => {
    const big = cell(32, 32, (x, y) => (x < 16 && y < 16 ? 0 : 5))
    const result = cellsToBitmapTiles(bank(), [big])
    if (typeof result === 'string') throw new Error(result)
    expect([result.cols, result.rows]).toEqual([2, 2])
    // Three identical solid tiles: one new tile, used three times.
    expect(result.cellTiles[0]).toEqual([0, 1, 1, 1])
  })

  it('refuses a cell that is not a whole number of tiles', () => {
    expect(cellsToBitmapTiles(bank(), [cell(24, 16, () => 1)])).toMatch(/whole number of tiles/)
  })

  it('refuses a full tileset, changing nothing', () => {
    const full = bank({ count: 256 })
    const result = cellsToBitmapTiles(full, [cell(16, 16, (x, y) => (x * y) % 15 + 1)])
    if (typeof result === 'string') throw new Error(result)
    expect(result.refused).toMatch(/ran out of room/)
    expect(result.doc).toBe(full)
  })
})

describe('MSX2: cells into a bitmap meta-tile', () => {
  it('one frame per cell, its tiles made in the tileset it names', () => {
    const tiles = { ...createBitmapTilesDoc('sc5', 8, 8, 1), reserveTile0: true }
    const frames = [cell(16, 8, (x) => (x < 8 ? 3 : 0)), cell(16, 8, (x) => (x < 8 ? 4 : 3))]
    const made = cellsToBitmapMeta(tiles, 'res/hero.btiles.json', frames)
    if (typeof made === 'string') throw new Error(made)
    expect([made.meta.tileset, made.meta.width, made.meta.height]).toEqual(['res/hero.btiles.json', 2, 1])
    // Frame 0's right half is empty: tile 0, never blitted. The 3s are shared.
    expect(made.meta.frames.map((frame) => frame.tiles)).toEqual([
      [1, 0],
      [2, 1]
    ])
    expect(made.tiles.count).toBe(3)
  })
})

describe('MSX2: cells into a software sprite', () => {
  it('pads frames to the mode\u2019s byte, and keeps the transparent dots transparent', () => {
    // SCREEN 6 packs four dots a byte: a 10-dot frame is drawn 12 wide.
    const frames = [cell(10, 4, (x) => (x < 5 ? 2 : 0)), cell(10, 4, (x) => (x >= 5 ? 3 : 0))]
    const made = cellsToSwSprite('sc6', frames, 'bat', 0)
    if (typeof made === 'string') throw new Error(made)
    expect([made.width, made.height, made.frames]).toEqual([12, 4, 2])
    const doc = normalizeSwSprites({ mode: 'sc6', sprites: [made] })
    const second = swFramePixels(doc, 0, 1)
    expect([...second.slice(0, 12)]).toEqual([0, 0, 0, 0, 0, 3, 3, 3, 3, 3, 0, 0])
  })

  it('writes a sheet\u2019s own transparent index where the cell was transparent', () => {
    const made = cellsToSwSprite('sc5', [cell(2, 1, (x) => (x ? 9 : 0))], 'dot', 15)
    if (typeof made === 'string') throw new Error(made)
    expect([...swFramePixels(normalizeSwSprites({ mode: 'sc5', sprites: [made] }), 0, 0)]).toEqual([15, 9])
  })

  it('a tiled mode draws whole 8×8 cells', () => {
    const made = cellsToSwSprite('sc2', [cell(12, 10, () => 4)], 'box')
    if (typeof made === 'string') throw new Error(made)
    expect([made.width, made.height]).toEqual([16, 16])
  })
})

describe('the palette entries a second sheet may take', () => {
  it('is every entry no pixel uses, never the transparent 0', () => {
    expect(unusedEntries([Uint8Array.from([0, 1, 1, 4]), [7]], 8)).toEqual([2, 3, 5, 6])
  })
})
