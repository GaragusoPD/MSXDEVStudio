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
/** Screen row the boss holds station on; the page row is this plus g_ViewY. */
#define BOSS_Y_POS (PLAY_TOP + 12)

static g_Boss_SwSprite g_Sprite;
static u8 g_Health;
static u8 g_X;
static i8 g_Dx;
static u8 g_Flash;
static u8 g_Alive;

void Boss_Start(void)
{
	g_Sprite.slot = 0;
	g_Sprite.bw = 0;
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

	g_Boss_Restore(&g_Sprite, BOSS_Y);

	// Every other frame: a 68×40 blit is about four kilobytes of VRAM traffic
	// with the display on, and doing it twice a frame would not fit.
	if(g_Frame & 1)
	{
		g_X += g_Dx;
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

	g_Boss_Draw(&g_Sprite, frame, g_X, (UY)((g_ViewY + BOSS_Y_POS) & 0xFF), BOSS_Y);
	return TRUE;
}
