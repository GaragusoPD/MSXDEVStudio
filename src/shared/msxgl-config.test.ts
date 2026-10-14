import { describe, expect, it } from 'vitest'
import { MUSIC_CONFIG, musicSetup, musicSetupDone, patchConfigDefines, readConfigDefine } from './msxgl-config'

/** The audio block of MSXgl's `projects/template/msxgl_config.h`, as it ships. */
const TEMPLATE = `
#define PSG_CHIP					PSG_INTERNAL
#define PSG_ACCESS					PSG_INDIRECT
#define AYFX_BUFFER					AYFX_BUFFER_PT3
#define LVGM_USE_PSG				TRUE	// Add parser for PSG data
#define LVGM_USE_MSXMUSIC			TRUE	// Add parser for MSX-Music data
#define LVGM_USE_MSXAUDIO			TRUE	// Add parser for MSX-Audio data
#define LVGM_USE_SCC				TRUE	// Add parser for Konami SCC data
`

describe('readConfigDefine', () => {
  it('reads a value and ignores the trailing comment', () => {
    expect(readConfigDefine(TEMPLATE, 'LVGM_USE_SCC')).toBe('TRUE')
    expect(readConfigDefine(TEMPLATE, 'AYFX_BUFFER')).toBe('AYFX_BUFFER_PT3')
    expect(readConfigDefine(TEMPLATE, 'NOPE')).toBeNull()
  })
})

describe('musicSetup', () => {
  it('finds what the stock template needs changed for music with effects', () => {
    const setup = musicSetup(TEMPLATE, ['system', 'bios', 'vdp'])
    expect(setup.modules).toEqual(['psg', 'vgm/lvgm_player', 'ayfx/ayfx_player'])
    expect(setup.defines).toEqual({
      LVGM_USE_MSXMUSIC: 'FALSE',
      LVGM_USE_MSXAUDIO: 'FALSE',
      LVGM_USE_SCC: 'FALSE',
      AYFX_BUFFER: 'AYFX_BUFFER_DEFAULT'
    })
    expect(setup.missing).toEqual([])
    expect(musicSetupDone(setup)).toBe(false)
  })

  it('has nothing left to do once applied', () => {
    const patched = patchConfigDefines(TEMPLATE, musicSetup(TEMPLATE, []).defines)
    expect(patched).toContain('#define LVGM_USE_SCC				FALSE	// Add parser for Konami SCC data')
    const setup = musicSetup(patched, ['psg', 'vgm/lvgm_player', 'ayfx/ayfx_player'])
    expect(musicSetupDone(setup)).toBe(true)
    for (const [name, value] of Object.entries(MUSIC_CONFIG)) expect(readConfigDefine(patched, name)).toBe(value)
  })

  it('reports defines a hand-made config lacks, rather than inventing them', () => {
    expect(musicSetup('#define PSG_ACCESS PSG_INDIRECT\n', []).missing).toContain('AYFX_BUFFER')
  })
})
