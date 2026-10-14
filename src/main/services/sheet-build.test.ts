/**
 * Characters imported from a sheet, compiled and linked by the **real** MSXgl
 * and drawn by the export's own helpers: the same multi-colour walker as
 * hardware sprites (split into stacked mode-2 planes, a metasprite two sprites
 * tall, drawn by `_SetMeta()`) and as a SCREEN 5 software sprite (uploaded once,
 * blitted with the VDP's transparency by `_Draw()`). The conversions are held to
 * the editor's composite in `sheet-convert.test.ts`; this is whether what they
 * make is a sheet the export and the engine take. With
 * MSXDEVSTUDIO_KEEP_SCRATCH=1 each also writes what the screen should show, for
 * an openMSX boot to compare against.
 */

import { existsSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { MSX1_PALETTE_GRB, MSX1_PALETTE_RGB, packGrb, unpackGrb } from '../../shared/msx/palette'
import { defaultExport } from '../../shared/msx/resource'
import { cellsToSprite, cellsToSwSprite, type SheetCell } from '../../shared/msx/sheet-convert'
import { normalizeSwSprites, swFramePixels } from '../../shared/msx/swsprite'
import { compositeFrame, createSpritesDoc, type SpritesDoc } from '../../shared/msx/sprite'
import { BUILD_TIMEOUT, buildFixture, cleanBuildFixtures, runsBuilds } from './__fixtures__/msxgl-build'

afterAll(cleanBuildFixtures)

/** A 12×22 walker in MSX1 colours: hair, face with eyes, shirt with bare arms, legs that step, shoes. */
function walker(frame: number): SheetCell {
  const width = 12
  const height = 22
  const step = [0, 1, 0, -1][frame]
  const indices = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let color = 0
      if (y < 3 && x >= 3 && x < 9) color = 6 // hair
      else if (y < 7 && x >= 3 && x < 9) color = y === 4 && (x === 4 || x === 7) ? 1 : 9 // face, eyes
      else if (y >= 7 && y < 13 && x >= 2 && x < 10) color = (x === 2 || x === 9) && y > 8 ? 9 : 5 // shirt, arms
      else if (y < 19 && ((x >= 3 + step && x < 5 + step) || (x >= 7 - step && x < 9 - step))) color = 14 // legs
      else if (y >= 19 && y < 21 && ((x >= 2 + step && x < 5 + step) || (x >= 7 - step && x < 10 - step))) color = 1 // shoes
      indices[y * width + x] = color
    }
  }
  return { width, height, indices }
}

describe.runIf(runsBuilds)('a character imported from a sheet builds against real MSXgl', () => {
  it(
    'four frames of a mode-2 metasprite, drawn with _SetMeta',
    () => {
      const frames = [0, 1, 2, 3].map(walker)
      const made = cellsToSprite(frames, { mode: 2, size: 16, maxPlanes: 3, palette: MSX1_PALETTE_RGB, name: 'walker' })
      if (typeof made === 'string') throw new Error(made)
      expect([made.character.cols, made.character.rows]).toEqual([1, 2])
      const doc: SpritesDoc = {
        ...createSpritesDoc(2, 16),
        sprites: [made.character],
        export: { ...defaultExport('res/hero.sprites.json'), name: 'g_Hero', out: 'content/hero.h', helpers: true }
      }
      const { output, root } = buildFixture({
        name: 'sheetsprite',
        template: 'template_msx2',
        machine: '2',
        resources: { 'hero.sprites': { kind: 'sprites', doc } },
        main: `#include "msxgl.h"
#include "content/hero.h"

void main(void)
{
\tVDP_SetMode(VDP_MODE_SCREEN5);
\tVDP_SetColor(4);
\t// VRAM is not cleared at boot: paint the page in the backdrop colour.
\tVDP_CommandHMMV(0, 0, 256, 212, 0x44);
\tVDP_EnableSprite(TRUE);
\tVDP_SetSpriteFlag(VDP_SPRITE_SIZE_16);
\tVDP_LoadSpritePattern(g_Hero_Patterns, 0, G_HERO_PATTERNS_SIZE / 8);
\tVDP_DisableSpritesFrom(G_HERO_WALKER_PLANES);
\tu8 frame = 0;
\tu8 ticks = 0;
\twhile(1)
\t{
\t\tHalt();
\t\tg_Hero_SetMeta(0, 120, 90, G_HERO_WALKER_BASE + frame * G_HERO_WALKER_PLANES, G_HERO_WALKER_PLANES);
\t\tif(++ticks == 50)
\t\t{
\t\t\tticks = 0;
\t\t\tframe = (frame + 1) & 3;
\t\t}
\t}
}
`
      })
      expect(output).not.toMatch(/\bError:/i)
      expect(output).not.toMatch(/Undefined Global/i)
      expect(output).toMatch(/Success/)
      const rom = join(root, 'out', 'sheetsprite.rom')
      expect(existsSync(rom), `${rom} should exist`).toBe(true)
      expect(statSync(rom).size).toBeGreaterThan(1024)
      if (process.env.MSXDEVSTUDIO_KEEP_SCRATCH) {
        const { cols, rows } = made.character
        writeFileSync(
          join(root, 'expected.json'),
          JSON.stringify({
            at: { x: 120, y: 90 },
            width: cols * 16,
            height: rows * 16,
            frames: made.character.frames.map((frame) => Array.from(compositeFrame(frame.layers, 2, 16, cols, rows)))
          })
        )
      }
    },
    BUILD_TIMEOUT
  )
})

describe.runIf(runsBuilds)('a software sprite imported from a sheet builds against real MSXgl', () => {
  it(
    'four frames in SCREEN 5, uploaded once and blitted with _Draw',
    () => {
      const frames = [0, 1, 2, 3].map(walker)
      const made = cellsToSwSprite('sc5', frames, 'walker')
      if (typeof made === 'string') throw new Error(made)
      // SCREEN 5 draws whole bytes: the 12-dot walker is already two dots a byte.
      expect([made.width, made.height, made.frames]).toEqual([12, 22, 4])
      // Colours the default palette does not have, so a screenshot shows
      // whether `_Palette` reached the VDP — and reached the right entries.
      const palette = [...MSX1_PALETTE_GRB]
      palette[1] = packGrb(7, 0, 7) // magenta
      palette[5] = packGrb(0, 7, 0) // green
      palette[6] = packGrb(7, 7, 0) // yellow
      palette[9] = packGrb(0, 7, 7) // cyan
      palette[14] = packGrb(4, 4, 4) // grey
      const doc = normalizeSwSprites({
        mode: 'sc5',
        palette,
        transparent: 0,
        sprites: [made],
        export: { ...defaultExport('res/cast.swsprites.json'), name: 'g_Cast', out: 'content/cast.h', helpers: true }
      })
      const { output, root } = buildFixture({
        name: 'sheetswsprite',
        template: 'template_msx2',
        machine: '2',
        resources: { 'cast.swsprites': { kind: 'swsprites', doc } },
        main: `#include "msxgl.h"
#include "content/cast.h"

// A global, so the backup survives the loop; set below, because RAM is not
// cleared at boot on a ROM target.
g_Cast_SwSprite walker;

void main(void)
{
\tVDP_SetMode(VDP_MODE_SCREEN5);
\t// Entries 1-15: the template's VDP_USE_PALETTE16 is FALSE.
\tVDP_SetPalette(g_Cast_Palette + 2);
\tVDP_SetColor(4);
\tVDP_CommandHMMV(0, 0, 256, 212, 0x44);
\tg_Cast_Upload(212);
\twalker.slot = 0;
\twalker.bw = 0;
\tu8 frame = 0;
\tu8 ticks = 0;
\twhile(1)
\t{
\t\tHalt();
\t\tg_Cast_Restore(&walker, 212);
\t\tg_Cast_Draw(&walker, G_CAST_WALKER, frame, 120, 90, 212);
\t\tif(++ticks == 50)
\t\t{
\t\t\tticks = 0;
\t\t\tframe = (frame + 1) & 3;
\t\t}
\t}
}
`
      })
      expect(output).not.toMatch(/\bError:/i)
      expect(output).not.toMatch(/Undefined Global/i)
      expect(output).toMatch(/Success/)
      const rom = join(root, 'out', 'sheetswsprite.rom')
      expect(existsSync(rom), `${rom} should exist`).toBe(true)
      if (process.env.MSXDEVSTUDIO_KEEP_SCRATCH) {
        writeFileSync(
          join(root, 'expected.json'),
          JSON.stringify({
            at: { x: 120, y: 90 },
            spriteLine: 0,
            palette: palette.map((grb) => unpackGrb(grb)),
            width: made.width,
            height: made.height,
            frames: [0, 1, 2, 3].map((f) => Array.from(swFramePixels(doc, 0, f)))
          })
        )
      }
    },
    BUILD_TIMEOUT
  )
})
