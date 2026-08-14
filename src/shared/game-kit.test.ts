import { describe, expect, it } from 'vitest'
import {
  GAME_SOURCE_DIR,
  attributionLines,
  configPatches,
  defaultDisplayMode,
  defaultScreens,
  displayModesFor,
  isGraphicKit,
  kitLibModules,
  kitMapSize,
  kitProjModules,
  suggestTarget,
  vdpModeMacro,
  type DisplayMode,
  type GameKitId,
  type NewGameRequest
} from './game-kit'

function req(partial: Partial<NewGameRequest> & Pick<NewGameRequest, 'kit'>): NewGameRequest {
  const machine = partial.machine ?? '1'
  const displayMode = partial.displayMode ?? defaultDisplayMode(partial.kit, machine)
  const screens = partial.screens ?? defaultScreens(partial.kit)
  return {
    name: 'mygame',
    location: '/tmp',
    machine,
    kit: partial.kit,
    displayMode,
    screens,
    audio: partial.audio ?? 'none',
    target: partial.target ?? 'ROM_32K',
    romSize: partial.romSize ?? null
  }
}

describe('displayModesFor', () => {
  it('offers SCREEN 0/40 on MSX1 and both 40 and 80 on MSX2 for the text kit', () => {
    expect(displayModesFor('text', '1')).toEqual(['sc0w40'])
    expect(displayModesFor('text', '2')).toEqual(['sc0w40', 'sc0w80'])
  })

  it('offers every graphic SCREEN the machine can do for action kits', () => {
    expect(displayModesFor('platformer', '1')).toEqual(['sc1', 'sc2', 'sc3'])
    expect(displayModesFor('side-scroll', '2')).toEqual([
      'sc1', 'sc2', 'sc3', 'sc4', 'sc5', 'sc6', 'sc7', 'sc8'
    ])
    expect(displayModesFor('vert-scroll', '2P')).toEqual(displayModesFor('platformer', '2'))
    expect(displayModesFor('top-down', '2')).toEqual(displayModesFor('platformer', '2'))
  })

  it('lets a visual novel pick a graphic split or drop to text-only', () => {
    expect(displayModesFor('vn', '1')).toEqual(['sc0w40', 'sc2'])
    expect(displayModesFor('vn', '2')[0]).toBe('sc0w40')
    expect(displayModesFor('vn', '2')).toContain('sc0w80')
    expect(displayModesFor('vn', '2')).toContain('sc5')
    expect(displayModesFor('vn', '2')).toContain('sc8')
    expect(displayModesFor('vn', '1')).not.toContain('sc5')
  })

  it('never offers SCREEN 0 on an action kit', () => {
    for (const kit of ['platformer', 'side-scroll', 'vert-scroll', 'top-down'] as const) {
      expect(displayModesFor(kit, '2').some((mode) => mode.startsWith('sc0'))).toBe(false)
    }
  })
})

describe('defaultDisplayMode', () => {
  it('picks a sensible default per kit and machine', () => {
    expect(defaultDisplayMode('text', '1')).toBe('sc0w40')
    expect(defaultDisplayMode('text', '2')).toBe('sc0w40')
    expect(defaultDisplayMode('platformer', '1')).toBe('sc2')
    expect(defaultDisplayMode('platformer', '2')).toBe('sc4')
    expect(defaultDisplayMode('vn', '1')).toBe('sc2')
    expect(defaultDisplayMode('vn', '2')).toBe('sc5')
  })
})

describe('suggestTarget', () => {
  it('keeps a text game in 32 KB', () => {
    expect(suggestTarget(req({ kit: 'text' }))).toEqual({
      target: 'ROM_32K',
      romSize: null,
      reason: 'A text game with no bitmap screens fits in 32 KB.'
    })
  })

  it('keeps a tiled platformer with text screens in 32 KB', () => {
    const result = suggestTarget(req({ kit: 'platformer', displayMode: 'sc2' }))
    expect(result.target).toBe('ROM_32K')
    expect(result.romSize).toBeNull()
  })

  it('bumps a SCREEN 5 game to a 128 KB mapped ROM', () => {
    const result = suggestTarget(req({ kit: 'platformer', machine: '2', displayMode: 'sc5' }))
    expect(result).toEqual({
      target: 'ROM_ASCII8',
      romSize: 128,
      reason: 'A SCREEN 5 picture will not fit in 32 KB.'
    })
  })

  it('bumps a visual novel on SCREEN 5 the same way', () => {
    const result = suggestTarget(req({ kit: 'vn', machine: '2', displayMode: 'sc5' }))
    expect(result.target).toBe('ROM_ASCII8')
    expect(result.romSize).toBe(128)
  })

  it('does not bump 32 KB just because ayFX is on', () => {
    expect(suggestTarget(req({ kit: 'platformer', audio: 'ayfx' })).target).toBe('ROM_32K')
  })
})

describe('attributionLines', () => {
  it('always names MSXDEVStudio, MSXgl and SDCC, and never GrafxKid', () => {
    const lines = attributionLines(req({ kit: 'text' }))
    expect(lines.join('\n')).toContain('Built with MSXDEVStudio by P.D. Garaguso')
    expect(lines.join('\n')).toContain("Guillaume 'Aoineko' Blanchard")
    expect(lines.join('\n')).toContain('CC BY-SA 4.0')
    expect(lines.join('\n')).toContain('Compiled with SDCC')
    expect(lines.join('\n')).toContain('Not endorsed by the above')
    expect(lines.join('\n')).not.toMatch(/GrafxKid/i)
  })

  it('adds the ayFX line only when that audio is selected', () => {
    expect(attributionLines(req({ kit: 'text' })).join('\n')).not.toContain('ayFX')
    expect(attributionLines(req({ kit: 'text', audio: 'ayfx' })).join('\n')).toContain('Sound: ayFX by Shiru')
  })
})

describe('kitLibModules / kitProjModules', () => {
  it('starts from the default engine set and adds what the kit needs', () => {
    const text = kitLibModules(req({ kit: 'text', screens: ['play', 'credits'] }))
    expect(text).toEqual(expect.arrayContaining(['system', 'bios', 'vdp', 'print', 'input', 'memory', 'game/state']))
    expect(text).not.toContain('game/pawn')

    const plat = kitLibModules(req({ kit: 'platformer' }))
    expect(plat).toEqual(expect.arrayContaining(['game/state', 'game/pawn']))

    const scroll = kitLibModules(req({ kit: 'side-scroll' }))
    expect(scroll).toContain('scroll')

    // The scroll module scrolls a tilemap; a bitmap mode has none to scroll.
    const bitmapScroll = kitLibModules(req({ kit: 'side-scroll', machine: '2', displayMode: 'sc5' }))
    expect(bitmapScroll).not.toContain('scroll')

    const withMenu = kitLibModules(req({ kit: 'text', screens: ['play', 'menu'] }))
    expect(withMenu).toContain('game/menu')

    const withAyfx = kitLibModules(req({ kit: 'platformer', audio: 'ayfx' }))
    expect(withAyfx).toEqual(expect.arrayContaining(['psg', 'ayfx/ayfx_player']))
  })

  it('compiles main plus the src/ kit files', () => {
    expect(kitProjModules()).toEqual(['main', `${GAME_SOURCE_DIR}/play`, `${GAME_SOURCE_DIR}/screens`])
  })
})

describe('configPatches', () => {
  it('turns off the pawn features no kit links, and collides against VRAM', () => {
    const patches = configPatches(req({ kit: 'platformer' }))
    expect(patches).toEqual({
      PAWN_USE_RT_LOAD: 'FALSE',
      PAWN_USE_SPRT_FX: 'FALSE',
      PAWN_TILEMAP_SRC: 'PAWN_TILEMAP_SRC_VRAM',
      PAWN_BORDER_MAX_Y: '191'
    })
    expect(configPatches(req({ kit: 'top-down' }))).toEqual(patches)
  })

  it('describes the exported map to the scroll module, one axis only', () => {
    const side = configPatches(req({ kit: 'side-scroll', displayMode: 'sc2' }))
    expect(side).toMatchObject({
      SCROLL_VERTICAL: 'FALSE',
      SCROLL_SRC_X: '0',
      SCROLL_SRC_W: String(kitMapSize('side-scroll').width),
      SCROLL_SRC_H: String(kitMapSize('side-scroll').height)
    })
    expect(side.SCROLL_HORIZONTAL).toBeUndefined()

    const vert = configPatches(req({ kit: 'vert-scroll', machine: '2', displayMode: 'sc4' }))
    expect(vert.SCROLL_HORIZONTAL).toBe('FALSE')
    expect(vert.SCROLL_SRC_H).toBe(String(kitMapSize('vert-scroll').height))
  })

  it('leaves a bitmap-mode kit alone — it drives no engine module', () => {
    expect(configPatches(req({ kit: 'side-scroll', machine: '2', displayMode: 'sc5' }))).toEqual({})
    expect(configPatches(req({ kit: 'text' }))).toEqual({})
    expect(configPatches(req({ kit: 'vn' }))).toEqual({})
  })
})

describe('vdpModeMacro', () => {
  const cases: [DisplayMode, string][] = [
    ['sc0w40', 'VDP_MODE_SCREEN0'],
    ['sc0w80', 'VDP_MODE_SCREEN0_W80'],
    ['sc1', 'VDP_MODE_SCREEN1'],
    ['sc2', 'VDP_MODE_SCREEN2'],
    ['sc3', 'VDP_MODE_SCREEN3'],
    ['sc4', 'VDP_MODE_SCREEN4'],
    ['sc5', 'VDP_MODE_SCREEN5'],
    ['sc6', 'VDP_MODE_SCREEN6'],
    ['sc7', 'VDP_MODE_SCREEN7'],
    ['sc8', 'VDP_MODE_SCREEN8']
  ]
  it.each(cases)('%s → %s', (mode, macro) => {
    expect(vdpModeMacro(mode)).toBe(macro)
  })
})

describe('isGraphicKit', () => {
  it('treats text as the only non-graphic kit', () => {
    expect(isGraphicKit('text')).toBe(false)
    for (const kit of ['platformer', 'side-scroll', 'vert-scroll', 'top-down', 'vn'] as GameKitId[]) {
      expect(isGraphicKit(kit)).toBe(true)
    }
  })
})
