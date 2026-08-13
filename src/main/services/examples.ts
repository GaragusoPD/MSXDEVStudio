/**
 * Pure logic for the Examples browser (Spec 12): checking which catalog
 * entries still exist on disk, loading a sample's read-only source, and
 * forking a sample into a new project. Asset-dependency copying is the only
 * subtle part — see `collectContentDependencies`/`findSegmentFiles`.
 *
 * Electron-free, same split as `project.ts` — testable directly against a
 * real MSXgl checkout.
 */

import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { NewProjectRequest, OpenProject } from '../../shared/ipc'
import { projectFromConfigGlobals, type ConfigGlobals, type RawFileEntry } from '../../shared/msxproj'
import { agentGuideFiles } from './agent-guide'
import { launcherScripts, PROJECT_EXT, saveProject } from './project'

export function samplesDir(msxglPath: string): string {
  return join(msxglPath, 'projects', 'samples')
}

export function sampleSourcePath(msxglPath: string, id: string): string {
  return join(samplesDir(msxglPath), `${id}.c`)
}

/** Which of `ids` still have a `<id>.c` on disk — lets the static catalog survive MSXgl version drift. */
export function existingSampleIds(msxglPath: string, ids: string[]): string[] {
  return ids.filter((id) => existsSync(sampleSourcePath(msxglPath, id)))
}

export function readSampleSource(msxglPath: string, id: string): string {
  return readFileSync(sampleSourcePath(msxglPath, id), 'utf-8')
}

// ── #include dependency resolution ──────────────────────────────────────────

const INCLUDE_RE = /^[ \t]*#include[ \t]+"([^"]+)"/gm

/** Every quoted `#include "…"` in `source`, in file order (duplicates kept — callers dedupe). */
export function extractIncludes(source: string): string[] {
  return [...source.matchAll(INCLUDE_RE)].map((m) => m[1])
}

function resolveAgainst(include: string, dirs: string[]): string | null {
  for (const dir of dirs) {
    const candidate = join(dir, ...include.split('/'))
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

export interface DependencyResult {
  /** Absolute source path → project-relative destination (forward-slash), one entry per file to copy. */
  files: Map<string, string>
  /** Include strings that resolved neither under the sample nor under the engine. */
  unresolved: string[]
}

/**
 * Walks `#include "..."` in `mainSource`, resolving against the sample's own
 * include dirs (`samples/` and `samples/content/`, per the spec). Includes
 * that resolve under the engine (`engine/src`, `engine/content`) are already
 * on every project's compile include path — skipped, not copied and not
 * reported as unresolved. Recurses one level into copied headers for their
 * own nested includes, matching the spec's "one level of nested includes".
 */
export function collectContentDependencies(msxglPath: string, mainSource: string): DependencyResult {
  const samples = samplesDir(msxglPath)
  const sampleDirs = [samples, join(samples, 'content')]
  const engineDirs = [join(msxglPath, 'engine', 'src'), join(msxglPath, 'engine', 'content')]

  const files = new Map<string, string>()
  const unresolved: string[] = []

  const resolveAndCopy = (includes: string[]): string[] => {
    const newlyResolved: string[] = []
    for (const include of includes) {
      if (resolveAgainst(include, engineDirs)) continue // ships with every project already
      const abs = resolveAgainst(include, sampleDirs)
      if (!abs) {
        unresolved.push(include)
        continue
      }
      if (files.has(abs)) continue
      files.set(abs, include)
      newlyResolved.push(abs)
    }
    return newlyResolved
  }

  const topLevel = resolveAndCopy(extractIncludes(mainSource))
  for (const headerPath of topLevel) {
    resolveAndCopy(extractIncludes(readFileSync(headerPath, 'utf-8')))
  }

  return { files, unresolved }
}

// ── mapper-segment siblings ──────────────────────────────────────────────────

const SEGMENT_EXTENSIONS = ['c', 's', 'asm']

export interface SegmentFile {
  abs: string
  /** New basename (e.g. `mygame_s4_b2.c`) to place beside the forked `main.c`. */
  newName: string
}

/**
 * `<base>_s<seg>_b<bank>.{c,s,asm}` and `<base>_p0.{c,s,asm}` siblings for
 * `projSegments` (a sample's `ProjSegments`, e.g. `"segment/s_arkos"` or just
 * its id when the sample never overrides it), renamed to match the new
 * project's own default `ProjSegments` — its `ProjName`.
 */
export function findSegmentFiles(msxglPath: string, projSegments: string, newProjName: string): SegmentFile[] {
  const dir = join(samplesDir(msxglPath), dirname(projSegments))
  if (!existsSync(dir)) return []
  const base = basename(projSegments).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^${base}_(s\\d+_b\\d+|p0)\\.(${SEGMENT_EXTENSIONS.join('|')})$`, 'i')
  const found: SegmentFile[] = []
  for (const name of readdirSync(dir)) {
    const match = re.exec(name)
    if (match) found.push({ abs: join(dir, name), newName: `${newProjName}_${match[1]}.${match[2]}` })
  }
  return found
}

// ── fork ─────────────────────────────────────────────────────────────────────

export interface ForkResult {
  opened: OpenProject
  /** Post-create notices (unresolved includes, missing referenced files) — never a failure reason. */
  notices: string[]
}

/**
 * Forks sample `id` into `request.location/request.name`. `globals` is the
 * sample's own evaluated config (`project_config.js` + `<id>.js`, via
 * `evaluateProjectConfig`'s override-file param) — machine/target/LibModules/
 * RawFiles/DiskFiles/Emul* all come from there, never from `request`.
 */
export function forkSample(
  msxglPath: string,
  id: string,
  request: NewProjectRequest,
  globals: ConfigGlobals,
  copyEntireContent: boolean
): ForkResult {
  const root = join(request.location, request.name)
  if (existsSync(root) && readdirSync(root).length > 0) {
    throw new Error(`"${root}" already exists and is not empty`)
  }
  const samples = samplesDir(msxglPath)
  const notices: string[] = []

  const project = {
    ...projectFromConfigGlobals(globals, request.name),
    name: request.name,
    projModules: ['main']
  }

  mkdirSync(join(root, 'content'), { recursive: true })

  // main.c: the sample source, with its build-generated rawdef include (if any) renamed to
  // match the new project — MSXgl regenerates that header under the new ProjName at build time.
  const source = readSampleSource(msxglPath, id)
  const renamedSource = source.replace(new RegExp(`(#include\\s+")${id}(_rawdef\\.h")`, 'g'), `$1${request.name}$2`)
  writeFileSync(join(root, 'main.c'), renamedSource, 'utf-8')

  // msxgl_config.h: samples share one dispatcher (msxgl_config_msx1/2.h picked by MSX_VERSION);
  // a real project gets the concrete header directly, same as createProject()'s template copy.
  const configHeader = project.machine === '1' ? 'msxgl_config_msx1.h' : 'msxgl_config_msx2.h'
  copyFileSync(join(samples, configHeader), join(root, 'msxgl_config.h'))

  writeFileSync(join(root, '.gitignore'), 'out/\nemul/\n.msxdevstudio/\n', 'utf-8')
  for (const script of launcherScripts(msxglPath)) {
    const scriptPath = join(root, script.name)
    writeFileSync(scriptPath, script.content, 'utf-8')
    if (script.exec) chmodSync(scriptPath, 0o755)
  }
  for (const file of agentGuideFiles(project, msxglPath)) {
    writeFileSync(join(root, file.name), file.content, 'utf-8')
  }

  if (copyEntireContent) {
    cpSync(join(samples, 'content'), join(root, 'content'), { recursive: true })
  } else {
    const deps = collectContentDependencies(msxglPath, source)
    for (const [abs, rel] of deps.files) {
      if (/_rawdef\.h$/i.test(rel)) continue // build-generated; MSXgl writes a fresh one under the new ProjName
      const dest = join(root, ...rel.split('/'))
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(abs, dest)
    }
    notices.push(
      ...deps.unresolved.map((inc) => `Could not resolve #include "${inc}" — copy it into the project manually if needed.`)
    )
  }

  const rawFiles = Array.isArray(globals.RawFiles) ? (globals.RawFiles as RawFileEntry[]) : []
  const diskFiles = Array.isArray(globals.DiskFiles) ? (globals.DiskFiles as string[]) : []
  for (const file of [...rawFiles.map((r) => r.file), ...diskFiles]) {
    const src = join(samples, ...file.split('/'))
    if (!existsSync(src)) {
      notices.push(`Referenced file not found in samples/: ${file}`)
      continue
    }
    const dest = join(root, ...file.split('/'))
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(src, dest)
  }

  const projSegmentsBase = typeof globals.ProjSegments === 'string' && globals.ProjSegments ? globals.ProjSegments : id
  for (const seg of findSegmentFiles(msxglPath, projSegmentsBase, request.name)) {
    copyFileSync(seg.abs, join(root, seg.newName))
  }

  return { opened: saveProject(root, `${request.name}${PROJECT_EXT}`, project), notices }
}
