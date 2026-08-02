# Spec 04 — Build & Run

**Phase:** 1 · **Depends on:** 01, 02, 03 · **Suggested model:** Opus 5 (output
parsing + emulator arg mapping), the rest Sonnet 5

## Goal

Compile the open project to ROM/DSK/COM via MSXgl's build tool and run it in
OpenMSX or WebMSX, with streamed output and clickable errors.

## Build (`BuildService` in main)

Spawn (never shell-interpolate):

```
<node> <msxglPath>/engine/script/js/build.js <args…>    cwd = project root
```

`<node>` = `tools/build/Node/node(.exe)` from the MSXgl folder (or the Spec 02
override). Pre-step: if not `customConfig`, regenerate `project_config.js`
(Spec 03) and run resource export + imgRules (Spec 07). Commands:

- **Build** → `all` · **Rebuild** → `rebuild` · **Clean** → `clean`
- **Build & Run** → `all run`
- `.msxproj` `build.defines` map → repeated `define=NAME:value` args.

One build at a time (queue = reject with "build in progress"). Kill button
terminates the process tree. Stream stdout/stderr (ANSI-stripped) to the Output
panel; on exit push `build:finished {ok, code, artifacts}`.

**Artifacts:** after success, resolve what exists for the target:
`emul/rom/<name>.rom`, `emul/dsk/<Target>_<name>.dsk`, `emul/bin/`, `emul/dos1|2/`,
`out/<name>.map`. Show them in a small "Artifacts" section of the Run panel with
file sizes and reveal-in-file-manager.

**Problems parsing** (feed Spec 05 `problemsStore`, source `"build"`):
- SDCC: `^(.+?):(\d+): (warning|error) (\d+): (.*)$` (and `syntax error` variants)
- sdasz80/sdldz80: lines starting `?ASxxxx-Error` / `?ASlink-Warning` — capture
  file/line where present, else file-less problem entries.
- Write regexes against captured fixtures: deliberately break `template.c` (missing
  semicolon, unknown symbol) and commit the raw outputs as test fixtures.

**Exit-code map** (build.js uses distinct codes): at minimum 20/30/35/40/50 →
"toolchain path invalid — open Toolchain Settings", 110 → "unknown LibModules
entry", 500 → "OpenMSX has no C-BIOS turbo R machine — set an openMSX machine
override in Project Settings". Unknown codes: generic failure + last stderr lines.

## Run

Toolbar (editor-area top right) + keybindings: **F5** Build & Run, **Ctrl+Shift+B**
Build, target picker (OpenMSX / WebMSX) bound to `.msxproj` `emulator.preferred`.

### OpenMSX path

MSXgl's own `run` step launches it — the IDE only guarantees config: Spec 02 keeps
`Emulator` pointing at openmsx in `projects/default_config.js`; Spec 03 generates the
`Emul*` flags. Machine selection: by default MSXgl passes C-BIOS machines matched to
`Machine`. If `.msxproj` `emulator.openmsxMachine` is set (needed for turbo R and
real-BIOS setups), generate `EmulMachine = false;` and append
`-machine <name>` via `EmulExtraParam`.

### WebMSX path (zero-install)

- Main-process `ArtifactServer`: `http.createServer` on `127.0.0.1:<random port>`,
  serves only the current artifact file(s), header
  `Access-Control-Allow-Origin: *`, stopped when the app quits or project closes.
- `shell.openExternal` to `https://webmsx.org/?MACHINE=<m>&<slot>`, where machine maps
  `1→MSX1`, `2→MSX2`, `2P→MSX2P`, `TR→MSXTR` (multi-machine values use the highest),
  and slot is `ROM=<url>` for ROM targets or `DISK=<url>` for BIN/DOS/DSK targets.
  Verify the exact WebMSX parameter names against webmsx.org docs at implementation
  time; they are config-file documented in the WebMSX repo (`ppeccin/webmsx`).
- If the default browser can't reach webmsx.org (offline), show the artifact path +
  hint to drag-drop into any local emulator. Bundling WebMSX locally is a possible
  later enhancement, not v1.

### Real hardware

Out of scope for the UI. `customConfig` users can still set `RunDevice` themselves;
nothing in the IDE blocks it.

## Status bar (fills Spec 01 placeholders)

Right side: `<machine> · <target>` (click → Project Settings), build spinner while
running, error/warning counts (click → Problems).

## Acceptance

- New template project (Spec 03): Build produces `emul/rom/<name>.rom` (32 KB), Run
  boots it in openMSX; both on Linux and Windows.
- Broken C file: Problems shows file:line, click jumps to the line in Monaco,
  status bar count matches.
- WebMSX: Build & Run with WebMSX selected opens the browser and the ROM boots
  (manual check); artifact server refuses paths outside the artifact list.
- Kill during compile leaves no orphan `node`/`sdcc` processes.
