# Printing text

MSXgl's Print module draws strings, single characters, and numbers to the
screen using a font you pick, in any MSX video mode. This tutorial covers
loading a font (the BIOS font or one of MSXgl's own), positioning and
coloring text, and drawing text, characters, and numbers.

**Sample:** `projects/samples/s_print.c` · **LibModules:** `system`, `bios`, `vdp`, `print`, `input`, `memory`, `math`, `draw`, `tool/kanji` (base list from `project_config.js`, plus `tool/kanji` which `s_print.js` adds only for the sample's Kanji-ROM demo page) · **Machine:** MSX2 and up (`Machine = "2"` in `project_config.js`; the sample cycles through GRAPHIC4-7 bitmap screens, which don't exist on MSX1)

## What it does

`s_print.c` is a browsable demo, not a single flow: F1-F4 switch between four
pages (font list, font sample + long paragraph, print effects, Kanji-ROM
test), the arrow keys cycle through 15 bundled fonts and four screen modes
(GRAPHIC4/5/6/7), and the effects page shows multi-color text, shadow,
outline, a VRAM-backed font, and a sprite-backed font.

This tutorial sticks to the core every one of those pages relies on:

1. Pick a font, BIOS or custom, and hand it to the Print module.
2. Position the cursor.
3. Draw text, single characters, and numbers.
4. Set colors.
5. Know what changes when you move between text modes (SCREEN 0/1) and
   graphic modes (SCREEN 5-8).

Effects (shadow, outline, VRAM/sprite fonts) and the Kanji demo are out of
scope here; they build on the same API once you're comfortable with it.

## Walking through it

### Loading a font: BIOS vs custom

There are two families of screen mode, and MSXgl gives you a different
"set the font" call for each.

In **text/tile modes** (SCREEN 0, 1, 2, 3, 4; `VDP_MODE_TEXT1/GRAPHIC1/
GRAPHIC2/MULTICOLOR/GRAPHIC3`), characters are pattern indices written into
the name table, so the font has to be uploaded into the VDP's pattern
generator table first. That's `Print_SetTextFont`:

```c
VDP_SetMode(VDP_MODE_SCREEN0); // Initialize screen mode 0 (text)
VDP_ClearVRAM();

Print_SetTextFont(PRINT_DEFAULT_FONT, 1); // Initialize font (use BIOS font)
Print_DrawText("Hello MSX world!");
```

(`s_hello.c`, MSXStudio's own hello-world sample.) `PRINT_DEFAULT_FONT` is
just `#define PRINT_DEFAULT_FONT NULL`, and passing it tells `Print_SetTextFont`
to reuse the character set already sitting in the BIOS ROM (`g_CGTABL`)
instead of uploading your own data. The `1` is the pattern index where the
font gets stored in VRAM.

In **bitmap modes** (SCREEN 5-8; `VDP_MODE_GRAPHIC4/5/6/7`), there is no
pattern table: each character is unpacked and blitted straight into the
bitmap. That's `Print_SetBitmapFont`, which needs `PRINT_USE_BITMAP` set in
`msxgl_config.h` (MSXStudio's MSX2 project template already has it `TRUE`;
the MSX1 template leaves it `FALSE`, since MSX1 hardware has no bitmap
screens to draw into):

```c
VDP_SetMode(VDP_MODE_SCREEN5);
VDP_SetColor(COLOR_BLACK);
VDP_ClearVRAM();

Print_SetBitmapFont(g_Font_MGL_Sample6);
```

(`projects/template_msx2/template.c`, what a new MSXStudio MSX2 project
starts from.) `g_Font_MGL_Sample6` comes from
`#include "font/font_mgl_sample6.h"`. MSXgl ships around 50 fonts under
`engine/content/font/` in the MSXgl checkout: `font_mgl_std0.h` (6x8),
`font_mgl_big1.h` (8x11), `font_carwar.h`, `font_darkrose.h`,
`font_bios_latin.h`, and more. Every one of them is a byte array with a
4-byte header (character width/height, display width/height, first
character code, last character code) followed by the pattern data.
`Print_SetFont` reads exactly that layout, so any font header from that
folder works with `Print_SetBitmapFont`/`Print_SetFont` unmodified.

`Print_SetFont(font)` is the lower-level call both of the above end up
using: it only loads the font data, it does **not** call `Print_Initialize`
for you. If you call it directly (to switch fonts mid-program, the way
`PrintList()` in `s_print.c` does when cycling through the font table), make
sure `Print_Initialize()` already ran once after `VDP_SetMode()`.

### Positioning

```c
Print_SetPosition(0, 0);
```

`Print_SetPosition(x, y)` moves the draw cursor. The unit depends on the
mode family: in text/tile modes it's **character cells** (0-39 / 0-31
depending on the mode's column count), in bitmap modes it's **pixels**
(0-255 or 0-511). `Print_SetPositionX`/`Print_SetPositionY` set one axis at
a time, and `Print_Return()` acts like a newline (cursor back to column 0,
down one character row).

### Drawing text, characters, and numbers

```c
Print_DrawText("MSXgl - PRINT SAMPLE (");
Print_DrawText(g_Modes[g_ModeIndex].Name);
Print_DrawText(")");
```

`Print_DrawText(str)` draws a null-terminated string at the cursor and
advances it. `s_print.c` also draws single characters, looping over every
glyph the current font defines:

```c
const struct Print_Data* data = Print_GetFontInfo();
for (u16 i = data->CharFirst; i <= data->CharLast; ++i)
	Print_DrawChar(i);
```

`Print_GetFontInfo()` returns the active `Print_Data`, whose `CharFirst`/
`CharLast` are the first/last ASCII codes the current font covers (parsed
straight from that 4-byte font header). `Print_DrawChar(chr)` draws one
character; `Print_DrawCharX(chr, num)` repeats the same character `num`
times.

For numbers, `s_print.c` uses:

```c
Print_DrawText("Ku: ");
Print_DrawInt(g_KuBase);
```

`Print_DrawInt` prints a signed decimal integer: `i32` if
`PRINT_USE_32B` is `TRUE` in `msxgl_config.h` (both MSXStudio templates
default it `TRUE`), otherwise `i16`. `print.h` also declares
`Print_DrawHex8(u8)`, `Print_DrawHex16(u16)`, `Print_DrawBin8(u8)` (always
available), and `Print_DrawHex32(u32)` (needs `PRINT_USE_32B`). None of
these are exercised by `s_print.c`, but their signatures are real and
declared right next to `Print_DrawInt`. If you need to mix text and numbers
in one call, `Print_DrawFormat("Score: %d  HP: %d\n", score, hp)` is also
available (needs `PRINT_USE_FORMAT`, `TRUE` by default) and understands
`%d`/`%i`, `%u`, `%x`, `%c`, `%s`, `%D`/`%U`/`%X` (32-bit versions), `\t` and
`\n`.

### Colors

```c
Print_SetColor(g_Modes[g_ModeIndex].ColorText, g_Modes[g_ModeIndex].ColorBG);
```

`Print_SetColor(text, bg)` sets the ink and paper colors used for
everything drawn after it: same call in every mode, but what it actually
touches is very different depending on the mode:

- **SCREEN 0** (both 40- and 80-column text mode): one color pair for the
  *whole screen*, written straight to the VDP color register. No
  per-character color.
- **SCREEN 1**: one color pair per group of 8 consecutive tile indices.
- **SCREEN 2/4**: one color pair per character, stored per 8-pixel row.
- **SCREEN 5-8** (bitmap): drawn pixel by pixel, so text can be colored
  freely, including per output call.

Colors are the 16-entry MSX palette index (`COLOR_BLACK` = 1, `COLOR_WHITE`
= 15, from `color.h`, already pulled in by `msxgl.h`) in every mode except
SCREEN 8/GRAPHIC7, where the VDP has no fixed palette and `Print_SetColor`
expects an 8-bit RGB value built with `RGB8(r, g, b)` instead (`s_print.c`
uses `COLOR8_WHITE`/`COLOR8_BLACK`, which are just `RGB8(7,7,3)`/`RGB8(0,0,0)`,
for its GRAPHIC7 page).

## The full program

```c
#include "msxgl.h"

#include "font/font_mgl_sample6.h"

//-----------------------------------------------------------------------------
// Program entry point
void main()
{
	VDP_SetMode(VDP_MODE_SCREEN5); // Graphic 4: 256x212, 16 colors
	VDP_SetColor(COLOR_BLACK);
	VDP_EnableVBlank(TRUE);
	VDP_ClearVRAM();

	Print_SetBitmapFont(g_Font_MGL_Sample6);
	Print_SetColor(COLOR_WHITE, COLOR_BLACK);

	Print_SetPosition(0, 0);
	Print_DrawText("MSXgl - PRINT TUTORIAL");

	Print_SetPosition(0, 20);
	Print_DrawText("Chars: ");
	const struct Print_Data* font = Print_GetFontInfo();
	for (u16 i = font->CharFirst; i <= font->CharLast; ++i)
		Print_DrawChar(i);

	Print_SetPosition(0, 200);
	Print_DrawText("Score: ");
	Print_DrawInt(1234);
	Print_DrawText("  Hex: ");
	Print_DrawHex8(0xA5);

	while (!Keyboard_IsKeyPressed(KEY_ESC))
	{
		Halt(); // Wait V-Blank
	}

	BIOS_Exit(0);
}
```

This drops straight into a new MSXStudio MSX2 project: Project Settings
already lists `system`, `bios`, `vdp`, `print`, `input`, `memory` after
**New Project**, which is everything this needs. Replace `main.c` with the
code above and press Run.

## Try changing it

- Switch to text mode: replace the top of `main` with
  `VDP_SetMode(VDP_MODE_SCREEN0); Print_SetTextFont(PRINT_DEFAULT_FONT, 1);`
  and drop the `Print_SetBitmapFont` line, then compare how `Print_SetPosition`
  now moves in character cells, and how `Print_SetColor` recolors the whole
  screen instead of just your text.
- Try a different bundled font: `#include "font/font_mgl_std0.h"` and pass
  `g_Font_MGL_Std0` to `Print_SetBitmapFont` instead. It's a smaller 6x8
  font, so the same text takes less screen space.
- Print a live value instead of a literal: swap `Print_DrawInt(1234)` for a
  counter you increment once per frame inside the `Halt()` loop.
- Give each line its own color: call `Print_SetColorShade(shadeArray)`
  (needs `PRINT_COLOR_NUM > 1` in `msxgl_config.h`; the MSX2 template sets
  it to 12) with a `u8[12]` of palette indices, one per pixel row of the
  font, for a gradient effect like the "Multi-color" demo on `s_print.c`'s
  effects page.

## Gotchas

- `Print_SetFont()` alone doesn't call `Print_Initialize()`. Call
  `Print_Initialize()` once after `VDP_SetMode()`, then `Print_SetFont()` as
  many times as you like to switch fonts. `Print_SetBitmapFont`/
  `Print_SetTextFont`/`Print_SetVRAMFont` call `Print_Initialize()` for you,
  so if you're using one of those you don't need a separate call.
- Cursor units are not the same across modes: character cells in text/tile
  modes, pixels in bitmap modes. Code that positions text by pixel math will
  misplace everything if the project later switches from a bitmap mode to
  SCREEN 0/1.
- `Print_SetColor`'s reach shrinks the further you get from bitmap modes:
  whole-screen in SCREEN 0, 8-tile groups in SCREEN 1, per-character in
  SCREEN 2/4, per-pixel only in SCREEN 5-8. Setting a color per character in
  a loop does nothing useful in SCREEN 0 or SCREEN 1.
- `Print_SetBitmapFont`, `Print_SetVRAMFont`, and `Print_SetSpriteFont` are
  compiled in only if `PRINT_USE_BITMAP`, `PRINT_USE_VRAM`, and
  `PRINT_USE_SPRITE` are `TRUE` in `msxgl_config.h`. MSXStudio's MSX2
  project template enables all three; the MSX1 template leaves them `FALSE`
  since GRAPHIC4-7 don't exist on MSX1 hardware.
- The BIOS font (`PRINT_DEFAULT_FONT`/`NULL`) only covers ASCII codes 1-255
  and is fixed size (6x8 pixels via `Print_SetFont`, one character cell via
  `Print_SetTextFont`). You can't resize or recolor individual glyphs in
  it beyond what `Print_SetColor`'s mode-dependent granularity allows.
