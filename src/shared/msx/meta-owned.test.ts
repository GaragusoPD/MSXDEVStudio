import { describe, expect, it } from 'vitest'
import {
  attachMigrated,
  createOwnedMeta,
  detachMeta,
  isOwnedMeta,
  metaFromV2,
  metaWindowAnim,
  movingCells,
  normalizeOwnedMeta,
  ownedMetaConstants,
  ownedMetaTables,
  refreshMetas,
  resolveMeta,
  tilesetMetaConstants,
  tilesetMetaHelperC,
  tilesetMetaTables,
  validateOwnedMeta,
  type OwnedMetaDoc
} from './meta-owned'
import { blankTileEntry, normalizeTiles, removeTile, validateTiles, type TileEntry, type TilesDoc } from './tile'
import { parseResource, renderResourceFiles, serializeResource } from './resource'
import { createMetaTileDoc } from './meta-tile'
import { metaRefFrom, normalizeMap, addMetaRef, placeMeta, placementHelperC, validateMap } from './map'
import { tileAnimHelperC } from './tile-anim'

/** A tile whose every row is `mark`, ink 15 on paper `paper`. */
const tile = (mark: number, paper = 1): TileEntry => ({ pattern: new Array(8).fill(mark), color: new Array(8).fill(0xf0 | paper) })

const TREE = 'res/tree.meta-tiles.json'
const TORCH = 'res/torch.meta-tiles.json'

/** A 2×2 still meta: four different tiles, the top-right one see-through. */
function tree(): OwnedMetaDoc {
  return normalizeOwnedMeta({
    version: 3,
    mode: 'sc2',
    width: 2,
    height: 2,
    holes: [false, true, false, false],
    frames: [{ tiles: [tile(0x81), tile(0), tile(0x42), tile(0x24)] }],
    flags: 0x01,
    export: { name: 'g_Tree', format: 'c', out: 'content/tree.h' }
  })
}

/**
 * A 2×3 torch: a still bracket and stick, with a two-tile flame on top that
 * changes between its three poses.
 */
function torch(): OwnedMetaDoc {
  const flame = [0x18, 0x3c, 0x7e]
  return normalizeOwnedMeta({
    version: 3,
    mode: 'sc2',
    width: 2,
    height: 3,
    frames: flame.map((mark) => ({
      tiles: [tile(mark, 9), tile(mark >> 1, 9), tile(0xff, 6), tile(0xf0, 6), tile(0x0f, 6), tile(0xaa, 6)],
      duration: 6
    })),
    loop: 'pingpong',
    export: { name: 'g_Torch', format: 'c', out: 'content/torch.h' }
  })
}

function tileset(count = 8, extra: Partial<TilesDoc> = {}): TilesDoc {
  return normalizeTiles({ mode: 'sc2', count, tiles: Array.from({ length: count }, (_, i) => tile(i)), ...extra })
}

function attach(tiles: TilesDoc, path: string, meta: OwnedMetaDoc, name = 'g_Meta'): TilesDoc {
  const result = resolveMeta(tiles, path, meta, name)
  if (typeof result === 'string') throw new Error(result)
  return result.doc
}

describe('the version-3 document', () => {
  it('owns its pixels and names no tileset', () => {
    const doc = createOwnedMeta('sc2', 3, 2)
    expect(isOwnedMeta(doc)).toBe(true)
    expect(doc.holes).toEqual(new Array(6).fill(false))
    expect(doc.frames[0].tiles).toHaveLength(6)
    expect('tileset' in doc).toBe(false)
    expect(validateOwnedMeta(doc)).toEqual([])
  })

  it('is read by version: a `.meta-tiles.json` without one is still a version-2 meta', () => {
    const v3 = parseResource(TREE, serializeResource({ kind: 'metatiles', doc: tree() }))
    expect(isOwnedMeta(v3.doc)).toBe(true)
    const v2 = parseResource(TREE, JSON.stringify(createMetaTileDoc('res/main.tiles.json', 2, 2)))
    expect(isOwnedMeta(v2.doc)).toBe(false)
  })

  it('takes any size up to 16 a side, unlike an animation window', () => {
    const doc = normalizeOwnedMeta({ width: 6, height: 4 })
    expect([doc.width, doc.height]).toEqual([6, 4])
  })
})

describe('moving cells', () => {
  it('are the cells whose art differs between poses — the torch’s flame, not its stick', () => {
    expect(movingCells(torch())).toEqual([0, 1])
    expect(movingCells(tree())).toEqual([])
  })

  it('make a one-row animation of just those cells, with the meta’s timing', () => {
    const window = metaWindowAnim(torch())!
    expect([window.width, window.height, window.frames.length, window.loop]).toEqual([2, 1, 3, 'pingpong'])
    expect(window.frames[2].tiles[0].pattern[0]).toBe(0x7e)
    expect(metaWindowAnim(tree())).toBeNull()
  })

  it('never include a see-through cell', () => {
    const doc = torch()
    expect(movingCells({ ...doc, holes: [true, false, false, false, false, false] })).toEqual([1])
  })

  it('are capped at a window’s 16 tiles', () => {
    const doc = normalizeOwnedMeta({
      width: 5,
      height: 4,
      frames: [{ tiles: new Array(20).fill(tile(1)) }, { tiles: new Array(20).fill(tile(2)) }]
    })
    expect(validateOwnedMeta(doc).join()).toMatch(/20 tiles change between poses/)
  })
})

describe('attaching a still meta', () => {
  it('finds identical art, creates the rest, and leaves see-through cells at 0', () => {
    const tiles = tileset(8)
    const doc = attach(tiles, TREE, normalizeOwnedMeta({ ...tree(), frames: [{ tiles: [tile(3), tile(0), tile(0x42), tile(0x24)] }] }))
    expect(doc.metas[0].cells).toEqual([3, 0, 8, 9])
    expect(doc.count).toBe(10)
    expect(doc.tiles[8].pattern[0]).toBe(0x42)
    expect(validateTiles(doc)).toEqual([])
  })

  it('never resolves an opaque cell to tile 0, even a blank one over a reserved blank tile 0', () => {
    const tiles = normalizeTiles({ mode: 'sc2', count: 4, reserveTile0: true })
    const blank = blankTileEntry('sc2')
    const doc = attach(tiles, TREE, normalizeOwnedMeta({ ...tree(), holes: [false, false, false, false], frames: [{ tiles: [blank, blank, blank, blank] }] }))
    expect(doc.metas[0].cells.every((cell) => cell !== 0)).toBe(true)
    // One blank tile of its own, shared by all four cells.
    expect(new Set(doc.metas[0].cells).size).toBe(1)
  })

  it('is a no-op the second time: same numbers, same document', () => {
    const once = attach(tileset(), TREE, tree())
    const twice = resolveMeta(once, TREE, tree(), 'g_Meta')
    expect(typeof twice !== 'string' && twice.doc).toBe(once)
  })

  it('keeps a cell’s tile while it still shows that art, and only re-finds the cells that changed', () => {
    const once = attach(tileset(), TREE, tree())
    const edited = normalizeOwnedMeta({ ...tree(), frames: [{ tiles: [tile(0x81), tile(0), tile(0x42), tile(0x99)] }] })
    const twice = attach(once, TREE, edited)
    expect(twice.metas[0].cells.slice(0, 3)).toEqual(once.metas[0].cells.slice(0, 3))
    expect(twice.metas[0].cells[3]).toBe(once.count)
    // The old tile is still there: a map that baked it keeps drawing it.
    expect(twice.tiles[once.metas[0].cells[3]].pattern[0]).toBe(0x24)
  })

  it('refuses poses the tileset cannot show', () => {
    const result = resolveMeta(tileset(), TREE, normalizeOwnedMeta({ ...tree(), mode: 'sc1' }), 'g_Tree')
    expect(result).toMatch(/sc1/)
  })

  it('on a banked tileset, goes to the shared region and never a tile a bank draws over', () => {
    // Tile 1 in the common set is the tree's first cell exactly — but bank 0
    // shows its own art at index 1, so drawing the tree in rows 0-7 would show that.
    const tiles = normalizeTiles({ mode: 'sc2', count: 2, tiles: [tile(0), tile(0x81)], bankTiles: [[tile(0), tile(0x81, 2)], [], []] })
    const doc = attach(tiles, TREE, tree())
    expect(doc.metas[0].cells[0]).not.toBe(1)
    expect(doc.metas[0].cells.filter((cell) => cell !== 0).every((cell) => cell >= 256 - doc.sharedTiles)).toBe(true)
    expect(validateTiles(doc)).toEqual([])
  })
})

describe('attaching an animated meta', () => {
  it('gives only its moving cells a window, filed as an animation under the meta’s own path', () => {
    const doc = attach(tileset(8), TORCH, torch(), 'g_Torch')
    const window = doc.animations.find((binding) => binding.path === TORCH)!
    expect([window.slot, window.width, window.height, window.frames, window.loop]).toEqual([8, 2, 1, 3, 'pingpong'])
    const cells = doc.metas[0].cells
    expect(cells.slice(0, 2)).toEqual([8, 9])
    expect(cells.slice(2).every((cell) => cell >= 10)).toBe(true)
    // The window holds the resting pose, so anything that does not play animations shows that.
    expect(doc.tiles[8].pattern[0]).toBe(0x18)
    expect(validateTiles(doc)).toEqual([])
  })

  it('is played by the tileset’s own _Animate(), from the meta’s own pose tables', () => {
    const doc = attach(tileset(8), TORCH, torch(), 'g_Torch')
    const c = tileAnimHelperC(doc, 'g_Tiles').source.join('\n')
    expect(c).toContain('extern const u8 g_Torch_Patterns[];')
    expect(c).toContain('VDP_LoadPattern_GM2(g_Torch_Patterns + (u16)frame * 16, 2, 8);')
    const own = ownedMetaTables(torch()).map((table) => table.suffix)
    expect(own).toEqual(['_Info', '_Patterns', '_Colors', '_Durations'])
  })

  it('keeps its window across refreshes, and moves it when more cells start to move', () => {
    const once = attach(tileset(8), TORCH, torch(), 'g_Torch')
    expect(attach(once, TORCH, torch(), 'g_Torch')).toBe(once)
    const more = torch()
    more.frames[1].tiles[2] = tile(0x11, 6)
    const moved = attach(once, TORCH, more, 'g_Torch')
    const window = moved.animations.filter((binding) => binding.path === TORCH)
    expect(window).toHaveLength(1)
    expect(window[0].width).toBe(3)
    expect(window[0].slot).toBeGreaterThanOrEqual(once.count)
    expect(moved.metas[0].cells.slice(0, 3)).toEqual([window[0].slot, window[0].slot + 1, window[0].slot + 2])
  })

  it('a meta whose poses stop differing loses its window', () => {
    const once = attach(tileset(8), TORCH, torch(), 'g_Torch')
    const still = normalizeOwnedMeta({ ...torch(), frames: [torch().frames[0]] })
    const doc = attach(once, TORCH, still, 'g_Torch')
    expect(doc.animations).toEqual([])
    expect(doc.metas[0].cells.slice(0, 2)).not.toContain(0)
  })

  it('in SCREEN 1, starts a group of its own when the next group is in another pair', () => {
    const tiles = normalizeTiles({ mode: 'sc1', count: 3, groupColors: [0x41] })
    const meta = normalizeOwnedMeta({ ...torch(), mode: 'sc1', pair: 0xa1 })
    const doc = attach(tiles, TORCH, meta, 'g_Torch')
    const window = doc.animations[0]
    expect(window.slot).toBe(8)
    expect(doc.groupColors[1]).toBe(0xa1)
    expect(validateTiles(doc)).toEqual([])
  })
})

describe('detaching, and renumbering under an attached meta', () => {
  it('detaching leaves the tiles as art and stops the window', () => {
    const once = attach(tileset(8), TORCH, torch(), 'g_Torch')
    const doc = detachMeta(once, TORCH)
    expect(doc.metas).toEqual([])
    expect(doc.animations).toEqual([])
    expect(doc.count).toBe(once.count)
  })

  it('a tile removed below the meta shifts its cells; one removed from under it heals on the next refresh', () => {
    const once = attach(tileset(8), TREE, tree())
    const shifted = removeTile(once, 1).doc
    expect(shifted.metas[0].cells).toEqual(once.metas[0].cells.map((cell) => (cell === 0 ? 0 : cell - 1)))
    const gone = removeTile(once, once.metas[0].cells[2]).doc
    expect(gone.metas[0].cells[2]).toBe(0)
    const healed = refreshMetas(gone, new Map([[TREE, { meta: tree(), name: 'g_Tree' }]]))
    expect(healed.doc.metas[0].cells[2]).not.toBe(0)
    expect(healed.changed).toEqual([TREE])
  })

  it('a refresh reports a meta it could not read, and leaves its binding alone', () => {
    const once = attach(tileset(8), TREE, tree())
    const result = refreshMetas(once, new Map([[TREE, 'gone']]))
    expect(result.problems).toEqual(['gone'])
    expect(result.doc).toBe(once)
  })
})

describe('version 2 → 3', () => {
  it('copies the art out of the tileset and keeps the tiles the meta pointed at', () => {
    const tiles = tileset(8)
    const v2 = { ...createMetaTileDoc('res/main.tiles.json', 2, 2), frames: [{ tiles: [5, 0, 6, 5] }], flags: 3 }
    const { meta, cells } = metaFromV2(v2, tiles)
    expect(meta.holes).toEqual([false, true, false, false])
    expect(meta.frames[0].tiles[0].pattern[0]).toBe(5)
    expect(meta.flags).toBe(3)
    const attached = attachMigrated(tiles, TREE, meta, 'g_Tree', cells)
    if (typeof attached === 'string') throw new Error(attached)
    expect(attached.binding.cells).toEqual([5, 0, 6, 5])
    expect(attached.doc.count).toBe(8)
  })

  it('turns frames of different tiles into poses, and the cells that differ into a window', () => {
    const tiles = tileset(8)
    const v2 = { ...createMetaTileDoc('res/main.tiles.json', 2, 1), frames: [{ tiles: [1, 7] }, { tiles: [2, 7] }] }
    const { meta, cells } = metaFromV2(v2, tiles)
    expect(movingCells(meta)).toEqual([0])
    const attached = attachMigrated(tiles, TORCH, meta, 'g_Torch', cells)
    if (typeof attached === 'string') throw new Error(attached)
    expect(attached.binding.cells[1]).toBe(7)
    expect(attached.doc.animations[0].slot).toBe(8)
  })

  it('says when a cell was see-through in only some frames', () => {
    const v2 = { ...createMetaTileDoc('res/main.tiles.json', 1, 1), frames: [{ tiles: [0] }, { tiles: [4] }] }
    expect(metaFromV2(v2, tileset()).partialHoles).toBe(1)
  })
})

describe('export', () => {
  it('a tileset states its metas as data: info, cells, and an index each', () => {
    let doc = attach(tileset(8), TREE, tree(), 'g_Tree')
    doc = attach(doc, TORCH, torch(), 'g_Torch')
    const [info, cells] = tilesetMetaTables(doc)
    expect([...info.bytes]).toEqual([2, 2, 1, 0, 0, 2, 3, 0, 4, 0])
    expect(cells.bytes.length).toBe(4 + 6)
    expect(cells.bytes[1]).toBe(0)
    expect(tilesetMetaConstants(doc, 'g_Tiles')).toEqual(['#define G_TILES_METAS 2', '#define G_TILES_META_TREE 0', '#define G_TILES_META_TORCH 1'])
  })

  it('the tileset’s header carries the tables with or without helpers, and _DrawMeta with them', () => {
    const doc = attach(tileset(8), TREE, tree(), 'g_Tree')
    const files = renderResourceFiles({ kind: 'tiles', doc }, 'res/main.tiles.json', { name: 'g_Tiles', format: 'c', out: 'content/tiles.h', helpers: true })
    expect(files.source).toContain('g_Tiles_MetaCells[]')
    expect(files.header).toContain('void g_Tiles_DrawMeta(u8 meta, u8 x, u8 y);')
    const c = tilesetMetaHelperC(doc, 'g_Tiles').source.join('\n')
    expect(c).toContain('VDP_WriteVRAM(src + col, dst + col, g_ScreenLayoutHigh, run - col);')
  })

  it('a meta’s own header is its size, flags and — when it moves — its window’s poses', () => {
    expect(ownedMetaTables(tree()).map((table) => table.suffix)).toEqual(['_Info'])
    expect(ownedMetaConstants(torch(), 'g_Torch')).toContain('#define G_TORCH_MOVING 2')
    const files = renderResourceFiles({ kind: 'metatiles', doc: tree() }, TREE, tree().export!)
    expect(files.header).not.toContain('_Draw')
  })
})

describe('a map placing a meta that owns its pixels', () => {
  it('mirrors the tiles its attachment gives it, and draws from its own copy', () => {
    const doc = attach(tileset(8), TREE, tree(), 'g_Tree')
    const ref = metaRefFrom(TREE, tree(), 'g_Tree', doc.metas[0])
    expect(ref.cells).toEqual(doc.metas[0].cells)
    expect(ref.frames).toBe(1)
    let map = normalizeMap({ tileset: 'res/main.tiles.json', width: 32, height: 24 })
    map = placeMeta(addMetaRef(map, ref), 0, 0, 3, 3)
    expect(validateMap(map)).toEqual([])
    const c = placementHelperC(map, 'g_Level').source.join('\n')
    expect(c).toContain(`static const u8 g_Level_MetaTiles0[] = { ${doc.metas[0].cells.join(', ')} };`)
    expect(c).not.toContain('extern const u8 g_Tree[]')
  })

  it('will not export when the meta is not attached to the map’s tileset', () => {
    let map = normalizeMap({ tileset: 'res/main.tiles.json', width: 32, height: 24 })
    map = placeMeta(addMetaRef(map, metaRefFrom(TREE, tree(), 'g_Tree', null)), 0, 0, 3, 3)
    expect(validateMap(map).join()).toMatch(/not attached to res\/main\.tiles\.json/)
  })
})
