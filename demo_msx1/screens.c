// ─────────────────────────────────────────────────────────────────────────────
//  The title picture and the text screens either side of the game.
// ─────────────────────────────────────────────────────────────────────────────
#include "demo.h"

// MSXgl's own 8x8 font, which also carries its logo as characters 1 to 6.
// Included *here* rather than in demo.h because it is another header that holds
// data rather than declarations: every file that included it would define its
// own copy of the font, and the linker would reject the duplicates.
#include "font/font_mgl_sample8.h"

// The text screens' paper colour. Local to this file: nothing else draws text.
#define PAPER  COLOR_BLACK


// SCREEN 1 stores one colour per group of eight consecutive pattern codes. The
// MSXgl font starts at character 0, so loading it at offset 0 makes a pattern
// code equal to the character code. So whole classes of character can be recoloured: capitals are 65-90,
// digits 48-57, and Print_DrawBox's frame glyphs 22-27 (lines 0x16/0x17,
// corners 0x18-0x1B).
void ColorChars(u8 firstChar, u8 lastChar, u8 fg, u8 bg)
{
	u8 col = (fg << 4) | bg;
	for (u8 group = firstChar >> 3; group <= (lastChar >> 3); ++group)
		VDP_Poke_16K(col, g_ScreenColorLow + group);
}

// Sets up SCREEN 1 with the BIOS font and the demo's palette, and clears it.
void BeginTextScreen()
{
	VDP_SetMode(VDP_MODE_GRAPHIC1);
	VDP_ClearVRAM();
	VDP_SetColor(PAPER);                       // border, so it matches the page
	Print_SetTextFont(g_Font_MGL_Sample8, 0);
	Print_SetColor(COLOR_WHITE, PAPER);        // fills all 32 groups at once

	// ...then lift a few classes out of that flat white.
	ColorChars(1,   6, COLOR_CYAN,          PAPER);   // the MSXgl logo
	ColorChars(22, 27, COLOR_CYAN,         PAPER);   // box lines and corners
	ColorChars(65, 90, COLOR_LIGHT_YELLOW, PAPER);   // capitals
	ColorChars(48, 57, COLOR_LIGHT_GREEN,  PAPER);   // digits
}

void PrintAt(u8 x, u8 y, const c8* text)
{
	Print_SetPosition(x, y);
	Print_DrawText(text);
}

/**
 * The title is a picture, not a page of text: `intro.map.json` drawn in
 * SCREEN 2 with its own tileset, and the player standing in the middle of it.
 *
 * It uses the *intro* tileset, so the game's tiles are not in VRAM while this
 * is up — `InitGame()` loads those when the game starts, which is why the two
 * screens can each have a full 256-tile bank.
 */
void TitleScreen()
{
	VDP_SetMode(VDP_MODE_GRAPHIC2);
	VDP_ClearVRAM();
	VDP_SetColor(COLOR_BLACK);

	VDP_LoadPattern_GM2(g_IntroTiles_Patterns, G_INTROTILES_PATTERNS_SIZE / 8, 0);
	VDP_LoadColor_GM2(g_IntroTiles_Colors, G_INTROTILES_COLORS_SIZE / 8, 0);

	// One screen exactly, so the map goes into the name table in one write.
	VDP_WriteVRAM_16K(g_IntroMap_Background, g_ScreenLayoutLow, G_INTROMAP_W * G_INTROMAP_H);

	// The player waits in the middle, facing right, in its standing pose.
	VDP_SetSpriteFlag(VDP_SPRITE_SIZE_16);
	VDP_LoadSpritePattern(g_PlayerSprites_Patterns, 0, G_PLAYERSPRITES_PATTERNS_SIZE / 8);
	VDP_DisableSpritesFrom(G_PLAYERSPRITES_PLAYER_PLANES);
	g_FaceLeft = 0;
	g_PlayerSprites_SetMeta(0, (256 - 16) / 2, ((192 - 16) / 2) - 1,
		G_PLAYERSPRITES_PLAYER_BASE + FRAME_STAND * G_PLAYERSPRITES_PLAYER_PLANES, G_PLAYERSPRITES_PLAYER_PLANES);
}

void CreditsScreen()
{
	BeginTextScreen();
	PrintAt(9,  2, "C R E D I T S");

	PrintAt(5,  5, "Built with MSXDEVStudio");
	PrintAt(8,  6, "by P.D. Garaguso");

	PrintAt(13, 8, MSX_GL);
	PrintAt(4, 10, "Powered by MSXgl + MSXtk");
	PrintAt(8, 11, "by G. Blanchard");
	PrintAt(10, 12, "CC BY-SA 4.0");

	PrintAt(3, 15, "Sound: ayFX by Shiru");
	PrintAt(3, 16, "Compiled with SDCC");
	PrintAt(3, 17, "Runs on openMSX / WebMSX");

	PrintAt(2, 20, "Not endorsed by the above");
	PrintAt(6, 22, "SPACE to restart");
}

void WaitForSpace()
{
	// Let go first, so the press that got us here does not fall through.
	while (Keyboard_IsKeyPressed(KEY_SPACE)) Halt();
	while (!Keyboard_IsKeyPressed(KEY_SPACE)) Halt();
}
