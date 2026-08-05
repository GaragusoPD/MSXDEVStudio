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

void PlaySfx(u8 id)
{
	ayFX_PlayBank(id, 0);
}

/**
 * The HUD: an energy bar and a life count, composited into the picture over the
 * scrolling canyon.
 *
 * Bitmap graphics rather than sprites, which costs more but buys two things. A
 * mode-2 sprite carries one colour per *line*, so a black panel with a coloured
 * bar and a white number on the same rows needs a second plane behind the
 * first; the bitmap has no such limit and the panel is simply drawn. And it
 * leaves all 32 sprite planes to the game.
 *
 * The price is the page. It is a 256-line ring that the display walks round, so
 * a panel at a fixed display line lands on a page row that moves — the panel
 * has to be lifted and put back down every frame, and **sixteen frames out of
 * every 256 it straddles row 0**. The VDP's command engine does not wrap: a
 * rectangle starting at row 250 runs on into the next page, where the display
 * never looks. Blit it in one piece and the HUD blinks out for a third of a
 * second every five seconds. So every copy below is split at the seam.
 *
 * That is why this does not use the exporter's ready-made `g_Hud_Draw`: the
 * generated helper is the straightforward case, an object on a page that does
 * not wrap. This is the same cycle with the seam handled.
 */
#define HUD_H 16
#define HUD_BAR_W 40
#define HUD_LIFE_W 16
#define HUD_BACKUP_Y (HUD_STRIP_Y + HUD_H)

/** Page row the panel was last put down at, and whether there is anything to lift. */
static u8 g_HudRow;
static u8 g_HudDrawn;

/** Rows that fit before the ring wraps — the whole panel, unless it is over the seam. */
static u8 HudFirst(u8 row)
{
	// 240 is the last row a 16-tall panel still fits below. Past it, `0 - row`
	// in eight bits *is* 256 - row: the same wrap the ring itself does.
	return (row > 240) ? (u8)(0 - row) : HUD_H;
}

/** Lifts the canyon out from under the panel, into the spare rows below the strip. */
static void HudSave(u8 slot, u8 x, u8 row, u8 w)
{
	u8 first = HudFirst(row);
	VDP_CommandHMMM(x, row, (u16)slot * HUD_BAR_W, HUD_BACKUP_Y, w, first);
	if(first < HUD_H)
		VDP_CommandHMMM(x, 0, (u16)slot * HUD_BAR_W, (u16)HUD_BACKUP_Y + first, w, HUD_H - first);
}

static void HudRestore(u8 slot, u8 x, u8 row, u8 w)
{
	u8 first = HudFirst(row);
	VDP_CommandHMMM((u16)slot * HUD_BAR_W, HUD_BACKUP_Y, x, row, w, first);
	if(first < HUD_H)
		VDP_CommandHMMM((u16)slot * HUD_BAR_W, (u16)HUD_BACKUP_Y + first, x, 0, w, HUD_H - first);
}

/** One piece of the strip, over whatever is there. */
static void HudBlit(u8 frame, u8 x, u8 row)
{
	const u8* rect = g_Hud_Rects + ((u16)frame * 4);
	u16 sx = rect[0] + ((u16)rect[1] << 8);
	u8 w = rect[2];
	u8 first = HudFirst(row);
	VDP_CommandLMMM(sx, HUD_STRIP_Y, x, row, w, first, VDP_OP_TIMP);
	if(first < HUD_H)
		VDP_CommandLMMM(sx, (u16)HUD_STRIP_Y + first, x, 0, w, HUD_H - first, VDP_OP_TIMP);
}

/** Puts the canyon back where the panel was. */
static void HideHud(void)
{
	if(!g_HudDrawn)
		return;
	HudRestore(1, HUD_X + HUD_BAR_W, g_HudRow, HUD_LIFE_W);
	HudRestore(0, HUD_X, g_HudRow, HUD_BAR_W);
	g_HudDrawn = 0;
}

/**
 * Lift, then save, then draw — in that order for both pieces, so neither one's
 * backup can capture the other's pixels. Getting that wrong leaves a ghost of
 * the bar smeared into the life panel's saved background, one frame behind.
 */
static void DrawHud(void)
{
	HideHud();
	g_HudRow = Scroll_PageRow(HUD_Y);
	HudSave(0, HUD_X, g_HudRow, HUD_BAR_W);
	HudSave(1, HUD_X + HUD_BAR_W, g_HudRow, HUD_LIFE_W);
	HudBlit(G_HUD_BAR3 + (MAX_ENERGY - g_Energy), HUD_X, g_HudRow);
	HudBlit(G_HUD_LIFE0 + (g_Lives & 3), HUD_X + HUD_BAR_W, g_HudRow);
	g_HudDrawn = 1;
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
	HideHud();
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
