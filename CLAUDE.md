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

Some `src/main/services` tests (`build-service`, `resources`, `toolchain`, `project`, `examples`) use a **real MSXgl checkout** hard-coded as `REAL_MSXGL` in the test files — the build ones run real compiles — they take ~40s each and fail if that checkout is missing. The pure-logic tests are fast.

## Architecture

Three Electron layers plus a shared core:

- `src/shared/` — `ipc.ts` (the entire IPC contract) plus dependency-free logic that runs in main, renderer, and Vitest unchanged: `.msxproj` model/config generation (`msxproj.ts`), MSX hardware and formats (`msx/`: palettes, tiles, sprites, screen modes, ayFX SFX, image quantization), editor logic (`tile-editor.ts`, `map-editor.ts`, …).
- `src/main/services/` — each domain is split in two: a **pure, Electron-free module** (`build.ts`, `toolchain.ts`, `project.ts`, `git.ts`, `resources.ts`, `examples.ts`) holding all testable logic, and a `*-service.ts` class that wires it to Electron/IPC with dependencies injected (see `BuildDeps`). Keep new logic in the pure module; the service stays thin. `src/main/index.ts` supplies real implementations.
- `src/preload/index.ts` — the single typed bridge (`window.api.invoke`/`window.api.on`). Never call `ipcRenderer` anywhere else.
- `src/renderer/` — Vue app; Pinia stores call `window.api`, components/editors are thin shells over the logic in `src/shared/`.

Adding an IPC channel: one line in `IpcApi` (or `IpcEvents`) in `shared/ipc.ts`, implement in a main service, call from a renderer store.

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
