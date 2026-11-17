import { describe, expect, it } from 'vitest'
import { musicHelperC } from '../../shared/msx/music'
import { normalizeSfx, sfxHelperC } from '../../shared/msx/sfx'
import { MUSIC_CONFIG } from '../../shared/msxgl-config'
import { normalizeProject } from '../../shared/msxproj'
import { normalizeMap } from '../../shared/msx/map'
import { normalizeWorld, worldHelperC } from '../../shared/msx/world'
import { agentGuideFiles } from './agent-guide'
import { buildReport } from './mcp'
import { conversionProblems } from './resources'

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

  it('walks a world through the calls its exporter really emits', () => {
    const text = guide('1')
    // A world whose one tileset animates, so every helper the guide names is emitted.
    const world = normalizeWorld({ cols: 1, rows: 1, cells: ['res/a.map.json'] })
    const tileset = { path: 'res/t.tiles.json', name: 'g_T', header: 'content/t.h', helpers: true, mode: 'sc2', count: 4, banked: false, animated: true }
    const rooms = new Map([['res/a.map.json', { doc: normalizeMap({ tileset: tileset.path }), tileset }]])
    const header = worldHelperC(world, rooms, 'g_Over', 'content/over.h').header.join('\n')
    for (const call of ['g_Over_RoomAt', 'g_Over_Neighbour', 'g_Over_RoomW', 'g_Over_RoomH', 'g_Over_TilesetOf', 'g_Over_RoomEntities', 'g_Over_DoorAt', 'g_Over_LoadTileset', 'g_Over_Animate', 'g_Over_DrawRoom']) {
      expect(text).toContain(`${call}(`)
      expect(header).toMatch(new RegExp(`\\b${call}\\(`))
    }
    // Every call the guide makes on the world is one of those.
    for (const [call] of text.matchAll(/\bg_Over_[A-Za-z]+(?=\()/g)) expect(header).toContain(`${call}(`)
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

  it('says which files are resources, that two may not share an output, and that a failed export is a Problem', () => {
    for (const machine of ['1', '2']) {
      const text = guide(machine)
      expect(text).toContain('Anything whose name starts with a dot is not a resource')
      expect(text).toContain('`.scratch/old.tiles.json`')
      expect(text).toContain('No two resources may write the same file')
      expect(text).toContain('A failed export is an error in the Problems panel')
      // ./build.sh is MSXgl's own script: it never runs the exporter.
      expect(text).toContain('`./build.sh` exports nothing')
    }
  })

  it('tells an agent that animated metas and animations need an export target of their own', () => {
    for (const machine of ['1', '2']) {
      const text = guide(machine)
      expect(text).toContain('An animated meta-tile needs an export target of its own')
      expect(text).toContain('an attached animation needs an export target of its own')
      expect(text).toContain('(`"format": "c"`)')
    }
  })

  it('describes the MCP resource tools as they now behave', () => {
    const text = guide('2')
    // A failed export does not fail MSXgl: the build result's first line says
    // so, and the guide quotes that line as buildReport writes it.
    const failed = conversionProblems([{ kind: 'resource', input: 'res/a.tiles.json', out: 'content/a.h', status: 'failed', message: 'x' }])
    const verdict = buildReport({ ok: true, code: 0, artifacts: [], problems: failed, message: null }, []).split('\n')[0]
    expect(text).toContain(`"${verdict.split(' — ')[0]}`)
    expect(text).toContain('comes back as an error')
    // A clash of output files is one of the problems read_resource reports, not only an export's.
    expect(text).not.toContain('show up only')
    expect(text).toContain('any other\n  resource writing its `out`) by the same code `export_resources` runs')
    // Mirrors refreshed, sibling keys kept, a new file's default export.
    expect(text).toContain("a\n  map's `metas` entries are rebuilt from each meta-tile and its attachment")
    expect(text).toContain("`tilesetReorderSeen` and a tileset's `reorderLog` come back")
    expect(text).toContain('`"export": null` means none')
    expect(text).toContain('Rewriting an existing map through\n`write_resource` keeps the stamp the file already has')
  })

  it('only offers screen compression where screens exist', () => {
    expect(guide('1')).toContain('Maps can be exported RLEp-packed')
    expect(guide('2')).toContain('Maps and screens can be exported RLEp-packed')
  })
})
