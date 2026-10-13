/**
 * Builds a scratch project against the **real** MSXgl, exactly as the IDE
 * does — for the tests that check emitted C by compiling and linking it,
 * because per CLAUDE.md emitted C is never verified by reading it.
 *
 * Skipped by callers when no checkout is present (`runsBuilds`). Scratch
 * projects go *beside* the checkout, never `/tmp`: MSXgl renames each `.rel`
 * out of the engine directory into the project's `out/`, and `rename(2)` fails
 * with EXDEV across filesystems.
 */

import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serializeResource, type ResourceDoc } from '../../../shared/msx/resource'
import { normalizeProject } from '../../../shared/msxproj'
import { buildScript } from '../build'
import { resolveNodeBinary, writeGeneratedConfig } from '../project'
import { exportResourceFile, generatedSourceModules } from '../resources'
import { REAL_MSXGL, hasMsxgl, scratchRoot } from './msxgl'

const NODE = hasMsxgl ? resolveNodeBinary(REAL_MSXGL) : null
export const runsBuilds = hasMsxgl && NODE !== null
export const BUILD_TIMEOUT = 400_000

const dirs: string[] = []

/**
 * For `afterAll`. Set MSXDEVSTUDIO_KEEP_SCRATCH=1 to keep the built projects
 * for a manual openMSX pass — a link is not a picture, and the ROM has to be
 * booted.
 */
export function cleanBuildFixtures(): void {
  if (process.env.MSXDEVSTUDIO_KEEP_SCRATCH) {
    for (const dir of dirs) console.log(`kept: ${dir}`)
    dirs.length = 0
    return
  }
  while (dirs.length) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

export interface FixtureSpec {
  name: string
  template: 'template' | 'template_msx2'
  machine: '1' | '2'
  /** `res/<key>.json` → the resource written there. */
  resources: Record<string, ResourceDoc>
  main: string
}

/**
 * Builds a fixture exactly as the IDE does, which is the part the first
 * version of the meta test got wrong: it rendered the headers straight to disk
 * and never told MSXgl about the generated `.c` files, so every symbol came
 * back undefined and it looked like the emitted C was broken. The pre-build
 * step — export each resource, then regenerate `project_config.js` with the
 * modules those exports produced — is not optional scaffolding, it is how the
 * data reaches the link.
 */
export function buildFixture(spec: FixtureSpec): { output: string; root: string } {
  const root = mkdtempSync(join(scratchRoot(), `${spec.name}-`))
  dirs.push(root)
  cpSync(join(REAL_MSXGL, `projects/${spec.template}`), root, { recursive: true })

  // The resources, as `res/*.json` — the same files the editors write.
  mkdirSync(join(root, 'res'), { recursive: true })
  for (const [name, resource] of Object.entries(spec.resources)) {
    writeFileSync(join(root, `res/${name}.json`), serializeResource(resource))
  }

  // Through the real exporter, not `renderResourceFiles` directly: that is what
  // refreshes every mirror, so this covers the export path as well as the C.
  for (const name of Object.keys(spec.resources)) {
    const result = exportResourceFile(root, `res/${name}.json`, { force: true })
    if (result.status === 'failed') throw new Error(`export ${name}: ${result.message}`)
  }

  // `template.c` in *both* templates — `template_msx2/` names its main file
  // `template.c` too (see `project.test.ts:88`). It would compile alongside
  // ours; `writeGeneratedConfig` emits ProjModules naming main.c, the way the
  // IDE's wizard does.
  rmSync(join(root, 'template.c'), { force: true })
  writeFileSync(join(root, 'main.c'), spec.main)
  writeGeneratedConfig(
    root,
    `${spec.name}.msxproj`,
    normalizeProject({ name: spec.name, machine: spec.machine, target: 'ROM_32K' }, spec.name),
    generatedSourceModules(root)
  )

  try {
    const output = execFileSync(NODE as string, [buildScript(REAL_MSXGL), 'all'], {
      cwd: root,
      encoding: 'utf-8',
      stdio: 'pipe'
    })
    return { output, root }
  } catch (error) {
    const spawned = error as { stdout?: string; stderr?: string }
    throw new Error(`${spawned.stdout ?? ''}\n${spawned.stderr ?? ''}`, { cause: error })
  }
}
