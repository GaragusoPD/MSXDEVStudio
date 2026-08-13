# demo_msx2 — agent guide

*Canyon Runner*: a SCREEN 5 vertical shooter in a 128 KB ASCII-8 MegaROM, built
with MSXDEVStudio's own editors. `canyon.msxproj`.

`README.md` beside this file explains *why* everything is the way it is, at
length — read it before changing the scroll, the split screen or the VRAM map.
This file is the short version. When they disagree, the code wins and both
should be fixed.

## Build and run

```sh
./build.sh all      # or build.bat on Windows — never call sdcc directly
./build.sh run      # builds, then launches the emulator
./build.sh rebuild  # after editing canyon.h or msxgl_config.h (see below)
```

Or open `canyon.msxproj` in MSXDEVStudio and press Run.

## Layout

| File | What it holds |
|---|---|
| `canyon.h` | The shared vocabulary: geometry, the VRAM map, sprite plane allocation, atlas cell ranges |
| `main.c` | Setup, the two interrupt handlers, the state machine, the frame loop |
| `scroll.c` | The parallax: R#23, the mist, the palette cycle, world↔screen conversion |
| `player.c` | The ship, its shots, energy, the grace period |
| `enemy.c` | The drones |
| `bossfight.c` | The boss |
| `screens.c` | Title and credits pictures, read straight out of ROM segments |

**Authored:** the above, `msxgl_config.h`, `res/*.json`, `datasrc/*.mjs`,
`canyon.msxproj`.
**Generated — never edit:** `content/*.c` and `content/*.h`, `data/*.bin`,
`canyon_rawdef.h` (MSXgl writes it: each raw blob's segment and size),
`project_config.js`, `out/`, `emul/`.

## Resources

| File | Exports | Used for |
|---|---|---|
| `res/canyon.btiles.json` | `data/atlas.bin` | 48 cells of 16×16 — the canyon's tileset, in a mode that has no tileset |
| `res/stage.map.json` | `g_Stage_Terrain` + `g_Stage_DrawRow()` | 16 × 160 cells of canyon, drawn a row at a time |
| `res/fleet.sprites.json` | `g_Fleet_Patterns/_Colors/_Palette/_Layout` + `g_Fleet_SetMeta()` | Ship (two planes, sprite mode 2), shots, drones |
| `res/mist.screen.json` | `g_Mist_Strip/_Rects` + `_Upload/_Restore/_Draw` | Three wisps of mist — the parallax layer, as software sprites |
| `res/boss.screen.json` | `g_Boss_Strip/_Rects` + `_Upload/_Restore/_Draw` | A 68×40 boss, too wide to be sprites |
| `res/hud.screen.json` | `g_Hud_Strip/_Rects` | The status band's artwork |
| `res/sfx.sfx.json` | `g_Sfx` | ayFX bank: shot, boom, crash, hit, victory |
| `res/title.screen.json`, `res/credits.screen.json` | `data/title.bin`, `data/credits.bin` | Full SCREEN 5 pictures, paged in from ROM |

`datasrc/make-art.mjs` draws the source PNGs from code and `make-data.mjs`
writes the map, sprite sheet and sound bank in the editors' formats. They are a
first-draft generator, not a parallel pipeline: every file they write opens in
the matching editor. `.screen.json` files are the exception — they cache a
conversion and come from importing a PNG in the screen editor with the palette
locked to `datasrc/palette.mjs`.

**The palette is locked, not optimised.** SCREEN 5 has one palette and the
sprites share it — a mode-2 sprite's per-line colour byte indexes the same
sixteen entries the canyon is drawn from. Change `datasrc/palette.mjs` and
everything changes.

## The invariants — break these and it breaks quietly

**R#23 scrolls the sprites too.** The sprite Y is compared against the same
offset line counter, so every sprite Y goes through `Scroll_SpriteY()`. And
`VDP_HideSprite` writes a fixed Y of 213, which is only off-screen when the
display is not offset — use `Scroll_HideSprite()` or a dead drone gets dragged
back into view forever.

**`VRAM_SPRITE_ATTR` must be a 1 KB boundary + 0x200.** The VDP masks R#5/R#11
to 1 KB, puts the sprite *colour* table there and the *attribute* table 0x200
above. A plausible-looking +0x380 puts MSXgl's writes 0x180 bytes from where the
VDP reads, nothing complains, and no sprite is ever drawn again. The tables also
have to leave page 0 entirely, or the scroll eventually walks them into view.

**Page 0 is a 256-line ring and all of it is used.** R#23 wraps at 256 and
nothing opts out. The scroll is not a redraw: the map is fed in a row at a time
and the display walks round it. So there is no spare strip to keep anything in —
anything that must hold still is a sprite or lives on another page. The command
engine does not wrap at row 0 either, which is why the status band is not
composited but lives on page 1.

**The split screen is for the status band, not parallax.** Two-speed parallax
off one page reads as a tear. The frame *starts* on the band (page 1, no offset,
**sprites off** — one bit in R#8, or ships get drawn across the status bar), and
the H-blank handler hands the rest of the screen to page 0. R#2 must be switched
back every frame. `HUD_SPLIT_LEAD` / `HUD_SPLIT_DELAY` compensate for the
interrupt firing late, and it has to be late by the *same* amount every frame —
which is why the band is at the top and why the loop waits on `halt`:

```c
while(g_VBlank == 0) { __asm halt __endasm; }
while(g_BandOn && g_Split == 0) { __asm halt __endasm; }
// only now does the frame's blitting begin
```

A polling loop instead of `halt` is tens of dots of jitter on its own.

**MSXgl's `scroll` module does not apply here, and that is not an oversight.**
It is a name-table scroller: `scroll.c` writes tile indices with
`VDP_WriteVRAM_16K` into `g_ScreenLayoutLow` and smooths with R#18
(`VDP_SetAdjustOffset`). It never touches R#23, and its 14-bit VRAM writes
cannot even reach a SCREEN 5 page. There is no bitmap-mode path in it and no
bitmap scrolling sample in MSXgl.

The right reference is `projects/samples/s_gm3.c`, and this demo already follows
it: R#23 through `VDP_SetVerticalOffset`, the same sprite-Y compensation down to
stepping over 216, and the same `VDP_SetHBlankLine`/`VDP_EnableHBlank` split.
What `scroll.c` adds on top is what MSXgl has no module for — feeding map rows
into the 256-line ring, the two-offset scheme below, disarming H-blank after the
split, and `Scroll_HideSprite`. Do not "replace this with the engine's scroller".

**MSXgl's `tile` module, unlike `scroll`, genuinely does apply here** — it is a
bitmap-mode tile engine for SCREEN 5–8 (`Tile_LoadBank`, `Tile_DrawTile`,
`Tile_DrawMapChunk`, `Tile_DrawScreen`; sample `s_swtile.c`), and its
`g_Tile_DrawPage * 256 + y * TILE_HEIGHT` addressing would reach this ring's
rows. It is still not the right trade here, for two reasons:

- It blits with `LMMM + VDP_OP_TIMP`, a per-pixel logical move. The generated
  `g_Stage_DrawRow()` uses `HMMM`, the byte-wise high-speed move, which is what
  an opaque canyon cell wants — and the per-frame blit budget in `Scroll_Mist()`
  assumes the cheaper one.
- Its geometry is compile-time `#define`s in `msxgl_config.h`
  (`TILE_WIDTH/HEIGHT/BPP/SCREEN_WIDTH`), so it would have to be kept in sync by
  hand with what the atlas resource already knows.

Its `TILE_USE_SKIP` / `TILE_SKIP_INDEX` idea was worth taking, and the map
editor now has it: set a **transparent cell** on a bitmap map and the export
adds `_DrawRowOver()` beside `_DrawRow()`, skipping that index instead of
blitting it. `stage.map.json` has one layer and does not set one, so nothing
here changed — reach for it if the canyon ever grows a foreground layer.

**Two scroll offsets, not one.** `g_MainOffset` is what the logic computed for
the *next* frame and the V-blank handler installs it; `g_ShownOffset` is what is
actually in R#23 and is what every sprite and composited position is measured
against. Measuring against the next frame's value puts things a pixel out for
the rest of the current frame, appearing and disappearing — it reads as
everything trembling. Registers only move inside the blanking.

**Software sprites are restore-then-draw.** `_Upload` once at startup, then
`_Restore` the saved background before moving and `_Draw` at the new position.
Each object owns its own `_SwSprite` struct — that is where the background
lives. Budget by bytes: a VDP blit is ~1.5 µs/byte with the display on, so a
48×16 wisp is ~1.2 KB of traffic per move. A 64×24 one did not fit.

**A generated module and a hand-written one cannot share a basename.** The
exporter writes `content/boss.c` and adds it to ProjModules; MSXgl compiles
every module to `out/<basename>.rel`. A hand-written `boss.c` would silently
overwrite it and the link fails with *Multiple definition of* something you
never wrote twice. That is why the boss's chapter is `bossfight.c`.

**Editing a header does not trigger a recompile from the command line.**
`CompileSkipOld` compares source mtimes only. After touching `canyon.h` or
`msxgl_config.h`, run `./build.sh rebuild`. (The IDE guards this itself with a
stamp file and a header sweep — `needsFullRebuild()`.)

**The MegaROM's raw blobs are placed by absolute offset** in `canyon.msxproj`, so
each picture's bitmap starts exactly on an 8 KB segment boundary (a SCREEN 5 line
is 128 bytes = 64 lines per segment, so no line straddles two). Paging uses
**bank 3** (0xA000), which holds only padding — bank 2 would be a gamble on the
linker's layout. Derive segments from `canyon_rawdef.h`, never a magic number.

## Scope

This demo is about what the V9938 adds over MSX1: programmable palette, R#23,
sprite mode 2, the command engine, line interrupts, MegaROM paging. If a change
would work equally well on an MSX1, it probably belongs in `demo_msx1`.

The artwork and code are the author's own (© 2026 Pablo D. Garaguso) and are
meant to be built on. Keep the title-screen and credits attribution intact when
modifying the demo itself — MSXDEVStudio's and MSXgl's licenses both ask for it.
