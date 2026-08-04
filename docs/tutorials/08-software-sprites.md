# Software sprites and tiles

Hardware sprites are fast but scarce: the VDP gives you 32 of them, a handful
per scanline, and one color each. Software sprites and software tiles get
around that by drawing straight into the screen's bitmap data with the VDP's
own command engine (its blitter), trading CPU/VDP time for unlimited color
and no per-line cap.

**Sample:** `projects/samples/s_swsprt.c`, `projects/samples/s_swtile.c` ·
**LibModules:** `system`, `bios`, `vdp`, `print`, `input`, `memory`, `math`,
`draw` for software sprites (the defaults from `project_config.js`,
unchanged by `s_swsprt.js`); software tiles adds `tile`, `debug`,
`game/pawn`, `string` on top (`s_swtile.js`) · **Machine:** MSX2 (both
samples need the VDP command engine, which requires MSX2 or higher)

## Why software sprites

A hardware sprite is an entry in the VDP's sprite attribute table: cheap to
move, but limited. On screen at once you get at most 32 sprites, and only 4
of them (MSX1) or 8 (MSX2) can appear on the same scanline before the rest
just don't get drawn. Each sprite is essentially one solid color. MSX2's
sprite mode 2 can vary the color per scanline, but not per pixel within a
line.

A software sprite is not a sprite at all as far as the VDP is concerned:
it's ordinary pixels, drawn into the bitmap plane like everything else on
screen. That means it can use every color the screen mode supports (256 on
SCREEN 8), there's no 32-on-screen or per-line cap, and nothing stops you
from having more "sprites" overlapping on one line than hardware would ever
allow. The cost lands on the CPU and the VDP's command engine instead: every
frame, something has to erase the old pixels and draw the new ones, and that
takes VDP cycles proportional to the area being moved.

## Setting up

The technique needs the VDP command engine (`VDP_Command*` functions),
which only exists on MSX2 and up. `VDP_USE_COMMAND` in
`msxgl_config_msx2.h` is what turns on those wrapper functions, and it is
gated on `MSX_VERSION >= MSX_2`. In MSXStudio's Project Settings that means
**Machine** must be MSX2 or higher.

`InitScreen()` in `s_swsprt.c` sets the mode and turns hardware sprites off,
since this technique doesn't use them:

```c
VDP_SetMode(src->Mode);
VDP_SetColor(src->Background);
VDP_EnableSprite(FALSE);
```

Then it uploads the sprite artwork once, into a strip of VRAM below the
visible picture (the sample's `HEIGHT` constant is 212, the bottom edge of
the picture; the VDP page has room below that which is never displayed):

```c
// Initialize sprite
VDP_CommandHMMV(0, HEIGHT, sprtWidth * 6, 16, 0);
for (u8 i = 0; i < 6; ++i)
{
	VDP_CommandLMMC(src->DataLMMC + i * (16 * 16 * pixelWidth), i * sprtWidth, HEIGHT, sprtWidth, 16, VDP_OP_TIMP);
}
```

`VDP_CommandHMMV(dx, dy, nx, ny, col)` clears that strip first. Then
`VDP_CommandLMMC(addr, dx, dy, nx, ny, op)` copies six 16x16 animation
frames from CPU memory (`src->DataLMMC`) into that strip, side by side.
`LMMC` is a CPU-to-VRAM copy, so it needs one byte per pixel regardless of
the screen's actual bit depth, so `main()` builds those unpacked
(`g_LMMC4b`, `g_LMMC2b_2`) arrays from the packed source bitmaps
(`g_DataBmp4b`, `g_DataBmp2b`) before this runs. This upload happens once at
startup; from then on the update loop only ever reads from that VRAM copy
with fast VRAM-to-VRAM commands, it never touches CPU memory again.

Finally, `BackupBackground()` saves whatever's currently on screen at the
sprite's starting position, so the first frame of the update loop has
something correct to restore later:

```c
void BackupBackground()
{
	const struct ScreenSetting* src = &g_Settings[g_SrcModeIndex];
	u8 pixelWidth = src->Width / 256;
	u8 sprtWidth = pixelWidth * 16;

	// Backup
	VDP_CommandHMMM(SX * pixelWidth - 2, SY, 0, HEIGHT + 16, sprtWidth + 4, 16);

	SX0 = SX;
	SY0 = SY;
}
```

`VDP_CommandHMMM(sx, sy, dx, dy, nx, ny)` is a raw VRAM-to-VRAM copy (no
transparency, no operation code). Here it stashes a rectangle of
the current background into a second offscreen strip, at `y = HEIGHT + 16`,
just below the sprite sheet.

VBlank sync in this sample comes from the project's build settings rather
than a manual hook: `s_swsprt.js` sets `CustomISR = "VBLANK"` and
`InstallRAMISR = "RAMISR_SEGMENT0"`, which wires up a function named exactly
`VDP_InterruptHandler()` as the interrupt handler automatically:

```c
// VBlank interrupt
void VDP_InterruptHandler()
{
	g_VBlank = 1;
}
```

## The update loop

Every software-sprite frame follows the same shape: **erase, move, redraw,
sync to VBlank.** `s_swsprt.c` does it in `DisplaySprite()`:

```c
void DisplaySprite()
{
	const struct ScreenSetting* src = &g_Settings[g_SrcModeIndex];
	u8 pixelWidth = src->Width / 256;
	u8 sprtWidth = pixelWidth * 16;

	// Restore background at the previous place
	VDP_CommandHMMM(0, HEIGHT + 16, SX0 * pixelWidth - 2, SY0, sprtWidth + 4, 16);

	// Backup background at the new place
	VDP_CommandHMMM(SX * pixelWidth - 2, SY, 0, HEIGHT + 16, sprtWidth + 4, 16);

	// Draw the sprite
	u8 frame = g_bMoving ? ((g_Frame / 4) % 6) : 4;
	VDP_CommandLMMM(sprtWidth * frame, HEIGHT, SX * pixelWidth, SY, sprtWidth, 16, VDP_OP_TIMP);

	SX0 = SX;
	SY0 = SY;
}
```

1. **Erase**, copy the saved background rectangle back over the sprite's
   *old* position (`SX0, SY0`).
2. **Backup**, save a fresh copy of whatever's under the sprite's *new*
   position, before drawing over it.
3. **Redraw**, `VDP_CommandLMMM(sx, sy, dx, dy, nx, ny, op)` copies one
   16x16 frame from the sprite sheet onto the screen at the new position,
   using `VDP_OP_TIMP` ("logical move, transparent"): pixels with color
   index 0 in the source are skipped, leaving the background around the
   sprite's silhouette untouched. `frame` picks which of the six strip
   frames to use, cycling only while `g_bMoving` is set.

The main loop ties it to input and VBlank:

```c
while (bContinue)
{
	WaitVBlank();
	DisplaySprite();

	// ... animate the "sign of life" character, read the mode-change key ...

	g_bMoving = FALSE;
	if ((row & KEY_FLAG(KEY_LEFT)) == 0)
	{
		if (SX > 2) { SX--; g_bMoving = TRUE; }
	}
	else if ((row & KEY_FLAG(KEY_RIGHT)) == 0)
	{
		if (SX < 256-16-2) { SX++; g_bMoving = TRUE; }
	}
	// ... same for KEY_UP / KEY_DOWN on SY ...

	if (Keyboard_IsKeyPressed(KEY_ESC))
		bContinue = FALSE;
}
```

`WaitVBlank()` blocks until `g_VBlank` is set by the interrupt handler, so
the whole erase-backup-redraw sequence for one frame always completes
during a single VBlank period rather than tearing across two.

## Software tiles

`tile.h`/`tile.c` solve a different problem: bitmap screen modes (SCREEN
5-8) have no native concept of reusable tiles, no pattern-name table like
SCREEN 1/2 have, so every pixel of a level's background would otherwise
have to be drawn by hand. The software tile module recreates a tile system
on top of a bitmap screen: it stores a bank of small cells in an offscreen
part of VRAM, then blits them onto the visible page with the same VDP
command engine used above.

`s_swtile.c` sets it up like this:

```c
VDP_SetMode(VDP_MODE_SCREEN5);
VDP_SetColor(6);
VDP_SetPage(0);

// Load tiles data
Tile_SetBankPage(2);
Tile_FillBank(0, 6);
Tile_FillBank(1, 7);
Tile_FillBank(2, 8);
Tile_FillBank(3, 9);
Tile_LoadBank(0, g_DataBG4b, sizeof(g_DataBG4b) / TILE_CELL_BYTES);
Tile_LoadBank(2, g_DataBG4b, sizeof(g_DataBG4b) / TILE_CELL_BYTES);
for (u8 i = 0; i < 15; ++i)
	VDP_SetPaletteEntry(i + 1, *(u16*)&g_DataBG4b_palette[i*2]);

// Draw level
Tile_SetDrawPage(0);
Tile_SelectBank(0);
Tile_FillScreen(6);
Tile_DrawMapChunk( 0, 15, g_TreeTileMap, 6, 6); // Draw tree tilemap
Tile_DrawMapChunk( 3, 15, g_TreeTileMap, 6, 6);
Tile_DrawMapChunk(11, 15, g_TreeTileMap, 6, 6);
Tile_DrawScreen(g_TileMap); // Draw the whole screen tilemap
Tile_DrawBlock(10, 8, 4, 4, 4, 2); // Draw a cloud (4x2 tiles)
```

- `Tile_SetBankPage(page)` picks the VRAM page the tile bank lives in.
- `Tile_FillBank(bank, value)` and `Tile_LoadBank(bank, data, num)` clear
  and fill one of that page's banks (a set of up to 256 cells) with your
  tile pixel data.
- `Tile_SetDrawPage(page)` / `Tile_SelectBank(bank)` pick where drawing
  happens and which loaded bank to draw from.
- `Tile_FillScreen(color)`, `Tile_DrawTile(x, y, tile)`,
  `Tile_DrawMapChunk(x, y, map, width, height)`, `Tile_DrawScreen(map)` and
  `Tile_DrawBlock(dx, dy, sx, sy, width, height)` all blit cells onto the
  draw page, from a single tile up to a whole tilemap array.

The compile-time defines (in `msxgl_config_msx2.h`, no override in this
sample) shape the cell grid:

```c
#define TILE_WIDTH       8    // Tile width
#define TILE_HEIGHT      8    // Tile height
#define TILE_BPP         4    // Screen bits-per-pixel
#define TILE_SCREEN_WIDTH  256  // Screen width
#define TILE_SCREEN_HEIGHT 212  // Screen height
#define TILE_USE_SKIP    TRUE // Skip drawing of a given index
#define TILE_SKIP_INDEX  0    // The index tile to skip
```

`TILE_USE_SKIP`/`TILE_SKIP_INDEX` is why the map arrays in `s_swtile.c` are
full of `OOO` (`#define OOO 0`): a cell whose value equals
`TILE_SKIP_INDEX` is skipped entirely rather than drawn, so the background
underneath shows through, that's how `g_TreeTileMap`'s tree shape can be
stamped on top of the level several times without a rectangular box erasing
what's already there.

**How it differs from software sprites:** the tile module has no
erase/redraw pair like `DisplaySprite()`, there's no backup/restore
helper in `tile.c` at all. It's built for laying out or refreshing a
background once (or occasionally, a chunk at a time), not for animating
something every frame. `s_swtile.c`'s moving player character is not drawn
with this module: it's a `Game_Pawn` (from the separate `game/pawn`
module), which uses ordinary hardware sprites, `VDP_LoadSpritePattern`,
`VDP_SetSpriteFlag(VDP_SPRITE_SIZE_16)`, layered three deep for a
multi-color look. That module is out of scope here; the point to take
away is that in this sample, tiles paint the world and hardware sprites
move through it, while `s_swsprt.c` shows the alternative of moving the
character through software-drawn pixels instead.

## The full program

A minimal version of the technique: one 16x16 software sprite you move with
the cursor keys in SCREEN 5, with the background correctly restored behind it.
SCREEN 5 displays lines 0 to 211, so everything from line 212 down is free
VRAM. This program parks the sprite artwork on one of those hidden lines and
the saved background on another.

```c
#include "msxgl.h"

#define HEIGHT      212             // first VRAM line below the visible screen
#define SPRITE_Y    (HEIGHT)        // where the sprite artwork is stored
#define BACKUP_Y    (HEIGHT + 16)   // where the saved background goes
#define LINE_BYTES  128             // SCREEN 5: 256 pixels, 2 per byte

// Your 16x16 sprite: 16 lines of 8 bytes, 4 bits per pixel
extern const u8 g_MySprite_Data[];

u8  g_VBlank = 0;
u16 SX = 100, SY = 80;      // current position
u16 SX0 = 100, SY0 = 80;    // position we drew at last frame

// The crt0 interrupt handler calls this by name every VBlank.
// Set CustomISR to VBLANK in Project Settings.
void VDP_InterruptHandler()
{
    g_VBlank = 1;
}

void WaitVBlank()
{
    while (g_VBlank == 0) {}
    g_VBlank = 0;
}

void DisplaySprite()
{
    // 1. Erase: put the saved background back where the sprite used to be
    VDP_CommandHMMM(0, BACKUP_Y, SX0, SY0, 16, 16);

    // 2. Backup: save what sits under the sprite's new position
    VDP_CommandHMMM(SX, SY, 0, BACKUP_Y, 16, 16);

    // 3. Redraw: copy the artwork over it, skipping color index 0
    VDP_CommandLMMM(0, SPRITE_Y, SX, SY, 16, 16, VDP_OP_TIMP);

    SX0 = SX;
    SY0 = SY;
}

void main()
{
    VDP_SetMode(VDP_MODE_SCREEN5);
    VDP_ClearVRAM();
    VDP_EnableVBlank(TRUE);

    // Upload the artwork one line at a time into the hidden area
    for (u8 y = 0; y < 16; ++y)
        VDP_WriteVRAM(g_MySprite_Data + (y * 8), (SPRITE_Y + y) * LINE_BYTES, 0, 8);

    // Something to move over, so the erase step is visible
    VDP_CommandHMMV(0, 0, 256, HEIGHT, 0x44);
    VDP_CommandWait();

    // Prime the backup slot before the first draw
    VDP_CommandHMMM(SX, SY, 0, BACKUP_Y, 16, 16);

    while (!Keyboard_IsKeyPressed(KEY_ESC))
    {
        WaitVBlank();
        DisplaySprite();

        u8 row = Keyboard_Read(KEY_ROW(KEY_LEFT));
        if (IS_KEY_PRESSED(row, KEY_LEFT)  && (SX > 0))            SX--;
        if (IS_KEY_PRESSED(row, KEY_RIGHT) && (SX < 256 - 16))     SX++;

        row = Keyboard_Read(KEY_ROW(KEY_UP));
        if (IS_KEY_PRESSED(row, KEY_UP)    && (SY > 0))            SY--;
        if (IS_KEY_PRESSED(row, KEY_DOWN)  && (SY < HEIGHT - 16))  SY++;
    }
}
```

The command engine takes X in pixels here because SCREEN 5 is 256 pixels wide.
In the 512 pixel wide modes (SCREEN 6 and 7) the real sample scales X by a
`pixelWidth` factor of `Width / 256`, so a sprite at logical x=100 is passed
as 200. Keep that in mind if you port this to another mode.

In MSXStudio: create an MSX2 project, set **CustomISR** to `VBLANK` in Project
Settings, include your exported sprite header in place of the `extern`
declaration, and press Run.

The real `s_swsprt.c` goes further: it cycles through SCREEN 5, 6, 7 and 8 to
show the same technique at four color depths, animates a six frame walk
cycle, and unpacks compressed artwork. Read it once this version runs.
## Try changing it

- Comment out the erase step in `DisplaySprite()` and move the sprite around.
  The trail it smears across the screen is exactly what the backup slot is
  there to prevent.
- Store several 16x16 frames side by side on the hidden line and animate by
  changing the source X in the `VDP_CommandLMMM` call, for example
  `(frame * 16)`.
- Add a second moving sprite: duplicate `SX`/`SY`/`SX0`/`SY0` and the
  backup/restore calls for a second position, backed by its own offscreen
  backup strip so the two don't overwrite each other's saved background.
- In `s_swtile.c`, change which bank `Tile_SelectBank` points at before a
  `Tile_DrawScreen` call, or edit `g_TileMap`'s numbers, to see a different
  section of the tile bank painted.

## Gotchas

- **VDP commands aren't free, and they block.** `VDP_CommandSetupR32`/`R36`
  (used internally by every `VDP_Command*` call) call `VDP_CommandWait()`
  first, which busy-waits for the *previous* command to finish before the
  next one can even start. Back-to-back blits, erase, backup, redraw, every
  single frame, eat straight into your frame budget, and it gets worse
  with bigger sprites, more of them, or higher color depth (more bytes to
  move for the same visual size).
- **No automatic double buffering.** The erase/backup/redraw dance works by
  overwriting the same two VRAM regions back and forth. If the sequence
  doesn't finish inside one VBlank period, you can see a half-drawn sprite
  or a visible chunk of the raw backup strip for a frame, that's the
  flicker/tearing trade-off. `WaitVBlank()` + doing all three steps before
  the next `WaitVBlank()` call is what keeps it clean in this sample.
- **The tile module has no erase step.** `tile.c` only draws; there's
  nothing in it like `DisplaySprite()`'s restore-then-redraw. It's meant for
  building or refreshing a background, not animating something every frame.
- **MSX2 or better only.** Both modules depend on the VDP command engine
  (`VDP_USE_COMMAND`, gated on `MSX_VERSION >= MSX_2`). None of this runs on
  a plain MSX1.
- **`VDP_CommandLMMC` needs unpacked pixel data.** One byte per pixel, no
  matter the screen's actual bit depth, mismatch that and you'll draw
  garbage. `s_swsprt.c`'s precalc loops in `main()` exist solely to build
  that unpacked form from packed source bitmaps.

## Using your own art

MSXStudio's **Map editor** already produces what `Tile_DrawScreen`/
`Tile_DrawMapChunk` expect for a level layout: a flat, one-byte-per-cell
array (see `../resources.md`). Point it at a tileset using tiles in the
same order you loaded into your tile bank, export, and pass the array
straight to those functions.

The tile *pixel* data is a different story. `Tile_LoadBank` needs each cell
packed as a contiguous `TILE_CELL_BYTES`-byte block, in the screen's native
packed pixel format, the way `content/tile/data_bg_4b.h` is laid out.
MSXStudio's Tile editor targets the SCREEN 1/2/4 pattern-generator format
instead (bitplanes plus a separate color table), which is a different byte
layout entirely. There's no export path from the Tile editor to the format
`Tile_LoadBank` needs, you'd have to build or convert that cell data
yourself, the way the engine's own sample content does.

Software sprites have no gap at all: MSXStudio does the whole of the above
for you. Cut your frames out of a converted image as **fragments** (the ⛶
tool in the Screen editor), and the export lays them side by side into one
`_Strip` in the packed native format for the mode — exactly what
`VDP_CommandHMMC` uploads and `VDP_CommandLMMM` blits. Tick **Export
ready-made C** and the header also carries the runtime this page has been
building by hand:

```c
g_Actors_Upload(212);              // strip parked below the visible lines
g_Actors_SwSprite hero = { 0 };    // slot 0 — one backup column per object
// every frame:
g_Actors_Restore(&hero, 212);
g_Actors_Draw(&hero, G_ACTORS_HERO_IDLE, x, y, 212);
```

It is `s_swsprt.c`'s cycle — restore the old background, save the new one,
blit the frame with `VDP_OP_TIMP` — generalised past the one thing the
sample never had to face: more than one object. Each gets its own backup
column (`slot`), and when objects can overlap you restore them all in
reverse draw order before drawing them all in order, or one restore rubs out
what was drawn over it.

Two things it deliberately does not do. `VDP_CommandLMMC` wants
one-byte-per-pixel source data, which neither editor produces, so the
generated code stages the frames in VRAM and blits with `LMMM` instead —
faster anyway, and pixel-exact in X. And it is MSX2-only, because the
command engine is: for pixel-precise software sprites on an MSX1 you are
back to CPU blits into the pattern table, which nothing here generates.
Tile-aligned MSX1 animation is a different and much cheaper trick — see the
pattern-table note in [tutorial 3](03-tiles-and-maps.md).
