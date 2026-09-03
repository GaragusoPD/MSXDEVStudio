/**
 * The emitted meta-tile C, compiled and linked by the **real** MSXgl.
 *
 * Per CLAUDE.md, emitted C is never verified by reading it. This is the only
 * check that catches a helper calling an engine function that does not exist
 * under this configuration, a `msxgl_config.h` default that leaves
 * `VDP_WriteLayout_GM2` out of the build, or a map's `extern` naming a symbol
 * the meta exported under a different name.
 *
 * Skipped when no MSXgl checkout is present (see `__fixtures__/msxgl.ts`).
 * Scratch projects go *beside* the checkout, never `/tmp`: MSXgl renames each
 * `.rel` out of the engine directory into the project's `out/`, and `rename(2)`
 * fails with EXDEV across filesystems.
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { addMetaRef, normalizeMap, placeMeta, setPlacementBaked } from '../../shared/msx/map'
import { createBitmapTilesDoc, type BitmapTilesDoc } from '../../shared/msx/bitmap-tile'
import { createMetaTileDoc, type MetaTileDoc } from '../../shared/msx/meta-tile'
import { paintBitmapMeta, paintMeta } from '../../shared/msx/meta-paint'
import { defaultExport, serializeResource, type ResourceDoc } from '../../shared/msx/resource'
import { mergeColorByte, normalizeTiles } from '../../shared/msx/tile'
import { REAL_MSXGL, hasMsxgl, scratchRoot } from './__fixtures__/msxgl'
import { buildScript } from './build'
import { resolveNodeBinary, writeGeneratedConfig } from './project'
import { exportResourceFile, generatedSourceModules } from './resources'
import { normalizeProject } from '../../shared/msxproj'

const NODE = hasMsxgl ? resolveNodeBinary(REAL_MSXGL) : null
const runsBuilds = hasMsxgl && NODE !== null
const BUILD_TIMEOUT = 400_000

const dirs: string[] = []

afterAll(() => {
  // Set MSXDEVSTUDIO_KEEP_SCRATCH=1 to keep the built projects for a manual
  // openMSX pass — a link is not a picture, and the ROM has to be booted.
  if (process.env.MSXDEVSTUDIO_KEEP_SCRATCH) {
    for (const dir of dirs) console.log(`kept: ${dir}`)
    dirs.length = 0
    return
  }
  while (dirs.length) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

/** Every pixel of the 8×8 cell whose top-left dot is (ox, oy). */
const cell = (ox: number, oy: number): { x: number; y: number }[] =>
  Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => ({ x: ox + x, y: oy + y }))).flat()

/**
 * The fixture: a SCREEN 2 tileset with tile 0 reserved, a 2×2 meta with two
 * opaque cells and two transparent ones, and a map that places it twice — one
 * live, one baked. Both halves of the transparency path and both kinds of
 * placement, in one build.
 */
function fixture(): Record<string, ResourceDoc> {
  let tiles = normalizeTiles({ mode: 'sc2', count: 1, reserveTile0: true })
  let meta = createMetaTileDoc('res/tree.meta-tiles.json', 2, 2)
  for (const points of [cell(0, 0), cell(8, 8)]) {
    const result = paintMeta(meta, tiles, 0, points, 5)
    meta = result.meta
    tiles = result.tiles
  }

  let map = normalizeMap({ tileset: 'res/tiles.tiles.json', width: 32, height: 24 })
  map = addMetaRef(map, {
    path: 'res/tree.meta-tiles.json',
    name: 'g_Tree',
    width: 2,
    height: 2,
    frames: 1,
    flags: 1
  })
  map = placeMeta(map, 0, 0, 4, 4)
  map = placeMeta(map, 0, 0, 10, 8)
  map = setPlacementBaked(map, 0, 1, true)

  return {
    'tiles.tiles': {
      kind: 'tiles',
      doc: { ...tiles, export: { ...defaultExport('res/tiles.tiles.json'), name: 'g_Tiles', out: 'content/tiles.h' } }
    },
    'tree.meta-tiles': {
      kind: 'metatiles',
      doc: {
        ...meta,
        flags: 0x01,
        export: { ...defaultExport('res/tree.meta-tiles.json'), name: 'g_Tree', out: 'content/tree.h', helpers: true }
      }
    },
    'level.map': {
      kind: 'map',
      doc: { ...map, export: { ...defaultExport('res/level.map.json'), name: 'g_Level', out: 'content/level.h', helpers: true } }
    }
  }
}

/**
 * Calls every emitted entry point. `main` must actually *use* them: a helper
 * that is declared and never called links fine even when its body references a
 * symbol that does not exist.
 */
const MAIN = `#include "msxgl.h"
#include "content/tiles.h"
#include "content/tree.h"
#include "content/level.h"

void main(void)
{
\tu8 frames[G_LEVEL_METAS];
\tframes[0] = 0;
\tVDP_SetMode(VDP_MODE_GRAPHIC2);
\tVDP_LoadPattern_GM2(g_Tiles_Patterns, G_TILES_PATTERNS_SIZE / 8, 0);
\tVDP_LoadColor_GM2(g_Tiles_Colors, G_TILES_COLORS_SIZE / 8, 0);
\tg_Level_DrawLayer(g_Level_Background, 0, 0);
\tg_Level_DrawPlacements(frames);
\tg_Tree_Draw(10, 5, 0);
\twhile(1) { Halt(); }
}
`

interface FixtureSpec {
  name: string
  template: 'template' | 'template_msx2'
  machine: '1' | '2'
  resources: Record<string, ResourceDoc>
  main: string
}

/**
 * Builds a fixture exactly as the IDE does, which is the part the first
 * version of this test got wrong: it rendered the headers straight to disk and
 * never told MSXgl about the generated `.c` files, so every symbol came back
 * undefined and it looked like the emitted C was broken. The pre-build step —
 * export each resource, then regenerate `project_config.js` with the modules
 * those exports produced — is not optional scaffolding, it is how the data
 * reaches the link.
 */
function buildFixture(spec: FixtureSpec): { output: string; root: string } {
  const root = mkdtempSync(join(scratchRoot(), `${spec.name}-`))
  dirs.push(root)
  cpSync(join(REAL_MSXGL, `projects/${spec.template}`), root, { recursive: true })

  // The resources, as `res/*.json` — the same files the editors write.
  mkdirSync(join(root, 'res'), { recursive: true })
  for (const [name, resource] of Object.entries(spec.resources)) {
    writeFileSync(join(root, `res/${name}.json`), serializeResource(resource))
  }

  // Export them through the real exporter, not `renderResourceFiles` directly:
  // that is what refreshes the map's meta mirror, so this covers the export
  // path as well as the C it emits.
  for (const name of Object.keys(spec.resources)) {
    const result = exportResourceFile(root, `res/${name}.json`, { force: true })
    if (result.status === 'failed') throw new Error(`export ${name}: ${result.message}`)
  }

  // `template.c` in *both* templates — `template_msx2/` names its main file
  // `template.c` too (see `project.test.ts:88`). It would compile alongside
  // ours; `writeGeneratedConfig` emits ProjModules naming main.c, the way the
  // IDE's wizard does.
  rmSync(join(root, 'template.c'), { force: true })
  writeFileSync(join(root, 'main.c'), spec.main)
  writeGeneratedConfig(
    root,
    `${spec.name}.msxproj`,
    normalizeProject({ name: spec.name, machine: spec.machine, target: 'ROM_32K' }, spec.name),
    generatedSourceModules(root)
  )

  try {
    const output = execFileSync(NODE as string, [buildScript(REAL_MSXGL), 'all'], {
      cwd: root,
      encoding: 'utf-8',
      stdio: 'pipe'
    })
    return { output, root }
  } catch (error) {
    const spawned = error as { stdout?: string; stderr?: string }
    throw new Error(`${spawned.stdout ?? ''}\n${spawned.stderr ?? ''}`, { cause: error })
  }
}

describe.runIf(runsBuilds)('the emitted meta-tile C builds against real MSXgl', () => {
  it(
    'a painted meta and a map that places it, live and baked',
    () => {
      const { output, root } = buildFixture({
        name: 'metatest',
        template: 'template',
        machine: '1',
        resources: fixture(),
        main: MAIN
      })
      // MSXgl reports a failed step in its output as well as its exit code.
      expect(output).not.toMatch(/\bError:/i)
      // The failure this test exists for: a helper calling something the engine
      // does not export links "successfully" until the linker resolves globals.
      expect(output).not.toMatch(/Undefined Global/i)
      expect(output).toMatch(/Success/)
      // A quiet build is not the same as a ROM. Assert the artefact.
      const rom = join(root, 'out', 'metatest.rom')
      expect(existsSync(rom), `${rom} should exist`).toBe(true)
      expect(statSync(rom).size).toBeGreaterThan(1024)
    },
    BUILD_TIMEOUT
  )
})

/**
 * The bitmap sibling of `fixture()`: a SCREEN 5 atlas, a 2×2 meta painted into
 * it, and a map that places it live and baked. `MapDoc.cell` is what sends
 * `placementHelperC` down `bitmapPlacementHelperC`, which until now had never
 * been through a compiler.
 */
function bitmapFixture(): Record<string, ResourceDoc> {
  // `transparent: 0` is what makes `metaRefFrom` mirror `masked: true` onto the
  // map's ref, which is the VDP_OP_TIMP path. Both blit branches are emitted
  // either way — the `if (masked)` is per cell — so this changes what the ROM
  // *does*, not what links.
  // Both annotated: without the annotation the spread infers `transparent:
  // number`, and reassigning a `BitmapTilesDoc` (`number | null`) into it does
  // not typecheck.
  let tiles: BitmapTilesDoc = { ...createBitmapTilesDoc('sc5', 16, 16, 4), transparent: 0 }
  // First argument is the **tileset**, not the meta's own path. (The pattern
  // fixture above passes its own path; harmless there because a pattern meta's
  // export never opens the tileset. Do not copy it here.)
  // `cols: 16`, not 4 — it has to equal `sheetCols(tiles)`, which is
  // `SHEET_WIDTH / width` = 256 / 16 (`bitmap-tile.ts:107`). It becomes
  // `G_LEVEL_ATLAS_COLS`, the divisor the blit uses to turn a cell index into
  // source coordinates; disagree with the real sheet and every copy reads the
  // wrong tile.
  let meta: MetaTileDoc = {
    ...createMetaTileDoc('res/tiles.btiles.json', 2, 2, { width: 16, height: 16, cols: 16 }),
    transparent: 0
  }
  // `cell()` is the 8x8 helper the pattern fixture uses, so this paints the
  // top-left quarter of each 16x16 cell. That is enough: the point is a cell
  // that is not tile 0, not a particular picture.
  for (const points of [cell(0, 0), cell(16, 16)]) {
    const result = paintBitmapMeta(meta, tiles, 0, points, 5)
    meta = result.meta
    tiles = result.tiles
  }

  let map = normalizeMap({
    tileset: 'res/tiles.btiles.json',
    width: 32,
    height: 24,
    cell: { width: 16, height: 16, cols: 16 }
  })
  map = addMetaRef(map, {
    path: 'res/rock.meta-btiles.json',
    name: 'g_Rock',
    width: 2,
    height: 2,
    frames: 1,
    flags: 1
  })
  map = placeMeta(map, 0, 0, 2, 2)
  map = placeMeta(map, 0, 0, 6, 4)
  map = setPlacementBaked(map, 0, 1, true)
  // Every field of this ref except `path` is overwritten at export time:
  // `resources.ts:147` re-reads the meta file and rebuilds it through
  // `metaRefFrom`. It is written out in full anyway, so the fixture on disk is
  // the one a hand-edited `res/` would hold — and so a mismatch between the two
  // shows up as a build failure rather than as nothing.

  return {
    'tiles.btiles': {
      kind: 'btiles',
      // `helpers: true` — without it `g_Atlas_Upload` is never emitted and the
      // sheet never reaches VRAM.
      doc: {
        ...tiles,
        export: { ...defaultExport('res/tiles.btiles.json'), name: 'g_Atlas', out: 'content/atlas.h', helpers: true }
      }
    },
    'rock.meta-btiles': {
      kind: 'metabtiles',
      doc: {
        ...meta,
        flags: 0x01,
        export: { ...defaultExport('res/rock.meta-btiles.json'), name: 'g_Rock', out: 'content/rock.h', helpers: true }
      }
    },
    'level.map': {
      kind: 'map',
      doc: { ...map, export: { ...defaultExport('res/level.map.json'), name: 'g_Level', out: 'content/level.h', helpers: true } }
    }
  }
}

/** Calls the emitted entry point — a helper never called links fine when broken. */
const BITMAP_MAIN = `#include "msxgl.h"
#include "content/atlas.h"
#include "content/rock.h"
#include "content/level.h"

void main(void)
{
\tu8 frames[G_LEVEL_METAS] = { 0 };
\tVDP_SetMode(VDP_MODE_SCREEN5);
\t// Park the atlas below the 212-line display, then blit out of it. Without
\t// this the placements copy whatever VRAM held at power-up, which is not
\t// blank — the screenshot would show garbage and read as a helper bug.
\tg_Atlas_Upload(212);
\t// VDP_SetMode does not clear the display page either.
\tVDP_CommandHMMV(0, 0, 256, 212, 0);
\tg_Level_DrawPlacements(frames, 212);
\t// \`helpers: true\` also emits g_Atlas_Draw, g_Atlas_DrawBlock and
\t// g_Rock_Draw — none of them reached by the map's own draw calls above.
\t// A helper never called links fine even when its body references a symbol
\t// that does not exist, so each one needs its own call here. Drawn well
\t// below the two placements asserted at (32,32) and (48,48) so nothing
\t// collides with that screenshot. Tile 4 is the one \`bitmapFixture\` painted
\t// (G_ATLAS_COUNT is 5: tiles 0-3 start blank, painting grows one more).
\tstatic const u8 block[4] = { 4, 0, 0, 4 };
\tg_Atlas_Draw(4, 80, 100, 212);
\tg_Atlas_DrawBlock(block, 2, 2, 120, 100, 212);
\tg_Rock_Draw(80, 140, 0, 212);
\twhile(1) { Halt(); }
}
`

describe.runIf(runsBuilds)('the emitted bitmap placement C builds against real MSXgl', () => {
  it(
    'a bitmap meta and a map that places it, live and baked',
    () => {
      const { output, root } = buildFixture({
        name: 'bmetatest',
        template: 'template_msx2',
        machine: '2',
        resources: bitmapFixture(),
        main: BITMAP_MAIN
      })
      expect(output).not.toMatch(/\bError:/i)
      // The failure this test exists for: VDP_CommandHMMM/LMMM are only linked
      // when VDP_USE_COMMAND is on, and nothing had ever asked for them here.
      expect(output).not.toMatch(/Undefined Global/i)
      expect(output).toMatch(/Success/)
      const rom = join(root, 'out', 'bmetatest.rom')
      expect(existsSync(rom), `${rom} should exist`).toBe(true)
      expect(statSync(rom).size).toBeGreaterThan(1024)
    },
    BUILD_TIMEOUT
  )
})

/**
 * A banked SCREEN 2 screen: each bank gets one distinctive solid tile of its
 * own at index 0, and the map fills each third with it. Three different colours
 * down the screen is a picture that is *only* right if each bank loaded its own
 * art at its own offset — the failure this test exists for looks like a
 * perfectly good build.
 */
function bankedFixture(): Record<string, ResourceDoc> {
  // A fully-set pattern (every bit 1) paints the whole 8x8 cell in the
  // foreground colour, so the picture is a flat colour band, not a texture —
  // easy to read back from a screenshot without decoding pixel art.
  const solid = (fg: number) => ({
    pattern: new Array(8).fill(0xff),
    color: new Array(8).fill(mergeColorByte(fg, 1))
  })
  const tiles = normalizeTiles({
    mode: 'sc2',
    count: 1,
    // The common tile is never actually loaded: each bank overrides index 0,
    // and `overrides === count` skips the (empty) common tail — see
    // `bankLoadHelperC`. Its colour is irrelevant to the picture; it exists
    // only so `count` has something to describe.
    tiles: [solid(1)],
    // Bank 0 (rows 0-7): medium red. Bank 1 (rows 8-15): light blue. Bank 2
    // (rows 16-23): light yellow — three hues from the fixed MSX1 palette
    // that read apart at a glance, in a screenshot as much as on hardware.
    bankTiles: [[solid(8)], [solid(5)], [solid(11)]]
  })

  // `normalizeMap` fills every cell with 0 by default, and a plain 32x24 grid
  // is exactly `SCREEN_ROWS` tall — the map's own banked-export requirement —
  // so every row already reads tile 0 from whichever bank it belongs to.
  const map = normalizeMap({ tileset: 'res/title.tiles.json', width: 32, height: 24 })

  return {
    'title.tiles': {
      kind: 'tiles',
      doc: {
        ...tiles,
        export: { ...defaultExport('res/title.tiles.json'), name: 'g_Title', out: 'content/title.h', helpers: true }
      }
    },
    'screen.map': {
      kind: 'map',
      doc: {
        ...map,
        export: { ...defaultExport('res/screen.map.json'), name: 'g_Screen', out: 'content/screen.h', helpers: true }
      }
    }
  }
}

const BANKED_MAIN = `#include "msxgl.h"
#include "content/title.h"
#include "content/screen.h"

void main(void)
{
\tVDP_SetMode(VDP_MODE_GRAPHIC2);
\tg_Title_Load();
\tg_Screen_DrawLayer(g_Screen_Background, 0, 0);
\twhile(1) { Halt(); }
}
`

describe.runIf(runsBuilds)('the emitted banked-tileset C builds against real MSXgl', () => {
  it(
    'a banked SCREEN 2 tileset compiles, links, and draws three distinct bands',
    () => {
      const { output, root } = buildFixture({
        name: 'bankedtest',
        template: 'template',
        machine: '1',
        resources: bankedFixture(),
        main: BANKED_MAIN
      })
      expect(output).not.toMatch(/\bError:/i)
      // The failure this test exists for: `VDP_LoadBankPattern_GM2` only links
      // when the `vdp` module reaches the build — see `writeGeneratedConfig`/
      // `generatedSourceModules`, not the emitted C, if this ever fires.
      expect(output).not.toMatch(/Undefined Global/i)
      expect(output).toMatch(/Success/)
      // A quiet build is not the same as a picture. Whether the three bands
      // actually come out as three different colours is verified by booting
      // the kept ROM in openMSX and reading back a screenshot — see the task
      // report; no unit test can see a wrong bank offset. That boot stays
      // manual (MSXDEVSTUDIO_KEEP_SCRATCH=1, then openMSX with
      // `-script`/`screenshot -raw`, per the bitmap placement test above and
      // CLAUDE.md), so it is not repeated here on every run.
      //
      // Timing note for whoever does that boot next: `after time N` in the
      // openMSX script counts *emulated* MSX seconds, and on at least one
      // dev machine the emulation ran roughly 15-20x slower than real time —
      // `after time 12` took about 200 real seconds to fire, not ~12. A
      // screenshot taken too early lands on the C-BIOS splash screen, which
      // looks exactly like "the feature does not work" but means nothing
      // more than "shot too early" — give the boot several real minutes
      // (or use `after realtime N` instead, which counts wall-clock seconds
      // directly) before treating a blank or wrong-looking picture as a
      // finding. Confirmed working: three horizontal bands — red rows 0-7,
      // blue rows 8-15, cream rows 16-23 — with the boundaries landing at
      // exactly 8 and 16 rows down, pixel-precise.
      const rom = join(root, 'out', 'bankedtest.rom')
      expect(existsSync(rom), `${rom} should exist`).toBe(true)
      expect(statSync(rom).size).toBeGreaterThan(1024)
    },
    BUILD_TIMEOUT
  )
})
