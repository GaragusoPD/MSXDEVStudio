/**
 * The `CLAUDE.md` / `AGENTS.md` pair scaffolded into a new project: what an AI
 * coding agent has to know to work inside an MSXDEVStudio project without
 * fighting the IDE (hand-editing generated files) or inventing MSXgl APIs.
 *
 * Same shape as `launcherScripts` in `project.ts`, so `createProject` and the
 * examples fork write both families the same way. Electron-free.
 */

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
  msxglPath: string
): { name: string; content: string }[] {
  const content = agentGuide(project, msxglPath)
  return [
    { name: 'CLAUDE.md', content },
    { name: 'AGENTS.md', content }
  ]
}

function agentGuide(project: MsxProject, msxglPath: string): string {
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
- \`content/*.h\` — resource tables exported from \`res/\` (see below).
- \`out/\`, \`emul/\`, \`${project.name}_rawdef.h\`, \`version.h\` — build output.

Config values are resolved in this order, last wins:
engine \`setup_global.js\` → \`${path}/projects/default_config.js\` (user-global,
where the emulator path lives) → this project's \`project_config.js\` → CLI args.
So a setting missing from \`project_config.js\` is not unset — it is inherited.

## Resources: \`res/\` in, \`content/\` out

Graphics and sound are authored in the IDE's editors as JSON under \`res/\`
(\`.tiles.json\`, \`.btiles.json\`, \`.sprites.json\`, \`.map.json\`, \`.screen.json\`,
\`.sfx.json\`) and exported to C headers in \`content/\` automatically before
every build. Edit the \`res/\` file (or the editor), never the header.

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
(\`background\` → \`g_MyMap_Background\`), plus \`_W\`/\`_H\`. On layers above the
first, tile 0 means transparent. Collision comes from the tileset's \`_Flags\`,
not from the map: \`g_MyTiles_Flags[tile] & FLAG_SOLID\`.

A tile *block* (a named rectangle of tiles) gets \`_BASE\`, \`_W\`, \`_H\`, so you can
stamp it without knowing where it landed in the bank. With helpers on:

\`\`\`c
// void g_Scenery_DrawBlock(u8 x, u8 y, u16 base, u8 w, u8 h);   // via VDP_WriteLayout_GM2
g_Scenery_DrawBlock(10, 4, G_SCENERY_HOUSE_BASE, G_SCENERY_HOUSE_W, G_SCENERY_HOUSE_H);
// void g_MyMap_DrawLayer(const u8* layer, u8 x, u8 y);
g_MyMap_DrawLayer(g_MyMap_Background, 0, 0);
\`\`\`

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

${
  msx1
    ? `### What this machine does not have

Screen resources (\`.screen.json\`) and bitmap tiles (\`.btiles.json\`) are
SCREEN 5–12 only, so on MSX1 they are not available — and neither is the VDP
command engine (\`VDP_Command*\`), the programmable palette, or software sprites
built on them. Everything on screen here is patterns, colour attributes and the
32 hardware sprites. A full-screen picture is a tileset plus a map that uses
every tile once; that is what the title screen of \`demo_msx1\` is.`
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
u8 buffer[G_MYMAP_UNPACKED_SIZE];
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
`
}
