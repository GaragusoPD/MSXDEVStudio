# Demo project: a two-screen platformer

A small, complete MSX1 game built entirely with MSXStudio's own editors. Collect
all eight coins, then reach the door at the far right. Arrow keys move, SPACE
jumps.

![Title screen](../docs/images/demo-title.png)

![Gameplay](../docs/images/demo-gameplay.png)

Open `demo.msxproj` in MSXStudio and press **Run**. It builds to a 32 KB ROM
(about 10.8 KB used) and boots in openMSX or WebMSX.

## What it demonstrates

Every graphic and sound came from a resource editor and was exported to a C
header, which is the workflow described in [the resources
guide](../docs/resources.md):

| Resource | Editor | Exports | Used for |
|---|---|---|---|
| `tiles.tiles.json` | Tile editor | `g_Tiles_Patterns`, `g_Tiles_Colors` | 32 SCREEN 2 tiles: terrain, coins, scenery, and digits 0-9 for the HUD |
| `player.sprites.json` | Sprite editor | `g_Player_Patterns`, `g_Player_Colors` | One 16x16 sprite in mode 1, six frames: standing, four walk poses, jumping |
| `level.map.json` | Map editor | `g_Level_Background` | A 64x24 map, exactly two screens wide, one byte per cell |
| `sfx.sfx.json` | SFX editor | `g_Sfx` | An ayFX bank: coin (id 0), jump (id 1), win fanfare (id 2) |

The game code in `main.c` covers the techniques the
[tutorials](../docs/tutorials/) explain, in one place:

- **Tiles**, loaded into all three SCREEN 2 banks with `VDP_LoadPattern_GM2` and
  `VDP_LoadColor_GM2`.
- **Scrolling**, without the `scroll` module. The level is copied into RAM at
  startup, and the visible 32 columns of a 64 wide map are contiguous there, so
  each screen row is a single `VDP_WriteVRAM_16K`. The camera moves in whole
  tiles and only redraws when it actually changes, which on MSX1 is as smooth as
  the hardware gets (see below).
- **Collision**, read from the same RAM map the VDP is drawing, so there is no
  second copy of the level to keep in sync. Taking a coin writes sky into that
  map, which is also how the coins are counted at startup.
- **Sprites**, placed with `VDP_SetSpriteSM1`. The walk is a six step cycle
  (`g_WalkCycle` in `main.c`) rather than two poses flipping back and forth,
  which is the difference between a stride and a flicker.
- **Sound**, an ayFX bank played with `ayFX_PlayBank`, updated once per frame by
  `ayFX_Update()` and pushed to the chip with `PSG_Apply()`.
- **Text screens**, drawn in SCREEN 1 with MSXgl's `g_Font_MGL_Sample8`, so the
  title and ending do not have to share the pattern table with the game's tiles.
  The title is framed with `Print_DrawBox`, and the MSXgl logo is characters 1
  to 6 of any MSXgl font (`MSX_GL` in `main.c`).
- **Colour in SCREEN 1**, which stores one colour per group of eight pattern
  codes rather than per character. Loading the font at offset 0 makes a pattern
  code equal its character code, so whole classes can be recoloured:
  `ColorChars()` tints the box frame cyan, capitals yellow, digits green and the
  logo cyan, which is why SPACE and the coin count stand out in a sentence.

## Six things worth knowing

**Use the `_16K` VRAM calls on MSX1.** The four-argument `VDP_WriteVRAM(src,
destLow, destHigh, count)` form is meant for the 17-bit addressing MSX2 uses.
With `VDP_VRAM_ADDR_14`, which is what an MSX1 project gets, `g_ScreenLayoutHigh`
does not even exist, and the level silently failed to draw here until the code
called `VDP_WriteVRAM_16K(src, dest, count)` and `VDP_Poke_16K(value, dest)`
directly. It compiles cleanly either way, so this is worth knowing before you
lose an hour to it.

**ayFX needs configuring for standalone use.** `msxgl_config.h` sets
`AYFX_BUFFER` to `AYFX_BUFFER_DEFAULT`. The MSXgl samples use
`AYFX_BUFFER_PT3` because they play PT3 music alongside the effects, and with
that setting the sound goes into PT3's register buffer, which nothing here would
ever flush. `psg` and `ayfx/ayfx_player` both have to be in **LibModules**, and
`msxgl.h` does not include their headers for you.

**Ask the ground whether you are standing, not the movement.** Velocity here is
in 1/8th pixels, so at rest it takes four frames for gravity to add up to one
whole pixel of fall. Setting `g_OnGround` from "did a downward step get blocked
this frame" therefore reported airborne on three frames out of four, and the
sprite flickered into its jump pose while walking on flat ground. It looked like
an animation speed problem and was not: `ApplyGravity()` now derives the flag
from `BoxHitsSolid(x, y + 1)`, which is a question about the world rather than
about what happened this frame.

**The scroll steps a whole tile at a time, and on MSX1 that is the hardware.**
Compare it with MSXgl's own `s_scroll.c`, which glides a pixel at a time and
looks like it is doing the same job in the same screen mode. It is not. That
sample sets `Machine = "2"`, so it runs in `VDP_MODE_GRAPHIC3` (SCREEN 4), which
looks identical to SCREEN 2 but is an MSX2 mode. `Scroll_Update()` splits the
scroll position into a whole-tile part that redraws the name table, exactly as
this demo does, and a 0 to 7 pixel remainder that it hands to
`VDP_SetAdjustOffset()`. That writes VDP register R#18, which shifts the whole
display by a few pixels, and R#18 does not exist on MSX1's TMS9918. MSXgl says as
much in its own configs: `SCROLL_ADJUST` is `TRUE` for MSX2 and `FALSE` for MSX1.

So an MSX1 game scrolls in 8 pixel steps unless it rewrites tile pattern data
every frame, shifted one pixel at a time, which real games did but only for a
narrow band of tiles and at a cost that would bury the rest of this code. If you
want the smooth version, switch the project to MSX2 and drive R#18; tutorial 6
and `s_scroll.c` show how, including the sprite masking that hides the partial
column the shift exposes at the screen edge.

**Never draw the wrong thing and fix it afterwards.** The first version of this
demo blitted the screen straight out of the ROM level, which still contains the
collected coins, and painted them out again immediately after. A full screen is
768 bytes, far more than fits in the vertical blanking period, so the VDP was
displaying while the correction was still being written and collected coins
flashed back into view on every scroll. Editing the RAM map when the coin is
taken means the blit is right the first time.

**Silence is usually the desktop, not the game.** The demo plays a sound on
every coin, jump and win. If you hear nothing on Linux, check the system before
suspecting the code: the distributed openMSX builds can only use ALSA, and on a
PipeWire desktop ALSA has no working default device until `pipewire-alsa` is
installed (`sudo apt install pipewire-alsa`, then log out and back in). openMSX
gives no visible sign of this, it just runs silently. `speaker-test -t sine -l 1`
being silent too confirms it is the system. To check the game end instead, run
openMSX's debugger and watch the PSG: `debug read {PSG regs} 8` is the channel A
volume, and it should ramp down over the frames after a coin is collected.

## Credits and attribution

The demo carries its attribution in the game itself, which is what MSXStudio's
[license](../LICENSE) asks of anything built with it: a line on the title
screen, and a full credits screen after you win.

![Credits screen](../docs/images/demo-credits.png)

- **MSXStudio** by P.D. Garaguso, whose license asks to be credited in software
  made with it, in wording that does not imply endorsement.
- **MSXgl** and **MSXtk** by Guillaume "Aoineko" Blanchard, licensed
  [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), which also
  asks for attribution.
- **ayFX** sound format by Shiru.
- **SDCC**, the compiler, and **openMSX** / **WebMSX**, the emulators.

None of them endorse this demo, which the credits screen says out loud. Copy
this pattern in your own game: the title screen line takes five minutes and
satisfies both licenses.

## Changing it

Open any of the four `.json` resources from the Resources panel and edit it,
then press Run. Exports happen automatically as part of the build, and only for
files that changed.

The level is the easiest thing to play with: open `level.map.json`, paint with
the tile picker, and press Run. Coins need nothing else, because the game counts
them out of the map at startup and collects whatever coin tile the player walks
into, so painting one anywhere is enough. The HUD handles up to 99.
