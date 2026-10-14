import { describe, expect, it } from 'vitest'
import { musicHelperC } from '../../shared/msx/music'
import { normalizeSfx, sfxHelperC } from '../../shared/msx/sfx'
import { MUSIC_CONFIG } from '../../shared/msxgl-config'
import { normalizeProject } from '../../shared/msxproj'
import { agentGuideFiles } from './agent-guide'

const guide = (machine: string): string =>
  agentGuideFiles(normalizeProject({ name: 'mygame', machine, target: 'ROM_32K' }, 'mygame'), '/home/me/MSXgl')[0]
    .content

describe('agentGuideFiles', () => {
  it('writes the same guide under both names', () => {
    const files = agentGuideFiles(normalizeProject({ name: 'mygame', machine: '2' }, 'mygame'), '/home/me/MSXgl')
    expect(files.map((f) => f.name)).toEqual(['CLAUDE.md', 'AGENTS.md'])
    expect(files[0].content).toBe(files[1].content)
  })

  it('plays music and effects through the calls the exporter really emits, in the order that works', () => {
    const text = guide('1')
    const header = [...musicHelperC('g_Music', true).header, ...sfxHelperC(normalizeSfx({}), 'g_Sfx').header].join('\n')
    const calls = [
      'g_Music_Play', 'g_Music_Update', 'g_Music_Decode', 'g_Music_Pause', 'g_Music_Resume', 'g_Music_Stop',
      'g_Music_FadeOut', 'g_Music_IsPlaying', 'g_Music_PlayJingle', 'g_Music_IsJingle', 'g_Sfx_Init', 'g_Sfx_Play', 'g_Sfx_PlayPriority', 'g_Sfx_Stop',
      'g_Sfx_IsPlaying', 'g_Sfx_Update'
    ]
    for (const call of calls) {
      expect(text).toContain(call)
      expect(header).toMatch(new RegExp(`\\b${call}\\(`))
    }
    // The hand-rolled order, for a game that needs one: song, effect, PSG.
    const decode = text.indexOf('g_Music_Decode(); ayFX_Update(); PSG_Apply();')
    expect(decode).toBeGreaterThan(0)
    // The config the template gets wrong for this, by name and value.
    for (const [name, value] of Object.entries(MUSIC_CONFIG)) {
      if (name === 'PSG_ACCESS' || name === 'LVGM_USE_PSG') continue // template defaults, already right
      expect(text).toContain(name)
      expect(text).toContain(value)
    }
  })

  it('states the project facts', () => {
    const text = guide('2')
    expect(text).toContain('# mygame')
    expect(text).toContain('/home/me/MSXgl')
    expect(text).toContain('mygame.msxproj')
    expect(text).toContain('ROM_32K')
  })

  it('offers the bitmap toolbox only where the hardware has it', () => {
    expect(guide('2')).toContain('g_MyTiles_Upload(256);')
    expect(guide('2')).toContain('g_Hero_Restore')
    expect(guide('1')).not.toContain('VDP_CommandHMMC')
    expect(guide('1')).not.toContain('_DrawRowOver')
    expect(guide('2')).toContain('g_Stage_DrawRowOver')
    expect(guide('1')).toContain('This project is MSX1')
  })

  it('hands MSX1 the 14-bit VRAM calls', () => {
    expect(guide('1')).toContain('VDP_WriteVRAM_16K')
    expect(guide('1')).not.toContain('g_ScreenLayoutHigh, 32 * 24')
    expect(guide('2')).toContain('g_ScreenLayoutHigh, 32 * 24')
  })

  it('animates the pattern, not the map', () => {
    for (const machine of ['1', '2']) {
      expect(guide(machine)).toContain('VDP_LoadPattern_GM2(g_MyTiles_Patterns + pose * 8, 1, slot);')
    }
  })

  it('copies a pose\'s colours along with its pattern', () => {
    // SCREEN 2/4 keep a tile's colours in a table of their own: copying only the
    // pattern draws the new pose's shape in the old pose's colours.
    for (const machine of ['1', '2']) {
      const text = guide(machine)
      expect(text).toContain('VDP_LoadColor_GM2(g_MyTiles_Colors + pose * 8, 1, slot);')
      expect(text).toContain('VDP_LoadBankColor_GM2(g_MyTiles_Bank0_Colors + (base + step) * 8, 1, 0, base);')
    }
    expect(guide('1')).toContain('VDP_WriteVRAM_16K(g_MyTiles_Patterns + pose * 8, g_ScreenPatternLow + slot * 8, 8);')
    expect(guide('2')).toContain('g_ScreenPatternHigh, 8);')
  })

  it('leads animation with the attached resource and its generated calls', () => {
    for (const machine of ['1', '2']) {
      const text = guide(machine)
      expect(text).toContain('`.anim-tiles.json`')
      expect(text).toContain('g_MyTiles_AnimReset();')
      expect(text).toContain('g_MyTiles_Animate();')
      expect(text).toContain('g_MyTiles_AnimRestart(G_MYTILES_ANIM_DOOR);')
      expect(text).toContain('g_MyTiles_AnimGetFrame(G_MYTILES_ANIM_DOOR)')
    }
  })

  it('follows the machine into the right sprite mode', () => {
    expect(guide('1')).toContain('VDP_SetSpriteSM1')
    expect(guide('1')).not.toContain('VDP_SetSpriteExMultiColor')
    expect(guide('2')).toContain('VDP_SetSpriteExMultiColor')
    expect(guide('2')).toContain('CC bit')
  })

  it('warns a dual-machine project that mode 2 is not everywhere', () => {
    expect(guide('12')).toContain('which includes MSX1')
    expect(guide('2')).not.toContain('which includes MSX1')
  })

  it('only offers screen compression where screens exist', () => {
    expect(guide('1')).toContain('Maps can be exported RLEp-packed')
    expect(guide('2')).toContain('Maps and screens can be exported RLEp-packed')
  })
})
