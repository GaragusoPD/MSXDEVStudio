# Meta-tiles Audit Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two `reserveTile0` bugs the 2026-09-02 spec audit found, cover
that function with the session tests it never had, put the bitmap placement
runtime through a real compile and a real boot, and make the design doc's
*Deviations* section agree with the code that shipped.

**Architecture:** Both bugs live in one function — `reserveTile0()` in
`src/renderer/src/editors/meta/session.ts:447`. Its bitmap sibling
`reserveBitmapTile0()` (same file, line 406) already does both things correctly,
so each fix is "do what the sibling does". Tests go in the existing
`session.test.ts`, the layer CLAUDE.md names for this class of bug: a session
function whose guard is missing and whose failure is invisible to every other
suite. Task 4 extends `meta-build.test.ts` with an MSX2 sibling of the fixture it
already has, because `bitmapPlacementHelperC` has never been compiled or run.

**Tech Stack:** TypeScript, Vue 3, Pinia, Vitest, real MSXgl + SDCC, openMSX. No
new dependencies.

**Spec:** [`docs/superpowers/specs/2026-08-24-meta-tiles-design.md`](../specs/2026-08-24-meta-tiles-design.md)

## Global Constraints

- `npm run check` (lint + typecheck) is the CI gate and must pass before each commit.
- Tests run with `npx vitest run <file>`. The renderer has no DOM in tests — stub
  `window`, never import a component.
- `MAX_TILES = 256` (`src/shared/msx/tile.ts:20`) is the pattern-bank ceiling.
- Per CLAUDE.md, `renderer/src/editors/*/session.ts` **is** vitest-covered. New
  session logic gets a session test.
- Scratch build projects go *beside* the MSXgl checkout (`scratchRoot()`), never
  `/tmp` — MSXgl renames `.rel` files across directories and `rename(2)` will not
  cross filesystems.
- Task order matters: **Task 1 before Task 2.** Task 1 adds the capacity guard;
  Task 2 removes the truncation that guard makes unreachable. The other order
  leaves one commit where a full bank produces a 257-entry `tiles` array claiming
  `count: 256`.

---

### Task 1: Reserving tile 0 refuses a full bank instead of dropping a tile

`reserveTile0()` has no capacity guard. At `count === 256` it truncates to 256
entries — destroying the last tile's art — and clamps the remap so old 254 and
old 255 both land on new 255, silently merging two different tiles.
`demo_msx1/res/intro.tiles.json` ships at `count: 256`, so this is reachable
today. `reserveBitmapTile0()` at `session.ts:406` already refuses this case; the
pattern path must match, and must refuse *before* the confirm dialog, as the
sibling does.

**Files:**
- Modify: `src/renderer/src/editors/meta/session.ts:39` (import), `:447-455` (the guard)
- Test: `src/renderer/src/editors/meta/session.test.ts`

**Interfaces:**
- Consumes: `MAX_TILES: number` from `src/shared/msx/tile.ts:20`; `reserveTile0(session: MetaSession): void` from `./session`; `patternDoc(path: string): TilesDoc | null` from `useTilesetStore()`.
- Produces: the `MAX_TILES` import in `session.ts`, which Task 2 also uses.

- [ ] **Step 1: Write the failing test**

Append to `src/renderer/src/editors/meta/session.test.ts`. Add `reserveTile0` to
the existing import list from `./session` (it goes after `pruneMetaSessions`).

```ts
describe('reserving tile 0 on a tileset that already holds art', () => {
  it('refuses a full bank rather than dropping the last tile', async () => {
    // `demo_msx1/res/intro.tiles.json` really is 256 tiles. Shifting one in
    // means one falls off the end, and two live indices collapse onto one.
    files[TILES] = serializeResource({
      kind: 'tiles',
      doc: normalizeTiles({ mode: 'sc2', count: 256, reserveTile0: false })
    })
    const session = metaSession(META)
    await settled()
    await settled()
    const before = useTilesetStore().patternDoc(TILES)!

    reserveTile0(session)

    const after = useTilesetStore().patternDoc(TILES)!
    expect(after).toBe(before)
    expect(after.reserveTile0).toBe(false)
    expect(session.status).toMatch(/full/i)
  })
})
```

The bank is all-blank, so `reserveTile0`'s `used` check is false and
`window.confirm` is never reached — this test needs no dialog stub. Task 2 adds
one.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/src/editors/meta/session.test.ts -t 'refuses a full bank'`

Expected: FAIL — the doc was replaced (`after` is not `before`) and
`after.reserveTile0` came back `true`.

- [ ] **Step 3: Add the guard**

In `src/renderer/src/editors/meta/session.ts`, add `MAX_TILES` to the existing
`shared/msx/tile` import on line 39:

```ts
import { MAX_TILES, mergeColorByte, removeTile, TILE_SIZE, type TilesDoc } from '../../../../shared/msx/tile'
```

Then inside `reserveTile0()`, insert the guard immediately after the
`if (!tileset || tileset.reserveTile0) return` line and **before** the
`const used = …` / `window.confirm` block — refusing before asking, exactly as
`reserveBitmapTile0()` does:

```ts
  if (tileset.count >= MAX_TILES) {
    session.status = 'The tileset is full, so tile 0 cannot be shifted out of the way. Free a tile first.'
    return
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/renderer/src/editors/meta/session.test.ts`

Expected: PASS, and every pre-existing test in the file still passes.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/editors/meta/session.ts src/renderer/src/editors/meta/session.test.ts
git commit -m "fix(meta): a full tileset refuses to reserve tile 0 instead of losing a tile"
```

---

### Task 2: A reserved tile 0 is blank, not a copy of the art it displaced

`reserveTile0()` shifts the bank by prepending `tileset.tiles[0]` — a *duplicate
of the old tile 0's artwork*. It should prepend a blank. `normalizeTiles()`
blanks tile 0 on load and `parseResource()` normalizes on the export path, so the
emitted C is safe; but `tilesetStore.set()` does not normalize, so between the
migration and the next reload the in-memory bank has art in the index the meta
canvas and the emitted `_Draw` both skip.

Task 1's guard makes the old `.slice(0, 256)` truncation and the
`Math.min(255, i + 1)` remap clamp unreachable, so they come out here.

**Files:**
- Modify: `src/renderer/src/editors/meta/session.ts:39` (import), `:461-470` (the shift)
- Test: `src/renderer/src/editors/meta/session.test.ts`

**Interfaces:**
- Consumes: `blankTileEntry(mode: TileMode): TileEntry` from `src/shared/msx/tile.ts:109`; the `MAX_TILES` import Task 1 added.
- Produces: a `window.confirm` stub in `session.test.ts`'s `beforeEach`.

- [ ] **Step 1: Add `confirm` to the window stub**

`reserveTile0()` calls `window.confirm` whenever the bank has art in it, and the
existing stub has no such method — the call would throw. In
`src/renderer/src/editors/meta/session.test.ts`, inside `beforeEach`, extend the
`window` object (it currently holds only `api`):

```ts
  ;(globalThis as { window?: unknown }).window = {
    // reserveTile0() asks before a migration; every test here says yes.
    confirm: vi.fn(() => true),
    api: {
```

- [ ] **Step 2: Write the failing test**

Add inside the `describe('reserving tile 0 on a tileset that already holds art')`
block Task 1 created:

```ts
  it('blanks the new tile 0 and moves the art to tile 1', async () => {
    // Tile 0 as real, load-bearing art is the case this whole flag exists for:
    // `demo_msx1/res/tiles.tiles.json` draws its tile 0 274 times.
    files[TILES] = serializeResource({
      kind: 'tiles',
      doc: normalizeTiles({
        mode: 'sc2',
        count: 4,
        reserveTile0: false,
        tiles: [{ pattern: new Array(8).fill(0xff) }]
      })
    })
    const session = metaSession(META)
    await settled()
    await settled()

    reserveTile0(session)

    const shifted = useTilesetStore().patternDoc(TILES)!
    expect(shifted.reserveTile0).toBe(true)
    expect(shifted.count).toBe(5)
    // A cell holding 0 is a skipped write, so index 0 must not hold art.
    expect(shifted.tiles[0].pattern).toEqual(new Array(8).fill(0))
    expect(shifted.tiles[0].color).toEqual(new Array(8).fill(0))
    // Nothing is destroyed: the old artwork is one slot along.
    expect(shifted.tiles[1].pattern).toEqual(new Array(8).fill(0xff))
    expect(shifted.tiles.length).toBe(5)
  })
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/renderer/src/editors/meta/session.test.ts -t 'blanks the new tile 0'`

Expected: FAIL — `tiles[0].pattern` is `[255,255,255,255,255,255,255,255]`, not zeros.

- [ ] **Step 4: Fix the shift**

In `src/renderer/src/editors/meta/session.ts`, add `blankTileEntry` to the
`shared/msx/tile` import Task 1 already touched:

```ts
import { blankTileEntry, MAX_TILES, mergeColorByte, removeTile, TILE_SIZE, type TilesDoc } from '../../../../shared/msx/tile'
```

Then replace the shift block in `reserveTile0()` — the `const shifted` object and
the `mapping` line — with:

```ts
  // Shift by prepending a genuinely blank tile: every old index i becomes i + 1.
  // `normalizeTiles` would blank it on the next load anyway; doing it here keeps
  // the in-memory doc honest, because `tilesetStore.set()` does not normalize.
  // No truncation: the guard above already refused a bank with no room.
  const shifted: TilesDoc = {
    ...tileset,
    reserveTile0: true,
    count: tileset.count + 1,
    tiles: [blankTileEntry(tileset.mode), ...tileset.tiles],
    flags: [0, ...tileset.flags],
    blocks: tileset.blocks.map((block) => ({ ...block, tiles: block.tiles.map((tile) => tile + 1) }))
  }
  const mapping = tileset.tiles.map((_, i) => i + 1)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/renderer/src/editors/meta/session.test.ts`

Expected: PASS, including Task 1's full-bank test — the guard is what keeps
`count + 1` from exceeding `MAX_TILES` now that the clamp is gone.

- [ ] **Step 6: Run the gate**

Run: `npm run check && npx vitest run src/renderer/src/editors src/renderer/src/stores src/shared/msx`

Expected: lint and both typechecks clean; no regression in the tile, map, meta or
store suites.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/editors/meta/session.ts src/renderer/src/editors/meta/session.test.ts
git commit -m "fix(meta): a reserved tile 0 is blank, not a copy of what it displaced"
```

---

### Task 3: The bitmap placement runtime is compiled and booted

`bitmapPlacementHelperC` (`src/shared/msx/map.ts:932`) is reached whenever a map
has a `cell` and is not a SCREEN 3 name table. It emits
`void <name>_DrawPlacements(const u8* frames, UY atlasY)` over `VDP_CommandHMMM`
/ `VDP_CommandLMMM`, and needs MSX2 with `VDP_USE_COMMAND`.

Its emitted *text* is asserted — `map.test.ts:184`, `meta-e2e.test.ts:171` and
`agent-guide-meta.test.ts:144` all check the signature. What has never happened
is a **compile, a link and a boot**: `meta-build.test.ts` builds only the
pattern-mode sibling, at `machine: '1'`. Per CLAUDE.md that build is the one
check that catches a helper calling an engine function which does not exist
under this configuration, and no assertion over a string can stand in for it.

**Files:**
- Modify: `src/main/services/meta-build.test.ts`
- Reference: `src/shared/msx/map.ts:932-1010` (the emitted API), `src/main/services/__fixtures__/msxgl.ts`

**Interfaces:**
- Consumes: `createBitmapTilesDoc(mode, width, height, count): BitmapTilesDoc` (`src/shared/msx/bitmap-tile.ts:117`); `paintBitmapMeta(meta, tiles, frame, points, color)` (`src/shared/msx/meta-paint.ts:274`); `createMetaTileDoc(tileset, width, height, cell)` (`src/shared/msx/meta-tile.ts:86`); the existing `buildFixture`, `cell`, `dirs`, `runsBuilds`, `BUILD_TIMEOUT` helpers already in `meta-build.test.ts`.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Generalise `buildFixture` to take a project and a main**

`buildFixture()` currently hardcodes `machine: '1'`, the template directory, the
resource set, and `MAIN`. Give it parameters, keeping the existing call working:

```ts
interface FixtureSpec {
  name: string
  template: 'template' | 'template_msx2'
  machine: '1' | '2'
  resources: Record<string, ResourceDoc>
  main: string
}

function buildFixture(spec: FixtureSpec): { output: string; root: string } {
  const root = mkdtempSync(join(scratchRoot(), `${spec.name}-`))
  dirs.push(root)
  cpSync(join(REAL_MSXGL, `projects/${spec.template}`), root, { recursive: true })

  mkdirSync(join(root, 'res'), { recursive: true })
  for (const [name, resource] of Object.entries(spec.resources)) {
    writeFileSync(join(root, `res/${name}.json`), serializeResource(resource))
  }
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
```

Update the existing pattern-mode test to call
`buildFixture({ name: 'metatest', template: 'template', machine: '1', resources: fixture(), main: MAIN })`.

- [ ] **Step 2: Run the existing build test to verify the refactor is neutral**

Run: `npx vitest run src/main/services/meta-build.test.ts`

Expected: PASS, unchanged (~40s). If it is reported as *skipped*, the MSXgl
checkout was not found — a skip is not a result. Fix
`src/main/services/__fixtures__/msxgl.ts` or set `MSXGL_PATH` and rerun before
continuing.

- [ ] **Step 3: Write the failing bitmap fixture and test**

Add to `src/main/services/meta-build.test.ts`. The map carries a `cell`, which is
what routes `placementHelperC` to the bitmap branch.

```ts
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
```

Add the new imports at the top of the file:

```ts
import { createBitmapTilesDoc, type BitmapTilesDoc } from '../../shared/msx/bitmap-tile'
import { paintBitmapMeta } from '../../shared/msx/meta-paint'
```

`MetaTileDoc` also needs importing — extend the existing
`from '../../shared/msx/meta-tile'` clause (which already brings in
`createMetaTileDoc`) with `type MetaTileDoc`.

(`paintMeta` is already imported from that module — extend the existing clause
rather than adding a second import from the same path.)

- [ ] **Step 4: Run the new test**

Run: `npx vitest run src/main/services/meta-build.test.ts -t 'bitmap meta and a map'`

Expected: a PASS — in which case the helper compiles and links, which was never
known before. The two prerequisites are already in place, so a failure here is a
real defect rather than missing setup:

- `VDP_USE_COMMAND` is `TRUE` at line 96 of **both** templates' `msxgl_config.h`,
  and the fixture copies that file verbatim — nothing generates it, so there is
  nothing to configure.
- `vdp` is in `normalizeProject`'s default `libModules`
  (`src/shared/msxproj.ts:104`), so the command wrappers are linked.

If it fails anyway, read the message rather than the plan:

- `Undefined Global '_VDP_CommandHMMM'` / `'_VDP_CommandLMMM'` → the `vdp` module
  is not reaching `LibModules`. Look at `writeGeneratedConfig` and
  `generatedSourceModules` in `src/main/services/project.ts` and `resources.ts`,
  not at `msxgl_config.h`.
- `Undefined Global '_g_Rock'` → the map's `extern` and the meta's export symbol
  disagree. That is the mirror: `metaRefFrom` in `src/shared/msx/map.ts:686`, and
  the refresh at `src/main/services/resources.ts:147`.
- An export failure naming `ATLAS_COLS`, `CELL_W` or `CELL_H` → the map's `cell`
  did not survive to `resourceConstants` (`src/shared/msx/resource.ts:792-794`),
  which emits those three defines only when `cell` is set.

Do not weaken the assertions to make it green. If the fix is larger than a few
lines, stop and report — that is a new defect, not a task step.

- [ ] **Step 5: Boot the ROM under openMSX**

A link is not a picture. Per CLAUDE.md, take a screenshot of the running ROM.
`afterAll` deletes every scratch root, so first make it keep one on request. In
`src/main/services/meta-build.test.ts`, change the existing `afterAll`:

```ts
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
```

Then build and boot:

```bash
MSXDEVSTUDIO_KEEP_SCRATCH=1 npx vitest run src/main/services/meta-build.test.ts -t 'bitmap meta and a map'
# note the "kept: /home/pablo/Applications/.msxdevstudio-test-scratch/bmetatest-XXXX" line

SHOT=/tmp/claude-1000/-home-pablo-Development-MSXDEVStudio/baa193ba-3e12-4bb6-914e-1ca10256cc41/scratchpad
cat > "$SHOT/shot.tcl" <<'TCL'
after time 12 { screenshot -raw SHOTDIR/bmeta.png; exit }
TCL
sed -i "s|SHOTDIR|$SHOT|" "$SHOT/shot.tcl"

OPENMSX_SYSTEM_DATA=/home/pablo/Applications/openMSX/share \
  /home/pablo/Applications/openMSX/bin/openmsx \
  -machine C-BIOS_MSX2_EU \
  -cart <the kept root>/out/bmetatest.rom \
  -script "$SHOT/shot.tcl"
```

C-BIOS needs ~10s before the cartridge runs, hence `after time 12`. The stub
never waits for input, so no `keymatrixdown` is needed.

Read `$SHOT/bmeta.png` back with the Read tool. **Two 8×8 colour-5 squares should
be on screen, at pixel (32, 32) and (48, 48)**, on an otherwise black display.

Why that shape and not one 32×32 block: the live placement sits at cell (2, 2),
so the meta's origin is pixel (32, 32) with a 16-pixel cell — its cell (0, 0)
lands at (32, 32) and its cell (1, 1) at (48, 48). Only those two of the four
meta cells were painted, and `cell()` covers just the top-left 8×8 quarter of
each, so with `transparent: 0` the TIMP blit drops the colour-0 remainder and
what survives is an 8×8 square per cell.

The second *placement* is deliberately absent, and that is the other assertion.
`setPlacementBaked` only flips the flag; it does not stamp the meta's cells into
the layer grid (see `map.ts:768-779`), and `BITMAP_MAIN` never calls a layer
draw. So the only thing that could have drawn it is `_DrawPlacements`, and it
skips baked entries on `slot & 0x80`. A second rock at (96, 64) would mean that
skip is broken.

Failure readings: a blank screen means the atlas never reached VRAM; a torn or
offset rectangle means the source coordinates in `bitmapPlacementHelperC` are
wrong; a rock at (96, 64) means the baked skip is.

Then clean up: `rm -rf /home/pablo/Applications/.msxdevstudio-test-scratch/bmetatest-*`

- [ ] **Step 6: Commit**

```bash
git add src/main/services/meta-build.test.ts
git commit -m "test(meta): the bitmap placement helper compiles, links and draws"
```

---

### Task 4: The design doc's deviations match the code that shipped

Three statements in the spec are now false. None is a code change; all three
mislead the next reader of the design doc, which is the artifact this feature is
argued from.

**Files:**
- Modify: `docs/superpowers/specs/2026-08-24-meta-tiles-design.md` — lines 4-5, ~118-121, 385-403
- Modify: `CHANGELOG.md` — the `[Unreleased]` section

- [ ] **Step 1: Correct the "read-only" claim in §1**

The spec's §1 (line ~120) says declining the tile-0 migration leaves the meta
read-only. The code deliberately does the opposite — `session.ts:566` reads
*"Deliberately not gated on `reserveTile0`: that buys transparency, not the right
to draw"*, and `session.test.ts` has a test named *draws even when the tileset has
not reserved tile 0*. Replace the sentence

> Declining leaves the meta read-only until a tileset with the flag is chosen.

with

> Declining leaves the meta drawable, not read-only — see deviation 3. A cell
> holding tile 0 is skipped either way: `MetaCanvas.vue` draws the checkerboard
> through it and the emitted `_Draw` does not write it. What the flag buys is
> that tile 0 is *blank*, so the cell a meta skips is also blank for everything
> else drawing from that tileset — a map's own grid included.

- [ ] **Step 2: Rewrite the Deviations section**

Under `## Deviations during implementation` (line 385), replace **both** the
intro paragraph (`Both are defensible and neither was a silent choice…`) and the
two numbered entries below it. Leave the `##` heading itself in place:

```markdown
All three are defensible and none was a silent choice, but this document said
otherwise and the record should agree with the code.

1. **`.meta-btiles.json` lost its cell-stamping editor.** §1 said it would keep
   today's interaction until stage 2. The rewrite replaced the editor wholesale,
   so a bitmap meta was briefly view-only.

   **Superseded.** Stage 2 shipped: a bitmap meta is authored with the same
   pixel tools, reserves tile 0 through `reserveBitmapTile0`, and is placed on a
   map like any other, drawn by `bitmapPlacementHelperC` over the VDP command
   engine. See the *Meta-tiles in bitmap and multicolour modes* entry in
   `CHANGELOG.md`.

2. **Erase is a colour, not a tool.** §4 listed it among the tools. It ships as a
   toolbar button that selects the transparent index, which composes with every
   tool rather than being a sixth one — erase with the pencil, with a line, with
   a spray of holes.

3. **Painting is not gated on `reserveTile0`.** §1 said declining the migration
   leaves the meta read-only. It does not: the flag buys *transparency*, not the
   right to draw. Refusing strokes made every pre-existing tileset — which is all
   of them, the flag being off by default — look like a broken editor. Covered by
   `session.test.ts`'s *draws even when the tileset has not reserved tile 0*.
```

- [ ] **Step 3: Update the Status line**

Lines 4-5 say "Two deviations". Replace with:

```markdown
**Status:** implemented on `dev02`, merged to `main` at `80a3910`. Three
deviations from this document are recorded at the end, under *Deviations during
implementation*; stage 2 has since superseded the first.
```

- [ ] **Step 4: Add a CHANGELOG entry**

Under `## [Unreleased]` in `CHANGELOG.md`, add a `### Fixed` section above the
existing feature sections (or append to one if a later commit added it):

```markdown
### Fixed

- **Reserving tile 0 on a full tileset no longer loses a tile.** Shifting a
  256-tile bank up by one dropped the last tile's art and merged the two highest
  indices onto one. It now refuses and says why, as the bitmap path already did.
  `demo_msx1/res/intro.tiles.json` is a real 256-tile bank, so this was
  reachable.
- **A newly reserved tile 0 is blank.** The migration prepended a copy of the art
  it displaced, so until the next reload the in-memory bank held art in the index
  the canvas and the emitted `_Draw` both skip. Exported data was never affected —
  the export path normalizes on read.
```

- [ ] **Step 5: Verify no other doc repeats the corrected claims**

Run: `grep -rn "read-only until a tileset\|Two deviations\|view-only" docs/ specs/ CHANGELOG.md`

Expected: no hits outside the lines just edited. If
`docs/superpowers/plans/2026-08-24-meta-tiles.md` or
`specs/10-map-screen-editors.md` repeat either claim, correct them the same way.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-08-24-meta-tiles-design.md CHANGELOG.md
git commit -m "docs(meta-tiles): the design doc's deviations match what shipped"
```

---

## Not in this plan

One audit finding is not fixable by editing code: **Pablo's manual UI pass from
2026-08-24 is unfinished.** Every UI bug found that day — blank editor pane,
canvas that would not draw, colour changes that did nothing, tiles piling up per
pointer sample, sidebar layout, preferences not persisting — came from him
clicking, not from tests. A green suite does not substitute for it, and no task
here changes that.

## Self-Review

- **Spec coverage:** every audit finding maps to a task — full-bank data loss →
  Task 1, art-instead-of-blank → Task 2, bitmap runtime never executed → Task 3,
  the unrecorded and the stale deviation → Task 4, the manual pass → *Not in this
  plan*, with its reason.
- **Placeholders:** none. Task 3 Step 4 names the two concrete failures it expects
  and where each is fixed, rather than "handle errors", and Step 5 carries the
  real openMSX path (`/home/pablo/Applications/openMSX`) rather than a
  `<placeholder>`. Both MSXgl templates ship their main as `template.c`, which is
  why Step 1 deletes that name and not `${spec.template}.c`.
- **Type consistency:** `blankTileEntry(mode: TileMode)` and `MAX_TILES` both come
  from `src/shared/msx/tile.ts` through one import clause, added in Task 1 and
  extended in Task 2. `FixtureSpec` in Task 3 is defined before its only two call
  sites. `_DrawPlacements` takes `(const u8* frames)` in pattern mode and
  `(const u8* frames, UY atlasY)` in bitmap mode — the two `main`s differ
  accordingly, which is deliberate, not a typo.
- **Ordering:** Task 1 must precede Task 2 (guard before the truncation it
  replaces). Tasks 3 and 4 are independent of both and of each other.
