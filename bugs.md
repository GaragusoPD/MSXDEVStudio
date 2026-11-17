# MSXDEVStudio: missing options and bugs found in Ancient Horrors

Found on 2026-11-16 while adding animation to sprites and meta-tiles, and moving the foes to
meta-tiles. Each entry gives what happened, how to reproduce it, what was expected, and the
workaround this project uses until the IDE is fixed.

The core issue: animation data drawn in the editors does not reach the export in a form game code
can use. For sprites, the export does not say where each character's frames are. For meta-tiles,
the poses are exported only through a per-meta export block that new meta-tiles do not have, and
not in a form a custom loader can use. Entries 1-6 are that; 7-9 are other problems found on the way.

---

## 1. Sprite export: nothing says where a character's frames start or how many there are

- **What happened:** `res/cursors.sprites.json` holds five 1x1 single-layer characters (arrow,
  down, marker, flash, here). Giving the arrow 4 frames exported 8 patterns and 8 colours in a row,
  and nothing else. `content/cursors_sprites.h` has only `G_CURSORSSPRITES_PATTERNS_SIZE` and
  `G_CURSORSSPRITES_COLORS_SIZE`.
- **Effect:** the game numbered characters by position (`shape * 4`). After the arrow grew to 4
  frames, every later character showed arrow frames: no warning, no build error.
- **Repro:** a sprite sheet of several 1x1 characters; add frames to the first one; export. The
  header does not change, apart from the two sizes.
- **Also with *Export ready-made C* on (`"helpers": true`):** the header is identical. RTS1 and
  sc2Tests also list their frames by hand in C (`Pawn_Frame`).
- **CLAUDE.md says** multi-cell or multi-layer characters get `_BASE` / `_PLANES` / `_FRAMES`.
  Single-cell, single-layer characters get nothing.
- **Expected:** for every character, whatever its cells and layers:

  ```c
  #define G_CURSORSSPRITES_ARROW_PATTERN  0   // first pattern number as the VDP takes it (x4 in 16x16)
  #define G_CURSORSSPRITES_ARROW_FRAMES   4
  #define G_CURSORSSPRITES_DOWN_PATTERN   16
  #define G_CURSORSSPRITES_DOWN_FRAMES    1
  ```

  Also say in the header that `_Colors` holds one byte per frame, in the same order.
- **Workaround here:** `SPR_FRAMES_*` in `src/gfx.c` mirror the sheet by hand.
  - A `#error` fires when their total differs from `G_CURSORSSPRITES_COLORS_SIZE`.
  - `tools/smoke16k.py` compares names, order and counts with the JSON.

## 2. Sprite animation speed is not saved

- **What happened:** the sprite editor previews the arrow at 6 fps, but `.sprites.json` stores no
  speed. A character only has `name`, `cols`, `rows`, `layers`, `frames`, and a frame only has
  `layers`.
- **Expected:**
  - A speed saved per character, or better a duration per frame in VBlanks, like meta-tile poses
    (`"duration": 8`).
  - Exported as `_FPS` or a `_Durations` table.
  - One unit for sprites and meta-tiles: meta-tiles use VBlanks.
- **Workaround here:** `SPR_FPS 6` in `src/gfx.c`. That is 8 VBlanks per frame at 50 Hz and 10 at
  60 Hz, the same for every sprite.

## 3. No sprite animation helper exists

- **What happened:** even with *Export ready-made C* on, there is no helper to show frame `f` of a
  character on a plane, or to step it.
- **Expected:** with item 1 in place, the data alone is enough. A small helper would still help,
  e.g. `g_X_SetFrame(plane, char, frame)` (pattern and colour), or `g_X_Animate(plane, char)` that
  keeps the frame and timer per plane.
- **Workaround here:** `Gfx_Sprite` / `Gfx_Animate` in `src/gfx.c` (about 200 bytes).

## 4. Meta-tile poses are exported only by the meta's own export block, which new meta-tiles lack

- **What happened:** these meta-tiles here have `"export": null`: the four bosses, the 11 portraits
  and the 13 items. The user gave the compass item 2 poses in the pose editor. Nothing about them
  reaches the export:
  - `content/items_tiles.h` gets a window for it;
  - the pose tables (`_Patterns`, `_Colors`, `_Durations` of the moving tiles) come only from the
    meta's own export, and it has none.

  The second pose is silently lost.
- **Repro:** a meta-tile with `"export": null`, attached to a tileset; add a pose; export everything.
- **Expected:** any of these:
  - (a) a default export target for every meta-tile;
  - (b) the attached tileset's export carries each attached meta's pose tables (it already carries
    the window);
  - (c) a problem reported: "compass has 2 poses but no export target: its poses are not exported".
- **Workaround here:** the three foes (`res/foes/`) were given export blocks by hand, and their
  `.c` files are included in segment 30 (`seg/pic_s30_b1.c`). The compass is not animated yet.

## 5. The tileset's animation defines miss the window length; the meta's export misses which cells move

- **What happened:** the tileset header has `_ANIM_<NAME>_SLOT` (the window's first tile) and
  `_ANIM_<NAME>_FRAMES`, but not how many tiles the window holds.
  - That count, `G_<META>_MOVING`, is only in the meta's own header (item 4).
  - The meta's `_Patterns` holds the moving tiles "in reading order", but no table says which cells
    they are.
- **Effect:** a game that draws a meta-tile with its own code must diff the poses to find which
  cells move. Portraits and items here are drawn that way (`Gfx_Portrait` / `Gfx_Item` copy cell
  `i` to VRAM slot `slot + i`).
- **Expected:**
  - `#define G_<TILESET>_ANIM_<NAME>_TILES n` in the tileset header.
  - `const u8 g_<Meta>_MovingCells[]` (cell indices, reading order) in the meta's export.

## 6. The generated `_Animate()` assumes the tileset is in VRAM at its own tile numbers, and its tables in memory

- **What happened:** this game keeps every picture, portrait and icon in MegaROM segments, read
  through a pager. It loads each third of the screen with only the tiles that third uses, so tile
  number 49 of a tileset lands in some other VRAM slot. `_Animate()` writes VRAM at the tileset's
  own numbers and reads its pose tables directly, so it cannot be used here. *Export ready-made C*
  does not help.
- **Expected:** with items 4 and 5, the data is enough to animate from game code. Maybe also an
  `_Animate` variant that takes a tile-to-slot table and a read function.
- **Workaround here:** `Gfx_Animate` in `src/gfx.c` (about 560 bytes with its tables). It learns where
  each third put the window tiles and copies poses from segment 30.

## 7. A placement written into a map by hand reads as "not attached" until its `metas` entry is filled in

- **What happened:** `write_resource` on a map whose `metas` entry had only `path` and `name`:
  - the normalisation filled `width: 1, height: 1, frames: 1` and no `cells`;
  - `read_resource` then reported `"ghoul" (res/foes/ghoul.meta-tiles.json) is not attached to
    res/pics/fight_alley.tiles.json — attach it in the tile editor, or place it again from the
    map editor`;
  - the IDE's preview and map editor did not draw the placement.

  Yet the tileset listed the meta (the same `name: ""` 1x1 stub the bosses' tilesets have), and a
  forced `export_resources` of the tileset and the map exported the placement and the window
  correctly.
- **Fixed by:** writing the entry the way the map editor does: real `width`, `height`, `frames`,
  `flags`, and `cells` copied from the exported `_MetaCells`.
- **Expected:** the map's `metas` entry is derived data. The normaliser should resolve it from the
  meta file and the tileset, as the export does, so the attachment check, the preview and the
  export agree.

## 8. The IDE treats any `.json` in the project tree as a resource, even in hidden or gitignored folders

- **What happened:** for a before-and-after comparison, copies of `res/pics/fight_*.map.json` and
  `.tiles.json` were saved in `.scratch/head/`, a gitignored folder.
  - The IDE listed them as resources (`list_resources`) and exported them at every Build.
  - Their `export.out` was the same as the real files', so the old fight pictures silently
    overwrote the real `content/pic_fight_*` files.
  - The game built without the foes, and no problem was reported.
- **Repro:** copy any resource JSON into a subfolder of the project; Build; the copy is exported
  over the original's header.
- **Expected:**
  - Look for resources in `res/` only, or skip dot folders and honour `.gitignore`.
  - Report an error when two resources export to the same `out` file.
- **Workaround here:** keep scratch copies with another extension (`.json.txt`). CLAUDE.md warns
  about it.

## 9. (Minor) `read_resource` and the export disagree about attachment

Part of 7: in the same state, the attachment check said "not attached" while a forced export
attached and exported the meta-tile. Whichever is right, they should agree, and the check should
name the field that is missing.

---

### Checked and not a bug

**Changed art in a segment-included `content/*.c` reaches the ROM.** MSXgl's `CompileSkipOld`
compares only each `.c` with its `.rel`, so a picture's `seg/pic_sN_b1.c`, which `#include`s the
exported `content/*.c`, is skipped when only the included file changes. Editing a `content/*.c` by
hand showed that, but a real change through the IDE's export did trigger the recompile. The guard
covers the IDE's own exports. It would not cover a file changed by anything else, such as a
pre-build script.
