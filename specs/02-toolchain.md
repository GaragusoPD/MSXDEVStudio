# Spec 02 — Toolchain Service

**Phase:** 1 · **Depends on:** 01 · **Suggested model:** Sonnet 5

## Goal

Detect or download everything needed to build and run MSX programs. Thanks to MSXgl's
layout this is small: **MSXgl bundles SDCC 4.6.0, MSXtk, a Node 18 runtime, msxtar and
MSX-DOS system files for both Linux and Windows** under `tools/`. Only two things are
user-provided: the MSXgl folder itself and an OpenMSX install. WebMSX needs nothing.

## Settings (global, in app userData via Spec 01 StateService)

```ts
interface ToolchainSettings {
  msxglPath: string | null      // root of an MSXgl checkout
  openmsxPath: string | null    // openmsx executable
  nodePath: string | null       // override; default = bundled tools/build/Node/node(.exe)
}
```

## MSXgl acquisition (`ToolchainService` in main)

- **Validate** a candidate root by checking these exist (append `.exe` on Windows):
  `engine/script/js/build.js`, `tools/sdcc/bin/sdcc`, `tools/MSXtk/bin/MSXimg`,
  `tools/build/Node/node`, `tools/build/msxtar/msxtar`.
- **Detect:** stored setting → `MSXGL_PATH` env var → nothing else (no folder scanning).
- **Download fallback:** "Download MSXgl" button → `git clone --depth 1
  https://github.com/aoineko-fr/MSXgl.git` into a user-chosen folder (default
  `~/MSXgl`); if git is absent, download the GitHub zip
  (`codeload.github.com/aoineko-fr/MSXgl/zip/refs/heads/main`) with progress UI and
  extract. **After zip extract on Linux, `chmod +x` every file under `tools/sdcc/bin/`,
  `tools/MSXtk/bin/`, `tools/build/Node/`, `tools/build/msxtar/`, `tools/build/DskTool/`**
  (zip loses exec bits). Record the resolved version (git HEAD or download date).
- **Update:** if the folder is a git repo, "Update MSXgl" runs `git pull` (surface
  conflicts as "re-download recommended"). Zip installs: re-download.

## OpenMSX

- **Detect:** stored setting → `openmsx` on PATH → `C:\Program Files\openMSX\openmsx.exe`
  (Windows). Validate by running `openmsx --version` and capturing the version string.
- **No auto-install.** If missing, show install guidance: distro package on Linux
  (`apt install openmsx` etc.), openmsx.org download on Windows. WebMSX (Spec 04) is
  offered as the zero-install alternative in the same dialog.
- When a valid path is known, write it into `<msxglPath>/projects/default_config.js`
  as `Emulator = "<path>";` — that file is MSXgl's own gitignored user-global config
  (auto-created by its build tool), so CLI builds outside the IDE get the emulator
  too. Create the file from `engine/script/js/default_config.js` if missing, and only
  rewrite the `Emulator` line (preserve user edits elsewhere).

## UI

- **Settings page** (route from a gear icon): the three paths with Browse buttons,
  live validation states (✓ version / ✗ what's missing), Download/Update MSXgl and
  OpenMSX-guidance buttons.
- **First-run:** Welcome screen (Spec 01) shows a "Set up toolchain" call-to-action
  when validation fails; project open/create is allowed but Build/Run buttons show
  the blocking reason (Spec 04 consumes `toolchain:status`).
- IPC: `toolchain:getStatus`, `toolchain:setPaths`, `toolchain:downloadMsxgl`
  (progress events `toolchain:progress`), `toolchain:updateMsxgl`.

## Acceptance

- Fresh machine, no settings: status reports both missing; Download MSXgl produces a
  validated install on Linux (exec bits verified by actually running
  `tools/MSXtk/bin/MSXimg` with no args) and Windows.
- Pointing at a broken folder lists exactly which sentinel files are missing.
- With openMSX installed, status shows its version and `default_config.js` contains
  the right `Emulator` line without clobbering other user edits.
