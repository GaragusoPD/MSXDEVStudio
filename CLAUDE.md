# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

MSXDEVStudio is a desktop IDE for MSX game development (Electron + Vue 3 + TypeScript + Pinia + Monaco) that wraps the MSXgl C library, SDCC, and openMSX/WebMSX. Built spec-first: `specs/00`–`13` are the implementation plan, and **`specs/msxgl-notes.md` is the ground-truth MSXgl reference** (build.js invocation, config chain, exit codes, MSXimg CLI, ayFX format) — trust it over memory; it was extracted from a real MSXgl clone.

## Commands

```bash
npm run dev                # launch the app with hot reload (--noSandbox is intentional)
npm run check              # lint + typecheck — the CI gate
npm run typecheck:node     # tsc over main/preload/shared (tsconfig.node.json)
npm run typecheck:web      # vue-tsc over the renderer (tsconfig.web.json)
npm run test               # vitest over src/shared/ and src/main/ (renderer has no unit tests)
npx vitest run src/shared/tile-editor.test.ts        # single file
npx vitest run src/main/services/build.test.ts -t 'stamp'  # filter by test name
npx electron-builder --dir # unpacked package for this platform
```

Some `src/main/services` tests (`build-service`, `resources`, `toolchain`, `project`, `examples`, `msxgl-symbols`) use a **real MSXgl checkout** — the build ones run real compiles, ~40s each, and skip when it's missing. Its path and their scratch root live in `src/main/services/__fixtures__/msxgl.ts`; override with `MSXGL_PATH=/your/clone`. Scratch projects go *beside* the checkout, not in `/tmp`: MSXgl's compile step renames `.rel` files out of the engine dir, which fails with EXDEV across filesystems. The pure-logic tests are fast.

## Architecture

Three Electron layers plus a shared core:

- `src/shared/` — `ipc.ts` (the entire IPC contract) plus dependency-free logic that runs in main, renderer, and Vitest unchanged: `.msxproj` model/config generation (`msxproj.ts`), MSX hardware and formats (`msx/`: palettes, tiles, sprites, screen modes, ayFX SFX, image quantization), editor logic (`tile-editor.ts`, `map-editor.ts`, …). Importing an asset sheet is split the same way: `msx/sheet.ts` cuts a PNG into cells (grid, pixel scale, key colour, the guesses), `msx/sheet-convert.ts` turns converted cells into each destination resource, and `renderer/src/editors/sheet-import.ts` applies the result to a new file or, through its editor, an existing one. The sprite, map and screen editors share one undo stack, `history.ts`'s `History<T>`, re-exported under their own names so call sites name their own module; the tile editor keeps its own, because its entries carry a label and a tile-renumbering map. The map and screen editors also share one selection, `floating.ts`: a move, a paste or an import is a *float* held on the session above the document — the canvas draws `displayDoc`/`displayPixels` — and lands as one undo step when dropped. Anything that changes what the float's values mean (switching layer, tool, mode or tileset; resizing; saving) drops it first.
- `src/main/services/` — each domain is split in two: a **pure, Electron-free module** (`build.ts`, `toolchain.ts`, `project.ts`, `git.ts`, `resources.ts`, `examples.ts`) holding all testable logic, and a `*-service.ts` class that wires it to Electron/IPC with dependencies injected (see `BuildDeps`). Keep new logic in the pure module; the service stays thin. `src/main/index.ts` supplies real implementations.
- `src/preload/index.ts` — the single typed bridge (`window.api.invoke`/`window.api.on`). Never call `ipcRenderer` anywhere else.
- `src/renderer/` — Vue app; Pinia stores call `window.api`, components/editors are thin shells over the logic in `src/shared/`. Editor sessions are module-level maps keyed by tab path — except a `.tiles.json`, which lives in `stores/tilesetStore.ts` because the meta-tile editor writes into it and two in-memory copies would overwrite each other on save. Undo stays per editor and rebases on external change. That was loss-free while painting only ever *appended* tiles; the map editor's edit mode rewrites a tile in place and its promotion to banked replaces the document wholesale, so it no longer is, and each editor guards its own side — the map's undo restores only slots that still hold what it painted (`map/session.ts`, `swapTileEdits`), and the tile editor starts its history over across a banked/unbanked flip rather than let an undo push the old document back (`tile/session.ts`).

Adding an IPC channel: one line in `IpcApi` (or `IpcEvents`) in `shared/ipc.ts`, implement in a main service, call from a renderer store.

The application menu (`main/menu.ts`) owns no behaviour: each item sends a `MenuCommand` over `menu:command`, and `renderer/src/commands.ts` runs it through the store action the equivalent button uses. Its accelerators are **labels only** (`registerAccelerator: false`) because the shortcuts are already bound in the renderer — registering them there too fires both handlers. Save/undo/redo reach an arbitrary tab through optional hooks on `EditorRegistration` (`editors/registry.ts`), so "save the active tab" works without knowing which editor it is; a new editor that skips them gets the Monaco text path.

### Groups: the one idea in three editors

A design bigger than the hardware's unit is modelled the same way every time — **a named group that owns no pixels**, only references to something that does. Painting the group paints what it points at, so there is no second copy to keep in sync.

- **`TileBlock`** (`msx/tile.ts`) — `width × height` references into the tile bank. Structurally `map-editor.ts`'s `Stamp`, deliberately, so a block can be handed to `applyStamp` unchanged. sc1 blocks are group-aligned (`SC1_GROUP`) because eight tiles share one FG/BG pair there. The tile grid's marquee is the *same* type, built on the fly by `selectionBlock()` — selecting a rectangle is all it takes to edit those tiles as one image, and `blockFromTiles` is what names one when the user wants to keep it. Both pickers wrap to their pane (`fitColumns`), so the column count a selection is read against is measured, not fixed: it lives on the tile session and `setColumns` collapses a stale marquee when it changes.
- **`SpriteCharacter.cols/rows` + `SpriteLayer.cx/cy`** (`msx/sprite.ts`) — a metasprite. `compositePixel` works in *character* space and each plane only answers for its own cell, so one composite serves canvas, thumbnails and filmstrip. `MAX_LAYERS` is the OR-color stack **per cell**, not per character.
- **`ScreenFragment`** (`msx/screen.ts`) — a rectangle of the converted bitmap. Exported as one side-by-side strip, which is what lets a single `HMMC` upload every software-sprite frame.
- **`MetaTileDoc`** (`msx/meta-tile.ts`) — a `.meta-btiles.json`, the bitmap-mode meta-tile: one file, one design, with its own size, animation frames and eight gameplay flags, as tile numbers into the one bitmap tileset it names. (Pattern metas own their pixels instead — below.) The only group with a *pixel* editor, and the invariant survives it: `meta-paint.ts` resolves each stroke **copy-on-write** into the referenced tileset — derive what the cell would look like, find-or-create that tile in the bank, repoint the cell. The bank is append-only, so painting a meta can never change what a map drawn with the same tileset looks like, and the dedup is free because "find" is half the operation. Its cost is orphans after undo, which an explicit Compact reclaims; it only removes tiles the session itself created, because reachability across closed files is not knowable. The hardware limit is not reimplemented — `paintPixel` decides, against a scratch one-tile doc.

**Animated tiles are the deliberate exception: an animation owns its pixels.**
`*.anim-tiles.json` (`msx/tile-anim.ts`) stores its poses as tile bytes, because
the point of it is to be attached to and detached from tilesets freely. What a
tileset holds is a *binding* (`TilesDoc.animations`): a window of consecutive
slots whose art is the animation's frame 0 — derived data, refreshed from the
animation by the tile editor and before every export through one
`animRefFrom`. The generated `_Animate()` copies poses over the window, so every
cell showing it animates without a name-table write; per-copy animation stays
a bitmap meta's frames.

**So do pattern meta-tiles** (`msx/meta-owned.ts`, `OwnedMetaDoc`): an
animation's poses plus a footprint (`holes`) and flags, naming no tileset, so
one meta can be attached to several. Attaching (`TilesDoc.metas`,
`MetaBinding`) is one `resolveMeta`, used by the tile editor, the map editor and
the exporter alike: see-through cells are 0 (and a meta's art never resolves to
tile 0, so 0 always means skip), still cells find-or-create their art, and the
cells that change between poses get a window filed in `TilesDoc.animations`
under the meta's path — so `_Animate()`, compaction, window protection and the
reorder remap all apply to it unchanged. A refresh keeps every tile that still
shows the right art and appends what changed, which is what makes two refreshes
of the same files agree. The exporter runs it before exporting a tileset **and**
before exporting any map drawn with it (`refreshTileset` in
`main/services/resources.ts`), because a map mirrors a meta's cells
(`MetaRef.cells`) and has to agree with the tileset on every number. A
`.meta-tiles.json` opens in the pose editor (`editors/anim`,
`session.kind === 'metatiles'`); `editors/meta` is the `.meta-btiles.json`
editor only. There is no older tileset-referencing pattern meta any more — a
file from before reads as a blank meta at its own size. Removing a meta from a
tileset takes it off every map drawn with that tileset (`editors/meta-removal.ts`:
open maps by event, closed ones rewritten), since a map cannot place a meta its
tileset does not have — the export refuses it.

Tile 0 is the seam that makes a group *transparent*: `TilesDoc.reserveTile0` locks it all-blank, and a meta cell holding 0 is a **skipped write**, which is the only see-through a name table has. Off in every pre-existing file, because tile 0 is real art in `demo_msx1`. A map *places* metas (`MapLayer.placements`, over a mirrored `MapDoc.metas`) beside its ordinary tile grid; `baked` trades the runtime draw for grid bytes. An **indexed** layer (`MapLayer.indexed`) is the other way round: its placements — pattern metas, free to overlap, stacked in list order — *are* its content, exported as one byte per meta in reading order (`indexedLayerStream`; slot + 1, or 0 for an empty cell) plus overlay records (slot + 1, x, y) for the metas reading order cannot carry, and expanded by the game into a RAM tile map (`_Expand`). `indexedLayerPlan` decides which go where: a meta goes to the overlays when its top-left is covered, when another starts at the same cell, or when an opaque overlap would come out in the wrong order. `decodeIndexedStream`/`expandIndexedLayer` walk it exactly as the C does, and are what the tests hold the C to. Its metas are not in `_Placements`; its stream is never RLEp-packed, whatever the map's other layers are.

Deleting or reordering tiles renumbers blocks and flags through the same Spec 10 remap seam maps use (`reorderTiles`/`removeTile` → `TilesReorderEvent`).

### Export: tables, constants, ready-made C

Compression is opt-in per resource (`ExportBlock.compress`), for maps and screens: `compress.ts` packs RLEp — **MSXgl's own** format, so the game unpacks with the engine's `RLEp_UnpackToRAM` (needs the `compress` lib module; packed for `COMPRESS_USE_RLEP_DEFAULT TRUE`, the template's value, which puts the default byte first in the stream). `mapExport()`/`screenDataExport()` are the single decision points — the tables, the `_UNPACKED_SIZE` defines, the helper C and the header's parameter block all read that one answer, and `compressionApplied()` is how anything else asks. Two constraints shape them: a map packs all layers or none (one `_DrawLayer()` serves every layer, so it cannot unpack some of them), and a screen packs in **bands** of `BAND_BUDGET` bytes with a `_Bands` offset table, because a 27 KB SCREEN 5 picture cannot be unpacked in one piece on a 16 KB RAM page — `_Unpack()` does one band at a time straight into VRAM. Either kind declines compression when it wouldn't shrink the data.

`resourceTables()` emits data; `resourceConstants()` emits `#define`s locating each group in it (`..._BASE/_W/_H`, `..._BASE/_PLANES/_FRAMES`); `resourceCode()` emits working C, gated on `ExportBlock.helpers` (a checkbox per editor, off by default) because it calls MSXgl and a data-only header must not. The emitted C calls **MSXgl's own API, never a reimplementation** — `VDP_SetSpriteExMultiColor`/`VDP_SetSpriteSM1`, `VDP_WriteLayout_GM2`, `VDP_CommandHMMC`/`HMMM`/`LMMM`. The one exception is software sprites: MSXgl ships no module for them, only the `s_swsprt` sample, so `screenHelperC` generalises that sample's save/restore/blit cycle.

**A mirror is derived data, and only a layer with fs access can refresh it.** `MapDoc.metas` copies each meta's symbol, size and flags because `shared/` is dependency-free and cannot open another file — which is exactly why the copy goes stale. `main/services/resources.ts` re-reads it before every export; the map editor does the same on load. Both build it through one `metaRefFrom`, because when they had independent rules they disagreed about the one field that has to name a real C symbol and every map with helpers on failed to link. A fix in the *editor* does not fix a build: a fresh clone, CI, or an agent editing `res/` JSON never opens the map. For the same reason the export skip compares a resource's header against every file it mirrors (`exportDependencies`), not just its own: a map is stale when a meta it places changed, a tileset when an animation attached to it did.

**Emitted C runs on a machine with no zeroed RAM.** On a ROM target the startup copies initialised data out of ROM and does not clear the uninitialised section, so a caller's `static u8 frames[N]` is boot garbage — deterministic garbage, which reads as art rather than as a bug. Any helper taking a caller-owned buffer defends itself (`_DrawPlacements` clamps the frame index) *and* `agent-guide.ts` says to zero it. The guide's own "globals beat locals for anything hot" is what turns a safe local into an unsafe global, so the two notes have to sit together.

Emitted C is not verified by compiling it in your head. Build a scratch project from `~/MSXgl/projects/template{,_msx2}` **outside `/tmp`** (MSXgl renames `.rel` files across directories and `rename(2)` will not cross filesystems), then boot the ROM:
`OPENMSX_SYSTEM_DATA=<openmsx>/share <openmsx>/bin/openmsx -machine C-BIOS_MSX2_EU -cart <rom> -script <tcl>` with `after time 12 { screenshot -raw <png>; exit }` — C-BIOS needs ~10s before the cartridge runs. (Windows: `"C:/Program Files/openMSX/openmsx.exe"`, no env var needed.) A stub that waits for input needs input: `keymatrixdown 8 0x01` / `keymatrixup 8 0x01` presses SPACE from the same script — row 8 is SPACE(0x01), LEFT(0x10), UP(0x20), DOWN(0x40), RIGHT(0x80). Shoot before *and* after: one screenshot cannot tell a scrolling camera from a still one. Keep `throttle` on — with it off the renderer skips frames and `screenshot -raw` comes back black. To prove a VRAM effect rather than eyeball it, log `vpeek <addr>` from timed `after time` callbacks (an animation's pattern bytes, a colour entry) and diff the log between two builds. On Linux, Debian's `openmsx` package ships no C-BIOS ROMs: install `cbios` and copy `/usr/share/cbios/*.rom` into `~/.openMSX/share/systemroms/`.

The game-kit wizard's own emitted C is checked that way by `game-kit-build.test.ts`, which builds one project per `emitPlayC` branch against the real engine — the only thing that catches a stub calling an API that doesn't exist, or a `msxgl_config.h` default that leaves a module's symbols unresolved (`PAWN_USE_SPRT_FX` wanting the `spritefx` module nothing links).

### Music: one render for the ear and the ROM

A `.music.json` (Spec 15) is exported as **lVGM** — a frame-by-frame log of PSG register writes for MSXgl's `vgm/lvgm_player` — rather than PT3, so the IDE never re-implements a tracker's player: `renderSong` (`msx/music.ts`) produces one register snapshot per frame, and the editor's audio (`music-play.ts` → `psg.ts`'s three-channel chip) and `encodeLvgm` both consume exactly those frames. Keep it that way — any sound the editor makes that doesn't come from `renderSong` is a sound the game won't make.

Two player facts shape the encoder and the helper, both pinned by tests and by an openMSX register log (933 frames, no mismatch): `LVGM_Decode` skips the byte after `FE` on every loop, so the loop marker is written `FE F0`; and lVGM writes only registers that *change*, so an ayFX effect (which writes its channel into the same `g_PSG_Regs`) would leave that channel wrong after it ends — the exported `_Decode` keeps a copy of the song's R#0–R#12 and restores it before each decode. ayFX must use `AYFX_BUFFER_DEFAULT`; the template's `AYFX_BUFFER_PT3` fails to link (`_PT3_Regs`) without the PT3 player. `music-build.test.ts` builds the helper against the real engine.

### The build pipeline (the core of the app)

MSXDEVStudio never reimplements MSXgl's build — it spawns `node <msxgl>/engine/script/js/build.js <steps>` with **cwd = the project dir** (MSXgl bundles its own SDCC, MSXtk, and Node). Around that:

- `.msxproj` (JSON) is the project model; `generateProjectConfig()` regenerates `project_config.js` before every build unless `customConfig` is set. Values equal to MSXgl's own defaults are omitted, except those that `projects/default_config.js` (the user-global config, loaded before the project one) would silently override.
- Config chain order: engine `setup_global.js` → `<msxgl>/projects/default_config.js` → project `project_config.js` (last wins). The IDE writes the emulator path into the user-global file (`writeEmulatorConfig`).
- Incremental builds: generated configs set `CompileSkipOld` (MSXgl skips sources whose `.rel` in `out/` is newer). That mtime check is blind to header/define/config changes, so `needsFullRebuild()` in `build.ts` guards it with a stamp file in `out/` and a header-mtime sweep, swapping `all` for MSXgl's `rebuild` step when it trips. The stamp is written **after** the build — rebuild's clean step wipes `out/`.
- Build output is parsed line-by-line into Problems (SDCC/sdasz80/ASxxxx formats, fixtures in `__fixtures__/`). MSXgl's three-digit exit codes come back mod 256 on POSIX — `exitCodeMessage()` matches both.
- Run: openMSX launches via MSXgl's own `run` step (relocatable Linux tarballs need `OPENMSX_SYSTEM_DATA` injected — handled in the spawn env); WebMSX gets the ROM lent over a loopback `ArtifactServer` to webmsx.org (Chrome 141+ requires the user to allow "local network access").
- Pre-build, `resource-service` exports editor resources to C headers (mtime-skipped), so resource edits flow into the compile.

### Conventions

- Toolchain resolution (`toolchain-service.ts`): explicit setting → PATH → platform default; validation shells the real binaries.
- Tests live next to their module. Non-trivial logic in shared/main gets tests; renderer components ride on the shared modules they delegate to — **except `renderer/src/stores` and `renderer/src/editors/*/session.ts`**, which vitest does include. A store or a session holds lifecycle and wiring no shared module can reach, and that is exactly where a silent early-return hides: a stroke that reaches a guard and returns looks identical to a dead canvas. They need no DOM — `window.api` stubs in five lines.
- **Test the layer the failure happens in.** A session test proves the editor is right and says nothing about a build, because `exportResourceFile` never goes near a session. Every export-path test therefore renders from files *without opening anything*, which is the common case: a fresh clone, CI, an agent editing `res/` by hand.
- **`agent-guide.ts` is a deliverable, not a comment.** Every new project (and forked sample) ships a `CLAUDE.md`/`AGENTS.md` written from it, and that file is the *only* thing an agent working inside a generated project knows about this IDE. So a feature that changes what the exporter emits, what a generated file is called, how a resource is used from C, or what the build does is not finished until the guide says so — otherwise agents keep writing code against last release's headers. Same for the demos' own `CLAUDE.md`/`AGENTS.md` (`demo_msx1/`, `demo_msx2/`), which are hand-written and cover those projects specifically.
- `package.json`'s `homepage` is a guessed GitHub URL kept only because the `.deb` builder requires one — correct it when a real repo exists.
