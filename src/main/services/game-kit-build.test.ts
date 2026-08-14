/**
 * Every game kit the wizard can scaffold, compiled and linked by the **real**
 * MSXgl — the only check that catches a stub calling an API that doesn't exist,
 * or a config define that leaves a module's symbols unresolved. One case per
 * `emitPlayC` branch; skipped when the checkout isn't there (see `__fixtures__`).
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  defaultDisplayMode,
  defaultScreens,
  suggestTarget,
  type NewGameRequest
} from '../../shared/game-kit'
import { REAL_MSXGL, hasMsxgl, scratchRoot } from './__fixtures__/msxgl'
import { buildScript } from './build'
import { createGameProject } from './game-kit'
import { resolveNodeBinary, writeGeneratedConfig } from './project'
import { generatedSourceModules } from './resources'

const NODE = hasMsxgl ? resolveNodeBinary(REAL_MSXGL) : null
const runsBuilds = hasMsxgl && NODE !== null
const BUILD_TIMEOUT = 400_000

const dirs: string[] = []

afterAll(() => {
  while (dirs.length) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

function request(partial: Partial<NewGameRequest>): NewGameRequest {
  const kit = partial.kit ?? 'platformer'
  const machine = partial.machine ?? '1'
  const displayMode = partial.displayMode ?? defaultDisplayMode(kit, machine)
  const screens = partial.screens ?? defaultScreens(kit)
  const suggested = suggestTarget({ kit, displayMode, screens })
  const location = mkdtempSync(join(scratchRoot(), 'kit-'))
  dirs.push(location)
  return {
    name: partial.name ?? 'kitgame',
    location,
    machine,
    kit,
    displayMode,
    screens,
    audio: partial.audio ?? 'none',
    target: partial.target ?? suggested.target,
    romSize: partial.romSize ?? suggested.romSize
  }
}

/** Scaffold, then build exactly as the IDE does: regenerate the config with the
 *  exported resource modules (BuildService's pre-build step) before MSXgl runs. */
function buildKit(partial: Partial<NewGameRequest>): string {
  const opened = createGameProject(request(partial), REAL_MSXGL)
  writeGeneratedConfig(
    opened.root,
    opened.projectFile,
    opened.project,
    generatedSourceModules(opened.root)
  )
  try {
    return execFileSync(NODE as string, [buildScript(REAL_MSXGL), 'all'], {
      cwd: opened.root,
      encoding: 'utf-8',
      stdio: 'pipe'
    })
  } catch (error) {
    const spawned = error as { stdout?: string; stderr?: string }
    throw new Error(`${spawned.stdout ?? ''}\n${spawned.stderr ?? ''}`, { cause: error })
  }
}

/** MSXgl reports a failed step in its output *and* its exit code; both are checked. */
function expectClean(output: string): void {
  expect(output).not.toMatch(/\bError:/i)
  expect(output).toMatch(/Success/)
}

describe.runIf(runsBuilds)('every game kit builds against real MSXgl', () => {
  it('text, no state (play only)', () => expectClean(buildKit({ kit: 'text', screens: ['play'] })), BUILD_TIMEOUT)

  it(
    'text with title/menu/credits states',
    () => expectClean(buildKit({ kit: 'text', screens: ['title', 'menu', 'play', 'pause', 'gameover', 'credits'] })),
    BUILD_TIMEOUT
  )

  it(
    'text on SCREEN 0 width 80 (MSX2)',
    () => expectClean(buildKit({ kit: 'text', machine: '2', displayMode: 'sc0w80' })),
    BUILD_TIMEOUT
  )

  it('platformer, MSX1 SCREEN 2', () => expectClean(buildKit({ kit: 'platformer' })), BUILD_TIMEOUT)

  it(
    'platformer with every screen and ayFX',
    () =>
      expectClean(
        buildKit({
          kit: 'platformer',
          audio: 'ayfx',
          screens: [
            'title',
            'menu',
            'options',
            'intro',
            'play',
            'pause',
            'hud',
            'gameover',
            'victory',
            'credits',
            'attract',
            'password',
            'stage-select'
          ]
        })
      ),
    BUILD_TIMEOUT
  )

  it(
    'platformer, MSX2 SCREEN 4',
    () => expectClean(buildKit({ kit: 'platformer', machine: '2', displayMode: 'sc4' })),
    BUILD_TIMEOUT
  )

  it(
    'platformer on a bitmap mode (MSX2 SCREEN 5)',
    () => expectClean(buildKit({ kit: 'platformer', machine: '2', displayMode: 'sc5' })),
    BUILD_TIMEOUT
  )

  it('top-down, MSX1', () => expectClean(buildKit({ kit: 'top-down' })), BUILD_TIMEOUT)

  it('side scroller, MSX1 SCREEN 2', () => expectClean(buildKit({ kit: 'side-scroll' })), BUILD_TIMEOUT)

  it(
    'vertical scroller, MSX2 SCREEN 4',
    () => expectClean(buildKit({ kit: 'vert-scroll', machine: '2', displayMode: 'sc4' })),
    BUILD_TIMEOUT
  )

  it('visual novel, MSX1 SCREEN 2', () => expectClean(buildKit({ kit: 'vn' })), BUILD_TIMEOUT)

  it(
    'visual novel, MSX2 SCREEN 5',
    () => expectClean(buildKit({ kit: 'vn', machine: '2', displayMode: 'sc5' })),
    BUILD_TIMEOUT
  )

  it(
    'visual novel on the text-only opt-out',
    () => expectClean(buildKit({ kit: 'vn', displayMode: 'sc0w40' })),
    BUILD_TIMEOUT
  )
})
