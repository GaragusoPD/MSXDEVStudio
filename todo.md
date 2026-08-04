# MSXStudio — Next Steps

## Verify now (manual — nothing here was verifiable headless)

- [x] **Boot a ROM in openMSX**: openMSX 21.0 lives at
      `~/Development/openMSX/openmsx-21.0-linux-x86_64-bin` and needs
      `OPENMSX_SYSTEM_DATA=<that>/share` — the relocatable-tarball case the build
      service already handles. Original note: install openMSX, run the app
      (`npm run dev` or `dist/msxstudio-0.1.0.AppImage`), Settings → point at an MSXgl
      checkout (or Download), New Project, press **F5**.
- [ ] Turbo R / real-BIOS machines: set the openMSX machine override in Project Settings
      (C-BIOS has no turbo R) and confirm the friendly exit-500 hint appears without it.
- [ ] **WebMSX**: switch the run target, confirm the ROM boots in the browser.
- [ ] **Editors visual pass**: tile conflict popover, sprite OR-color preview + animation,
      map stamps + flags painting, screen import/retouch, git panel flow.
- [ ] **Metasprites (dev14)**: set a character to 2×2 in the sprite panel, paint each
      cell, check the canvas outline follows the selected cell and that the list,
      filmstrip and playback preview all show the whole character.
- [ ] **Tile blocks (dev14)**: make a 2×2 block in the tile editor, draw across a seam,
      check the stroke lands on both tiles and that undo takes the whole stroke back.
- [ ] **Fragments (dev14)**: in the screen editor, pick ⛶ and drag a rectangle on the
      converted image; check the overlay boxes and that the export writes a `_Strip`.
- [x] **Ready-made C on an emulator**: all three generated helpers were built into ROMs
      and booted in openMSX 21.0 (C-BIOS_MSX2_EU) — `_SetMeta` placed a 2×2 metasprite
      as one character, `_DrawBlock` stamped a 3×2 block into the name table, and the
      software sprite crossed a striped background leaving no trail. Not yet run on
      *real* hardware.
- [ ] **SFX audition**: play the 5 presets (laser/jump/explosion/pickup/hit) — do they
      sound right? 50 Hz playback smooth?
- [ ] Try-it on a few samples (`s_scroll`, `s_arkos`) from the Examples panel.
- [ ] Install and test the `.deb` on a real machine (file association: double-click a
      `.msxproj`).

## When creating the GitHub repo

Repo created 2026-08-03 at https://github.com/GaragusoPD/MSXStudio, **private for now** —
make it public when the work in progress is ready to show.

- [x] Fix `homepage` in `package.json` (was a guessed URL — needed by the .deb builder).
- [ ] Tag `v0.1.0` → `release.yml` builds Linux + **Windows NSIS/portable**
      (not buildable locally, no wine) and drafts a release with all artifacts.
- [ ] Verify `ci.yml` (check + 486 tests) goes green on the runner. Note that Actions
      minutes on a private repo are metered, unlike a public one.
- [ ] Windows manual pass: NSIS install → toolchain setup → build → run loop.
- [ ] Before going public: re-read `LICENSE` and the README license section, and decide
      whether the source-available terms are still what you want with an audience.

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

- [x] **1. Multi-sprite characters (Metal Gear style).** A character built from a grid
      of hardware sprites, side by side as well as stacked — 16x32 or 32x32 from two or
      four 16x16 sprites, each of which may itself be layered per the next item.
      *Done (dev14):* `SpriteCharacter` carries a `cols`/`rows` grid and every
      `SpriteLayer` its `cx`/`cy` cell, so the composite, canvas, thumbnails and
      filmstrip all work in character space; `MAX_LAYERS` is now the stack per cell.
      Export adds a `_Layout` table (dx, dy per plane) plus per-character
      `BASE`/`PLANES`/`FRAMES` defines, and an opt-in `_SetMeta()` places the whole
      group from one coordinate. **Still to check by hand: the editor UI in the app.**
- [x] **2. Superposition of sprites.** Stack several hardware sprites on the same
      coordinates to get a multi-color character — the only way to do it in sprite
      mode 1 (MSX1), where a sprite is a single color. *Done (dev14):* item 1 already
      emitted the planes and the runtime that writes N attribute entries from one x/y;
      this widened the `_Layout` table, the per-character defines and `_SetMeta` from
      "spans cells" to "takes more than one hardware sprite", so a stacked character
      exports the same way. The plane→color assignment was already the layer panel's
      mode-1 color picker / mode-2 line colors. Each character now carries its own
      cost badge (`characterPlaneCost` = the busiest cell row) next to the sheet-wide
      scanline hint, so a 3-layer character visibly spends 3 of mode 1's 4.
- [x] **3. Software sprites and animation (MSX2).** Characters drawn into the screen
      surface instead of the sprite attribute table, so there is no per-scanline limit.
      *Done (dev14):* MSXgl ships no software-sprite module — only the `s_swsprt`
      sample — so the export carries the runtime: frames laid side by side in one
      strip (`fragmentStrip`), uploaded once with `HMMC`, then per object restore the
      old background, save the new one, blit with `LMMM`/`VDP_OP_TIMP`. The saved
      rectangle *is* the dirty rect. Two things one sample sprite never had to face
      are handled: a per-object backup column, and the reverse-order restore rule for
      overlapping objects, which is the draw order.
      **Not done: the MSX1 path** (CPU blits into the pattern table). Pixel-precise
      MSX1 software sprites need a pattern-shifting blitter neither MSXgl nor this
      code has — `sprite_fx` only shifts 1-bit *hardware* sprite patterns.
      Tile-aligned MSX1 animation is already covered by item 4's blocks: point a
      block at different tiles and re-stamp it.
- [x] **4. Multi-tile designs, in tiled and bitmap modes.** The tile-side counterpart of
      the metasprite in item 1: draw an object bigger than one tile as **one canvas**,
      not as N separate 8x8 cells the user has to mentally assemble. *Done (dev14):*
      - *Tiled modes* — a `TilesDoc` carries named `blocks`, each `width × height`
        references into the same tile bank. A block owns no pixels, so painting one
        paints its tiles and the existing per-tile constraint engine still governs
        every pixel; the canvas works in block space and splits each stroke back per
        tile. `TileBlock` is structurally `map-editor.ts`'s `Stamp`, so it can be
        handed to `applyStamp` unchanged. sc1 blocks start on a `SC1_GROUP` boundary
        and the panel names the tiles a block still has to share colour with.
      - *Bitmap modes* — a `ScreenDoc` carries named `fragments`: rectangles of the
        converted image, cut with a drag on the canvas. Same "holds no pixels" trick,
        so retouching the image updates every fragment over it.
      - The opt-in **Export ready-made C** checkbox is on all three editors:
        `_DrawBlock` (name table, via MSXgl's `VDP_WriteLayout_GM2`), `_SetMeta`
        (sprite groups), and the software-sprite runtime for fragments. Every emitted
        variant was compiled against a real MSXgl + SDCC into a ROM.

      **Not done:** the map editor still targets tiled modes only. Composing a whole
      bitmap screen out of fragments would be a bitmap map editor — the fragments and
      the stamping runtime it would need already exist, so it is additive.

## Deferred features (add when wanted, specs/00-overview.md)

- msxgl_config.h settings UI (currently edited as C in Monaco)
- Code intelligence beyond Monaco defaults (MSXgl header-aware completion)
- Bundled/offline WebMSX · real-hardware flashing UI (RunDevice) · V9990 tooling
- Music tracker integration beyond file import (external trackers cover it)
- macOS packaging

## Small debt (marked `ponytail:` in code — harvest with /ponytail-debt)

- ~~Three editors carry near-identical undo-stack code~~ — hoisted into
  `src/shared/history.ts` as `History<T>` (dev14). The tile editor keeps its own: its
  entries carry a label and a tile-renumbering map.
- ~~Tile editor: tile delete + mode conversion~~ — both landed (dev14). Delete publishes
  a remap on the same seam as reorder; conversion warns before collapsing per-row
  colours onto sc1's per-group pair. Fixed alongside: `reorderTiles` was leaving
  `flags` behind, so re-arranging a tileset handed a tile's gameplay bits to whatever
  slid into its slot — exactly what flags exist to prevent.
- Monaco import shim is generated — re-run `npm run monaco:shim` after monaco upgrades.
- Screen retouch stores flat pixel triples (size ceiling documented in code).
