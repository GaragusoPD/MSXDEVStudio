# Sprites on MSX2 (mode 2)

MSX2 and up replace the MSX1 sprite hardware with a much more flexible one:
sprite mode 2 gives every sprite a color per scanline instead of one flat
color, and lets two overlapping sprites blend their colors together.

**Sample:** `projects/samples/s_sprite.c` · **LibModules:** `system`, `bios`, `vdp` · **Machine:** MSX2 and up

## What mode 2 adds

| | Mode 1 (MSX1) | Mode 2 (MSX2+) |
|---|---|---|
| Color | One color for the whole sprite (`VDP_SetSpriteSM1`) | One color per line, up to 16 lines (`VDP_SetSprite`, `VDP_SetSpriteExUniColor`, `VDP_SetSpriteExMultiColor`) |
| Sprites total | 32 | 32 |
| Sprites per scanline | 4 | 8 |
| Extra per-line flags | EC only | EC, CC, IC |

The sprite count (32) does not change. What changes is how many can share
one scanline (8 instead of 4) and how color is attached to a sprite: instead
of one 4-bit color value for the whole shape, mode 2 gives you a 16-byte
table, one color byte per line, and each of those bytes can carry its own
EC/CC/IC flags.

## Setting up the sprite tables

Sprites read from three VRAM tables: the pattern table (the shapes), the
attribute table (position + shape index per sprite), and, in mode 2 only,
a color table (one 16-byte color line-list per sprite). You only ever set
the first two; the engine derives the color table address for you.

```c
VDP_SetMode(VDP_MODE_SCREEN5);     // SCREEN 5 = GRAPHIC 4; sprite mode 2 works on SCREEN 4 and up
VDP_EnableSprite(TRUE);
VDP_SetSpritePatternTable(VDP_G4_ADDR_SPT);   // 0x7800, SCREEN 5's default
VDP_SetSpriteAttributeTable(VDP_G4_ADDR_SAT); // 0x7600, SCREEN 5's default
VDP_SetSpriteFlag(VDP_SPRITE_SIZE_8);         // or VDP_SPRITE_SIZE_16
```

`VDP_SetMode` already points the tables at these default addresses, so the
two calls above are shown to make the setup explicit; you only need to call
them again if you want the tables somewhere else.

On MSX1, VRAM addresses are 14-bit (max 16KB). MSX2 can have up to 128KB of
VRAM, so table addresses become 17-bit values behind the scenes: MSXgl's
`VADDR` type grows from `u16` to `u32` and the extra bit is written to VDP
register 11 for you. You still just pass a plain number. `s_sprite.c` uses
this to push its tables into the second 64KB bank, clear of the SCREEN 5
bitmap in the first bank:

```c
VDP_SetSpritePatternTable(0x17000);
VDP_SetSpriteAttributeTable(0x17A00);
```

Whichever address you pick for the attribute table, `VDP_SetSpriteAttributeTable`
also places the mode 2 color table for you, always exactly 512 bytes before
it. You never set the color table address directly.

## Per-line colors

Each color byte in mode 2 packs a 4-bit color index (0 = transparent) plus
three flags:

```c
#define VDP_SPRITE_EC   0x80   // Early clock: offset this line 32 dots to the left
#define VDP_SPRITE_CC   0x40   // Sprite priority control (color blending, see next section)
#define VDP_SPRITE_IC   0x20   // Line collision detection
```

`VDP_SetSpriteExMultiColor(index, x, y, shape, ram)` writes a sprite's
position and shape, and copies `ram` (16 bytes, one per line) into its color
table entry. You must pass 16 bytes even for an 8x8 sprite; only the first 8
are used, but the hardware reserves 16 bytes per sprite slot regardless of
size.

```c
// One color per line (16 bytes required even for an 8x8 sprite)
const u8 g_RainbowColors[16] =
{
    COLOR_LIGHT_RED,
    COLOR_LIGHT_YELLOW,
    COLOR_LIGHT_YELLOW,
    COLOR_MEDIUM_GREEN,
    COLOR_MEDIUM_GREEN,
    COLOR_CYAN,
    COLOR_CYAN,
    COLOR_LIGHT_BLUE,
    0, 0, 0, 0, 0, 0, 0, 0
};

VDP_SetSpriteExMultiColor(0, 40, 90, 0, g_RainbowColors);
```

That is a ball that is red at the top and blue at the bottom, one flat band
of color per scanline. If every line needs the same color, use
`VDP_SetSpriteExUniColor(index, x, y, shape, color)` instead: it fills all
16 lines with a single color byte, which can still carry EC/CC/IC.

EC and IC are set the same way, OR'd into a color byte: `VDP_SPRITE_EC | 5`
nudges that one line 32 dots left (historically used to let a sprite hang
off the left edge without a negative X coordinate). `VDP_SPRITE_IC | 5`
opts that line into the sprite collision flag read back with
`VDP_ReadDefaultStatus()`; leave it off any line you don't want counted
(background decoration, for example).

## Layering sprites for more colors

CC ("sprite priority control") is what turns two single-color-per-line
sprites into a multicolor character. Sprites are drawn in index order,
sprite 0 on top, sprite 31 at the back. Normally, where two sprites overlap,
only the higher-priority (lower index) one shows. If the lower-priority
sprite's line has CC set, the VDP instead OR's the two color indices
together and shows that as the pixel's color, a third, distinct index.

`s_sprite.c` demonstrates it like this:

```c
VDP_SetPaletteEntry(2, RGB16(7, 7, 7));
VDP_SetPaletteEntry(3, RGB16(6, 4, 1));
VDP_SetSpriteExUniColor(SPRITE_16OR_1ST + 0, (u8)128, 32, PATTERN_16OR_1ST + 0 * 4, 0x02);
VDP_SetSpriteExUniColor(SPRITE_16OR_1ST + 1, (u8)128, 32, PATTERN_16OR_1ST + 6 * 4, VDP_SPRITE_CC + 0x01);
```

The first sprite (lower index, drawn on top) uses color 2, no CC. The second
sprite (higher index, drawn behind, same position) uses color 1 with
`VDP_SPRITE_CC` set. Wherever both sprites have an opaque pixel at the same
spot, `2 | 1 = 3` is shown, and palette entry 3 was set to its own RGB value
(`RGB16(6, 4, 1)`), a color that is neither sprite's own color 1 or 2.
Wherever only one of the two sprites has a pixel, that sprite's own color
shows as usual. Stack up to four sprites this way (the practical limit of
one logical multicolor character) for richer characters than 16 palette
entries alone would allow.

The composite index is just a number the VDP computed for you; it is your
job to give it a sensible RGB value with `VDP_SetPaletteEntry`, otherwise it
shows whatever color already happened to be sitting in that palette slot.

## The full program

```c
#include "msxgl.h"
#include "bios.h"

// A filled 8x8 disk, used both as the rainbow ball and as the bottom
// layer of the composite-color demo.
const u8 g_DiskPattern[8] =
{
	0b00111100,
	0b01111110,
	0b11111111,
	0b11111111,
	0b11111111,
	0b11111111,
	0b01111110,
	0b00111100,
};

// A small dot, used as the top layer of the composite-color demo.
// Every set pixel here sits inside the disk above.
const u8 g_DotPattern[8] =
{
	0b00000000,
	0b00000000,
	0b00111100,
	0b00111100,
	0b00111100,
	0b00111100,
	0b00000000,
	0b00000000,
};

// One color per line (16 bytes required even for an 8x8 sprite)
const u8 g_RainbowColors[16] =
{
	COLOR_LIGHT_RED,
	COLOR_LIGHT_YELLOW,
	COLOR_LIGHT_YELLOW,
	COLOR_MEDIUM_GREEN,
	COLOR_MEDIUM_GREEN,
	COLOR_CYAN,
	COLOR_CYAN,
	COLOR_LIGHT_BLUE,
	0, 0, 0, 0, 0, 0, 0, 0
};

void main()
{
	if (Sys_GetMSXVersion() == MSXVER_1)
	{
		BIOS_ClearScreen();
		BIOS_TextPrint("This sample needs MSX2 or above");
		BIOS_GetCharacter();
		return;
	}

	// SCREEN 5 (GRAPHIC 4): the lowest-numbered mode with sprite mode 2
	VDP_SetMode(VDP_MODE_SCREEN5);
	VDP_SetColor(COLOR_BLACK);
	VDP_CommandHMMV(0, 0, 256, 212, COLOR_MERGE(COLOR_BLACK, COLOR_BLACK));
	VDP_CommandWait();

	VDP_EnableSprite(TRUE);
	VDP_SetSpritePatternTable(VDP_G4_ADDR_SPT);
	VDP_SetSpriteAttributeTable(VDP_G4_ADDR_SAT);
	VDP_SetSpriteFlag(VDP_SPRITE_SIZE_8);

	VDP_LoadSpritePattern(g_DiskPattern, 0, 1); // pattern 0: disk
	VDP_LoadSpritePattern(g_DotPattern, 1, 1);  // pattern 1: dot

	// Sprite 0: rainbow ball, one color per line
	VDP_SetSpriteExMultiColor(0, 40, 90, 0, g_RainbowColors);

	// Sprites 1 and 2: layered for a third color where they overlap
	VDP_SetPaletteEntry(1, RGB16(0, 0, 7)); // blue
	VDP_SetPaletteEntry(2, RGB16(7, 0, 0)); // red
	VDP_SetPaletteEntry(3, RGB16(7, 7, 0)); // 1 | 2, the blend the VDP computes for us

	VDP_SetSpriteExUniColor(1, 150, 90, 0, 1);                 // bottom: blue disk, no CC
	VDP_SetSpriteExUniColor(2, 150, 90, 1, VDP_SPRITE_CC | 2); // top: red dot, CC set

	VDP_DisableSpritesFrom(3); // hide the other 29 sprite slots

	BIOS_GetCharacter(); // wait for a key
	BIOS_Exit(0);
}
```

## Try changing it

- Edit `g_RainbowColors` to try other `COLOR_*` values, or set fewer than 8
  entries to a color and leave the rest 0 (transparent) for a two-tone ball.
- Swap the palette RGB values for entries 1-3 and watch the overlap color
  change without touching a single sprite call.
- Shrink `g_DotPattern` to a 2x2 square instead of 4x4 (clear more of the
  middle rows/columns) to make the overlap area smaller.
- Switch to 16x16 sprites: `VDP_SetSpriteFlag(VDP_SPRITE_SIZE_16)`, patterns
  become 32 bytes each, and shape indices must be a multiple of 4.
- Add `VDP_SPRITE_IC` to a line in `g_RainbowColors` and read
  `VDP_ReadDefaultStatus()` in your main loop to see the collision flag.

## Using your own art

Hand-writing pattern bytes and color arrays works for a tutorial, but for
real sprites use the **Sprites** editor in MSXStudio: pick mode 2, draw on
the composite canvas, and use the per-layer line-color strip on the right
to paint each line's color and toggle its EC/CC bits. Stack up to 4 layers
per sprite for multicolor characters exactly like the disk-and-dot example
above, the editor's preview shows the OR-blended result live.

Exporting a sprite resource named `Hero` generates `content/hero.h` with
`g_Hero_Patterns`, `g_Hero_Colors` (16 color bytes per layer, ready for
`VDP_SetSpriteExMultiColor`), and `g_Hero_Palette`:

```c
#include "content/hero.h"

VDP_SetPalette(g_Hero_Palette);
VDP_LoadSpritePattern(g_Hero_Patterns, 0, 1);
VDP_SetSpriteExMultiColor(0, x, y, 0, g_Hero_Colors);
```

See `../resources.md` for the full export and loading workflow shared by
every editor.

## Gotchas

- The mode 2 color table always reserves 16 bytes per sprite slot, even for
  8x8 sprites. `VDP_SetSpriteExMultiColor` and `VDP_SetSpriteMultiColor`
  both expect a full 16-byte buffer.
- CC belongs on the *lower-priority* sprite of a layered pair (the one with
  the higher index, drawn behind). Setting it on the top sprite instead
  does nothing useful.
- A composite color from CC is just an index; if you never call
  `VDP_SetPaletteEntry` for it, it shows whatever color already happens to
  be in that palette slot.
- Call `VDP_SetSpriteAttributeTable` before loading any colors: it also
  repositions the color table (512 bytes before it), so colors written
  before the tables are (re)placed end up in the wrong spot.
- Past 8 sprites on one scanline, the lowest-priority ones among them (the
  highest indices) simply do not draw on that line, there is no blinking or
  dimming.
- Always call `VDP_DisableSpritesFrom()` past your last used index. Leftover
  VRAM bytes from a previous screen can otherwise show up as stray sprites.
