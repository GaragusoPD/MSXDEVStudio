# Resources

Resources are the art and sound you make inside MSXStudio. Each one is a file
in your project that an editor owns, and each one exports a C header your game
`#include`s.

| Kind | File | Editor | Use it for |
|---|---|---|---|
| tiles | `name.tiles.json` | Tile editor | 8×8 patterns for SCREEN 1/2/4 |
| sprites | `name.sprites.json` | Sprite editor | 8×8 or 16×16 hardware sprites |
| map | `name.map.json` | Map editor | Tile layouts / levels |
| screen | `name.screen.json` | Screen editor | Full-screen MSX2 bitmaps (SCREEN 5–8) |
| sfx | `name.sfx.json` | SFX editor | ayFX sound effects |

## Creating and opening

In the **Resources** panel (side bar): pick a kind, type a name, press **New**.
The file is created and its editor opens. Click any listed resource to reopen
it later — or open the file from the Explorer.

## The editors

**Tiles** — draw with pencil, line, rectangle and fill. Shift, mirror and
rotate the current tile. Colors depend on the mode: SCREEN 2/4 give you two
colors per 8-pixel row, SCREEN 1 gives one pair per group of 8 tiles. SCREEN 4
adds an editable 16-colour palette. **Import image…** converts a PNG into a
whole tileset.

**Tile flags** — eight numbered squares in the tile editor, in the manner of
PICO-8's sprite flags. They say what a tile *means* to your game rather than how
it looks: solid, collectable, deadly, whatever you decide. They belong to the
tileset, so every map drawn with it agrees, and they export as `_Flags`, one
byte per tile, only once some tile carries a bit.

```c
#define FLAG_SOLID 0x01          // flag 1 is bit 0
if (g_Tiles_Flags[tile] & FLAG_SOLID) { /* blocked */ }
```

That turns collision into a table lookup rather than a list of tile numbers in
your code, so re-arranging a tileset does not break the game. See
[`demo_project`](../demo_project/) for it in use.

**Tile blocks** — a door, a tree or a boss face is bigger than one tile, so the
tile editor lets you name a **block**: a W×H design you draw on one canvas.
A block holds no pixels of its own, only references to tiles in the same bank,
so painting a block paints those tiles. Pick a size in the side panel and press
**+ Block**; the seams between tiles are drawn in blue. In SCREEN 1 a new block
starts on a colour-group boundary, because eight consecutive tiles share one
FG/BG pair there — the panel warns when a block can't own its whole group.

**Sprites** — mode 1 gives each sprite one colour; mode 2 gives a colour per
line, plus the EC/CC/IC bits. Sprites are 8×8 or 16×16 and can stack up to 4
layers for multicolour characters. The animation bar previews frames.

**Metasprites** — a character can span a grid of hardware sprites (the
*Character grid* control): 2×2 of 16×16 sprites is a 32×32 Metal Gear-style
hero that moves as one. Each cell is a separate hardware sprite and each of its
layers costs another, so every character shows what it spends of the VDP's
4 (mode 1) or 8 (mode 2) sprites per scanline.

**Map** — pick a tileset first (dropdown in the side panel), then paint with
stamp, fill, rectangle and erase. Shift+click or drag in the tile picker takes
a multi-tile stamp. A 32×24 map is exactly one screen; larger maps get a screen
outline overlay for designing scrolling worlds. Add layers to draw a foreground
over a background: on any layer above the first, tile 0 means transparent.

**Screen** — for MSX2 bitmap modes only. Import a source image, then retouch
the conversion with pencil/fill and edit the palette. For MSX1 full-screen art,
draw a tileset and place it in a map instead.

**Fragments** — bitmap modes have no name table, so the block idea arrives as a
**fragment**: pick the ⛶ tool and drag a rectangle on the converted image to
name a cut-out of it. Fragments are bitmap-mode blocks *and* the frames of a
software sprite; like blocks they hold no pixels, so retouching the image
updates every fragment over it.

**SFX** — one file holds a bank of effects. Draw tone, noise and volume per
frame, press Play to hear it. Start from a preset, or import `.afx`/`.afb`
files from AYFX Editor. An effect's position in the list is the id you pass to
`ayFX_PlayBank()`, so reordering renumbers them.

## Exporting

Every editor has an **Export** block in its side panel:

- **name** — the C variable, e.g. `g_MyTiles`
- **out** — where to write it, e.g. `content/mytiles.h`
- **format** — `c` for a header, `bin` for raw bytes
- **Export ready-made C** — appends working code for the thing you just drew
  (see below). Off by default, because it calls into MSXgl.

Exports run automatically before every build, and skip anything already up to
date. To export by hand, use the **Export** button in the editor toolbar, or
**Export all** in the Resources panel.

A generated header defines one array per table, plus a size define:

```c
#define G_MYTILES_PATTERNS_SIZE 768
const unsigned char g_MyTiles_Patterns[] = { ... };
const unsigned char g_MyTiles_Colors[] = { ... };
```

Never edit generated headers — they are overwritten on every build.

## Using resources in code

Include the header, then load the arrays into VRAM. All examples assume
`#include "msxgl.h"` at the top of your `.c` file.

### Tiles

Exports `_Patterns`, `_Colors`, and `_Palette` on SCREEN 4.

```c
#include "content/mytiles.h"

VDP_SetMode(VDP_MODE_GRAPHIC2);            // SCREEN 2
VDP_LoadPattern_GM2(g_MyTiles_Patterns, 64, 0);  // 64 tiles, starting at tile 0
VDP_LoadColor_GM2(g_MyTiles_Colors, 64, 0);
```

`VDP_LoadPattern_GM2` mirrors the data into all three SCREEN 2 banks for you.
Pass `0` as the count to mean all 256 tiles. On SCREEN 1 there are no banks to
mirror, so write the tables directly instead:

```c
VDP_WriteVRAM(g_MyTiles_Patterns, g_ScreenPatternLow, g_ScreenPatternHigh, 64 * 8);
VDP_WriteVRAM(g_MyTiles_Colors, g_ScreenColorLow, g_ScreenColorHigh, 32);
```

### Sprites

Exports `_Patterns`, `_Colors`, and `_Palette` in mode 2.

```c
#include "content/myhero.h"

VDP_EnableSprite(TRUE);
VDP_SetSpriteFlag(VDP_SPRITE_SIZE_16);
VDP_LoadSpritePattern(g_MyHero_Patterns, 0, 4);  // 16×16 sprite = 4 patterns

// Mode 1 (MSX1): one colour per sprite
VDP_SetSpriteSM1(0, x, y, 0, COLOR_WHITE);

// Mode 2 (MSX2): colour per line, 16 bytes per sprite in _Colors
VDP_SetSpriteExMultiColor(0, x, y, 0, g_MyHero_Colors);

VDP_DisableSpritesFrom(1);                 // hide the rest
```

### Map

Exports one array per layer, named after the layer — the default layer
`background` becomes `g_MyMap_Background`. It is one byte per cell, so a 32×24
map is 768 bytes you can blit straight into the name table:

```c
#include "content/mymap.h"

VDP_WriteVRAM(g_MyMap_Background, g_ScreenLayoutLow, g_ScreenLayoutHigh, 32 * 24);
```

Load the map's tileset first, or you'll see the wrong patterns. For maps wider
than one screen, add MSXgl's `scroll` module to LibModules and pass the array
to `Scroll_Initialize((u16)g_MyMap_Background)` instead.

Collision comes from the tileset's flags rather than from the map, so the same
map data serves both the VDP and the game logic:

```c
u8 tile = g_MyMap_Background[y * 32 + x];
if (g_MyTiles_Flags[tile] & FLAG_SOLID) { /* blocked */ }
```

### Screen

Exports `_Palette` (when the mode has one) and `_Data`.

```c
#include "content/title.h"

VDP_SetMode(VDP_MODE_SCREEN5);
VDP_SetPalette(g_Title_Palette);           // 16 entries, 2 bytes each
VDP_WriteVRAM(g_Title_Data, g_ScreenLayoutLow, g_ScreenLayoutHigh, G_TITLE_DATA_SIZE);
```

### SFX

Exports the whole bank as one array. Add `"ayfx/ayfx_player"` to **LibModules**
in Project Settings first.

```c
#include "content/sounds.h"

ayFX_InitBank(g_Sounds);
ayFX_SetChannel(PSG_CHANNEL_A);

ayFX_PlayBank(0, 0);                       // effect id 0, priority 0
```

`ayFX_Update()` must run once per frame, and it only fills a register buffer —
something has to push that buffer to the PSG:

```c
void VBlankHook()
{
    ayFX_Update();
    PSG_Apply();       // if you also use PT3 music, call PT3_UpdatePSG() instead
}
```

Author your effects at the same rate you call `ayFX_Update()` — set 50 Hz for
PAL or 60 Hz for NTSC in the SFX editor.

## Ready-made C

Tick **Export ready-made C** in the side panel and the generated header carries
the code that drives what you drew, so you get a working object without writing
the VDP plumbing by hand. It calls into MSXgl, so include `msxgl.h` first.

**Sprite groups** — a metasprite, a stack of superposed planes, or both. The
header defines where each character starts, and one call places the whole group:

```c
g_Actors_SetMeta(0, x, y, G_ACTORS_HERO_BASE + frame * G_ACTORS_HERO_PLANES,
                 G_ACTORS_HERO_PLANES);
```

**Tile blocks** — stamps a block's tile indices into the name table. Needs
`VDP_USE_MODE_G2` or `VDP_USE_MODE_G3`:

```c
g_Scenery_DrawBlock(10, 5, G_SCENERY_DOOR_BASE, G_SCENERY_DOOR_W, G_SCENERY_DOOR_H);
```

**Software sprites** (MSX2, `VDP_USE_COMMAND`) — characters drawn *into* the
screen, so the per-scanline sprite limit does not apply. The fragments are
exported as one strip; upload it once, then restore and draw each object:

```c
g_Actors_Upload(212);                 // strip parked below the visible lines
g_Actors_SwSprite hero = { 0 };       // slot 0 — one backup column per object
// every frame:
g_Actors_Restore(&hero, 212);
g_Actors_Draw(&hero, G_ACTORS_HERO_IDLE, x, y, 212);
```

Two rules the generated comments repeat: give every object its own `slot`, and
when objects can overlap, restore them all in reverse draw order before drawing
them all in order.
