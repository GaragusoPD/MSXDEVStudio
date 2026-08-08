// ─────────────────────────────────────────────────────────────────────────────
// Canyon Runner — the shared vocabulary.
//
// Everything here is a fact about the machine or the stage that more than one
// chapter needs. Which file owns which global is written next to it.
// ─────────────────────────────────────────────────────────────────────────────
#pragma once

#include "msxgl.h"
#include "rom_mapper.h"
#include "keyboard.h"
#include "psg.h"
#include "ayfx/ayfx_player.h"

#include "content/stage.h"
#include "content/fleet.h"
#include "content/mist.h"
#include "content/hud.h"
#include "content/sfx.h"
// Written by MSXgl's build tool from the RawFiles list in the .msxproj: where
// each raw blob ended up in the 128 KB ROM.
#include "canyon_rawdef.h"

// ── the screen ──────────────────────────────────────────────────────────────

#define VIEW_W 256
#define VIEW_H 212
#define CELL 16

#define MAP_COLS G_STAGE_W
#define MAP_ROWS G_STAGE_H
#define WORLD_H ((u16)MAP_ROWS * CELL)

/** The first display line below the status band — the top of the play area. */
#define PLAY_TOP (HUD_H + 4)

// ── VRAM ────────────────────────────────────────────────────────────────────
//
// The VDP command engine addresses all 128 KB as one 256-dot-wide column, so a
// Y past 255 simply means the next page. That is the whole reason this project
// sets VDP_UNIT_U16: a `u8` Y could only ever name page 0.
//
// Page 0 (Y 0–255) is the scrolling world, and *all* of it is: R#23 wraps at
// 256, so there is no spare strip at the bottom to keep anything in. That is
// also why the sprite tables are moved out of their default home at 0x7600 —
// it sits in rows 212–255 of page 0, which the scroll walks straight through.
//
// R#23 moves the sprite plane along with the bitmap, so every sprite Y goes
// through `Scroll_SpriteY` on its way to the VDP. See scroll.c.

#define HUD_BAND_Y 256 // page 1, row 0: the status band the split screen shows
#define MIST_Y 320 // page 1: the mist strip, and its backups 16 rows below
#define ATLAS_Y 512 // page 2: the tile atlas, 256×48
#define HUD_STRIP_Y 576 // page 2: the HUD artwork, blitted into the band when it changes
#define BOSS_Y 608 // page 2: the boss frames, side by side

// ── the art that lives in ROM segments, not in the 32 KB the code shares ─────
//
// The atlas, the two pictures, the boss and the ending panels are all blobs the
// build tool places by absolute offset, and all of them reach VRAM the same
// way: page the segment into the window, one HMMC, page it back. Keeping them
// out of `_CODE` is not tidiness — it is what leaves bank 3 free to *be* the
// window. See screens.c.
#define BOSS_W 68
#define BOSS_H 40
#define BOSS_FRAMES 2
#define BOSS_REST 0
#define BOSS_FLEX 1

#define MSG_W 96
#define MSG_H 18
#define MSG_VICTORY 0
#define MSG_GAMEOVER 1
// Page 3, which nothing else uses. The boss is assembled here rather than on the
// picture — see bossfight.c.
#define BOSS_BG_Y 768 // the arena band, as it looks with no boss standing on it
#define BOSS_COMP_Y 816 // where the next frame of the boss is put together
#define ENDINGS_Y 864 // the two ending panels, side by side

//
// The sprite attribute address has to be **1 KB-aligned plus 0x200**, and
// getting that wrong is silent. In the MSX2 bitmap modes the VDP takes R#5/R#11,
// masks the address down to a 1 KB boundary, and puts the *colour* table there
// and the *attribute* table 0x200 above it. MSXgl matches that — it writes the
// attributes at the address you hand it and the colours 0x200 below — but only
// if the address you hand it already sits where the VDP will look. Hand it a
// 1 KB boundary + 0x380 (which looks just as plausible, since MSXgl ORs A9–A7
// into R#5) and MSXgl writes the sprites 0x180 bytes from where the VDP reads
// them. Nothing complains; no sprite is ever drawn again.
#define VRAM_SPRITE_ATTR 0x0EE00UL // colours 0x0EC00–0x0EDFF, attributes above
#define VRAM_SPRITE_PATTERN 0x0F000UL // 0x0F000–0x0F7FF

// ── hardware sprite planes ──────────────────────────────────────────────────
//
// 32 planes, handed out once here so no two chapters can claim the same one.

#define SPR_SHIP 0 // 2 planes: hull, and the OR-colour plane over it
#define SPR_SHOT 2 // 4 planes, one per shot in flight
#define SPR_DRONE 6 // 8 planes, one per drone

/**
 * The status band: the top 24 lines of the screen, and the one place this demo
 * splits the display.
 *
 * The frame *starts* on the band — page 1, no offset, sprites off — and at line
 * HUD_H the H-blank interrupt hands the rest of the screen to the scrolling
 * world on page 0. The band is painted once, when the numbers on it change, and
 * then simply sits there on a page nothing scrolls.
 *
 * It is at the top rather than the bottom for one reason, and it is a timing
 * one. The split is only clean if the CPU is in a known state when the
 * interrupt arrives: MSXgl sets a VDP command up by writing fifteen registers
 * with interrupts disabled, so an interrupt landing mid-burst waits — by a
 * different amount every frame, which frays the join. With the band at the
 * bottom the split fires at line 188, deep into the frame's blitting, and the
 * frame's blitting is measurably able to run the whole 240 lines. With it at the
 * top the loop can simply *wait* for the split before it starts work, so the
 * interrupt is always taken from a `halt` and always lands in the same place.
 *
 * This is also what the split screen is for in the first place. Pointing both
 * bands at the *same* page with different offsets — the classic two-speed
 * parallax — was tried first and looked like a tear, because the strip across
 * the join showed an unrelated part of the same canyon. A status bar has no
 * business lining up with the ground, so its join stops being a seam and starts
 * being a frame.
 */
#define HUD_H 24
/** The bar and the count, tucked against the right end of the band. */
#define HUD_X 192

/**
 * How many lines early R#19 has to be set for the world to start on line HUD_H.
 *
 * The line interrupt fires at the *end* of the line R#19 names, and then the
 * Z80 has to finish its instruction, take the interrupt, save registers, read
 * S#1 to find out which interrupt it was, and only then write R#2, R#23 and
 * R#8. That is several scanlines on a 3.58 MHz machine — measured, not guessed.
 *
 * With the loop waiting for the split before it does anything, the interrupt is
 * always taken from a `halt` and this is consistent frame to frame, so a fixed
 * lead corrects it exactly.
 */
#define HUD_SPLIT_LEAD 4

/**
 * A calibrated pause before the handler touches a register, in loop iterations.
 *
 * The interrupt does not arrive at the start of a line, it arrives partway
 * along one — so the page switch takes effect in the *middle* of a scanline and
 * the band's top edge comes out as a step: canyon for the first seventy-odd
 * dots, black for the rest. Waiting a moment first pushes the switch into the
 * horizontal blanking, where changing R#2 costs nothing visible and the edge
 * comes out straight.
 *
 * ponytail: this is a cycle count, so it is specific to a 3.58 MHz Z80 — it was
 * measured, not derived. If the top of the band ever shows a step again (a
 * turbo machine, a different ISR), this is the one knob to turn.
 */
#define HUD_SPLIT_DELAY 12

/** Display row the ending panels sit on — centred in the play area. */
#define MSG_Y ((VIEW_H - MSG_H) / 2)

/** A few painted rows past the join, so a switch landing late still lands on band. */
#define HUD_PAINT_H (HUD_H + 8)

#define MAX_SHOTS 4
#define MAX_DRONES 8

/**
 * How long each frame of an explosion is held. The whole burst is this times
 * `G_FLEET_BOOM_FRAMES`, so adding a frame in the sprite editor lengthens it
 * without anything here changing.
 */
#define BOOM_HOLD 4
#define BOOM_TOTAL (G_FLEET_BOOM_FRAMES * BOOM_HOLD)

/** Hits the hull takes before a life is lost. */
#define MAX_ENERGY 3
/** Frames of grace after a hit — long enough to fly out of whatever caused it. */
#define HIT_GRACE 60

// ── palette ─────────────────────────────────────────────────────────────────

/** The three entries the vein animation rotates. See datasrc/palette.mjs. */
#define VEIN_FIRST 8
#define VEIN_COUNT 3

// ── what a cell *means* ─────────────────────────────────────────────────────
//
// One byte per tile, carried by the tileset itself (`res/canyon.btiles.json`,
// bit 0 solid, bit 1 pit) and exported at the tail of the atlas blob.
//
// This used to be a range check — cells 16 to 31 were the walls, because that
// is where they happened to sit in the atlas. It worked, and it made the atlas
// *order* load-bearing: every tile added in the middle renumbered the map, and
// a tile could not be made solid without moving it into the range. A flag byte
// says what a tile is rather than where it is, so the atlas can be rearranged
// freely and a new wall is a checkbox in the tile editor.

#define TILE_SOLID 0x01
#define TILE_PIT 0x02

/**
 * The shape of `data/atlas.bin`, which the tileset editor decides and this has
 * to agree with: palette, then the tile sheet padded to whole rows of sixteen,
 * then one flag byte per tile, then the blocks table.
 *
 * The sheet is padded, so its size follows the *rows* rather than the tile
 * count — a bank of 60 tiles still occupies four full rows of sixteen. Both are
 * spelled out here and checked against the blob below, because getting them
 * wrong reads the flags out of the middle of the artwork and says nothing.
 */
#define ATLAS_TILES 60
#define ATLAS_ROWS 4
#define ATLAS_COLS 16
#define ATLAS_SHEET_BYTES (ATLAS_ROWS * ATLAS_COLS * CELL * CELL / 2)
/** Where the flag table starts, once the sheet is behind it. */
#define ATLAS_FLAGS_ABS (ATLAS_BIN_ABS + 32 + ATLAS_SHEET_BYTES)

// The build tool sizes the blob from the file on disk before anything is
// compiled, so this is an honest check rather than a guess: palette + sheet +
// flags is the minimum, and the blocks table is the only slack above it.
#if (ATLAS_BIN_SIZE < 32 + ATLAS_SHEET_BYTES + ATLAS_TILES) || \
	(ATLAS_BIN_SIZE > 32 + ATLAS_SHEET_BYTES + ATLAS_TILES + 512)
#error "ATLAS_TILES/ATLAS_ROWS do not match data/atlas.bin — open res/canyon.btiles.json, note its tile count, and update canyon.h."
#endif

extern u8 g_TileFlags[ATLAS_TILES];

#define IsWall(cell) (g_TileFlags[cell] & TILE_SOLID)

// ── state ───────────────────────────────────────────────────────────────────

typedef enum
{
	STATE_TITLE,
	STATE_PLAY,
	STATE_BOSS,
	STATE_DEAD,
	STATE_OVER,
	STATE_WIN
} GameState;

// main.c
/** The 32 palette bytes, copied out of the atlas blob so they can be read without paging. */
extern u8 g_Palette[32];
extern u8 g_VBlank;
extern u8 g_Frame;
extern GameState g_State;
extern u8 g_Lives;
extern u8 g_Energy;
void PlaySfx(u8 id);

// scroll.c — the four parallax layers
extern u16 g_ViewY; // display line L shows world row g_ViewY + L
void Scroll_Present(void);
/** Called from the H-blank handler: hands the rest of the screen to the world. */
void Scroll_World(void);

/** Where the frame is: `Scroll_Present` resets it, the line interrupt moves it on. */
#define PHASE_BAND 0  // above the join; the band is on screen
#define PHASE_WORLD 1 // the split has happened; the world is on screen
extern u8 g_Phase;
/** Turns the status band on for the game and off for the title and credits screens. */
void Scroll_ShowBand(u8 on);
/** Parks the display at the top of the page — for the full-screen pictures. */
void Scroll_Reset(void);
extern u8 g_BandOn;
/** The page row a screen line is currently drawn from — the bitmap counterpart of Scroll_SpriteY. */
u8 Scroll_PageRow(u8 screenY);
u8 Scroll_SpriteY(u8 screenY);
void Scroll_HideSprite(u8 index);
void Scroll_Start(void);
void Scroll_Update(void);
void Scroll_Mist(void);
void Scroll_MistOff(void);
u8 Scroll_CellAt(u8 screenX, u8 screenY);

// player.c
extern u8 g_ShipX, g_ShipY;
void Player_Start(void);
void Player_Update(void);
void Player_Hide(void);
/** One hit on the hull: spends a bar block, and a life when the last one goes. */
void Player_Damage(void);
u8 Player_HitBy(u8 x, u8 y, u8 w, u8 h);
/** Returns the shot that hit the box and retires it, or MAX_SHOTS for none. */
u8 Player_ShotHits(u8 x, u8 y, u8 w, u8 h);

// enemy.c
void Enemy_Start(void);
void Enemy_Update(void);
void Enemy_Hide(void);

// boss.c
void Boss_Start(void);
/**
 * Drives the boss's death one frame at a time; FALSE once it is over. The
 * caller owns the frame, so this stays out of the business of waiting.
 */
bool Boss_Exploding(void);
/** Forgets the saved arena band, because a new stage draws a different one. */
void Boss_Reset(void);
/** FALSE once the boss is gone. */
bool Boss_Update(void);

// screens.c
void Screens_Title(void);
void Screens_Credits(void);
/** A panel over whatever is on screen — MSG_VICTORY or MSG_GAMEOVER. */
void Screens_Message(u8 panel);
/** Uploads every ROM-resident sheet into the pages the display never shows. */
void Screens_LoadArt(void);
