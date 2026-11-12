/**
 * A world's emitted C, compiled and linked by the **real** MSXgl, together with
 * the rooms' and tilesets' own exports it dispatches to.
 *
 * - An ordinary tileset with an animated meta-tile attached, a one-screen room
 *   that places it **live**, and a shorter packed room: `_LoadTileset` loads
 *   and resets the animation, `_DrawRoom` calls the room's own `_DrawLayer` and
 *   `_DrawPlacements` (or unpacks into the buffer first), `_Animate` plays it.
 * - A banked tileset, loaded through its own `_Load()`.
 *
 * Per CLAUDE.md, emitted C is never verified by reading it. Every helper is
 * called from `main`, because a helper nothing calls links fine even when its
 * body names a symbol that does not exist.
 *
 * Booted in openMSX by hand when this was written (MSXDEVSTUDIO_KEEP_SCRATCH=1,
 * then `vpeek` from timed callbacks): the live torch's cells were in the name
 * table at its placement, its flame's pattern bytes changed between samples,
 * the packed room drew 22 rows, and each bank of the banked room held its own
 * colour.
 *
 * Skipped when no MSXgl checkout is present (see `__fixtures__/msxgl.ts`).
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { addMetaRef, metaRefFrom, normalizeMap, placeMeta, withEntities, type MapDoc } from '../../shared/msx/map'
import { normalizeOwnedMeta, resolveMeta, type OwnedMetaDoc } from '../../shared/msx/meta-owned'
import { defaultExport, type ResourceDoc } from '../../shared/msx/resource'
import { normalizeTiles, type TileEntry, type TilesDoc } from '../../shared/msx/tile'
import { normalizeWorld } from '../../shared/msx/world'
import { BUILD_TIMEOUT, buildFixture, cleanBuildFixtures, runsBuilds } from './__fixtures__/msxgl-build'

afterAll(cleanBuildFixtures)

const entry = (mark: number, ink: number, paper: number): TileEntry => ({
  pattern: new Array(8).fill(mark),
  color: new Array(8).fill((ink << 4) | paper)
})

const TORCH = 'res/torch.meta-tiles.json'

/** A torch whose flame (top row) flickers between three poses. */
function torch(): OwnedMetaDoc {
  return normalizeOwnedMeta({
    version: 3,
    mode: 'sc2',
    width: 2,
    height: 2,
    loop: 'pingpong',
    frames: [0x18, 0x3c, 0x7e].map((mark) => ({
      tiles: [entry(mark, 9, 1), entry(mark, 11, 1), entry(0xff, 6, 1), entry(0xff, 6, 1)],
      duration: 6
    })),
    export: { ...defaultExport(TORCH), name: 'g_Torch', out: 'content/torch.h' }
  })
}

/** Sky over grass, from row `grass` down; tile 0 is reserved blank. */
function ground(height: number, grass: number): { name: string; data: number[] } {
  return { name: 'background', data: Array.from({ length: 32 * height }, (_, i) => (Math.floor(i / 32) >= grass ? 2 : 1)) }
}

function roomExport(name: string, compress = false): MapDoc['export'] {
  return {
    ...defaultExport(`res/${name}.map.json`),
    name: `g_${name.toUpperCase()}`,
    out: `content/${name}.h`,
    helpers: true,
    ...(compress ? { compress: 'rlep' as const } : {})
  }
}

function animatedFixture(): Record<string, ResourceDoc> {
  const meta = torch()
  let tiles: TilesDoc = normalizeTiles({
    mode: 'sc2',
    count: 3,
    reserveTile0: true,
    tiles: [entry(0, 1, 1), entry(0x00, 1, 5), entry(0xaa, 12, 2)],
    export: { ...defaultExport('res/tiles.tiles.json'), name: 'g_Tiles', out: 'content/tiles.h', helpers: true }
  })
  const attached = resolveMeta(tiles, TORCH, meta, 'g_Torch')
  if (typeof attached === 'string') throw new Error(attached)
  tiles = attached.doc

  // Room a: one screen, a torch placed live at 4,10, and a chest.
  let a = normalizeMap({ tileset: 'res/tiles.tiles.json', layers: [ground(24, 16)], export: roomExport('a') })
  a = addMetaRef(a, metaRefFrom(TORCH, meta, 'g_Torch', tiles.metas.find((binding) => binding.path === TORCH)))
  a = placeMeta(a, 0, 0, 4, 10)
  a = withEntities(a, [{ type: 'chest', x: 6, y: 15, param: 1 }])
  // Room b: shorter — rows left for a HUD — and RLEp-packed.
  const b = normalizeMap({ tileset: 'res/tiles.tiles.json', height: 22, layers: [ground(22, 12)], export: roomExport('b', true) })

  return {
    'tiles.tiles': { kind: 'tiles', doc: tiles },
    'torch.meta-tiles': { kind: 'metatiles', doc: meta },
    'a.map': { kind: 'map', doc: a },
    'b.map': { kind: 'map', doc: b },
    'over.world': {
      kind: 'world',
      doc: normalizeWorld({
        cols: 2,
        rows: 1,
        cells: ['res/a.map.json', 'res/b.map.json'],
        entityTypes: ['chest'],
        doors: [{ room: 0, x: 6, y: 15, to: 1, toX: 2, toY: 3 }],
        export: { name: 'g_Over', format: 'c', out: 'content/over.h', helpers: true }
      })
    }
  }
}

/** `start` picks the room drawn, so one ROM per path can be booted. Every helper is reached. */
const animatedMain = (start: number): string => `#include "msxgl.h"
#include "content/over.h"

u8 g_Buffer[G_OVER_BUFFER_BYTES + 1];

void main(void)
{
\tu8 room = ${start};
\tu8 tileset = g_Over_TilesetOf(room);
\tconst u8* e;
\tVDP_SetMode(VDP_MODE_SCREEN2);
\tg_Over_LoadTileset(tileset);
\tg_Over_DrawRoom(room, g_Buffer);
\te = g_Over_RoomEntities(g_Over_RoomAt(0, 0));
\tif (e[0] && e[1] == G_OVER_ENT_CHEST && g_Over_DoorAt(0, e[2], e[3]) == G_OVER_NONE)
\t\troom = g_Over_Neighbour(room, G_OVER_EAST) + g_Over_RoomW(room) + g_Over_RoomH(room);
\twhile (1)
\t{
\t\tHalt();
\t\tg_Over_Animate(tileset);
\t}
}
`

function bankedFixture(): Record<string, ResourceDoc> {
  const solid = (fg: number): TileEntry => ({ pattern: new Array(8).fill(0xff), color: new Array(8).fill((fg << 4) | 1) })
  const tiles = normalizeTiles({
    mode: 'sc2',
    count: 1,
    tiles: [solid(1)],
    bankTiles: [[solid(8)], [solid(5)], [solid(11)]],
    export: { ...defaultExport('res/banked.tiles.json'), name: 'g_Banked', out: 'content/banked.h', helpers: true }
  })
  return {
    'banked.tiles': { kind: 'tiles', doc: tiles },
    'c.map': { kind: 'map', doc: normalizeMap({ tileset: 'res/banked.tiles.json', export: roomExport('c') }) },
    'dungeon.world': {
      kind: 'world',
      doc: normalizeWorld({
        cols: 1,
        rows: 1,
        cells: ['res/c.map.json'],
        export: { name: 'g_Dungeon', format: 'c', out: 'content/dungeon.h', helpers: true }
      })
    }
  }
}

const BANKED_MAIN = `#include "msxgl.h"
#include "content/dungeon.h"

void main(void)
{
\tVDP_SetMode(VDP_MODE_SCREEN2);
\tg_Dungeon_LoadTileset(g_Dungeon_TilesetOf(0));
\tg_Dungeon_DrawRoom(0, NULL);
\twhile (1) { Halt(); }
}
`

function expectClean(output: string, root: string, name: string): void {
  expect(output).not.toMatch(/\bError:/i)
  expect(output).not.toMatch(/Undefined Global/i)
  // The generated sources compile without a warning of their own.
  expect(output).not.toMatch(/content\/\w+\.c:\d+: warning/)
  expect(output).toMatch(/Success/)
  expect(existsSync(join(root, 'out', `${name}.rom`))).toBe(true)
}

describe.runIf(runsBuilds)('the emitted world C builds against real MSXgl', () => {
  it(
    'a live, animated meta-tile in one room, a packed room beside it',
    () => {
      for (const [name, start] of [['worldanim', 0], ['worldpack', 1]] as const) {
        const { output, root } = buildFixture({
          name,
          template: 'template',
          machine: '1',
          resources: animatedFixture(),
          main: animatedMain(start),
          libModules: ['compress']
        })
        expectClean(output, root, name)
      }
    },
    BUILD_TIMEOUT
  )

  it(
    'a banked tileset, loaded through its own _Load()',
    () => {
      const { output, root } = buildFixture({
        name: 'worldbank',
        template: 'template',
        machine: '1',
        resources: bankedFixture(),
        main: BANKED_MAIN
      })
      expectClean(output, root, 'worldbank')
    },
    BUILD_TIMEOUT
  )
})
