/**
 * Shared scaffolding for the tests that drive a **real MSXgl checkout** —
 * `build-service`, `examples`, `project`, `resources`, `toolchain`. They take
 * ~40s and are skipped when the checkout isn't there.
 *
 * Point `MSXGL_PATH` at your own clone to run them elsewhere.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Where a clone usually sits, per platform. `MSXGL_PATH` beats all of them. */
const CANDIDATES = [
  '/home/pablo/MSXgl',
  join(homedir(), 'MSXgl'),
  join(homedir(), 'Applications', 'MSXgl'),
  join(homedir(), 'Development', 'msx', 'MSXgl')
]

export const REAL_MSXGL =
  process.env.MSXGL_PATH ??
  CANDIDATES.find((dir) => existsSync(join(dir, 'projects/template/template.c'))) ??
  CANDIDATES[0]

export const hasMsxgl = existsSync(join(REAL_MSXGL, 'projects/template/template.c'))

/**
 * Where a scratch project goes. **Not** `os.tmpdir()`: MSXgl's compiler step
 * renames each `.rel` out of the engine directory into the project's `out/`,
 * and `rename(2)` fails with EXDEV across filesystems — so a project has to
 * live on the same device as the checkout it builds with.
 */
/**
 * True when this clone's user-global config names an emulator — the IDE writes
 * one there (`writeEmulatorConfig`). MSXgl's `run` step then really launches it
 * and blocks until it is closed, which no automated test can wait for.
 */
export function emulatorConfigured(): boolean {
  try {
    const config = readFileSync(join(REAL_MSXGL, 'projects/default_config.js'), 'utf-8')
    return /^Emulator\s*=\s*"[^"]+"/m.test(config)
  } catch {
    return false
  }
}

export function scratchRoot(): string {
  const root = join(dirname(REAL_MSXGL), '.msxdevstudio-test-scratch')
  if (!existsSync(root)) mkdirSync(root, { recursive: true })
  return root
}
