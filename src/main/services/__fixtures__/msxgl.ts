/**
 * Shared scaffolding for the tests that drive a **real MSXgl checkout** —
 * `build-service`, `examples`, `project`, `resources`, `toolchain`. They take
 * ~40s and are skipped when the checkout isn't there.
 *
 * Point `MSXGL_PATH` at your own clone to run them elsewhere.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const REAL_MSXGL = process.env.MSXGL_PATH ?? '/home/pablo/MSXgl'

export const hasMsxgl = existsSync(join(REAL_MSXGL, 'projects/template/template.c'))

/**
 * Where a scratch project goes. **Not** `os.tmpdir()`: MSXgl's compiler step
 * renames each `.rel` out of the engine directory into the project's `out/`,
 * and `rename(2)` fails with EXDEV across filesystems — so a project has to
 * live on the same device as the checkout it builds with.
 */
export function scratchRoot(): string {
  const root = join(dirname(REAL_MSXGL), '.msxdevstudio-test-scratch')
  if (!existsSync(root)) mkdirSync(root, { recursive: true })
  return root
}
