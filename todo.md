# MSXStudio — Next Steps

## Verify now (manual — nothing here was verifiable headless)

- [ ] **Boot a ROM in openMSX**: install openMSX (`sudo apt install openmsx`), run the app
      (`npm run dev` or `dist/msxstudio-0.1.0.AppImage`), Settings → point at an MSXgl
      checkout (or Download), New Project, press **F5**.
- [ ] Turbo R / real-BIOS machines: set the openMSX machine override in Project Settings
      (C-BIOS has no turbo R) and confirm the friendly exit-500 hint appears without it.
- [ ] **WebMSX**: switch the run target, confirm the ROM boots in the browser.
- [ ] **Editors visual pass**: tile conflict popover, sprite OR-color preview + animation,
      map stamps + flags painting, screen import/retouch, git panel flow.
- [ ] **SFX audition**: play the 5 presets (laser/jump/explosion/pickup/hit) — do they
      sound right? 50 Hz playback smooth?
- [ ] Try-it on a few samples (`s_scroll`, `s_arkos`) from the Examples panel.
- [ ] Install and test the `.deb` on a real machine (file association: double-click a
      `.msxproj`).

## When creating the GitHub repo

- [ ] Fix `homepage` in `package.json` (currently a guessed URL — needed by the .deb builder).
- [ ] Push, then tag `v0.1.0` → `release.yml` builds Linux + **Windows NSIS/portable**
      (not buildable locally, no wine) and drafts a release with all artifacts.
- [ ] Verify `ci.yml` (check + 486 tests) goes green on the runner.
- [ ] Windows manual pass: NSIS install → toolchain setup → build → run loop.

## Known gaps (documented, deliberate)

- No code signing (add when certificates exist) · no auto-update (manual downloads).
- Audio conversion for Arkos/Trilo/pcmenc is Windows-only upstream (MSXgl ships .exe
  only) — Linux users need wine for those; ayFX/VGM/lVGM paths are cross-platform.
- MSXgl is CC BY-SA 4.0 — surfaced in README; games built with it inherit the terms.

## Deferred features (add when wanted, specs/00-overview.md)

- msxgl_config.h settings UI (currently edited as C in Monaco)
- Code intelligence beyond Monaco defaults (MSXgl header-aware completion)
- Bundled/offline WebMSX · real-hardware flashing UI (RunDevice) · V9990 tooling
- Music tracker integration beyond file import (external trackers cover it)
- macOS packaging

## Small debt (marked `ponytail:` in code — harvest with /ponytail-debt)

- Three editors now carry near-identical undo-stack code → hoist a generic `History<T>`.
- Tile editor: tile delete + mode conversion not implemented (needs the same remap seam
  as reorder).
- Monaco import shim is generated — re-run `npm run monaco:shim` after monaco upgrades.
- Screen retouch stores flat pixel triples (size ceiling documented in code).
