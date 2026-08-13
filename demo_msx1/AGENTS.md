# demo_msx1 — agent guide

A complete MSX1 platformer built with MSXDEVStudio's own editors: collect eight
coins, reach the door. SCREEN 2, 32 KB ROM, `demo.msxproj`.

`README.md` beside this file explains *why* everything is the way it is, at
length. This file is the short version an agent needs before touching anything.
When they disagree, the code wins and both should be fixed.

## Build and run

```sh
./build.sh all      # or build.bat on Windows — never call sdcc directly
./build.sh run      # builds, then launches the emulator
./build.sh rebuild  # after editing demo.h or msxgl_config.h (see below)
```

Or open `demo.msxproj` in MSXDEVStudio and press Run.

## Layout

| File | What it holds |
|---|---|
| `demo.h` | The shared vocabulary: tile indices, flags, physics constants, and which file owns which global |
| `level.c` | The level in RAM — `TileAt`, collision, the camera, the door |
| `view.c` | Everything that reaches the name table — the composed view, the HUD, the coin spin |
| `player.c` | Moving, falling, collecting, turning around |
| `screens.c` | The title picture and the text screens either side of the game |
| `main.c` | Setup, and the loop that drives the rest |

Each is a real module listed in **ProjModules**.

**Authored:** the `.c`/`.h` above, `msxgl_config.h`, `res/*.json`, `demo.msxproj`.
**Generated — never edit:** `content/*.c` and `content/*.h` (exported from `res/`
before every build), `project_config.js` (rewritten from `demo.msxproj`), `out/`,
`emul/`.

The exporter splits each resource in two — a header of `#define`s, `extern`s and
prototypes, and a `.c` holding the tables — which is what lets five modules
include `content/tiles.h` while only `content/tiles.c` defines the arrays.

## Resources

| File | Exports | Used for |
|---|---|---|
| `res/tiles.tiles.json` | `g_Tiles_Patterns/_Colors/_Flags/_Blocks` + `g_Tiles_DrawBlock()` | Terrain, coins, scenery, HUD digits, solidity flags, a 4×1 coin-spin block and a 1×2 open doorway |
| `res/player.sprites.json` | `g_PlayerSprites_Patterns/_Colors/_Layout` + `g_PlayerSprites_SetMeta()` | 16×16 character, mode 1, six poses, **three superposed planes** each |
| `res/level.map.json` | `g_LevelMap_Background` | 64×12 level, RLEp-compressed (768 cells → 86 bytes) |
| `res/background.map.json` | `g_BackgroundMap_Sky` | 32×24 backdrop pinned to the screen |
| `res/sfx.sfx.json` | `g_Sfx` | ayFX bank: coin (0), jump (1), win (2) |
| `res/intro.tiles.json` / `res/intro.map.json` | `g_IntroTiles`, `g_IntroMap` | The title screen's own 256-tile bank and picture |

Edit the `.json` in the IDE (or by hand — they are plain JSON), then build.
Exports run automatically and skip anything already up to date.

## The invariants — break these and it breaks quietly

**Use the `_16K` VRAM calls.** This is an MSX1 project, so `VDP_VRAM_ADDR_14` is
in force and `g_ScreenLayoutHigh` does not exist. The four-argument
`VDP_WriteVRAM(src, destLow, destHigh, count)` compiles cleanly and silently
writes nothing useful. Use `VDP_WriteVRAM_16K(src, dest, count)` and
`VDP_Poke_16K(value, dest)`.

**Collision reads flags, never tile numbers.** `g_Tiles_Flags[tile] & FLAG_SOLID`
(`FLAG_COIN 0x02`, `FLAG_EXIT 0x04`, `FLAG_TRANS 0x80`). No code may test
`tile == 3`; re-ordering the tileset is supposed to be safe.

**`g_Map` is the level, and it is RAM.** The compressed map is unpacked into it
at startup with `RLEp_UnpackToRAM`, and the game reads *and writes* it — taking
a coin writes the transparent tile there. Never blit from the ROM table; that
was a real bug (collected coins flashing back on scroll). Draw the right thing,
do not draw the wrong thing and correct it.

**The backdrop is a compose rule, not a layer.** SCREEN 2 has one name table.
A level cell carrying `FLAG_TRANS` is not drawn — `g_Back` at that screen
position is. Cost is ~95 µs per composed cell, so two cuts keep it affordable:
the level only occupies rows `LEVEL_TOP`..24 (above is backdrop, written once by
`DrawBackdropTop()` and never touched), and `g_RowHasTrans` skips composing for
rows with no transparent cell. Anything that widens either undoes the budget —
the README has the measured frame counts.

**Animate the pattern, not the map.** `SpinCoins()` copies one pose's 8 pattern
bytes over the coin tile's slot with `VDP_LoadPattern_GM2`, which writes all
three SCREEN 2 banks: 24 bytes turns *every* coin, on screen or not, HUD
included. Re-pointing cells would cost a name-table write per coin per step.

**SCREEN 2 has three colour tables, one per third of the screen.** The same
pattern can look different depending on where it sits. `InitGame()` exploits
this to recolour pattern 6's top-third entry for the HUD coin without touching
the ones in play.

**Sprite planes: line art first.** Mode 1 gives one colour per sprite, so a
three-colour character is three superposed hardware sprites placed by
`g_PlayerSprites_SetMeta()`. Plane 0 is the black line art and the colour planes
sit behind it, because the lower plane number wins on overlap; each colour plane
carries the whole silhouette so nothing shows through if they land a pixel
apart. Facing left is `SpriteFX_FlipHorizontal16()` writing back into the *same*
pattern slots — needs `sprite_fx` in LibModules and `SPRITEFX_USE_16x16` /
`SPRITEFX_USE_FLIP` in `msxgl_config.h`.

**`g_OnGround` asks the world, not the frame.** Velocity is in 1/8th pixels, so
"was a downward step blocked this frame" reads airborne three frames in four.
`ApplyGravity()` uses `BoxHitsSolid(x, y + 1)`.

**LibModules: `keyboard`, not `input`.** MSXgl's `input.c` ends with
`#include "keyboard.c"`, so listing both compiles it twice — a duplicate-symbol
*warning* that still links, and costs 149 bytes of ROM.

**ayFX needs `AYFX_BUFFER_DEFAULT`.** The MSXgl samples use `AYFX_BUFFER_PT3`
because they also play PT3; with that setting sound goes into a buffer nothing
here flushes. `psg` and `ayfx/ayfx_player` both go in LibModules, and `msxgl.h`
does not include their headers for you.

**Editing a header does not trigger a recompile from the command line.** MSXgl's
`CompileSkipOld` compares source mtimes only. After touching `demo.h` or
`msxgl_config.h`, run `./build.sh rebuild`. (The IDE guards this itself.)

## Scope

Scrolling steps a whole tile at a time because MSX1's TMS9918 has no R#18 —
that is the hardware, not a shortcut. Smooth scrolling means switching the
project to MSX2; see `docs/tutorials/06-scrolling.md`.

The artwork and code are the author's own (© 2026 Pablo D. Garaguso) and are
meant to be built on. Keep the title-screen and credits attribution intact when
modifying the demo itself — MSXDEVStudio's and MSXgl's licenses both ask for it.
