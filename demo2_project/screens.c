// ─────────────────────────────────────────────────────────────────────────────
// The full-screen pictures, and what a MegaROM is actually for.
//
// A SCREEN 5 picture is 27 136 bytes. Two of them plus the code do not fit in a
// 32 KB ROM, and the usual answer is to compress — which costs a RAM buffer,
// the `compress` module, and an unpack pass every time the picture is shown.
// A 128 KB ASCII-8 ROM lets you skip all of that: the picture goes into the
// cartridge raw and reaches VRAM as four HMMC calls.
//
// Two details make it that simple:
//
//  - Each picture is placed by *absolute offset* (see the .msxproj) so that its
//    bitmap starts exactly on an 8 KB segment boundary. A SCREEN 5 line is 128
//    bytes, so a segment is exactly 64 lines and no line ever straddles two.
//    The 32-byte palette the exporter writes ahead of the bitmap therefore sits
//    in the tail of the previous segment, where nothing reads it — the palette
//    the game uses is the atlas's copy, and they are the same sixteen colours.
//
//  - The window used for paging is bank 3 (0xA000). MSXgl maps segments 0–3
//    there at boot as the "main" 32 KB, and this program does not fill it, so
//    bank 3 holds nothing but padding — which means paging it out cannot take
//    the running code or a table with it. Bank 2 would be a gamble on the
//    linker's layout; bank 3 is not.
// ─────────────────────────────────────────────────────────────────────────────
#include "canyon.h"

#define BANK_WINDOW 3
#define BANK_ADDR ((const u8*)0xA000)
#define SEG_SIZE 0x2000
#define LINES_PER_SEG 64

/** The segment a raw blob's *bitmap* starts in, skipping the palette in front of it. */
#define BITMAP_SEG(abs) (u8)(((abs) + 32) / SEG_SIZE)

/**
 * Blits `lines` lines of a picture into page 0, one segment at a time. `seg` is
 * where its bitmap starts; every segment after it holds the next 64 lines.
 */
static void DrawPicture(u8 seg, u8 lines)
{
	u8 y = 0;
	while(lines)
	{
		u8 chunk = (lines > LINES_PER_SEG) ? LINES_PER_SEG : lines;
		SET_BANK_SEGMENT(BANK_WINDOW, seg++);
		VDP_CommandHMMC(BANK_ADDR, 0, y, VIEW_W, chunk);
		y += chunk;
		lines -= chunk;
	}
	SET_BANK_SEGMENT(BANK_WINDOW, BANK_WINDOW);
}

/**
 * The tile atlas into the page the display never shows, and the palette into
 * both the VDP and RAM. The RAM copy is what the vein animation rotates: it
 * runs every eighth frame and paging a segment in to read two bytes would be a
 * silly price for that.
 */
void Screens_LoadAtlas(void)
{
	SET_BANK_SEGMENT(BANK_WINDOW, ATLAS_BIN_SEG);
	const u8* blob = BANK_ADDR + ATLAS_BIN_REL;
	for(u8 i = 0; i < 32; ++i)
		g_Palette[i] = blob[i];
	VDP_SetPalette(g_Palette);
	VDP_CommandHMMC(blob + 32, 0, ATLAS_Y, VIEW_W, 48);
	SET_BANK_SEGMENT(BANK_WINDOW, BANK_WINDOW);
}

/** A picture, and then wait for SPACE — with a release first, so one press is one press. */
static void ShowUntilSpace(u8 seg)
{
	Scroll_Reset();
	// Nothing on a picture screen is a sprite, and the ones the stage left
	// behind are parked at 213 *plus the scroll offset* — which the reset above
	// has just thrown away, so they would slide back into view. Y = 216 in plane
	// 0 tells the VDP to stop looking at the table at all; the next Player_Start
	// overwrites it.
	VDP_DisableSpritesFrom(0);
	DrawPicture(seg, VIEW_H);

	while(Keyboard_IsKeyPressed(KEY_SPACE))
		;
	while(!Keyboard_IsKeyPressed(KEY_SPACE))
	{
		while(g_VBlank == 0)
		{
			__asm
				halt
			__endasm;
		}
		g_VBlank = 0;
		g_Frame++;
		ayFX_Update();
		PSG_Apply();
	}
}

void Screens_Title(void)
{
	ShowUntilSpace(BITMAP_SEG(TITLE_BIN_ABS));
}

void Screens_Credits(void)
{
	ShowUntilSpace(BITMAP_SEG(CREDITS_BIN_ABS));
}
