import { describe, expect, it } from 'vitest'
import {
  animationFromBlock,
  attachAnimation,
  colorsVary,
  createTileAnimDoc,
  detachAnimation,
  frameTiles,
  normalizeTileAnim,
  tileAnimConstants,
  tileAnimHelperC,
  tileAnimTables,
  tilesetAnimConstants,
  validateTileAnim,
  withAnimFrame,
  withFrameTiles,
  type TileAnimDoc
} from './tile-anim'
import { normalizeTiles, removeTile, reorderTiles, validateTiles, type TileEntry, type TilesDoc } from './tile'
import { defaultExport, parseResource, renderResourceFiles, resourceKindOf, serializeResource } from './resource'
import { findOrCreateBankTile, findOrCreateTile, paintGrid } from './meta-paint'
import { placePicture } from './tile-compact'

/** A tile whose every row is `mark`, ink 15 on paper `paper`. */
const tile = (mark: number, paper = 1): TileEntry => ({ pattern: new Array(8).fill(mark), color: new Array(8).fill(0xf0 | paper) })

/** Four 1×1 poses, all the same colours unless told otherwise. */
function coin(paperOf: (frame: number) => number = () => 5): TileAnimDoc {
  return normalizeTileAnim({
    mode: 'sc2',
    width: 1,
    height: 1,
    frames: [0x18, 0x3c, 0x7e, 0x3c].map((mark, f) => ({ tiles: [tile(mark, paperOf(f))], duration: 10 })),
    export: { name: 'g_Coin', format: 'c', out: 'content/coin_anim.h' }
  })
}

function tileset(count = 8, extra: Partial<TilesDoc> = {}): TilesDoc {
  return normalizeTiles({ mode: 'sc2', count, tiles: Array.from({ length: count }, (_, i) => tile(i)), ...extra })
}

const PATH = 'res/coin.anim-tiles.json'

describe('the animation document', () => {
  it('normalizes a hand-written file to its own geometry', () => {
    const doc = normalizeTileAnim({ width: 2, height: 1, frames: [{ tiles: [tile(1)] }, {}], loop: 'bogus' })
    expect(doc.frames).toHaveLength(2)
    expect(doc.frames.every((f) => f.tiles.length === 2)).toBe(true)
    expect(doc.frames[0].duration).toBe(8)
    expect(doc.loop).toBe('loop')
    expect(validateTileAnim(doc)).toEqual([])
  })

  it('caps a window at 16 tiles', () => {
    const doc = normalizeTileAnim({ width: 8, height: 8 })
    expect(doc.width * doc.height).toBeLessThanOrEqual(16)
  })

  it('sc1 poses carry no colours', () => {
    const doc = createTileAnimDoc('sc1')
    expect(doc.frames[0].tiles[0].color).toEqual([])
    expect(colorsVary(doc)).toBe(false)
  })

  it('knows whether the poses differ in colour', () => {
    expect(colorsVary(coin())).toBe(false)
    expect(colorsVary(coin((f) => (f === 2 ? 9 : 5)))).toBe(true)
  })

  it('paints through a scratch tileset and back', () => {
    const doc = coin()
    const scratch = frameTiles(doc, 1)
    expect(scratch.count).toBe(1)
    const painted = { ...scratch, tiles: [tile(0xff, 5)] }
    const next = withFrameTiles(doc, 1, painted)
    expect(next.frames[1].tiles[0].pattern[0]).toBe(0xff)
    expect(next.frames[0]).toBe(doc.frames[0])
  })
})

describe('the exported tables', () => {
  it('lays poses end to end, then colours, then one duration per pose', () => {
    const tables = tileAnimTables(coin())
    expect(tables.map((t) => t.suffix)).toEqual(['_Patterns', '_Colors', '_Durations'])
    expect(tables[0].bytes.length).toBe(4 * 8)
    expect(Array.from(tables[0].bytes.slice(8, 16))).toEqual(new Array(8).fill(0x3c))
    expect(Array.from(tables[2].bytes)).toEqual([10, 10, 10, 10])
  })

  it('has no colour table in sc1', () => {
    expect(tileAnimTables(createTileAnimDoc('sc1')).map((t) => t.suffix)).toEqual(['_Patterns', '_Durations'])
  })

  it('states its shape', () => {
    expect(tileAnimConstants(normalizeTileAnim({ width: 2, height: 2, frames: [{}, {}] }), 'g_Torch')).toEqual([
      '#define G_TORCH_W 2',
      '#define G_TORCH_H 2',
      '#define G_TORCH_CELLS 4',
      '#define G_TORCH_FRAMES 2'
    ])
  })
})

describe('attaching to a tileset', () => {
  it('writes frame 0 into the window, records the binding and names a block over it', () => {
    const doc = attachAnimation(tileset(), PATH, coin(), { slot: 6, bank: null, name: 'g_CoinAnim' })
    expect(doc.tiles[6].pattern[0]).toBe(0x18)
    expect(doc.animations).toEqual([
      { path: PATH, slot: 6, bank: null, name: 'g_Coin', width: 1, height: 1, frames: 4, colorsVary: false, loop: 'loop' }
    ])
    expect(doc.blocks).toEqual([{ name: 'coin', width: 1, height: 1, tiles: [6] }])
    expect(validateTiles(doc)).toEqual([])
  })

  it('grows the set when the window runs past it', () => {
    const doc = attachAnimation(tileset(4), PATH, coin(), { slot: 4, bank: null, name: 'g_X' })
    expect(doc.count).toBe(5)
    expect(doc.tiles[4].pattern[0]).toBe(0x18)
  })

  it("writes a bank window into that bank's own art", () => {
    const banked = normalizeTiles({ mode: 'sc2', count: 1, bankTiles: [[tile(1), tile(2), tile(3)], [], []] })
    const doc = attachAnimation(banked, PATH, coin(), { slot: 2, bank: 0, name: 'g_X' })
    expect(doc.bankTiles[0][2].pattern[0]).toBe(0x18)
    expect(doc.tiles[2]).toEqual(banked.tiles[2])
  })

  it('detaching keeps the pose as ordinary art and drops the block', () => {
    const attached = attachAnimation(tileset(), PATH, coin(), { slot: 6, bank: null, name: 'g_X' })
    const doc = detachAnimation(attached, PATH)
    expect(doc.animations).toEqual([])
    expect(doc.blocks).toEqual([])
    expect(doc.tiles[6].pattern[0]).toBe(0x18)
  })

  it('a refresh that changes nothing hands back the same document', () => {
    const doc = attachAnimation(tileset(), PATH, coin(), { slot: 6, bank: null, name: 'g_X' })
    expect(withAnimFrame(doc, doc.animations[0], coin())).toBe(doc)
  })

  it('survives a save and load', () => {
    const doc = attachAnimation(tileset(), PATH, coin(), { slot: 6, bank: null, name: 'g_X' })
    expect(normalizeTiles(JSON.parse(JSON.stringify(doc))).animations).toEqual(doc.animations)
  })
})

describe('windows follow the tileset', () => {
  const attached = (): TilesDoc =>
    attachAnimation(tileset(), 'res/torch.anim-tiles.json', normalizeTileAnim({ width: 2, height: 1 }), { slot: 4, bank: null, name: 'g_T' })

  it('a reorder outside the window moves it with its tiles', () => {
    const { doc } = reorderTiles(attached(), 7, 0)
    expect(doc.animations[0].slot).toBe(5)
    expect(doc.blocks[0].tiles).toEqual([5, 6])
  })

  it('a removal below the window shifts it down', () => {
    const { doc } = removeTile(attached(), 1)
    expect(doc.animations[0].slot).toBe(3)
  })

  it('a removal inside the window detaches the animation rather than split it', () => {
    const { doc } = removeTile(attached(), 5)
    expect(doc.animations).toEqual([])
  })

  it('a reorder that splits the window detaches it', () => {
    const { doc } = reorderTiles(attached(), 4, 7)
    expect(doc.animations).toEqual([])
  })
})

describe('window validation', () => {
  it('refuses a window past the set', () => {
    const doc = { ...tileset(4), animations: [{ path: PATH, slot: 3, bank: null, name: 'g_X', width: 2, height: 1, frames: 1, colorsVary: false, loop: 'loop' as const }] }
    expect(validateTiles(doc).join()).toMatch(/run past the tileset's 4 tiles/)
  })

  it('refuses two windows over one tile', () => {
    let doc = attachAnimation(tileset(), 'res/a.anim-tiles.json', coin(), { slot: 2, bank: null, name: 'g_A' })
    doc = { ...doc, animations: [...doc.animations, { ...doc.animations[0], path: 'res/b.anim-tiles.json', name: 'g_B' }] }
    expect(validateTiles(doc).join()).toMatch(/g_B: tile 2 is also driven by g_Coin/)
  })

  it('refuses the reserved see-through tile', () => {
    const doc = attachAnimation(tileset(4, { reserveTile0: true }), PATH, coin(), { slot: 0, bank: null, name: 'g_X' })
    expect(validateTiles(doc).join()).toMatch(/reserved see-through/)
  })

  it("refuses a common window over a bank's own art, since a step writes every bank", () => {
    const banked = normalizeTiles({ mode: 'sc2', count: 8, tiles: tileset().tiles, bankTiles: [[tile(1), tile(2), tile(3)], [], []] })
    const doc = attachAnimation(banked, PATH, coin(), { slot: 2, bank: null, name: 'g_X' })
    expect(validateTiles(doc).join()).toMatch(/bank 1 has its own art at tile 2/)
  })
})

describe('extracting from a pose block', () => {
  it('reads a strip as one pose per tile', () => {
    const doc = tileset()
    const anim = animationFromBlock(doc, { name: 'spin', width: 4, height: 1, tiles: [3, 4, 5, 6] }, 1, 1, 10)!
    expect(anim.frames.map((f) => f.tiles[0].pattern[0])).toEqual([3, 4, 5, 6])
    expect(anim.frames.every((f) => f.duration === 10)).toBe(true)
  })

  it('reads a 4×2 block as two 2×2 poses', () => {
    const anim = animationFromBlock(tileset(), { name: 't', width: 4, height: 2, tiles: [0, 1, 2, 3, 4, 5, 6, 7] }, 2, 2)!
    expect(anim.frames.map((f) => f.tiles.map((t) => t.pattern[0]))).toEqual([
      [0, 1, 4, 5],
      [2, 3, 6, 7]
    ])
  })

  it('refuses a block that does not divide into poses', () => {
    expect(animationFromBlock(tileset(), { name: 't', width: 3, height: 1, tiles: [0, 1, 2] }, 2, 1)).toBeNull()
  })
})

describe('the generated C', () => {
  const code = (doc: TilesDoc): string => {
    const { header, source } = tileAnimHelperC(doc, 'g_Tiles')
    return [...header, ...source].join('\n')
  }

  it('is nothing at all for a tileset with nothing attached', () => {
    expect(tileAnimHelperC(tileset(), 'g_Tiles')).toEqual({ header: [], source: [] })
    expect(tilesetAnimConstants(tileset(), 'g_Tiles')).toEqual([])
  })

  it('copies patterns only when every pose shares its colours', () => {
    const text = code(attachAnimation(tileset(), PATH, coin(), { slot: 6, bank: null, name: 'g_X' }))
    expect(text).toContain('VDP_LoadPattern_GM2(g_Coin_Patterns + (u16)frame * 8, 1, 6);')
    expect(text).not.toContain('LoadColor')
    expect(text).not.toContain('g_Coin_Colors')
  })

  it('copies colours too when a pose differs', () => {
    const text = code(attachAnimation(tileset(), PATH, coin((f) => f + 1), { slot: 6, bank: null, name: 'g_X' }))
    expect(text).toContain('VDP_LoadColor_GM2(g_Coin_Colors + (u16)frame * 8, 1, 6);')
    expect(text).toContain('extern const u8 g_Coin_Colors[];')
  })

  it("writes only its own bank for a bank's window", () => {
    const banked = normalizeTiles({ mode: 'sc2', count: 1, bankTiles: [[], [tile(1), tile(2), tile(3)], []] })
    const text = code(attachAnimation(banked, PATH, coin((f) => f + 1), { slot: 2, bank: 1, name: 'g_X' }))
    expect(text).toContain('VDP_LoadBankPattern_GM2(g_Coin_Patterns + (u16)frame * 8, 1, 1, 2);')
    expect(text).toContain('VDP_LoadBankColor_GM2(g_Coin_Colors + (u16)frame * 8, 1, 1, 2);')
    expect(text).not.toContain('VDP_LoadPattern_GM2')
  })

  it('writes the one pattern table directly in SCREEN 1', () => {
    const sc1 = normalizeTiles({ mode: 'sc1', count: 8 })
    const anim = normalizeTileAnim({ mode: 'sc1', width: 2, height: 1, frames: [{}, {}], export: { name: 'g_Flag', format: 'c', out: 'x.h' } })
    const text = code(attachAnimation(sc1, 'res/flag.anim-tiles.json', anim, { slot: 3, bank: null, name: 'g_X' }))
    expect(text).toContain('VDP_WriteVRAM(g_Flag_Patterns + (u16)frame * 16, g_ScreenPatternLow + 24, g_ScreenPatternHigh, 16);')
    expect(text).not.toContain('_GM2')
  })

  it('states the binding indices and slots, and the tables the runtime reads', () => {
    const doc = attachAnimation(tileset(), PATH, coin(), { slot: 6, bank: null, name: 'g_X' })
    expect(tilesetAnimConstants(doc, 'g_Tiles')).toEqual([
      '#define G_TILES_ANIMS 1',
      '#define G_TILES_ANIM_COIN 0',
      '#define G_TILES_ANIM_COIN_SLOT 6',
      '#define G_TILES_ANIM_COIN_FRAMES 4'
    ])
    const text = code(doc)
    expect(text).toContain('static const u8* const g_Tiles_AnimDurations[G_TILES_ANIMS] = { g_Coin_Durations };')
    expect(text).toContain('static const u8 g_Tiles_AnimLength[G_TILES_ANIMS] = { 4 };')
    expect(text).toContain('void g_Tiles_AnimReset(void)')
    expect(text).toContain('void g_Tiles_AnimSetActive(u8 anim, bool on)')
    // A garbage frame index from uncleared RAM is clamped, not followed.
    expect(text).toContain('if(f > last) f = 0;')
  })

  it('restarts one animation without touching the others, and reads a pose back', () => {
    const text = code(attachAnimation(tileset(), PATH, coin(), { slot: 6, bank: null, name: 'g_X' }))
    expect(text).toContain('void g_Tiles_AnimRestart(u8 anim);')
    expect(text).toContain('u8 g_Tiles_AnimGetFrame(u8 anim);')
    // Restart is the per-animation half of Reset, and shows pose 0 at once.
    const restart = text.slice(text.indexOf('void g_Tiles_AnimRestart(u8 anim)\n{'))
    expect(restart).toMatch(/if\(anim >= G_TILES_ANIMS\) return;[\s\S]*g_Tiles_AnimShow\(anim, 0\);/)
    expect(text).toContain('for(u8 i = 0; i < G_TILES_ANIMS; ++i) g_Tiles_AnimRestart(i);')
    // The getter clamps exactly as _Animate() does.
    expect(text).toContain('return f < g_Tiles_AnimLength[anim] ? f : 0;')
  })
})

describe('the export path, from files alone', () => {
  // What a fresh clone, CI or an agent editing res/ by hand exports: no editor
  // has opened anything, so everything below is read from file text.
  it('a tileset with an animation attached states it and plays it', () => {
    const doc = attachAnimation(tileset(), PATH, coin(), { slot: 6, bank: null, name: 'g_X' })
    const text = serializeResource({ kind: 'tiles', doc: { ...doc, export: { name: 'g_Tiles', format: 'c', out: 'content/tiles.h', helpers: true } } })
    const resource = parseResource('res/tiles.tiles.json', text)
    const files = renderResourceFiles(resource, 'res/tiles.tiles.json', resource.doc.export!)
    expect(files.header).toContain('#define G_TILES_ANIM_COIN_SLOT 6')
    expect(files.header).toContain('void g_Tiles_Animate(void);')
    expect(files.source).toContain('VDP_LoadPattern_GM2(g_Coin_Patterns + (u16)frame * 8, 1, 6);')
    // Frame 0 is the window's static art in the pattern table.
    expect(files.source).toMatch(/0x18/)
  })

  it('with helpers off, the defines are still there and no C is', () => {
    const doc = attachAnimation(tileset(), PATH, coin(), { slot: 6, bank: null, name: 'g_X' })
    const resource = parseResource('res/tiles.tiles.json', serializeResource({ kind: 'tiles', doc }))
    const files = renderResourceFiles(resource, 'res/tiles.tiles.json', { name: 'g_Tiles', format: 'c', out: 'content/tiles.h' })
    expect(files.header).toContain('#define G_TILES_ANIMS 1')
    expect(files.header).not.toContain('_Animate')
  })

  it('an animation exports its poses and durations', () => {
    const resource = parseResource(PATH, serializeResource({ kind: 'anim', doc: coin() }))
    expect(resource.kind).toBe('anim')
    const files = renderResourceFiles(resource, PATH, resource.doc.export!)
    expect(files.header).toContain('#define G_COIN_FRAMES 4')
    expect(files.header).toContain('extern const unsigned char g_Coin_Durations[];')
    expect(files.source).toContain('g_Coin_Patterns[]')
  })

  it('is its own kind, not a tileset', () => {
    expect(resourceKindOf('res/coin.anim-tiles.json')).toBe('anim')
    expect(defaultExport('res/coin.anim-tiles.json')).toEqual({ name: 'g_CoinAnim', format: 'c', out: 'content/coin_anim.h' })
  })
})

describe('a window is never mistaken for static art', () => {
  // Tile 6 holds the coin's first pose: the exact bytes a static coin would have.
  const attached = (): TilesDoc => attachAnimation(tileset(), PATH, coin(), { slot: 6, bank: null, name: 'g_X' })
  const firstPose = (): TileEntry => coin().frames[0].tiles[0]

  it('find-or-create appends a new tile rather than reuse the window', () => {
    const doc = attached()
    const found = findOrCreateTile(doc, firstPose())!
    expect(found.index).not.toBe(6)
    expect(found.index).toBe(doc.count)
  })

  it("a bank's search skips the bank's own window and every common one", () => {
    const banked = normalizeTiles({ mode: 'sc2', count: 1, bankTiles: [[tile(1), tile(2), tile(3)], [], []] })
    const doc = attachAnimation(banked, PATH, coin(), { slot: 2, bank: 0, name: 'g_X' })
    expect(findOrCreateBankTile(doc, 0, firstPose())!.index).not.toBe(2)
  })

  it('an edit stroke on an animated cell forks it instead of rewriting the window, and says so', () => {
    const doc = attached()
    const result = paintGrid({ width: 2, height: 1, tiles: [6, 0] }, doc, [{ x: 0, y: 0 }], 9, 'fg', { write: 'edit' })
    expect(result.tileEdits).toEqual([])
    expect(result.tiles.tiles[6]).toEqual(doc.tiles[6])
    expect(result.grid.tiles[0]).not.toBe(6)
    expect(result.unanimated).toBe(1)
  })

  it('an imported picture is not matched to a window', () => {
    const doc = attached()
    const pixels = new Uint8Array(64)
    const pose = firstPose()
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) pixels[y * 8 + x] = pose.pattern[y] & (0x80 >> x) ? 15 : 1
    const result = placePicture({ width: 1, height: 1, tiles: [0] }, doc, pixels, 1, 1)
    expect(result.grid.tiles[0]).not.toBe(6)
  })
})
