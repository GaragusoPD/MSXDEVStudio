# Meta-tiles: bigger maps in less ROM

A tile map costs one byte per cell. A 32×24 screen is 768 bytes, a 128×24
four-screen level is 3072, and on a 32 KB ROM that adds up faster than the art
does. This tutorial is about spending a quarter of it, by noticing something
about MSX art that the hardware does not: **it repeats in clumps.**

Nothing here is required. A map that names an ordinary `.tiles.json` works
exactly as it always has, and everything in
[Tiles and maps](03-tiles-and-maps.md) still applies. Meta-tiles are a second
resource you create when a map is big enough to be worth it.

**MSXDEVStudio resources:** a `.meta-tiles.json` (or `.meta-btiles.json`) over a
tileset, and a `.map.json` pointed at it · **Machine:** MSX1 and up

## The idea

Look at almost any MSX screen and you will find the same 2×2 or 4×4 groups over
and over: a brick, a section of wall, a treetop, the end of a platform. The name
table stores them one 8×8 tile at a time because that is what the VDP reads —
but *your level data* does not have to.

A **meta-tile set** names those groups. A map pointed at the set stores one byte
per *group* instead of one per tile:

```
  tiles                        metas (2×2)
  ┌──┬──┬──┬──┬──┬──┐          ┌─────┬─────┬─────┐
  │ 4│ 5│ 4│ 5│ 8│ 9│          │     │     │     │
  ├──┼──┼──┼──┼──┼──┤          │  0  │  0  │  1  │
  │ 6│ 7│ 6│ 7│10│11│          │     │     │     │
  └──┴──┴──┴──┴──┴──┘          └─────┴─────┴─────┘
  12 bytes                     3 bytes
```

The saving is exactly the number of tiles per meta: 4× for 2×2, 16× for 4×4.
And it composes with RLEp compression, which still packs whatever is left.

What you pay is one extra table (the set itself — 4 bytes per meta, so a
64-meta set is 256 bytes) and a little arithmetic per cell when the map is
drawn. For one screen that trade is not worth making. For a level, it usually
is.

## Building a set

1. In the **Resources** panel, pick **meta-tiles** (or **meta-tiles (bitmap)**
   if the art is a `.btiles.json` for SCREEN 5–8), type a name, press **New**.
2. In the new editor's side panel, choose the **tileset** to group. The left
   pane fills with its tiles.
3. Set the **meta size** — 2×2 is the usual choice. Every meta in the set is
   this size; the exported table is read at one stride, so they have to be.
4. Add metas. **+ Meta** gives you a blank one to fill by clicking a tile on the
   left and then the cells on the canvas. **+ From tiles** is faster when the
   art was drawn as a block already: pick the top-left tile and it takes the
   whole W×H group starting there.
5. Name the ones you will refer to from C. A named meta exports a `#define`;
   unnamed ones are just their index.

Then open the map, and in **Tileset** choose the meta-tile set instead of the
tileset. The picker now shows metas, and stamp, fill, rectangle, erase,
rect-select and copy/paste all work as before — the cells simply mean something
bigger. (If the map already has art, MSXDEVStudio asks first: the old cell values
cannot survive the change, because a 3 that meant "brick" now means "meta 3".)

## What you get in C

The set exports one table and its geometry:

```c
#include "content/level_metatiles.h"

// #define G_LEVELMETAS_META_W 2
// #define G_LEVELMETAS_META_H 2
// #define G_LEVELMETAS_COUNT 24
// #define G_LEVELMETAS_GROUND 0        // one per meta you named
// extern const unsigned char g_LevelMetas[];
```

The map exports its layers as meta indices, plus enough to make sense of them:
`_W`/`_H` now count **metas**, and `_TILE_W`/`_TILE_H` are the size in tiles.

```c
#include "content/level_map.h"

// #define G_LEVEL_W 32          // metas across
// #define G_LEVEL_TILE_W 64     // tiles across
// #define G_LEVEL_META_CELLS 4  // the table stride
```

With **Export ready-made C** ticked on the map you also get the code that turns
one back into the other. Note that every call takes the set's table as an
argument — the map does not know its name, the same way `_DrawLayer` has always
taken the layer rather than baking it in.

### Drawing straight to the screen

```c
u8 rowbuf[G_LEVEL_TILE_W];

// A 32×20 window at name-table row 4, scrolled by camX:
g_Level_DrawView(g_Level_Terrain, g_LevelMetas, rowbuf, camX, 0, 0, 4, 32, 20);
```

`_DrawView` expands one row at a time into `rowbuf` and writes it, so it never
needs the map in RAM. Call it with the whole map's size and it is your
"draw everything" — that is the cheapest way to put a meta map on screen.

There is deliberately no `_DrawColumn`. SCREEN 1/2/4 have no hardware horizontal
scroll, so stepping the camera one column rewrites the whole name table anyway;
`_DrawView` *is* that.

There is also no `_DrawLayer` on a meta map, and this is the one thing that will
catch you out if you come from a plain tile map. The layer holds meta indices.
Writing it into the name table would draw whichever tiles happen to share those
numbers — a screen of noise, with nothing to point at the cause. The exporter
therefore does not emit it.

### Expanding to RAM

A game that only *shows* its map wants `_DrawView`. A game that **reads and
writes** it — collision, or turning a collected coin into sky — wants the tiles
in memory:

```c
u8 g_World[G_LEVEL_TILE_W * G_LEVEL_TILE_H];

g_Level_ExpandToRAM(g_Level_Terrain, g_LevelMetas, g_World);

// Now it is an ordinary tile map, and everything you already know works:
u8 tile = g_World[ty * G_LEVEL_TILE_W + tx];
if (g_Tiles_Flags[tile] & FLAG_SOLID) { /* blocked */ }
g_World[ty * G_LEVEL_TILE_W + tx] = T_SKY;   // and you can change it
```

That is the trade in one line: meta-tiles save you **ROM**, and expanding costs
you **RAM**. A 64×12 level is 768 bytes of RAM either way — but only 192 bytes
of ROM instead of 768, and you can still compress those 192.

If you want collision without expanding, resolve the cell yourself:

```c
u8 meta = g_Level_Terrain[(ty / G_LEVEL_META_H) * G_LEVEL_W + (tx / G_LEVEL_META_W)];
u8 tile = g_LevelMetas[meta * G_LEVEL_META_CELLS
                       + (ty % G_LEVEL_META_H) * G_LEVEL_META_W
                       + (tx % G_LEVEL_META_W)];
```

Both `%` and `/` are by a compile-time constant, so a power-of-two meta size
compiles to a shift and a mask rather than SDCC's division routine. Prefer 2×2
and 4×4 over 3×3 for exactly that reason.

### Stamping one meta at runtime

The *set* exports its own helper, for the door that opens or the block that
breaks:

```c
g_LevelMetas_DrawMeta(10, 5, G_LEVELMETAS_DOOR_OPEN);
```

Remember to change the map too if the game will redraw that area later —
drawing the right thing and recording it are two steps, exactly as they are for
a plain tile map.

## Compression

Meta layers pack with RLEp like any other layer; tick **Compress (RLEp)** on the
map and the side panel shows the measured trade. The one difference from a plain
map: the meta helpers all read an **unpacked** layer, so unpack once at startup
rather than per call.

```c
u8 g_Level[G_LEVEL_TERRAIN_UNPACKED_SIZE];

RLEp_UnpackToRAM(g_Level_Terrain, g_Level);      // once, at startup
g_Level_DrawView(g_Level, g_LevelMetas, rowbuf, camX, 0, 0, 4, 32, 20);
```

Note the define is `G_LEVEL_TERRAIN_UNPACKED_SIZE`, not `G_LEVEL_UNPACKED_SIZE`
— it is emitted per table, so it carries the layer's name.

Keeping the unpacked layer around is not a cost you are paying reluctantly: it
is small (192 bytes for a screen of 2×2 metas), and having it in RAM is what
lets the game change the level as it runs.

`RLEp_UnpackToRAM` needs `"compress"` in **LibModules** and
`COMPRESS_USE_RLEP` / `COMPRESS_USE_RLEP_DEFAULT` TRUE in `msxgl_config.h`,
which is the default.

## Bitmap modes

A `.meta-btiles.json` groups a bitmap tileset, and a bitmap map drawn with it
keeps the shape it had in [Bitmap graphics](07-bitmap-graphics.md) — one extra
argument:

```c
g_Stage_DrawRow(g_Stage_Terrain, g_CanyonMetas, row, ATLAS_Y, destY);
```

`row` is still a *cell* row, and the loop still issues one `HMMM` per cell
across the map. That is on purpose: a scroller written against a plain bitmap
map ports by adding the argument, and its per-frame blit budget does not move.
`_DrawRowOver` (the transparent-cell twin) gains the same argument and nothing
else.

The saving in a bitmap mode is the same ROM saving on the map, but it is worth
weighing against the alternative: you could equally cut the atlas at 32×32
instead of 16×16 and have no metas at all. Meta-tiles win when the *same* small
cells recur in different combinations — which is the usual case for terrain, and
not the case for one-off scenery.

## Gotchas

- **No `_DrawLayer`, and no `Scroll_Initialize`.** MSXgl's `scroll` module blits
  raw name-table rows straight out of the array you hand it. A meta layer is not
  that. Use `_DrawView`, or expand to RAM first and scroll that.
- **`_W`/`_H` count metas.** `_TILE_W`/`_TILE_H` are what you compare a pixel
  position against. Mixing them up gives you a camera that stops a quarter of
  the way across the level.
- **`_ExpandRow` and `_DrawView` clip nothing.** Keep the window inside the map;
  they read whatever is past the end otherwise.
- **The set is not the tileset.** The map's **Tileset** dropdown names the *set*;
  the set's own dropdown names the tileset. You still have to load the tileset's
  patterns and colors into VRAM as usual — meta-tiles change the level data, not
  the art.
- **Tile blocks are not offered on a meta map.** A block's cells are tile
  indices and this map's cells are not, so stamping one would paint whichever
  metas share those numbers. The meta set *is* the grouping a meta map paints
  with.
- **Deleting or moving a meta renumbers every map drawn with the set**, exactly
  as deleting a tile renumbers every map drawn with a tileset. MSXDEVStudio
  replays that for you — open maps immediately, closed ones when you next open
  them — but a meta you delete leaves those cells pointing at meta 0.

## When not to bother

- The map is one screen. 768 bytes against 192 plus a 96-byte table plus the
  expansion code is not a win worth the indirection.
- The art barely repeats — a hand-drawn title picture, a boss room where every
  cell is unique. Meta-tiles save nothing if there are as many metas as there
  were tiles.
- You are already at the RAM limit and cannot afford to expand, and the drawing
  path is hot enough that the per-cell arithmetic matters. Measure before
  assuming this one; `_DrawView` is a shift and a compare per cell.

RLEp compression on a plain tile map is the simpler answer for a lot of levels,
and the two are not exclusive — try compression first, and reach for meta-tiles
when the map is big enough that a quarter of the bytes is real money.
