/**
 * A world's emitted C, compiled and linked by the **real** MSXgl — both shapes
 * of `_DrawRoom` (RLEp-packed rooms and raw ones), with and without doors,
 * since `_DoorAt` compiles a different body when there is no `_Doors` table.
 *
 * Per CLAUDE.md, emitted C is never verified by reading it. Every helper is
 * called from `main`, because a helper nothing calls links fine even when its
 * body names a symbol that does not exist.
 *
 * Skipped when no MSXgl checkout is present (see `__fixtures__/msxgl.ts`).
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { normalizeMap, withEntities } from '../../shared/msx/map'
import { defaultExport, type ResourceDoc } from '../../shared/msx/resource'
import { mergeColorByte, normalizeTiles } from '../../shared/msx/tile'
import { normalizeWorld, type WorldDoor } from '../../shared/msx/world'
import { BUILD_TIMEOUT, buildFixture, cleanBuildFixtures, runsBuilds } from './__fixtures__/msxgl-build'

afterAll(cleanBuildFixtures)

/** `hud`: rooms two rows short, drawn from row 2 — the `_TOP` path of `_DrawRoom`. */
function fixture(compress: boolean, doors: WorldDoor[], hud = false): Record<string, ResourceDoc> {
  const height = hud ? 22 : 24
  const tiles = normalizeTiles({
    mode: 'sc2',
    count: 2,
    tiles: [
      { pattern: new Array(8).fill(0), color: new Array(8).fill(mergeColorByte(15, 4)) },
      { pattern: new Array(8).fill(0xff), color: new Array(8).fill(mergeColorByte(12, 1)) }
    ]
  })
  // Ground from row 16 down in one room, from row 8 in the other: packs well.
  const room = (from: number): ResourceDoc => ({
    kind: 'map',
    doc: withEntities(
      normalizeMap({
        tileset: 'res/hero.tiles.json',
        height,
        layers: [{ name: 'background', data: Array.from({ length: 32 * height }, (_, i) => (i >= from * 32 ? 1 : 0)) }]
      }),
      [{ type: 'chest', x: 4, y: 5, param: 1 }]
    )
  })
  return {
    'hero.tiles': {
      kind: 'tiles',
      doc: { ...tiles, export: { ...defaultExport('res/hero.tiles.json'), name: 'g_Hero', out: 'content/hero.h' } }
    },
    'a.map': room(16),
    'b.map': room(8),
    'over.world': {
      kind: 'world',
      doc: normalizeWorld({
        cols: 2,
        rows: 2,
        roomHeight: height,
        top: hud ? 2 : 0,
        cells: ['res/a.map.json', 'res/b.map.json', null, 'res/a.map.json'],
        entityTypes: ['chest'],
        doors,
        export: {
          name: 'g_Over',
          format: 'c',
          out: 'content/over.h',
          helpers: true,
          ...(compress ? { compress: 'rlep' as const } : {})
        }
      })
    }
  }
}

/** Calls every helper, so a broken body fails the link. */
const MAIN = `#include "msxgl.h"
#include "content/hero.h"
#include "content/over.h"

#if defined(G_OVER_COMPRESSED)
u8 g_RoomBuffer[G_OVER_ROOM_BYTES];
#endif

void main(void)
{
\tu8 room = g_Over_RoomAt(0, 0);
\tconst u8* entities;
\tconst u8* data;
\tVDP_SetMode(VDP_MODE_SCREEN2);
\tVDP_LoadPattern_GM2(g_Hero_Patterns, 2, 0);
\tVDP_LoadColor_GM2(g_Hero_Colors, 2, 0);
#if defined(G_OVER_COMPRESSED)
\tg_Over_DrawRoom(room, g_RoomBuffer);
#else
\tg_Over_DrawRoom(room);
#endif
\troom = g_Over_Neighbour(room, G_OVER_EAST);
\tentities = g_Over_RoomEntities(room);
\tdata = g_Over_RoomData(room);
\tif (entities[0] && entities[1] == G_OVER_ENT_CHEST && g_Over_DoorAt(room, entities[2], entities[3]) == G_OVER_NONE)
\t\troom = g_Over_TilesetOf(room) + data[0];
\twhile (1) { Halt(); }
}
`

function expectClean(output: string): void {
  expect(output).not.toMatch(/\bError:/i)
  expect(output).not.toMatch(/Undefined Global/i)
  // The generated source compiles without a warning of its own.
  expect(output).not.toMatch(/content\/over\.c:\d+: warning/)
  expect(output).toMatch(/Success/)
}

describe.runIf(runsBuilds)('the emitted world C builds against real MSXgl', () => {
  it(
    'packed rooms, with doors',
    () => {
      const { output, root } = buildFixture({
        name: 'worldpack',
        template: 'template',
        machine: '1',
        resources: fixture(true, [{ room: 0, x: 4, y: 5, to: 3, toX: 10, toY: 12 }]),
        main: MAIN,
        libModules: ['compress']
      })
      expectClean(output)
      expect(existsSync(join(root, 'out', 'worldpack.rom'))).toBe(true)
    },
    BUILD_TIMEOUT
  )

  /*
   * Booted in openMSX by hand when this was written (MSXDEVSTUDIO_KEEP_SCRATCH=1,
   * then \`vpeek\` the name table at 0x1800 a row at a time): packed and raw
   * both drew room 0 — 16 rows of tile 0, then tile 1 — and the HUD build drew
   * it two rows lower, leaving rows 0-1 alone.
   */
  it(
    'raw rooms under a HUD, no doors',
    () => {
      const { output, root } = buildFixture({
        name: 'worldraw',
        template: 'template',
        machine: '1',
        resources: fixture(false, [], true),
        main: MAIN
      })
      expectClean(output)
      expect(existsSync(join(root, 'out', 'worldraw.rom'))).toBe(true)
    },
    BUILD_TIMEOUT
  )
})
