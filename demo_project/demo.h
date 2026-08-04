// ─────────────────────────────────────────────────────────────────────────────
//  The vocabulary every part of the demo shares: what the generated resources
//  are called, how the level is laid out, what a tile flag means, and which
//  file owns which piece of state.
//
//  Each `.c` beside this one is a chapter of the same story:
//
//    level.c   the level in RAM — read it, collide with it, scroll it
//    view.c    everything that reaches the name table — the view, the HUD,
//              the coin animation
//    player.c  the character — move, jump, collect, turn around
//    screens.c the title picture and the credits
//    main.c    setup, and the loop that drives the rest
// ─────────────────────────────────────────────────────────────────────────────
#pragma once

#include "msxgl.h"
// msxgl.h does not pull the sound modules in; the ayFX sample includes them the
// same way. `psg.h` is needed for PSG_Apply(), which pushes ayFX's register
// buffer to the sound chip.
#include "psg.h"
#include "ayfx/ayfx_player.h"
// Sprite mirroring: msxgl.h does not pull this one in either, and "sprite_fx"
// has to be in the project's LibModules.
#include "sprite_fx.h"

// MSXgl's own 8x8 font, which also carries its logo as characters 1 to 6.
#include "font/font_mgl_sample8.h"

#include "content/tiles.h"
#include "content/intro_tiles.h"
#include "content/intro_map.h"
#include "content/player_sprites.h"
#include "content/level_map.h"
#include "content/background_map.h"
#include "content/sfx.h"

//──────────────────────────────────────────────────────────────────────────────
// Level and tile layout
//──────────────────────────────────────────────────────────────────────────────


#define MAP_W        64          // two screens wide
#define VIEW_W       32          // what fits on screen
#define VIEW_H       24          // screen rows
#define MAX_CAM      (MAP_W - VIEW_W)

/**
 * The level only covers the bottom of the screen. Everything above `LEVEL_TOP`
 * was sky, so it is the backdrop's alone: those rows never scroll, which means
 * they are written once and never redrawn, and a scroll step costs half the
 * work it used to. Anything above the level counts as empty for collision.
 */
#define LEVEL_TOP    12
#define LEVEL_H      (VIEW_H - LEVEL_TOP)

/** The level cell at world tile (tx, ty). Only valid for ty >= LEVEL_TOP — `TileAt` is the guarded way in. */
#define MapCell(tx, ty) (g_Map[((u16)((ty) - LEVEL_TOP) * MAP_W) + (u16)(tx)])

// The screen column the player is drawn on while the map is scrolling. It is
// where the centring camera puts them anyway, so the pin never moves them.
#define PLAYER_PIN_X ((VIEW_W / 2) * 8)

// Tile indices, matching the order of res/tiles.tiles.json. Only the ones the code
// draws with are named; what a tile *does* is a flag, not an index.
#define T_SKY        0
#define T_COIN       6           // for the HUD icon, and the slot the spin animates
#define T_TRANS      39          // carries flag 8: the backdrop shows here instead
#define T_DIGIT_0    16          // digits live at 16..25, so tile = T_DIGIT_0 + value

// Where the level's door stands, so the open one can be stamped over it.
#define DOOR_COL     60
#define DOOR_ROW     18

// The coin spin: the block's cells are the poses, in order. Holding each for a
// few frames is what makes it read as a turn rather than a flicker.
#define COIN_POSES   G_TILES_COIN_SPIN_W
#define COIN_RATE    10

// The tile editor's eight flag squares, as this game reads them. Set flag 1 on
// a tile and it becomes solid, anywhere it appears in any map; nothing here
// needs to know which tile index that was.
#define FLAG_SOLID   0x01        // flag 1
#define FLAG_COIN    0x02        // flag 2
#define FLAG_EXIT    0x04        // flag 3
#define FLAG_TRANS   0x80        // flag 8 (bit 7): show the backdrop here instead

/** What the tileset says this tile does. `g_Tiles_Flags` is one byte per tile. */
#define TileFlags(t) (g_Tiles_Flags[t])

/**
 * The one rule that makes the backdrop a layer: what the screen shows at a
 * cell is the level's tile, unless that tile is flagged transparent, in which
 * case it is whatever the backdrop has at the *same screen position*. `back`
 * points at that backdrop cell.
 *
 * A macro rather than a function because the redraw runs it 768 times in a
 * frame; the call overhead alone would cost more than the merge.
 */
#define ScreenTile(tile, back) ((TileFlags(tile) & FLAG_TRANS) ? (back) : (tile))

// The MSXgl logo, drawn with characters 1-6 of any MSXgl font.
#define MSX_GL       "\x02\x03\x04\x05"


// Each pose is one frame of the sprite sheet; a frame is two superposed
// planes, and g_PlayerSprites_SetMeta works out the patterns and colours for both.
#define FRAME_STAND  0
#define FRAME_JUMP   5
// Six poses per stride: legs together, two steps out on one side, together
// again, then two on the other. Small differences between neighbouring poses
// are what makes it read as walking rather than flicker.
#define WALK_STEPS   6
#define WALK_RATE    8           // frames each pose is held

// Player physics, in 1/8th pixels so gravity can be gentler than one pixel.
#define SUBPIXEL     8
#define GRAVITY      2           // 0.25 px per frame, per frame
#define JUMP_POWER   36          // 4.5 px per frame upwards
#define WALK_SPEED   1           // whole pixels per frame
#define MAX_FALL     40          // terminal velocity, 5 px per frame

//──────────────────────────────────────────────────────────────────────────────
// Shared state. Each global is defined in the file that owns it — named here so
// the others can read it, and so it is obvious where to go looking.
//──────────────────────────────────────────────────────────────────────────────

//──────────────────────────────────────────────────────────────────────────────

/**
 * The level, copied out of ROM so it can be edited as it is played: taking a
 * coin turns that cell into sky here, and everything downstream (the screen
 * blit, collision, the exit check) reads this one array. Drawing straight from
 * the ROM copy and painting the collected coins out afterwards is what made
 * them flash back into view for a frame whenever the screen scrolled.
 */
extern u8  g_Map[MAP_W * LEVEL_H];

/**
 * The backdrop, one screen wide and pinned to the screen: it does not scroll,
 * so it is indexed by *view* column rather than by world column. SCREEN 2 has
 * one name table and no hardware layers, so "behind" happens here — see
 * `ScreenTile()`. Unpacked from ROM once, like the level.
 */
extern u8  g_Back[VIEW_W * VIEW_H];

/** One row of the composed view, so a scroll step is still one VDP write per row. */
extern u8  g_Row[VIEW_W];

/**
 * Which level rows hold a transparent cell at all. The ground rows hold none,
 * so they skip the merge and go to VRAM straight out of the level — the same
 * blit the game did before it had a backdrop. Kept current by whoever writes a
 * transparent tile into the level (see `CollectCoins`).
 */
extern u8  g_RowHasTrans[LEVEL_H];

extern u8  g_Remaining;
extern i16 g_PlayerX;       // pixels, top-left of the 16x16 sprite
extern i16 g_PlayerY;
extern i16 g_VelY;          // 1/8th pixels per frame
extern u8  g_OnGround;
extern u8  g_CamX;          // leftmost visible column, in tiles
extern u8  g_Frame;
extern u8  g_CoinPhase;     // which pose of the spin is currently in the pattern table
extern u8  g_CoinTick;
extern u8  g_DoorOpen;
extern u8  g_FaceLeft;      // which way the player is drawn facing

// The stride, as sprite *frame* numbers now rather than raw shape values:
// g_PlayerSprites_SetMeta turns a frame into the right pattern for each of its planes.
// Frames 1/2 step out one way and 3/4 the other, legs together in between.
extern const u8 g_WalkCycle[WALK_STEPS];

//──────────────────────────────────────────────────────────────────────────────
// What each file offers the others
//──────────────────────────────────────────────────────────────────────────────

// level.c
u8   TileAt(i16 tx, i16 ty);
bool IsSolid(u8 tile);
bool BoxHitsSolid(i16 px, i16 py);
bool UpdateCamera();
void OpenDoor();

// view.c
void DrawBackdropTop();
void DrawView();
void DrawHUD();
void SpinCoins();

// player.c
void MoveX(i16 dx);
void ApplyGravity();
void CollectCoins();
bool AtExit();
void FacePlayer(u8 left);

// screens.c
void BeginTextScreen();
void PrintAt(u8 x, u8 y, const c8* text);
void TitleScreen();
void CreditsScreen();
void WaitForSpace();
