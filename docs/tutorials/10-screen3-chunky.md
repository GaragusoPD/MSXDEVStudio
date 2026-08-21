# 10 — SCREEN 3: chunky graphics with no colour clash

**Machine:** MSX1 and up · **Editors:** the screen editor, the bitmap tileset
editor, the map editor

Every other MSX1 mode makes you fight colour clash. SCREEN 2 gives you 256×192
dots but only two colours per 8×1 span, so a red sprite over a blue sky needs
planning. SCREEN 3 makes the opposite trade: **64×48 blocks of 4×4 dots, and
every block is any of the sixteen colours, independently.** No attributes, no
clash, no planning.

That is the same picture recent ZX Spectrum chunky-pixel games (*Twinlight*,
*Yazzie Junior*) go to considerable trouble to fake in software. On an MSX1 it
is what the VDP does.

The catch is resolution — 64×48 is coarse, and everything moves on a 4-dot grid.
That suits puzzle and arcade games, and it is the reason this mode was mostly
ignored: it does not look like the games people were copying.

> MSXgl has no sample for this mode and almost no support for it —
> `VDP_SetModeMultiColor()` sets the registers and stops. Everything else in this
> tutorial is emitted by MSXDEVStudio's exporter, and all of it calls MSXgl for
> the actual VRAM work.

## The one thing you have to know about the hardware

SCREEN 3 is not really a bitmap mode. It has a name table and a pattern table
like SCREEN 1, and the VDP reads a cell's pattern at

```
pattern_base + name * 8 + (char_row & 3) * 2 + (block_row & 1)
```

Two bytes per cell, four nibbles, four blocks. What makes it *behave* as a
bitmap is filling the name table with a specific pattern — row `y` holds
`(y >> 2) * 32 + x` — after which the pattern table is a plain 1536-byte
framebuffer and the byte holding block *(x, y)* is

```
((y & 0xF8) << 5) | ((x >> 1) << 3) | (y & 7)
```

You will not write that yourself. It matters because of two things that fall out
of it:

- **Eight consecutive bytes are an 8×32-dot column strip** (the low three bits
  are `y`). That is the unit a screen update works in.
- **`x` is byte-aligned.** Two blocks share a byte, so a software sprite moves 8
  dots at a time horizontally, and 4 vertically.

## Two ways to use the mode, and how to choose

You get to pick what the name table is for. It cannot be both.

| | What it is | A whole screen costs | Use it for |
|---|---|---|---|
| **Framebuffer** | Name table is the boilerplate above; the pattern table is your picture | 1536 bytes ≈ **64 % of a 50 Hz frame** | Chunky arcade and puzzle, software sprites, destructible terrain |
| **Name table** | Pattern table holds up to 256 tiles of 2×2 blocks; the name table is your map | 768 bytes ≈ **32 %** | Multi-screen worlds, scrolling |

Those percentages are the whole design. A 50 Hz frame is about 71,600 T-states
and MSX1 VRAM writes cost roughly 30 each, so you cannot repaint a SCREEN 3
framebuffer every frame and have any time left. You do not have to: a single
dirty column strip is 8 bytes, under half a percent.

## Path 1 — the framebuffer, for a chunky playfield

Make a `.screen.json` in the Resources panel, switch its mode to **SCREEN 3** in
the palette panel, and press *start a blank canvas*. You now have a 64×48 grid
you can draw on with pencil, line, rectangle, fill and the eyedropper. Turn on
the **8-dot cell guide** if you might later cut the art into tiles — that is the
boundary a name-table entry falls on.

Importing a PNG works too, and it is scaled to 64×48 for you before conversion,
which is also what averages each block's colour sensibly.

Tick **Ready-made C**, and **Double buffer**. Export.

```c
#include "content/playfield.h"

// The whole playfield, in RAM. 1536 bytes.
static u8 g_Screen[G_PLAYFIELD_SIZE];

void Play_Init(void)
{
	// Sets the mode *and* writes the name table. Not optional — without it the
	// pattern table is not a framebuffer.
	g_Playfield_InitScreen();
	g_Playfield_ToBuffer(g_Screen);   // start from the picture you drew
	g_Playfield_FlushAll(g_Screen);
}
```

Then per frame, draw into `g_Screen` and flush:

```c
g_Playfield_Plot(g_Screen, x, y, COLOR_LIGHT_RED);   // blocks: 0..63 by 0..47
g_Playfield_FillRect(g_Screen, 10, 10, 8, 4, COLOR_BLACK);
g_Playfield_Flush(g_Screen);   // only the strips that changed
```

`_Flush()` walks 192 flags, sends the strips that are dirty, waits for the
interrupt and flips the page. **The flip costs nothing**: the two pages are two
pattern tables at 0x0000 and 0x1000, the name table holds pattern *indices* so
it is shared, and swapping them is one `VDP_SetPatternTable()`. Nothing is
copied, and a moving object never shows half-drawn.

### Collision is just reading the picture

```c
if (g_Playfield_Get(g_Screen, x, y) != 0)
	/* something solid is there */;
```

In a mode with no colour clash and no attributes, the picture *is* the map. No
tilemap lookup, no parallel collision array — which is a large part of why this
mode suits the genre.

### Software sprites

Draw the frames in a `.btiles.json` set at SCREEN 3, one frame per tile. Set its
**transparent colour** (0 is the natural choice), and drag across the bank to
keep a run of frames as a named block — a 1×4 block called `walk` is a
four-frame animation, and the side panel will play it back so you can see
whether the cycle reads.

```c
// Lift it, move it, put it down, show it.
g_Playfield_Restore(g_Screen, g_Under, g_X, g_Y, 4, 4);
g_X += 2;                                       // 2 blocks = 8 dots, byte-aligned
g_Playfield_Save(g_Screen, g_Under, g_X, g_Y, 4, 4);
g_Hero_DrawTileMasked(g_Screen, G_HERO_WALK_BASE + step, g_X, g_Y);
g_Playfield_Flush(g_Screen);
```

`_Save` keeps `ceil(w / 2) * h` bytes — eight, for a 4×4-block sprite. Hardware
sprites still work over all of this and are cheaper for anything that only
moves, so a common split is hardware sprites for actors and software blitting
for terrain and effects.

## Path 2 — the name table, for a world that scrolls

Make a `.btiles.json`, set it to SCREEN 3, and leave the tile size at **2×2**.
Two by two blocks is exactly one name-table entry and nothing else is, which is
the whole point: at that size the VDP draws your map instead of the CPU.

Point a `.map.json` at it and the map exports the same `_DrawLayer` a SCREEN 2
map does:

```c
VDP_SetMode(VDP_MODE_SCREEN3);   // *not* _InitScreen(): your map is the name table
g_Tiles_Upload();                // patterns to 0x0000
g_Level_DrawLayer(g_Level_Background, 0, 0);
```

And because MSXgl's `scroll` module is nothing but name-table arithmetic, it
drives this unchanged — the side-scroller and vertical-scroller kits on SCREEN 3
get the same real camera they get on SCREEN 2, at 8-dot steps.

Bigger tiles are allowed, and their maps export a `_DrawRow` that blits into the
shadow buffer instead. Use them for a single-screen playfield; use 2×2 if it has
to scroll.

## Two rules that will bite you

**Do not `Print` in SCREEN 3.** MSXgl's Print module has an empty case for this
mode, and — worse — the pattern table a font would be loaded into *is* your
picture. Run title, menu and credits in SCREEN 1 and switch to SCREEN 3 for
play. The game-kit wizard emits `GAME_TEXT_VDP_MODE` for exactly this, and it is
what real SCREEN 3 games did.

**Check `VDP_USE_MODE_MC` first if the screen stays blank.** It has no
engine-side default, and when it is `FALSE` `VDP_SetMode(VDP_MODE_SCREEN3)` does
nothing at all — silently. `VDP_GetMode()` will still tell you it worked. The
wizard writes it for you; a hand-made project may not have it. The name-table
path also needs `VDP_USE_MODE_G2 TRUE`, which is what compiles
`VDP_WriteLayout_GM2`.

## The quickest way to see it

**File ▸ New Game… ▸ Chunky arcade.** It scaffolds a playfield, a tileset and a
map, and gives you a block-grid actor that walks around and stops at solid
blocks — double buffered, in about eighty lines of `src/play.c` you can read.
