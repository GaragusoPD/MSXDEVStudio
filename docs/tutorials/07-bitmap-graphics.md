# Bitmap graphics (SCREEN 5 to 8)

MSX2's bitmap modes turn the whole screen into addressable pixels instead of
tiles, and the V9938/V9958 video chip can fill, copy and line-draw rectangles
of VRAM by itself, without the CPU touching a single pixel.

**Sample:** `projects/samples/s_vdpcmd.c`, `projects/samples/s_draw.c` · **LibModules:** `system`, `bios`, `vdp`, `draw`, `input` · **Machine:** MSX2 and up

## The bitmap modes

| Mode | Resolution | Colors | Bits per pixel |
|---|---|---|---|
| SCREEN 5 (`VDP_MODE_SCREEN5`) | 256 x 212 | 16 | 4 |
| SCREEN 6 (`VDP_MODE_SCREEN6`) | 512 x 212 | 4 | 2 |
| SCREEN 7 (`VDP_MODE_SCREEN7`) | 512 x 212 | 16 | 4 |
| SCREEN 8 (`VDP_MODE_SCREEN8`) | 256 x 212 | 256 | 8 |

These four are aliases in `vdp.h` for the underlying VDP modes
`VDP_MODE_GRAPHIC4` through `VDP_MODE_GRAPHIC7`. Pass any of them to
`VDP_SetMode()` and it sets up the layout table address and sprite tables for
you.

MSX2+ (V9958) machines also expose `VDP_MODE_SCREEN10`, `VDP_MODE_SCREEN11`
and `VDP_MODE_SCREEN12` plus a `VDP_SetYJK()` function in `vdp.h`. They reuse
SCREEN 8's byte-per-pixel VRAM layout but decode each byte as YJK color
instead of a palette index. Neither sample used in this tutorial uses them,
so they are not covered here.

## Setting the palette

SCREEN 5, 6 and 7 draw through a software palette: each stored pixel value is
an index, and the index is looked up in a table of actual colors. Colors on
the V9938 are 3 bits each of green, red and blue (a format often called
GRB333), packed into 2 bytes. `color.h` gives you a macro to build one:

```c
#define RGB16(r, g, b)   (u16)(((u16)((g) & 0x07) << 8) + (((r) & 0x07) << 4) + ((b) & 0x07))
```

`r`, `g` and `b` each go from 0 to 7. To set one entry:

```c
VDP_SetPaletteEntry(1, RGB16(7, 0, 0)); // palette index 1 = red
```

`VDP_SetPaletteEntry(u8 index, u16 color)` takes an index (0-15) and one
`RGB16` value. To load a whole table at once, use `VDP_SetPalette(const u8*
pal)`. By default it writes palette indices 1 to 15 (30 bytes, 2 per entry)
and leaves index 0 alone; MSXStudio's MSX2 project template leaves
`VDP_USE_PALETTE16` at its default `FALSE`, so this is what you get unless
you turn that on in `msxgl_config.h`.

SCREEN 8 has no palette. Each VRAM byte directly encodes a color as 3 bits
green, 3 bits red, 2 bits blue, the same packing as the `RGB8(r, g, b)` macro
in `color.h`. That is why neither sample calls `VDP_SetPaletteEntry` or
`VDP_SetPalette` for SCREEN 8: there is nothing to load.

## Showing an image

`VDP_WriteVRAM(src, destLow, destHigh, count)` copies `count` bytes from RAM
into VRAM starting at the 17-bit address `(destLow, destHigh)`. The bitmap's
own base address is kept for you in `g_ScreenLayoutLow` / `g_ScreenLayoutHigh`
once you have called `VDP_SetMode()`.

If your picture already fills the screen and its bytes are laid out exactly
like VRAM, one call is enough. If you only want to blit part of an image (or
your source buffer is not VRAM-shaped), write it row by row, like
`s_zip.c` does after decompressing a picture into RAM:

```c
u8* src = g_UnpackBuffer;
u16 dest = g_ScreenLayoutLow + (IMAGE_X/2) + (IMAGE_Y*128);
for (u8 y = 0; y < IMAGE_H; ++y)
{
	VDP_WriteVRAM(src, dest, 0, IMAGE_W/2);
	src += IMAGE_W/2;
	dest += 256/2;
}
```

`IMAGE_X/2` and `IMAGE_W/2` divide by 2 because SCREEN 5 packs 2 pixels per
byte (4 bits per pixel). `256/2` is the byte width of one full SCREEN 5
scanline, so `dest` always jumps to the next VRAM line even though only
`IMAGE_W/2` bytes of it were written, leaving the rest of that line
untouched.

On machines with enough VRAM, `VDP_SetPage(u8 page)` picks which page is
currently shown on screen, while the `destHigh` argument to `VDP_WriteVRAM`
(and to the VDP commands below) lets you target a page that is not currently
displayed. `s_vdpcmd.c` uses exactly that to write into page 1 while page 0
stays on screen: `VDP_WriteVRAM(buffer, addr, 1, count); // Write to page 1`.

## Using your own image

MSXStudio's screen editor does this conversion for you: **Import image…**
loads a PNG, converts it to the bitmap mode you picked, and **Export**
produces a header with `g_Name_Palette` (2 bytes per entry, ready for
`VDP_SetPalette`) and `g_Name_Data` (the packed bitmap, already laid out the
way VRAM expects it for that mode):

```c
#include "content/title.h"

VDP_SetMode(VDP_MODE_SCREEN5);
VDP_SetPalette(g_Title_Palette);
VDP_WriteVRAM(g_Title_Data, g_ScreenLayoutLow, g_ScreenLayoutHigh, G_TITLE_DATA_SIZE);
```

See [Resources](../resources.md) for how to create a screen resource and what
gets generated for each bitmap mode.

## Drawing with the VDP commands

The V9938/V9958 has a command engine built into the chip: it can fill a
rectangle, copy VRAM to VRAM, or draw a line entirely in hardware. The CPU
just writes a handful of registers describing the operation and moves on
instead of looping over pixels itself. MSXgl wraps that register interface
(R#32-46) in the `VDP_Command*` functions declared in `vdp.h` and defined in
`vdp_inl.h`, active whenever `VDP_USE_COMMAND` is on (it is, by default, in
MSXStudio's MSX2 template).

```c
void VDP_CommandHMMV(u16 dx, u16 dy, u16 nx, u16 ny, u8 col);
void VDP_CommandHMMM(u16 sx, u16 sy, u16 dx, u16 dy, u16 nx, u16 ny);
void VDP_CommandYMMM(u16 sy, u16 dx, u16 dy, u16 ny, u8 dir);
void VDP_CommandHMMC(const u8* addr, u16 dx, u16 dy, u16 nx, u16 ny);
void VDP_CommandLMMV(u16 dx, u16 dy, u16 nx, u16 ny, u8 col, u8 op);
void VDP_CommandLMMM(u16 sx, u16 sy, u16 dx, u16 dy, u16 nx, u16 ny, u8 op);
void VDP_CommandLMMC(const u8* addr, u16 dx, u16 dy, u16 nx, u16 ny, u8 op);
void VDP_CommandLINE(u16 dx, u16 dy, u16 nx, u16 ny, u8 col, u8 arg, u8 op);
void VDP_CommandPSET(u16 dx, u16 dy, u8 col, u8 op);
u8   VDP_CommandPOINT(u16 sx, u16 sy);
void VDP_CommandSTOP();
void VDP_CommandWait();
```

- **HMMV** fills a `nx` x `ny` rectangle at `(dx, dy)` with color `col`. It is
  the fastest way to clear the screen: `VDP_CommandHMMV(0, 0, 256, 212, 0);`.
- **HMMM** copies a `nx` x `ny` rectangle from `(sx, sy)` to `(dx, dy)`,
  VRAM to VRAM, at full VDP speed.
- **YMMM** is HMMM's cheaper cousin: it copies a band from column `dx` to the
  right edge of the screen, moving only in Y (from `sy` to `dy`), which is
  enough for a full-width vertical scroll.
- **HMMC** streams bytes from RAM (`addr`) straight into a `nx` x `ny` VRAM
  rectangle, unconditionally overwriting whatever was there.
- **LMMV**, **LMMM** and **LMMC** are the "logical" versions of HMMV/HMMM/HMMC:
  they take an extra `op` argument and combine the source with what is
  already in VRAM instead of overwriting it outright.
- **LINE** draws a straight line `nx` wide, `ny` tall, starting at `(dx, dy)`.
- **PSET** sets a single pixel. **POINT** reads one back (and blocks until
  the VDP is idle before it does, via `VDP_CommandWait()` internally).
- **STOP** aborts whatever command is currently running.
- **WAIT** blocks until the previous command has finished; call it yourself
  before reusing a buffer you just handed to HMMC/LMMC, or before reading
  VRAM you just wrote with a command.

`op` (for LMMV/LMMM/LMMC/LINE/PSET) is one of the blend operators from
`vdp_reg.h`:

| Constant | Value | Meaning |
|---|---|---|
| `VDP_OP_IMP` | 0x00 | overwrite (same as the "H" commands) |
| `VDP_OP_AND` | 0x01 | AND with destination |
| `VDP_OP_OR` | 0x02 | OR with destination |
| `VDP_OP_XOR` | 0x03 | XOR with destination |
| `VDP_OP_NOT` | 0x04 | NOT of the source |
| `VDP_OP_TIMP` | 0x08 | overwrite, skipping source pixels equal to 0 |
| `VDP_OP_TAND` / `VDP_OP_TOR` / `VDP_OP_TXOR` / `VDP_OP_TNOT` | 0x09-0x0C | AND/OR/XOR/NOT, skipping source pixels equal to 0 |

The `T`-prefixed operators treat color 0 in the source as transparent, which
is how you composite one image over another without a black box around it.

`arg` (for HMMV/HMMM/YMMM/LINE) picks direction, using these constants from
`vdp_reg.h`:

```c
#define VDP_ARG_DIY_DOWN    0
#define VDP_ARG_DIY_UP      8
#define VDP_ARG_DIX_RIGHT   0
#define VDP_ARG_DIX_LEFT    4
#define VDP_ARG_MAJ_H       0 // horizontal
#define VDP_ARG_MAJ_V       1 // vertical
```

Combine them with `+`, as `s_vdpcmd.c` does:

```c
VDP_CommandHMMM_Arg(15, 40, 0+15, 100, 16, 16, VDP_ARG_DIX_LEFT);
VDP_CommandHMMM_Arg(0, 40+15, src->Width/2+1, 100-1, 16, 16, VDP_ARG_DIX_LEFT+VDP_ARG_DIY_UP);
VDP_CommandLINE(X + blockWidth/2, Y + 8, 16, 0, src->Gray, VDP_ARG_DIY_DOWN + VDP_ARG_MAJ_V, VDP_OP_OR); // vertical line
```

`draw.h` builds friendlier shapes on top of the same commands, and needs no
setup beyond `VDP_USE_COMMAND`:

```c
void Draw_Line(UX x1, UY y1, UX x2, UY y2, u8 color, u8 op);
void Draw_LineH(UX x1, UX x2, UY y, u8 color, u8 op);
void Draw_LineV(UX x, UY y1, UY y2, u8 color, u8 op);
void Draw_Box(UX x1, UY y1, UX x2, UY y2, u8 color, u8 op);
void Draw_FillBox(UX x1, UY y1, UX x2, UY y2, u8 color, u8 op);
void Draw_Circle(UX x, UY y, u8 radius, u8 color, u8 op);
void Draw_Point(UX x, UY y, u8 color, u8 op); // literally VDP_CommandPSET(x, y, color, op)
```

They all take the same trailing `op`, so `VDP_OP_OR`, `VDP_OP_TIMP` and so on
work here too.

## The full program

```c
#include "msxgl.h"

//-----------------------------------------------------------------------------
// Program entry point
void main()
{
	// SCREEN 5: 256x212, 16 colors, 4 bits per pixel
	VDP_SetMode(VDP_MODE_SCREEN5);
	VDP_ClearVRAM();

	// Palette: a few custom GRB333 colors (index 0 is left alone, stays black)
	VDP_SetPaletteEntry(1, RGB16(7, 0, 0)); // red
	VDP_SetPaletteEntry(2, RGB16(0, 7, 0)); // green
	VDP_SetPaletteEntry(3, RGB16(0, 0, 7)); // blue
	VDP_SetPaletteEntry(4, RGB16(7, 7, 7)); // white

	// Fill the whole screen in hardware, no CPU pixel loop involved
	VDP_CommandHMMV(0, 0, 256, 212, 0);

	// Draw shapes with the friendly Draw_* helpers
	Draw_Box(8, 8, 247, 203, 4, 0);
	Draw_Circle(128, 106, 60, 1, 0);
	Draw_Line(8, 8, 247, 203, 2, 0);
	Draw_FillBox(100, 90, 156, 122, 3, 0);

	// Or drop to a VDP command directly, e.g. to OR a color into what's there
	VDP_CommandLMMV(112, 96, 32, 20, 4, VDP_OP_OR);

	while (!Keyboard_IsKeyPressed(KEY_ESC))
	{
	}

	BIOS_Exit(0);
}
```

In MSXStudio: create or open a project, set **Machine** to MSX2 (or higher)
and **Library modules** to `system`, `bios`, `vdp`, `draw`, `input` in
Project Settings, paste this into `main.c`, and press Run.

## Try changing it

- Swap `VDP_MODE_SCREEN5` for `VDP_MODE_SCREEN8`. Drop the
  `VDP_SetPaletteEntry` calls (SCREEN 8 has no palette) and pass `RGB8(r, g,
  b)` values instead of palette indices to `Draw_Box`/`Draw_Circle`/etc.
- Change the last `VDP_OP_OR` to `VDP_OP_XOR` or `VDP_OP_TIMP` and see how the
  overlap with the circle changes.
- Add a second `VDP_CommandHMMM` call that copies part of the picture
  somewhere else on screen, then flip `VDP_ARG_DIX_LEFT`/`VDP_ARG_DIY_UP` on
  and off to see the copy direction change.
- Call `VDP_SetPage(1)` before drawing, draw the same scene again with
  different colors, then alternate `VDP_SetPage(0)` / `VDP_SetPage(1)` in the
  main loop for a simple flip-page animation (needs a machine with enough
  VRAM for a second page).

## Gotchas

- `VDP_CommandSRCH`'s own doc comment in `vdp_inl.h` calls it "not
  fonctional" (sic). Do not rely on it.
- `VDP_CommandLMCM` (logical move VRAM to CPU) is an empty function body in
  `vdp_inl.h`, it is not implemented. `s_vdpcmd.c`'s own demo panel for it
  just prints `"xxx"`.
- `vdp_inl.h`'s doc comments for `VDP_ARG_DIY_UP` and `VDP_ARG_DIX_LEFT` say
  `(4)` and `(8)` respectively, but the real `#define`s in `vdp_reg.h` are the
  other way around (`VDP_ARG_DIY_UP` is 8, `VDP_ARG_DIX_LEFT` is 4). Use the
  macro names, not the numbers from the comments.
- `dx`/`nx` (and `sx`/`sy` for HMMM) must be a multiple of 2 in SCREEN 5 and
  SCREEN 7, and a multiple of 4 in SCREEN 6, because those modes pack more
  than one pixel per VRAM byte. SCREEN 8 has no such restriction.
- `VDP_SetPalette` only writes palette indices 1-15 by default; index 0 keeps
  whatever it already had. Turn on `VDP_USE_PALETTE16` in `msxgl_config.h` if
  you need to set index 0 too.
- VDP commands run in the background. If you fire one and immediately reuse
  its source buffer, or read VRAM it just touched, call `VDP_CommandWait()`
  first.
- All of this is guarded by `MSX_VERSION >= MSX_2` in `vdp.h`, so it compiles
  out entirely on an MSX1 target. Set **Machine** to MSX2 or higher in
  Project Settings.
