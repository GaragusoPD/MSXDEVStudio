/**
 * The `CLAUDE.md` / `AGENTS.md` pair scaffolded into a new project: what an AI
 * coding agent has to know to work inside an MSXDEVStudio project without
 * fighting the IDE (hand-editing generated files) or inventing MSXgl APIs.
 *
 * Same shape as `launcherScripts` in `project.ts`, so `createProject` and the
 * examples fork write both families the same way. Electron-free.
 */

import {
  attributionLines,
  GAME_SOURCE_DIR,
  isBitmapMode,
  type NewGameRequest
} from '../../shared/game-kit'
import type { MsxProject } from '../../shared/msxproj'

/** Sprite mode 1 is MSX1's; everything newer gets mode 2 (same split as `templateDirFor`). */
const isMsx1 = (machine: string): boolean => machine === '1'

/**
 * One guide, written twice under the two names agents look for. Content is
 * mostly fixed; the header states this project's facts and the sprite section
 * follows the machine, because OR-color layers are a sprite mode 2 feature.
 */
export function agentGuideFiles(
  project: MsxProject,
  msxglPath: string,
  kit?: Pick<NewGameRequest, 'kit' | 'audio' | 'displayMode'>
): { name: string; content: string }[] {
  const content = agentGuide(project, msxglPath, kit)
  return [
    { name: 'CLAUDE.md', content },
    { name: 'AGENTS.md', content }
  ]
}

function agentGuide(
  project: MsxProject,
  msxglPath: string,
  kit?: Pick<NewGameRequest, 'kit' | 'audio' | 'displayMode'>
): string {
  const msx1 = isMsx1(project.machine)
  const path = msxglPath.split('\\').join('/')
  return `# ${project.name}

An MSX game project created with **MSXDEVStudio**, built on the **MSXgl** C
library. This file was written once at project creation and is never
regenerated — edit it freely as the project grows.

| | |
|---|---|
| MSXgl checkout | \`${path}\` |
| Machine | \`${project.machine}\` (MSXgl \`Machine\`) |
| Target | \`${project.target}\` (MSXgl \`Target\`) |
| Language | C, compiled by SDCC 4.6 (Z80) — bundled inside MSXgl |

## Build and run

Use the launchers in this folder. They call MSXgl's own build script with its
bundled Node and SDCC, from this directory:

\`\`\`sh
./build.sh all       # compile + link + package + deploy    (build.bat on Windows)
./build.sh run       # the above, then launch the emulator
./build.sh rebuild   # full rebuild — wipes out/ first
./build.sh compile   # compile only
\`\`\`

Never invoke \`sdcc\`, \`sdasz80\` or \`sdldz80\` directly, and never write a
Makefile. MSXgl's build script owns the include paths, the segment layout, the
CRT0 and the packaging step; bypassing it produces binaries that don't boot.

Artifacts land in \`out/\` (objects, \`.ihx\`) and \`emul/\` (the ROM/BIN/DSK you
actually run). Both are gitignored.

Notable exit codes: **20/30/35/40/50** a tool path is wrong, **110** an unknown
entry in \`LibModules\`, **500** openMSX has no turbo R C-BIOS machine, **540**
meisei was asked to run a non-ROM target. On Linux/macOS they arrive mod 256.

## What you may edit, and what is generated

**Yours:**

- \`main.c\` and any other \`.c\`/\`.h\` you add — the game.
- \`msxgl_config.h\` — engine compile-time features (~257 \`#define\`s: which VDP
  driver, input driver, scroll/tile options, …). Editing it changes what gets
  compiled into the engine; a change here needs a \`rebuild\`.
- \`${project.name}.msxproj\` — the project model (settings, resource list). The
  IDE owns it, but it is plain JSON and safe to read.

**Generated — do not hand-edit, your changes are overwritten:**

- \`project_config.js\` — regenerated from the \`.msxproj\` before every build.
  To take it over permanently, set \`customConfig\` in the \`.msxproj\` (Project
  Settings → *use a custom config*); after that the IDE stops touching it.
- \`content/*.h\` and \`content/*.c\` — resource declarations and tables exported
  from \`res/\` (see below). Both halves are generated; the \`.c\` is compiled for
  you, listed in \`ProjModules\`.
- \`out/\`, \`emul/\`, \`${project.name}_rawdef.h\`, \`version.h\` — build output.

Config values are resolved in this order, last wins:
engine \`setup_global.js\` → \`${path}/projects/default_config.js\` (user-global,
where the emulator path lives) → this project's \`project_config.js\` → CLI args.
So a setting missing from \`project_config.js\` is not unset — it is inherited.

## Resources: \`res/\` in, \`content/\` out

Graphics and sound are authored in the IDE's editors as JSON under \`res/\`
(\`.tiles.json\`, \`.btiles.json\`, \`.meta-tiles.json\`, \`.meta-btiles.json\`,
\`.sprites.json\`, \`.map.json\`, \`.screen.json\`, \`.sfx.json\`) and exported to C in
\`content/\` automatically before every build — a \`.h\` of declarations and a
\`.c\` of tables, both generated. Edit the \`res/\` file (or the editor), never
either half of the output.

A header carries the data tables plus a \`_SIZE\` define per table, and
\`#define\`s locating each named group inside them. If the resource's *Export
ready-made C* box is ticked it also carries working helper functions; that is
off by default, because helpers call into MSXgl and a data-only header must
not. Include \`msxgl.h\` before any header that has helpers.

\`\`\`c
#include "msxgl.h"
#include "content/mytiles.h"
\`\`\`

### Tiles and maps

\`\`\`c
VDP_SetMode(VDP_MODE_GRAPHIC2);                  // SCREEN 2
VDP_LoadPattern_GM2(g_MyTiles_Patterns, 64, 0);  // 64 tiles from tile 0
VDP_LoadColor_GM2(g_MyTiles_Colors, 64, 0);
${
  msx1
    ? `VDP_WriteVRAM_16K(g_MyMap_Background, g_ScreenLayoutLow, 32 * 24);`
    : `VDP_WriteVRAM(g_MyMap_Background, g_ScreenLayoutLow, g_ScreenLayoutHigh, 32 * 24);`
}
\`\`\`

\`VDP_LoadPattern_GM2\` mirrors the data into all three SCREEN 2 banks for you;
\`count\` is a **tile count** (0 means all 256), while the \`VDP_WriteVRAM*\` count
is in **bytes**. On SCREEN 1 there are no banks to mirror — write the tables
directly instead of using the \`_GM2\` helpers.
${
  msx1
    ? `
**Use the \`_16K\` VRAM calls.** This project is MSX1, so \`VDP_VRAM_ADDR_14\` is in
force and \`g_ScreenLayoutHigh\` does not exist — the four-argument
\`VDP_WriteVRAM(src, destLow, destHigh, count)\` is for MSX2's 17-bit addressing.
It compiles cleanly here and silently writes nothing useful. Use
\`VDP_WriteVRAM_16K(src, dest, count)\` and \`VDP_Poke_16K(value, dest)\`.
`
    : ''
}

A map exports one byte-per-cell array *per layer*, named after the layer
(\`background\` → \`g_MyMap_Background\`), plus \`_W\`/\`_H\`. Collision comes from the
tileset's \`_Flags\`, not from the map: \`g_MyTiles_Flags[tile] & FLAG_SOLID\`.
In a pattern mode there is no transparent cell — \`_DrawLayer\` writes the whole
rectangle in one call, so a layer over another paints every cell of it. If you
want holes, compose the rows yourself before writing them (the usual trick is a
flag bit meaning "see through", tested per cell as the row is built).

A tile *block* (a named rectangle of tiles) gets \`_BASE\`, \`_W\`, \`_H\`, so you can
stamp it without knowing where it landed in the bank. With helpers on:

\`\`\`c
// void g_Scenery_DrawBlock(u8 x, u8 y, u16 base, u8 w, u8 h);   // via VDP_WriteLayout_GM2
g_Scenery_DrawBlock(10, 4, G_SCENERY_HOUSE_BASE, G_SCENERY_HOUSE_W, G_SCENERY_HOUSE_H);
// void g_MyMap_DrawLayer(const u8* layer, u8 x, u8 y);
g_MyMap_DrawLayer(g_MyMap_Background, 0, 0);
\`\`\`

### Meta-tiles — optional, and only worth it for big maps

A map costs one byte per cell, and most MSX art repeats in clumps: a brick wall,
a pine tree, a platform end. A **meta-tile set** (\`res/*.meta-tiles.json\`, or
\`*.meta-btiles.json\` over a bitmap tileset) names those clumps once, and a map
pointed at the set indexes *them* instead of tiles. A 32×24 screen of 2×2 metas
is 192 bytes rather than 768, before RLEp.

This is opt-in and nothing else changes: a map that names an ordinary
\`.tiles.json\` exports exactly what it always did. Use it when a map is large
enough for the ROM to notice, and skip it when it is not — the indirection costs
a few cycles per cell drawn and one extra table.

The set exports its metas as one table at a fixed stride, plus
\`_META_W\`/\`_META_H\`/\`_COUNT\` and a \`#define\` per *named* meta. The map exports
its own \`_META_W\`/\`_META_H\`, \`_META_CELLS\` (the stride) and \`_TILE_W\`/\`_TILE_H\`
(its size in tiles — \`_W\`/\`_H\` count metas now). With helpers on the map gains:

\`\`\`c
// The map's cells are meta indices, so pass the set's table in alongside them.
u8 rowbuf[G_MYMAP_TILE_W];
g_MyMap_DrawView(g_MyMap_Background, g_MyMetas, rowbuf, camX, camY, 0, 0, 32, 24);

// Or expand it to plain tiles in RAM, when the game *reads and writes* the map
// — collision, or turning a collected coin into sky. VRAM cannot do that.
u8 world[G_MYMAP_TILE_W * G_MYMAP_TILE_H];
g_MyMap_ExpandToRAM(g_MyMap_Background, g_MyMetas, world);
\`\`\`

Two rules worth knowing before you use it:

- There is **no \`_DrawLayer\` on a meta map**. Writing meta indices into the name
  table would draw whichever tiles happen to share those numbers. \`_DrawView\`
  covering the whole map is the equivalent, and it needs a \`_TILE_W\`-byte row
  buffer instead of the whole map in RAM.
- Compressed meta layers are **unpacked by you**, once, with
  \`RLEp_UnpackToRAM\` — the helpers read an unpacked layer. That is affordable
  precisely because a meta layer is small, and it is what lets the game keep the
  map in RAM and change it.

Collision still reads the tileset's \`_Flags\`, indexed by *tile*: either expand
the map first, or resolve a cell yourself with
\`g_MyMetas[meta * G_MYMAP_META_CELLS + sy * G_MYMAP_META_W + sx]\`.

### Animated tiles

There are two ways to make every coin in a level spin: change *which* tile each
cell points at, or change what that tile *looks like*. **Prefer the second.**

\`\`\`c
// Keep the poses as a 4x1 block in the tileset, then per animation step:
VDP_LoadPattern_GM2(g_MyTiles_Patterns + (G_MYTILES_COIN_BASE + step) * 8, 1, G_MYTILES_COIN_BASE);
\`\`\`

That is 8 bytes into each of the three banks — 24 bytes, once — and every cell
using that tile animates, including the ones scrolled off screen. Re-pointing
cells costs a name-table write per copy per step and leaves off-screen ones
behind. The catch is that it is all-or-nothing: *every* use of the tile
animates, so anything that must hold still needs its own tile.

Pace it yourself — hold each pose for several frames (a counter in the VBlank
loop), don't rewrite VRAM at 50/60 Hz.

${
  msx1
    ? `This is the MSX1 answer and the MSX2 answer alike, in any pattern mode. MSX2
also has palette animation — rewriting one palette entry recolours everything
drawn in it for free, cheaper than any pattern rewrite — but SCREEN 1/2 have a
fixed palette, so it is not available here.`
    : `The same holds in SCREEN 4. In the **bitmap** modes (5–8) there are no
patterns to rewrite: a tile is pixels, so you animate by blitting a different
tile out of the sheet (\`g_MyTiles_Draw(tile, x, y, sheetY)\`, below) at the cell
you want. Cheaper still on MSX2: \`VDP_SetPaletteEntry(i, color)\` recolours
everything drawn in palette index \`i\` at once — colour cycling costs two bytes
per step and no VRAM traffic at all.`
}

### Sprites

Patterns go to VRAM once; after that a character is placed by writing hardware
sprite attributes each frame.

\`\`\`c
VDP_EnableSprite(TRUE);
VDP_SetSpriteFlag(VDP_SPRITE_SIZE_16);
VDP_LoadSpritePattern(g_MyHero_Patterns, 0, G_MYHERO_PATTERNS_SIZE / 8);
${
  msx1
    ? `VDP_SetSpriteSM1(0, x, y, 0, COLOR_WHITE);       // sprite mode 1: one colour per sprite`
    : `VDP_SetSpriteExMultiColor(0, x, y, 0, g_MyHero_Colors);  // mode 2: one colour per line`
}
VDP_DisableSpritesFrom(1);                       // hide the unused planes
\`\`\`

${
  msx1
    ? `In sprite mode 1 (MSX1) a hardware sprite is a single colour. \`_Colors\` is
one byte per plane; pass \`g_MyHero_Colors[plane]\`.`
    : `In sprite mode 2 (MSX2+) each of the 16 lines of a sprite has its own colour
byte, so \`_Colors\` holds **16 bytes per plane** and
\`VDP_SetSpriteExMultiColor\` takes a pointer into it, not a colour.${
        project.machine.includes('1')
          ? `

Careful: \`Machine\` is \`${project.machine}\`, which includes MSX1 — this ROM is
expected to boot on a machine that has no sprite mode 2. Branch on the detected
MSX version at run time and fall back to \`VDP_SetSpriteSM1\`, or drop MSX1 from
\`Machine\` in Project Settings.`
          : ''
      }`
}

### Layered sprites (the important one)

A character bigger or more colourful than one hardware sprite is drawn by
several *planes*. Two things stack:

- **Cells** — \`cols × rows\` of 8×8 or 16×16 sprites: a metasprite.
- **Layers** — up to 4 planes on the *same* cell, drawn on top of each other.
  ${
    msx1
      ? `In sprite mode 1 layers are plain superposition — each plane keeps its own
  single colour and higher-priority planes win, which is the only way to get a
  multi-coloured character on MSX1.`
      : `In sprite mode 2 a layer whose colour byte has the **CC bit** (\`0x40\`) set
  shares priority with the plane above it and their colour codes are **OR'ed**
  where they overlap — that is how you exceed one colour per line. The editor
  writes those bits into \`_Colors\` for you.`
  }

For any character that spans cells or stacks layers, the export adds three
defines per character and a \`_Layout\` table (2 bytes per plane: \`dx, dy\` in
dots from the character's top-left):

\`\`\`c
#define G_MYHERO_WALK_BASE    0   // first plane of the character
#define G_MYHERO_WALK_PLANES  6   // hardware sprites per frame
#define G_MYHERO_WALK_FRAMES  4   // animation frames
\`\`\`

Placing frame \`f\` means writing \`_PLANES\` attribute entries from one
coordinate. With *Export ready-made C* on, that loop is already written:

\`\`\`c
// void g_MyHero_SetMeta(u8 index, u8 x, u8 y, u8 base, u8 planes);
g_MyHero_SetMeta(0, x, y,
    G_MYHERO_WALK_BASE + f * G_MYHERO_WALK_PLANES,
    G_MYHERO_WALK_PLANES);
\`\`\`

\`index\` is the first hardware sprite plane [0:31] to write — advance it by
\`_PLANES\` for each character you place, and call
\`VDP_DisableSpritesFrom(total)\` once afterwards. Frames are consecutive in the
pattern table, which is why the \`base + f * planes\` arithmetic works.

Budget: the VDP has **32 planes** in total and will draw only
**${msx1 ? '4' : '8'} of them on any one scanline** (sprite mode ${msx1 ? '1' : '2'}) — the rest simply
vanish. Every cell and every layer costs one, so a 6-plane hero and two 6-plane
enemies at the same height is already over. Watch the per-line limit before the
total; the sprite editor shows what each character spends.

### Software sprites (\`*.swsprites.json\`)

A different file from \`*.sprites.json\`, and a different thing: those are the
VDP's 32 hardware sprites, these are images blitted **into** the picture. Use
them when the hardware runs out — of colours, of size, or of the four (MSX1) or
eight (MSX2) per scanline.

**Every character carries its own size**, which is why this is not a tileset
with named blocks: a 16×16 hero and an 8×8 bullet live in one sheet. Frames of
one character are all the same size — that is what makes them an animation.

The export is always \`_Data\` plus \`_Info\` (offsetLo, offsetHi, width, height,
frames per character) and a \`#define\` per name, but the *runtime* is whatever
the mode actually has:

| Mode | How a frame is drawn |
|---|---|
| SCREEN 3 | Blitted from ROM by the CPU into the shadow buffer, transparent index skipped |
| SCREEN 5–8 | Every frame in one strip, uploaded once with \`HMMC\`; each draw is one \`LMMM\` with \`VDP_OP_TIMP\` |
| SCREEN 1/2/4 | No pixels to blit — the frame's 8×8 cells are written into a reserved pattern range and the name table points at them |

\`\`\`c
// SCREEN 3, with a screen resource's shadow buffer:
g_Sw_Restore(g_Screen, under, G_SW_HERO, oldX, oldY);
g_Sw_Save(g_Screen, under, G_SW_HERO, x, y);
g_Sw_Draw(g_Screen, G_SW_HERO, frame, x, y);
g_Play_Mark(x, y, g_Sw_Width(G_SW_HERO), g_Sw_Height(G_SW_HERO));
g_Play_Flush(g_Screen);
\`\`\`

Sizes snap to what the blitter can address and the editor will not let you past
it: multiples of 2 blocks across in SCREEN 3, of the mode's dots-per-byte in a
bitmap mode, of 8 in a pattern mode. In SCREEN 1/2/4 the two-colours-per-row
rule applies to sprite art as much as to tiles, and the Problems panel says so
before the export flattens it. The pattern-mode runtime also **borrows real
patterns** — reserve that range in your tileset (\`..._FIRST_PATTERN\` up) or the
sprite overwrites tiles the map is using.

### SCREEN 3 (MULTICOLOR) — the mode with no colour clash

Available on **every** machine, MSX1 included. 64×48 blocks of 4×4 dots, any of
the fixed 16 colours per block, plus the 32 hardware sprites (mode 1). It is the
hardware version of what recent chunky-pixel ZX Spectrum games do by hand.

MSXgl gives you \`VDP_SetModeMultiColor()\` and nothing else — no name-table
initialiser, no conversion, no sample, and \`Draw_*\` is V9938-only. Everything
below is emitted by the exporter, and it calls MSXgl for every VRAM access.

**Two runtime shapes, and a game is in one of them.** The name table decides:

| | Resource | How a screen is drawn | Use it for |
|---|---|---|---|
| Framebuffer | \`*.screen.json\` at \`sc3\` | The name table is boilerplate that makes the pattern table a 1536-byte bitmap | Chunky arcade and puzzle, software sprites, per-block collision |
| Name table | \`*.btiles.json\` at \`sc3\`, **2×2 blocks**, plus a map | \`VDP_WriteLayout_GM2\`, exactly as SCREEN 1/2 | Multi-screen worlds and scrolling |

The cost decides which: a 50 Hz frame is about 71,600 T-states and MSX1 VRAM
runs at ~30 per byte, so a whole framebuffer is 1536 bytes ≈ **64 % of a frame**
and a whole name table is 768 ≈ 32 %. That is why the framebuffer shape never
uploads all of itself per frame, and why a scrolling SCREEN 3 game uses the name
table — where a scroll edge is a couple of dozen bytes and MSXgl's \`scroll\`
module drives it unchanged.

Both shapes need \`VDP_USE_MODE_MC TRUE\` in \`msxgl_config.h\`. **Check it before
anything else if the screen stays blank:** with it FALSE,
\`VDP_SetMode(VDP_MODE_SCREEN3)\` is a silent no-op — no error, and
\`VDP_GetMode()\` still reports MULTICOLOR. The name-table shape also needs
\`VDP_USE_MODE_G2 TRUE\`, which is what compiles \`VDP_WriteLayout_GM2\`.

**Do not \`Print\` in SCREEN 3.** MSXgl's Print module is an empty \`case\` for
this mode, and the pattern table a font would load into *is* the picture. Run
title, menu and credits in SCREEN 1 and switch to SCREEN 3 for play — the
game-kit wizard emits \`GAME_TEXT_VDP_MODE\` for exactly this.

#### Pictures bigger than the screen

A \`*.screen.json\` states its own \`width\`/\`height\`, and they may be **larger
than the display**. That is the only thing separating a screen from a map: past
one screenful the same document is a *world* — packed row by row rather than in
the VDP's byte order, and windowed instead of uploaded.

\`\`\`c
// SCREEN 3: copy the 64x48 view at (camX, camY) into the shadow buffer.
g_World_DrawWindow(g_Screen, camX, camY);   // camX even
g_World_Flush(g_Screen);
\`\`\`

\`_W\`/\`_H\` are the world's size; \`_VIEW_W\`/\`_VIEW_H\` are the display's, and
\`_STRIDE\` is the world's bytes per row. In the bitmap modes the world stays in
ROM and \`_DrawRow(camX, camY, row, destY)\` copies one line with \`HMMC\` — a
scroller calls it for the line coming into view and leaves the rest alone.

Use a world when the art is one continuous picture; use a tilemap when it
repeats, which is almost always cheaper in ROM. They are not exclusive: a map's
tileset can be cut from a world.

#### The framebuffer shape

\`_InitScreen()\` is not optional: it sets the mode *and* writes the 768-byte
name table that makes the pattern table a bitmap. Then everything is drawn into a
RAM shadow you own, and only the 8-byte column strips that changed go to VRAM:

\`\`\`c
static u8 g_Screen[G_PLAY_SIZE];          // 1536 bytes

g_Play_InitScreen();
g_Play_ToBuffer(g_Screen);                // start from the exported picture
g_Play_FlushAll(g_Screen);
// every frame:
g_Play_Plot(g_Screen, x, y, COLOR_WHITE); // blocks, 0..63 by 0..47
g_Play_Flush(g_Screen);                   // only what changed
\`\`\`

\`_Get(buf, x, y)\` reads a block back, and in a mode with no colour clash that
*is* your collision test — the picture is the map. \`_Plot\`, \`_FillRect\`,
\`_Blit\` and \`_DrawTile\` all mark what they touched, so \`_Flush()\` finds it.

Positions and widths must be **even horizontally** (two blocks share a VRAM byte
and the blitters copy bytes); vertically every block row is free.

Turn on **double buffering** in the resource's export block and \`_Flush()\` also
flips the page. It costs no copy: the two pages are two pattern tables and the
flip is one \`VDP_SetPatternTable()\` — the name table holds *indices*, so it is
written once and shared.

#### Chunky software sprites

Use \`*.swsprites.json\` (above): each character its own size, its own frames,
and a \`_Draw\`/\`_Save\`/\`_Restore\` cycle over the shadow buffer.

Two lighter alternatives exist and are worth knowing. A \`*.btiles.json\` tile is
a frame too, and a 1×N block of them is an animation — fine when everything is
one size. And a screen's named **fragments** are frames cut straight out of the
picture, with \`_DrawFrame\`/\`_SaveFrame\` to match. Hardware sprites still float
over all of it, and are the cheaper choice for actors that only move.

#### The name-table shape

A 2×2-block tile is exactly one name-table entry, and nothing else can be. Its
pattern is the tile's two bytes repeated four times, which is what makes it draw
the same at every screen row — the exporter does that, but it is why the table
is \`_Patterns\` and 8 bytes a tile rather than 2.

\`\`\`c
VDP_SetMode(VDP_MODE_SCREEN3);   // not _InitScreen(): the map replaces that name table
g_Tiles_Upload();                // patterns to 0x0000
g_Level_DrawLayer(g_Level_Background, 0, 0);
\`\`\`

Bigger tiles have no name-table shape at all: their map exports a \`_DrawRow\`
that blits into the shadow buffer instead.

**Meta-tile sets do not work over a SCREEN 3 tileset yet.** A meta map's helper
is built on the V9938 command engine, so the export is refused rather than
emitting \`VDP_CommandHMMM\` an MSX1 cannot run — point the map at the tileset
directly.

${
  msx1
    ? `### What this machine does not have

Screen resources (\`.screen.json\`) and bitmap tiles (\`.btiles.json\`) also come
in SCREEN 5–12 flavours, and those need an MSX2 — as do the VDP command engine
(\`VDP_Command*\`), the programmable palette, and the software sprites built on
them. On this machine those two file kinds are useful at \`sc3\` only, described
above. Everything else on screen here is patterns, colour attributes and the 32
hardware sprites. A full-screen SCREEN 2 picture is a tileset plus a map that
uses every tile once; that is what the title screen of \`demo_msx1\` is.`
    : `### Screens, bitmap tiles and bitmap sprites

A converted picture exports \`_Data\` (+ \`_Palette\` where the mode has one) and
\`_W\`/\`_H\`:

\`\`\`c
VDP_SetMode(VDP_MODE_SCREEN5);
VDP_SetPalette(g_Title_Palette);       // 16 entries, 2 bytes each
VDP_WriteVRAM(g_Title_Data, g_ScreenLayoutLow, g_ScreenLayoutHigh, G_TITLE_DATA_SIZE);
\`\`\`

**Bitmap tiles** are the SCREEN 5/6/7/8 counterpart of a pattern tileset: a bank
of small images (any size, not just 8×8) addressed by number. They live in VRAM
off-screen and are blitted by the VDP command engine, so \`VDP_USE_COMMAND\` must
stay TRUE in \`msxgl_config.h\`. With helpers on the header carries the whole
cycle:

\`\`\`c
// void g_MyTiles_Upload(UY sheetY);                                  // HMMC, once at startup
// void g_MyTiles_Draw(u8 tile, UX x, UY y, UY sheetY);               // HMMM out of the sheet
// void g_MyTiles_DrawBlock(const u8* block, u8 w, u8 h, UX x, UY y, UY sheetY);
g_MyTiles_Upload(256);                 // park the sheet below the visible page
g_MyTiles_Draw(cell, x, y, 256);       // one tile onto the screen
\`\`\`

\`sheetY\` is where you parked it — SCREEN 5 shows 212 lines of a 256-line page,
so lines 212+ and the other pages are free VRAM. Keep the sheet at a fixed Y and
pass the same value everywhere.

A **bitmap-mode map** (one whose tileset is a bitmap tileset or a screen read as
a grid) exports \`_DrawRow()\` instead of \`_DrawLayer()\` — one \`HMMM\` per cell,
a row at a time, which is the unit a vertical scroller actually draws. It blits
every cell, so stacking layers needs the map's **transparent cell** set in the
editor; that adds \`_DrawRowOver()\`, the same blit with \`_TRANSPARENT\` skipped:

\`\`\`c
g_Stage_DrawRow(g_Stage_Terrain, row, ATLAS_Y, destY);      // background: every cell
g_Stage_DrawRowOver(g_Stage_Foreground, row, ATLAS_Y, destY); // then what sits on top
\`\`\`

There is no default — cell 0 is an ordinary picture, so a map that names no
transparent cell has none, and the Problems panel says so once it has more than
one layer.

A bitmap map drawn with a **meta-tile set** (\`*.meta-btiles.json\`) keeps that
shape exactly, plus the set's table: \`_DrawRow(layer, metas, row, atlasY,
destY)\`. \`row\` is still a *cell* row and the loop still issues one \`HMMM\` per
cell across the map, so a scroller written against a plain bitmap map ports by
adding one argument and its blit budget does not move.

**Bitmap sprites (software sprites)** are how you get a moving object bigger or
more colourful than the hardware allows in a bitmap mode. MSXgl ships no module
for them — the exporter generalises the engine's \`s_swsprt\` sample instead.
Draw the frames as named *fragments* of a screen resource; they export as one
side-by-side strip, so a single \`HMMC\` uploads every frame at once. With
helpers on you get a save/restore/blit cycle per object:

\`\`\`c
g_Hero_SwSprite hero;
g_Hero_Upload(212);                              // strip → off-screen VRAM
g_Hero_Draw(&hero, G_HERO_WALK, x, y, 212);      // save background, then blit frame
// each frame, before moving:
g_Hero_Restore(&hero, 212);                      // put the saved background back
\`\`\`

The order is the whole trick: **restore what you covered, then draw at the new
position**, and do the VRAM work inside VBlank or you will see tearing. Each
object owns its own \`_SwSprite\` struct — that is where the saved background
lives, backups sitting \`_BACKUP_PITCH\` apart in VRAM.

Blit with the command engine (\`VDP_CommandHMMC\` CPU→VRAM, \`HMMM\` VRAM→VRAM,
\`LMMM\` with \`VDP_OP_TIMP\` for transparent copies), never a per-pixel loop.
Commands block: each \`VDP_Command*\` waits for the previous one, so a long HMMC
stalls the CPU. Hardware sprites are still free on MSX2 — use them for anything
that fits in 16×16 and save software sprites for what doesn't.`
}

### Sound

SFX export as an ayFX bank. Add \`"ayfx/ayfx_player"\` to **LibModules** first,
then \`ayFX_InitBank(g_Sounds)\`, \`ayFX_SetChannel(PSG_CHANNEL_A)\`,
\`ayFX_PlayBank(id, priority)\`. An effect's *position in the list* is its id, so
reordering the bank renumbers them.

### Compression

Maps${msx1 ? '' : ' and screens'} can be exported RLEp-packed (MSXgl's own format). When they
are, the header says so and adds \`_UNPACKED_SIZE\`; unpack with the engine's
\`RLEp_UnpackToRAM\`, which needs \`"compress"\` in **LibModules** (and
\`COMPRESS_USE_RLEP\`/\`COMPRESS_USE_RLEP_DEFAULT\` TRUE in \`msxgl_config.h\`, as
they are by default). The generated helpers change shape with it — a compressed
map's \`_DrawLayer\` takes a scratch buffer you size with \`_UNPACKED_SIZE\`:

\`\`\`c
// The define is per *table*, so it carries the layer's name — not G_MYMAP_UNPACKED_SIZE.
u8 buffer[G_MYMAP_BACKGROUND_UNPACKED_SIZE];
g_MyMap_DrawLayer(g_MyMap_Background, buffer, 0, 0);${
    msx1 ? '' : `
g_Title_Unpack(buffer, 0);   // packed screen: one band at a time, straight to VRAM`
  }
\`\`\`

A map packs all layers or none${
    msx1
      ? ''
      : `, and a packed screen is split into bands with a
\`_Bands\` offset table, because a full SCREEN 5 picture does not fit in one 16 KB
RAM page`
  }. Compression is declined automatically when it would not
shrink the data, so read the header's parameter block rather than assuming.

Compression pays when the data was going to be copied to RAM anyway — a level
you unpack once at startup and then read and write. Unpacking a map you meant to
read straight out of ROM costs you the RAM you were trying to save.

Meta-tiles and RLEp stack: the meta layer is just a smaller array, so it packs
like any other. A meta map's helpers all read an **unpacked** layer, so unpack
it once at startup rather than per call — which is what you wanted anyway, since
a meta layer is small enough to keep in RAM and edit.

## Engine modules

\`#include "msxgl.h"\` pulls in the core (system, bios, vdp, draw, print, input,
memory, math, color, clock, compress, string). Anything else — \`scroll\`,
\`tile\`, \`sprite_fx\`, \`psg\`, \`scc\`, \`fsm\`, the audio replayers — must be listed
in **LibModules** (Project Settings, or \`LibModules\` in \`project_config.js\`) or
it will not be compiled in, and you get a link error, not a helpful one.

Engine sources: \`${path}/engine/src/\`. Ready-made fonts, palettes and math
tables: \`${path}/engine/content/\`. 56 worked samples: \`${path}/projects/samples/\`
— \`s_sprite\` (mode 2), \`s_sm1\` (mode 1), \`s_swsprt\` (software sprites),
\`s_scroll\`, \`s_vdpcmd\`, \`s_game\`. **Read the sample before writing new engine
calls** — it is the fastest way to get a signature right.

## Working rules

1. Prefer MSXgl's API over reimplementing it. If you are writing a VRAM copy
   loop or a sprite attribute writer by hand, there is an engine function for
   it.
2. Verify by building: \`./build.sh all\`. It is fast, and SDCC's errors are the
   only real check on Z80 C — no runtime will catch it later.
3. Z80 reality: no floats, 8-bit is cheaper than 16-bit, \`u8\`/\`u16\`/\`i8\`/\`i16\`
   from MSXgl's types, and globals beat locals for anything hot.
4. When a resource looks wrong, fix it in the editor / \`res/\` file, then
   rebuild — not in \`content/\`.
${kit ? kitChapter(kit) : ''}`
}

function kitChapter(kit: Pick<NewGameRequest, 'kit' | 'audio' | 'displayMode'>): string {
  const credits = attributionLines(kit)
    .map((line) => `- ${line}`)
    .join('\n')
  const bitmap = isBitmapMode(kit.displayMode)
  return `
## This project's game kit

Created from the **${kit.kit}** kit (display \`${kit.displayMode}\`).

Authored C lives in \`${GAME_SOURCE_DIR}/\` — \`${GAME_SOURCE_DIR}/play.c\` is the
play state, \`${GAME_SOURCE_DIR}/screens.c\` is title/menu/credits. \`main.c\` at
the root only starts the state machine. Do not move those files to the root;
\`ProjModules\` lists them as \`${GAME_SOURCE_DIR}/play\` and \`${GAME_SOURCE_DIR}/screens\`.

### The state machine

\`State_Play()\` runs \`Play_Init()\` **once** and hands over to \`State_Resume()\`,
which is the per-frame loop — put gameplay code there, not in \`State_Play\`, or
it re-initializes on every frame. A state returning \`TRUE\` ends the frame;
\`FALSE\` runs the next state immediately (that is how the hand-over works).

### Fonts

\`Game_SetFont()\` in \`${GAME_SOURCE_DIR}/screens.c\` installs the right font for
this display mode${
    bitmap
      ? ": bitmap modes have no pattern table, so it uses MSXgl's own\n`g_Font_MGL_Sample8` rather than the BIOS font"
      : ': the BIOS font, from pattern 1 up. It overwrites tile\npatterns, which is why `Play_Init()` calls it *before* loading the tileset'
  }.

### msxgl_config.h was tuned for this kit

The wizard rewrote a few \`#define\`s the engine modules need — leave them alone
unless you know why they were set:
\`PAWN_USE_SPRT_FX\`/\`PAWN_USE_RT_LOAD\` off (nothing links \`spritefx\`),
\`PAWN_TILEMAP_SRC_VRAM\` (collision reads the map you uploaded), and
\`SCROLL_SRC_W\`/\`SCROLL_SRC_H\`, which **must** stay equal to the exported map's
size — resize \`res/*.map.json\` and you resize these too.
${
  bitmap
    ? `
### Pictures in a bitmap mode

A SCREEN ${kit.displayMode.slice(2)} picture is ~27 KB and does not fit in the 32 KB the mapper pages
in at boot, so this kit ships **no** screen resource — \`Play_Init()\` fills the
panel with a VDP command instead. To ship a real one: export it as a raw file
(\`format: "bin"\`), place it in the \`.msxproj\`'s \`files.rawFiles\` at an offset
whose bitmap starts on an 8 KB segment boundary, then page that segment into
bank 3 and blit it with \`VDP_CommandHMMC\` — the way \`demo_msx2\` does.
`
    : ''
}
### Credits you must keep

${credits}
`
}
