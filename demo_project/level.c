// ─────────────────────────────────────────────────────────────────────────────
//  The level in RAM: what is where, what is solid, and where the view sits.
// ─────────────────────────────────────────────────────────────────────────────
#include "demo.h"


/**
 * The level, copied out of ROM so it can be edited as it is played: taking a
 * coin turns that cell into sky here, and everything downstream (the screen
 * blit, collision, the exit check) reads this one array. Drawing straight from
 * the ROM copy and painting the collected coins out afterwards is what made
 * them flash back into view for a frame whenever the screen scrolled.
 */
u8  g_Map[MAP_W * LEVEL_H];

/**
 * Which level rows hold a transparent cell at all. The ground rows hold none,
 * so they skip the merge and go to VRAM straight out of the level — the same
 * blit the game did before it had a backdrop. Kept current by whoever writes a
 * transparent tile into the level (see `CollectCoins`).
 */
u8  g_RowHasTrans[LEVEL_H];

u8  g_Remaining;   // coins still to collect
u8  g_CamX;        // leftmost visible column, in tiles

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
