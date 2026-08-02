# Hello world

You will end up with a program that clears the screen, prints `Hello MSX world!`
in text mode, and sits there until you press ESC to quit.

**Sample:** `projects/samples/s_hello.c` · **LibModules:** `system`, `bios`, `vdp`, `print`, `input` · **Machine:** MSX1 and up

## What it does

1. Switches the VDP to SCREEN 0 (40-column text mode).
2. Clears VRAM so the screen starts blank.
3. Loads a font and prints one line of text.
4. Loops forever, doing nothing, until ESC is pressed.

That's the whole program: no sprites, no game loop timing, no input beyond
one key check. It's the minimum that gets pixels (well, characters) on
screen.

## Walking through it

```c
#include "msxgl.h"
```

`msxgl.h` is the one header nearly every MSXgl program includes. It doesn't
add code by itself, it just pulls in the declarations for every engine
module (`system.h`, `bios.h`, `vdp.h`, `print.h`, `input.h`, `memory.h`,
`math.h`, `color.h`, and more) so you don't have to remember which header
declares which function. What actually gets **compiled and linked** into
your ROM is controlled separately, by the `LibModules` list in Project
Settings. Include the header for convenience; the LibModules list is what
decides the final program size.

```c
void main()
{
```

This is the program entry point. MSXgl programs don't have the `int main(int
argc, char** argv)` shape you'd write on a PC: on bare MSX hardware there's
no OS to pass you arguments, so `main` takes nothing and returns nothing.

```c
	VDP_SetMode(VDP_MODE_SCREEN0); // Initialize screen mode 0 (text)
	VDP_ClearVRAM();
```

`VDP_SetMode` configures the video chip for a given screen mode.
`VDP_MODE_SCREEN0` is BASIC's familiar SCREEN 0: 40 columns of text, one
fixed color per character, no sprites. It's the simplest mode to get running
on any MSX. `VDP_ClearVRAM` wipes the whole 16KB of video RAM to zero. VRAM
is not cleared automatically on startup or on a mode switch: old pattern
data can be sitting in there from before, so you clear it explicitly before
drawing anything.

```c
	Print_SetTextFont(PRINT_DEFAULT_FONT, 1); // Initialize font (use BIOS font)
	Print_DrawText("Hello MSX world!");
```

The print module doesn't know how to draw characters until you give it a
font. `Print_SetTextFont` takes a pointer to font data and uploads it into
VRAM; passing `PRINT_DEFAULT_FONT` (which is just `NULL`) tells it to reuse
the character set already sitting in the MSX's BIOS ROM instead of shipping
your own font data. The second argument, `1`, is the pattern offset: the
VRAM slot number where the font starts being stored. Once a font is set,
`Print_DrawText` writes a string at the current cursor position (top-left by
default) using it.

```c
	while(!Keyboard_IsKeyPressed(KEY_ESC))
	{
	}
}
```

A busy loop: the CPU spins here, checking the keyboard every iteration,
until `Keyboard_IsKeyPressed(KEY_ESC)` returns true. This is the simplest
possible "wait for the user" loop. It works, but it burns 100% of the CPU
for nothing, and it has no notion of timing (nothing here is tied to the
screen's refresh rate). It's fine for a hello-world that has nothing else to
do. The moment you're animating anything, you want a frame-paced loop
instead.

**Busy loop vs `Halt()` sync.** Most real MSXgl programs replace the empty
`while` body with `Halt()`, which executes the Z80 `halt` instruction: it
stops the CPU until the next interrupt, which normally fires once per screen
refresh (VBlank). Looping on `Halt()` paces your loop to the screen instead
of spinning uncontrolled, and it's what the `projects/template/template.c`
skeleton uses:

```c
	VDP_SetMode(VDP_MODE_SCREEN0);
	VDP_EnableVBlank(TRUE);
	VDP_ClearVRAM();

	Print_SetTextFont(g_Font_MGL_Sample6, 1);
	Print_SetColor(COLOR_WHITE, COLOR_BLACK);
	Print_SetPosition(0, 0);
	Print_DrawText("Hello");

	while (!Keyboard_IsKeyPressed(KEY_ESC))
	{
		// ... per-frame work goes here ...
		Halt();
	}

	BIOS_Exit(0);
```

Two differences from `s_hello.c` worth calling out:

- `VDP_EnableVBlank(TRUE)` turns on the VBlank interrupt so `Halt()` actually
  has something to wake up on once per frame.
- After the loop, `BIOS_Exit(0)` is called. `s_hello.c` skips it because it
  never means to return anywhere, the ESC check just falls through to the
  end of `main`. `BIOS_Exit` hands control back cleanly to whatever loaded
  your program (BASIC or MSX-DOS); use it whenever your program is meant to
  exit back to that environment rather than reset or hang.

## The full program

```c
#include "msxgl.h"

//-----------------------------------------------------------------------------
// Program entry point
void main()
{
	VDP_SetMode(VDP_MODE_SCREEN0); // Initialize screen mode 0 (text)
	VDP_ClearVRAM();

	Print_SetTextFont(PRINT_DEFAULT_FONT, 1); // Initialize font (use BIOS font)
	Print_DrawText("Hello MSX world!");

	while(!Keyboard_IsKeyPressed(KEY_ESC))
	{
	}
}
```

In MSXStudio: create or open a project, set **Library modules** in Project
Settings to `system`, `bios`, `vdp`, `print`, `input` (the default project
template also includes `memory`, which this sample doesn't need but is
harmless to leave checked), paste this into `main.c`, and press Run.

## Try changing it

- Change the text: edit the string passed to `Print_DrawText`.
- Move it: call `Print_SetPosition(x, y)` before `Print_DrawText` to place
  the text elsewhere on the 40x24 character grid.
- Add color: call `Print_SetColor(COLOR_WHITE, COLOR_BLACK)` (from
  `color.h`, already pulled in by `msxgl.h`) before drawing text, then try
  other named colors.
- Swap the busy loop for a frame-paced one: add `VDP_EnableVBlank(TRUE)`
  after `VDP_SetMode`, and put `Halt();` inside the `while` loop body.

## Gotchas

- Forgetting `VDP_ClearVRAM()` after `VDP_SetMode` can leave stray pattern
  data visible on screen, especially if you're re-running the program in an
  emulator without a full reset.
- `Print_SetTextFont` must run before any `Print_DrawText`/`Print_DrawChar`
  call: there's no default font until you set one.
- The empty `while(!Keyboard_IsKeyPressed(KEY_ESC)) {}` loop pins the CPU at
  100%. That's invisible on real hardware and most emulators, but it means
  nothing else can happen in that loop: no animation, no other input. Once
  you need per-frame work, switch to the `VDP_EnableVBlank(TRUE)` +
  `Halt()` pattern shown above.
- `s_hello.c` never calls `BIOS_Exit`, so falling out of the loop just falls
  off the end of `main`. That's fine for a sample, but if your program should
  hand control back to BASIC/DOS, call `BIOS_Exit(0)` explicitly.
