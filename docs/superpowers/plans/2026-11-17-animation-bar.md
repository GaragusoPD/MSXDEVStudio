# One Animation Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The sprite editor, the pose editor (`.meta-tiles.json` / `.anim-tiles.json`) and the bitmap meta-tile editor (`.meta-btiles.json`) share one bottom animation bar, timed by one tested function; bitmap meta-tiles gain saved per-frame durations and a `_Durations` export.

**Architecture:** A presentational `AnimationBar.vue` in `src/renderer/src/components/` owns layout, the preview's `requestAnimationFrame` loop and the controls; each editor passes frame count, durations, loop mode and a draw callback, and maps the bar's events onto its own existing undoable session/shared functions. Timing is a pure module in `src/shared/` so it is unit-tested; the `.vue` is not (verified by driving the app).

**Tech Stack:** Vue 3 `<script setup>` + TypeScript, Pinia-free sessions, Vitest, MSXgl (real builds for the export).

**Spec:** `docs/superpowers/specs/2026-11-17-animation-bar-design.md` — read it first; this plan argues from it.

## Global Constraints

- Preview clock: 20 ms per VBlank (`VBLANK_MS = 20`, PAL 50 Hz), everywhere. No 50/60 Hz switch.
- Durations: VBlanks, integers 1..255, default `DEFAULT_ANIM_DURATION` (8, `src/shared/msx/tile-anim.ts`). Old bitmap meta files read as 8.
- Play start: `loop` → from the selected frame; `pingpong` / `once` → from frame 0, forward.
- Playing animates the **preview pane only**; the main canvas stays on the frame being edited.
- Background: `'checkered' | 'solid'` (solid = black); colour 0 / empty shows the background.
- Every edit made from the bar is exactly one undo step in that editor's own history.
- No change to what sprites, animations or pattern metas export. Bitmap metas: `_Durations` **after** the existing frames table, only when frames > 1; a one-frame meta exports byte-for-byte as before. **No new helper C.**
- No keyboard shortcuts added. Swsprite and btiles editors untouched.
- Repo rules (CLAUDE.md): logic in `src/shared` or `editors/*/session.ts`, not in `.vue`; tests next to modules; only one agent at a time may run the real-MSXgl suites (`*-build.test.ts`, `resources`, `build-service`, `project`, `toolchain`, `examples`, `msxgl-symbols`).

## Review Focus

1. **Tab switched while playing.** Remounting the bar with `playing` already true must keep playing (the sprite bar's `watch(…, { immediate: true })` note) → Task 3 drives it by CDP; Task 1 pins nothing here.
2. **Frames removed or reordered during playback.** The preview index must never point past the last frame (blank preview, thrown error) → `previewFrame` clamps; test in Task 1.
3. **Extreme frame shapes.** 1×1 tile, 16×16 tiles (128×128 dots), 16×1 strips, 2×2 16×16 sprites: preview and thumbnails keep aspect and fit their boxes, pixelated → `fitScale` test in Task 1; CDP check in Task 7.
4. **Bad duration input.** Emptied field, 0, 999, `1e3`, letters: stored value clamps to 1..255 or stays, field shows the stored value, one undo step at most → `parseDuration` test in Task 1; session tests in Tasks 2 and 4.
5. **Art edited while the bar shows it** (stroke, undo, external file change): thumbnails and preview redraw → `artKey` contract in Task 3; CDP check in Task 7.

---

### Task 1: Shared playback timing

**Files:**
- Create: `src/shared/animation-playback.ts`, `src/shared/animation-playback.test.ts`
- Modify: `src/renderer/src/editors/anim/session.ts:648-665` (`poseAtTick` delegates), `src/shared/sprite-editor.ts:517-548` (`VBLANK_MS` re-exported from the new module; `tickPlayback`/`PlaybackState` stay until Task 3 removes them)

**Interfaces — Produces:**
- `export const VBLANK_MS = 20`
- `export type PlaybackLoop = AnimLoop` (re-use `AnimLoop` from `src/shared/msx/tile.ts`)
- `export type AnimationBackground = 'checkered' | 'solid'` — here, not in the `.vue`, so sessions (which vitest imports) can name it without importing a component.
- `frameAtTick(durations: readonly number[], loop: PlaybackLoop, ticks: number): number` — today's `poseAtTick` rules over plain durations: ping-pong order `0..n-1, n-2..1` (ends not repeated); `once` holds the last frame; non-finite or < 1 durations count as 1; empty → 0; one frame → 0.
- `startTick(durations: readonly number[], loop: PlaybackLoop, selected: number): number` — `loop`: sum of durations before `selected` (clamped into range); otherwise 0.
- `previewFrame(durations: readonly number[], loop: PlaybackLoop, start: number, elapsedMs: number): number` — `frameAtTick(durations, loop, start + Math.floor(elapsedMs / VBLANK_MS))`, always in `0..max(0, n-1)` even if `durations` shrank since `start` was taken.
- `parseDuration(raw: number): number | null` — `null` for NaN/±Infinity; otherwise `Math.round` clamped to 1..255.
- `fitScale(frame: { width: number; height: number }, box: { width: number; height: number }): number` — largest scale (may be fractional below 1) at which the frame fits the box; 0 for an empty frame.

- [ ] **Step 1: Write failing tests** in `animation-playback.test.ts`: port every `poseAtTick` case from `src/renderer/src/editors/anim/session.test.ts` (~:180) to `frameAtTick` over `frames.map(f => f.duration)`; port `tickPlayback`'s cases (`sprite-editor.test.ts`) as `previewFrame` equivalents (e.g. durations `[5,5,5]`, `elapsedMs` 100 → frame 1 at 20 ms/VBlank); `startTick([3,6,9], 'loop', 2) === 9`, `startTick([3,6,9], 'pingpong', 2) === 0`, `startTick([3,6,9], 'once', 2) === 0`; `previewFrame([4,4], 'loop', 999, 0)` ∈ {0,1}; `previewFrame([], 'loop', 0, 500) === 0`; `parseDuration(NaN) === null`, `(0) → 1`, `(999) → 255`, `(1e3) → 255`, `(7.6) → 8`; `fitScale({width:128,height:128},{width:64,height:64}) === 0.5`, `({width:128,height:8},{width:64,height:64}) === 0.5`, `({width:8,height:8},{width:64,height:64}) === 8`, `({width:0,height:8}, …) === 0`.
- [ ] **Step 2: Run** `npx vitest run src/shared/animation-playback.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** the module; make `poseAtTick(anim, ticks)` return `frameAtTick(anim.frames.map((f) => f.duration), anim.loop, ticks)`; `sprite-editor.ts` imports `VBLANK_MS` from it and re-exports it.
- [ ] **Step 4: Run** `npx vitest run src/shared/animation-playback.test.ts src/shared/sprite-editor.test.ts src/renderer/src/editors/anim/` — all pass.
- [ ] **Step 5: Commit** `feat(anim): one tested playback clock for every animation preview`.

### Task 2: Bitmap meta-tile frame durations and `_Durations`

**Files:**
- Modify: `src/shared/msx/meta-tile.ts` (`MetaFrame`, `normalizeMetaTile`, `addFrame`, `resizeMeta`, `remapMetaTiles`, new `setFrameDuration`), `src/shared/msx/resource.ts` (`metabtiles` branch of `resourceTables` + its notes only), `src/renderer/src/editors/meta/session.ts` (new `setDuration`), every other `MetaFrame` builder `tsc` reports (likely `src/shared/msx/sheet-convert.ts`, `src/shared/msx/meta-paint.ts`)
- Test: `src/shared/msx/meta-tile.test.ts`, `src/shared/msx/resource.test.ts`, `src/renderer/src/editors/meta/session.test.ts`

**Interfaces — Produces:**
- `MetaFrame { tiles: number[]; duration: number }` (duration **required**)
- `setFrameDuration(doc: MetaTileDoc, index: number, duration: number): MetaTileDoc` — clamps 1..255; returns `doc` itself when unchanged or `index` out of range.
- `addFrame(doc, copyOf?)`: a copy now goes **right after** `copyOf` and keeps its duration; a blank one still appends, taking the last frame's duration. Update `editors/meta/session.ts` `addFrame` so `session.frame` lands on the new frame (`copyOf + 1`, or the end). Check every caller: `grep -rn "addFrame" src | grep -i meta`.
- Session: `setDuration(session: MetaSession, index: number, duration: number): void` — one `commit`, none when unchanged.
- Export: table suffix `_Durations`, one byte per frame, appended after the existing unsuffixed frames table, comment `'Frames (VBlanks) each frame is held'`, only when `frames.length > 1`.

- [ ] **Step 1: Failing tests:** normalize of a file without `duration` → every frame 8; `duration: 0/300/'x'` → 1/255/8; serialize round-trip keeps durations; `addFrame(doc, 0)` on 3 frames inserts at index 1 with frame 0's duration; blank add takes the last frame's duration; `resizeMeta` and `remapMetaTiles` keep durations; `setFrameDuration` clamps and returns the same object when unchanged; `resourceTables` for a 3-frame bitmap meta ends with `_Durations` = durations; a 1-frame meta's `renderResourceFiles` output is byte-identical to `git show HEAD:` behaviour (assert no `_Durations` / `DURATIONS` text); a `bin` export's first bytes are unchanged and the durations come last; session `setDuration` is one undo step and marks dirty, unchanged value adds no step.
- [ ] **Step 2: Run** `npx vitest run src/shared/msx/meta-tile.test.ts src/shared/msx/resource.test.ts src/renderer/src/editors/meta/` — expect FAIL.
- [ ] **Step 3: Implement.** Reuse one clamp (e.g. `clampSpriteDuration` in `sprite.ts`, or move a shared `clampDuration` beside `DEFAULT_ANIM_DURATION` in `tile-anim.ts` and use it from both — not a third copy).
- [ ] **Step 4: Run** the Step 2 command, then `npm run typecheck:node && npm run typecheck:web`, then the real build `npx vitest run src/main/services/meta-build.test.ts` (exports a bitmap meta; must still link — a skip is not a pass). Then `npx vitest run src/main/services/demo-exports.test.ts src/main/services/demo-export.test.ts` (no demo has a `.meta-btiles.json`; they must stay green).
- [ ] **Step 5: Commit** `feat(meta): bitmap meta-tile frames keep a duration, exported as _Durations`.

### Task 3: `AnimationBar.vue`, adopted by the sprite editor

**Files:**
- Create: `src/renderer/src/components/AnimationBar.vue`
- Modify: `src/renderer/src/editors/sprite/SpriteEditorTab.vue` (bind the bar), `src/renderer/src/editors/sprite/session.ts` (`PlaybackBackground` becomes an alias of `AnimationBackground`), delete `src/renderer/src/editors/sprite/SpriteAnimationBar.vue` (or reduce it to a wrapper — implementer's call; say which), `src/shared/sprite-editor.ts` (remove `tickPlayback`/`PlaybackState` and their tests once unused)

**Interfaces — Consumes:** Task 1 (`previewFrame`, `startTick`, `parseDuration`, `fitScale`, `VBLANK_MS`).
**Produces** (Tasks 4–5 bind exactly this):
- Props: `frameCount: number`, `selected: number`, `durations: readonly number[]`, `loop?: PlaybackLoop` (default `'loop'`), `frameSize: { width: number; height: number }` (dots), `drawFrame: (ctx: CanvasRenderingContext2D, index: number, scale: number) => void` (draws frame `index` at `scale` from (0,0), transparent where empty), `artKey: unknown` (any change → thumbnails and preview redraw), `maxFrames?: number` (disables add/duplicate when reached).
- `v-model:playing: boolean`, `v-model:onionSkin: boolean`, `v-model:background: AnimationBackground` (from Task 1's module).
- Emits: `select [index]`, `add []` (blank, at end), `duplicate [index]` (after `index`), `remove [index]`, `move [from, to]` (buttons and drag), `duration [index, value]` (value already `parseDuration`-ed and non-null).
- Slot `extra`: editor-specific controls after the bar's own.
- Behaviour: Play disabled when `frameCount < 2`; Delete disabled at 1 frame; preview box and thumbnails scale by `fitScale`, `image-rendering: pixelated`; on play start, `start = startTick(durations, loop, selected)` and elapsed resets; the rAF loop survives remount with `playing` already true; after a `duration` emit, the input shows `durations[index]` from props (so a clamped or refused value snaps back).

- [ ] **Step 1:** Build the component, matching the sprite bar's look (layout, checkered pattern, button styles in today's `SpriteAnimationBar.vue`), plus a duration input under every thumbnail and drag-to-reorder (as `MetaFrameBar.vue` does today).
- [ ] **Step 2:** Switch the sprite editor to it. `drawFrame` = `compositeFrame(frame.layers, …)` + `drawIndices` (`editors/sprite/draw.ts`); `artKey` = the sprite's frames array; handlers = `addFrame`/`cloneFrame`/`removeFrame`/`reorderFrame`/`setFrameDuration` through the tab's existing `mutate`.
- [ ] **Step 3:** Remove `tickPlayback`/`PlaybackState` and their tests (covered by Task 1's `previewFrame` tests).
- [ ] **Step 4: Run** `npx vitest run src/shared src/renderer`, `npm run typecheck:web`, `npm run lint` — pass.
- [ ] **Step 5: Commit** `feat(editors): one AnimationBar, used by the sprite editor`.

### Task 4: Pose editor on the bar, with onion skin

**Files:**
- Modify: `src/renderer/src/editors/anim/AnimTileEditorTab.vue` (bind the bar), `editors/anim/AnimSidePanel.vue` (remove the "Preview" section, its timer and its Play button; keep loop and "All" durations), `editors/anim/AnimCanvas.vue` (onion skin), `editors/anim/session.ts` (`onionSkin`, `background` state + `setOnionSkin(session, on: boolean)`, `setBackground(session, value: AnimationBackground)`); delete `editors/anim/AnimFrameBar.vue`
- Test: `src/renderer/src/editors/anim/session.test.ts`

**Interfaces — Consumes:** Task 3's props/events; Task 1's `frameAtTick` (via `poseAtTick`).
- Bindings: `loop` = `doc.loop`; `drawFrame` from `posePixels(session, index)` (index 0 → transparent); `add` → `addFrame(session, null)`; `duplicate i` → `addFrame(session, i)`; `remove i` → `removeFrame(session, i)`; `move a b` → `moveFrame(session, a, b)`; `duration i v` → `setDuration(session, i, v)`; `select i` → `setFrame(session, i)`; `playing` → session's existing `playing`.
- Onion skin: when on and `session.frame > 0`, pose `frame - 1` drawn at alpha 0.3 before the current pose, beneath the see-through hatching, the float and the stroke preview (as `MetaCanvas.vue:172`).

- [ ] **Step 1: Failing session tests:** new session has `onionSkin === false`, `background === 'checkered'`; setters change them without dirtying or adding undo steps; `setDuration(session, 1, 999)` stores 255 in one step (exists — keep green).
- [ ] **Step 2: Run** `npx vitest run src/renderer/src/editors/anim/` — expect FAIL; then implement session state, then the `.vue` changes.
- [ ] **Step 3: Run** `npx vitest run src/renderer/src/editors/anim/`, `npm run typecheck:web`, `npm run lint` — pass.
- [ ] **Step 4: Commit** `feat(anim): the pose editor plays in the shared animation bar, with onion skin`.

### Task 5: Bitmap meta editor on the bar

**Files:**
- Modify: `src/renderer/src/editors/meta/MetaTileEditorTab.vue` (bind the bar; Grid toggle in the `extra` slot), `editors/meta/session.ts` (`background` state + `setBackground`; make sure nothing steps `session.frame` while playing); delete `editors/meta/MetaFrameBar.vue` (its fps box and frame-stepping interval go)
- Test: `src/renderer/src/editors/meta/session.test.ts`

**Interfaces — Consumes:** Task 3's props/events; Task 2's `setDuration`, `addFrame` (copy after), `removeFrame`, `reorderFrames`.
- Bindings: `loop` = `'loop'`; `drawFrame` draws `metaThumbnail(sheet(session), doc, index)` scaled (`editors/map/sheet.ts:185`); `artKey` must also change when the tileset's sheet changes; `frameSize` = `width * cell.width` × `height * cell.height` dots (8×8 cells when `cell` is null); `maxFrames` = `MAX_FRAMES`.

- [ ] **Step 1: Failing session tests:** `background` defaults to `'checkered'`, `setBackground` does not dirty; `togglePlaying` does not change `session.frame` (assert across a fake timer advance if any timer remains).
- [ ] **Step 2: Run** `npx vitest run src/renderer/src/editors/meta/` — FAIL; implement; run again — pass. Then `npm run typecheck:web`, `npm run lint`.
- [ ] **Step 3: Commit** `feat(meta): the bitmap meta-tile editor plays in the shared animation bar`.

### Task 6: Docs

**Files:** `src/main/services/agent-guide.ts` (+ `agent-guide.test.ts` / `agent-guide-meta.test.ts`), `docs/resources.md`, `docs/editing.md` if it describes the sprite or meta animation bars, `specs/09-sprite-editor.md` (the bar is now shared), the bitmap meta-tile spec if one describes frames (`grep -ln "meta-btiles" specs docs`), demo `CLAUDE.md`s only if they mention bitmap meta frames.
- [ ] **Step 1:** Guide: `.meta-btiles.json` frames carry `duration`; `_Durations` (when >1 frame); a short C example timing `frames[slot]` for `_DrawPlacements` with one tick byte per animated meta (zero RAM first — CLAUDE.md "Emitted C runs on a machine with no zeroed RAM"); no helper is emitted. Docs: one bar in three editors (preview, durations, onion skin, background, drag), Play start rule.
- [ ] **Step 2: Run** `npx vitest run src/main/services/agent-guide.test.ts src/main/services/agent-guide-meta.test.ts src/main/services/docs.test.ts`, `npm run check`.
- [ ] **Step 3: Commit** `docs: the shared animation bar and bitmap meta-tile durations`.

### Task 7: Verification (coordinator)

- [ ] Full `npm run check` and `npx vitest run` (real MSXgl present; skips explained).
- [ ] Drive the app over CDP (`electron-vite dev --remoteDebuggingPort 9222`, scratch copy of `demo_msx1` + a bitmap meta in a scratch copy of `demo_msx2`; wait ≥ 5 s after any `.vue` edit) for each editor: play/pause, switch tab and back while playing, set a duration (and an empty / 999 value), delete a frame while playing, onion skin, background, drag reorder, a 16×16 and a 1×1 meta's preview.
- [ ] Commit any fixes; report to Pablo what was clicked by CDP and that his own click-through remains the real check.
