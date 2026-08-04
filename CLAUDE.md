# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

MSXStudio is a desktop IDE for MSX game development (Electron + Vue 3 + TypeScript + Pinia + Monaco) that wraps the MSXgl C library, SDCC, and openMSX/WebMSX. Built spec-first: `specs/00`–`13` are the implementation plan, and **`specs/msxgl-notes.md` is the ground-truth MSXgl reference** (build.js invocation, config chain, exit codes, MSXimg CLI, ayFX format) — trust it over memory; it was extracted from a real MSXgl clone.

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

- `src/shared/` — `ipc.ts` (the entire IPC contract) plus dependency-free logic that runs in main, renderer, and Vitest unchanged: `.msxproj` model/config generation (`msxproj.ts`), MSX hardware and formats (`msx/`: palettes, tiles, sprites, screen modes, ayFX SFX, image quantization), editor logic (`tile-editor.ts`, `map-editor.ts`, …). The sprite, map and screen editors share one undo stack, `history.ts`'s `History<T>`, re-exported under their own names so call sites name their own module; the tile editor keeps its own, because its entries carry a label and a tile-renumbering map.
- `src/main/services/` — each domain is split in two: a **pure, Electron-free module** (`build.ts`, `toolchain.ts`, `project.ts`, `git.ts`, `resources.ts`, `examples.ts`) holding all testable logic, and a `*-service.ts` class that wires it to Electron/IPC with dependencies injected (see `BuildDeps`). Keep new logic in the pure module; the service stays thin. `src/main/index.ts` supplies real implementations.
- `src/preload/index.ts` — the single typed bridge (`window.api.invoke`/`window.api.on`). Never call `ipcRenderer` anywhere else.
- `src/renderer/` — Vue app; Pinia stores call `window.api`, components/editors are thin shells over the logic in `src/shared/`.

Adding an IPC channel: one line in `IpcApi` (or `IpcEvents`) in `shared/ipc.ts`, implement in a main service, call from a renderer store.

The application menu (`main/menu.ts`) owns no behaviour: each item sends a `MenuCommand` over `menu:command`, and `renderer/src/commands.ts` runs it through the store action the equivalent button uses. Its accelerators are **labels only** (`registerAccelerator: false`) because the shortcuts are already bound in the renderer — registering them there too fires both handlers. Save/undo/redo reach an arbitrary tab through optional hooks on `EditorRegistration` (`editors/registry.ts`), so "save the active tab" works without knowing which editor it is; a new editor that skips them gets the Monaco text path.

### Groups: the one idea in three editors

A design bigger than the hardware's unit is modelled the same way every time — **a named group that owns no pixels**, only references to something that does. Painting the group paints what it points at, so there is no second copy to keep in sync.

- **`TileBlock`** (`msx/tile.ts`) — `width × height` references into the tile bank. Structurally `map-editor.ts`'s `Stamp`, deliberately, so a block can be handed to `applyStamp` unchanged. sc1 blocks are group-aligned (`SC1_GROUP`) because eight tiles share one FG/BG pair there. The tile grid's marquee is the *same* type, built on the fly by `selectionBlock()` — selecting a rectangle is all it takes to edit those tiles as one image, and `blockFromTiles` is what names one when the user wants to keep it. Both pickers wrap to their pane (`fitColumns`), so the column count a selection is read against is measured, not fixed: it lives on the tile session and `setColumns` collapses a stale marquee when it changes.
- **`SpriteCharacter.cols/rows` + `SpriteLayer.cx/cy`** (`msx/sprite.ts`) — a metasprite. `compositePixel` works in *character* space and each plane only answers for its own cell, so one composite serves canvas, thumbnails and filmstrip. `MAX_LAYERS` is the OR-color stack **per cell**, not per character.
- **`ScreenFragment`** (`msx/screen.ts`) — a rectangle of the converted bitmap. Exported as one side-by-side strip, which is what lets a single `HMMC` upload every software-sprite frame.

Deleting or reordering tiles renumbers blocks and flags through the same Spec 10 remap seam maps use (`reorderTiles`/`removeTile` → `TilesReorderEvent`).

### Export: tables, constants, ready-made C

`resourceTables()` emits data; `resourceConstants()` emits `#define`s locating each group in it (`..._BASE/_W/_H`, `..._BASE/_PLANES/_FRAMES`); `resourceCode()` emits working C, gated on `ExportBlock.helpers` (a checkbox per editor, off by default) because it calls MSXgl and a data-only header must not. The emitted C calls **MSXgl's own API, never a reimplementation** — `VDP_SetSpriteExMultiColor`/`VDP_SetSpriteSM1`, `VDP_WriteLayout_GM2`, `VDP_CommandHMMC`/`HMMM`/`LMMM`. The one exception is software sprites: MSXgl ships no module for them, only the `s_swsprt` sample, so `screenHelperC` generalises that sample's save/restore/blit cycle.

Emitted C is not verified by compiling it in your head. Build a scratch project from `~/MSXgl/projects/template{,_msx2}` **outside `/tmp`** (MSXgl renames `.rel` files across directories and `rename(2)` will not cross filesystems), then boot the ROM:
`OPENMSX_SYSTEM_DATA=<openmsx>/share <openmsx>/bin/openmsx -machine C-BIOS_MSX2_EU -cart <rom> -script <tcl>` with `after time 12 { screenshot -raw <png>; exit }` — C-BIOS needs ~10s before the cartridge runs.

### The build pipeline (the core of the app)

MSXStudio never reimplements MSXgl's build — it spawns `node <msxgl>/engine/script/js/build.js <steps>` with **cwd = the project dir** (MSXgl bundles its own SDCC, MSXtk, and Node). Around that:

- `.msxproj` (JSON) is the project model; `generateProjectConfig()` regenerates `project_config.js` before every build unless `customConfig` is set. Values equal to MSXgl's own defaults are omitted, except those that `projects/default_config.js` (the user-global config, loaded before the project one) would silently override.
- Config chain order: engine `setup_global.js` → `<msxgl>/projects/default_config.js` → project `project_config.js` (last wins). The IDE writes the emulator path into the user-global file (`writeEmulatorConfig`).
- Incremental builds: generated configs set `CompileSkipOld` (MSXgl skips sources whose `.rel` in `out/` is newer). That mtime check is blind to header/define/config changes, so `needsFullRebuild()` in `build.ts` guards it with a stamp file in `out/` and a header-mtime sweep, swapping `all` for MSXgl's `rebuild` step when it trips. The stamp is written **after** the build — rebuild's clean step wipes `out/`.
- Build output is parsed line-by-line into Problems (SDCC/sdasz80/ASxxxx formats, fixtures in `__fixtures__/`). MSXgl's three-digit exit codes come back mod 256 on POSIX — `exitCodeMessage()` matches both.
- Run: openMSX launches via MSXgl's own `run` step (relocatable Linux tarballs need `OPENMSX_SYSTEM_DATA` injected — handled in the spawn env); WebMSX gets the ROM lent over a loopback `ArtifactServer` to webmsx.org (Chrome 141+ requires the user to allow "local network access").
- Pre-build, `resource-service` exports editor resources to C headers (mtime-skipped), so resource edits flow into the compile.

### Conventions

- Toolchain resolution (`toolchain-service.ts`): explicit setting → PATH → platform default; validation shells the real binaries.
- Tests live next to their module. Non-trivial logic in shared/main gets tests; renderer correctness rides on the shared modules it delegates to.
- `package.json`'s `homepage` is a guessed GitHub URL kept only because the `.deb` builder requires one — correct it when a real repo exists.
