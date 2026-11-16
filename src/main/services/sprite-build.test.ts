/**
 * Animated hardware sprites, compiled and linked by the **real** MSXgl: the
 * per-character defines, `_Durations` and the animation helpers
 * (`_SetFrame`/`_AnimStep`) of `spriteAnimHelperC`, in both sprite modes.
 * `main` calls every helper the export emits — a helper that is declared but
 * never called links fine even when its body calls an API that does not exist.
 *
 * The MSX1 fixture is the one booted in openMSX to prove the frames advance by
 * the durations (MSXDEVSTUDIO_KEEP_SCRATCH=1 keeps the ROM): a still character
 * first, then two animated ones, so the animated characters' `_BASE` and
 * `_FRAME0` are not 0 and an off-by-one shows; distinct durations and colours
 * per frame; and counters of `_AnimStep`'s TRUE returns poked into the name
 * table — the blinking character's, and the still one's, which must stay 0 —
 * so a step that says "changed" when nothing did shows too.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { defaultExport } from '../../shared/msx/resource'
import { createLayer, normalizeSprites, type SpriteLayer } from '../../shared/msx/sprite'
import { BUILD_TIMEOUT, buildFixture, cleanBuildFixtures, runsBuilds } from './__fixtures__/msxgl-build'

afterAll(cleanBuildFixtures)

/** A 16×16 plane in `color`, its pattern `fill` on every row so each frame looks different. */
function plane(color: number, fill: number, cx = 0, cy = 0): SpriteLayer {
  return { ...createLayer(16, color, cx, cy), pattern: new Array<number>(32).fill(fill) }
}

describe.runIf(runsBuilds)('animated sprites build against real MSXgl', () => {
  it(
    'mode 1 on an MSX1: one-plane characters stepped by _AnimStep and shown by _SetFrame',
    () => {
      const doc = normalizeSprites({
        mode: 1,
        size: 16,
        sprites: [
          { name: 'still', frames: [{ layers: [plane(15, 0x3c)], duration: 8 }] },
          {
            name: 'blink',
            frames: [3, 6, 9, 12].map((duration, f) => ({ layers: [plane(4 + 2 * f, [0xff, 0x7e, 0x3c, 0x18][f])], duration }))
          },
          { name: 'pad', frames: [5, 10].map((duration, f) => ({ layers: [plane(2 + f, f ? 0xf0 : 0x0f)], duration })) }
        ],
        export: { ...defaultExport('res/blink.sprites.json'), name: 'g_Blink', out: 'content/blink.h', helpers: true }
      })
      const { output, root } = buildFixture({
        name: 'spriteanim1',
        template: 'template',
        machine: '1',
        resources: { 'blink.sprites': { kind: 'sprites', doc } },
        main: `#include "msxgl.h"
#include "content/blink.h"

// Globals, zeroed in main: RAM is not cleared at boot on a ROM target.
u8 g_StillAnim[2];
u8 g_BlinkAnim[2];
u8 g_PadAnim[2];
u8 g_Changes;
u8 g_StillChanges;

void main(void)
{
\tVDP_SetMode(VDP_MODE_SCREEN2);
\tVDP_EnableVBlank(TRUE);
\tVDP_SetColor(1);
\tVDP_ClearVRAM();
\tVDP_SetSpriteFlag(VDP_SPRITE_SIZE_16);
\tVDP_LoadSpritePattern(g_Blink_Patterns, 0, G_BLINK_PATTERNS_SIZE / 8);
\tg_StillAnim[0] = 0; g_StillAnim[1] = 0;
\tg_BlinkAnim[0] = 0; g_BlinkAnim[1] = 0;
\tg_PadAnim[0] = 0; g_PadAnim[1] = 0;
\tg_Changes = 0;
\tg_StillChanges = 0;
\tVDP_SetSpriteSM1(0, 60, 80, G_BLINK_STILL_PATTERN, 15);
\tVDP_SetSpriteSM1(1, 100, 80, 0, 15);
\tVDP_SetSpriteSM1(2, 140, 80, 0, 15);
\tVDP_DisableSpritesFrom(3);
\tg_Blink_SetFrame(1, G_BLINK_BLINK_ID, 0);
\tg_Blink_SetFrame(2, G_BLINK_PAD_ID, 0);
\twhile(1)
\t{
\t\tHalt();
\t\tif(g_Blink_AnimStep(G_BLINK_BLINK_ID, g_BlinkAnim))
\t\t{
\t\t\tg_Blink_SetFrame(1, G_BLINK_BLINK_ID, g_BlinkAnim[0]);
\t\t\t// Name-table byte 0: how often the step said "changed", for vpeek.
\t\t\tVDP_Poke_GM2(0, 0, ++g_Changes);
\t\t}
\t\tif(g_Blink_AnimStep(G_BLINK_PAD_ID, g_PadAnim))
\t\t\tg_Blink_SetFrame(2, G_BLINK_PAD_ID, g_PadAnim[0]);
\t\t// One frame: its step never says "changed". Name-table byte 1 counts it if it does.
\t\tif(g_Blink_AnimStep(G_BLINK_STILL_ID, g_StillAnim))
\t\t{
\t\t\tg_Blink_SetFrame(0, G_BLINK_STILL_ID, g_StillAnim[0]);
\t\t\tVDP_Poke_GM2(1, 0, ++g_StillChanges);
\t\t}
\t}
}
`
      })
      expect(output).not.toMatch(/\bError:/i)
      expect(output).not.toMatch(/Undefined Global/i)
      expect(output).toMatch(/Success/)
      const header = readFileSync(join(root, 'content/blink.h'), 'utf-8')
      expect(header).toContain('#define G_BLINK_BLINK_PATTERN 4')
      expect(header).toContain('#define G_BLINK_BLINK_FRAME0 1')
      expect(header).toContain('#define G_BLINK_PAD_PATTERN 20')
      const rom = join(root, 'out', 'spriteanim1.rom')
      expect(existsSync(rom), `${rom} should exist`).toBe(true)
      expect(statSync(rom).size).toBeGreaterThan(1024)
    },
    BUILD_TIMEOUT
  )

  it(
    'mode 2 on an MSX2: a metasprite placed by _SetMeta, animated with a one-plane character',
    () => {
      // Two cells tall, two frames, a colour per cell per frame.
      const walker = (color: number, fill: number): SpriteLayer[] => [plane(color, fill), plane(color + 1, fill, 0, 1)]
      const doc = normalizeSprites({
        mode: 2,
        size: 16,
        sprites: [
          { name: 'walker', rows: 2, frames: [{ layers: walker(6, 0xff), duration: 4 }, { layers: walker(8, 0x81), duration: 7 }] },
          { name: 'spark', frames: [2, 3, 5].map((duration, f) => ({ layers: [plane(10 + f, 0x55 << (f & 1))], duration })) }
        ],
        palette: null,
        export: { ...defaultExport('res/hero.sprites.json'), name: 'g_Hero', out: 'content/hero.h', helpers: true }
      })
      const { output, root } = buildFixture({
        name: 'spriteanim2',
        template: 'template_msx2',
        machine: '2',
        resources: { 'hero.sprites': { kind: 'sprites', doc } },
        main: `#include "msxgl.h"
#include "content/hero.h"

// Globals, zeroed in main: RAM is not cleared at boot on a ROM target.
u8 g_Walk[2];
u8 g_Spark[2];

void main(void)
{
\tVDP_SetMode(VDP_MODE_SCREEN5);
\tVDP_SetColor(4);
\t// VRAM is not cleared at boot: paint the page in the backdrop colour.
\tVDP_CommandHMMV(0, 0, 256, 212, 0x44);
\tVDP_EnableSprite(TRUE);
\tVDP_SetSpriteFlag(VDP_SPRITE_SIZE_16);
\tVDP_LoadSpritePattern(g_Hero_Patterns, 0, G_HERO_PATTERNS_SIZE / 8);
\tg_Walk[0] = 0; g_Walk[1] = 0;
\tg_Spark[0] = 0; g_Spark[1] = 0;
\tg_Hero_SetMeta(0, 120, 90, G_HERO_WALKER_BASE, G_HERO_WALKER_PLANES);
\tVDP_SetSpriteExMultiColor(G_HERO_WALKER_PLANES, 60, 90, G_HERO_SPARK_PATTERN, g_Hero_Colors + (u16)G_HERO_SPARK_BASE * 16);
\tVDP_DisableSpritesFrom(G_HERO_WALKER_PLANES + 1);
\twhile(1)
\t{
\t\tHalt();
\t\tif(g_Hero_AnimStep(G_HERO_WALKER_ID, g_Walk))
\t\t\tg_Hero_SetFrame(0, G_HERO_WALKER_ID, g_Walk[0]);
\t\tif(g_Hero_AnimStep(G_HERO_SPARK_ID, g_Spark))
\t\t\tg_Hero_SetFrame(G_HERO_WALKER_PLANES, G_HERO_SPARK_ID, g_Spark[0]);
\t}
}
`
      })
      expect(output).not.toMatch(/\bError:/i)
      expect(output).not.toMatch(/Undefined Global/i)
      expect(output).toMatch(/Success/)
      const header = readFileSync(join(root, 'content/hero.h'), 'utf-8')
      expect(header).toContain('void g_Hero_SetMeta(u8 index, u8 x, u8 y, u8 base, u8 planes);')
      expect(header).toContain('#define G_HERO_SPARK_BASE 4')
      expect(header).toContain('#define G_HERO_SPARK_FRAME0 2')
      const rom = join(root, 'out', 'spriteanim2.rom')
      expect(existsSync(rom), `${rom} should exist`).toBe(true)
      expect(statSync(rom).size).toBeGreaterThan(1024)
    },
    BUILD_TIMEOUT
  )
})
