/**
 * The pre-build resource step (Spec 07 B + C): turn the editors' resource
 * files into the headers/binaries a project's `content/` holds, and run the
 * declarative `imgRules` through MSXgl's bundled **MSXimg** — the
 * cross-platform replacement for MSXgl's Windows-only `build_data.bat`.
 *
 * Both halves are mtime-skipped: a build that changes nothing converts
 * nothing. Electron-free, same split as `toolchain.ts` / `project.ts`.
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, type Dirent } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isIgnoredName, resolveRelativePath } from '../../shared/fs-safety'
import type { ImgRule, MsxProject } from '../../shared/msxproj'
import { defaultExport, isMetaKind, parseResource, renderResourceFiles,
  sourcePathFor, resourceKindOf, validateResource, type ResourceDoc } from '../../shared/msx/resource'
import { metaRefFrom, validateMap, type MapDoc } from '../../shared/msx/map'
import type { MetaTileDoc } from '../../shared/msx/meta-tile'
import { isBanked } from '../../shared/msx/tile'

/** `<msxgl>/tools/MSXtk/bin/MSXimg(.exe)` — MSXgl ships Linux and Windows builds. */
export function msximgPath(msxglPath: string): string {
  return join(msxglPath, 'tools', 'MSXtk', 'bin', process.platform === 'win32' ? 'MSXimg.exe' : 'MSXimg')
}

/** URL of the CLI help that ships beside the binary; the settings UI links to it. */
export function msximgHelpPath(msxglPath: string): string {
  return join(msxglPath, 'tools', 'MSXtk', 'bin', 'MSXimg.txt')
}

export type ConversionStatus = 'converted' | 'skipped' | 'failed'

export interface ConversionResult {
  kind: 'resource' | 'imgRule'
  /** Project-relative source path. */
  input: string
  /** Project-relative output path. */
  out: string
  status: ConversionStatus
  /** Failure reason, or a short note about what was written. */
  message?: string
}

export interface ExportOptions {
  /** Convert even when the output is newer than its input. */
  force?: boolean
  msxglPath?: string | null
  /** Extra mtime every output must beat — the `.msxproj`, so editing a rule's args re-runs it. */
  configMtimeMs?: number
}

function safeEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** Every `*.tiles|sprites|map|screen.json` under `root`, project-relative, sorted for deterministic order. */
export function findResourceFiles(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const entry of safeEntries(dir).sort((a, b) => a.name.localeCompare(b.name))) {
      if (isIgnoredName(entry.name)) continue
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(join(dir, entry.name), relative)
      else if (resourceKindOf(entry.name)) found.push(relative)
    }
  }
  walk(root, '')
  return found
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/** True when `out` already reflects `input` (and the project config it was configured by). */
function upToDate(input: string, out: string, options: ExportOptions): boolean {
  if (options.force) return false
  const outTime = mtime(out)
  return outTime !== 0 && outTime >= mtime(input) && outTime >= (options.configMtimeMs ?? 0)
}

/**
 * Resolves a project-relative path to an absolute one, refusing anything that
 * escapes the project (rules come from a `.msxproj` the user may have hand
 * edited — the same trust boundary the `fs:*` channels guard).
 */
function insideRoot(root: string, relative: string): string | null {
  const safe = resolveRelativePath(relative)
  return safe ? resolve(root, safe) : null
}

/**
 * The module names MSXgl must compile for the generated data: every resource
 * that exports C contributes one `.c` beside its header. Extensionless and
 * project-relative, which is the form ProjModules takes.
 */
export function generatedSourceModules(root: string): string[] {
  const out: string[] = []
  for (const relative of findResourceFiles(root)) {
    const abs = insideRoot(root, relative)
    if (!abs) continue
    try {
      const block = parseResource(relative, readFileSync(abs, 'utf-8')).doc.export
      if (block?.out && block.format === 'c') out.push(sourcePathFor(block.out).replace(/\.c$/, ''))
    } catch {
      // A resource that will not parse cannot contribute a module; the export
      // itself reports why.
    }
  }
  return [...new Set(out)].sort()
}

/** Converts one editor resource into the file its `export` block names. */
/**
 * Re-reads a map's meta-tile mirror from the meta files themselves.
 *
 * `MapDoc.metas` copies each meta's symbol, size, frames and flags because
 * `shared/msx/map.ts` is dependency-free and cannot open another file — that is
 * the whole reason the mirror exists. It follows that the copy goes stale, and
 * that only a layer with filesystem access can refresh it. This is that layer.
 *
 * The map editor refreshes the same mirror when a map is open, but a build does
 * not go through the editor: a fresh clone, a CI run, or an agent editing `res/`
 * JSON by hand all reach the exporter with whatever the file last said. That is
 * the common case, not the exotic one, and it is where an out-of-date symbol
 * became `?ASlink-Warning-Undefined Global`.
 *
 * A meta that cannot be read keeps the mirror it had: the map still exports,
 * and `validateResource` is what complains about a meta that is genuinely gone.
 */
function refreshMapMetas(root: string, resource: ResourceDoc): void {
  if (resource.kind !== 'map' || !resource.doc.metas.length) return
  resource.doc = {
    ...resource.doc,
    metas: resource.doc.metas.map((ref) => {
      const abs = insideRoot(root, ref.path)
      if (!abs || !existsSync(abs)) return ref
      try {
        const parsed = parseResource(ref.path, readFileSync(abs, 'utf-8'))
        if (!isMetaKind(parsed.kind)) return ref
        return metaRefFrom(ref.path, parsed.doc as MetaTileDoc, defaultExport(ref.path).name)
      } catch {
        return ref
      }
    })
  }
}

/**
 * Whether a map's tileset gives its three SCREEN 2/4 banks their own art —
 * `validateMap`'s only opinion that `shared/` cannot form on its own, since it
 * takes a `MapDoc` and a banked tileset lives in a different file. Read fresh
 * for the same reason `refreshMapMetas` is: a build never opens the tileset
 * editor, only this layer can.
 *
 * A tileset that cannot be read passes nothing rather than a failure — a
 * missing tileset is already `validateMap`'s own "No tileset referenced", and
 * a second message for the same problem helps nobody.
 */
function mapValidateOptions(root: string, doc: MapDoc): { banked?: boolean } {
  const abs = insideRoot(root, doc.tileset)
  if (!abs || !existsSync(abs)) return {}
  try {
    const parsed = parseResource(doc.tileset, readFileSync(abs, 'utf-8'))
    return parsed.kind === 'tiles' ? { banked: isBanked(parsed.doc) } : {}
  } catch {
    return {}
  }
}

export function exportResourceFile(root: string, relative: string, options: ExportOptions = {}): ConversionResult {
  const sourceAbs = insideRoot(root, relative)
  const base: ConversionResult = { kind: 'resource', input: relative, out: '', status: 'failed' }
  if (!sourceAbs) return { ...base, message: 'Path escapes the project folder.' }

  try {
    const resource = parseResource(relative, readFileSync(sourceAbs, 'utf-8'))
    const block = resource.doc.export
    if (!block?.out) return { ...base, status: 'skipped', message: 'No export target set.' }

    const outAbs = insideRoot(root, block.out)
    if (!outAbs) return { ...base, out: block.out, message: 'Output path escapes the project folder.' }
    // Both halves must be newer than the resource, or a deleted .c would never
    // come back.
    const pairAbs = block.format === 'bin' ? null : insideRoot(root, sourcePathFor(block.out))
    if (upToDate(sourceAbs, outAbs, options) && (!pairAbs || upToDate(sourceAbs, pairAbs, options))) {
      return { ...base, out: block.out, status: 'skipped' }
    }

    // Before validation, not just before rendering: a stale mirror also means
    // stale sizes, and "this placement hangs off the map" must be judged
    // against the meta as it is now.
    refreshMapMetas(root, resource)

    const problems =
      resource.kind === 'map'
        ? validateMap(resource.doc, mapValidateOptions(root, resource.doc))
        : validateResource(resource)
    if (problems.length) return { ...base, out: block.out, message: problems.join('; ') }

    const files = renderResourceFiles(resource, relative, block)
    mkdirSync(dirname(outAbs), { recursive: true })
    if (files.bin) {
      writeFileSync(outAbs, files.bin)
      return { ...base, out: block.out, status: 'converted', message: `${files.bin.length} bytes` }
    }
    // A C export is two files: declarations for everyone, definitions once.
    const sourceRel = sourcePathFor(block.out)
    const sourceOut = insideRoot(root, sourceRel)
    if (!sourceOut) return { ...base, out: block.out, message: 'Output path escapes the project folder.' }
    writeFileSync(outAbs, files.header ?? '')
    writeFileSync(sourceOut, files.source ?? '')
    return {
      ...base,
      out: `${block.out} + ${sourceRel}`,
      status: 'converted',
      message: `${(files.header ?? '').length} + ${(files.source ?? '').length} bytes`
    }
  } catch (error) {
    return { ...base, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Arguments handed to MSXimg. The rule's own `args` come first so the user
 * stays in control; `-out` is always ours, and `-nodate` is forced so output
 * is byte-stable (otherwise every conversion dirties git and defeats the mtime
 * skip's whole point).
 */
export function msximgArgs(rule: ImgRule): string[] {
  const user: string[] = []
  for (let i = 0; i < rule.args.length; i++) {
    // Drop a hand-typed `-out` *and* the path after it — the rule's `out` wins.
    if (rule.args[i] === '-out') i++
    else user.push(rule.args[i])
  }
  const args = [rule.input, ...user]
  if (!args.includes('-nodate')) args.push('-nodate')
  // MSXimg's documented default is to return the data size as the exit code;
  // -ret0 makes "0 = success" true whatever the version does.
  if (!args.includes('-ret0')) args.push('-ret0')
  return [...args, '-out', rule.out]
}

/** Runs one imgRule with cwd = the project root, so every path in it is project-relative. */
export function runImgRule(
  root: string,
  msxglPath: string,
  rule: ImgRule,
  options: ExportOptions = {}
): Promise<ConversionResult> {
  const base: ConversionResult = { kind: 'imgRule', input: rule.input, out: rule.out, status: 'failed' }
  const inputAbs = insideRoot(root, rule.input)
  const outAbs = insideRoot(root, rule.out)
  if (!rule.input || !rule.out) return Promise.resolve({ ...base, status: 'skipped', message: 'Incomplete rule.' })
  if (!inputAbs || !outAbs) return Promise.resolve({ ...base, message: 'Rule path escapes the project folder.' })
  if (!existsSync(inputAbs)) return Promise.resolve({ ...base, message: `Input not found: ${rule.input}` })

  const binary = msximgPath(msxglPath)
  if (!existsSync(binary)) return Promise.resolve({ ...base, message: `MSXimg not found at ${binary}` })
  if (upToDate(inputAbs, outAbs, options)) return Promise.resolve({ ...base, status: 'skipped' })

  mkdirSync(dirname(outAbs), { recursive: true })
  return new Promise((resolvePromise) => {
    execFile(binary, msximgArgs(rule), { cwd: root, windowsHide: true }, (error, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim()
      if (error) {
        resolvePromise({ ...base, message: output || error.message })
        return
      }
      resolvePromise({ ...base, status: 'converted', message: output.split('\n').pop() ?? '' })
    })
  })
}

/**
 * The whole pre-build step: every editor resource, then every imgRule.
 * Returns one result per item so the caller can log it and count failures.
 */
export async function exportAll(
  root: string,
  project: MsxProject,
  options: ExportOptions = {}
): Promise<ConversionResult[]> {
  const results = findResourceFiles(root).map((relative) => exportResourceFile(root, relative, options))
  const msxglPath = options.msxglPath
  for (const rule of project.resources.imgRules) {
    if (!msxglPath) {
      results.push({
        kind: 'imgRule',
        input: rule.input,
        out: rule.out,
        status: 'failed',
        message: 'MSXgl is not configured — set it up in Toolchain Settings.'
      })
      continue
    }
    results.push(await runImgRule(root, msxglPath, rule, options))
  }
  return results
}

/** One-line summary for the Output panel. */
export function summarize(results: readonly ConversionResult[]): string {
  const count = (status: ConversionStatus): number => results.filter((result) => result.status === status).length
  return `Resources: ${count('converted')} converted, ${count('skipped')} up to date, ${count('failed')} failed.`
}
