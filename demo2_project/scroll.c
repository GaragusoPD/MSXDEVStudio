// ─────────────────────────────────────────────────────────────────────────────
// The parallax — three layers, three different techniques, and only one of them
// costs the CPU anything worth measuring.
//
//  1. The canyon      R#23, one register write a frame. The page is a ring of
//                     256 lines and the map is fed into it a row at a time.
//  2. The mist        software sprites, moving *through* the page faster than
//                     the page moves under them — genuinely overlapping, which
//                     is the layer that actually reads as depth.
//  3. The veins       three palette entries rotated. No VRAM at all.
//
// The constraint everything here bends around is that R#23 wraps at 256 and
// nothing can opt out of it: every one of page 0's 256 lines gets scrolled
// through, so there is no corner of the page to hide a status bar or a spare
// tile in. Anything that must hold still is either a hardware sprite (which
// R#23 does not move) or lives in another page.
// ─────────────────────────────────────────────────────────────────────────────
#include "canyon.h"

/** World pixel row under display line 0: display line L shows world row g_ViewY + L. */
u16 g_ViewY;

/** The lowest map row already blitted into the ring. */
static u8 g_DrawnTop;

/**
 * Two offsets, and the difference between them is what stops the picture
 * shaking.
 *
 * `g_MainOffset` is what the logic has computed for the *next* frame. R#23
 * shifts the whole display, so moving it while the raster is inside the picture
 * tears the frame across; the logic therefore only ever updates this value and
 * the V-blank handler installs it, which is the one window where it is safe.
 *
 * `g_ShownOffset` is what the handler actually put in R#23, and it is what
 * every sprite position is measured against. Sprites are written in the middle
 * of a frame, so measuring them against the *next* frame's offset puts them one
 * pixel out for the rest of the current one — and since how far the logic gets
 * before the raster reaches any given line varies frame to frame, that one
 * pixel appears and disappears. It reads as the whole HUD trembling.
 */
static u8 g_MainOffset;
static u8 g_ShownOffset;

/** Where the vein ramp currently starts; see CyclePalette. */
static u8 g_VeinPhase;

/** One drifting wisp: which fragment it draws, where it is in the world, how fast. */
typedef struct
{
	g_Mist_SwSprite sprite;
	u8 frame;
	u8 x;
	u16 y; // world row, the same space as g_ViewY
	u8 period; // moves one pixel every `period` frames
	u8 phase;
} Wisp;

#define WISPS 3
#define WISP_H 16
#define WISP_TOP (PLAY_TOP + 4)
#define WISP_BOTTOM (VIEW_H - WISP_H - 4)

static Wisp g_Wisps[WISPS];

// ── the canyon ──────────────────────────────────────────────────────────────

/**
 * Blits one map row into the ring. The page row is the world row masked to
 * 256 — the ring the display walks round — and the generated helper does the
 * rest: one HMMM per cell, out of the atlas parked in page 1.
 */
static void DrawMapRow(u8 row)
{
	g_Stage_DrawRow(g_Stage_Terrain, row, ATLAS_Y, (UY)(((u16)row * CELL) & 0xFF));
}

void Scroll_Start(void)
{
	g_ViewY = WORLD_H - VIEW_H;
	g_VeinPhase = 0;
	g_MainOffset = (u8)(g_ViewY & 0xFF);
	g_ShownOffset = g_MainOffset;

	// Fill the whole ring before the display is looking at it.
	g_DrawnTop = (u8)(g_ViewY / CELL);
	for(u8 i = 0; i < 16; ++i)
		DrawMapRow(g_DrawnTop + i);

	// Three wisps, three speeds — which is what makes them read as a layer
	// rather than as three objects that happen to be moving.
	for(u8 i = 0; i < WISPS; ++i)
	{
		g_Wisps[i].sprite.slot = i;
		g_Wisps[i].sprite.bw = 0;
		g_Wisps[i].frame = i;
		g_Wisps[i].x = 24 + i * 72;
		g_Wisps[i].y = g_ViewY + WISP_TOP + i * 56;
		g_Wisps[i].period = 2 + i;
		g_Wisps[i].phase = i;
	}
}

/**
 * The vein ramp rotated by one. Three writes to the palette port and the whole
 * canyon has something flowing through it — the cheapest animation on the
 * machine, and the only one that also reaches the cells scrolled off screen.
 */
static void CyclePalette(void)
{
	g_VeinPhase = (g_VeinPhase + 1) % VEIN_COUNT;
	for(u8 i = 0; i < VEIN_COUNT; ++i)
	{
		const u8* entry = g_Palette + ((VEIN_FIRST + ((i + g_VeinPhase) % VEIN_COUNT)) * 2);
		VDP_SetPaletteEntry(VEIN_FIRST + i, (u16)entry[0] | ((u16)entry[1] << 8));
	}
}

void Scroll_Update(void)
{
	if(g_ViewY > 0)
	{
		g_ViewY--;

		// A row of map every sixteen pixels of travel, written into the ring
		// 240-odd lines from the raster, so nothing is drawn over something the
		// display is about to reach.
		while((g_ViewY / CELL) < g_DrawnTop)
		{
			g_DrawnTop--;
			DrawMapRow(g_DrawnTop);
		}
	}

	g_MainOffset = (u8)(g_ViewY & 0xFF);

	if((g_Frame & 7) == 0)
		CyclePalette();
}

/**
 * Installs the scroll for the frame that is about to be drawn. Called from the
 * V-blank handler and nowhere else — see above for why.
 */
/**
 * The initialiser is not decoration. MSXgl's crt0 copies `_INITIALIZER` into
 * `_INITIALIZED` and stops there — it never clears `_DATA`, so a global written
 * without one starts as whatever the machine happened to leave in RAM. Left
 * bare, this came up non-zero on a cold boot and the V-blank handler put the
 * display on page 1 before `main` had run a line: the title picture was drawn
 * correctly onto page 0 and never shown, and what reached the screen was the
 * mist strip parked at MIST_Y. Anything read before it is first written needs
 * an `= value` here.
 */
u8 g_BandOn = FALSE;

/**
 * Where the frame is: on the band, or past the join and on the world. Reset by
 * `Scroll_Present` at the V-blank, moved on by the line interrupt — so it is
 * both the split's state and what `WaitFrame` waits on.
 */
u8 g_Phase = PHASE_BAND;

void Scroll_ShowBand(u8 on)
{
	g_BandOn = on;
	VDP_EnableHBlank(on ? TRUE : FALSE);
}

/**
 * Parks the display at the top of the page, for the full-screen pictures.
 *
 * Setting R#23 directly would not survive: `Scroll_Present` reinstalls
 * `g_ShownOffset` on the very next V-blank, so a picture shown after a stage
 * would come up scrolled by wherever the canyon had got to. The offset belongs
 * to this file, so the reset does too.
 */
void Scroll_Reset(void)
{
	g_MainOffset = 0;
	g_ShownOffset = 0;
	VDP_SetVerticalOffset(0);
}

/**
 * Sets the display up for the top of the frame, from the V-blank handler.
 *
 * With the band on, the frame *starts* on it: page 1, no offset, no sprites.
 * R#19 then asks for an interrupt at the join, and because the band's own
 * offset is zero the line R#19 names is the display line — no scroll to add
 * back in, which is one fewer thing to get wrong than a band at the bottom.
 */
void Scroll_Present(void)
{
	g_ShownOffset = g_MainOffset;
	if(!g_BandOn)
	{
		VDP_SetPage(0);
		VDP_SetVerticalOffset(g_ShownOffset);
		VDP_EnableSprite(TRUE);
		return;
	}
	g_Phase = PHASE_BAND;
	VDP_SetPage(1);
	VDP_SetVerticalOffset(0);
	VDP_EnableSprite(FALSE);
	VDP_SetHBlankLine(HUD_H - HUD_SPLIT_LEAD);
	// Armed here, at a known line, with the offset still zero. `Scroll_World`
	// decides what happens to it after it fires — see there.
	VDP_EnableHBlank(TRUE);
}

/**
 * …and for everything below the join: the scrolling world, with its sprites.
 *
 * Then the line interrupt is switched off for the rest of the frame, and that
 * is not tidiness either — it is the fix for the screen jumping every few
 * seconds.
 *
 * R#19 is not compared against the display line. It is compared against the
 * same offset line counter R#23 shifts, which is only the display line while
 * the offset is zero — true across the band, and the reason the band is easy to
 * place. The moment this function installs the world's offset, R#19 = 20 starts
 * naming display line (20 − offset) instead, and it matches a *second* time in
 * the same frame. For most offsets that second match lands early and harmlessly
 * re-runs this function. But as the canyon scrolls, the offset passes through
 * 65–69, the second match lands on display lines 207–211 — the last handful
 * before the vertical blank — and the two interrupts arrive on top of each
 * other. The frame that comes out is drawn from page 1 at the world's offset:
 * the whole picture jumps and the status band appears at the bottom of it.
 *
 * It is a window five values wide out of 256, so it turns up about every four
 * seconds of scrolling — often enough to be the "every now and then" flicker,
 * rare enough to look random. One bit closes it: the split has already happened
 * and there is nothing left to interrupt for, so the interrupt goes away until
 * the next V-blank arms it again.
 */
void Scroll_World(void)
{
	VDP_SetPage(0);
	VDP_SetVerticalOffset(g_ShownOffset);
	VDP_EnableSprite(TRUE);
	g_Phase = PHASE_WORLD;
	VDP_EnableHBlank(FALSE);
}

/**
 * The sprite Y to write for something that should appear on display line
 * `screenY`.
 *
 * R#23 does not only shift the bitmap: the sprite Y coordinate is compared
 * against the same offset line counter, so the whole sprite plane scrolls with
 * the picture. A sprite left at a fixed Y therefore slides off the top of the
 * screen as the world scrolls — which looks exactly like sprites being broken,
 * because for most of the time none of them are anywhere near the display.
 * MSXgl's own `s_gm3` sample does the same addition for the same reason.
 *
 * The offset used is the one *currently on screen*, not the one queued for the
 * next frame, so a sprite written halfway down a frame still lands where it was
 * asked to.
 */
/**
 * Parks a sprite below the display.
 *
 * MSXgl's `VDP_HideSprite` writes a fixed Y of 213, which is off-screen only
 * when the display is not offset — and R#23 offsets it. Left as is, a "hidden"
 * sprite is dragged back into view and sits there: a shot down drone that never
 * goes away.
 */
void Scroll_HideSprite(u8 index)
{
	VDP_SetSpritePositionY(index, Scroll_SpriteY(VDP_SPRITE_HIDE));
}

u8 Scroll_PageRow(u8 screenY)
{
	return (u8)((screenY + g_ShownOffset) & 0xFF);
}

u8 Scroll_SpriteY(u8 screenY)
{
	u8 y = screenY + g_ShownOffset;
	// 216 tells the VDP to stop drawing sprites from this plane on. Landing on
	// it by accident would take out everything behind, so step over it.
	if(y == 216)
		y++;
	return y;
}

// ── the mist ────────────────────────────────────────────────────────────────

/**
 * Software sprites, and the reason they earn their cost here: the canyon comes
 * down the screen at one pixel a frame because the *page* moves under a fixed
 * display, while a wisp also moves down the page — so on screen it travels
 * faster than the ground it is over. Two layers, one picture, no second name
 * table, and no per-line sprite limit.
 *
 * Restore every wisp that is about to move before drawing any of them:
 * restoring one at a time rubs out whatever was drawn on top of it.
 */
void Scroll_Mist(void)
{
	u8 moved = 0;
	for(u8 i = 0; i < WISPS; ++i)
		if(((g_Frame + g_Wisps[i].phase) % g_Wisps[i].period) == 0)
			moved |= 1 << i;

	// At most one wisp a frame, and this is a frame *budget*, not thrift.
	//
	// A wisp costs about 1.2 KB of VRAM traffic to lift and put down, and the
	// VDP runs at roughly 1.5 µs a byte with the display on — so three of them
	// in one frame is five milliseconds, and with a map row and the sprites on
	// top of that the blitting can still be going when the raster reaches the
	// bottom of the screen. That matters because the status band's split fires
	// down there: if the CPU is inside MSXgl's command setup, which writes
	// fifteen registers with interrupts disabled, the interrupt waits — by a
	// different amount every frame — and the band's top edge frays.
	//
	// Spreading them out costs nothing visible (each wisp still moves at its own
	// rate, just never on the same frame as its neighbours) and leaves the last
	// third of every frame quiet.
	// Round-robin, so no wisp starves when two come due on the same frame.
	for(u8 n = 0; n < WISPS; ++n)
	{
		u8 bit = 1 << ((g_Frame + n) % WISPS);
		if(moved & bit)
		{
			moved = bit;
			break;
		}
	}
	if(moved == 0)
		return;

	for(i8 i = WISPS - 1; i >= 0; --i)
		if(moved & (1 << i))
			g_Mist_Restore(&g_Wisps[i].sprite, MIST_Y);

	for(u8 i = 0; i < WISPS; ++i)
	{
		if((moved & (1 << i)) == 0)
			continue;
		Wisp* wisp = &g_Wisps[i];
		// Down the page as well as down the screen: 1 + 1/period pixels a frame
		// against the ground's 1.
		wisp->y++;
		u16 screen = wisp->y - g_ViewY;
		if(screen > WISP_BOTTOM)
			wisp->y = g_ViewY + WISP_TOP;

		// The page is a ring for the *display*, but not for the command engine:
		// DY is ten bits, so a blit starting within WISP_H of row 255 does not
		// wrap back to row 0, it carries straight on into page 1 — which is the
		// status band. Both the backup and the draw would land there, and the
		// band is only repainted when the numbers on it change, so what it
		// leaves sits on the HUD until the wisp next moves.
		//
		// The wisp is simply left down for the fifteen moves it takes to cross
		// the seam. It was restored above, so nothing of it is on the picture,
		// and its own `bw` is zero — the next restore is a no-op.
		//
		// ponytail: the cheap half of the fix. The wisp does fade out and back
		// in, roughly a second every quarter-minute. Splitting the blit in two
		// at the seam would keep it visible, but the generated helper takes a
		// whole fragment; if that ever matters, teach it a height.
		u8 row = (u8)(wisp->y & 0xFF);
		if(row > (u8)(256 - WISP_H))
			continue;
		g_Mist_Draw(&wisp->sprite, wisp->frame, wisp->x, (UY)row, MIST_Y);
	}
}

/** Takes the wisps off the picture — before a redraw, or when the boss arrives. */
void Scroll_MistOff(void)
{
	for(i8 i = WISPS - 1; i >= 0; --i)
		g_Mist_Restore(&g_Wisps[i].sprite, MIST_Y);
}

// ── asking the map a question ───────────────────────────────────────────────

/**
 * The atlas cell under a point on the *screen*. Hardware sprites live in screen
 * space (R#23 does not move them) and the map lives in world space; this is the
 * one place the two meet, so everything else can stay in whichever space it
 * belongs to.
 */
u8 Scroll_CellAt(u8 screenX, u8 screenY)
{
	u16 world = g_ViewY + screenY;
	if(world >= WORLD_H)
		return 0;
	return g_Stage_Terrain[((world / CELL) * MAP_COLS) + (screenX / CELL)];
}
