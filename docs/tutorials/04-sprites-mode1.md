# Sprites on MSX1 (mode 1)

Hardware sprites let you move graphics around the screen without touching the
background, and the VDP does the positioning and priority work for you.

**Sample:** `projects/samples/s_sm1.c` · **LibModules:** default set - `system`, `bios`, `vdp`, `print`, `input`, `memory` (no additions needed) · **Machine:** MSX1 and up

## How MSX1 sprites work

MSX1's video chip (the TMS9918A) supports **sprite mode 1**: up to 32 sprites,
each either 8x8 or 16x16 pixels, each drawn in a single colour. Two VRAM
tables drive them:

- The **sprite pattern table** holds the sprite shapes, 8 bytes per 8x8
  pattern (one byte per row, one bit per pixel), the same format as
  background tile patterns.
- The **sprite attribute table** (SAT) holds, for each of the 32 sprite
  slots, 4 bytes: Y, X, pattern index and colour.

You point the VDP at these tables with `VDP_SetSpritePatternTable(addr)` and
`VDP_SetSpriteAttributeTable(addr)`. Calling `VDP_SetMode()` already sets both
to sensible defaults for the mode (`VDP_G2_ADDR_SPT` / `VDP_G2_ADDR_SAT` for
GRAPHIC2, for example), so the calls are only needed if you want to move a
table somewhere else in VRAM.

Sprite size and zoom are set together with `VDP_SetSpriteFlag()`:

```c
VDP_SetSpriteFlag(VDP_SPRITE_SIZE_8);                       // 8x8, normal size (default)
VDP_SetSpriteFlag(VDP_SPRITE_SIZE_16);                       // 16x16
VDP_SetSpriteFlag(VDP_SPRITE_SIZE_16 | VDP_SPRITE_SCALE_2);  // 16x16, doubled to 32x32 on screen
```

`VDP_SPRITE_SCALE_1` (normal) and `VDP_SPRITE_SCALE_2` (double every pixel)
apply to whichever size you picked; magnification never changes how many
patterns a sprite uses, only how big each dot is drawn.

A note on `VDP_EnableSprite()`: in MSXgl it toggles register R#8, which only
exists on the V9938 (MSX2) VDP. It is compiled out on a plain MSX1 target
(`Machine = "1"`), so don't call it there - real MSX1 sprites are simply
always on. If your project targets MSX2 and up, `VDP_EnableSprite(TRUE)` /
`VDP_EnableSprite(FALSE)` work as expected.

## Loading sprite patterns

Load pattern bytes into the sprite pattern table with:

```c
void VDP_LoadSpritePattern(const u8* addr, u8 index, u8 count);
```

- `addr` - pointer to the pattern bytes in RAM/ROM.
- `index` - first pattern slot to write to.
- `count` - how many patterns to copy: 1 per 8x8 sprite shape, 4 per 16x16
  sprite shape (a 16x16 sprite is stored as four 8x8 quarters - top-left,
  bottom-left, top-right, bottom-right - 8 bytes each, 32 bytes total).

```c
VDP_LoadSpritePattern(g_MySprite, 0, 1);   // one 8x8 shape at slot 0
VDP_LoadSpritePattern(g_MySprite, 0, 4);   // one 16x16 shape, slots 0-3
```

In 16x16 mode, `index` (and the `shape` you pass when placing the sprite)
must be a multiple of 4.

## Placing and moving sprites

Place or update a sprite with:

```c
void VDP_SetSpriteSM1(u8 index, u8 x, u8 y, u8 shape, u8 color);
```

- `index` - sprite slot, 0 to 31. Slot order is also draw priority: slot 0
  is drawn on top of slot 1, and so on.
- `x`, `y` - top-left corner of the sprite, in pixels.
- `shape` - pattern index, the same value you passed to `VDP_LoadSpritePattern`.
  For 16x16 sprites this must be a multiple of 4: the first 16x16 shape you
  loaded is `shape = 0`, the second is `shape = 4`, the third `shape = 8`,
  and so on, since each shape consumes 4 pattern slots.
- `color` - 4-bit colour index (0-15). You can OR in `VDP_SPRITE_EC` to shift
  the sprite 32 dots to the left (the "early clock" bit), useful for easing a
  sprite in from the left edge of the screen.

```c
VDP_SetSpriteSM1(0, 100, 80, 0, COLOR_LIGHT_YELLOW);
```

The Y value has a classic TMS9918A quirk: the VDP actually draws the sprite
one line below the Y you store. Normally you never notice it, but it means
`y = 255` (which wraps to -1) places the sprite's top row exactly on screen
row 0 - handy for letting a sprite scroll smoothly in from above the visible
area.

To move a sprite, just call `VDP_SetSpriteSM1` again each frame with new
`x`/`y`.

To hide sprites, use `VDP_DisableSpritesFrom(index)`:

```c
void VDP_DisableSpritesFrom(u8 index);
```

It writes a magic Y coordinate that disables the given sprite **and every
sprite after it** in the table (slot order matters here too). To hide a
single sprite without affecting the others, set its Y to `VDP_SPRITE_HIDE`
(213) instead, e.g. via `VDP_SetSpritePositionY(index, VDP_SPRITE_HIDE)`.

## The full program

```c
#include "msxgl.h"

//=============================================================================
// DEFINES
//=============================================================================

#define VRAM_SPRITE_PATTERN	VDP_G2_ADDR_SPT
#define VRAM_SPRITE_ATTRIBUTE	VDP_G2_ADDR_SAT

//=============================================================================
// DATA
//=============================================================================

// 8x8 ball sprite pattern, 1 byte per row, 1 bit per pixel
const u8 g_BallPattern[8] =
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

u8 g_VBlank = 0;
u8 g_X = 100;
u8 g_Y = 100;

//=============================================================================
// HELPERS
//=============================================================================

// H_TIMI interrupt hook, called once per frame
void VBlankHook()
{
	g_VBlank = 1;
}

// Wait for the next V-Blank
void WaitVBlank()
{
	while (g_VBlank == 0) {}
	g_VBlank = 0;
}

//=============================================================================
// MAIN
//=============================================================================

void main()
{
	// Screen setup
	VDP_SetMode(VDP_MODE_GRAPHIC2);
	VDP_SetColor(COLOR_BLACK);
	VDP_FillVRAM_16K(0, 0x0000, 0x4000); // clear 16 KB of VRAM

	// Sprite tables (GRAPHIC2 defaults, set here for clarity)
	VDP_SetSpritePatternTable(VRAM_SPRITE_PATTERN);
	VDP_SetSpriteAttributeTable(VRAM_SPRITE_ATTRIBUTE);
	VDP_SetSpriteFlag(VDP_SPRITE_SIZE_8);

	// Load the pattern and place the sprite
	VDP_LoadSpritePattern(g_BallPattern, 0, 1);
	VDP_SetSpriteSM1(0, g_X, g_Y, 0, COLOR_LIGHT_YELLOW);
	VDP_DisableSpritesFrom(1); // only slot 0 is used

	// Start the frame timer
	BIOS_SetHookCallback(H_TIMI, VBlankHook);
	VDP_EnableVBlank(TRUE);

	while (TRUE)
	{
		WaitVBlank();

		if (Keyboard_IsKeyPressed(KEY_RIGHT)) g_X++;
		if (Keyboard_IsKeyPressed(KEY_LEFT))  g_X--;
		if (Keyboard_IsKeyPressed(KEY_DOWN))  g_Y++;
		if (Keyboard_IsKeyPressed(KEY_UP))    g_Y--;

		VDP_SetSpriteSM1(0, g_X, g_Y, 0, COLOR_LIGHT_YELLOW);
	}
}
```

## Try changing it

- Swap `COLOR_LIGHT_YELLOW` for another `COLOR_*` value and see the ball
  change colour.
- Draw a second 8x8 pattern, load it at slot 1 with
  `VDP_LoadSpritePattern(g_OtherPattern, 1, 1)`, and call `VDP_SetSpriteSM1`
  a second time with `index = 1` and its own `x`/`y` to get a second sprite
  on screen (remember to move `VDP_DisableSpritesFrom(1)` down to `(2)`).
- Switch to a 16x16 sprite: change the flag to
  `VDP_SetSpriteFlag(VDP_SPRITE_SIZE_16)`, extend `g_BallPattern` to 32 bytes,
  and load it with `VDP_LoadSpritePattern(g_BallPattern, 0, 4)`.
- Add `VDP_SPRITE_SCALE_2` to the flag and watch the same pattern draw twice
  as big.
- Instead of moving with the cursor keys, animate `g_X`/`g_Y` automatically
  each frame (e.g. bounce between two edges) for a simple demo loop.

## Using your own art

Hand-typed pixel bytes get old fast. Draw the sprite in MSXStudio's **Sprite
editor** instead: create a `name.sprites.json` resource, pick mode 1, draw
your 8x8 or 16x16 frames, then export it. That generates a header with
`g_Name_Patterns` (the pattern bytes, ready for `VDP_LoadSpritePattern`) and
`g_Name_Colors` (one colour byte per sprite/frame in mode 1):

```c
#include "content/myhero.h"

VDP_LoadSpritePattern(g_MyHero_Patterns, 0, 1);            // 8x8: 1 pattern per frame
VDP_SetSpriteSM1(0, g_X, g_Y, 0, g_MyHero_Colors[0]);       // frame 0's colour
```

See [Resources](../resources.md) for how the editors and exports work.

## Gotchas

- **4 sprites per scanline.** The TMS9918A can only draw 4 sprites on any
  single horizontal line; a 5th sprite on that line simply doesn't render
  (it flickers if you shuffle slot order over time, which is why the sample
  has a "flip SAT" mode). Keep this in mind once you have more than a
  handful of sprites moving around.
- **One colour per sprite in mode 1.** Every pixel of a mode-1 sprite is
  drawn in the same `color`; there's no per-line colour like MSX2's sprite
  mode 2 offers. The way round it is *superposition*: draw the character as
  two or more sprites on the same coordinate, each holding the pixels of one
  colour. MSXStudio's sprite editor calls those layers, tells you what the
  stack costs against the 4-per-line limit, and — with **Export ready-made
  C** ticked — writes a `_SetMeta()` that places every plane from one x/y.
  The [demo game](../../demo_project/) uses it for its two-colour player.
- **A character can be bigger than one sprite.** Several sprites side by
  side and stacked, moved together, is how a 32x32 character works on this
  hardware. The sprite editor's *character grid* models that directly, and
  the same `_SetMeta()` places the whole group; see the [resources
  guide](../resources.md).
- **32 sprites total**, indices 0-31, and slot order is draw priority
  (lower index drawn on top) as well as the order `VDP_DisableSpritesFrom`
  cuts off from.
- **16x16 shape indices must be multiples of 4** - both the `index` you pass
  to `VDP_LoadSpritePattern` and the `shape` you pass to `VDP_SetSpriteSM1`.
- **`VDP_EnableSprite`/`VDP_DisableSprite` need MSX2.** On a `Machine = "1"`
  project they aren't even compiled in; use `VDP_DisableSpritesFrom(0)` (or
  hide sprites individually) to turn sprites off on MSX1.
