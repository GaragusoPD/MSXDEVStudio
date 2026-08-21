/**
 * Game-kit recipes: legal machine/mode combinations, ROM budget, library
 * modules, attributions. Pure — the wizard, the scaffolder and Vitest all
 * import this. Disk work lives in `main/services/game-kit.ts`.
 */

import type { Machine } from './msxgl-consts'
import { defaultProject } from './msxproj'

/** Authored kit C (everything except `main.c`) lives here, parallel to `res/`. */
export const GAME_SOURCE_DIR = 'src'

export const GAME_KITS = [
  { id: 'text', title: 'Text', description: 'SCREEN 0 program. Print, optional menus.' },
  { id: 'platformer', title: 'Platformer', description: 'Walk, jump, gravity. From MSXgl’s game/pawn sample.' },
  { id: 'side-scroll', title: 'Side scroller', description: 'Hardware scroll on the X axis.' },
  { id: 'vert-scroll', title: 'Vertical scroller', description: 'Hardware scroll on the Y axis.' },
  { id: 'top-down', title: 'Top-down', description: 'Four-way walk, no gravity. Same pawn as the platformer.' },
  { id: 'vn', title: 'Visual novel', description: 'Picture on top, text below — not a pure console.' },
  {
    id: 'chunky',
    title: 'Chunky arcade',
    description:
      'SCREEN 3: a 64×48 playfield of 4×4 blocks with no colour clash, double buffered. Block-grid action on an MSX1.'
  }
] as const

export type GameKitId = (typeof GAME_KITS)[number]['id']

export type DisplayMode =
  | 'sc0w40'
  | 'sc0w80'
  | 'sc1'
  | 'sc2'
  | 'sc3'
  | 'sc4'
  | 'sc5'
  | 'sc6'
  | 'sc7'
  | 'sc8'

export type ScreenId =
  | 'title'
  | 'menu'
  | 'options'
  | 'intro'
  | 'play'
  | 'pause'
  | 'hud'
  | 'gameover'
  | 'victory'
  | 'credits'
  | 'attract'
  | 'password'
  | 'stage-select'

export type GameAudio = 'none' | 'ayfx'

export interface NewGameRequest {
  name: string
  location: string
  machine: Machine
  kit: GameKitId
  displayMode: DisplayMode
  screens: ScreenId[]
  audio: GameAudio
  target: string
  romSize: number | null
}

export interface SuggestedTarget {
  target: string
  romSize: number | null
  reason: string
}

const MSX1_GRAPHIC: DisplayMode[] = ['sc1', 'sc2', 'sc3']
const MSX2_GRAPHIC: DisplayMode[] = ['sc1', 'sc2', 'sc3', 'sc4', 'sc5', 'sc6', 'sc7', 'sc8']

const ACTION_KITS: readonly GameKitId[] = ['platformer', 'side-scroll', 'vert-scroll', 'top-down', 'chunky']

export function isMsx1(machine: string): boolean {
  return machine === '1'
}

export function isGraphicKit(kit: GameKitId): boolean {
  return kit !== 'text'
}

export function isTextMode(mode: DisplayMode): boolean {
  return mode === 'sc0w40' || mode === 'sc0w80'
}

export function isBitmapMode(mode: DisplayMode): mode is 'sc5' | 'sc6' | 'sc7' | 'sc8' {
  return mode === 'sc5' || mode === 'sc6' || mode === 'sc7' || mode === 'sc8'
}

/** Modes the tile editor can author (SCREEN 1/2/4). */
export function isTiledMode(mode: DisplayMode): mode is 'sc1' | 'sc2' | 'sc4' {
  return mode === 'sc1' || mode === 'sc2' || mode === 'sc4'
}

/**
 * SCREEN 3, which is none of the three above: not text, not a V9938 bitmap, and
 * not something the pattern tile editor can author — its "pixel" is a 4×4 block.
 *
 * Deliberately its own predicate rather than folded into `isBitmapMode`. That
 * one gates the V9938 branches — `VDP_CommandHMMV`, bitmap fonts, dot
 * coordinates — none of which exist on the MSX1 VDP this mode implies.
 */
export function isSc3Mode(mode: DisplayMode): mode is 'sc3' {
  return mode === 'sc3'
}

/**
 * Modes with a name table a map can be written into, so `VDP_WriteLayout_GM2`
 * draws the world and MSXgl's `scroll` module can drive a camera over it.
 *
 * SCREEN 3 qualifies: its name table is the same 32×24 as SCREEN 1's and
 * `scroll.c` is pure address arithmetic over the layout base. That is what lets
 * a SCREEN 3 scroll kit have a real camera rather than the bitmap stub.
 */
export function hasNameTable(mode: DisplayMode): boolean {
  return isTiledMode(mode) || isSc3Mode(mode)
}

/**
 * MSXgl's `Print` is an empty `case` in MULTICOLOR (`print.c`) and sets no
 * `ScreenWidth` — and worse, the pattern table it would write a font into *is*
 * the picture there. So a SCREEN 3 game runs its title, menu and credits in
 * SCREEN 1 and switches to SCREEN 3 for play, which is what real ones do.
 */
export function textModeMacroFor(mode: DisplayMode): DisplayMode {
  return isSc3Mode(mode) ? 'sc1' : mode
}

/** Characters per line. Bitmap modes count dots, but a glyph is still 8 wide. */
export function displayColumns(mode: DisplayMode): number {
  if (mode === 'sc0w40') return 40
  if (mode === 'sc0w80') return 80
  if (mode === 'sc6' || mode === 'sc7') return 64 // 512 dots across
  return 32
}

export function displayModesFor(kit: GameKitId, machine: Machine): DisplayMode[] {
  const msx1 = isMsx1(machine)
  if (kit === 'text') return msx1 ? ['sc0w40'] : ['sc0w40', 'sc0w80']
  // The chunky kit *is* SCREEN 3 — its whole loop is that framebuffer — and the
  // mode is MSX1 hardware, so every machine can run it.
  if (kit === 'chunky') return ['sc3']
  if (kit === 'vn') {
    // sc3 is excluded for the same reason sc1 is: picture-on-top/text-below needs
    // `Print`, which MULTICOLOR does not have.
    const graphic = MSX2_GRAPHIC.filter((m) => m !== 'sc1' && m !== 'sc3')
    return msx1 ? ['sc0w40', 'sc2'] : ['sc0w40', 'sc0w80', ...graphic]
  }
  return msx1 ? [...MSX1_GRAPHIC] : [...MSX2_GRAPHIC]
}

export function defaultDisplayMode(kit: GameKitId, machine: Machine): DisplayMode {
  if (kit === 'text') return 'sc0w40'
  if (kit === 'chunky') return 'sc3'
  if (kit === 'vn') return isMsx1(machine) ? 'sc2' : 'sc5'
  return isMsx1(machine) ? 'sc2' : 'sc4'
}

export function defaultScreens(kit: GameKitId): ScreenId[] {
  if (kit === 'text') return ['play', 'credits']
  return ['title', 'play', 'credits']
}

const ALWAYS_SCREENS: ScreenId[] = [
  'title',
  'menu',
  'options',
  'intro',
  'pause',
  'gameover',
  'victory',
  'credits'
]

export function availableScreens(kit: GameKitId): ScreenId[] {
  const extra: ScreenId[] = []
  if (kit !== 'vn') extra.push('attract')
  if (kit === 'platformer' || kit === 'top-down') extra.push('password')
  // No HUD for the chunky kit: a HUD is `Print` over the play field, and MSXgl's
  // Print does not work in MULTICOLOR — the pattern table it writes into is the
  // picture. Its other screens are fine; they run in SCREEN 1.
  if (ACTION_KITS.includes(kit)) extra.push('stage-select')
  if (ACTION_KITS.includes(kit) && kit !== 'chunky') extra.push('hud')
  return [...ALWAYS_SCREENS, ...extra]
}

export function suggestTarget(request: Pick<NewGameRequest, 'kit' | 'displayMode' | 'screens'>): SuggestedTarget {
  if (isBitmapMode(request.displayMode)) {
    return {
      target: 'ROM_ASCII8',
      romSize: 128,
      reason: `A SCREEN ${request.displayMode.slice(2)} picture will not fit in 32 KB.`
    }
  }
  return {
    target: 'ROM_32K',
    romSize: null,
    reason: request.kit === 'text'
      ? 'A text game with no bitmap screens fits in 32 KB.'
      : 'A tiled game with text screens fits in 32 KB.'
  }
}

export function attributionLines(request: Pick<NewGameRequest, 'audio'>): string[] {
  const lines = [
    'Built with MSXDEVStudio by P.D. Garaguso',
    "Powered by MSXgl + MSXtk by Guillaume 'Aoineko' Blanchard (CC BY-SA 4.0)",
    'Compiled with SDCC',
    'Not endorsed by the above.'
  ]
  if (request.audio === 'ayfx') lines.splice(3, 0, 'Sound: ayFX by Shiru')
  return lines
}

export function isPawnKit(kit: GameKitId): boolean {
  return kit === 'platformer' || kit === 'top-down'
}

export function isScrollKit(kit: GameKitId): boolean {
  return kit === 'side-scroll' || kit === 'vert-scroll'
}

/** The stub map a kit scaffolds. Also what `SCROLL_SRC_W/H` has to be told about. */
export function kitMapSize(kit: GameKitId): { width: number; height: number } {
  // SCREEN 3 is 64×48 blocks, so one screen is exactly 16×12 tiles of 4×4 blocks.
  // The chunky kit is single-screen on purpose — that is the genre, and it means
  // the playfield needs no camera and no clipping.
  if (kit === 'chunky') return { width: 16, height: 12 }
  if (kit === 'side-scroll') return { width: 64, height: 24 }
  if (kit === 'vert-scroll') return { width: 32, height: 48 }
  if (kit === 'vn') return { width: 32, height: 14 }
  return { width: 32, height: 24 }
}

export function kitLibModules(
  request: Pick<NewGameRequest, 'kit' | 'screens' | 'audio' | 'displayMode'>
): string[] {
  const modules = [...defaultProject('').libModules]
  const add = (name: string): void => {
    if (!modules.includes(name)) modules.push(name)
  }

  const stateful = request.screens.some((screen) => screen !== 'play' && screen !== 'hud')
  if (stateful || request.kit !== 'text') add('game/state')
  // The chunky loop keeps its playfield in RAM and copies frames into it.
  if (request.kit === 'chunky') add('memory')

  if (request.screens.includes('menu') || request.screens.includes('options')) add('game/menu')
  if (isPawnKit(request.kit)) {
    add('game/state')
    add('game/pawn')
  }
  if (isScrollKit(request.kit)) {
    add('game/state')
    // The scroll module scrolls a name table; a bitmap-mode kit moves a sprite
    // instead. SCREEN 3 has a name table, so it gets the real camera.
    if (hasNameTable(request.displayMode)) add('scroll')
  }
  if (request.audio === 'ayfx') {
    add('psg')
    add('ayfx/ayfx_player')
  }
  return modules
}

export function kitProjModules(): string[] {
  return ['main', `${GAME_SOURCE_DIR}/play`, `${GAME_SOURCE_DIR}/screens`]
}

export function vdpModeMacro(mode: DisplayMode): string {
  const macros: Record<DisplayMode, string> = {
    sc0w40: 'VDP_MODE_SCREEN0',
    sc0w80: 'VDP_MODE_SCREEN0_W80',
    sc1: 'VDP_MODE_SCREEN1',
    sc2: 'VDP_MODE_SCREEN2',
    sc3: 'VDP_MODE_SCREEN3',
    sc4: 'VDP_MODE_SCREEN4',
    sc5: 'VDP_MODE_SCREEN5',
    sc6: 'VDP_MODE_SCREEN6',
    sc7: 'VDP_MODE_SCREEN7',
    sc8: 'VDP_MODE_SCREEN8'
  }
  return macros[mode]
}

/**
 * `msxgl_config.h` edits a kit needs to actually link and run. The templates are
 * written for the blank hello world, so:
 *  - the pawn module's sprite effects pull in `SpriteFX_*`, which no kit links
 *    (and its run-time pattern loading wants per-frame data the stub has none of);
 *  - `template_msx2` reads the collision tilemap from **RAM**, but the stub's map
 *    is the one it uploaded to VRAM — the same source `s_game` uses;
 *  - `PAWN_BORDER_MAX_Y` is the MSX2 bitmap height (211), two rows below a tiled
 *    screen's floor;
 *  - `SCROLL_SRC_*` describes the sample's 128-wide map, not the one exported here.
 */
export function configPatches(
  request: Pick<NewGameRequest, 'kit' | 'displayMode'>
): Record<string, string> {
  const patches: Record<string, string> = {}

  // SCREEN 3 has two switches and no safe default for either.
  //
  //  - `VDP_USE_MODE_MC` has no engine-side default at all, and when it is FALSE
  //    `VDP_SetMode(VDP_MODE_SCREEN3)` is a **silent no-op**: the switch falls
  //    through, `VDP_GetMode()` still reports MULTICOLOR, and the machine sits in
  //    whatever mode it was in. The templates ship it TRUE; `projects/targets`
  //    ships it FALSE. Stating it is the only way to be sure.
  //  - `VDP_WriteLayout_GM2` is gated `#if (VDP_USE_MODE_G2 || VDP_USE_MODE_G3)`
  //    even though its body is mode-agnostic, so a name-table SCREEN 3 map needs
  //    G2 compiled in to have anything to call.
  if (isSc3Mode(request.displayMode)) {
    patches.VDP_USE_MODE_MC = 'TRUE'
    patches.VDP_USE_MODE_G2 = 'TRUE'
  }

  if (isPawnKit(request.kit)) {
    return {
      ...patches,
      PAWN_USE_RT_LOAD: 'FALSE',
      PAWN_USE_SPRT_FX: 'FALSE',
      PAWN_TILEMAP_SRC: 'PAWN_TILEMAP_SRC_VRAM',
      PAWN_BORDER_MAX_Y: '191'
    }
  }
  if (isScrollKit(request.kit) && hasNameTable(request.displayMode)) {
    const { width, height } = kitMapSize(request.kit)
    return {
      ...patches,
      [request.kit === 'side-scroll' ? 'SCROLL_VERTICAL' : 'SCROLL_HORIZONTAL']: 'FALSE',
      SCROLL_SRC_X: '0',
      SCROLL_SRC_Y: '0',
      SCROLL_SRC_W: String(width),
      SCROLL_SRC_H: String(height)
    }
  }
  return patches
}

export function firstState(screens: ScreenId[]): ScreenId {
  const order: ScreenId[] = ['title', 'menu', 'intro', 'play']
  return order.find((id) => screens.includes(id)) ?? 'play'
}
