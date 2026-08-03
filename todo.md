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

## Sprite composition and software sprites (planned)

Four related features. Each one wants the same two deliverables: **editor support in
the UI**, and **ready-made C** the IDE can drop into a project as a script/snippet, so
a user gets a working character without writing the VDP plumbing by hand.

Where this already starts: `src/shared/msx/sprite.ts` models a sprite as up to
`MAX_LAYERS` (4) `SpriteLayer`s per frame and already composites them for the mode-2
OR-color preview (`lineColorByte`), with `SpriteLayerPanel.vue` in the editor. So the
data model exists — what is missing is emitting the extra sprite planes and the
runtime code that drives them.

Listed in build order, which is not the order they were asked for: the multi-sprite
character shape constrains superposition, so it is designed first, and the software
sprite blitters are what the bitmap-mode work stands on.

- [ ] **1. Multi-sprite characters (Metal Gear style).** A character built from a grid
      of hardware sprites, side by side as well as stacked — 16x32 or 32x32 from two or
      four 16x16 sprites, each of which may itself be layered per the next item. Needs a
      "metasprite" concept above the current flat sprite list: cell offsets, a combined
      canvas in the editor, and emitted code that places the whole group from one
      coordinate. First because it is the item that most changes the sprite document
      shape — built after superposition, it would mean undoing a one-sprite-per-
      character assumption.
- [ ] **2. Superposition of sprites.** Stack several hardware sprites on the same
      coordinates to get a multi-color character. This is the only way to do it in
      sprite mode 1 (MSX1), where a sprite is a single color. Needs: the layer stack
      emitted as N sprite planes rather than one composite (`emitC.ts`), a plane→color
      assignment in the editor, and a runtime helper that writes N attribute entries
      from one x/y. Watch the 4-sprites-per-scanline limit — a 3-layer character costs
      3 of the 4, and a metasprite from item 1 multiplies that, so the editor should
      warn.
- [ ] **3. Software sprites and animation.** Characters drawn into the screen surface
      instead of the sprite attribute table, so there is no per-scanline limit. Needs
      background save/restore per object, a draw order, and dirty-rect redraw. On MSX2
      this can lean on the VDP blitter (HMMM/LMMM); on MSX1 it is CPU blits into the
      pattern table. Pre-made code matters most here — this is the item users are least
      likely to get right unaided.
- [ ] **4. Tiles and software sprites for bitmap modes.** Extend both to the bitmap
      modes already described in `src/shared/msx/modes.ts` (`BITMAP_MODES`: sc5, sc6,
      sc7, sc8, plus import-only sc10/12). Bitmap modes have no name table, so "tiles"
      there means stamping pattern blocks into the bitmap, and software sprites are the
      normal way to move things. Needs the tile and map editors to accept a bitmap
      target, and the blit helpers from item 3 in their MSX2 form.

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
