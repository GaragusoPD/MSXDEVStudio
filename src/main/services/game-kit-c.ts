/**
 * C text the game-kit scaffolder writes into main.c / src/*.
 * String assembly only — no disk I/O.
 *
 * Everything here is checked by compiling and linking it against a real MSXgl
 * (`game-kit-build.test.ts`), because an API that doesn't exist and a config
 * define that leaves a module half-built both look fine on the page.
 */

import {
  attributionLines,
  displayColumns,
  firstState,
  GAME_SOURCE_DIR,
  isBitmapMode,
  isScrollKit,
  isTextMode,
  isTiledMode,
  isSc3Mode,
  hasNameTable,
  textModeMacroFor,
  vdpModeMacro,
  type DisplayMode,
  type NewGameRequest,
  type ScreenId
} from '../../shared/game-kit'

const STATE_FUN: Record<Exclude<ScreenId, 'hud' | 'play'>, string> = {
  title: 'State_Title',
  menu: 'State_Menu',
  options: 'State_Options',
  intro: 'State_Intro',
  pause: 'State_Pause',
  gameover: 'State_GameOver',
  victory: 'State_Victory',
  credits: 'State_Credits',
  attract: 'State_Attract',
  password: 'State_Password',
  'stage-select': 'State_StageSelect'
}

/** MSXgl's own 8×8 bitmap font. The BIOS font (`PRINT_DEFAULT_FONT`) is a
 *  pattern-table font: it only exists in text and tiled modes. */
const FONT_HEADER = 'font/font_mgl_sample8.h'
const FONT_SYMBOL = 'g_Font_MGL_Sample8'

/** Double-quoted C string literal; keeps Print_DrawText compilable. */
export function cString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '').replace(/\n/g, '\\n')}"`
}

/** Greedy word wrap. A word longer than the line is left alone rather than cut. */
export function wrapText(text: string, columns: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    if (!line) line = word
    else if (line.length + 1 + word.length <= columns) line += ` ${word}`
    else {
      out.push(line)
      line = word
    }
  }
  if (line) out.push(line)
  return out
}

function usesState(request: NewGameRequest): boolean {
  return request.screens.some((screen) => screen !== 'play' && screen !== 'hud') || request.kit !== 'text'
}

/**
 * A byte of VRAM holds two dots in SCREEN 5/7, four in SCREEN 6 and one in
 * SCREEN 8 (where it is a GRB332 value, not a palette index) — so a VDP fill
 * command takes a packed byte, never a colour number.
 */
function panelFill(mode: DisplayMode): { picture: string; window: string } {
  if (mode === 'sc8') return { picture: '0x03', window: '0x00' } // GRB332: dark blue, black
  if (mode === 'sc6') return { picture: 'COLOR_MERGE4(2)', window: 'COLOR_MERGE4(1)' }
  return { picture: 'COLOR_MERGE2(COLOR_DARK_BLUE)', window: 'COLOR_MERGE2(COLOR_BLACK)' }
}

/**
 * SCREEN 1-3 use sprite mode 1, where the colour sits in the attribute entry;
 * SCREEN 4 and up use mode 2, where it lives in a table of its own. Writing a
 * mode-1 attribute in mode 2 spills into the next sprite's X.
 */
function setSprite(mode: DisplayMode, index: string, x: string, y: string, color: string): string {
  const mode1 = mode === 'sc1' || mode === 'sc2' || mode === 'sc3'
  return mode1
    ? `VDP_SetSpriteSM1(${index}, ${x}, ${y}, 0, ${color})`
    : `VDP_SetSpriteExUniColor(${index}, ${x}, ${y}, 0, ${color})`
}

/** `Print_SetPosition` counts characters in text and tiled modes, dots in bitmap ones. */
function at(request: NewGameRequest, col: number, row: number): string {
  return isBitmapMode(request.displayMode) ? `${col * 8}, ${row * 8}` : `${col}, ${row}`
}

function selectedStates(request: NewGameRequest): Exclude<ScreenId, 'hud'>[] {
  const ids = request.screens.filter((id): id is Exclude<ScreenId, 'hud'> => id !== 'hud')
  if (!ids.includes('play')) ids.unshift('play')
  return ids
}

function nextAfter(request: NewGameRequest, from: ScreenId): string {
  if (from === 'title' && request.screens.includes('menu')) return 'State_Menu'
  if (from === 'title' && request.screens.includes('intro')) return 'State_Intro'
  if (from === 'menu' || from === 'intro' || from === 'attract' || from === 'password' || from === 'stage-select') {
    return 'State_Play'
  }
  if (from === 'gameover' || from === 'victory') {
    return request.screens.includes('credits') ? 'State_Credits' : 'State_Play'
  }
  if (from === 'credits') {
    return request.screens.includes('title') ? 'State_Title' : 'State_Play'
  }
  return 'State_Play'
}

function stateDecl(id: Exclude<ScreenId, 'hud'>): string {
  return id === 'play' ? 'bool State_Play(void);' : `bool ${STATE_FUN[id]}(void);`
}

export function emitGameH(request: NewGameRequest): string {
  // State_Play sets the level up and hands over; the loop is a state of its own
  // so Pause can come back to it without re-initializing everything. Without the
  // state module there are no states at all — main() just calls Play_Init().
  const decls = usesState(request)
    ? [...selectedStates(request).map(stateDecl), 'bool State_Resume(void);']
    : []
  return `// Shared vocabulary for the ${request.kit} kit.
#pragma once

#include "msxgl.h"
${usesState(request) ? '#include "game/state.h"\n' : ''}
#define GAME_VDP_MODE ${vdpModeMacro(request.displayMode)}
${
  isSc3Mode(request.displayMode)
    ? `// Title, menu and credits run in SCREEN 1, because MSXgl's Print module is an
// empty case in MULTICOLOR — and worse, the pattern table it would load a font
// into *is* the picture there. Play_Init() switches to SCREEN 3; every state
// that comes back to play goes through State_Play, which re-initializes.
#define GAME_TEXT_VDP_MODE ${vdpModeMacro(textModeMacroFor(request.displayMode))}
`
    : `#define GAME_TEXT_VDP_MODE GAME_VDP_MODE
`
}
// Installs the font this display mode needs (see ${GAME_SOURCE_DIR}/screens.c).
void Game_SetFont(void);

void Play_Init(void);
${decls.join('\n')}
`
}

export function emitMainC(request: NewGameRequest): string {
  const start = firstState(request.screens)
  const startFun = start === 'play' ? 'State_Play' : STATE_FUN[start as Exclude<ScreenId, 'hud' | 'play'>]
  if (!usesState(request)) {
    return `#include "msxgl.h"
#include "${GAME_SOURCE_DIR}/game.h"

void main()
{
	BIOS_SetKeyClick(FALSE);
	VDP_SetMode(GAME_VDP_MODE);
	VDP_ClearVRAM();
	Play_Init();
	while (!Keyboard_IsKeyPressed(KEY_ESC))
	{
	}
}
`
  }
  return `#include "msxgl.h"
#include "${GAME_SOURCE_DIR}/game.h"

void main()
{
	BIOS_SetKeyClick(FALSE);
	Game_SetState(${startFun});
	Game_Start(GAME_TEXT_VDP_MODE, FALSE);
}
`
}

function waitSpace(): string {
  return `// Waits for a fresh press, so the key that got us here doesn't skip this screen.
static void WaitSpace(void)
{
	while (Keyboard_IsKeyPressed(KEY_SPACE))
		Halt();
	while (!Keyboard_IsKeyPressed(KEY_SPACE))
		Halt();
}
`
}

function stubState(request: NewGameRequest, name: string, title: string, next: string): string {
  return `bool ${name}(void)
{
	VDP_SetMode(GAME_TEXT_VDP_MODE);
	VDP_ClearVRAM();
	Game_SetFont();
	Print_SetPosition(${at(request, 1, 1)});
	Print_DrawText(${cString(title)});
	Print_SetPosition(${at(request, 1, 3)});
	Print_DrawText("SPACE to continue");
	WaitSpace();
	Game_SetState(${next});
	return FALSE;
}
`
}

/**
 * What `Play_Init()` does before drawing. In SCREEN 3 the pattern table is the
 * picture, so loading a font into it would write glyphs across the playfield —
 * the text screens have their own SCREEN 1 pass for that.
 */
function playFont(request: NewGameRequest): string {
  return isSc3Mode(request.displayMode) ? '' : '\tGame_SetFont();\n'
}

function setFont(request: NewGameRequest): string {
  return isBitmapMode(request.displayMode)
    ? `void Game_SetFont(void)
{
	// Bitmap modes have no pattern table, so the BIOS font is not an option.
	Print_SetBitmapFont(${FONT_SYMBOL});
}
`
    : `void Game_SetFont(void)
{
	// The BIOS font, loaded from pattern 1 up. Tile patterns 0-7 are reloaded
	// after it, which is why Play_Init() calls this first.
	Print_SetTextFont(PRINT_DEFAULT_FONT, 1);
}
`
}

export function emitScreensC(request: NewGameRequest): string {
  const lines = attributionLines(request)
  const comments = [
    '// Required attributions — keep these if you ship the game.',
    ...lines.map((line) => `//   ${line}`)
  ].join('\n')

  const states: string[] = []
  if (request.screens.includes('title')) {
    states.push(stubState(request, 'State_Title', request.name, nextAfter(request, 'title')))
  }
  if (request.screens.includes('menu')) {
    states.push(stubState(request, 'State_Menu', 'MENU  Start / Options', nextAfter(request, 'menu')))
  }
  if (request.screens.includes('options')) {
    states.push(stubState(request, 'State_Options', 'OPTIONS', 'State_Play'))
  }
  if (request.screens.includes('intro')) {
    states.push(stubState(request, 'State_Intro', 'INTRO', nextAfter(request, 'intro')))
  }
  if (request.screens.includes('pause')) {
    // Back to State_Play, not State_Resume: the level is redrawn rather than
    // left with "PAUSED" printed over it.
    states.push(stubState(request, 'State_Pause', 'PAUSED', 'State_Play'))
  }
  if (request.screens.includes('gameover')) {
    states.push(stubState(request, 'State_GameOver', 'GAME OVER', nextAfter(request, 'gameover')))
  }
  if (request.screens.includes('victory')) {
    states.push(stubState(request, 'State_Victory', 'VICTORY', nextAfter(request, 'victory')))
  }
  if (request.screens.includes('attract')) {
    states.push(stubState(request, 'State_Attract', request.name, nextAfter(request, 'attract')))
  }
  if (request.screens.includes('password')) {
    states.push(stubState(request, 'State_Password', 'PASSWORD', nextAfter(request, 'password')))
  }
  if (request.screens.includes('stage-select')) {
    states.push(stubState(request, 'State_StageSelect', 'STAGE SELECT', nextAfter(request, 'stage-select')))
  }
  if (request.screens.includes('credits')) {
    // Wrapped, because "Powered by MSXgl + MSXtk…" is twice a SCREEN 2 line and
    // Print_DrawText runs straight off the right edge into the next row.
    const wrapped = lines.flatMap((line) => wrapText(line, displayColumns(request.displayMode)))
    const prints = [
      `	Print_SetPosition(${at(request, 1, 1)});`,
      '	Print_DrawText("CREDITS");',
      `	Print_SetPosition(${at(request, 1, 3)});`,
      '	Print_DrawText("Your name here");',
      ...wrapped.map(
        (line, i) => `	Print_SetPosition(${at(request, 0, 5 + i)});\n	Print_DrawText(${cString(line)});`
      )
    ].join('\n')
    states.push(`bool State_Credits(void)
{
	VDP_SetMode(GAME_VDP_MODE);
	VDP_ClearVRAM();
	Game_SetFont();
${prints}
	WaitSpace();
	Game_SetState(${nextAfter(request, 'credits')});
	return FALSE;
}
`)
  }

  const parts: string[] = [
    comments,
    '',
    `#include "${GAME_SOURCE_DIR}/game.h"`,
    ...(isBitmapMode(request.displayMode) ? [`#include "${FONT_HEADER}"`] : []),
    '',
    setFont(request)
  ]
  if (states.length) parts.push(waitSpace(), ...states)
  return parts.join('\n')
}

export function emitPlayC(request: NewGameRequest): string {
  if (request.kit === 'text' || (request.kit === 'vn' && isTextMode(request.displayMode))) {
    return emitTextPlay(request)
  }
  if (request.kit === 'vn') return emitVnPlay(request)
  if (request.kit === 'chunky') return emitChunkyPlay(request)
  if (isScrollKit(request.kit)) return emitScrollPlay(request)
  return emitPawnPlay(request)
}

/**
 * The SCREEN 3 chunky loop — the shape recent ZX Spectrum chunky-pixel games
 * (Twinlight, Yazzie Junior) build by hand, on the MSX1 that has it in hardware.
 *
 * The whole playfield is a 1536-byte RAM shadow of the framebuffer. Everything
 * is drawn there, and only the 8-byte column strips that changed are uploaded —
 * a full upload is about two thirds of a 50 Hz frame, one strip is under half a
 * percent. The page flip on top means a moving actor never shows half-drawn.
 *
 * Collision is reading the picture back (`_Get`): with no colour clash and no
 * name table in the way, "is this block the background colour" *is* the test,
 * which is why this genre suits the mode.
 *
 * Single screen, so there is no camera and nothing to clip. A SCREEN 3 game that
 * wants to scroll uses the name-table shape instead — the side-scroller kit on
 * SCREEN 3 does exactly that, with MSXgl's real `scroll` module.
 */
function emitChunkyPlay(request: NewGameRequest): string {
  return `#include "${GAME_SOURCE_DIR}/game.h"
#include "content/playfield.h"
#include "content/tiles.h"
#include "content/level_map.h"

// Chunky SCREEN 3 stub: a 64x48 playfield of 4x4 blocks, double buffered.
// No win condition — this is a place to start, not a game.

// Blocks per tile side, and how far the actor moves in a frame. Both are even
// because two blocks share a VRAM byte and the blitters copy bytes; 2 blocks is
// 8 dots, which is the horizontal step this mode gives you.
#define TILE G_LEVELMAP_CELL_W
#define STEP 2
// Tile 2 is the actor, tile 1 the ground, tile 0 the background. Colour 0 is the
// tileset's transparent index, so the actor is blitted through a mask.
#define ACTOR_TILE 2

// The playfield in RAM. 1536 bytes of the 16 KB an MSX1 ROM game gets, and the
// reason nothing here talks to VRAM until the flush.
static u8 g_Screen[G_PLAYFIELD_SIZE];
// What the actor is covering, so it can be put back before it moves.
static u8 g_Under[(TILE / 2) * TILE];
static u8 g_X, g_Y;

static void DrawLevel(void)
{
	u8 row;
	for (row = 0; row < G_LEVELMAP_H; ++row)
		g_LevelMap_DrawRow(g_Screen, g_Tiles_Tiles, g_LevelMap_Background, row, 0, row * TILE);
}

// Anything that is not the background colour is solid. That is the whole
// collision system: in a mode with no colour clash, the picture is the map.
static bool Blocked(u8 x, u8 y)
{
	if ((x + TILE > G_PLAYFIELD_W) || (y + TILE > G_PLAYFIELD_H))
		return TRUE;
	return g_Playfield_Get(g_Screen, x, y)
		|| g_Playfield_Get(g_Screen, x + TILE - 1, y)
		|| g_Playfield_Get(g_Screen, x, y + TILE - 1)
		|| g_Playfield_Get(g_Screen, x + TILE - 1, y + TILE - 1);
}

void Play_Init(void)
{
	g_Playfield_InitScreen();
	// The exported picture is the backdrop — draw it in res/play.screen.json and
	// it appears here. The level tiles go on top of it.
	g_Playfield_ToBuffer(g_Screen);
	DrawLevel();
	g_X = TILE;
	g_Y = TILE;
	g_Playfield_Save(g_Screen, g_Under, g_X, g_Y, TILE, TILE);
	g_Tiles_DrawTileMasked(g_Screen, ACTOR_TILE, g_X, g_Y);
	// Both pages, so the first flip does not reveal an empty one.
	g_Playfield_FlushAll(g_Screen);
	g_Playfield_FlushAll(g_Screen);
}

${playStates(
  request,
  `	u8 row = Keyboard_Read(8);
	u8 nx = g_X;
	u8 ny = g_Y;
	// Lift the actor first, so the collision test reads the real background and
	// the background it was covering is already back where it belongs.
	g_Playfield_Restore(g_Screen, g_Under, g_X, g_Y, TILE, TILE);
	if (IS_KEY_PRESSED(row, KEY_RIGHT)) nx += STEP;
	if (IS_KEY_PRESSED(row, KEY_LEFT) && (g_X >= STEP)) nx -= STEP;
	if (IS_KEY_PRESSED(row, KEY_DOWN)) ny += STEP;
	if (IS_KEY_PRESSED(row, KEY_UP) && (g_Y >= STEP)) ny -= STEP;
	if (!Blocked(nx, g_Y)) g_X = nx;
	if (!Blocked(g_X, ny)) g_Y = ny;
	g_Playfield_Save(g_Screen, g_Under, g_X, g_Y, TILE, TILE);
	g_Tiles_DrawTileMasked(g_Screen, ACTOR_TILE, g_X, g_Y);
	// The tileset's blitters cannot reach the screen's dirty flags — different
	// header — so say what moved. Without this the actor's new strips are never
	// uploaded and it smears whenever it crosses a byte column.
	g_Playfield_Mark(g_X, g_Y, TILE, TILE);
	// Uploads only the strips that changed, waits for the interrupt, flips.
	g_Playfield_Flush(g_Screen);
`
)}`
}

/** The HUD screen is a line of status text over the play field, drawn once. */
function hudPrint(request: NewGameRequest): string {
  if (!request.screens.includes('hud')) return ''
  return `	Print_SetPosition(${at(request, 0, 0)});
	Print_DrawText("SCORE 000000  LIVES 3");
`
}

/** State_Play sets up, State_Resume runs the frame. `body` is the frame. */
function playStates(request: NewGameRequest, body: string): string {
  const pause = request.screens.includes('pause')
    ? `	if (Keyboard_IsKeyPressed(KEY_ESC))
	{
		Game_SetState(State_Pause);
		return FALSE;
	}
`
    : ''
  return `bool State_Play(void)
{
	Play_Init();
	Game_SetState(State_Resume);
	return FALSE; // same frame: hand straight over to the loop
}

bool State_Resume(void)
{
${body}${pause}	return TRUE; // frame finished
}
`
}

function emitTextPlay(request: NewGameRequest): string {
  const init = `#include "${GAME_SOURCE_DIR}/game.h"

void Play_Init(void)
{
	VDP_SetMode(GAME_VDP_MODE);
	VDP_ClearVRAM();
	Game_SetFont();
	Print_SetPosition(${at(request, 1, 1)});
	Print_DrawText(${cString(request.name)});
	Print_SetPosition(${at(request, 1, 3)});
	Print_DrawText("A text game. Replace this screen.");
${hudPrint(request)}}
`
  if (!usesState(request)) return init

  const toCredits = request.screens.includes('credits')
    ? `	if (Keyboard_IsKeyPressed(KEY_SPACE))
	{
		Game_SetState(State_Credits);
		return FALSE;
	}
`
    : ''
  return `${init}
${playStates(request, toCredits)}`
}

function emitVnPlay(request: NewGameRequest): string {
  const tiled = isTiledMode(request.displayMode)
  const includes = tiled
    ? `#include "content/scene_tiles.h"
#include "content/scene_map.h"
`
    : ''
  const picture = tiled
    ? `	VDP_LoadPattern_GM2(g_SceneTiles_Patterns, G_SCENETILES_PATTERNS_SIZE / 8, 0);
	VDP_LoadColor_GM2(g_SceneTiles_Colors, G_SCENETILES_COLORS_SIZE / 8, 0);
	VDP_WriteVRAM_16K(g_SceneMap_Background, g_ScreenLayoutLow, G_SCENEMAP_W * G_SCENEMAP_H);
`
    : `	// The scene: a filled panel until you draw one. A SCREEN ${request.displayMode.slice(2)} picture is
	// too big to sit in the 32 KB the mapper pages in at boot, so a real one
	// ships as a raw file placed on a segment boundary (see CLAUDE.md).
	// HMMV writes whole bytes, so the colour is packed to fill every dot in one.
	VDP_CommandHMMV(0, 0, ${displayColumns(request.displayMode) * 8}, 128, ${panelFill(request.displayMode).picture});
	VDP_CommandHMMV(0, 128, ${displayColumns(request.displayMode) * 8}, 84, ${panelFill(request.displayMode).window});
`

  return `#include "${GAME_SOURCE_DIR}/game.h"
${includes}
static const c8* g_Lines[] = {
	"Speaker",
	"The picture sits above this",
	"dialogue window. SPACE advances.",
};
static u8 g_Line;

void Play_Init(void)
{
	VDP_SetMode(GAME_VDP_MODE);
	VDP_ClearVRAM();
	Game_SetFont();
${picture}${hudPrint(request)}	g_Line = 0;
}

${playStates(
  request,
  `	Print_SetPosition(${at(request, 1, 18)});
	Print_DrawText(g_Lines[g_Line]);
	if (Keyboard_IsKeyPressed(KEY_SPACE))
	{
		while (Keyboard_IsKeyPressed(KEY_SPACE))
			Halt();
		g_Line++;
		if (g_Line >= numberof(g_Lines))
			g_Line = 0;
	}
`
)}`
}

/**
 * Platformer and top-down share every line but the input-to-movement step —
 * both are MSXgl's `s_game` pawn with physics, which is also why they need
 * `configPatches`' `PAWN_*` values.
 */
/**
 * Getting the tileset into the pattern table, which is not the same call twice.
 *
 * `VDP_LoadPattern_GM2`/`VDP_LoadColor_GM2` triple-write across GRAPHIC 2's
 * three 2 KB banks and touch a colour table — neither of which MULTICOLOR has.
 * There the tileset's own `_Upload()` writes its 8-byte patterns to 0x0000 and
 * that is the whole job: the colour *is* the pattern.
 */
function uploadPatterns(request: NewGameRequest): string {
  return isSc3Mode(request.displayMode)
    ? `	g_Tiles_Upload();
`
    : `	VDP_LoadPattern_GM2(g_Tiles_Patterns, G_TILES_PATTERNS_SIZE / 8, 0);
	VDP_LoadColor_GM2(g_Tiles_Colors, G_TILES_COLORS_SIZE / 8, 0);
`
}

/** The patterns, then the map straight into the name table — the same call in both modes. */
function uploadTilemap(request: NewGameRequest): string {
  return `${uploadPatterns(request)}	VDP_WriteVRAM_16K(g_LevelMap_Background, g_ScreenLayoutLow, G_LEVELMAP_W * G_LEVELMAP_H);
`
}

function emitPawnPlay(request: NewGameRequest): string {
  // SCREEN 3 counts here: a 2x2-block tile is one name-table entry, so the pawn's
  // tilemap collision reads the same layout bytes it does in SCREEN 2.
  const tiled = hasNameTable(request.displayMode)
  const jumps = request.kit === 'platformer'

  const includes = [
    `#include "${GAME_SOURCE_DIR}/game.h"`,
    '#include "game/pawn.h"',
    ...(tiled ? ['#include "content/tiles.h"', '#include "content/level_map.h"'] : []),
    '#include "content/player_sprites.h"'
  ].join('\n')

  // Without a tilemap on screen there is nothing to collide with, so the pawn
  // only meets the screen borders (PAWN_BORDER_BLOCK in msxgl_config.h).
  const collision = tiled
    ? `static bool PhysicsCollision(u8 tile)
{
	return tile != 0; // tile 0 is empty; everything else is solid
}
`
    : `static bool PhysicsCollision(u8 tile)
{
	tile;
	return FALSE; // no tilemap in a bitmap mode — borders only
}
`

  const drawLevel = tiled ? uploadTilemap(request) : ''

  const move = jumps
    ? `	g_DX = 0;
	g_DY = 0;
	if (IS_KEY_PRESSED(row, KEY_RIGHT)) g_DX = 2;
	if (IS_KEY_PRESSED(row, KEY_LEFT)) g_DX = -2;
	if (g_Jumping)
	{
		g_DY -= g_VelocityY / 4;
		g_VelocityY -= GRAVITY;
		if (g_VelocityY < -FORCE) g_VelocityY = -FORCE;
	}
	else if (IS_KEY_PRESSED(row, KEY_SPACE) || IS_KEY_PRESSED(row, KEY_UP))
	{
		g_Jumping = TRUE;
		g_VelocityY = FORCE;
	}
	else
	{
		g_DY = 2; // no ground under the feet? fall
	}
`
    : `	g_DX = 0;
	g_DY = 0;
	if (IS_KEY_PRESSED(row, KEY_RIGHT)) g_DX = 2;
	if (IS_KEY_PRESSED(row, KEY_LEFT)) g_DX = -2;
	if (IS_KEY_PRESSED(row, KEY_DOWN)) g_DY = 2;
	if (IS_KEY_PRESSED(row, KEY_UP)) g_DY = -2;
`

  const gravityState = jumps
    ? `static bool g_Jumping;
static i8 g_VelocityY;
`
    : ''
  const gravityDefines = jumps
    ? `#define FORCE   24
#define GRAVITY 1

`
    : ''
  const physicsEvent = jumps
    ? `static void PhysicsEvent(u8 event, u8 tile)
{
	tile;
	if (event == PAWN_PHYSICS_COL_DOWN || event == PAWN_PHYSICS_BORDER_DOWN)
	{
		g_Jumping = FALSE;
		g_VelocityY = 0;
	}
}
`
    : `static void PhysicsEvent(u8 event, u8 tile)
{
	event;
	tile;
}
`

  return `${includes}

// Playable stub adapted from MSXgl's s_game (pawn${jumps ? ' + gravity' : ', no gravity'}). No win condition.

${gravityDefines}static Pawn g_Player;
${gravityState}static i8 g_DX, g_DY;

static const Pawn_Sprite g_Layers[] = { { 0, 0, 0, COLOR_WHITE, 0 } };
static const Pawn_Frame g_Idle[] = { { 0, 8, NULL } };
static const Pawn_Action g_Actions[] = { { g_Idle, 1, TRUE, TRUE } };

${physicsEvent}
${collision}
void Play_Init(void)
{
	VDP_SetMode(GAME_VDP_MODE);
	VDP_ClearVRAM();
${playFont(request)}${drawLevel}	VDP_SetSpriteFlag(VDP_SPRITE_SIZE_16);
	VDP_LoadSpritePattern(g_PlayerSprites_Patterns, 0, G_PLAYERSPRITES_PATTERNS_SIZE / 8);
	VDP_DisableSpritesFrom(1);
${hudPrint(request)}	Pawn_Initialize(&g_Player, g_Layers, numberof(g_Layers), 0, g_Actions);
	Pawn_SetPosition(&g_Player, ${jumps ? '32, 32' : '112, 88'});
	Pawn_InitializePhysics(&g_Player, PhysicsEvent, PhysicsCollision, 16, 16);
${jumps ? '	g_Jumping = FALSE;\n	g_VelocityY = 0;\n' : ''}}

${playStates(
  request,
  `	u8 row = Keyboard_Read(8);
${move}	Pawn_SetMovement(&g_Player, g_DX, g_DY);
	Pawn_Update(&g_Player);
	Pawn_Draw(&g_Player);
`
)}`
}

function emitScrollPlay(request: NewGameRequest): string {
  const horiz = request.kit === 'side-scroll'
  if (!hasNameTable(request.displayMode)) {
    return `#include "${GAME_SOURCE_DIR}/game.h"
#include "content/player_sprites.h"

// Bitmap-mode scroll stub: MSXgl's scroll module scrolls a tilemap, so this
// only moves a sprite. Pick a tiled mode (SCREEN 1/2/4) for a real camera.

static u8 g_X = 80;
static u8 g_Y = 80;

void Play_Init(void)
{
	VDP_SetMode(GAME_VDP_MODE);
	VDP_ClearVRAM();
	Game_SetFont();
	VDP_SetSpriteFlag(VDP_SPRITE_SIZE_16);
	VDP_LoadSpritePattern(g_PlayerSprites_Patterns, 0, G_PLAYERSPRITES_PATTERNS_SIZE / 8);
	VDP_DisableSpritesFrom(1);
${hudPrint(request)}	g_X = 80;
	g_Y = 80;
}

${playStates(
  request,
  `	u8 row = Keyboard_Read(8);
${
  horiz
    ? `	if (IS_KEY_PRESSED(row, KEY_RIGHT)) g_X += 2;
	if (IS_KEY_PRESSED(row, KEY_LEFT)) g_X -= 2;
`
    : `	if (IS_KEY_PRESSED(row, KEY_DOWN)) g_Y += 2;
	if (IS_KEY_PRESSED(row, KEY_UP)) g_Y -= 2;
`
}	${setSprite(request.displayMode, '0', 'g_X', 'g_Y', 'COLOR_WHITE')};
`
)}`
  }
  return `#include "${GAME_SOURCE_DIR}/game.h"
#include "scroll.h"
#include "content/tiles.h"
#include "content/level_map.h"
#include "content/player_sprites.h"

// Scroll stub from MSXgl's s_scroll. One axis only, and the source map's size
// lives in msxgl_config.h as SCROLL_SRC_W/H — keep them in step with res/.

#define SPEED 1

// Sprite 0 can belong to the scroll module's mask (SCROLL_MASK), so the player
// takes whatever id Scroll_Initialize() hands back.
static u8 g_Sprite;

void Play_Init(void)
{
	VDP_SetMode(GAME_VDP_MODE);
	VDP_ClearVRAM();
${playFont(request)}${uploadPatterns(request)}	g_Sprite = Scroll_Initialize((u16)g_LevelMap_Background);
	VDP_SetSpriteFlag(VDP_SPRITE_SIZE_16);
	VDP_LoadSpritePattern(g_PlayerSprites_Patterns, 0, G_PLAYERSPRITES_PATTERNS_SIZE / 8);
	${setSprite(request.displayMode, 'g_Sprite', '120', '96', 'COLOR_WHITE')};
	VDP_DisableSpritesFrom(g_Sprite + 1);
${hudPrint(request)}}

${playStates(
  request,
  `	u8 row = Keyboard_Read(8);
${
  horiz
    ? `	if (IS_KEY_PRESSED(row, KEY_RIGHT)) Scroll_SetOffsetH(SPEED);
	if (IS_KEY_PRESSED(row, KEY_LEFT)) Scroll_SetOffsetH(-SPEED);
`
    : `	if (IS_KEY_PRESSED(row, KEY_DOWN)) Scroll_SetOffsetV(SPEED);
	if (IS_KEY_PRESSED(row, KEY_UP)) Scroll_SetOffsetV(-SPEED);
`
}	Scroll_Update();
`
)}`
}
