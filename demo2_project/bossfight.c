// ─────────────────────────────────────────────────────────────────────────────
// The boss — a software sprite, because it is 68 dots wide.
//
// A 68-wide character is five 16-wide hardware sprites side by side, and sprite
// mode 2 draws eight per line. Five of the eight spent on one enemy, before the
// ship (two) and its shots have asked for any, is not a budget. So the boss is
// blitted straight into the picture instead: no per-line limit, any size, any
// number of colours — at the price of having to put back what it covered.
//
// That cycle is what the screen editor's exporter generates from the fragments
// cut out of boss.png: `_Upload` parks both frames in a VRAM page the display
// never shows, `_Restore` puts the canyon back, `_Draw` saves the new patch and
// blits the frame over it with a transparent-aware LMMM.
//
// The stage scroll stops while the boss is alive. That is not only pacing: a
// restore puts back the pixels that were under the boss *when it was drawn*, so
// the ground beneath it has to hold still.
// ─────────────────────────────────────────────────────────────────────────────
#include "canyon.h"

#define BOSS_W 68
#define BOSS_H 40
#define BOSS_HEALTH 14
/** Dots per move, at one move every second frame — the drift rate is the product. */
#define BOSS_STEP 1
/** Screen row the boss holds station on; the page row is this plus g_ViewY. */
#define BOSS_Y_POS (PLAY_TOP + 12)
/**
 * The rectangle actually written to the picture: the boss plus a margin wide
 * enough to swallow wherever it was standing a moment ago. One write covers the
 * new pose and erases the old one, so there is never a moment with neither.
 */
#define BOSS_MARGIN 4
#define BOSS_RECT_W (BOSS_W + BOSS_MARGIN * 2)

static u8 g_Health;
static u8 g_X;
static i8 g_Dx;
static u8 g_Flash;
static u8 g_Alive;
/** What is actually on the picture right now, so an unchanged frame costs nothing. */
static u8 g_DrawnX;
static u8 g_DrawnFrame;
/** Whether BOSS_BG_Y holds this stage's arena band yet. Zeroed on purpose. */
static u8 g_HasBg = 0;
/** Set once the boss has been written to the picture at least once. */
static u8 g_OnPicture = 0;

/** The page row the arena band occupies; the scroll is stopped, so it is fixed. */
static UY BandRow(void)
{
	return (UY)((g_ViewY + BOSS_Y_POS) & 0xFF);
}

void Boss_Reset(void)
{
	g_HasBg = 0;
	g_OnPicture = 0;
}

void Boss_Start(void)
{
	// The arena band, kept clean in a page the display never shows.
	//
	// Losing a life no longer rewinds the canyon, so a death in the middle of
	// this fight comes straight back here with the previous boss still on the
	// picture. Putting the saved band back deals with that; and the save only
	// happens once a stage, because by the second visit the picture has a boss
	// on it and saving again would keep him for ever.
	if(g_OnPicture)
		VDP_CommandHMMM(0, BOSS_BG_Y, 0, BandRow(), VIEW_W, BOSS_H);
	if(!g_HasBg)
	{
		VDP_CommandHMMM(0, BandRow(), 0, BOSS_BG_Y, VIEW_W, BOSS_H);
		g_HasBg = 1;
	}
	g_OnPicture = 0;
	g_Health = BOSS_HEALTH;
	g_X = (VIEW_W - BOSS_W) / 2;
	g_Dx = 1;
	g_Flash = 0;
	g_Alive = 1;
	g_Boss_Upload(BOSS_Y);
}

bool Boss_Update(void)
{
	if(!g_Alive)
		return FALSE;

	// One dot every other frame. Coarser steps were worth trying while a redraw
	// still cost a visible frame; now that it does not, the boss may as well
	// glide.
	if((g_Frame & 1) == 0)
	{
		g_X += g_Dx * BOSS_STEP;
		if(g_X < 8 || g_X > VIEW_W - BOSS_W - 8)
			g_Dx = -g_Dx;
	}

	if(Player_ShotHits(g_X, BOSS_Y_POS, BOSS_W, BOSS_H) != MAX_SHOTS)
	{
		g_Flash = 4;
		PlaySfx(3);
		if(--g_Health == 0)
		{
			g_Alive = 0;
			PlaySfx(4);
			g_State = STATE_WIN;
			return FALSE;
		}
	}

	if(Player_HitBy(g_X, BOSS_Y_POS, BOSS_W, BOSS_H))
		Player_Damage();

	// The second frame is the same hull with its wings dropped and its eye lit;
	// flying it on a hit is what makes a hit readable without a health bar.
	u8 frame = G_BOSS_REST;
	if(g_Flash)
	{
		frame = G_BOSS_FLEX;
		g_Flash--;
	}
	else if((g_Frame & 31) < 8)
	{
		frame = G_BOSS_FLEX;
	}

	// Nothing moved, nothing to draw. Assembling and writing the boss is a few
	// kilobytes of VDP traffic, so the frames that change nothing are worth
	// spotting: the boss holds still on the odd frames and only pays on the even.
	if(g_OnPicture && g_X == g_DrawnX && frame == g_DrawnFrame)
		return TRUE;

	// Assembled off-screen, then written to the picture in one opaque blit — and
	// that is what makes the boss stop flickering.
	//
	// The obvious cycle is the one the exporter generates: put the canyon back,
	// then blit the boss over it. It leaves the picture with no boss in it for
	// the length of a restore plus a save plus a draw, and those three are around
	// four kilobytes of VDP traffic — measured at roughly a whole frame with the
	// display on. There is no moment in the frame late enough to start that and
	// have it finish before the raster comes back round to line 40, which is why
	// waiting for the beam did not help: the beam always wins a race that long.
	//
	// So nothing is ever taken *off* the picture. The clean arena band and the
	// boss are combined in page 3, where the display never looks, and the result
	// goes down in a single opaque HMMM. The rectangle is drawn a little wider
	// than the boss so it also covers wherever he was standing a moment ago,
	// which is what makes the old pose disappear without a separate erase.
	//
	// The raster can still catch that one blit halfway — but both halves have a
	// boss in them, one dot apart. There is no frame in which he is missing.
	const u8 cx = (g_X > BOSS_MARGIN) ? g_X - BOSS_MARGIN : 0;
	const u8* rect = g_Boss_Rects + ((u16)frame * 4);
	const UX sx = rect[0] + ((u16)rect[1] << 8);

	VDP_CommandHMMM(cx, BOSS_BG_Y, 0, BOSS_COMP_Y, BOSS_RECT_W, BOSS_H);
	VDP_CommandLMMM(sx, BOSS_Y, g_X - cx, BOSS_COMP_Y, BOSS_W, BOSS_H, VDP_OP_TIMP);
	VDP_CommandHMMM(0, BOSS_COMP_Y, cx, BandRow(), BOSS_RECT_W, BOSS_H);

	g_DrawnX = g_X;
	g_DrawnFrame = frame;
	g_OnPicture = 1;
	return TRUE;
}
