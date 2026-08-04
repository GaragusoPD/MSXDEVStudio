# Demo project: a two-screen platformer

A small, complete MSX1 game built entirely with MSXStudio's own editors. Collect
all eight coins, then reach the door at the far right. Arrow keys move, SPACE
jumps.

![Title screen](../docs/images/demo-title.png)

![Gameplay](../docs/images/demo-gameplay.png)

Open `demo.msxproj` in MSXStudio and press **Run**. It builds to a 32 KB ROM
(about 14.4 KB used) and boots in openMSX or WebMSX.

## What it demonstrates

Every graphic and sound came from a resource editor and was exported to a C
header, which is the workflow described in [the resources
guide](../docs/resources.md):

| Resource | Editor | Exports | Used for |
|---|---|---|---|
| `tiles.tiles.json` | Tile editor | `g_Tiles_Patterns`, `g_Tiles_Colors`, `g_Tiles_Flags`, `g_Tiles_Blocks` + `g_Tiles_DrawBlock()` | SCREEN 2 tiles: terrain, coins, scenery, digits 0-9 for the HUD, the flags that say which are solid, and two **blocks** — a 4x1 coin-spin strip and a 1x2 open doorway |
| `player.sprites.json` | Sprite editor | `g_Player_Patterns`, `g_Player_Colors`, `g_Player_Layout` + `g_Player_SetMeta()` | A 16x16 dragon in mode 1, six poses, each drawn by **two superposed planes**: one flat green body, one black line art in front of it. Mirrored at run time to face left |
| `level.map.json` | Map editor | `g_Level_Background` | A 64x12 map, two screens wide and half a screen tall — the bottom half, where the level actually is. One byte per cell, **RLEp-compressed**: 768 cells in 86 bytes |
| `background.map.json` | Map editor | `g_Backdrop_Sky` | A 32x24 backdrop — one screen, pinned to the screen, drawn behind the level wherever a tile is flagged transparent. 768 cells in 127 bytes |
| `sfx.sfx.json` | SFX editor | `g_Sfx` | An ayFX bank: coin (id 0), jump (id 1), win fanfare (id 2) |

The game code in `main.c` covers the techniques the
[tutorials](../docs/tutorials/) explain, in one place:

- **Tiles**, loaded into all three SCREEN 2 banks with `VDP_LoadPattern_GM2` and
  `VDP_LoadColor_GM2`.
- **Scrolling**, without the `scroll` module. The level is unpacked into RAM at
  startup, and the visible 32 columns of a 64 wide map are contiguous there, so
  each screen row is a single `VDP_WriteVRAM_16K`. The camera moves in whole
  tiles and only redraws when it actually changes, which on MSX1 is as smooth as
  the hardware gets (see below).
- **Collision from tile flags**, not from a list of tile numbers in the code.
  The tile editor's eight flag squares mark a tile solid, collectable or an
  exit, and `main.c` only ever asks `g_Tiles_Flags[tile] & FLAG_SOLID`. Re-order
  the tileset or add a new solid tile and the game keeps working, because
  nothing in it knows that grass happens to be tile 3.
- **A level in RAM**, read from the same array the VDP is drawing, so there is
  no second copy to keep in sync. Taking a coin writes the transparent tile into
  that map, which is also how the coins are counted at startup.
- **A compressed level**, which the RAM copy above makes free. The map editor's
  *Compress (RLEp)* packs 768 cells into 86 bytes of ROM, and startup unpacks
  them into `g_Map` with MSXgl's own `RLEp_UnpackToRAM` — the same one line the
  `Mem_Copy` used to be. Net saving after the unpacker is linked in: about a kilobyte.
  Compression is worth having exactly when the data was going to be copied to
  RAM anyway; unpacking a map you meant to read straight out of ROM would cost
  you the RAM you were trying to save.
- **A backdrop behind the level**, which on an MSX1 is a thing you build rather
  than a thing the VDP has. SCREEN 2 owns exactly one name table, so there is no
  layer to be behind: the "layer" is a single rule applied where a cell reaches
  the screen. `background.map.json` is a 32x24 map pinned to the *screen* (not
  the world), and `ScreenTile()` says that a level tile carrying **flag 8** is
  not drawn — the backdrop's tile at that screen position is. Because the
  backdrop does not scroll and the level does, the holes slide across it.

  The same rule applies at the one other place a cell reaches the screen on its
  own — the poke that clears a collected coin, which leaves tile 39 behind so
  the hole shows the backdrop too. Flags come from the *level's* tile, so a
  transparent cell is still non-solid, still not a coin; the backdrop is
  decoration and nothing reads its flags. Sampling `g_Back` at
  `(camX / 2 + col) & 31` instead of `col` would make it scroll at half speed —
  the same merge with a different index, and it wants tileable art.

  **Composing costs about 95 µs per cell** (~340 Z80 cycles) once SDCC is done
  with it, which is a lot next to a straight `VDP_WriteVRAM_16K` of the same
  row. So the only lever that matters is *how many cells get composed*, and the
  demo pulls it twice. One full redraw, measured in openMSX by breaking on
  `DrawView` twice and subtracting the emulator's clock:

  | Redraw | Frames (20 ms each) |
  |---|---|
  | No backdrop at all, 24 rows blitted straight from the level | 0.47 |
  | Backdrop composed over all 24 rows | 4.45 |
  | Level cut to the bottom 12 rows, opaque rows skipped | **1.67** |

  The first cut is that **the level only covers the bottom half of the screen**:
  everything above `LEVEL_TOP` was sky, so it belongs to the backdrop alone,
  goes to VRAM once in `DrawBackdropTop()`, and is never touched again — it
  cannot change, because it does not scroll. The second is `g_RowHasTrans`: a
  level row holding no transparent cell needs no composing, so the ground rows
  go straight to VRAM exactly as they did before the backdrop existed.

  A redraw only happens when the camera crosses a whole tile, which at one pixel
  per frame is every eighth frame. Two more levers are measured but not taken:
  SDCC's *Ultra* compile complexity (Project Settings) buys 1.67 → 1.42 at the
  cost of build time, and writing the patch loop in `__asm` would take most of
  the rest, since what remains is SDCC keeping the loop's pointers in the stack
  frame rather than in registers.

  To open up more of the backdrop, paint tile 39 — the checkered *transparent*
  tile — wherever you want a hole; flagging tile 0 instead turns the whole sky
  into one.
- **Superposed sprites**, placed with the sprite sheet's own
  `g_Player_SetMeta()`. A mode 1 sprite is a single colour, so a two-colour
  character means two hardware sprites on the same coordinate: the sprite editor
  holds both planes and their colours, and one call writes both attribute
  entries. The split here is the useful one — **plane 0 is the line art, plane 1
  the flat body colour**, in that order because the lower plane number wins
  where they overlap. The body plane carries the whole silhouette, line pixels
  included, so nothing shows through if the two ever land a pixel apart; and the
  black outline is what keeps a green dragon readable against green hills.

  The art faces right, and `FacePlayer()` mirrors it with MSXgl's
  `SpriteFX_FlipHorizontal16()` — 32 bytes per shape, swapping the two
  half-columns and reversing the bits in each byte. The mirrors go back into the
  *same* pattern slots rather than a second set, which is what lets
  `g_Player_SetMeta()` and the sheet's generated plane and colour tables stay
  usable as they are: they describe the twelve shapes that exist, not
  twenty-four. It costs 384 bytes of VRAM on a turn and nothing at all while the
  player keeps walking the same way. Needs `sprite_fx` in **LibModules** and
  `SPRITEFX_USE_16x16` / `SPRITEFX_USE_FLIP` in `msxgl_config.h`. It costs two of the four sprites the VDP will draw on one line, which
  the editor shows per character. The walk is a six step cycle (`g_WalkCycle` in
  `main.c`) rather than two poses flipping back and forth, which is the
  difference between a stride and a flicker.
- **Animation through the pattern table.** The coins turn without the map being
  touched at all. The four poses are the cells of a 4x1 block in the tileset —
  a design drawn on one canvas rather than as four separate tiles — and
  `SpinCoins()` copies one pose's eight pattern bytes over the coin tile's slot.
  `VDP_LoadPattern_GM2` writes all three SCREEN 2 banks, so a step costs 24
  bytes and turns *every* coin on screen, the HUD icon included, because the
  name table still says "tile 6" in all those places. Re-pointing each coin at
  another tile would cost a name-table write per coin per step and would not
  animate the ones off screen at all.
- **Stamping a block**, in `OpenDoor()`. The open doorway is a 1x2 block, and
  when the last coin is taken its two cells go into the level array and
  `g_Tiles_DrawBlock()` puts them on screen — MSXgl's `VDP_WriteLayout_GM2`
  underneath. Both steps, because the screen shows the change now and the map
  keeps it when the view scrolls back over it.
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

## Seven things worth knowing

**Animate patterns, not the map.** A tile-based animation has two shapes: change
which tile each cell points at, or change what that tile *looks like*. The second
is almost always the one you want — it is a fixed cost no matter how many of the
thing are on screen, it reaches copies that are scrolled off, and it leaves the
map alone so collision and the coin count keep reading the same array. The only
catch is that every cell using that tile animates, which is exactly why the HUD
coin spins along with the ones in the level here. If you need one of them still,
give it its own tile.

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
them out of the map at startup and collects whatever carries the coin flag, so
painting one anywhere is enough. The HUD handles up to 99. To invent a new kind
of tile, draw it, tick the flags it should have in the tile editor, and paint
it into the map; `main.c` needs no changes at all.
