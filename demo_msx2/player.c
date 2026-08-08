// ─────────────────────────────────────────────────────────────────────────────
// The ship and its shots — hardware sprites, and the one place mode 2's
// OR-colour is doing real work.
//
// The ship is two planes on the same coordinate, and the order of those planes
// is load-bearing. The lower one is the hull. The upper one carries the detail
// with its CC bit set, which tells the VDP to OR its colour with the plane
// underneath instead of hiding behind it — and a CC plane is only drawn where a
// lower-numbered plane already has a pixel, so it has to be the *upper* of the
// two. With the CC layer underneath there is nothing to OR against and it is
// simply never drawn: the ship comes out as one flat sprite with the second
// layer missing. If that ever happens again, the layer order in the sprite
// editor is the thing to look at.
//
// Everything else about the ship's look lives in the sheet. The two frames are
// the booster animation and nothing here needs to know what changes between
// them; `g_Fleet_SetMeta` places every plane of whichever frame is due, and the
// frame count comes from the exporter, so adding one is an edit in the sprite
// editor and a rebuild.
//
// There is one hull and it does not bank. The sheet used to carry a left and a
// right lean as separate characters, picked by which way the player was
// pressing; they were dropped from the resource, and with them the pose index
// that chose between them.
//
// Every Y here is a *screen* line and goes through `Scroll_SpriteY` on the way
// out, because R#23 scrolls the sprite plane too.
// ─────────────────────────────────────────────────────────────────────────────
#include "canyon.h"

u8 g_ShipX, g_ShipY;

static u8 g_Cooldown;
/** Frames left of post-hit grace; the hull shows red while it runs. */
static u8 g_Grace;

typedef struct
{
	u8 alive;
	u8 x, y;
} Shot;

static Shot g_Shots[MAX_SHOTS];

#define SHIP_SPEED 2
#define SHOT_SPEED 6
#define SHIP_TOP (PLAY_TOP + 8)
#define SHIP_BOTTOM (VIEW_H - 20)
#define FIRE_DELAY 8
/** The hull's colour through the grace period — palette entry 14, the bright red. */
#define HIT_COLOR 14

void Player_Start(void)
{
	g_ShipX = 120;
	g_ShipY = (u8)(VIEW_H - 48);
	g_Cooldown = 0;
	g_Grace = 0;
	g_Energy = MAX_ENERGY;
	for(u8 i = 0; i < MAX_SHOTS; ++i)
	{
		g_Shots[i].alive = 0;
		Scroll_HideSprite(SPR_SHOT + i);
	}
}

void Player_Hide(void)
{
	Scroll_HideSprite(SPR_SHIP);
	Scroll_HideSprite(SPR_SHIP + 1);
	for(u8 i = 0; i < MAX_SHOTS; ++i)
		Scroll_HideSprite(SPR_SHOT + i);
}

static void Fire(void)
{
	for(u8 i = 0; i < MAX_SHOTS; ++i)
	{
		if(g_Shots[i].alive)
			continue;
		g_Shots[i].alive = 1;
		g_Shots[i].x = g_ShipX;
		g_Shots[i].y = g_ShipY - 8;
		g_Cooldown = FIRE_DELAY;
		PlaySfx(0);
		return;
	}
}

/**
 * The canyon walls are solid. The question is asked about the middle of the
 * hull rather than its corners: a 16×16 sprite whose corners are clear of the
 * rock still looks like it is touching it, and the generous version is the one
 * that feels fair.
 */
static bool HitsWall(void)
{
	return IsWall(Scroll_CellAt(g_ShipX + 8, g_ShipY + 8));
}

/**
 * One hit. The grace period is not politeness — without it, a hull resting
 * against rock would spend the whole bar in three frames, and the player would
 * never see what hit them.
 */
void Player_Damage(void)
{
	if(g_Grace)
		return;
	g_Grace = HIT_GRACE;
	PlaySfx(2);
	if(--g_Energy == 0)
		g_State = STATE_DEAD;
}

void Player_Update(void)
{
	if(Keyboard_IsKeyPressed(KEY_LEFT) && g_ShipX > 4)
		g_ShipX -= SHIP_SPEED;
	if(Keyboard_IsKeyPressed(KEY_RIGHT) && g_ShipX < VIEW_W - 20)
		g_ShipX += SHIP_SPEED;
	if(Keyboard_IsKeyPressed(KEY_UP) && g_ShipY > SHIP_TOP)
		g_ShipY -= SHIP_SPEED;
	if(Keyboard_IsKeyPressed(KEY_DOWN) && g_ShipY < SHIP_BOTTOM)
		g_ShipY += SHIP_SPEED;

	if(g_Cooldown)
		g_Cooldown--;
	else if(Keyboard_IsKeyPressed(KEY_SPACE))
		Fire();

	// One call places every plane of the hull from a single coordinate, and the
	// frame it picks is whatever the sheet happens to hold: the count comes from
	// the exporter, so adding a frame in the sprite editor animates the ship
	// without touching this line.
	if(g_Grace)
		g_Grace--;
	const u8 frame = (u8)((g_Frame >> 3) % G_FLEET_SHIP_COPY_FRAMES);
	g_Fleet_SetMeta(SPR_SHIP, g_ShipX, Scroll_SpriteY(g_ShipY),
		G_FLEET_SHIP_COPY_BASE + frame * G_FLEET_SHIP_COPY_PLANES, G_FLEET_SHIP_COPY_PLANES);

	// The grace period turns the hull red rather than blinking it off. A blink
	// says "something happened"; a tint says "you were hit and you are still
	// here", and it keeps the ship where the player can see it — which matters,
	// because they are flying it through rock at the time.
	//
	// `g_Fleet_SetMeta` has just written both planes, colour table included, so
	// there is nothing to undo when the grace period ends: the next ordinary
	// frame puts the ship's own colours straight back. In sprite mode 2 the
	// colour table is one byte per line, so a fill over it is the whole tint.
	if(g_Grace)
	{
		for(u8 i = 0; i < G_FLEET_SHIP_COPY_PLANES; ++i)
			VDP_FillVRAM(HIT_COLOR, g_SpriteColorLow + ((u16)(SPR_SHIP + i) * 16),
				g_SpriteColorHigh, 16);
	}

	for(u8 i = 0; i < MAX_SHOTS; ++i)
	{
		if(!g_Shots[i].alive)
		{
			// Re-parked every frame; see the same loop in enemy.c for why a
			// one-off hide does not stay hidden while the world scrolls.
			Scroll_HideSprite(SPR_SHOT + i);
			continue;
		}
		if(g_Shots[i].y < SHOT_SPEED + PLAY_TOP)
		{
			g_Shots[i].alive = 0;
			Scroll_HideSprite(SPR_SHOT + i);
			continue;
		}
		g_Shots[i].y -= SHOT_SPEED;
		g_Fleet_SetMeta(SPR_SHOT + i, g_Shots[i].x, Scroll_SpriteY(g_Shots[i].y), G_FLEET_SHOT_BASE, G_FLEET_SHOT_PLANES);
	}

	if(HitsWall())
	{
		Player_Damage();
		// Pushed back out of the rock: leaving the hull inside it would spend
		// the next block the moment the grace period ends.
		g_ShipX = (g_ShipX < VIEW_W / 2) ? g_ShipX + 10 : g_ShipX - 10;
	}
}

/** Box overlap against the ship's hull, in screen space. */
u8 Player_HitBy(u8 x, u8 y, u8 w, u8 h)
{
	if(x + w < g_ShipX + 3 || g_ShipX + 13 < x)
		return 0;
	if(y + h < g_ShipY + 3 || g_ShipY + 13 < y)
		return 0;
	return 1;
}

u8 Player_ShotHits(u8 x, u8 y, u8 w, u8 h)
{
	for(u8 i = 0; i < MAX_SHOTS; ++i)
	{
		if(!g_Shots[i].alive)
			continue;
		u8 sx = g_Shots[i].x + 6;
		u8 sy = g_Shots[i].y + 4;
		if(sx < x || sx > x + w || sy < y || sy > y + h)
			continue;
		g_Shots[i].alive = 0;
		Scroll_HideSprite(SPR_SHOT + i);
		return i;
	}
	return MAX_SHOTS;
}
