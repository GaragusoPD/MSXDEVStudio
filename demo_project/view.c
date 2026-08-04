// ─────────────────────────────────────────────────────────────────────────────
//  Everything that reaches the name table: the view, the HUD, the coin spin.
// ─────────────────────────────────────────────────────────────────────────────
// Part of main.c's translation unit — see the note there.



/**
 * The backdrop, one screen wide and pinned to the screen: it does not scroll,
 * so it is indexed by *view* column rather than by world column. SCREEN 2 has
 * one name table and no hardware layers, so "behind" happens here — see
 * `ScreenTile()`. Unpacked from ROM once, like the level.
 */
u8  g_Back[VIEW_W * VIEW_H];

/** One row of the composed view, so a scroll step is still one VDP write per row. */
u8  g_Row[VIEW_W];

u8  g_CoinPhase;   // which pose of the spin is in the pattern table
u8  g_CoinTick;
u8  g_DoorOpen;

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
