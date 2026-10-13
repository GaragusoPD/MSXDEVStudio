/**
 * A tileset's generated `_Animate()`, compiled and linked by the **real** MSXgl —
 * one build per VRAM write path the generator can emit, because each calls a
 * different engine function under a different configuration:
 *
 * - SCREEN 2, common set: `VDP_LoadPattern_GM2`, plus `VDP_LoadColor_GM2` only
 *   for an animation whose poses differ in colour;
 * - SCREEN 2, a bank's own art: `VDP_LoadBankPattern_GM2`/`_LoadBankColor_GM2`;
 * - SCREEN 1: `VDP_WriteVRAM` straight into the one pattern table, on MSX1
 *   (14-bit addressing, where it is a macro) and MSX2 (17-bit, a function).
 *
 * `main` calls every entry point: a helper that is declared and never called
 * links fine even when its body references something that does not exist.
 */

import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { defaultExport, type ResourceDoc } from '../../shared/msx/resource'
import { attachAnimation, normalizeTileAnim, type TileAnimDoc } from '../../shared/msx/tile-anim'
import { normalizeTiles, type TileEntry, type TilesDoc } from '../../shared/msx/tile'
import { BUILD_TIMEOUT, buildFixture, cleanBuildFixtures, runsBuilds } from './__fixtures__/msxgl-build'

afterAll(cleanBuildFixtures)

const entry = (mark: number, color: number, sc1 = false): TileEntry => ({
  pattern: new Array(8).fill(mark),
  color: sc1 ? [] : new Array(8).fill(color)
})

function anim(name: string, mode: 'sc1' | 'sc2', width: number, poses: number, colorOf: (pose: number) => number, loop = 'loop'): TileAnimDoc {
  return normalizeTileAnim({
    mode,
    width,
    height: 1,
    loop,
    frames: Array.from({ length: poses }, (_, pose) => ({
      tiles: Array.from({ length: width }, (_, cell) => entry(0x11 * (pose + 1) + cell, colorOf(pose), mode === 'sc1')),
      duration: 4
    })),
    export: { ...defaultExport(`res/${name}.anim-tiles.json`), name: `g_${name[0].toUpperCase()}${name.slice(1)}` }
  })
}

/** The tileset, `g_Tiles` with helpers on, and every animation's own resource. */
function resources(tiles: TilesDoc, anims: Record<string, TileAnimDoc>): Record<string, ResourceDoc> {
  const out: Record<string, ResourceDoc> = {
    'tiles.tiles': { kind: 'tiles', doc: { ...tiles, export: { ...defaultExport('res/tiles.tiles.json'), name: 'g_Tiles', out: 'content/tiles.h', helpers: true } } }
  }
  for (const [name, doc] of Object.entries(anims)) out[`${name}.anim-tiles`] = { kind: 'anim', doc }
  return out
}

const main = (load: string): string => `#include "msxgl.h"
#include "content/tiles.h"

void main(void)
{
${load}
\tg_Tiles_AnimReset();
\tfor(u8 i = 0; i < 20; ++i)
\t{
\t\tHalt();
\t\tg_Tiles_Animate();
\t}
\tg_Tiles_AnimSetActive(0, FALSE);
\tg_Tiles_Animate();
\twhile(1) { Halt(); }
}
`

const LOAD_GM2 = `\tVDP_SetMode(VDP_MODE_GRAPHIC2);
\tVDP_LoadPattern_GM2(g_Tiles_Patterns, G_TILES_PATTERNS_SIZE / 8, 0);
\tVDP_LoadColor_GM2(g_Tiles_Colors, G_TILES_COLORS_SIZE / 8, 0);`

function expectRom(output: string, root: string, name: string): void {
  expect(output).not.toMatch(/\bError:/i)
  expect(output).not.toMatch(/Undefined Global/i)
  expect(output).toMatch(/Success/)
  const rom = join(root, 'out', `${name}.rom`)
  expect(existsSync(rom), `${rom} should exist`).toBe(true)
  expect(statSync(rom).size).toBeGreaterThan(1024)
}

describe.runIf(runsBuilds)('the emitted tile-animation C builds against real MSXgl', () => {
  it(
    'SCREEN 2, common set: one animation copying patterns only, one copying colours too',
    () => {
      const coin = anim('coin', 'sc2', 1, 4, () => 0xb5)
      const flag = anim('flag', 'sc2', 2, 3, (pose) => 0xf0 | (pose + 2), 'pingpong')
      let tiles = normalizeTiles({ mode: 'sc2', count: 8 })
      tiles = attachAnimation(tiles, 'res/coin.anim-tiles.json', coin, { slot: 2, bank: null, name: 'g_Coin' })
      tiles = attachAnimation(tiles, 'res/flag.anim-tiles.json', flag, { slot: 4, bank: null, name: 'g_Flag' })
      const { output, root } = buildFixture({
        name: 'animgm2',
        template: 'template',
        machine: '1',
        resources: resources(tiles, { coin, flag }),
        main: main(LOAD_GM2)
      })
      expectRom(output, root, 'animgm2')
    },
    BUILD_TIMEOUT
  )

  it(
    "SCREEN 2, a bank's own art",
    () => {
      const water = anim('water', 'sc2', 1, 2, (pose) => (pose ? 0x45 : 0x54), 'once')
      const bank = Array.from({ length: 6 }, (_, i) => entry(i, 0xf1))
      let tiles = normalizeTiles({ mode: 'sc2', count: 1, bankTiles: [bank, bank, bank] })
      tiles = attachAnimation(tiles, 'res/water.anim-tiles.json', water, { slot: 3, bank: 2, name: 'g_Water' })
      const { output, root } = buildFixture({
        name: 'animbank',
        template: 'template',
        machine: '1',
        resources: resources(tiles, { water }),
        main: main('\tVDP_SetMode(VDP_MODE_GRAPHIC2);\n\tg_Tiles_Load();')
      })
      expectRom(output, root, 'animbank')
    },
    BUILD_TIMEOUT
  )

  for (const machine of ['1', '2'] as const) {
    it(
      `SCREEN 1 on MSX${machine}: patterns straight into the one table`,
      () => {
        const torch = anim('torch', 'sc1', 2, 3, () => 0)
        let tiles = normalizeTiles({ mode: 'sc1', count: 8 })
        tiles = attachAnimation(tiles, 'res/torch.anim-tiles.json', torch, { slot: 4, bank: null, name: 'g_Torch' })
        const name = `animsc1m${machine}`
        const { output, root } = buildFixture({
          name,
          template: machine === '1' ? 'template' : 'template_msx2',
          machine,
          resources: resources(tiles, { torch }),
          main: main('')
        })
        expectRom(output, root, name)
      },
      BUILD_TIMEOUT
    )
  }
})

describe.runIf(runsBuilds)('restarting one animation and reading its pose builds against real MSXgl', () => {
  it(
    'a looping coin and a play-once door, the door restarted on its own',
    () => {
      const coin = anim('coin', 'sc2', 1, 4, () => 0xb5)
      const door = anim('door', 'sc2', 1, 3, () => 0x45, 'once')
      let tiles = normalizeTiles({ mode: 'sc2', count: 8 })
      tiles = attachAnimation(tiles, 'res/coin.anim-tiles.json', coin, { slot: 2, bank: null, name: 'g_Coin' })
      tiles = attachAnimation(tiles, 'res/door.anim-tiles.json', door, { slot: 4, bank: null, name: 'g_Door' })
      const { output, root } = buildFixture({
        name: 'animrestart',
        template: 'template',
        machine: '1',
        resources: resources(tiles, { coin, door }),
        // Each frame writes both poses into the first two name-table cells, so
        // an emulator can read them back; at frame 50 only the door restarts.
        main: `#include "msxgl.h"
#include "content/tiles.h"

void main(void)
{
\tu8 count = 0;
${LOAD_GM2}
\tg_Tiles_AnimReset();
\twhile(1)
\t{
\t\tHalt();
\t\tg_Tiles_Animate();
\t\tif(++count == 50) g_Tiles_AnimRestart(G_TILES_ANIM_DOOR);
\t\tVDP_Poke_16K(g_Tiles_AnimGetFrame(G_TILES_ANIM_COIN), g_ScreenLayoutLow + 0);
\t\tVDP_Poke_16K(g_Tiles_AnimGetFrame(G_TILES_ANIM_DOOR), g_ScreenLayoutLow + 1);
\t}
}
`
      })
      expectRom(output, root, 'animrestart')
    },
    BUILD_TIMEOUT
  )
})
