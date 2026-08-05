// ─────────────────────────────────────────────────────────────────────────────
// Drones: ordinary hardware sprites, one plane each, two frames of animation
// out of the same sheet the ship comes from.
//
// They exist to make the point the boss then breaks. Eight of them can be on
// screen and the VDP will draw them, but only eight *per line* in sprite mode 2
// — line them up and the ninth vanishes. The boss is 68 dots wide, which is
// five 16-wide sprites on one line before it has any company at all, and that
// is why it is not a sprite (see boss.c).
// ─────────────────────────────────────────────────────────────────────────────
#include "canyon.h"

typedef struct
{
	u8 alive;
	u8 x, y;
	i8 dx;
	/** Frames left of the wreck. A slot with this set is dead but not yet free. */
	u8 boom;
} Drone;

static Drone g_Drones[MAX_DRONES];
static u8 g_SpawnTimer;
static u16 g_Seed;

#define DRONE_FALL 1
#define SPAWN_EVERY 44
/** How long each frame of the burst is held, and so how long the whole thing lasts. */
#define BOOM_HOLD 4
#define BOOM_TOTAL (G_FLEET_BOOM_FRAMES * BOOM_HOLD)

/** Small xorshift — Math_GetRandom8 would pull in the maths module for this alone. */
static u8 Random(void)
{
	g_Seed ^= g_Seed << 7;
	g_Seed ^= g_Seed >> 9;
	g_Seed ^= g_Seed << 8;
	return (u8)g_Seed;
}

void Enemy_Start(void)
{
	g_Seed = 0x2B71;
	g_SpawnTimer = 30;
	for(u8 i = 0; i < MAX_DRONES; ++i)
	{
		g_Drones[i].alive = 0;
		g_Drones[i].boom = 0;
		Scroll_HideSprite(SPR_DRONE + i);
	}
}

void Enemy_Hide(void)
{
	for(u8 i = 0; i < MAX_DRONES; ++i)
	{
		g_Drones[i].alive = 0;
		g_Drones[i].boom = 0;
		Scroll_HideSprite(SPR_DRONE + i);
	}
}

static void Spawn(void)
{
	for(u8 i = 0; i < MAX_DRONES; ++i)
	{
		// A slot still burning is not free — reusing it would cut the wreck off
		// mid-burst and drop a new drone out of the flash.
		if(g_Drones[i].alive || g_Drones[i].boom)
			continue;
		g_Drones[i].alive = 1;
		g_Drones[i].boom = 0;
		g_Drones[i].x = 24 + (Random() % 200);
		g_Drones[i].y = PLAY_TOP + 2;
		g_Drones[i].dx = (Random() & 1) ? 1 : -1;
		return;
	}
}

/**
 * The drone stops being a drone and starts being a wreck: the same plane, three
 * frames of burst, and only then the plane goes away. Nothing new is allocated
 * — the explosion is drawn where the drone was, on the plane the drone had, so
 * it cannot be crowded out by whatever else is on that scanline.
 */
static void Kill(u8 i)
{
	g_Drones[i].alive = 0;
	g_Drones[i].boom = BOOM_TOTAL;
	PlaySfx(1);
}

void Enemy_Update(void)
{
	if(--g_SpawnTimer == 0)
	{
		g_SpawnTimer = SPAWN_EVERY;
		Spawn();
	}

	// Two frames, swapped every eighth frame, and every drone shares the count —
	// they are a swarm, so they may as well beat together.
	u8 frame = (g_Frame & 8) ? 1 : 0;

	for(u8 i = 0; i < MAX_DRONES; ++i)
	{
		if(!g_Drones[i].alive)
		{
			if(g_Drones[i].boom)
			{
				// The burst holds the screen position it died at while the
				// canyon keeps moving under it, which is what makes it read as
				// a thing that happened rather than a thing stuck to the ground.
				g_Drones[i].boom--;
				u8 f = (BOOM_TOTAL - 1 - g_Drones[i].boom) / BOOM_HOLD;
				g_Fleet_SetMeta(SPR_DRONE + i, g_Drones[i].x, Scroll_SpriteY(g_Drones[i].y),
					G_FLEET_BOOM_BASE + f * G_FLEET_BOOM_PLANES, G_FLEET_BOOM_PLANES);
				continue;
			}
			// Parked again every frame, not once when it died — and this is the
			// whole reason dead drones were coming back.
			//
			// `Scroll_HideSprite` puts the plane at display line 213, which it
			// reaches by writing 213 *plus the current scroll offset*, because
			// R#23 moves the sprite plane along with the picture. One frame
			// later the offset has moved by one and that same stored Y is line
			// 214; forty-three frames later it has wrapped past 255 to line 0,
			// and the corpse walks back down the screen at exactly the speed a
			// live drone falls — never dying, because nothing is updating it.
			// Eight planes doing that is the screen filling up with enemies that
			// do not react and cannot be shot.
			//
			// There is no Y that is off-screen for every offset (the display
			// covers 212 of the plane's 256 lines), so the park has to be
			// renewed while the world moves. It costs one VRAM byte per dead
			// plane per frame.
			Scroll_HideSprite(SPR_DRONE + i);
			continue;
		}
		Drone* drone = &g_Drones[i];

		drone->y += DRONE_FALL;
		if(drone->y > VIEW_H - 18)
		{
			drone->alive = 0;
			Scroll_HideSprite(SPR_DRONE + i);
			continue;
		}
		// A drone that would slide into the rock turns round instead, which
		// keeps them in the channel the player is flying down.
		u8 next = drone->x + (drone->dx > 0 ? 18 : (u8)-2);
		if(next < 8 || next > VIEW_W - 24 || IsWall(Scroll_CellAt(next, drone->y + 8)))
			drone->dx = -drone->dx;
		drone->x += drone->dx;

		if(Player_ShotHits(drone->x, drone->y, 16, 16) != MAX_SHOTS)
		{
			Kill(i);
			continue;
		}
		if(Player_HitBy(drone->x, drone->y, 16, 16))
		{
			Kill(i);
			Player_Damage();
			continue;
		}

		g_Fleet_SetMeta(SPR_DRONE + i, drone->x, Scroll_SpriteY(drone->y),
			G_FLEET_DRONE_BASE + frame * G_FLEET_DRONE_PLANES, G_FLEET_DRONE_PLANES);
	}
}
