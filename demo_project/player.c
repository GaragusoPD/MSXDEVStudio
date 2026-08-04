// ─────────────────────────────────────────────────────────────────────────────
//  The character: moving, falling, collecting, and turning around.
// ─────────────────────────────────────────────────────────────────────────────
// Part of main.c's translation unit — see the note there.


i16 g_PlayerX;     // pixels, top-left of the 16x16 sprite
i16 g_PlayerY;
i16 g_VelY;        // 1/8th pixels per frame
u8  g_OnGround;
u8  g_Frame;
u8  g_FaceLeft;    // which way the player is drawn facing


// The stride, as sprite *frame* numbers now rather than raw shape values:
// g_PlayerSprites_SetMeta turns a frame into the right pattern for each of its planes.
// Frames 1/2 step out one way and 3/4 the other, legs together in between.
const u8 g_WalkCycle[WALK_STEPS] = { 0, 1, 2, 0, 3, 4 };

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

/**
 * Turns the player around. The art faces right, so facing left means mirrored
 * patterns — MSXgl's `SpriteFX_FlipHorizontal16` does the 32 bytes of one 16x16
 * shape, swapping the two half-columns and reversing the bits in each byte.
 *
 * The mirrors go back into the *same* pattern slots rather than into a second
 * set, which keeps `g_PlayerSprites_SetMeta()` and the sprite sheet's own plane and
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
		VDP_LoadSpritePattern(g_PlayerSprites_Patterns, 0, G_PLAYERSPRITES_PATTERNS_SIZE / 8);
		return;
	}

	// One shape at a time, so this needs 32 bytes of scratch rather than a
	// mirrored copy of the whole sheet.
	u8 shape[32];
	for (u8 i = 0; i < G_PLAYERSPRITES_PATTERNS_SIZE / 32; ++i)
	{
		SpriteFX_FlipHorizontal16(g_PlayerSprites_Patterns + ((u16)i * 32), shape);
		VDP_LoadSpritePattern(shape, i * 4, 4);
	}
}
