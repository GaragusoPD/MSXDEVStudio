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
import { addMetaRef, normalizeMap, placeMeta, setPlacementBaked } from '../../shared/msx/map'
import { createMetaTileDoc } from '../../shared/msx/meta-tile'
import { paintBitmapMeta, paintMeta } from '../../shared/msx/meta-paint'
import { defaultExport, renderResourceFiles, type ResourceDoc } from '../../shared/msx/resource'
import { normalizeTiles } from '../../shared/msx/tile'
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

/** A painted 2×3 pattern meta named `g_Tree`, exactly as the guide's example. */
function patternMeta(): ResourceDoc {
  const tiles = normalizeTiles({ mode: 'sc2', count: 1, reserveTile0: true })
  const meta = createMetaTileDoc('res/tiles.tiles.json', 2, 3)
  const painted = paintMeta(meta, tiles, 0, cellPoints(0, 0, 8), 5)
  return { kind: 'metatiles', doc: { ...painted.meta, flags: 0x01, export: block('g_Tree') } }
}

function patternMap(): ResourceDoc {
  let map = normalizeMap({ tileset: 'res/tiles.tiles.json', width: 32, height: 24 })
  map = addMetaRef(map, {
    path: 'res/tree.meta-tiles.json',
    name: 'g_Tree',
    width: 2,
    height: 3,
    frames: 4,
    flags: 0x01
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
  it('the pattern meta-tile defines and helper', () => {
    const text = render(patternMeta(), 'res/tree.meta-tiles.json', 'g_Tree')
    const emitted = ['G_TREE_META_W', 'G_TREE_META_H', 'G_TREE_CELLS', 'G_TREE_FRAMES', 'G_TREE_FLAGS']
    for (const symbol of emitted) {
      expect(text, `${symbol} is emitted`).toContain(`#define ${symbol}`)
      expect(guide('1'), `${symbol} is taught`).toContain(symbol)
    }
    expect(text).toContain('void g_Tree_Draw(u8 x, u8 y, u8 frame)')
    expect(guide('1')).toContain('g_Tree_Draw(10, 5, 0)')
  })

  it('the placement table, its names and its mirrored flags', () => {
    const text = render(patternMap(), 'res/level.map.json', 'g_Level')
    for (const symbol of ['G_LEVEL_METAS', 'G_LEVEL_PLACEMENTS', 'G_LEVEL_META_G_TREE', 'G_LEVEL_FLAGS_G_TREE']) {
      expect(text, `${symbol} is emitted`).toContain(`#define ${symbol}`)
      expect(guide('1'), `${symbol} is taught`).toContain(symbol)
    }
    // emitC declares tables as `unsigned char`, not the `u8` alias.
    expect(text).toContain('extern const unsigned char g_Level_Placements[];')
    expect(text).toContain('void g_Level_DrawPlacements(const u8* frames)')
    expect(guide('1')).toContain('g_Level_DrawPlacements(frames)')
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

  it('points at it from the placements section too', () => {
    expect(guide('1')).toContain('If you make `frames` a global, zero it explicitly')
  })

  it('shows the software-sprite state zeroed, which has the same shape', () => {
    expect(guide('2')).toContain('g_Hero_SwSprite hero = { 0 };')
  })
})
