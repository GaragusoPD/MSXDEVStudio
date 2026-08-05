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
} Drone;

static Drone g_Drones[MAX_DRONES];
static u8 g_SpawnTimer;
static u16 g_Seed;

#define DRONE_FALL 1
#define SPAWN_EVERY 44

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
		Scroll_HideSprite(SPR_DRONE + i);
	}
}

void Enemy_Hide(void)
{
	for(u8 i = 0; i < MAX_DRONES; ++i)
	{
		g_Drones[i].alive = 0;
		Scroll_HideSprite(SPR_DRONE + i);
	}
}

static void Spawn(void)
{
	for(u8 i = 0; i < MAX_DRONES; ++i)
	{
		if(g_Drones[i].alive)
			continue;
		g_Drones[i].alive = 1;
		g_Drones[i].x = 24 + (Random() % 200);
		g_Drones[i].y = PLAY_TOP + 2;
		g_Drones[i].dx = (Random() & 1) ? 1 : -1;
		return;
	}
}

static void Kill(u8 i)
{
	g_Drones[i].alive = 0;
	Scroll_HideSprite(SPR_DRONE + i);
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
			continue;
		Drone* drone = &g_Drones[i];

		drone->y += DRONE_FALL;
		if(drone->y > HUD_Y - 18)
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
