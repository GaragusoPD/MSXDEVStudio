# Tiles and maps

MSX graphics are built from small 8x8 tiles repeated across the screen,
not full-screen bitmaps. This tutorial explains how the VDP's pattern
modes work and how to load a tileset and draw a map with MSXgl.

**Sample:** `projects/samples/s_game.c` · **LibModules:** `game/state, game/pawn, system, bios, vdp, print, input, memory, math, draw` (from `s_game.js`'s override merged with the samples' `project_config.js` base) · **Machine:** MSX1 (`Machine = "1"` in `s_game.js`, since the sample runs in SCREEN 1)

## How pattern modes work

A pattern-mode screen (SCREEN 1, 2 or 4) is drawn from three VRAM tables:

- **Pattern generator table.** The shape of every tile: 8 bytes per tile,
  one byte per pixel row, one bit per pixel. Its VRAM address is set with
  `VDP_SetPatternTable(addr)` and remembered in `g_ScreenPatternLow`
  (and `g_ScreenPatternHigh` on builds that use 17-bit VRAM addressing).
- **Color table.** The ink/paper colors for each tile. In SCREEN 2/4
  "the colour is specified for each 8 dots" (one color byte per pixel
  row, so the color table is the same size as the pattern table). In
  SCREEN 1 one color byte covers a whole group of 8 consecutive tile
  indices, so 256 tiles only need 32 color bytes and every tile in a
  group of 8 shares one ink/paper pair. Set with `VDP_SetColorTable(addr)`,
  remembered in `g_ScreenColorLow` / `g_ScreenColorHigh`.
- **Layout table** (also called the name table). One byte per screen
  cell: 32 columns x 24 rows = 768 bytes, one full screen. Each byte is
  the tile index shown at that cell. Set with `VDP_SetLayoutTable(addr)`,
  remembered in `g_ScreenLayoutLow` / `g_ScreenLayoutHigh`.

`VDP_SetMode()` already calls the right setup for you. For example,
`VDP_SetModeGraphic2()` (called internally by `VDP_SetMode(VDP_MODE_GRAPHIC2)`)
sets the layout table to `0x1800`, the color table to `0x2000` and the
pattern table to `0x0000` (`VDP_G2_ADDR_NT/CT/PT` in `vdp.h`). Most
programs never call the three setters directly, they just call
`VDP_SetMode()` and then read `g_ScreenLayoutLow` and friends. You only
need the setters when you want custom table addresses, the way
`s_scroll.c` does to make room for a bigger map and separate sprite
tables.

SCREEN 2 (and SCREEN 4, which shares the same table layout) splits the
768 name bytes into three vertical thirds of 256 cells each (rows 0-7,
8-15, 16-23), and gives **each third its own 2KB region** of the pattern
and color tables (offset, offset+0x800, offset+0x1000). A single name
byte (0-255) can therefore look different depending on which third of
the screen it appears in, that's how a name table with only 256 possible
values can drive up to 768 distinct-looking tiles on one screen. If you
just want the same 256 tiles everywhere (the common case), load the same
data into all three banks at once, see below.

SCREEN 4 (`VDP_MODE_GRAPHIC3`) uses the exact same three-table, three-bank
layout as SCREEN 2 (`VDP_G3_ADDR_NT/CT/PT` are the same addresses as
`VDP_G2_ADDR_NT/CT/PT`) and the same loading functions. Being MSX2, it
additionally gives you a real 16-color palette (`VDP_SetPalette`) instead
of the fixed MSX1 palette, and needs `Machine` set to `"2"` or higher in
Project Settings since `VDP_MODE_GRAPHIC3` only exists for MSX2+.

## Loading a tileset

For SCREEN 2/4, use the GM2 helpers (declared in `vdp.h`, guarded by
`VDP_USE_MODE_G2 || VDP_USE_MODE_G3`):

```c
void VDP_LoadPattern_GM2(const u8* src, u8 count, u8 offset);
void VDP_LoadColor_GM2(const u8* src, u8 count, u8 offset);
```

- `src` is your tileset data.
- `count` is a number of **tiles** (8 bytes each), not bytes. A count of
  `0` means all 256 tiles.
- `offset` is the index of the first tile to overwrite (0-255).

Both copy `count` tiles starting at `offset` into the pattern (or color)
table, then repeat the same copy twice more, 0x800 bytes further each
time, so all three banks end up identical:

```c
// engine/src/vdp.c
void VDP_LoadPattern_GM2(const u8* src, u8 count, u8 offset)
{
	u16 cnt = count == 0 ? 256 * 8 : count * 8;
	u16 dst = g_ScreenPatternLow + (offset * 8);
	VDP_WriteVRAM(src, dst, g_ScreenPatternHigh, cnt);
	dst += 0x800;
	VDP_WriteVRAM(src, dst, g_ScreenPatternHigh, cnt);
	dst += 0x800;
	VDP_WriteVRAM(src, dst, g_ScreenPatternHigh, cnt);
}
```

`VDP_LoadColor_GM2` is identical but writes to `g_ScreenColorLow` instead.
`s_scroll.c` calls them like this to load a 94-tile set:

```c
VDP_LoadPattern_GM2(g_DataMapGM2_Patterns, 94, 0);
VDP_LoadColor_GM2(g_DataMapGM2_Colors, 94, 0);
```

SCREEN 1 has no banks, so there is nothing to mirror: write the pattern
and color data straight into the tables with `VDP_WriteVRAM` /
`VDP_FillVRAM` against the globals, the way `s_game.c` does:

```c
// Pattern table: clear it, then load 24 tiles from the start
VDP_FillVRAM(0x00, g_ScreenPatternLow, 0, 256*8); // Clear pattern
VDP_WriteVRAM(g_DataBackground, g_ScreenPatternLow, 0, 24*8);

// Color table: clear it (32 bytes = 256 tiles / 8 per group),
// then set the color of four individual groups
VDP_FillVRAM(0xF0, g_ScreenColorLow, 0, 32); // Clear color
VDP_Poke_16K(0xF7, g_ScreenColorLow + 0);
VDP_Poke_16K(0x54, g_ScreenColorLow + 1);
VDP_Poke_16K(0xF5, g_ScreenColorLow + 2);
VDP_Poke_16K(0x99, g_ScreenColorLow + 3);
```

Each color byte packs two 4-bit color codes, ink in the high nibble and
paper in the low nibble. Because SCREEN 1's color table is grouped by 8,
`g_ScreenColorLow + 1` recolors tiles 8-15 all at once, not just tile 1.

## Drawing a map

The layout table is one byte per cell, so drawing a whole static map is
one blit. `VDP_WriteVRAM(src, destLow, destHigh, count)` is a macro
(declared in `vdp.h`) that always takes those four arguments; on MSX2/2+
builds it forwards to `VDP_WriteVRAM_128K` (`destHigh` is the 17th VRAM
address bit), on MSX1-only builds it forwards to `VDP_WriteVRAM_16K` and
`destHigh` is simply ignored, so the same call works either way. `count`
is a byte count, and a count of `0` means 65536 bytes.

So a full 32x24 screen (one screen) is:

```c
VDP_WriteVRAM(map, g_ScreenLayoutLow, g_ScreenLayoutHigh, 32 * 24);
```

Note: this exact call is not copied from a sample, it is assembled from
the verified `VDP_WriteVRAM` signature above. `s_game.c` builds its
levels procedurally with per-row `VDP_FillVRAM` calls instead, and
`s_scroll.c` hands its map array straight to the `scroll` module rather
than blitting it itself.

To change a single cell, use `VDP_Poke`:

```c
VDP_Poke(tileIndex, g_ScreenLayoutLow + y * 32 + x, g_ScreenLayoutHigh);
```

On SCREEN 2/4, `vdp.h` also gives you cell-coordinate helpers that do the
`y * 32 + x` math for you:

```c
inline void VDP_Poke_GM2(u8 x, u8 y, u8 value) { VDP_Poke(value, g_ScreenLayoutLow + (y * 32) + x, g_ScreenLayoutHigh); }
inline u8   VDP_Peek_GM2(u8 x, u8 y) { return VDP_Peek(g_ScreenLayoutLow + (y * 32) + x, g_ScreenLayoutHigh); }
inline void VDP_FillScreen_GM2(u8 value) { VDP_FillVRAM(value, g_ScreenLayoutLow, g_ScreenLayoutHigh, 32*24); }
```

## The full program

```c
#include "msxgl.h"

#include "content/tileset.h"   // g_Tileset_Patterns, g_Tileset_Colors
#include "content/level.h"     // g_Level_Background

void main()
{
	VDP_SetMode(VDP_MODE_GRAPHIC2); // SCREEN 2
	VDP_SetColor(COLOR_BLACK);
	VDP_ClearVRAM();

	// Load the tileset into all 3 pattern/color banks
	VDP_LoadPattern_GM2(g_Tileset_Patterns, G_TILESET_PATTERNS_SIZE / 8, 0);
	VDP_LoadColor_GM2(g_Tileset_Colors, G_TILESET_PATTERNS_SIZE / 8, 0);

	// Draw the map: one byte per cell, 32x24 = one screen
	VDP_WriteVRAM(g_Level_Background, g_ScreenLayoutLow, g_ScreenLayoutHigh, 32 * 24);

	VDP_EnableDisplay(TRUE);

	while (1) {}
}
```

`G_TILESET_PATTERNS_SIZE` is the size define MSXDEVStudio writes next to
every generated array (see `../resources.md`); dividing it by 8 gives the
tile count so `VDP_LoadPattern_GM2` never reads past the end of your
tileset, whatever its size.

## Try changing it

- Pass `0` instead of `G_TILESET_PATTERNS_SIZE / 8` if your tileset fills
  all 256 slots, it's the documented shortcut for "load everything".
- Recolor one tile group with `VDP_Poke(color, g_ScreenColorLow + n, g_ScreenColorHigh)`
  and watch how many on-screen tiles change on SCREEN 1 versus SCREEN 2.
- Swap a single cell at runtime with `VDP_Poke_GM2(x, y, newTileIndex)`
  instead of redrawing the whole map.
- Flood the screen with one tile using `VDP_FillScreen_GM2(value)` before
  drawing the real map, to see the three-bank mirroring at work.
- Switch to SCREEN 1 (`VDP_SetMode(VDP_MODE_GRAPHIC1)`) and load the same
  tileset with `VDP_WriteVRAM`/`VDP_FillVRAM` instead of the GM2 helpers.

## Using your own art

The tile and map editors generate exactly the arrays used above. Open the
**Resources** panel, create a **tiles** resource (say, named `tileset`)
and paint it, it exports `g_Tileset_Patterns` and `g_Tileset_Colors`
(plus `g_Tileset_Palette` if your project targets SCREEN 4). Then create
a **map** resource (say, named `level`), pick your tileset in its side
panel and paint the map, its default layer, `background`, exports as
`g_Level_Background`, one byte per cell, ready for `VDP_WriteVRAM`.

See `../resources.md` for how to create, export and name these resources,
including multi-layer maps and MSX2 palettes.

## Gotchas

- `count` means different things on different functions: `VDP_LoadPattern_GM2`
  / `VDP_LoadColor_GM2` count in **tiles** (0 means all 256 tiles), while
  the underlying `VDP_WriteVRAM` / `VDP_FillVRAM` count in **bytes** (0
  means 65536 bytes). Mixing them up is an easy off-by-8 bug.
- Loading patterns/colors into only one SCREEN 2/4 bank (via raw
  `VDP_WriteVRAM` instead of the `_GM2` helpers) leaves the other two
  screen thirds showing whatever was already in VRAM there.
- SCREEN 1's color table is grouped by 8 tiles, recoloring one tile index
  recolors its whole group.
- The table globals (`g_ScreenLayoutLow`, etc.) are only valid after
  `VDP_SetMode()` or the explicit `VDP_Set*Table()` calls have run, read
  them too early and you'll get stale addresses.
- Load the tileset before writing the layout table (or before enabling
  display), or the screen will briefly show the map through the wrong
  patterns.

## Three things MSXDEVStudio adds

**Designs bigger than one tile.** A door or a tree is several tiles, and
assembling it mentally from 8x8 cells is the tedious part of tile art. The tile
editor lets you name a **block** and draw it on one canvas; it is stored as the
tiles it is made of, so nothing about the hardware changes. On export you get a
`_Blocks` table of tile indices plus `..._BASE/_W/_H` defines, and — with
**Export ready-made C** ticked — a `_DrawBlock()` that stamps one into the name
table through MSXgl's `VDP_WriteLayout_GM2`. See the [resources
guide](../resources.md).

**Animate the pattern, not the map.** To make every coin in a level spin, you
have two options: change which tile each cell points at, or change what that
tile *looks like*. Prefer the second. `VDP_LoadPattern_GM2(src, 1, tile)` writes
eight bytes into all three SCREEN 2 banks — 24 bytes, once — and every cell
using that tile animates, including the ones scrolled off screen. Re-pointing
cells costs a name-table write per copy per step and leaves the off-screen ones
behind. The catch is that it is all-or-nothing: every use of that tile animates,
so anything that must hold still needs its own tile. The
[demo game](../../demo_msx1/README.md) spins its coins this way, keeping the four
poses as a 4x1 block.

**Maps stored in clumps, not tiles.** A block is an authoring convenience: the
map records the tiles it stamped, so the clump exists in the editor and nowhere
in the ROM. If a level is big enough for its 768-bytes-a-screen to matter, a
**meta-tile set** keeps those clumps as data and lets the map index them
instead — a quarter of the bytes for 2×2 groups, before compression. It is a
separate, optional resource; see [Meta-tiles](09-meta-tiles.md).
