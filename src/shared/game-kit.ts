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
  { id: 'vn', title: 'Visual novel', description: 'Picture on top, text below — not a pure console.' }
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

const ACTION_KITS: readonly GameKitId[] = ['platformer', 'side-scroll', 'vert-scroll', 'top-down']

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
  if (kit === 'vn') {
    return msx1 ? ['sc0w40', 'sc2'] : ['sc0w40', 'sc0w80', ...MSX2_GRAPHIC.filter((m) => m !== 'sc1')]
  }
  return msx1 ? [...MSX1_GRAPHIC] : [...MSX2_GRAPHIC]
}

export function defaultDisplayMode(kit: GameKitId, machine: Machine): DisplayMode {
  if (kit === 'text') return 'sc0w40'
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
  if (ACTION_KITS.includes(kit)) extra.push('stage-select', 'hud')
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

  if (request.screens.includes('menu') || request.screens.includes('options')) add('game/menu')
  if (isPawnKit(request.kit)) {
    add('game/state')
    add('game/pawn')
  }
  if (isScrollKit(request.kit)) {
    add('game/state')
    // The scroll module scrolls a tilemap; a bitmap-mode kit moves a sprite instead.
    if (isTiledMode(request.displayMode)) add('scroll')
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
  if (isPawnKit(request.kit)) {
    return {
      PAWN_USE_RT_LOAD: 'FALSE',
      PAWN_USE_SPRT_FX: 'FALSE',
      PAWN_TILEMAP_SRC: 'PAWN_TILEMAP_SRC_VRAM',
      PAWN_BORDER_MAX_Y: '191'
    }
  }
  if (isScrollKit(request.kit) && isTiledMode(request.displayMode)) {
    const { width, height } = kitMapSize(request.kit)
    return {
      [request.kit === 'side-scroll' ? 'SCROLL_VERTICAL' : 'SCROLL_HORIZONTAL']: 'FALSE',
      SCROLL_SRC_X: '0',
      SCROLL_SRC_Y: '0',
      SCROLL_SRC_W: String(width),
      SCROLL_SRC_H: String(height)
    }
  }
  return {}
}

export function firstState(screens: ScreenId[]): ScreenId {
  const order: ScreenId[] = ['title', 'menu', 'intro', 'play']
  return order.find((id) => screens.includes(id)) ?? 'play'
}
