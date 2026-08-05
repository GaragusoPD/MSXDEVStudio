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
// ─────────────────────────────────────────────────────────────────────────────
#include "canyon.h"

u8 g_Palette[32];
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
 * The split: from here down, the display is page 1 with no offset — the status
 * band. R#23 and R#2 both change, and both only ever change inside a blanking
 * period, which is what keeps the picture still.
 *
 * Sprites go off too, and that is not tidiness. The VDP compares a sprite's Y
 * against the same offset line counter R#23 shifts, so with the offset dropped
 * to zero for these lines every sprite is suddenly being asked about a
 * different part of the screen — and whichever ones happen to land in 188–211
 * are drawn over the band. Ships and drones appearing at random across the
 * status bar is what that looks like. One bit in R#8 ends it.
 */
void VDP_HBlankHandler(void)
{
	VDP_SetPage(1);
	VDP_SetVerticalOffset(0);
	VDP_EnableSprite(FALSE);
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

static void PaintHud(void)
{
	// The panel: black across the full width, with a lit rule along the top so
	// the join with the canyon reads as a frame rather than as a glitch.
	VDP_CommandHMMV(0, HUD_BAND_Y, VIEW_W, HUD_H, 0x11);
	VDP_CommandHMMV(0, HUD_BAND_Y, VIEW_W, 1, 0x22);

	// Page 1, so past 255 — this is why the project builds with VDP_UNIT_U16.
	const u16 y = HUD_BAND_Y + 4;
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
	PaintHud();
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

	Screens_LoadAtlas();
	g_Mist_Upload(MIST_Y);
	g_Hud_Upload(HUD_STRIP_Y);
}

static void HideAll(void)
{
	Player_Hide();
	Enemy_Hide();
}

/** One frame of waiting, with the sound chip serviced — the only place that happens. */
static void WaitFrame(void)
{
	while(g_VBlank == 0)
		;
	g_VBlank = 0;
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

static void StartStage(void)
{
	Scroll_Start();
	Player_Start();
	Enemy_Start();
	Scroll_Present();
	g_HudShown = 0xFF; // force the band to be painted for the new life
	VDP_EnableHBlank(TRUE);
	g_State = STATE_PLAY;
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
		HideAll();
		g_State = STATE_TITLE;
		Screens_Title();

		g_Lives = 3;
		while(g_Lives)
		{
			StartStage();

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

			VDP_EnableHBlank(FALSE);
			VDP_SetPage(0);

			if(g_State == STATE_WIN)
				break;

			// Dead: hold the wreck a moment so it is clear what happened.
			PlaySfx(2);
			Player_Hide();
			Pause(70);
			g_Lives--;
		}

		HideAll();
		Screens_Credits();
	}
}
