/**
 * The generated `CLAUDE.md`/`AGENTS.md` is the **only** thing an agent working
 * inside a generated project knows about this IDE. When the exporter's output
 * moves and the guide does not, that agent writes code against last release's
 * headers — and nothing fails until someone compiles it.
 *
 * So this pins one to the other: every identifier the guide teaches is rendered
 * from a real resource and looked for in the real output. It is deliberately a
 * hand-written list rather than something scraped from the guide, because
 * scraping would make the test agree with the guide by construction and catch
 * nothing.
 */

import { describe, expect, it } from 'vitest'
import { normalizeProject } from '../../shared/msxproj'
import { normalizeBitmapTiles, sheetCols } from '../../shared/msx/bitmap-tile'
import { addMetaRef, metaRefFrom, normalizeMap, placeMeta, setLayerIndexed, setPlacementBaked } from '../../shared/msx/map'
import { normalizeOwnedMeta, resolveMeta } from '../../shared/msx/meta-owned'
import { createMetaTileDoc } from '../../shared/msx/meta-tile'
import { paintBitmapMeta } from '../../shared/msx/meta-paint'
import { defaultExport, renderResourceFiles, type ResourceDoc } from '../../shared/msx/resource'
import { createLayer, normalizeSprites } from '../../shared/msx/sprite'
import { normalizeTiles } from '../../shared/msx/tile'
import { LOOP_CODE } from '../../shared/msx/tile-anim'
import { agentGuideFiles } from './agent-guide'

const guide = (machine: string): string =>
  agentGuideFiles(normalizeProject({ name: 'mygame', machine }, 'mygame'), '/home/me/MSXgl')[0].content

const block = (name: string) => ({ ...defaultExport(`res/${name}.json`), name, helpers: true })

const render = (resource: ResourceDoc, path: string, name: string): string => {
  const files = renderResourceFiles(resource, path, block(name))
  return `${files.header ?? ''}\n${files.source ?? ''}`
}

const cellPoints = (ox: number, oy: number, size: number): { x: number; y: number }[] =>
  Array.from({ length: size }, (_, y) => Array.from({ length: size }, (_, x) => ({ x: ox + x, y: oy + y }))).flat()

/** A pattern map placing one meta, as the guide's example: mirrored with its tiles. */
function patternMap(): ResourceDoc {
  let map = normalizeMap({ tileset: 'res/tiles.tiles.json', width: 32, height: 24 })
  map = addMetaRef(map, {
    path: 'res/tree.meta-tiles.json',
    name: 'g_Tree',
    width: 2,
    height: 3,
    frames: 1,
    flags: 0x01,
    cells: [1, 2, 3, 4, 5, 6]
  })
  map = placeMeta(map, 0, 0, 4, 4)
  map = setPlacementBaked(placeMeta(map, 0, 0, 10, 8), 0, 1, true)
  return { kind: 'map', doc: { ...map, export: block('g_Level') } }
}

function bitmapMeta(): ResourceDoc {
  const tiles = normalizeBitmapTiles({
    mode: 'sc5',
    width: 16,
    height: 16,
    count: 1,
    reserveTile0: true,
    transparent: 0
  })
  const meta = { ...createMetaTileDoc('res/canyon.btiles.json', 2, 2), transparent: 0 }
  const painted = paintBitmapMeta(meta, tiles, 0, cellPoints(0, 0, 16), 7)
  return {
    kind: 'metabtiles',
    doc: {
      ...painted.meta,
      transparent: 0,
      cell: { width: 16, height: 16, cols: sheetCols(painted.tiles) },
      export: block('g_Rock')
    }
  }
}

function bitmapMap(): ResourceDoc {
  let map = normalizeMap({
    tileset: 'res/canyon.btiles.json',
    width: 16,
    height: 12,
    cell: { width: 16, height: 16, cols: 16 }
  })
  map = addMetaRef(map, {
    path: 'res/rock.meta-btiles.json',
    name: 'g_Rock',
    width: 2,
    height: 2,
    frames: 1,
    flags: 0,
    masked: true
  })
  return { kind: 'map', doc: { ...placeMeta(map, 0, 0, 3, 3), export: block('g_Stage') } }
}

describe('the guide teaches what the exporter emits', () => {
  it('the placement table, its names and its mirrored flags', () => {
    const text = render(patternMap(), 'res/level.map.json', 'g_Level')
    for (const symbol of ['G_LEVEL_METAS', 'G_LEVEL_PLACEMENTS', 'G_LEVEL_META_G_TREE', 'G_LEVEL_FLAGS_G_TREE']) {
      expect(text, `${symbol} is emitted`).toContain(`#define ${symbol}`)
      expect(guide('1'), `${symbol} is taught`).toContain(symbol)
    }
    // emitC declares tables as `unsigned char`, not the `u8` alias.
    expect(text).toContain('extern const unsigned char g_Level_Placements[];')
    expect(text).toContain('void g_Level_DrawPlacements(void)')
    expect(guide('1')).toContain('g_Level_DrawPlacements();')
    // The guide pairs it with the layer write; that signature must still exist.
    expect(text).toContain('void g_Level_DrawLayer(const u8* layer, u8 x, u8 y)')
    expect(guide('1')).toContain('g_Level_DrawLayer(g_Level_Background, 0, 0)')
  })

  it('the bitmap meta-tile defines and helper', () => {
    const text = render(bitmapMeta(), 'res/rock.meta-btiles.json', 'g_Rock')
    for (const symbol of ['G_ROCK_CELL_W', 'G_ROCK_CELL_H', 'G_ROCK_ATLAS_COLS', 'G_ROCK_TRANSPARENT']) {
      expect(text, `${symbol} is emitted`).toContain(`#define ${symbol}`)
      expect(guide('2'), `${symbol} is taught`).toContain(symbol)
    }
    expect(text).toContain('void g_Rock_Draw(UX x, UY y, u8 frame, UY atlasY)')
    expect(guide('2')).toContain('g_Rock_Draw(64, 32, 0, ATLAS_Y)')
    // The guide names both blits by their real MSXgl spelling.
    expect(text).toContain('VDP_CommandLMMM')
    expect(guide('2')).toContain('VDP_CommandLMMM')
    expect(guide('2')).toContain('VDP_OP_TIMP')
  })

  it('the bitmap placement helper takes the atlas position', () => {
    const text = render(bitmapMap(), 'res/stage.map.json', 'g_Stage')
    expect(text).toContain('void g_Stage_DrawPlacements(const u8* frames, UY atlasY)')
    expect(guide('2')).toContain('g_Stage_DrawPlacements(frames, ATLAS_Y)')
  })

  it('keeps the bitmap meta-tile half away from an MSX1 project', () => {
    // Not a blanket ban on naming V9938 calls — the guide has a cross-mode
    // table that deliberately says what SCREEN 5-8 would do. What an MSX1
    // project must not be *taught* is the bitmap meta-tile API it cannot call.
    for (const symbol of ['g_Rock_Draw', 'G_ROCK_TRANSPARENT', 'G_ROCK_ATLAS_COLS', '_DrawPlacements(frames, ATLAS_Y)']) {
      expect(guide('1'), `${symbol} must not reach an MSX1 guide`).not.toContain(symbol)
      expect(guide('2'), `${symbol} belongs in the MSX2 guide`).toContain(symbol)
    }
    // SCREEN 3 is MSX1's own multicolour mode, so its half stays.
    expect(guide('1')).toContain('SCREEN 3')
    expect(guide('1')).toContain('no command engine to blit with')
  })

  it('states the 128-meta cap the slot byte actually imposes', () => {
    expect(guide('1')).toContain('128')
  })
})

describe('the guide teaches meta-tiles that own their pixels as the exporter emits them', () => {
  const entry = (mark: number) => ({ pattern: new Array(8).fill(mark), color: new Array(8).fill(0xf1) })
  /** A 2×2 torch whose top row moves, exported as `g_Torch`. */
  const torch = normalizeOwnedMeta({
    version: 3,
    mode: 'sc2',
    width: 2,
    height: 2,
    flags: 2,
    frames: [0x18, 0x3c].map((mark) => ({ tiles: [entry(mark), entry(mark), entry(0xff), entry(0xff)], duration: 6 })),
    export: block('g_Torch')
  })
  const tileset = (() => {
    const attached = resolveMeta(normalizeTiles({ mode: 'sc2', count: 4, reserveTile0: true }), 'res/torch.meta-tiles.json', torch, 'g_Torch')
    if (typeof attached === 'string') throw new Error(attached)
    return attached.doc
  })()

  it("the tileset's meta table, _DrawMeta, and the meta's window as an animation", () => {
    const text = render({ kind: 'tiles', doc: tileset }, 'res/mytiles.tiles.json', 'g_MyTiles')
    for (const symbol of ['G_MYTILES_METAS', 'G_MYTILES_META_TORCH', 'G_MYTILES_ANIM_TORCH']) {
      expect(text, `${symbol} is emitted`).toContain(`#define ${symbol}`)
      expect(guide('1'), `${symbol} is taught`).toContain(symbol)
    }
    for (const table of ['g_MyTiles_MetaInfo', 'g_MyTiles_MetaCells']) {
      expect(text).toContain(`extern const unsigned char ${table}[];`)
      expect(guide('1')).toContain(table)
    }
    expect(text).toContain('void g_MyTiles_DrawMeta(u8 meta, u8 x, u8 y);')
    expect(guide('1')).toContain('g_MyTiles_DrawMeta(G_MYTILES_META_TORCH, 10, 5)')
  })

  it("the meta's own header", () => {
    const text = render({ kind: 'metatiles', doc: torch }, 'res/torch.meta-tiles.json', 'g_Torch')
    for (const symbol of ['G_TORCH_W', 'G_TORCH_H', 'G_TORCH_FLAGS', 'G_TORCH_MOVING', 'G_TORCH_FRAMES']) {
      expect(text, `${symbol} is emitted`).toContain(`#define ${symbol}`)
      expect(guide('1'), `${symbol} is taught`).toContain(symbol.replace(/_(H|FLAGS)$/, ''))
    }
    for (const table of ['g_Torch_Patterns', 'g_Torch_Colors', 'g_Torch_Durations', 'g_Torch_MovingCells']) {
      expect(text, `${table} is emitted`).toContain(`extern const unsigned char ${table}[];`)
      expect(guide('1'), `${table} is taught`).toContain(table)
    }
  })

  it('a loader of its own: every symbol the relocating example names, and the bank-only VRAM calls', () => {
    const meta = render({ kind: 'metatiles', doc: torch }, 'res/torch.meta-tiles.json', 'g_Torch')
    const set = render({ kind: 'tiles', doc: tileset }, 'res/mytiles.tiles.json', 'g_MyTiles')
    // The window's length, beside where it starts — and the same number as the meta's _MOVING.
    expect(set).toContain('#define G_MYTILES_ANIM_TORCH_SLOT ')
    expect(set).toContain('#define G_MYTILES_ANIM_TORCH_TILES 2')
    expect(meta).toContain('#define G_TORCH_MOVING 2')
    // The top row moves: cells 0 and 1, in reading order.
    expect(meta).toMatch(/g_Torch_MovingCells\[\] =\s*\{\s*0x00, 0x01,/)
    for (const machine of ['1', '2']) {
      const text = guide(machine)
      expect(text).toContain('G_MYTILES_ANIM_COIN_TILES')
      expect(text).toContain('_ANIM_TORCH_TILES')
      const example = text.slice(text.indexOf('#### Your own loader'), text.indexOf('#### By hand, from a block'))
      for (const [symbol] of example.matchAll(/\b[gG]_T[Oo][Rr][Cc][Hh]_\w+/g)) {
        expect(meta, `${symbol} (guide, MSX${machine}) is in the meta's header`).toMatch(new RegExp(`\\b${symbol}\\b`))
      }
      // One bank, not the mirroring _GM2 loaders: the whole point of a loader of one's own.
      expect(example).toContain('VDP_LoadBankPattern_GM2(pattern + k * 8, 1, TORCH_BANK, slot);')
      expect(example).toContain('VDP_LoadBankColor_GM2(color + k * 8, 1, TORCH_BANK, slot);')
      // The loop mode is read from the header, by the numbers _Animate() uses —
      // not hard-coded, not left to the reader.
      expect(example).toContain(`G_TORCH_LOOP == ${LOOP_CODE.pingpong}`)
      expect(example).toContain(`G_TORCH_LOOP == ${LOOP_CODE.once}`)
      expect(example).not.toMatch(/yours to code|written only in the\s+header's comment/)
    }
    expect(meta).toContain(`#define G_TORCH_LOOP ${LOOP_CODE[torch.loop]}\n`)
  })

  it('an indexed layer, its tables and _Expand', () => {
    let map = normalizeMap({ tileset: 'res/mytiles.tiles.json', width: 32, height: 24, layers: [{ name: 'background' }, { name: 'terrain' }] })
    map = addMetaRef(map, metaRefFrom('res/torch.meta-tiles.json', torch, 'g_Torch', tileset.metas[0]))
    map = setLayerIndexed(placeMeta(map, 1, 0, 4, 4), 1, true)
    const text = render({ kind: 'map', doc: map }, 'res/level.map.json', 'g_Level')
    for (const table of ['g_Level_Terrain', 'g_Level_MetaCells', 'g_Level_MetaCellsAt']) {
      expect(text).toContain(`extern const unsigned char ${table}[];`)
      expect(guide('1')).toContain(table)
    }
    expect(text).toContain('void g_Level_Expand(const u8* layer, u8* tiles, u8* objects);')
    expect(guide('1')).toContain('g_Level_Expand(g_Level_Terrain, g_Map, NULL)')
  })
})

describe('the guide teaches animated sprite sheets as the exporter emits them', () => {
  /** The bug report's cursors sheet: an arrow of 4 frames, then four one-frame characters. */
  const cursors = (mode: 1 | 2, animated = true) =>
    normalizeSprites({
      mode,
      size: 16,
      sprites: [
        { name: 'arrow', frames: (animated ? [1, 2, 3, 4] : [1]).map((f) => ({ layers: [createLayer(16, 4 + f)], duration: 4 + f })) },
        ...['down', 'marker', 'flash', 'here'].map((name) => ({ name, frames: [{ layers: [createLayer(16, 15)], duration: 8 }] }))
      ]
    })
  const header = (mode: 1 | 2, animated = true): string =>
    render({ kind: 'sprites', doc: { ...cursors(mode, animated), export: block('g_Cursors') } }, 'res/cursors.sprites.json', 'g_Cursors')

  it('every #define in its example, with the value the export gives it', () => {
    const text = header(1)
    for (const machine of ['1', '2']) {
      const taught = [...guide(machine).matchAll(/^#define (G_CURSORS_\w+)\s+(\d+)/gm)]
      // The two characters of the bug report, and the sheet-level pair.
      expect(taught.map(([, symbol]) => symbol)).toEqual(
        expect.arrayContaining(['G_CURSORS_CHARS', 'G_CURSORS_PLANE_PATTERNS', 'G_CURSORS_ARROW_ID', 'G_CURSORS_DOWN_PATTERN', 'G_CURSORS_DOWN_FRAME0'])
      )
      for (const [, symbol, value] of taught) expect(text, `${symbol} ${value}`).toContain(`#define ${symbol} ${value}\n`)
    }
    expect(text).toContain('extern const unsigned char g_Cursors_Durations[];')
    expect(guide('1')).toContain('g_Cursors_Durations')
  })

  it('the two helpers, by their real signatures, and every call the guide makes on the sheet', () => {
    for (const [machine, mode] of [['1', 1], ['2', 2]] as const) {
      const text = header(mode)
      const taught = guide(machine)
      expect(text).toContain('void g_Cursors_SetFrame(u8 index, u8 chr, u8 frame);')
      expect(text).toContain('bool g_Cursors_AnimStep(u8 chr, u8* state);')
      expect(taught).toContain('void g_Cursors_SetFrame(u8 index, u8 chr, u8 frame);')
      expect(taught).toContain('bool g_Cursors_AnimStep(u8 chr, u8* state);')
      for (const [call] of taught.matchAll(/\bg_Cursors_[A-Za-z]+(?=\()/g)) expect(text).toContain(`${call}(`)
    }
    // Mode 2's colour call is MSX2-only in MSXgl, and only the MSX2 guide says so.
    expect(header(2)).toContain('VDP_SetSpriteMultiColor(')
    expect(guide('2')).toContain('VDP_SetSpriteMultiColor')
    expect(guide('1')).not.toContain('VDP_SetSpriteMultiColor')
  })

  it('no animation, no _FRAME0, _Durations or helpers — as the guide says', () => {
    const text = header(1, false)
    expect(text).toContain('#define G_CURSORS_DOWN_PATTERN 4')
    expect(text).not.toContain('_FRAME0')
    expect(text).not.toContain('g_Cursors_Durations')
    expect(text).not.toContain('g_Cursors_SetFrame')
    expect(guide('1')).toContain('`_FRAME0` and `_Durations` exist once some character has more than one')
    expect(guide('1')).toContain('With *Export ready-made C* on, a sheet with any animated character also gets')
  })
})

describe('the ROM zero-initialisation trap', () => {
  /**
   * Two pieces of correct advice combining into a bug: the guide says globals
   * beat locals for anything hot, and the placement example uses a local array
   * that SDCC really does zero. Hoist it for speed, as told, and on a ROM
   * target it holds boot garbage — a stray frame index that reads past the end
   * of the meta's table and draws whatever followed in ROM.
   */
  it('warns that a global is not zero at boot, where the advice collides', () => {
    for (const machine of ['1', '2']) {
      const text = guide(machine)
      expect(text, machine).toContain('a global is not zero at boot')
      expect(text, machine).toContain('Mem_Set')
      // Named next to the rule that sends you there, not buried elsewhere.
      expect(text, machine).toContain('globals beat locals for anything hot')
    }
  })

  it('points at it wherever a helper takes a caller-owned buffer', () => {
    // A bitmap meta's frame array…
    expect(guide('2')).toContain('If you make `frames` a global, zero it explicitly')
    // …and the RAM an indexed layer expands into.
    expect(guide('1')).toContain('fill it before expanding')
    expect(guide('1')).toContain('Zero it first, for the same reason.')
  })

  it('shows the software-sprite state zeroed, which has the same shape', () => {
    expect(guide('2')).toContain('g_Hero_SwSprite hero = { 0 };')
  })
})
