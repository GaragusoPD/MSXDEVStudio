// ─────────────────────────────────────────────────────────────────────────────
//  MSXStudio demo: a two-screen platformer
//
//  Collect all eight coins, then reach the door on the far right.
//  Arrows move, SPACE jumps.
//
//  Every graphic and sound in here was made with MSXStudio's own editors and
//  exported to the headers included below:
//
//    tiles.tiles.json    -> content/tiles.h   (g_Tiles_Patterns / _Colors)
//    player.sprites.json -> content/player.h  (g_Player_Patterns / _Colors)
//    level.map.json      -> content/level.h   (g_Level_Background, 64x24 cells)
//    sfx.sfx.json        -> content/sfx.h     (g_Sfx, an ayFX bank)
//
//  Built with MSXStudio by P.D. Garaguso.
//  Powered by MSXgl and MSXtk by Guillaume "Aoineko" Blanchard (CC BY-SA 4.0),
//  compiled with SDCC, sound in Shiru's ayFX format.
//  None of the above endorse this demo. The in-game credits screen says the
//  same thing, which is what MSXStudio's license asks of anything made with it.
// ─────────────────────────────────────────────────────────────────────────────

#include "msxgl.h"
// msxgl.h does not pull the sound modules in; the ayFX sample includes them the
// same way. `psg.h` is needed for PSG_Apply(), which pushes ayFX's register
// buffer to the sound chip.
#include "psg.h"
#include "ayfx/ayfx_player.h"

// MSXgl's own 8x8 font, which also carries its logo as characters 1 to 6.
#include "font/font_mgl_sample8.h"

#include "content/tiles.h"
#include "content/player.h"
#include "content/level.h"
#include "content/sfx.h"

//──────────────────────────────────────────────────────────────────────────────
// Level and tile layout
//──────────────────────────────────────────────────────────────────────────────

#define MAP_W        64          // two screens wide
#define MAP_H        24
#define VIEW_W       32          // what fits on screen
#define MAX_CAM      (MAP_W - VIEW_W)

// Tile indices, matching the order of tiles.tiles.json. Only the ones the code
// draws with are named; what a tile *does* is a flag, not an index.
#define T_SKY        0
#define T_COIN       6           // for the HUD icon
#define T_DIGIT_0    16          // digits live at 16..25, so tile = T_DIGIT_0 + value

// The tile editor's eight flag squares, as this game reads them. Set flag 1 on
// a tile and it becomes solid, anywhere it appears in any map; nothing here
// needs to know which tile index that was.
#define FLAG_SOLID   0x01        // flag 1
#define FLAG_COIN    0x02        // flag 2
#define FLAG_EXIT    0x04        // flag 3

/** What the tileset says this tile does. `g_Tiles_Flags` is one byte per tile. */
#define TileFlags(t) (g_Tiles_Flags[t])

// The MSXgl logo, drawn with characters 1-6 of any MSXgl font.
#define MSX_GL       "\x01\x02\x03\x04\x05\x06"


// Sprite frames are 16x16, so each one occupies 4 pattern slots, and the shape
// passed to the VDP is the frame index times four.
#define FRAME_STAND  0
#define FRAME_JUMP   20
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
// State
//──────────────────────────────────────────────────────────────────────────────

/**
 * The level, copied out of ROM so it can be edited as it is played: taking a
 * coin turns that cell into sky here, and everything downstream (the screen
 * blit, collision, the exit check) reads this one array. Drawing straight from
 * the ROM copy and painting the collected coins out afterwards is what made
 * them flash back into view for a frame whenever the screen scrolled.
 */
u8  g_Map[MAP_W * MAP_H];

u8  g_Remaining;
i16 g_PlayerX;       // pixels, top-left of the 16x16 sprite
i16 g_PlayerY;
i16 g_VelY;          // 1/8th pixels per frame
u8  g_OnGround;
u8  g_CamX;          // leftmost visible column, in tiles
u8  g_Frame;

// The stride, as sprite shape values. Frames 1/2 step out one way and 3/4 the
// other, with the legs-together pose in between each pair.
const u8 g_WalkCycle[WALK_STEPS] = { 0, 4, 8, 0, 12, 16 };

//──────────────────────────────────────────────────────────────────────────────
// Map helpers
//──────────────────────────────────────────────────────────────────────────────

// The level is a flat array of one byte per cell, straight from the map editor.
u8 TileAt(i16 tx, i16 ty)
{
	if ((tx < 0) || (tx >= MAP_W) || (ty < 0) || (ty >= MAP_H)) return T_SKY;
	return g_Map[(u16)ty * MAP_W + (u16)tx];
}

bool IsSolid(u8 tile)
{
	return (TileFlags(tile) & FLAG_SOLID) != 0;
}

// True when the 16x16 box at (px, py) overlaps any solid tile.
bool BoxHitsSolid(i16 px, i16 py)
{
	i16 left   = px >> 3;
	i16 right  = (px + 15) >> 3;
	i16 top    = py >> 3;
	i16 bottom = (py + 15) >> 3;
	// Below the last row counts as floor, so the player cannot fall out.
	if (bottom >= MAP_H) return TRUE;
	for (i16 ty = top; ty <= bottom; ++ty)
		for (i16 tx = left; tx <= right; ++tx)
			if (IsSolid(TileAt(tx, ty))) return TRUE;
	return FALSE;
}

//──────────────────────────────────────────────────────────────────────────────
// Drawing
//──────────────────────────────────────────────────────────────────────────────

// One VDP write per row: the visible 32 columns are contiguous in the map,
// so the window can be blitted straight out of ROM without a RAM buffer.
void DrawView()
{
	// The window is already correct in `g_Map`, so each row is one write and
	// the screen is never shown holding a tile that is no longer there.
	for (u8 row = 0; row < MAP_H; ++row)
	{
		const u8* src = g_Map + ((u16)row * MAP_W) + (u16)g_CamX;
		u16 dst = g_ScreenLayoutLow + ((u16)row * VIEW_W);
		VDP_WriteVRAM_16K(src, dst, VIEW_W);
	}
}

// Coins left, drawn with the digit tiles built into the tileset.
void DrawHUD()
{
	VDP_Poke_16K(T_COIN, g_ScreenLayoutLow + 1);
	// Two digits when the level holds ten coins or more, so a hand-painted map
	// still reads correctly; a single digit sits tight against the icon.
	if (g_Remaining >= 10)
	{
		VDP_Poke_16K(T_DIGIT_0 + (g_Remaining / 10), g_ScreenLayoutLow + 2);
		VDP_Poke_16K(T_DIGIT_0 + (g_Remaining % 10), g_ScreenLayoutLow + 3);
	}
	else
	{
		VDP_Poke_16K(T_DIGIT_0 + g_Remaining, g_ScreenLayoutLow + 2);
		VDP_Poke_16K(T_SKY, g_ScreenLayoutLow + 3);
	}
}

//──────────────────────────────────────────────────────────────────────────────
// Text screens (SCREEN 1, so the BIOS font can use the pattern table freely)
//──────────────────────────────────────────────────────────────────────────────

// SCREEN 1 stores one colour per group of eight consecutive pattern codes. The
// MSXgl font starts at character 0, so loading it at offset 0 makes a pattern
// code equal to the character code. So whole classes of character can be recoloured: capitals are 65-90,
// digits 48-57, and Print_DrawBox's frame glyphs 22-27 (lines 0x16/0x17,
// corners 0x18-0x1B).
void ColorChars(u8 firstChar, u8 lastChar, u8 fg, u8 bg)
{
	u8 col = (fg << 4) | bg;
	for (u8 group = firstChar >> 3; group <= (lastChar >> 3); ++group)
		VDP_Poke_16K(col, g_ScreenColorLow + group);
}

#define PAPER  COLOR_BLACK

// Sets up SCREEN 1 with the BIOS font and the demo's palette, and clears it.
void BeginTextScreen()
{
	VDP_SetMode(VDP_MODE_GRAPHIC1);
	VDP_ClearVRAM();
	VDP_SetColor(PAPER);                       // border, so it matches the page
	Print_SetTextFont(g_Font_MGL_Sample8, 0);
	Print_SetColor(COLOR_WHITE, PAPER);        // fills all 32 groups at once

	// ...then lift a few classes out of that flat white.
	ColorChars(1,   6, COLOR_CYAN,          PAPER);   // the MSXgl logo
	ColorChars(22, 27, COLOR_CYAN,         PAPER);   // box lines and corners
	ColorChars(65, 90, COLOR_LIGHT_YELLOW, PAPER);   // capitals
	ColorChars(48, 57, COLOR_LIGHT_GREEN,  PAPER);   // digits
}

void PrintAt(u8 x, u8 y, const c8* text)
{
	Print_SetPosition(x, y);
	Print_DrawText(text);
}

void TitleScreen()
{
	BeginTextScreen();

	// A framed title, then the rules underneath.
	Print_DrawBox(3, 2, 26, 5);
	PrintAt(7,  4, "M S X S T U D I O");

	PrintAt(5,  8, "A two-screen demo game");

	PrintAt(4, 11, "Arrows move, SPACE jumps");
	PrintAt(3, 13, "Collect all 8 coins, then");
	PrintAt(2, 14, "reach the door on the right");

	PrintAt(6, 17, "Press SPACE to play");

	// The attribution MSXStudio's license asks of anything built with it.
	PrintAt(6, 19, "Built with MSXStudio");
	PrintAt(8, 20, "by P.D. Garaguso");
	PrintAt(4, 22, MSX_GL " MSX Game Library");
	PrintAt(0, 23, "");
}

// Everything this game stands on. MSXgl is CC BY-SA 4.0 and asks to be
// credited; MSXStudio asks the same, and both ask not to look like an
// endorsement, which is what the last line is for.
void CreditsScreen()
{
	BeginTextScreen();
	PrintAt(9,  2, "C R E D I T S");

	PrintAt(5,  5, "Built with MSXStudio");
	PrintAt(8,  6, "by P.D. Garaguso");

	PrintAt(13, 8, MSX_GL);
	PrintAt(4, 10, "Powered by MSXgl + MSXtk");
	PrintAt(8, 11, "by G. Blanchard");
	PrintAt(10, 12, "CC BY-SA 4.0");

	PrintAt(3, 15, "Sound: ayFX by Shiru");
	PrintAt(3, 16, "Compiled with SDCC");
	PrintAt(3, 17, "Runs on openMSX / WebMSX");

	PrintAt(2, 20, "Not endorsed by the above");
	PrintAt(6, 22, "SPACE to restart");
}

void WaitForSpace()
{
	// Let go first, so the press that got us here does not fall through.
	while (Keyboard_IsKeyPressed(KEY_SPACE)) Halt();
	while (!Keyboard_IsKeyPressed(KEY_SPACE)) Halt();
}

//──────────────────────────────────────────────────────────────────────────────
// Game
//──────────────────────────────────────────────────────────────────────────────

void InitGame()
{
	VDP_SetMode(VDP_MODE_GRAPHIC2);
	VDP_ClearVRAM();
	VDP_SetColor(COLOR_BLACK);

	// Tiles go into all three SCREEN 2 banks, so they look the same everywhere.
	VDP_LoadPattern_GM2(g_Tiles_Patterns, 32, 0);
	VDP_LoadColor_GM2(g_Tiles_Colors, 32, 0);

	// One 16x16 sprite, three frames: standing, walking, jumping.
	VDP_SetSpriteFlag(VDP_SPRITE_SIZE_16);
	VDP_LoadSpritePattern(g_Player_Patterns, 0, 6 * 4);
	VDP_DisableSpritesFrom(1);

	ayFX_InitBank((void*)g_Sfx);
	ayFX_SetChannel(PSG_CHANNEL_A);

	// Restart from the pristine level, and trust the map for the coin count so
	// that painting a coin in the map editor is all it takes to add one.
	Mem_Copy(g_Level_Background, g_Map, sizeof(g_Map));
	g_Remaining = 0;
	for (u16 i = 0; i < sizeof(g_Map); ++i)
		if (TileFlags(g_Map[i]) & FLAG_COIN) g_Remaining++;

	g_PlayerX   = 2 * 8;
	g_PlayerY   = 19 * 8 - 8;    // standing on the grass line
	g_VelY      = 0;
	g_OnGround  = 1;
	g_CamX      = 0;
	g_Frame     = 0;

	DrawView();
	DrawHUD();
}

// Horizontal move with a wall check, one pixel at a time so we never tunnel.
void MoveX(i16 dx)
{
	while (dx != 0)
	{
		i16 step = (dx > 0) ? 1 : -1;
		i16 next = g_PlayerX + step;
		if ((next < 0) || (next > (MAP_W * 8 - 16))) return;
		if (BoxHitsSolid(next, g_PlayerY)) return;
		g_PlayerX = next;
		dx -= step;
	}
}

void ApplyGravity()
{
	g_VelY += GRAVITY;
	if (g_VelY > MAX_FALL) g_VelY = MAX_FALL;

	i16 dy = g_VelY / SUBPIXEL;

	while (dy != 0)
	{
		i16 step = (dy > 0) ? 1 : -1;
		if (BoxHitsSolid(g_PlayerX, g_PlayerY + step))
		{
			g_VelY = 0;
			break;
		}
		g_PlayerY += step;
		dy -= step;
	}

	// Standing is a question about the ground, not about whether we just moved.
	// Velocity is in 1/8th pixels, so at rest it takes four frames to add up to
	// one whole pixel of fall: deriving this from "did a downward step get
	// blocked" would report airborne on three frames out of four, and the
	// sprite would flicker into its jump pose while walking on flat ground.
	g_OnGround = BoxHitsSolid(g_PlayerX, g_PlayerY + 1);
	if (g_OnGround && (g_VelY > 0)) g_VelY = 0;
}

void CollectCoins()
{
	i16 left   = g_PlayerX >> 3;
	i16 right  = (g_PlayerX + 15) >> 3;
	i16 top    = g_PlayerY >> 3;
	i16 bottom = (g_PlayerY + 15) >> 3;

	for (i16 ty = top; ty <= bottom; ++ty)
	{
		for (i16 tx = left; tx <= right; ++tx)
		{
			if ((TileFlags(TileAt(tx, ty)) & FLAG_COIN) == 0) continue;

			g_Map[(u16)ty * MAP_W + (u16)tx] = T_SKY;
			g_Remaining--;
			i16 sx = tx - (i16)g_CamX;
			if ((sx >= 0) && (sx < VIEW_W))
				VDP_Poke_16K(T_SKY, g_ScreenLayoutLow + ((u16)ty * VIEW_W) + (u16)sx);
			DrawHUD();
			ayFX_PlayBank(0, 0);
		}
	}
}

// The camera keeps the player near the middle, and only ever moves in whole
// tiles: a column step is one full redraw of the name table.
void UpdateCamera()
{
	i16 want = (g_PlayerX >> 3) - (VIEW_W / 2);
	if (want < 0) want = 0;
	if (want > MAX_CAM) want = MAX_CAM;

	if ((u8)want != g_CamX)
	{
		g_CamX = (u8)want;
		DrawView();
		DrawHUD();
	}
}

// True once every coin is collected and the player is standing in the doorway.
bool AtExit()
{
	if (g_Remaining != 0) return FALSE;
	// Any tile the player overlaps will do: the character is 16 pixels wide and
	// the door 8, so demanding an exact centre match makes it easy to miss.
	i16 left   = g_PlayerX >> 3;
	i16 right  = (g_PlayerX + 15) >> 3;
	i16 top    = g_PlayerY >> 3;
	i16 bottom = (g_PlayerY + 15) >> 3;
	for (i16 ty = top; ty <= bottom; ++ty)
		for (i16 tx = left; tx <= right; ++tx)
			if (TileFlags(TileAt(tx, ty)) & FLAG_EXIT) return TRUE;
	return FALSE;
}

void PlayGame()
{
	InitGame();

	while (1)
	{
		Halt();                     // one iteration per VBlank
		ayFX_Update();              // fills the PSG register buffer
		PSG_Apply();                // and pushes it to the sound chip

		u8 walking = 0;
		if (Keyboard_IsKeyPressed(KEY_LEFT))  { MoveX(-WALK_SPEED); walking = 1; }
		if (Keyboard_IsKeyPressed(KEY_RIGHT)) { MoveX( WALK_SPEED); walking = 1; }

		if (g_OnGround && Keyboard_IsKeyPressed(KEY_SPACE))
		{
			g_VelY = -JUMP_POWER;
			g_OnGround = 0;
			ayFX_PlayBank(1, 1);
		}

		ApplyGravity();
		CollectCoins();
		UpdateCamera();

		// Airborne wins; on the ground, alternate the two walk poses while
		// moving. The counter only runs while walking, so stopping always
		// leaves the character standing rather than mid-stride.
		u8 shape = FRAME_STAND;
		if (!g_OnGround)
		{
			shape = FRAME_JUMP;
			g_Frame = 0;
		}
		else if (walking)
		{
			g_Frame++;
			if (g_Frame >= WALK_STEPS * WALK_RATE) g_Frame = 0;
			shape = g_WalkCycle[g_Frame / WALK_RATE];
		}
		else g_Frame = 0;

		// Sprite Y is written one line higher than it appears on screen.
		i16 sx = g_PlayerX - ((i16)g_CamX * 8);
		VDP_SetSpriteSM1(0, (u8)sx, (u8)(g_PlayerY - 1), shape, COLOR_LIGHT_RED);

		if (AtExit()) return;
	}
}

//──────────────────────────────────────────────────────────────────────────────

void main()
{
	VDP_EnableVBlank(TRUE);

	while (1)
	{
		TitleScreen();
		WaitForSpace();

		PlayGame();

		ayFX_PlayBank(2, 0);
		BeginTextScreen();
		PrintAt(7,  8, "CONGRATULATIONS!");
		PrintAt(4, 11, "You found every coin");
		PrintAt(4, 12, "and escaped.");
		PrintAt(5, 16, "SPACE for credits");
		// Let the fanfare finish while the message is up.
		for (u8 i = 0; i < 120; ++i) { Halt(); ayFX_Update(); PSG_Apply(); }
		WaitForSpace();

		CreditsScreen();
		WaitForSpace();
	}
}
