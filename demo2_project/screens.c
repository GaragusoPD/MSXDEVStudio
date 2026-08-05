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
/** …and for the small sheets, which are read whole rather than a segment at a time. */
#define BLOB_SEG(abs) (u8)((abs) / SEG_SIZE)
#define BLOB_REL(abs) (u16)((abs) & (SEG_SIZE - 1))

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

/** One small sheet out of its ROM segment and into VRAM, palette skipped. */
static void LoadSheet(u8 seg, u16 rel, UY y, u16 w, u8 h)
{
	SET_BANK_SEGMENT(BANK_WINDOW, seg);
	VDP_CommandHMMC(BANK_ADDR + rel + 32, 0, y, w, h);
	SET_BANK_SEGMENT(BANK_WINDOW, BANK_WINDOW);
}

/**
 * The tile sheet, which is the one blob big enough to outgrow a segment.
 *
 * Same shape as `DrawPicture`: a segment holds 64 rows of 256 dots, so the
 * upload walks segment by segment. That is why the atlas is placed with its
 * sheet *on* a segment boundary — the palette in front of it sits in the tail
 * of the previous segment, where nothing reads it.
 */
static void LoadTileSheet(void)
{
	u8 seg = BITMAP_SEG(ATLAS_BIN_ABS);
	UY y = ATLAS_Y;
	u8 rows = ATLAS_ROWS * CELL;
	while(rows)
	{
		u8 chunk = (rows > LINES_PER_SEG) ? LINES_PER_SEG : rows;
		SET_BANK_SEGMENT(BANK_WINDOW, seg++);
		VDP_CommandHMMC(BANK_ADDR, 0, y, VIEW_W, chunk);
		y += chunk;
		rows -= chunk;
	}
	SET_BANK_SEGMENT(BANK_WINDOW, BANK_WINDOW);
}

/**
 * Every sheet that lives in a ROM segment, into the pages the display never
 * shows — and the palette into both the VDP and RAM.
 *
 * The RAM copy of the palette is what the vein animation rotates: it runs every
 * eighth frame, and paging a segment in to read two bytes would be a silly
 * price for that.
 *
 * The boss and the ending panels are here rather than in `content/` as C arrays
 * for one reason, and it is the reason this whole file works: the paging window
 * is bank 3, 0xA000–0xBFFF, and paging it out has to be safe. It only is while
 * nothing the program needs lives up there — so the moment the code and its
 * constant tables grow past 0xA000, `SET_BANK_SEGMENT` starts swapping live
 * functions out from under the CPU and the machine hangs on the next call.
 * Every kilobyte of artwork kept out of `_CODE` is a kilobyte of headroom
 * against that.
 */
void Screens_LoadArt(void)
{
	// The palette sits in the 32 bytes before the sheet, in the tail of the
	// segment ahead of it.
	SET_BANK_SEGMENT(BANK_WINDOW, BLOB_SEG(ATLAS_BIN_ABS));
	const u8* blob = BANK_ADDR + BLOB_REL(ATLAS_BIN_ABS);
	for(u8 i = 0; i < 32; ++i)
		g_Palette[i] = blob[i];
	SET_BANK_SEGMENT(BANK_WINDOW, BANK_WINDOW);
	VDP_SetPalette(g_Palette);

	LoadTileSheet();

	// The flags follow the sheet — one byte a tile, copied into RAM once so a
	// collision test is an array read rather than a page-in.
	SET_BANK_SEGMENT(BANK_WINDOW, BLOB_SEG(ATLAS_FLAGS_ABS));
	const u8* flags = BANK_ADDR + BLOB_REL(ATLAS_FLAGS_ABS);
	for(u8 i = 0; i < ATLAS_TILES; ++i)
		g_TileFlags[i] = flags[i];
	SET_BANK_SEGMENT(BANK_WINDOW, BANK_WINDOW);

	LoadSheet(BLOB_SEG(BOSS_BIN_ABS), BLOB_REL(BOSS_BIN_ABS), BOSS_Y, BOSS_W * BOSS_FRAMES, BOSS_H);
	LoadSheet(BLOB_SEG(ENDINGS_BIN_ABS), BLOB_REL(ENDINGS_BIN_ABS), ENDINGS_Y, MSG_W * 2, MSG_H);
}

/** Waits for SPACE, with a release first so one press is one press. */
static void WaitSpace(void)
{
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

/**
 * A message panel, put down on the play screen exactly where it stands.
 *
 * The endings are a strip rather than two more full-screen pictures — one more
 * picture would fit in the ROM and two would not — but that is not the only
 * reason. Leaving the canyon behind the message is the better reading: the
 * player can still see where they got to, and nothing jumps at the moment the
 * run ends.
 *
 * Keeping it there is the whole of the work below. The panel goes into page 0,
 * whose rows the scroll has walked round to somewhere arbitrary, so the *page*
 * row is the screen row plus the offset — and a panel low enough on the screen
 * runs off the bottom of the page. The VDP command engine does not wrap there;
 * it carries straight on into page 1, which is the status band. So the blit is
 * cut at the seam and the remainder goes to page row 0, which is the row the
 * display shows immediately below it. Two blits, one continuous panel.
 */
void Screens_Message(u8 panel)
{
	VDP_DisableSpritesFrom(0);
	const UX sx = (UX)panel * MSG_W;
	const u8 w = MSG_W;
	const u8 h = MSG_H;
	const u8 x = (VIEW_W - w) / 2;
	const u8 row = Scroll_PageRow(MSG_Y);
	// 16-bit: with `row` at 0 the whole panel fits, and `256 - row` in eight
	// bits is zero — which the command engine reads as 1024 rows, not none.
	const u16 avail = 256u - row;
	const u8 fits = (avail < h) ? (u8)avail : h;

	VDP_CommandHMMM(sx, ENDINGS_Y, x, row, w, fits);
	if(fits < h)
		VDP_CommandHMMM(sx, ENDINGS_Y + fits, x, 0, w, h - fits);
	WaitSpace();
}

/** A picture, and then wait for SPACE. */
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
	WaitSpace();
}

void Screens_Title(void)
{
	ShowUntilSpace(BITMAP_SEG(TITLE_BIN_ABS));
}

void Screens_Credits(void)
{
	ShowUntilSpace(BITMAP_SEG(CREDITS_BIN_ABS));
}
