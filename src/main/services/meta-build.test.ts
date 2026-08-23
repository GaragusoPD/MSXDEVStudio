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
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { addMetaRef, normalizeMap, placeMeta, setPlacementBaked } from '../../shared/msx/map'
import { createMetaTileDoc } from '../../shared/msx/meta-tile'
import { paintMeta } from '../../shared/msx/meta-paint'
import { defaultExport, renderResourceFiles, type ResourceDoc } from '../../shared/msx/resource'
import { normalizeTiles } from '../../shared/msx/tile'
import { REAL_MSXGL, hasMsxgl, scratchRoot } from './__fixtures__/msxgl'
import { buildScript } from './build'
import { resolveNodeBinary } from './project'

const NODE = hasMsxgl ? resolveNodeBinary(REAL_MSXGL) : null
const runsBuilds = hasMsxgl && NODE !== null
const BUILD_TIMEOUT = 400_000

const dirs: string[] = []

afterAll(() => {
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
function fixture(): { tiles: ResourceDoc; meta: ResourceDoc; map: ResourceDoc } {
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
    tiles: { kind: 'tiles', doc: { ...tiles, export: { ...defaultExport('res/tiles.tiles.json'), name: 'g_Tiles', out: 'content/tiles.h' } } },
    meta: { kind: 'metatiles', doc: { ...meta, flags: 0x01, export: { ...defaultExport('res/tree.meta-tiles.json'), name: 'g_Tree', out: 'content/tree.h', helpers: true } } },
    map: { kind: 'map', doc: { ...map, export: { ...defaultExport('res/level.map.json'), name: 'g_Level', out: 'content/level.h', helpers: true } } }
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

function buildFixture(): string {
  const root = mkdtempSync(join(scratchRoot(), 'meta-'))
  dirs.push(root)
  cpSync(join(REAL_MSXGL, 'projects/template'), root, { recursive: true })
  rmSync(join(root, 'template.c'), { force: true })

  mkdirSync(join(root, 'content'), { recursive: true })
  const resources = fixture()
  for (const [name, resource] of Object.entries(resources)) {
    const block = resource.doc.export!
    const files = renderResourceFiles(resource, `res/${name}.json`, block)
    const base = join(root, block.out.replace(/\.h$/, ''))
    if (files.header) writeFileSync(`${base}.h`, files.header)
    if (files.source) writeFileSync(`${base}.c`, files.source)
  }
  writeFileSync(join(root, 'template.c'), MAIN)

  try {
    return execFileSync(NODE as string, [buildScript(REAL_MSXGL), 'all'], {
      cwd: root,
      encoding: 'utf-8',
      stdio: 'pipe'
    })
  } catch (error) {
    const spawned = error as { stdout?: string; stderr?: string }
    throw new Error(`${spawned.stdout ?? ''}\n${spawned.stderr ?? ''}`, { cause: error })
  }
}

describe.runIf(runsBuilds)('the emitted meta-tile C builds against real MSXgl', () => {
  it(
    'a painted meta and a map that places it, live and baked',
    () => {
      const output = buildFixture()
      // MSXgl reports a failed step in its output as well as its exit code.
      expect(output).not.toMatch(/\bError:/i)
      // The failure this test exists for: a helper calling something the engine
      // does not export links "successfully" until the linker resolves globals.
      expect(output).not.toMatch(/Undefined Global/i)
      expect(output).toMatch(/Success/)
    },
    BUILD_TIMEOUT
  )
})
