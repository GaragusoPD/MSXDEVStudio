import { describe, expect, it } from 'vitest'
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
      expect(guide(machine)).toContain('VDP_LoadPattern_GM2(g_MyTiles_Patterns +')
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
