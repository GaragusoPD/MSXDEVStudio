/**
 * The music export's ready-made C (Spec 15), compiled and linked by the **real**
 * MSXgl together with an ayFX bank — the only check that catches the helper
 * calling an lVGM or PSG API that has changed, or a config switch that leaves
 * a module's symbols unresolved. Skipped when the checkout isn't there (see
 * `__fixtures__`).
 *
 * What it plays was checked separately in openMSX by logging the PSG registers
 * every frame (see CLAUDE.md for the method), against `stepPlayer`: 933 frames
 * across a song switch, a loop and three effects on channel C; then 695 more
 * through the helpers — priorities (a coin refused under a death cry),
 * `g_Sfx_Stop`, a fade-out to silence and `g_Music_Play` after it. Jingles:
 * 720 frames sampled at each `g_Music_Update` entry (a breakpoint, so no frame
 * is caught mid-update), identical to a statement-by-statement model of the
 * helper and, up to the first pause, to `stepPlayer` — a jingle over the song
 * with an effect over the jingle, one over a fade-out (the fade goes on after),
 * one replacing another, one over a paused song (still paused after, until
 * `_Resume`), one after `_Stop` (silence after) and one over a song played once.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createMusicDoc } from '../../shared/msx/music'
import { defaultExport, renderResourceFiles, type ResourceDoc } from '../../shared/msx/resource'
import { normalizeSfx } from '../../shared/msx/sfx'
import { MUSIC_CONFIG, patchConfigDefines } from '../../shared/msxgl-config'
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

interface Game {
  /** Which banks the project has. */
  music: boolean
  effects: boolean
  /** The body of `main()`. */
  code: string[]
  config?: Record<string, string>
}

/** A template project, set up the way "Set up project" leaves it, around `game.code`. */
function build(game: Game): string {
  const root = mkdtempSync(join(scratchRoot(), 'music-'))
  dirs.push(root)
  mkdirSync(join(root, 'content'))
  const template = join(REAL_MSXGL, 'projects/template/msxgl_config.h')
  writeFileSync(join(root, 'msxgl_config.h'), patchConfigDefines(readFileSync(template, 'utf-8'), game.config ?? { ...MUSIC_CONFIG }))
  const modules = ['system', 'bios', 'vdp', 'print', 'input', 'memory', 'psg']
  const projModules = ['ProjName']
  const includes = ['#include "msxgl.h"']
  if (game.music) {
    const doc = createMusicDoc()
    doc.effects = game.effects ? 'res/sfx.sfx.json' : null
    writeExport(root, { kind: 'music', doc }, 'res/music.music.json')
    modules.push('vgm/lvgm_player')
    projModules.push('"content/music"')
    includes.push('#include "content/music.h"')
  }
  if (game.effects) {
    const doc = normalizeSfx({ effects: [{ name: 'coin', priority: 9 }, { name: 'death', priority: 0 }] })
    writeExport(root, { kind: 'sfx', doc }, 'res/sfx.sfx.json')
    modules.push('ayfx/ayfx_player')
    projModules.push('"content/sfx"')
    includes.push('#include "content/sfx.h"')
  }
  writeFileSync(join(root, 'game.c'), [...includes, 'void main()', '{', ...game.code.map((line) => `\t${line}`), '}', ''].join('\n'))
  writeFileSync(
    join(root, 'project_config.js'),
    [
      'ProjName = "game";',
      `ProjModules = [ ${projModules.join(', ')} ];`,
      `LibModules = [ ${modules.map((name) => JSON.stringify(name)).join(', ')} ];`,
      'Machine = "1";',
      'Target = "ROM_32K";',
      ''
    ].join('\n')
  )
  // Both streams, pass or fail: a compiler warning is only worth checking for if it can be seen.
  const run = spawnSync(NODE as string, [buildScript(REAL_MSXGL), 'all'], { cwd: root, encoding: 'utf-8' })
  return `${run.stdout ?? ''}\n${run.stderr ?? ''}`
}

/** Sanity check on the check: a warning in generated code is reported in a form the regex below sees. */
function expectWarningsVisible(output: string): void {
  expect(output).toMatch(/game\.c:\d+: warning/)
}

function expectClean(output: string): void {
  expect(output).not.toMatch(/\bError:/i)
  expect(output).not.toMatch(/Undefined Global/)
  // The helpers themselves compile without a single warning.
  expect(output).not.toMatch(/content\/(music|sfx)\.c:\d+: warning/)
  expect(output).toMatch(/Success/)
}

/** Every call the two helper sets offer, so a renamed engine API fails here. */
const MUSIC_WITH_EFFECTS = [
  'u8 frame = 0;',
  'g_Sfx_Init();',
  'g_Music_Play(g_Music_Theme, TRUE);',
  'while (1)',
  '{',
  '\tHalt();',
  '\tg_Music_Update();',
  '\tif (++frame == 50)',
  '\t\tg_Sfx_Play(G_SFX_COIN);',
  '\tif (frame == 60 && g_Sfx_IsPlaying())',
  '\t\tg_Sfx_Stop();',
  '\tif (frame == 70)',
  '\t\tg_Sfx_PlayPriority(G_SFX_DEATH, 0);',
  '\tif (frame == 100) { g_Music_Pause(); g_Music_Resume(); }',
  '\tif (frame == 110)',
  '\t\tg_Music_PlayJingle(g_Music_Theme);',
  '\tif (frame == 120 && g_Music_IsJingle())',
  '\t\tg_Music_PlayJingle(g_Music_Theme);',
  '\tif (frame == 150)',
  '\t\tg_Music_FadeOut(4);',
  '\tif (frame == 250 && !g_Music_IsPlaying())',
  '\t\tg_Music_Play(g_Music_Theme, FALSE);',
  '\tif (frame == 255) { g_Music_Stop(); g_Music_Decode(); }',
  '}'
]

describe.runIf(hasMsxgl && NODE !== null)('music and sound effects build against real MSXgl', () => {
  it('music with sound effects, every call, with the config "Set up project" writes', () => {
    expectClean(build({ music: true, effects: true, code: MUSIC_WITH_EFFECTS }))
  }, 400_000)

  it('sound effects alone, flushed by g_Sfx_Update()', () => {
    expectClean(
      build({
        music: false,
        effects: true,
        code: ['g_Sfx_Init();', 'g_Sfx_Play(G_SFX_DEATH);', 'while (1)', '{', '\tHalt();', '\tg_Sfx_Update();', '}']
      })
    )
  }, 400_000)

  it('music alone links without the ayFX module', () => {
    expectClean(
      build({
        music: true,
        effects: false,
        code: ['g_Music_Play(g_Music_Theme, TRUE);', 'while (1)', '{', '\tHalt();', '\tg_Music_Update();', '}']
      })
    )
  }, 400_000)

  it('would see a compiler warning if the generated code had one', () => {
    // An unused-variable warning in game.c, built the same way as the cases above.
    expectWarningsVisible(build({ music: false, effects: true, code: ['u8 unused;', 'g_Sfx_Init();', 'while (1) g_Sfx_Update();'] }))
  }, 400_000)

  it('fails to link on the template\'s PT3 ayFX buffer — the change the setup exists to make', () => {
    const output = build({ music: true, effects: true, code: MUSIC_WITH_EFFECTS, config: { ...MUSIC_CONFIG, AYFX_BUFFER: 'AYFX_BUFFER_PT3' } })
    expect(output).toMatch(/Undefined Global _PT3_Regs/)
  }, 400_000)
})
