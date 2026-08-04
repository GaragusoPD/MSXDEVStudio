// ─────────────────────────────────────────────────────────────────────────────
//  MSXStudio demo: a two-screen platformer
//
//  Collect all eight coins, then reach the door on the far right.
//  Arrows move, SPACE jumps.
//
//  Every graphic and sound in here was made with MSXStudio's own editors and
//  exported to the headers included below:
//
//    res/tiles.tiles.json    -> content/tiles.h   (g_Tiles_Patterns / _Colors,
//                                            _Blocks + g_Tiles_DrawBlock)
//    res/player.sprites.json -> content/player.h  (g_Player_Patterns / _Colors,
//                                            _Layout + g_Player_SetMeta)
//    res/level.map.json      -> content/level.h   (g_Level_Background, 64x12 cells
//                                            — the bottom half of the screen,
//                                            RLEp-compressed to 86 bytes)
//    res/background.map.json -> content/backdrop.h (g_Backdrop_Sky, 32x24, the
//                                            static backdrop behind the level)
//    res/sfx.sfx.json        -> content/sfx.h     (g_Sfx, an ayFX bank)
//
//  Five of MSXStudio's editor features carry their weight here:
//
//    * The coins spin without the map being touched. The four poses are a 4x1
//      *block* in the tileset — a multi-tile design drawn on one canvas — and
//      the game copies one pose's eight pattern bytes over the coin's tile.
//      Every coin on screen turns at once, for 24 bytes a step, because the
//      name table still says "tile 6" everywhere.
//    * The player is two superposed hardware sprites, which is the only way to
//      get a two-colour character on an MSX1: plane 0 is the dragon's line art,
//      plane 1 the flat body colour behind it. The sprite editor holds both
//      planes and their colours; g_Player_SetMeta places them from one x/y.
//      The art faces right; walking left mirrors it in place with MSXgl's
//      SpriteFX_FlipHorizontal16 (see FacePlayer).
//    * The doorway opens when the last coin is taken, stamped from a 1x2 block
//      by g_Tiles_DrawBlock.
//    * A backdrop behind the level, from a second map. SCREEN 2 has one name
//      table and no hardware layers, so the "layer" is one rule: a tile whose
//      flag 8 is set is not drawn — the backdrop's tile at that screen position
//      is (`ScreenTile()`). The backdrop does not scroll, so the holes slide
//      across it. The level covers only the bottom half of the screen for the
//      same reason: everything above it was sky, so it is the backdrop's, and
//      those rows are written once instead of on every scroll step.
//    * The level is compressed. A name table is mostly runs of the same tile,
//      so the map editor's "Compress (RLEp)" packs 768 cells into 86 bytes of
//      ROM — and it costs nothing at run time, because the game already keeps a
//      writable copy of the level in RAM (coins vanish, the door opens). What
//      was a Mem_Copy out of ROM is now an unpack into the same array.
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
// Sprite mirroring: msxgl.h does not pull this one in either, and "sprite_fx"
// has to be in the project's LibModules.
#include "sprite_fx.h"

// MSXgl's own 8x8 font, which also carries its logo as characters 1 to 6.
#include "font/font_mgl_sample8.h"

#include "content/tiles.h"
#include "content/intro_tiles.h"
#include "content/intro_map.h"
#include "content/player.h"
#include "content/level.h"
#include "content/backdrop.h"
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
// planes, and g_Player_SetMeta works out the patterns and colours for both.
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
// State
//──────────────────────────────────────────────────────────────────────────────

/**
 * The level, copied out of ROM so it can be edited as it is played: taking a
 * coin turns that cell into sky here, and everything downstream (the screen
 * blit, collision, the exit check) reads this one array. Drawing straight from
 * the ROM copy and painting the collected coins out afterwards is what made
 * them flash back into view for a frame whenever the screen scrolled.
 */
u8  g_Map[MAP_W * LEVEL_H];

/**
 * The backdrop, one screen wide and pinned to the screen: it does not scroll,
 * so it is indexed by *view* column rather than by world column. SCREEN 2 has
 * one name table and no hardware layers, so "behind" happens here — see
 * `ScreenTile()`. Unpacked from ROM once, like the level.
 */
u8  g_Back[VIEW_W * VIEW_H];

/** One row of the composed view, so a scroll step is still one VDP write per row. */
u8  g_Row[VIEW_W];

/**
 * Which level rows hold a transparent cell at all. The ground rows hold none,
 * so they skip the merge and go to VRAM straight out of the level — the same
 * blit the game did before it had a backdrop. Kept current by whoever writes a
 * transparent tile into the level (see `CollectCoins`).
 */
u8  g_RowHasTrans[LEVEL_H];

u8  g_Remaining;
i16 g_PlayerX;       // pixels, top-left of the 16x16 sprite
i16 g_PlayerY;
i16 g_VelY;          // 1/8th pixels per frame
u8  g_OnGround;
u8  g_CamX;          // leftmost visible column, in tiles
u8  g_Frame;
u8  g_CoinPhase;     // which pose of the spin is currently in the pattern table
u8  g_CoinTick;
u8  g_DoorOpen;
u8  g_FaceLeft;      // which way the dragon is drawn facing

// The stride, as sprite *frame* numbers now rather than raw shape values:
// g_Player_SetMeta turns a frame into the right pattern for each of its planes.
// Frames 1/2 step out one way and 3/4 the other, legs together in between.
const u8 g_WalkCycle[WALK_STEPS] = { 0, 1, 2, 0, 3, 4 };

//──────────────────────────────────────────────────────────────────────────────
// Map helpers
//──────────────────────────────────────────────────────────────────────────────

// The level is a flat array of one byte per cell, straight from the map editor.
// It starts at row LEVEL_TOP: everything above it is backdrop, and empty.
u8 TileAt(i16 tx, i16 ty)
{
	if ((tx < 0) || (tx >= MAP_W) || (ty < LEVEL_TOP) || (ty >= VIEW_H)) return T_SKY;
	return MapCell(tx, ty);
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
	if (bottom >= VIEW_H) return TRUE;
	for (i16 ty = top; ty <= bottom; ++ty)
		for (i16 tx = left; tx <= right; ++tx)
			if (IsSolid(TileAt(tx, ty))) return TRUE;
	return FALSE;
}

//──────────────────────────────────────────────────────────────────────────────
// Drawing
//──────────────────────────────────────────────────────────────────────────────

/**
 * The backdrop above the level, straight out of `g_Back` — no merge, because
 * there is no level up there to see through. It does not scroll either, so
 * this runs once per game rather than once per scroll step.
 */
void DrawBackdropTop()
{
	const u8* back = g_Back;
	u16 dst = g_ScreenLayoutLow;
	for (u8 row = 0; row < LEVEL_TOP; ++row)
	{
		VDP_WriteVRAM_16K(back, dst, VIEW_W);
		back += VIEW_W;
		dst  += VIEW_W;
	}
}

// One VDP write per row: the visible 32 columns are contiguous in the map, so
// a row is composed into `g_Row` and blitted in a single call.
void DrawView()
{
	// The window is already correct in `g_Map`, so each row is one write and
	// the screen is never shown holding a tile that is no longer there.
	//
	// All three addresses just step by a constant, so they are carried between
	// rows rather than recomputed from `row`, which cost two calls to SDCC's
	// 16-bit multiply per row. Worth the pennies: this is the one piece of the
	// loop on a deadline, and the merge below adds a compare per cell on top of
	// it. Only the level's own rows are touched — the backdrop above them is
	// already on screen and cannot have changed.
	const u8* src  = g_Map + (u16)g_CamX;
	const u8* back = g_Back + (LEVEL_TOP * VIEW_W);
	u16 dst = g_ScreenLayoutLow + (LEVEL_TOP * VIEW_W);
	for (u8 row = 0; row < LEVEL_H; ++row)
	{
		if (g_RowHasTrans[row])
		{
			// The row is copied wholesale first (one LDIR) and only the
			// transparent cells are patched afterwards, so the loop that runs
			// per cell holds one index and two fixed bases instead of three
			// live pointers — which SDCC spills to the stack frame.
			Mem_Copy(src, g_Row, VIEW_W);
			for (u8 col = 0; col < VIEW_W; ++col)
				if (TileFlags(g_Row[col]) & FLAG_TRANS) g_Row[col] = back[col];
			VDP_WriteVRAM_16K(g_Row, dst, VIEW_W);
		}
		else VDP_WriteVRAM_16K(src, dst, VIEW_W);
		src  += MAP_W;
		back += VIEW_W;
		dst  += VIEW_W;
	}
}

/**
 * Turns the dragon around. The art faces right, so facing left means mirrored
 * patterns — MSXgl's `SpriteFX_FlipHorizontal16` does the 32 bytes of one 16x16
 * shape, swapping the two half-columns and reversing the bits in each byte.
 *
 * The mirrors go back into the *same* pattern slots rather than into a second
 * set, which keeps `g_Player_SetMeta()` and the sprite sheet's own plane and
 * colour tables usable exactly as generated — they only describe the twelve
 * shapes that exist. The cost is 384 bytes of VRAM on a turn, and a turn is
 * something a player does a few times a second at most.
 */
void FacePlayer(u8 left)
{
	if (g_FaceLeft == left)
		return;
	g_FaceLeft = left;

	if (!left)
	{
		VDP_LoadSpritePattern(g_Player_Patterns, 0, G_PLAYER_PATTERNS_SIZE / 8);
		return;
	}

	// One shape at a time, so this needs 32 bytes of scratch rather than a
	// mirrored copy of the whole sheet.
	u8 shape[32];
	for (u8 i = 0; i < G_PLAYER_PATTERNS_SIZE / 32; ++i)
	{
		SpriteFX_FlipHorizontal16(g_Player_Patterns + ((u16)i * 32), shape);
		VDP_LoadSpritePattern(shape, i * 4, 4);
	}
}

/**
 * Advances the coin spin. The map is not touched: the four poses are the cells
 * of the tileset's `coin_spin` block, and this copies the chosen pose's eight
 * pattern bytes over tile T_COIN's slot. VDP_LoadPattern_GM2 writes all three
 * SCREEN 2 banks, so that is 24 bytes a step to turn every coin on screen —
 * against 8 bytes *per coin* if each one were re-pointed at another tile, and
 * without a single name-table write.
 */
void SpinCoins()
{
	if (++g_CoinTick < COIN_RATE) return;
	g_CoinTick = 0;
	if (++g_CoinPhase >= COIN_POSES) g_CoinPhase = 0;

	u8 pose = g_Tiles_Blocks[G_TILES_COIN_SPIN_BASE + g_CoinPhase];
	VDP_LoadPattern_GM2(g_Tiles_Patterns + ((u16)pose * 8), 1, T_COIN);
}

/**
 * Swings the door open once the last coin is in. The open doorway is a 1x2
 * block, so it goes into the level as its two tiles and onto the screen with
 * the tileset's own stamper — the same two steps taking a coin already does,
 * which is what keeps it there when the view scrolls back over it.
 */
void OpenDoor()
{
	const u8* cells = g_Tiles_Blocks + G_TILES_DOOR_OPEN_BASE;
	for (u8 row = 0; row < G_TILES_DOOR_OPEN_H; ++row)
		MapCell(DOOR_COL, DOOR_ROW + row) = cells[row];

	i16 sx = (i16)DOOR_COL - (i16)g_CamX;
	if ((sx >= 0) && (sx < VIEW_W))
		g_Tiles_DrawBlock((u8)sx, DOOR_ROW, G_TILES_DOOR_OPEN_BASE, G_TILES_DOOR_OPEN_W, G_TILES_DOOR_OPEN_H);

	// No sound of its own: the last coin's chime is still playing this very
	// frame, and effect 2 is the win fanfare, which has not been earned yet —
	// the door has to be walked into first.
	g_DoorOpen = 1;
}

// Coins left, drawn with the digit tiles built into the tileset.
void DrawHUD()
{
	// Only the cells the counter actually needs are written. The corner cell is
	// left alone: the backdrop's top row draws the screen border, and the HUD
	// has nothing to put there worth erasing it for.
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
		// One digit, so the tens cell shows the backdrop again — the count can
		// fall from 10 to 9, and a leftover digit there would be a lie.
		VDP_Poke_16K(g_Back[3], g_ScreenLayoutLow + 3);
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

/**
 * The title is a picture, not a page of text: `intro.map.json` drawn in
 * SCREEN 2 with its own tileset, and the player standing in the middle of it.
 *
 * It uses the *intro* tileset, so the game's tiles are not in VRAM while this
 * is up — `InitGame()` loads those when the game starts, which is why the two
 * screens can each have a full 256-tile bank.
 */
void TitleScreen()
{
	VDP_SetMode(VDP_MODE_GRAPHIC2);
	VDP_ClearVRAM();
	VDP_SetColor(COLOR_BLACK);

	VDP_LoadPattern_GM2(g_IntroTiles_Patterns, G_INTROTILES_PATTERNS_SIZE / 8, 0);
	VDP_LoadColor_GM2(g_IntroTiles_Colors, G_INTROTILES_COLORS_SIZE / 8, 0);

	// One screen exactly, so the map goes into the name table in one write.
	VDP_WriteVRAM_16K(g_IntroMap_Background, g_ScreenLayoutLow, G_INTROMAP_W * G_INTROMAP_H);

	// The dragon waits in the middle, facing right, in its standing pose.
	VDP_SetSpriteFlag(VDP_SPRITE_SIZE_16);
	VDP_LoadSpritePattern(g_Player_Patterns, 0, G_PLAYER_PATTERNS_SIZE / 8);
	VDP_DisableSpritesFrom(G_PLAYER_PLAYER_PLANES);
	g_FaceLeft = 0;
	g_Player_SetMeta(0, (256 - 16) / 2, ((192 - 16) / 2) - 1,
		G_PLAYER_PLAYER_BASE + FRAME_STAND * G_PLAYER_PLAYER_PLANES, G_PLAYER_PLAYER_PLANES);
}

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
	// The whole sheet goes up, blocks included: the open door has to be in VRAM
	// before it can be stamped, and the spin poses cost nothing to carry along.
	VDP_LoadPattern_GM2(g_Tiles_Patterns, G_TILES_PATTERNS_SIZE / 8, 0);
	VDP_LoadColor_GM2(g_Tiles_Colors, G_TILES_COLORS_SIZE / 8, 0);

	// SCREEN 2 keeps a separate colour table for each third of the screen, so a
	// pattern can look different depending on where it is used. The coin's
	// background is sky blue, which is right in the level and wrong in the HUD's
	// black corner — so its entry is recoloured in the *top* third only. The
	// level starts below that third, so no coin in play is affected.
	VDP_FillVRAM(0xB1, g_ScreenColorLow + (T_COIN * 8), 0, 8);

	// The player is two superposed planes per pose, so the pattern table holds
	// frames x planes shapes and the character costs two of the four sprites
	// the VDP will draw on one line.
	VDP_SetSpriteFlag(VDP_SPRITE_SIZE_16);
	VDP_LoadSpritePattern(g_Player_Patterns, 0, G_PLAYER_PATTERNS_SIZE / 8);
	VDP_DisableSpritesFrom(G_PLAYER_PLAYER_PLANES);
	g_FaceLeft = 0;   // matches what was just uploaded

	// ayFX_InitBank takes a plain `void*` although it only ever reads the bank
	// (it stores the pointer and reads sample data through it — see
	// ayfx_player.c). The bank is `const` because the exporter puts it in ROM,
	// so casting the const away is what the API forces. SDCC warning 357 is
	// disabled for this one line rather than making the data writable to please
	// it: a bank in RAM would cost 200-odd bytes to fix a cast.
#pragma save
#pragma disable_warning 357
	ayFX_InitBank((void*)g_Sfx);
#pragma restore
	ayFX_SetChannel(PSG_CHANNEL_A);

	// Restart from the pristine level, and trust the map for the coin count so
	// that painting a coin in the map editor is all it takes to add one.
	// The ROM copy is RLEp-compressed (132 bytes for 1536 cells); unpacking it
	// straight into the working array is the same one line the copy used to be.
	RLEp_UnpackToRAM(g_Level_Background, g_Map);
	// The backdrop never changes, so this could be read straight out of ROM —
	// it is unpacked into RAM because compressing it costs 127 bytes of ROM
	// against 768, and the unpacker is already here for the level.
	RLEp_UnpackToRAM(g_Backdrop_Sky, g_Back);

	// Which rows need composing at all — see `g_RowHasTrans`.
	for (u8 row = 0; row < LEVEL_H; ++row)
	{
		const u8* cell = g_Map + ((u16)row * MAP_W);
		u8 any = 0;
		for (u16 col = 0; col < MAP_W; ++col)
			if (TileFlags(cell[col]) & FLAG_TRANS) { any = 1; break; }
		g_RowHasTrans[row] = any;
	}
	g_Remaining = 0;
	for (u16 i = 0; i < sizeof(g_Map); ++i)
		if (TileFlags(g_Map[i]) & FLAG_COIN) g_Remaining++;

	g_PlayerX   = 2 * 8;
	g_PlayerY   = 19 * 8 - 8;    // standing on the grass line
	g_VelY      = 0;
	g_OnGround  = 1;
	g_CamX      = 0;
	g_Frame     = 0;
	g_CoinPhase = 0;
	g_CoinTick  = 0;
	g_DoorOpen  = 0;

	// The backdrop's own rows go up once: they do not scroll, so the redraw on
	// a camera step never has to touch them again.
	DrawBackdropTop();
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

			MapCell(tx, ty) = T_TRANS;
			g_RowHasTrans[ty - LEVEL_TOP] = 1;
			g_Remaining--;
			i16 sx = tx - (i16)g_CamX;
			if ((sx >= 0) && (sx < VIEW_W))
			{
				// Same rule as the full redraw: if sky is a transparent tile,
				// the cell the coin leaves behind has to show the backdrop.
				u16 at = ((u16)ty * VIEW_W) + (u16)sx;
				VDP_Poke_16K(ScreenTile(T_TRANS, g_Back[at]), g_ScreenLayoutLow + at);
			}
			DrawHUD();
			ayFX_PlayBank(0, 0);
		}
	}
}

// The camera keeps the player near the middle, and only ever moves in whole
// tiles: a column step is one full redraw of the name table.
//
// Moving it and redrawing are two steps on purpose, so that the caller can
// place the sprite for the new column before spending half a frame on the
// redraw. It reports whether the column changed.
bool UpdateCamera()
{
	i16 want = (g_PlayerX >> 3) - (VIEW_W / 2);
	if (want < 0) want = 0;
	if (want > MAX_CAM) want = MAX_CAM;

	if ((u8)want == g_CamX) return FALSE;
	g_CamX = (u8)want;
	return TRUE;
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
		if (Keyboard_IsKeyPressed(KEY_LEFT))  { MoveX(-WALK_SPEED); walking = 1; FacePlayer(1); }
		if (Keyboard_IsKeyPressed(KEY_RIGHT)) { MoveX( WALK_SPEED); walking = 1; FacePlayer(0); }

		if (g_OnGround && Keyboard_IsKeyPressed(KEY_SPACE))
		{
			g_VelY = -JUMP_POWER;
			g_OnGround = 0;
			ayFX_PlayBank(1, 1);
		}

		ApplyGravity();
		CollectCoins();
		SpinCoins();
		if (!g_DoorOpen && (g_Remaining == 0)) OpenDoor();
		bool scrolled = UpdateCamera();

		// Airborne wins; on the ground, alternate the two walk poses while
		// moving. The counter only runs while walking, so stopping always
		// leaves the character standing rather than mid-stride.
		u8 pose = FRAME_STAND;
		if (!g_OnGround)
		{
			pose = FRAME_JUMP;
			g_Frame = 0;
		}
		else if (walking)
		{
			g_Frame++;
			if (g_Frame >= WALK_STEPS * WALK_RATE) g_Frame = 0;
			pose = g_WalkCycle[g_Frame / WALK_RATE];
		}
		else g_Frame = 0;

		// Sprite Y is written one line higher than it appears on screen.
		i16 sx = g_PlayerX - ((i16)g_CamX * 8);

		// The camera steps whole tiles, so it can only follow the player to
		// within a tile, and `sx` above carries the 0 to 7 pixel remainder.
		// That remainder is what dragged the player 8 pixels left every time
		// the map stepped: the scroll was moving the sprite. Pin the sprite to
		// one column instead and let the map slide underneath it, which is the
		// whole point of scrolling. The dropped remainder puts the sprite up to
		// 7 pixels behind where it really is, and never more, because the
		// camera catches up every eighth pixel.
		//
		// Both ends of the level are exempt: there the camera is clamped and
		// cannot follow at all, so the player really does walk across the
		// screen. The pin hands over seamlessly, because a clamped camera only
		// lets `sx` past PLAYER_PIN_X once it has stopped scrolling.
		if ((sx > PLAYER_PIN_X) && (g_CamX < MAX_CAM)) sx = PLAYER_PIN_X;

		// One call, one coordinate, both planes — and their colours come from
		// the sprite sheet rather than from a constant in here.
		g_Player_SetMeta(0, (u8)sx, (u8)(g_PlayerY - 1),
		                 G_PLAYER_PLAYER_BASE + pose * G_PLAYER_PLAYER_PLANES,
		                 G_PLAYER_PLAYER_PLANES);

		if (scrolled) { DrawView(); DrawHUD(); }

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
