# MSXDEVStudio — Overview & Implementation Guide

A desktop IDE for MSX game development: Godot's project/editor model, Pico-8's
"everything included" feel, VS Code's workbench — built on the
[MSXgl](https://github.com/aoineko-fr/MSXgl) C library, SDCC, and OpenMSX/WebMSX.
Targets MSX1, MSX2, MSX2+, and MSX turbo R.

## Stack

Electron + Vue 3 (TypeScript, script setup) + Pinia + Vue Router + Monaco,
tooling via `electron-vite`, packaging via `electron-builder`. Ships on **Linux and
Windows**. Tests: Vitest for `src/shared/` logic; no e2e framework in v1.

## Repo layout

```
src/main/       Electron main: services (fs, git, toolchain, project, build, resources…)
src/preload/    single typed bridge: window.api.invoke / window.api.on
src/renderer/   Vue app: activity bar, panels, editor tabs, stores
src/shared/     ipc.ts (the IPC contract) + msx/ (pure MSX logic library)
specs/          these documents
```

Core conventions (defined in Spec 01, used by all): every IPC channel is declared
in `src/shared/ipc.ts`; every file-type editor registers in
`src/renderer/editors/registry.ts`; long output streams to the Output panel via
`outputStore`; diagnostics go to `problemsStore`.

## The one architectural fact to internalize

MSXgl is not just a library — it bundles its whole toolchain (SDCC 4.6.0, MSXtk
converters, Node 18 runtime, msxtar, MSX-DOS files; Linux + Windows binaries) and a
Node-based build orchestrator. **MSXDEVStudio therefore wraps, never reimplements:**
builds spawn `<msxgl>/engine/script/js/build.js` with cwd = project folder; image
conversion uses bundled `MSXimg`; DSK creation, emulator launching, mapper layout
are all the build tool's job. The IDE's own value is the UI, the constraint-aware
editors, and generating correct configuration. Read `specs/msxgl-notes.md` (repo
reference, gathered from the actual source) before implementing any spec that
touches MSXgl.

## Spec index & phases

| Phase | Spec | Title | Model |
|---|---|---|---|
| 1 | [01](01-app-shell.md) | Application shell (Electron+Vue scaffold, IPC, layout) | Sonnet 5 |
| 1 | [02](02-toolchain.md) | Toolchain service (MSXgl + OpenMSX detect/download) | Sonnet 5 |
| 1 | [03](03-project-system.md) | Project system (.msxproj, config generation, wizard) | Opus 5 |
| 1 | [04](04-build-run.md) | Build & run (build.js wrapper, problems, OpenMSX/WebMSX) | Opus 5 |
| 1 | [05](05-workbench.md) | Workbench (explorer + Monaco tabs; search in Ph. 2) | Sonnet 5 |
| 2 | [06](06-git.md) | Git integration | Sonnet 5 |
| 2 | [12](12-examples-browser.md) | Examples browser (56 MSXgl samples: try/fork) | Sonnet 5 |
| 3 | [07](07-graphics-core.md) | Graphics core & asset pipeline (msx lib, MSXimg rules) | Opus 5 |
| 3 | [08](08-tile-editor.md) | Tile editor (constraint-enforcing) | Opus 5 |
| 3 | [09](09-sprite-editor.md) | Sprite editor (modes 1/2, OR-color, animation) | Sonnet 5 |
| 4 | [10](10-map-screen-editors.md) | Map & bitmap-screen editors | Sonnet 5 |
| 5 | [11](11-sfx-editor.md) | PSG sound-effect editor (ayFX) | Opus 5 |
| 5 | [13](13-packaging.md) | Packaging & distribution | Sonnet 5 |

**Phase 1 = the core loop:** create a project from the MSXgl template, edit C code,
press F5, watch it boot in openMSX. Everything else layers on top. Within Phase 1
the dependency order is 01 → 02 → 03 → 04, with 05 parallel after 01.

## Implementation workflow

Each spec is self-contained for one sub-agent: read this file + `msxgl-notes.md` +
the spec, then implement to its Acceptance list. Specs state *what* and the fixed
contracts (file formats, IPC names, MSXgl invocations); internal code structure is
the implementer's call. When a spec references real MSXgl paths/behavior, trust
`msxgl-notes.md` over memory, and verify against a live clone of
https://github.com/aoineko-fr/MSXgl when in doubt.

Deferred by design (add when needed, not before): auto-update, code
intelligence/LSP beyond Monaco defaults, music tracker (external tools cover it),
real-hardware run UI, msxgl_config.h settings UI, bundled/offline WebMSX,
V9990 tooling, macOS.

## Licensing note

MSXgl is CC BY-SA 4.0 (bundled third-party tools under their own free licenses).
MSXDEVStudio doesn't redistribute MSXgl — Spec 02 downloads it to the user's machine —
but games built with it inherit MSXgl's license terms; surface this in the About
dialog and README.
