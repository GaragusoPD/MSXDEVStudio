/**
 * Meta-tiles that own their pixels, and maps indexed by them, compiled and
 * linked by the **real** MSXgl — every entry point the export can emit for
 * them, called from `main`, because a helper that is declared and never called
 * links fine whatever its body names.
 *
 * - An indexed level: `_Expand()` over a tile layer in RAM, mixed sizes, a
 *   see-through cell, an animated torch on screen and one that only scrolls
 *   in later; the tileset's `_Animate()` driving the torches' window, and
 *   `_DrawMeta()` for a HUD. This is the ROM the openMSX pass boots
 *   (MSXDEVSTUDIO_KEEP_SCRATCH=1 keeps it).
 * - SCREEN 1 on an MSX2: `_DrawMeta()`'s `VDP_WriteVRAM` with 17-bit
 *   addressing, a meta placed live through `_DrawPlacements()`, and an sc1
 *   window.
 */

import { existsSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { addMetaRef, metaRefFrom, normalizeMap, placeMeta, setLayerIndexed, type MapDoc } from '../../shared/msx/map'
import { normalizeOwnedMeta, resolveMeta, type OwnedMetaDoc } from '../../shared/msx/meta-owned'
import { defaultExport, type ResourceDoc } from '../../shared/msx/resource'
import { normalizeTiles, type TileEntry, type TilesDoc } from '../../shared/msx/tile'
import { BUILD_TIMEOUT, buildFixture, cleanBuildFixtures, runsBuilds } from './__fixtures__/msxgl-build'

afterAll(cleanBuildFixtures)

const entry = (mark: number, ink: number, paper: number, sc1 = false): TileEntry => ({
  pattern: new Array(8).fill(mark),
  color: sc1 ? [] : new Array(8).fill((ink << 4) | paper)
})

function meta(name: string, doc: Partial<OwnedMetaDoc> & { frames: OwnedMetaDoc['frames'] }): OwnedMetaDoc {
  return normalizeOwnedMeta({ version: 3, ...doc, export: { ...defaultExport(`res/${name}.meta-tiles.json`), name: `g_${name[0].toUpperCase()}${name.slice(1)}`, out: `content/${name}.h` } })
}

function attach(tiles: TilesDoc, name: string, doc: OwnedMetaDoc): TilesDoc {
  const result = resolveMeta(tiles, `res/${name}.meta-tiles.json`, doc, doc.export!.name)
  if (typeof result === 'string') throw new Error(result)
  return result.doc
}

function expectRom(output: string, root: string, name: string): void {
  expect(output).not.toMatch(/\bError:/i)
  expect(output).not.toMatch(/Undefined Global/i)
  expect(output).toMatch(/Success/)
  const rom = join(root, 'out', `${name}.rom`)
  expect(existsSync(rom), `${rom} should exist`).toBe(true)
  expect(statSync(rom).size).toBeGreaterThan(1024)
}

describe.runIf(runsBuilds)('an indexed level of meta-tiles builds against real MSXgl', () => {
  it(
    'expands into RAM, scrolls, animates every torch, and draws a HUD meta',
    () => {
      // A rock with a see-through top-right cell; a torch whose flame (top
      // row) flickers between three poses; a brick strip.
      const rock = meta('rock', {
        mode: 'sc2',
        width: 2,
        height: 2,
        holes: [false, true, false, false],
        frames: [{ tiles: [entry(0x7e, 14, 1), entry(0, 1, 1), entry(0xff, 14, 1), entry(0xff, 14, 1)], duration: 1 }],
        flags: 1
      })
      const torch = meta('torch', {
        mode: 'sc2',
        width: 2,
        height: 3,
        loop: 'pingpong',
        frames: [0x18, 0x3c, 0x7e].map((mark) => ({
          tiles: [entry(mark, 9, 1), entry(mark, 11, 1), entry(0xff, 6, 1), entry(0xff, 6, 1), entry(0x18, 10, 1), entry(0x18, 10, 1)],
          duration: 6
        })),
        flags: 2
      })
      const brick = meta('brick', {
        mode: 'sc2',
        width: 4,
        height: 1,
        frames: [{ tiles: [entry(0xee, 8, 6), entry(0xee, 8, 6), entry(0xbb, 8, 6), entry(0xbb, 8, 6)], duration: 1 }]
      })

      // Tile 0 blank (reserved), 1 sky, 2 grass.
      let tiles = normalizeTiles({
        mode: 'sc2',
        count: 3,
        reserveTile0: true,
        tiles: [entry(0, 1, 1), entry(0x00, 1, 5), entry(0xaa, 12, 2)],
        export: { ...defaultExport('res/tiles.tiles.json'), name: 'g_Tiles', out: 'content/tiles.h', helpers: true }
      })
      tiles = attach(tiles, 'rock', rock)
      tiles = attach(tiles, 'torch', torch)
      tiles = attach(tiles, 'brick', brick)

      let map: MapDoc = normalizeMap({
        tileset: 'res/tiles.tiles.json',
        width: 64,
        height: 24,
        layers: [
          { name: 'background', data: Array.from({ length: 64 * 24 }, (_, i) => (Math.floor(i / 64) >= 16 ? 2 : 1)) },
          { name: 'terrain' }
        ],
        export: { ...defaultExport('res/level.map.json'), name: 'g_Level', out: 'content/level.h', helpers: true }
      })
      for (const [name, doc] of [['rock', rock], ['torch', torch], ['brick', brick]] as const) {
        const path = `res/${name}.meta-tiles.json`
        map = addMetaRef(map, metaRefFrom(path, doc, doc.export!.name, tiles.metas.find((b) => b.path === path)))
      }
      map = setLayerIndexed(map, 1, true)
      // Torch A on screen from the start; torch B at x=50, on screen only once
      // the view scrolls 32 tiles right. Rocks and bricks between them.
      for (const [slot, x, y] of [
        [1, 4, 10], [1, 50, 10], [0, 8, 14], [0, 40, 14], [2, 12, 16], [2, 16, 16], [2, 44, 16], [0, 20, 4]
      ] as const) {
        map = placeMeta(map, 1, slot, x, y)
      }

      const resources: Record<string, ResourceDoc> = {
        'tiles.tiles': { kind: 'tiles', doc: tiles },
        'rock.meta-tiles': { kind: 'metatiles', doc: rock },
        'torch.meta-tiles': { kind: 'metatiles', doc: torch },
        'brick.meta-tiles': { kind: 'metatiles', doc: brick },
        'level.map': { kind: 'map', doc: map }
      }
      const { output, root } = buildFixture({
        name: 'indexedlevel',
        template: 'template',
        machine: '1',
        resources,
        main: `#include "msxgl.h"
#include "content/tiles.h"
#include "content/level.h"

// Globals, so they are not on the stack; zeroed below, because RAM is not
// cleared at boot on a ROM target.
u8 g_Map[G_LEVEL_W * G_LEVEL_H];
u8 g_Objects[G_LEVEL_W * G_LEVEL_H];

// Rows 0-21 are the scrolling view; 22-23 are a HUD drawn with _DrawMeta.
void DrawView(u8 scroll)
{
\tfor(u8 row = 0; row < 22; ++row)
\t\tVDP_WriteVRAM(g_Map + (u16)row * G_LEVEL_W + scroll, g_ScreenLayoutLow + (u16)row * 32, g_ScreenLayoutHigh, 32);
}

void main(void)
{
\tVDP_SetMode(VDP_MODE_GRAPHIC2);
\tVDP_LoadPattern_GM2(g_Tiles_Patterns, G_TILES_PATTERNS_SIZE / 8, 0);
\tVDP_LoadColor_GM2(g_Tiles_Colors, G_TILES_COLORS_SIZE / 8, 0);
\tfor(u16 i = 0; i < G_LEVEL_W * G_LEVEL_H; ++i)
\t{
\t\tg_Map[i] = g_Level_Background[i];
\t\tg_Objects[i] = 0;
\t}
\tg_Level_Expand(g_Level_Terrain, g_Map, g_Objects);
\tg_Tiles_DrawMeta(G_TILES_META_BRICK, 0, 22);
\tg_Tiles_DrawMeta(G_TILES_META_ROCK, 28, 22);
\t// Which object covers torch A's flame, and rock 1's see-through cell, as
\t// tile numbers an emulator can read back from the name table.
\tVDP_Poke_16K(g_Objects[10 * G_LEVEL_W + 4], g_ScreenLayoutLow + 23 * 32 + 10);
\tVDP_Poke_16K(g_Objects[14 * G_LEVEL_W + 9], g_ScreenLayoutLow + 23 * 32 + 11);
\tg_Tiles_AnimReset();
\tu8 scroll = 0;
\tu16 frame = 0;
\tDrawView(scroll);
\twhile(1)
\t{
\t\tHalt();
\t\tg_Tiles_Animate();
\t\tif(++frame == 150)
\t\t{
\t\t\tscroll = 32;
\t\t\tDrawView(scroll);
\t\t}
\t}
}
`
      })
      expectRom(output, root, 'indexedlevel')
      if (process.env.MSXDEVSTUDIO_KEEP_SCRATCH) {
        // What the openMSX pass checks the name table and patterns against.
        writeFileSync(
          join(root, 'expected.json'),
          JSON.stringify({ metas: tiles.metas, windows: tiles.animations, count: tiles.count }, null, 2)
        )
      }
    },
    BUILD_TIMEOUT
  )
})

describe.runIf(runsBuilds)('SCREEN 1 meta-tiles build against real MSXgl on an MSX2', () => {
  it(
    '_DrawMeta, a meta placed live with _DrawPlacements, and an sc1 window',
    () => {
      const sign = meta('sign', {
        mode: 'sc1',
        width: 3,
        height: 1,
        pair: 0xa1,
        frames: [0x81, 0xc3].map((mark) => ({ tiles: [entry(mark, 0, 0, true), entry(0xff, 0, 0, true), entry(mark, 0, 0, true)], duration: 10 }))
      })
      let tiles = normalizeTiles({
        mode: 'sc1',
        count: 8,
        export: { ...defaultExport('res/tiles.tiles.json'), name: 'g_Tiles', out: 'content/tiles.h', helpers: true }
      })
      tiles = attach(tiles, 'sign', sign)
      let map = normalizeMap({
        tileset: 'res/tiles.tiles.json',
        width: 32,
        height: 24,
        export: { ...defaultExport('res/level.map.json'), name: 'g_Level', out: 'content/level.h', helpers: true }
      })
      map = addMetaRef(map, metaRefFrom('res/sign.meta-tiles.json', sign, 'g_Sign', tiles.metas[0]))
      map = placeMeta(map, 0, 0, 3, 3)
      const { output, root } = buildFixture({
        name: 'metasc1',
        template: 'template_msx2',
        machine: '2',
        resources: {
          'tiles.tiles': { kind: 'tiles', doc: tiles },
          'sign.meta-tiles': { kind: 'metatiles', doc: sign },
          'level.map': { kind: 'map', doc: map }
        },
        main: `#include "msxgl.h"
#include "content/tiles.h"
#include "content/level.h"

void main(void)
{
\tu8 frames[G_LEVEL_METAS];
\tframes[0] = 0;
\tg_Level_DrawLayer(g_Level_Background, 0, 0);
\tg_Level_DrawPlacements(frames);
\tg_Tiles_DrawMeta(G_TILES_META_SIGN, 10, 10);
\tg_Tiles_AnimReset();
\twhile(1)
\t{
\t\tHalt();
\t\tg_Tiles_Animate();
\t}
}
`
      })
      expectRom(output, root, 'metasc1')
    },
    BUILD_TIMEOUT
  )
})
