# Ancient Horrors bug report — fix plan

Source: `bugs.md` (untracked, repo root), found while building *Ancient Horrors*
(`~/Development/msx/projects/elder_monsters/Ancient_Horrors`, read-only — never edit it;
copy to a scratch dir to reproduce). Branch: `fix/ancient-horrors-bugs`.

Phase 2 (after this plan is green and committed): the sprite editor's animation
bottom bar, brought to the meta-tile pose editor. Not part of this plan — it gets its
own brainstorm.

## What investigation established (verified, not assumed)

| # | Claim in bugs.md | Root cause found |
|---|---|---|
| 1 | Single-cell/single-layer sprite characters get no defines | `resourceConstants` (`shared/msx/resource.ts`, `kind === 'sprites'` tail) returns `[]` unless `hasSpriteGroups`. |
| 2 | Sprite speed not saved | `SpriteFrame` is `{ layers }` only; the editor's fps lives in the session (`editors/sprite/session.ts:66`, default 6) and drives `tickPlayback(…, fps, …)` (`shared/sprite-editor.ts:496`). |
| 3 | No sprite animation helper | Only `_SetMeta`, and only for group sheets (`spriteHelperC`). |
| 4 | Poses of an export-less meta "silently lost" | The exporter **does** refuse: `refreshTileMetas` (`main/services/resources.ts`) fails the tileset with "…animates, and its poses are written to its own header — give it an export target" (reproduced on a scratch copy of the game: `res/items.tiles.json` → `failed`). The *silence* is `BuildService.reportConversions` (`main/services/build-service.ts:186`): a failed conversion goes only to the `build:err` output channel, never into `BuildFinished.problems`, and MSXgl then compiles the stale header still on disk. The game's export-less metas were written by an agent through MCP `write_resource` (every IDE creation path — `resourcesStore.createResource`, `sheet-import.ts:279` — sets `defaultExport`). |
| 5 | Missing `_ANIM_<NAME>_TILES`, `_MovingCells` | `tilesetAnimConstants` (`shared/msx/tile-anim.ts`) emits `<id>`, `_SLOT`, `_FRAMES` only; `ownedMetaTables` (`shared/msx/meta-owned.ts`) emits `_Info` + window tables, no cell list. |
| 6 | `_Animate()` unusable for a relocating loader | By design. With 4 and 5 the data is sufficient; **no `_Animate` variant is built** (stated in the final report). |
| 7 | Hand-written map `metas` entry reads "not attached"; editor/preview draw nothing | (a) MCP `read_resource`/`write_resource` (`main/services/mcp.ts`) run `validateResource` on the file as written — no `replayTilesetLog`/`refreshMapMetas`/`refreshTileset`, which `exportResourceFile` runs first. (b) Map editor: `loadMetaDocs` (`editors/map/session.ts`) only considers metas listed in `useResourcesStore().entries`. A probe test proved it: same files, meta listed → mirror resolved (`cells:[4,0]`); meta not listed (a list that has not caught up with an agent's write) → stub kept, nothing drawn, no status. (c) The Resources-panel preview draws the file's mirror as written. |
| 8 | `.scratch/` copies exported over the real headers | `findResourceFiles` skips only `IGNORED_DIR_NAMES` (`node_modules`, `out`, `emul`, `.git`, `.msxdevstudio`). No duplicate-`out` check anywhere. Not yet reproduced with a real `.json` in a dot folder — Task C's first test does that. |
| 9 | Check and export disagree | Same as 7(a); and `validateMap`'s message (`shared/msx/map.ts:458`) does not name the field. |

## Decisions

- **Item 4:** (c) made visible + (a) on the one creation path that lacks it. No change to
  what an export-less meta means (`export: null` stays "not exported"); no tileset-side
  copies of pose tables (would duplicate pose bytes in ROM for every tileset a meta is
  attached to, and ROM is what hung the MSX2 demo once).
  - Every failed resource conversion becomes a `BuildProblem` (severity `error`, `file` =
    the resource's project-relative path, message = the conversion's message). The build
    still runs (existing deliberate no-abort rule) and `ok` stays MSXgl's own result.
  - The missing-export message names the pose count:
    `res/items/compass.meta-tiles.json has 2 poses but no export target, so its poses are not exported and <tileset>'s _Animate() cannot link — give it an export target (Export in the meta-tile editor's side panel, or "export": {…} in the file)`.
  - The pose editor (`editors/anim`, both `.anim-tiles.json` and `.meta-tiles.json`) today
    has **no way to set an export target**: its header Export button is disabled when
    `export` is null (`AnimTileEditorTab.vue:248`) and there is no Export section. Add one to
    `AnimSidePanel.vue`, modelled on `TileSidePanel.vue:188-194` (`setupExport` →
    `defaultExport(path)`, `patchExport` for name/out/format) and its template at `:695`,
    committed through the anim session's undoable doc change. (Helpers checkbox: omit — a
    pattern meta or an animation emits no helper C, `resourceCode` returns `NO_CODE`.)
  - MCP `write_resource`: when the target file **does not exist yet** and the incoming `doc`
    has **no `export` key at all** (not `null` — an explicit `null` is respected), set
    `defaultExport(path)`. Same rule `create_resource` follows.
- **Item 8:** skip every entry whose name starts with `.` inside `findResourceFiles` only
  (not via `IGNORED_DIR_NAMES`, which also hides them from the explorer/watcher/search). Do
  not restrict to `res/` (`RESOURCE_DIR`'s comment promises the walk is recursive). Do not
  parse `.gitignore` (a sync walk called several times per build; a gitignore rule that
  silently drops a real resource is the same class of bug). Duplicate `out`: group resources
  by the files they write — normalized `export.out` (format `c` and `bin` both) and, for `c`,
  `sourcePathFor(out)` too; every resource in a group of 2+ is reported `failed` with a
  message naming all claimants, and **none of them is exported** (no file written). This must
  hold for **single-file exports too** — `resources:exportOne` (each editor's Export button,
  `resourcesStore.exportOne`) and MCP `export_resources` with a path both go through
  `exportResourceFile`, not `exportAll`. So: `ExportOptions.claims?` (out-path → claimant
  inputs); `exportAll` builds it once from `findResourceFiles` and passes it; when absent,
  `exportResourceFile` builds it itself (one walk + parse per single export is fine). The
  claim check runs **before** the up-to-date skip — a duplicate whose outputs happen to be
  newer is still reported, since the header on disk may be the wrong one. Resources that
  will not parse claim nothing. Out paths are compared after `resolveRelativePath`
  normalization (slashes, `./`), case-insensitively on Windows. The dot rule applies to entries *below* the project root,
  never to the root's own path.
- **Items 7/9:** one main-side function is the only way a resource gets "made ready to
  export": `prepareResource(root, relative, resource, text)` in `main/services/resources.ts`
  (caller parses; `text` is what `replayTilesetLog` reads the stamp from) →
  `{ resource, problems }`. It does what `exportResourceFile` does today between parse and
  render: world rooms, `replayTilesetLog`, `refreshMapMetas`, `refreshTileset` (tiles),
  then validation (`validateMap(doc, mapValidateOptions)` for maps, else attached problems +
  `validateResource`). `exportResourceFile` calls it (world rooms still loaded *before* the
  up-to-date check — keep that order: rooms feed `exportDependencies`; so `prepareResource`
  takes the already-parsed resource and loads rooms only when `rooms` is unset — never twice).
  MCP uses it:
  - `read_resource` → `problems` from `prepareResource` (worlds included now — drop the
    "run export_resources" special case). The returned `doc` is the file's doc with its
    **mirrors refreshed** (`refreshMapMetas` only) but **not replayed** — replaying without
    updating `tilesetReorderSeen` would double-apply later.
  - `write_resource` → writes the normalized doc with mirrors refreshed (same rule as read),
    returns `prepareResource`'s problems for the written text.
  - Expose to `mcp.ts` through `McpDeps` (it never imports Electron or fs): e.g.
    `inspectResource(path: string, text: string): { doc: ResourceDoc; problems: string[] }`
    and `refreshMirrors(path, resource): ResourceDoc`, wired in `mcp-service.ts`.
    Implementer picks the exact shape; keep `mcp.test.ts` stubs simple.
  - `validateMap`'s message names the field and the numbers:
    `"g_Ghoul" (res/foes/ghoul.meta-tiles.json): metas[2].cells has 0 tile numbers, expected 4 (2×2) — it is not attached to res/pics/fight_alley.tiles.json; attach it in the tile editor, or place it again from the map editor`.
  - Map editor: `loadMetaDocs` also reads every meta path the map's `metas` and the
    tileset's `metas` bindings name, whether or not the Resources store lists it yet — with
    the same filters the listed ones get (pattern map: `.meta-tiles.json` in a compatible
    mode; bitmap map: `.meta-btiles.json` over this tileset), and a missing or unreadable file
    skipped as today.
  - Accepted limitation: the Resources-panel preview still draws a map's mirror as the file
    has it. A file written by MCP now carries a resolved mirror; one hand-edited outside the
    IDE is corrected the first time the map editor opens and saves it.
- **Items 1–3 (sprites):**
  - `SpriteFrame.duration: number` — **required** in the type so `tsc` finds every site that
    builds `{ layers }` (`lockLeadingCc`, `normalizeSprites`, `convertSpriteMode`,
    `sprite-editor.ts` addFrame/cloneFrame/addSprite/duplicate/layer ops,
    `sheet-convert.ts:426`, `sprite-editor.ts:482`, …). VBlanks, 1..255, default
    `DEFAULT_ANIM_DURATION` (8, from `tile-anim.ts`). Normalize clamps; serialize writes it.
    Clone copies it; a blank frame added at the end takes the last frame's duration.
  - Constants for **every** character (no `hasSpriteGroups` gate):
    `_BASE` (first plane), `_PLANES`, `_FRAMES`, plus new `_PATTERN` = `_BASE * step`
    (step = 4 for 16×16, 1 for 8×8: the VDP pattern number when the sheet is loaded at
    pattern 0) and `_FRAME0` (index of the character's first frame in `_Durations`).
    Sheet-level: `_CHARS` (character count) and `_PLANE_PATTERNS` (the step).
    Order inside each character unchanged for the three existing defines, new ones after.
    Two characters whose names give the same `defineName` id would now emit conflicting
    `#define`s in sheets that emitted none before: only the first gets its defines, and the
    header notes name the skipped ones ("rename one"). Never an export failure.
  - `_Durations` table: one byte per frame, characters in sheet order, frames in order —
    emitted only when some character has more than one frame; `_FRAME0` is emitted only
    alongside it (it indexes nothing otherwise).
  - `_Colors` comment states the layout per mode: mode 1 "one byte per plane (EC|colour),
    in pattern order — for a one-plane character that is one byte per frame"; mode 2
    "16 line bytes per plane, in pattern order".
  - Helpers (with `helpers: true`, only when some character has >1 frame; additive — a sheet
    without animation gets exactly the C it got before):
    - `void <N>_SetFrame(u8 index, u8 chr, u8 frame)` — pattern and colour of every plane of
      that frame onto hardware sprites `index…`, positions untouched. Mode 1:
      `VDP_SetSpritePattern` + `VDP_SetSpriteColorSM1(index, <N>_Colors[plane])`; mode 2:
      `VDP_SetSpritePattern` + `VDP_SetSpriteMultiColor(index, <N>_Colors + plane * 16)`.
      Clamps `frame` past the end to 0, ignores `chr` out of range.
    - `bool <N>_AnimStep(u8 chr, u8* state)` — caller-owned 2 bytes (`state[0]` frame shown,
      `state[1]` VBlanks on it); advances one VBlank, loops, returns TRUE when the frame
      changed. Clamps a garbage frame to 0 (RAM is not zeroed on a ROM target); header
      comment says to zero `state` first.
    - A `static const u8` per-character info table in the `.c` (base plane, planes, frames,
      frame0) — u8 is enough because the pattern table holds at most 256 patterns, the same
      limit `_SetMeta`'s `plane * step` already lives with.
    - `resourceCode`'s sprites branch today returns `NO_CODE` unless `hasSpriteGroups`
      (`resource.ts:1169`): it becomes `joinHelpers(groups ? spriteHelperC : NO_CODE,
      animated ? <new helper> : NO_CODE)`.
    Every call is MSXgl's own API (verified in `~/Applications/MSXgl/engine/src/vdp.h`:
    `VDP_SetSpritePattern`, `VDP_SetSpriteColorSM1`, `VDP_SetSpriteMultiColor` exist —
    implementer re-checks any config gating).
  - Editor: the filmstrip shows each frame's duration as an editable number (like
    `AnimFrameBar.vue`), the fps input goes, preview playback steps by the durations at a
    20 ms tick (one PAL VBlank — the pose editor's clock, `AnimSidePanel.vue:45`).
    `tickPlayback` takes durations instead of fps (its tests at `sprite-editor.test.ts:469-476`
    are rewritten). Session `fps` field removed (`editors/sprite/session.ts:39,66`,
    `SpriteEditorTab.vue:247`). The software-sprite and bitmap-tile editors keep their own
    fps (`SwSpriteEditorTab.vue`, `BitmapTileAnimation.vue`) — out of scope.
- **Item 5:** `#define <TS>_ANIM_<NAME>_TILES <animCells(binding)>` after `_FRAMES` in
  `tilesetAnimConstants` (every binding, meta windows and `.anim-tiles.json` alike).
  `ownedMetaTables`: `_MovingCells` (u8 cell indices of `movingCells(doc)`, reading order)
  after the window tables, only when the meta animates. `G_<META>_MOVINGCELLS_SIZE` (auto)
  does not collide with `G_<META>_MOVING` (checked).

## Tasks

Order: **B alone first** (small; it may run `anim-build`/`meta-owned-build`), then **A ∥ C**
(disjoint files), then **E**, then **D**. `src/shared/msx/resource.test.ts` belongs to A.
`demo-exports.test.ts` goes red after A and B by design — D fixes it; nobody else touches
`demo_msx*/`.

Only **one** agent at a time may run the real-MSXgl suites (`*-build.test.ts`,
`build-service`, `resources`, `toolchain`, `project`, `examples`, `msxgl-symbols`): they share
one engine directory. Parallel agents run only the test files named in their brief.
Scratch builds go beside the MSXgl checkout (`__fixtures__/msxgl.ts`'s scratch root), never
in `/tmp` (EXDEV). `buildFixture`/`runsBuilds` in `__fixtures__/msxgl-build.ts` are the
existing way to build one.

### Task A — sprites (items 1, 2, 3)
Files: `src/shared/msx/sprite.ts` (+test), `src/shared/msx/resource.ts` (sprites branches of
`resourceTables`/`resourceConstants`/`resourceCode`/`resourceNotes` **only**), `src/shared/sprite-editor.ts`
(+test), `src/shared/msx/sheet-convert.ts` (+test) and any other `{ layers }` frame builder
`tsc` reports, `src/renderer/src/editors/sprite/*`, `src/main/services/sheet-build.test.ts`
or a new `sprite-build.test.ts`.
- Tests first: per-character defines for a 5-character 1×1 sheet (the bug's cursors shape:
  arrow 4 frames, then down/marker/flash/here 1 frame each) — `ARROW_PATTERN 0`,
  `DOWN_PATTERN 16`, `ARROW_FRAMES 4`, `DOWN_FRAME0 4`; durations round-trip; `_Durations`
  bytes; helper text; normalize of an old file without `duration` → 8.
- Real build: a mode-1 multi-frame sheet (MSX1 template) **and** a mode-2 group sheet with
  frames (mode 2 needs the MSX2 template, `projects/template_msx2`), helpers on, `main` calls `_SetFrame` and `_AnimStep` (and `_SetMeta` where emitted). Then boot one
  in openMSX and `vpeek` the sprite attribute table's pattern byte for the plane across two
  timed `after time` callbacks to prove the frame advances (CLAUDE.md recipe). First check a
  C-BIOS machine loads at all: `~/Applications/openMSX/bin/openmsx`, systemroms holds only
  `cbios-old` + README — if C-BIOS machines will not start, report it rather than skip.
- Owns the real-MSXgl suites while it runs.

### Task B — meta/tileset data (item 5) and the map message (item 9)
Files: `src/shared/msx/tile-anim.ts` (+test), `src/shared/msx/meta-owned.ts` (+test),
`src/shared/msx/map.ts` (`validateMap` message only, +test). (Item 4's missing-export
message is in `main/services/resources.ts` — Task C.)
- Existing assertions that list a meta's tables or a tileset's anim defines change:
  `meta-owned.test.ts:198,322`, `tile-anim.test.ts:260-264`. If `resource.test.ts` breaks,
  fix it (A has not started yet).
- Runs alone, so it may also run `anim-build.test.ts` and `meta-owned-build.test.ts`, which
  build real ROMs from these headers. `agent-guide*.test.ts` is D's.

### Task C — main/services + map editor (items 4 build problems + message + 4a, 7, 8, 9)
Files: `src/main/services/resources.ts` (+`resources.test.ts`), `build-service.ts`
(+test), `mcp.ts` (+`mcp.test.ts`), `mcp-service.ts` (+test), `src/renderer/src/editors/map/session.ts`
(+ a test in `owned-meta.test.ts`).
- Tests first: a real `.scratch/x.tiles.json` copy with the same `export.out` as a real one
  (reproduce item 8: today both export and the copy wins/loses by sort order); dot-folder
  skip; duplicate-`out` failure writes nothing; a failed conversion appears in
  `BuildFinished.problems`; MCP `read_resource` on a map with a bare `metas` entry + a
  tileset stub binding reports no attachment problem (agrees with `export_resources`);
  `write_resource` stores resolved `cells`; `write_resource` of a new file without `export`
  gets `defaultExport`, with `export: null` keeps null; map editor resolves an attached meta
  the Resources store does not list.
- `resources.test.ts`/`build-service.test.ts` include real-MSXgl cases: run them **only**
  with `-t` filters on the new tests until Task A finishes, then in full.
- Conversion failures as problems: ids must not collide with `run()`'s `p<n>` (use `r<n>`),
  listed before MSXgl's; applies to every command, `clean` included; `ok` unchanged.
  `build:finished` is emitted **inside** `run()` (`build-service.ts:269-277`), and the
  renderer's Problems panel is filled only from that event (`buildStore.ts` →
  `problemsStore.set(result.problems)`), so the conversion problems must be passed *into*
  `run()` (e.g. a `preProblems` parameter seeding its list) — appending to the result after
  `run()` returns would reach the MCP tool but never the panel. `startExternal` passes none.

### Task E — pose editor Export section (item 4)
Files: `src/renderer/src/editors/anim/AnimSidePanel.vue`, `editors/anim/session.ts`
(+`session.test.ts`). As in Decisions/Item 4. Session test: setting up an export on a meta
with `export: null` gives `defaultExport(path)` and is undoable. Phase 2 reworks this
editor's bottom bar afterwards; keep the change to the side panel.

### Task D — docs and demos (after A–C and E, one owner)
- `src/main/services/agent-guide.ts` (+ its tests): per-character sprite defines,
  `_Durations`, `_SetFrame`/`_AnimStep`, frame `duration`; `_ANIM_<NAME>_TILES`,
  `_MovingCells` and how a relocating loader animates a meta from them; animated metas need
  an export target; resources in dot folders are ignored; two resources may not share an
  `out`.
- `docs/resources.md` (same facts for users), `docs/claude.md` + `specs/17-mcp-server.md` +
  the guide's MCP paragraph (read/write_resource now refresh mirrors and report export
  problems; new-file default export).
- Re-export `demo_msx1/` and `demo_msx2/` content with **the same function
  `demo-exports.test.ts` compares against** (`parseResource` → `renderResourceFiles`, no
  refresh), so the test goes green; diff the result and confirm the only changes are the new
  sprite defines/`_Durations`/comment and `_ANIM_*_TILES`. Update their hand-written
  `CLAUDE.md`/`AGENTS.md` where they describe sprite or animation defines.
- `CLAUDE.md` (repo), Export section: the sentence "`resourceConstants()` emits `#define`s
  locating each group in it (`..._BASE/_W/_H`, `..._BASE/_PLANES/_FRAMES`)" — say sprite
  characters now all get them (plus `_PATTERN`, `_FRAME0`), and that a failed resource
  export is a build Problem.
- Runs `agent-guide.test.ts` and `agent-guide-meta.test.ts` (the latter checks the guide's
  symbols against real headers).

### Final gate (me)
`npm run check`, full `npm run test` (real MSXgl present — a skip is not a result),
mutation spot-checks on the new logic (one term at a time, restore from file copy, verify
with `grep -cF`), then a reviewer pass before merge.
The `.vue` changes (sprite filmstrip durations + preview timing, the pose editor's Export
section) have no vitest coverage: drive the app over CDP against a scratch copy of a demo
(`electron-vite dev --remoteDebuggingPort 9222`, real `Input.dispatch*` events, wait ≥5 s
after any `.vue` edit) — set a frame's duration and see it saved; set up an export on an
export-less meta and see the file gain the block. Pablo's own click-through remains the
real check, and the report says so.
