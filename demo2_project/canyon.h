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
#include "content/boss.h"
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

/** A margin at the top of the play area, so nothing spawns half off screen. */
#define PLAY_TOP 8

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

#define ATLAS_Y 256 // page 1: the tile atlas, 256×48
#define MIST_Y 320 // page 1: the mist strip, and its backups 16 rows below
#define HUD_BAND_Y (256 + HUD_Y) // page 1: the status band the split screen shows
#define BOSS_Y 544 // page 2: the boss frames, and its backup 40 rows below
#define HUD_STRIP_Y 512 // page 2: the HUD artwork, blitted into the band when it changes

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
 * The status band, and the one place this demo splits the screen.
 *
 * Everything above HUD_Y is page 0 scrolled by R#23. At that line the H-blank
 * interrupt switches the display to **page 1 with no offset**, so the bottom of
 * the screen shows a fixed strip of a page nothing scrolls. The band is drawn
 * once, when the numbers on it change, and then simply sits there.
 *
 * This is what the split screen is actually for. Pointing both bands at the
 * *same* page and giving them different offsets — the classic two-speed
 * parallax — was tried first and looked like a tear, because the strip above
 * the join showed an unrelated part of the same canyon. Content that is meant
 * to be discontinuous with the world is a different matter: a status bar has no
 * business lining up with the ground, so the join stops being a seam and starts
 * being a frame.
 *
 * It also makes the HUD free. Composited into the scrolling page instead, it
 * would have to be lifted and put back down every frame — and 16 frames out of
 * every 256 it would straddle the ring's seam at row 0, where the VDP's command
 * engine does not wrap. That is a blink once every five seconds, and a fifth of
 * the frame's blitting budget to boot.
 */
#define HUD_Y 188
#define HUD_H (VIEW_H - HUD_Y)
#define HUD_X 192

#define MAX_SHOTS 4
#define MAX_DRONES 8

/** Hits the hull takes before a life is lost. */
#define MAX_ENERGY 3
/** Frames of grace after a hit — long enough to fly out of whatever caused it. */
#define HIT_GRACE 60

// ── palette ─────────────────────────────────────────────────────────────────

/** The three entries the vein animation rotates. See datasrc/palette.mjs. */
#define VEIN_FIRST 8
#define VEIN_COUNT 3

// ── the atlas, by name ──────────────────────────────────────────────────────
//
// Cell numbers, matching the order in datasrc/make-art.mjs. Only the ranges the
// game actually asks questions about are named.

#define CELL_WALL_FIRST 16
#define CELL_WALL_LAST 31
#define CELL_PIT_FIRST 32
#define CELL_PIT_LAST 40

#define IsWall(cell) ((cell) >= CELL_WALL_FIRST && (cell) <= CELL_WALL_LAST)

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
/** FALSE once the boss is gone. */
bool Boss_Update(void);

// screens.c
void Screens_Title(void);
void Screens_Credits(void);
void Screens_LoadAtlas(void);
