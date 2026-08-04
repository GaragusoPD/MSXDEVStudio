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
//    res/player.sprites.json -> content/player_sprites.h  (g_PlayerSprites_Patterns / _Colors,
//                                            _Layout + g_PlayerSprites_SetMeta)
//    res/level.map.json      -> content/level_map.h   (g_LevelMap_Background, 64x12 cells
//                                            — the bottom half of the screen,
//                                            RLEp-compressed to 86 bytes)
//    res/background.map.json -> content/background_map.h (g_BackgroundMap_Sky, 32x24, the
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
//    * The player is several superposed hardware sprites, which is the only way
//      to get a multi-colour character on an MSX1: plane 0 is the line art, the
//      colour planes sit behind it. The sprite editor holds every plane and its
//      colour; g_PlayerSprites_SetMeta places them all from one x/y.
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
//  Where things live — each file is a real module, compiled separately, and
//  `demo.h` is the vocabulary they share (the tile indices, the flags, the
//  physics constants):
//
//    demo.h     what everything agrees on, and who owns which global
//    level.c    the level in RAM — read it, collide with it, scroll it
//    view.c     everything that reaches the name table — view, HUD, coin spin
//    player.c   the character — move, jump, collect, turn around
//    screens.c  the title picture and the credits
//    main.c     setup, and the loop that drives the rest
//
//  Built with MSXStudio by P.D. Garaguso.
//  Powered by MSXgl and MSXtk by Guillaume "Aoineko" Blanchard (CC BY-SA 4.0),
//  compiled with SDCC, sound in Shiru's ayFX format.
//  None of the above endorse this demo. The in-game credits screen says the
//  same thing, which is what MSXStudio's license asks of anything made with it.
#include "demo.h"

//──────────────────────────────────────────────────────────────────────────────
// Setting up, and the loop that drives everything else
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
	VDP_LoadSpritePattern(g_PlayerSprites_Patterns, 0, G_PLAYERSPRITES_PATTERNS_SIZE / 8);
	VDP_DisableSpritesFrom(G_PLAYERSPRITES_PLAYER_PLANES);
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
	RLEp_UnpackToRAM(g_LevelMap_Background, g_Map);
	// The backdrop never changes, so this could be read straight out of ROM —
	// it is unpacked into RAM because compressing it costs 127 bytes of ROM
	// against 768, and the unpacker is already here for the level.
	RLEp_UnpackToRAM(g_BackgroundMap_Sky, g_Back);

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
		g_PlayerSprites_SetMeta(0, (u8)sx, (u8)(g_PlayerY - 1),
		                 G_PLAYERSPRITES_PLAYER_BASE + pose * G_PLAYERSPRITES_PLAYER_PLANES,
		                 G_PLAYERSPRITES_PLAYER_PLANES);

		if (scrolled) { DrawView(); DrawHUD(); }

		if (AtExit()) return;
	}
}

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
