/**
 * The music export's ready-made C (Spec 15), compiled and linked by the **real**
 * MSXgl together with an ayFX bank — the only check that catches the helper
 * calling an lVGM or PSG API that has changed, or a config switch that leaves
 * a module's symbols unresolved. Skipped when the checkout isn't there (see
 * `__fixtures__`).
 *
 * What it plays was checked separately in openMSX by logging the PSG registers
 * every frame (see CLAUDE.md for the method): 933 frames from boot matched
 * `stepPlayer`, across a song switch, a loop and three effects on channel C.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createMusicDoc } from '../../shared/msx/music'
import { defaultExport, renderResourceFiles, type ResourceDoc } from '../../shared/msx/resource'
import { createSfxDoc } from '../../shared/msx/sfx'
import { MUSIC_CONFIG, MUSIC_LIB_MODULES, patchConfigDefines } from '../../shared/msxgl-config'
import { REAL_MSXGL, hasMsxgl, scratchRoot } from './__fixtures__/msxgl'
import { buildScript } from './build'
import { resolveNodeBinary } from './project'

const NODE = hasMsxgl ? resolveNodeBinary(REAL_MSXGL) : null
const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function writeExport(root: string, resource: ResourceDoc, path: string): void {
  const block = { ...defaultExport(path), helpers: true }
  const files = renderResourceFiles(resource, path, block)
  writeFileSync(join(root, block.out), files.header ?? '')
  writeFileSync(join(root, block.out.replace(/\.h$/, '.c')), files.source ?? '')
}

/** A template project patched by "Set up project", playing the demo song with an effect over it. */
function build(config: Record<string, string>): string {
  const root = mkdtempSync(join(scratchRoot(), 'music-'))
  dirs.push(root)
  mkdirSync(join(root, 'content'))
  const template = join(REAL_MSXGL, 'projects/template/msxgl_config.h')
  writeFileSync(join(root, 'msxgl_config.h'), patchConfigDefines(readFileSync(template, 'utf-8'), config))
  writeExport(root, { kind: 'music', doc: createMusicDoc() }, 'res/music.music.json')
  writeExport(root, { kind: 'sfx', doc: createSfxDoc() }, 'res/sfx.sfx.json')
  writeFileSync(
    join(root, 'game.c'),
    [
      '#include "msxgl.h"',
      '#include "ayfx/ayfx_player.h"',
      '#include "content/music.h"',
      '#include "content/sfx.h"',
      'void main()',
      '{',
      '\tu8 frame = 0;',
      '\tayFX_InitBank((void*)g_Sfx);',
      '\tayFX_SetChannel(PSG_CHANNEL_C);',
      '\tg_Music_Play(g_Music_Theme, TRUE);',
      '\twhile (1)',
      '\t{',
      '\t\tHalt();',
      '\t\tg_Music_Decode();',
      '\t\tif (++frame == 0)',
      '\t\t\tayFX_PlayBank(0, 0);',
      '\t\tayFX_Update();',
      '\t\tPSG_Apply();',
      '\t\tif (frame == 200) { g_Music_Pause(); g_Music_Resume(); }',
      '\t\tif (frame == 250) { g_Music_Stop(); g_Music_Play(g_Music_Theme, FALSE); }',
      '\t}',
      '}',
      ''
    ].join('\n')
  )
  const modules = ['system', 'bios', 'vdp', 'print', 'input', 'memory', ...MUSIC_LIB_MODULES]
  writeFileSync(
    join(root, 'project_config.js'),
    [
      'ProjName = "game";',
      'ProjModules = [ ProjName, "content/music", "content/sfx" ];',
      `LibModules = [ ${modules.map((name) => JSON.stringify(name)).join(', ')} ];`,
      'Machine = "1";',
      'Target = "ROM_32K";',
      ''
    ].join('\n')
  )
  try {
    return execFileSync(NODE as string, [buildScript(REAL_MSXGL), 'all'], { cwd: root, encoding: 'utf-8', stdio: 'pipe' })
  } catch (error) {
    const spawned = error as { stdout?: string; stderr?: string }
    return `${spawned.stdout ?? ''}\n${spawned.stderr ?? ''}`
  }
}

describe.runIf(hasMsxgl && NODE !== null)('music with sound effects builds against real MSXgl', () => {
  it('links with the config "Set up project" writes', () => {
    const output = build({ ...MUSIC_CONFIG })
    expect(output).not.toMatch(/\bError:/i)
    expect(output).not.toMatch(/Undefined Global/)
    expect(output).toMatch(/Success/)
  }, 400_000)

  it('fails to link on the template\'s PT3 ayFX buffer — the change the setup exists to make', () => {
    const output = build({ ...MUSIC_CONFIG, AYFX_BUFFER: 'AYFX_BUFFER_PT3' })
    expect(output).toMatch(/Undefined Global _PT3_Regs/)
  }, 400_000)
})
