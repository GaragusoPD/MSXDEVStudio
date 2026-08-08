// ─────────────────────────────────────────────────────────────────────────────
// Canyon Runner — an MSX2 demo for MSXStudio.
//
// SCREEN 5, a 128 KB ASCII-8 ROM, four layers of parallax, multicolour sprites
// for the ship and a software sprite for the boss. main.c is the setup and the
// loop that drives the rest; every technique lives in its own chapter.
//
//   scroll.c   R#23, the mist, the palette cycle
//   player.c   the ship and its shots (sprite mode 2, OR-colour)
//   enemy.c    the drones
//   boss.c     the boss (a software sprite)
//   screens.c  the title and credits pictures, straight out of ROM segments
//
// `VDP_InterruptHandler` below is why the .msxproj asks for CustomISR =
// "VBLANK" and InstallRAMISR = "RAMISR_PAGE3": MSXgl's own ISR calls it by
// name, and the scroll register has to move inside the blanking period.
//
// Copyright © 2026 Pablo D. Garaguso. The code and all the artwork — the
// canyon, the ship, the drones, the boss and the sound effects — are the
// author's own, drawn from the generators in datasrc/ and finished in
// MSXStudio's editors.
//
// This demo ships with MSXStudio as a worked example. You may use, modify and
// build on its code and art in your own projects, commercial or not, with no
// obligation to credit this demo. See README.md for the full notice.
// ─────────────────────────────────────────────────────────────────────────────
#include "canyon.h"

u8 g_Palette[32];
/** One byte per atlas tile, read out of the tileset blob at boot. See canyon.h. */
u8 g_TileFlags[ATLAS_TILES];
u8 g_VBlank;
u8 g_Frame;
GameState g_State;
u8 g_Lives;
u8 g_Energy;

/**
 * The scroll, in one register write — and the write happens *here* rather than
 * in the game loop for one reason. R#23 shifts the whole display, so moving it
 * while the raster is inside the picture tears the frame across. The blanking
 * period is the only safe window and the loop does not run in it, so the loop
 * latches the value and this installs it.
 */
void VDP_InterruptHandler(void)
{
	Scroll_Present();
	g_VBlank = 1;
}

/**
 * The join: from here down the display is the scrolling world again — page 0,
 * the scroll offset, and sprites back on.
 *
 * Sprites being off across the band is not tidiness. The VDP compares a
 * sprite's Y against the same offset line counter R#23 shifts, so with the
 * band's offset at zero every sprite is suddenly being asked about a different
 * part of the screen, and whichever ones land in the band's lines are drawn
 * over it. Ships and drones appearing at random across the status bar is what
 * that looks like. One bit in R#8 ends it.
 *
 * The short pause first pushes the register writes into the horizontal
 * blanking, so the change does not land partway along a visible line and leave
 * the join ragged. It only works because the main loop is halted waiting for
 * this interrupt — see `WaitFrame`.
 */
void VDP_HBlankHandler(void)
{
	for(u8 i = HUD_SPLIT_DELAY; i; --i)
	{
		__asm
			nop
		__endasm;
	}
	Scroll_World();
}

void PlaySfx(u8 id)
{
	ayFX_PlayBank(id, 0);
}

/**
 * The status band: an energy bar and a life count on a black strip across the
 * bottom of the screen.
 *
 * It lives in page 1, which nothing scrolls, and the H-blank interrupt switches
 * the display over to it at line HUD_Y (see `VDP_HBlankHandler`). So the band is
 * painted only when the numbers on it change — the rest of the time it costs
 * nothing at all, and it cannot shake, blink or be smeared by the scroll,
 * because the scroll never touches the page it is on.
 *
 * `VDP_CommandHMMV` fills; `VDP_CommandLMMM` copies the artwork in from the
 * strip parked in page 2. Both are VDP block operations — the CPU only writes
 * the coordinates.
 */
static u8 g_HudShown; // energy and lives as last painted, so it repaints only on a change

/**
 * The panel itself. Painted once, when a stage puts the band up — never from
 * the game loop.
 *
 * It used to be part of every repaint, and that was the single most expensive
 * thing this program did in a frame: a 256×32 fill is four kilobytes of VDP
 * traffic and a full-width rule on top of it, some six milliseconds with the
 * display on. The frame that paid it was always the frame the player was hit,
 * because that is what changes the numbers — so the work landed on top of the
 * mist, the drones and the ship, ran past the end of the frame, and the V-blank
 * handler was still waiting when the raster came round. The screen jumped and
 * the canyon vanished for a moment, exactly when the player was least able to
 * afford it. The panel does not change, so it should not be redrawn.
 */
static void PaintHudPanel(void)
{
	// Black across the full width, starting a few lines above where the band is
	// meant to begin so the switch cannot expose a stripe of canyon.
	VDP_CommandHMMV(0, HUD_BAND_Y, VIEW_W, HUD_PAINT_H, 0x11);
	// A rule along the bottom, where the band meets the canyon, so the join reads
	// as a deliberate frame — with two plain rows left below it, because the
	// switch still lands a couple of dozen dots into a line and that residue is
	// better on blank padding than through the rule.
	VDP_CommandHMMV(0, (u16)HUD_BAND_Y + HUD_H - 4, VIEW_W, 2, 0x44);
}

/**
 * The two readouts, and only the strip they sit in — about a sixteenth of what
 * the full repaint moved.
 */
static void PaintHudValues(void)
{
	// Page 1, so past 255 — this is why the project builds with VDP_UNIT_U16.
	const u16 y = HUD_BAND_Y + 4;
	VDP_CommandHMMV(HUD_X, y, VIEW_W - HUD_X, HUD_H - 8, 0x11);
	const u8* rect = g_Hud_Rects + ((u16)(G_HUD_BAR3 + (MAX_ENERGY - g_Energy)) * 4);
	VDP_CommandLMMM(rect[0] + ((u16)rect[1] << 8), HUD_STRIP_Y, HUD_X, y, rect[2], rect[3], VDP_OP_TIMP);
	rect = g_Hud_Rects + ((u16)(G_HUD_LIFE0 + (g_Lives & 3)) * 4);
	VDP_CommandLMMM(rect[0] + ((u16)rect[1] << 8), HUD_STRIP_Y, HUD_X + 40, y, rect[2], rect[3], VDP_OP_TIMP);
}

/** Repaints only when something on it changed — which is a few times a stage. */
static void DrawHud(void)
{
	u8 state = (g_Energy << 4) | (g_Lives & 15);
	if(state == g_HudShown)
		return;
	g_HudShown = state;
	PaintHudValues();
}

static void SetupVideo(void)
{
	VDP_SetMode(VDP_MODE_GRAPHIC4);
	VDP_SetColor(0x00);

	// The sprite tables have to leave page 0. Their default home is 0x7600,
	// which is rows 212–255 of the page the scroll walks all the way round —
	// leave them there and the canyon eventually scrolls the attribute table
	// into view. Page 3's tail is somewhere nothing else wants.
	VDP_SetSpritePatternTable(VRAM_SPRITE_PATTERN);
	VDP_SetSpriteAttributeTable(VRAM_SPRITE_ATTR);
	VDP_SetSpriteFlag(VDP_SPRITE_SIZE_16);
	VDP_LoadSpritePattern(g_Fleet_Patterns, 0, G_FLEET_PATTERNS_SIZE / 8);
	VDP_EnableSprite(TRUE);

	Screens_LoadArt();
	g_Mist_Upload(MIST_Y);
	g_Hud_Upload(HUD_STRIP_Y);
}

/**
 * One frame of waiting, with the sound chip serviced — the only place that
 * happens.
 *
 * The wait is a `halt`, not a polling loop, and that is what makes the split
 * screen clean. A poll like `while(g_VBlank == 0);` is a handful of
 * instructions, and the H-blank interrupt for the status band can arrive at any
 * point in it — so it is serviced a variable number of cycles later, and the
 * page switch lands at a different dot of the scanline every frame. The band's
 * top edge frays.
 *
 * `halt` parks the Z80 until an interrupt, so the interrupt is always taken
 * from the same state and the switch lands in the same place. It costs nothing:
 * the CPU had no work to do anyway.
 */
static void WaitFrame(void)
{
	while(g_VBlank == 0)
	{
		__asm
			halt
		__endasm;
	}
	g_VBlank = 0;

	// Then wait for the split before doing anything at all.
	//
	// This is the whole reason the status band is at the top of the screen. The
	// join is only clean if the interrupt is serviced the same number of cycles
	// after it fires every frame, and it will not be if the CPU is halfway
	// through MSXgl's fifteen-register command setup with interrupts disabled.
	// Waiting here means the interrupt is always taken from a `halt`, and the
	// frame's blitting only begins once the join is behind the raster — so
	// however heavy the frame gets, it cannot fray the band.
	while(g_BandOn && g_Phase == PHASE_BAND)
	{
		__asm
			halt
		__endasm;
	}
	g_Frame++;
	ayFX_Update();
	PSG_Apply();
}

/** Freezes for `frames`, keeping the interrupt handlers and the sound alive. */
static void Pause(u8 frames)
{
	while(frames--)
		WaitFrame();
}

/**
 * A new life, on the canyon exactly where it was left.
 *
 * Losing a life costs the life, not the ground already flown. `Scroll_Start` is
 * deliberately *not* here: it rewinds `g_ViewY` to the bottom of the map and
 * refills the ring, which threw away a whole stage's progress every time the
 * hull ran out of energy. Everything this does touch is per-life state — a
 * fresh ship, an empty sky, and the readouts forced to repaint for the new
 * count.
 */
static void StartLife(void)
{
	Player_Start();
	Enemy_Start();
	g_HudShown = 0xFF; // force the readouts to be painted for the new life
	Scroll_ShowBand(TRUE);
	PaintHudPanel();
	Scroll_Present();
	g_State = STATE_PLAY;
}

/** A new game: the canyon back to the start, then the first life on it. */
static void StartStage(void)
{
	Boss_Reset();
	Scroll_Start();
	StartLife();
}

void main(void)
{
	SetupVideo();

	// ayFX_InitBank takes a plain `void*` although it only ever reads the bank,
	// and the exporter puts the bank in ROM as `const` — so casting the const
	// away is what the API forces. Warning 357 is silenced for this one line
	// rather than copying a kilobyte of samples into RAM to please it.
#pragma save
#pragma disable_warning 357
	ayFX_InitBank((void*)g_Sfx);
#pragma restore
	ayFX_SetChannel(2);
	VDP_EnableVBlank(TRUE);

	for(;;)
	{
		g_State = STATE_TITLE;
		Screens_Title();

		g_Lives = 3;
		StartStage();
		while(g_Lives)
		{
			while(g_State == STATE_PLAY || g_State == STATE_BOSS)
			{
				WaitFrame();

				// First thing after the blanking, while the raster is still at
				// the top of the screen and nowhere near the panel: the HUD
				// does not depend on anything the logic below computes, so
				// drawing it here keeps it nailed to the display.
				DrawHud();

				if(g_State == STATE_PLAY)
				{
					Scroll_Update();
					Scroll_Mist();
					Enemy_Update();
					Player_Update();
					// The stage runs out at the top of the map, and the boss is
					// waiting there. The mist and the drones go first: both draw
					// into the page, and so does the boss.
					if(g_ViewY == 0)
					{
						Scroll_MistOff();
						Enemy_Hide();
						Boss_Start();
						g_State = STATE_BOSS;
					}
				}
				else
				{
					Boss_Update();
					Player_Update();
				}
			}

			if(g_State == STATE_WIN)
				break;

			// Dead: hold the wreck a moment so it is clear what happened. The
			// band stays up through it — switching it off here was leaving the
			// canyon to fill the top of the screen for a second and a half.
			PlaySfx(2);
			Player_Hide();
			Pause(70);
			if(--g_Lives)
				StartLife();
		}

		// The boss comes apart before anything else happens — it is the last
		// thing the player did, so it gets the screen to itself.
		while(Boss_Exploding())
			WaitFrame();

		// Only now, on the way to the ending, does the split go away.
		Scroll_ShowBand(FALSE);
		VDP_SetPage(0);
		if(g_State == STATE_WIN)
		{
			Screens_Message(MSG_VICTORY);
			Screens_Credits();
		}
		else
		{
			// Out of lives: the offer to go again, and then the title, which is
			// where going again starts.
			Screens_Message(MSG_GAMEOVER);
		}
	}
}
