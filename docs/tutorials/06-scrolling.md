# Scrolling

Your level is bigger than one 32x24 screen, but the MSX VDP can only display
one screen's worth of tiles at a time. MSXgl's `scroll` module keeps a window
into a bigger tilemap and rewrites the tiles at its edges each frame so the
window appears to move.

**Sample:** `projects/samples/s_scroll.c` · **LibModules:** `["scroll", "system", "bios", "vdp", "print", "input", "memory"]` (add `"scroll"` to whatever your project already has) · **Machine:** MSX2 (also works on MSX1, with the MSX2-only options turned off, see Gotchas)

## How it works

MSX1's VDP has no hardware register that scrolls a tile screen (Graphic 1/2).
The only way to move the picture is to rewrite the bytes in the name table
(the table of tile indices the VDP reads every frame) so different tiles show
through.

The scroll module keeps two tilemaps in mind:

- The **source map**: your whole level, as one flat array of tile indices in
  ROM, one byte per cell, row by row. This can be much larger than one screen.
- The **destination window**: the rectangle of the name table in VRAM that
  the VDP actually displays.

Each time you call `Scroll_Update()`, it looks at how far you've scrolled,
works out which tile column/row of the source map should now be visible at
the edge of the window, and writes just that band of bytes into VRAM. It only
touches VRAM when the offset has crossed a full 8-pixel tile boundary, so
calling it every frame is cheap.

On MSX2, the module can also use the VDP's screen adjust register (R#18) to
shift the whole picture by a sub-tile amount (0-7 pixels) without touching
VRAM at all, giving smooth pixel-by-pixel scrolling between tile updates.
`scroll.c` reaches it through MSXgl's `VDP_SetAdjustOffset()`. R#18 is a
V9938 register, so this works on any MSX2 — it is not the V9958's horizontal
scroll pair (R#26/R#27), which would need an MSX2+.

## Configuring the module

Scrolling parameters are not runtime arguments, they are `#define`s in your
project's `msxgl_config.h`. The module is compiled with `#if` guards around
each feature, so anything you leave off (vertical scrolling, the adjust
register, mask sprites) is not compiled into your ROM at all.

| Define | What it controls |
|---|---|
| `SCROLL_HORIZONTAL` | Turns on horizontal scrolling: adds `g_Scroll_OffsetX`, `g_Scroll_TileX` and `Scroll_SetOffsetH()`. |
| `SCROLL_VERTICAL` | Turns on vertical scrolling: adds `g_Scroll_OffsetY`, `g_Scroll_TileY` and `Scroll_SetOffsetV()`. |
| `SCROLL_SRC_X` | Documented as the start X coordinate of the source data, but the current engine (`scroll.c`) never reads it. Leave it at its default. |
| `SCROLL_SRC_Y` | Start row (in tiles) of the source map to scroll from. Added as a fixed offset before your vertical scroll position. |
| `SCROLL_SRC_W` | Width of the source map, in tiles. |
| `SCROLL_SRC_H` | Height of the source map, in tiles. |
| `SCROLL_DST_X` | X position (in tiles) of the visible window inside the screen's name table. |
| `SCROLL_DST_Y` | Y position (in tiles) of the visible window inside the screen's name table. |
| `SCROLL_DST_W` | Width of the visible window, in tiles (up to 32). |
| `SCROLL_DST_H` | Height of the visible window, in tiles (up to 24). |
| `SCROLL_SCREEN_W` | Width of the actual screen's name table, in tiles (the row stride used when writing VRAM). Normally 32. |
| `SCROLL_WRAP` | Loops the source map when scrolling reaches its edge. Horizontal only. |
| `SCROLL_ADJUST` | Use the VDP adjust register (R#18, via `VDP_SetAdjustOffset()`) for smooth sub-tile scrolling. MSX2 only. |
| `SCROLL_ADJUST_SPLIT` | Apply the adjust register only inside the destination window (via an H-blank split), so text/HUD areas outside the window aren't shifted. MSX2 only. |
| `SCROLL_MASK` | Use sprites to hide the ragged tile edge while it's mid pixel-shift. MSX2 only. |
| `SCROLL_MASK_ID` | First sprite index reserved for the mask sprites. |
| `SCROLL_MASK_COLOR` | Color of the mask sprites, must match your border color. |
| `SCROLL_MASK_PATTERN` | Sprite pattern index used for the mask sprites. |

`msxgl_config_msx1.h` ships with `SCROLL_ADJUST`, `SCROLL_ADJUST_SPLIT` and
`SCROLL_MASK` all `FALSE`, since those three need MSX2 VDP features.
`msxgl_config_msx2.h` ships with all three `TRUE`.

## Setting it up

1. Add `"scroll"` to **LibModules** in Project Settings.
2. `#include "scroll.h"` in your source file.
3. Open your project's `msxgl_config.h` (a plain file in the project folder,
   edited as C) and set the `SCROLL_*` defines under `SCROLL MODULE` to match
   your map size and the window you want on screen.
4. Set up video mode and VRAM table addresses as usual, then load your tile
   patterns/colors.
5. Call `Scroll_Initialize()` with your map array's address cast to `u16`:

```c
u8 sprt = Scroll_Initialize((u16)g_Level_Background);
```

It returns the first sprite index still free after the module (only relevant
if `SCROLL_MASK` reserved some for masking; otherwise it's `0`).

6. Optionally call `Scroll_SetOffsetH()`/`Scroll_SetOffsetV()` once to set a
   starting position before the loop begins.

## Scrolling each frame

Each frame:

```c
WaitVBlank();
Scroll_Update();               // redraw the tiles that just scrolled into view
Scroll_SetOffsetH(dx);         // move by dx pixels this frame (signed, i8)
Scroll_SetOffsetV(dy);         // move by dy pixels this frame (signed, i8)
```

`Scroll_Update()` applies whatever offset is currently stored, so this
"update then move" order means the offset you set this frame is drawn on the
*next* call to `Scroll_Update()`. `Scroll_SetOffsetH`/`Scroll_SetOffsetV` only
exist if you enabled the matching `SCROLL_HORIZONTAL`/`SCROLL_VERTICAL`
define, both take a signed pixel delta, and both clamp at the edges of the
source map (or wrap, for horizontal, if `SCROLL_WRAP` is on).

## The full program

```c
#include "msxgl.h"
#include "scroll.h"

#include "content/tiles.h"          // exported by the Tile editor
#include "content/level.h"          // exported by the Map editor

// V-blank synchronization flag
u8 g_VBlank = 0;

//-----------------------------------------------------------------------------
// H_TIMI interrupt hook
void VBlankHook()
{
	g_VBlank = 1;
}

//-----------------------------------------------------------------------------
// Wait for V-Blank period
void WaitVBlank()
{
	while (g_VBlank == 0) {}
	g_VBlank = 0;
}

//-----------------------------------------------------------------------------
// Program entry point
void main()
{
	// Initialize video
	VDP_SetMode(VDP_MODE_GRAPHIC2);       // SCREEN 2
	VDP_SetLayoutTable(0x3800);
	VDP_SetColorTable(0x2000);
	VDP_SetPatternTable(0x0000);
	VDP_SetColor(COLOR_BLACK);
	VDP_ClearVRAM();
	VDP_EnableVBlank(TRUE);
	BIOS_SetHookCallback(H_TIMI, VBlankHook);

	// Load tileset
	VDP_LoadPattern_GM2(g_Tiles_Patterns, 0, 0);   // 0 = all 256 patterns
	VDP_LoadColor_GM2(g_Tiles_Colors, 0, 0);

	// Initialize scroll module with the map exported by the Map editor
	Scroll_Initialize((u16)g_Level_Background);

	while (1)
	{
		WaitVBlank();
		Scroll_Update();

		u8 row8 = Keyboard_Read(8);
		if (IS_KEY_PRESSED(row8, KEY_RIGHT))
			Scroll_SetOffsetH(2);
		else if (IS_KEY_PRESSED(row8, KEY_LEFT))
			Scroll_SetOffsetH(-2);

		if (IS_KEY_PRESSED(row8, KEY_DOWN))
			Scroll_SetOffsetV(2);
		else if (IS_KEY_PRESSED(row8, KEY_UP))
			Scroll_SetOffsetV(-2);
	}
}
```

This assumes `SCROLL_DST_W`/`SCROLL_DST_H` cover the full 32x24 screen and
`SCROLL_ADJUST`/`SCROLL_MASK` are off, so it needs no extra interrupt hooks
and runs unchanged on MSX1 or MSX2. See `projects/samples/s_scroll.c` for the
full version with smooth per-pixel scrolling, an H-blank split and mask
sprites.

## Try changing it

- Set `SCROLL_DST_Y` to `2` and `SCROLL_DST_H` to `20` in `msxgl_config.h`, so
  two rows stay free at the top for a HUD that never scrolls (`s_scroll.c`
  does exactly this).
- Turn `SCROLL_VERTICAL` off if your game only scrolls sideways, it removes
  the vertical bookkeeping from your ROM.
- Set `SCROLL_WRAP` to `FALSE` so the view stops at the map's edges instead
  of looping back to the start.
- On MSX2, turn `SCROLL_ADJUST` on for smooth pixel scrolling instead of the
  8-pixel jumps you get with it off.

## Gotchas

- `Scroll_Initialize` expects the map's address cast to `u16`,
  `(u16)g_Level_Background`, not the array itself.
- Your map array must be exactly `SCROLL_SRC_W * SCROLL_SRC_H` bytes, one
  byte per cell, row by row. If it doesn't match the size you configured,
  `Scroll_Update` reads the wrong bytes.
- `SCROLL_SRC_X` is defined in `msxgl_config.h` but the current engine does
  not use it, only `SCROLL_SRC_Y` offsets into the source map.
- `SCROLL_ADJUST` and `SCROLL_MASK` need MSX2 VDP features; they're `FALSE`
  in the MSX1 config and calling code that depends on them won't even compile
  if you leave them off.
- Turning on `SCROLL_ADJUST_SPLIT` is not automatic: you also need your own
  `H_KEYI` hook that calls `Scroll_HBlankAdjust()`, as shown in
  `s_scroll.c`. `Scroll_Update()` alone will not split the screen.
- `SCROLL_WRAP` only loops horizontal scrolling. `Scroll_SetOffsetV` always
  clamps at the top/bottom of the map, it never wraps.
- `Scroll_SetOffsetH`/`Scroll_SetOffsetV` only exist in the build if you
  turned on the matching `SCROLL_HORIZONTAL`/`SCROLL_VERTICAL` define.

## Using your own map

Draw your level in the Map editor. A map wider or taller than 32x24 tiles is
exactly what scrolling is for, the editor draws a screen-size outline overlay
on top of the canvas so you can see how much fits on screen at once while you
design the rest of the level around it.

Each layer exports as its own array named after the layer, so the default
`background` layer of a map called `level` becomes `g_Level_Background`, one
byte per cell. Set `SCROLL_SRC_W`/`SCROLL_SRC_H` in `msxgl_config.h` to that
map's width and height in tiles, load its tileset before you start scrolling,
and pass the array to `Scroll_Initialize()` as shown above. See
[Resources](../resources.md) for how exporting and tile loading work in
detail.
