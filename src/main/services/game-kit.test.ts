import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GAME_SOURCE_DIR,
  defaultDisplayMode,
  defaultScreens,
  kitLibModules,
  kitProjModules,
  type NewGameRequest
} from '../../shared/game-kit'
import { createGameProject, patchConfigDefines } from './game-kit'

const tmpDirs: string[] = []
function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// The subset of the real templates `configPatches` rewrites, tabs and all.
const FAKE_CONFIG = [
  '#define PAWN_USE_RT_LOAD			TRUE',
  '#define PAWN_USE_SPRT_FX			TRUE',
  '#define PAWN_BORDER_MAX_Y			211',
  '#define PAWN_TILEMAP_SRC			PAWN_TILEMAP_SRC_RAM',
  '#define SCROLL_HORIZONTAL			TRUE',
  '#define SCROLL_VERTICAL				TRUE',
  '#define SCROLL_SRC_X				64',
  '#define SCROLL_SRC_Y				0',
  '#define SCROLL_SRC_W				128',
  '#define SCROLL_SRC_H				24',
  '#define GAME_USE_STATE				TRUE'
].join('\n')

function fakeMsxgl(): string {
  const root = makeTmpDir('msxgl-fake-')
  for (const dir of ['template', 'template_msx2']) {
    const folder = join(root, 'projects', dir)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'template.c'), 'void main() {}\n', 'utf-8')
    writeFileSync(join(folder, 'msxgl_config.h'), FAKE_CONFIG + '\n', 'utf-8')
  }
  return root
}

function request(partial: Partial<NewGameRequest> = {}): NewGameRequest {
  const kit = partial.kit ?? 'text'
  const machine = partial.machine ?? '1'
  return {
    name: partial.name ?? 'mygame',
    location: partial.location ?? makeTmpDir('game-out-'),
    machine,
    kit,
    displayMode: partial.displayMode ?? defaultDisplayMode(kit, machine),
    screens: partial.screens ?? defaultScreens(kit),
    audio: partial.audio ?? 'none',
    target: partial.target ?? 'ROM_32K',
    romSize: partial.romSize ?? null
  }
}

describe('patchConfigDefines', () => {
  it('replaces known #define values and refuses a missing name', () => {
    expect(patchConfigDefines(FAKE_CONFIG, { SCROLL_VERTICAL: 'FALSE' })).toContain(
      '#define SCROLL_VERTICAL				FALSE'
    )
    expect(() => patchConfigDefines(FAKE_CONFIG, { NOPE: '1' })).toThrow(/NOPE/)
  })
})

describe('createGameProject', () => {
  it('writes main.c at the root and kit C under src/, never the blank template', () => {
    const msxgl = fakeMsxgl()
    const opened = createGameProject(request({ kit: 'text' }), msxgl)
    expect(existsSync(join(opened.root, 'main.c'))).toBe(true)
    expect(existsSync(join(opened.root, GAME_SOURCE_DIR, 'game.h'))).toBe(true)
    expect(existsSync(join(opened.root, GAME_SOURCE_DIR, 'play.c'))).toBe(true)
    expect(existsSync(join(opened.root, GAME_SOURCE_DIR, 'screens.c'))).toBe(true)
    expect(readFileSync(join(opened.root, 'main.c'), 'utf-8')).not.toBe('void main() {}\n')
    expect(readFileSync(join(opened.root, 'main.c'), 'utf-8')).toContain('#include "src/game.h"')
    expect(opened.project.projModules).toEqual(kitProjModules())
    expect(opened.project.libModules).toEqual(kitLibModules(request({ kit: 'text' })))
  })

  it('always writes the license attributions as comments, even without a credits screen', () => {
    const opened = createGameProject(request({ kit: 'text', screens: ['play'] }), fakeMsxgl())
    const screens = readFileSync(join(opened.root, GAME_SOURCE_DIR, 'screens.c'), 'utf-8')
    expect(screens).toContain('Built with MSXDEVStudio by P.D. Garaguso')
    expect(screens).toContain("Guillaume 'Aoineko' Blanchard")
    expect(screens).toContain('Compiled with SDCC')
    expect(screens).not.toMatch(/GrafxKid/i)
    expect(screens).not.toContain('Print_DrawText("Built with MSXDEVStudio by P.D. Garaguso")')
  })

  it('prints the attributions when the credits screen is selected', () => {
    const opened = createGameProject(request({ kit: 'text', screens: ['play', 'credits'] }), fakeMsxgl())
    const screens = readFileSync(join(opened.root, GAME_SOURCE_DIR, 'screens.c'), 'utf-8')
    expect(screens).toContain('Print_DrawText("Built with MSXDEVStudio by P.D. Garaguso")')
    expect(screens).toContain('Your name here')
    expect(screens).toContain("Guillaume 'Aoineko' Blanchard")
    for (const line of screens.split('\n')) {
      const draw = /Print_DrawText\((.*)\);$/.exec(line)
      if (draw) expect(draw[1].startsWith('"') && draw[1].endsWith('"')).toBe(true)
    }
  })

  it('uses SCREEN 0/80 when that display mode is chosen', () => {
    const opened = createGameProject(
      request({ kit: 'text', machine: '2', displayMode: 'sc0w80' }),
      fakeMsxgl()
    )
    expect(readFileSync(join(opened.root, GAME_SOURCE_DIR, 'game.h'), 'utf-8')).toContain(
      'VDP_MODE_SCREEN0_W80'
    )
  })

  it('patches scroll axes and writes stub resources for a side scroller', () => {
    const opened = createGameProject(request({ kit: 'side-scroll', displayMode: 'sc2' }), fakeMsxgl())
    const config = readFileSync(join(opened.root, 'msxgl_config.h'), 'utf-8')
    expect(config).toContain('#define SCROLL_VERTICAL				FALSE')
    expect(config).toContain('#define SCROLL_HORIZONTAL			TRUE')
    // The scroll module reads the map through these, not through the export.
    expect(config).toContain('#define SCROLL_SRC_W				64')
    expect(config).toContain('#define SCROLL_SRC_X				0')
    expect(existsSync(join(opened.root, 'res', 'tiles.tiles.json'))).toBe(true)
    expect(existsSync(join(opened.root, 'res', 'level.map.json'))).toBe(true)
    expect(existsSync(join(opened.root, 'res', 'player.sprites.json'))).toBe(true)
    expect(existsSync(join(opened.root, 'content', 'tiles.h'))).toBe(true)
    expect(existsSync(join(opened.root, 'content', 'level_map.h'))).toBe(true)
    expect(existsSync(join(opened.root, 'content', 'player_sprites.h'))).toBe(true)
  })

  it('leaves a SCREEN 5 visual novel without a 27 KB blank picture in its ROM', () => {
    const opened = createGameProject(
      request({ kit: 'vn', machine: '2', displayMode: 'sc5', target: 'ROM_ASCII8', romSize: 128 }),
      fakeMsxgl()
    )
    // A bitmap picture does not fit in the 32 KB the mapper pages in at boot.
    expect(existsSync(join(opened.root, 'res', 'scene.screen.json'))).toBe(false)
    const play = readFileSync(join(opened.root, GAME_SOURCE_DIR, 'play.c'), 'utf-8')
    expect(play).toContain('dialogue')
    expect(play).toContain('VDP_CommandHMMV')
  })

  it('patches the pawn config so the kit links without the spritefx module', () => {
    const opened = createGameProject(request({ kit: 'platformer', displayMode: 'sc2' }), fakeMsxgl())
    const config = readFileSync(join(opened.root, 'msxgl_config.h'), 'utf-8')
    expect(config).toContain('#define PAWN_USE_SPRT_FX			FALSE')
    expect(config).toContain('#define PAWN_USE_RT_LOAD			FALSE')
    // The stub collides against the tilemap it uploaded to VRAM, like s_game.
    expect(config).toContain('#define PAWN_TILEMAP_SRC			PAWN_TILEMAP_SRC_VRAM')
    expect(config).toContain('#define PAWN_BORDER_MAX_Y			191')
  })

  it('sets the level up once, then loops — never re-initializing every frame', () => {
    const opened = createGameProject(request({ kit: 'platformer' }), fakeMsxgl())
    const play = readFileSync(join(opened.root, GAME_SOURCE_DIR, 'play.c'), 'utf-8')
    expect(play).toMatch(/bool State_Play\(void\)\s*\{\s*Play_Init\(\);\s*Game_SetState\(State_Resume\);/)
    expect(play).toContain('bool State_Resume(void)')
    expect(play).not.toContain('Play_Init();\n\tg_FromPause')
  })

  it('refuses a non-empty destination, same as createProject', () => {
    const msxgl = fakeMsxgl()
    const req = request({ name: 'once' })
    createGameProject(req, msxgl)
    expect(() => createGameProject(req, msxgl)).toThrow(/already exists/)
  })

  it('enters the play state by calling Play_Init', () => {
    const opened = createGameProject(request({ kit: 'platformer' }), fakeMsxgl())
    const play = readFileSync(join(opened.root, GAME_SOURCE_DIR, 'play.c'), 'utf-8')
    expect(play).toMatch(/State_Play[\s\S]*Play_Init/)
  })

  it('mentions src/play.c in the agent guide', () => {
    const opened = createGameProject(request({ kit: 'platformer' }), fakeMsxgl())
    const guide = readFileSync(join(opened.root, 'CLAUDE.md'), 'utf-8')
    expect(guide).toContain('src/play.c')
    expect(guide).toContain('src/screens.c')
    expect(guide).toContain('Built with MSXDEVStudio by P.D. Garaguso')
  })
})
