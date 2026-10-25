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
import { defaultExport, parseResource, renderResourceFiles,
  sourcePathFor, resourceKindOf, validateResource, type ResourceDoc } from '../../shared/msx/resource'
import { metaRefFrom, remapTiles, validateMap, type MapDoc } from '../../shared/msx/map'
import { remapMetaTiles } from '../../shared/msx/meta-tile'
import { pendingReorders } from '../../shared/map-editor'
import type { TilesReorderEvent } from '../../shared/tile-editor'
import { movingCells, refreshMetas, type LoadedMeta } from '../../shared/msx/meta-owned'
import { isBanked, isMetaPath, MAX_TILES, type TilesDoc } from '../../shared/msx/tile'
import { animModesCompatible, animRefFrom, withAnimFrame, type TileAnimDoc } from '../../shared/msx/tile-anim'
import { swSpriteFamily } from '../../shared/msx/swsprite'

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

/**
 * True when `out` already reflects `input`, the project config it was
 * configured by, and every other file `input` mirrors (`dependencies`).
 *
 * Comparing `input` alone was the whole check once, and that was wrong as soon
 * as a resource's header carried data from another file: edit a meta-tile's
 * frame count, leave the map that places it untouched, and the map's header
 * kept the old count. A dependency that is missing is never "up to date" —
 * the export has to run to say so.
 */
function upToDate(input: string, out: string, options: ExportOptions, dependencies: readonly string[] = []): boolean {
  if (options.force) return false
  const outTime = mtime(out)
  if (outTime === 0 || outTime < mtime(input) || outTime < (options.configMtimeMs ?? 0)) return false
  return dependencies.every((dependency) => {
    const time = mtime(dependency)
    return time !== 0 && outTime >= time
  })
}

/**
 * The other files a resource's export reads, as absolute paths: the metas a
 * map mirrors, the animations and meta-tiles a tileset has attached. What
 * `upToDate` must also be newer than.
 *
 * A map that places meta-tiles also depends on its tileset and on everything
 * attached *there*: a meta that owns its pixels is drawn with the tiles its
 * attachment resolves to, and that resolution reads the tileset and every meta
 * attached before it (`refreshMetas` goes in order, and each may add tiles).
 */
function exportDependencies(root: string, resource: ResourceDoc): string[] {
  const attached = (doc: TilesDoc): string[] => [...doc.animations.map((b) => b.path), ...doc.metas.map((b) => b.path)]
  let paths: string[] = []
  if (resource.kind === 'tiles') paths = attached(resource.doc)
  // Its numbers follow the tileset's reorder log (`replayTilesetLog`).
  if (resource.kind === 'map' || resource.kind === 'metabtiles') paths.push(resource.doc.tileset)
  if (resource.kind === 'map' && resource.doc.metas.length) {
    paths = resource.doc.metas.map((ref) => ref.path)
    const tileset = readTileset(root, resource.doc.tileset)
    if (tileset) paths.push(resource.doc.tileset, ...attached(tileset))
  }
  return [...new Set(paths)].map((path) => insideRoot(root, path)).filter((path): path is string => path !== null)
}

/**
 * Brings a map, or a bitmap meta-tile, into its tileset's current numbering.
 *
 * Deleting, moving or reclaiming tiles renumbers a tileset, and its file logs
 * each renumbering (`reorderLog`) for the files drawn with it; an editor
 * replays what a file missed when it opens. A build opens nothing, so without
 * this a file that was closed at the time exports the old numbers — the wrong
 * art, with nothing to say so. Only a stamped file is replayed: one without
 * `tilesetReorderSeen` cannot say which entries it has already seen, and
 * replaying them all would scramble one written after them.
 */
function replayTilesetLog(root: string, resource: ResourceDoc, text: string): void {
  if (resource.kind !== 'map' && resource.kind !== 'metabtiles') return
  const seen = (JSON.parse(text) as { tilesetReorderSeen?: unknown }).tilesetReorderSeen
  const abs = insideRoot(root, resource.doc.tileset)
  if (typeof seen !== 'number' || !abs || !existsSync(abs)) return
  const log = (JSON.parse(readFileSync(abs, 'utf-8')) as { reorderLog?: TilesReorderEvent[] }).reorderLog
  if (!Array.isArray(log)) return
  for (const event of pendingReorders(log, seen)) {
    if (resource.kind === 'map') resource.doc = remapTiles(resource.doc, event.mapping, event.bank)
    else resource.doc = remapMetaTiles(resource.doc, event.mapping)
  }
}

/** A pattern tileset as its file says, or null when it is not one or cannot be read. */
function readTileset(root: string, path: string): TilesDoc | null {
  const abs = insideRoot(root, path)
  if (!abs || !existsSync(abs)) return null
  try {
    const parsed = parseResource(path, readFileSync(abs, 'utf-8'))
    return parsed.kind === 'tiles' ? parsed.doc : null
  } catch {
    return null
  }
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
  // Read and refreshed once, and only if some meta owns its pixels: its tiles
  // are what its attachment there resolves to *now*, by the same refresh the
  // tileset's own export runs — so the two headers agree on every number.
  let tileset: TilesDoc | null | undefined
  const refreshedTileset = (): TilesDoc | null => {
    if (tileset !== undefined) return tileset
    const read = readTileset(root, (resource.doc as MapDoc).tileset)
    tileset = read ? refreshTileset(root, read).doc : null
    return tileset
  }
  resource.doc = {
    ...resource.doc,
    metas: resource.doc.metas.map((ref) => {
      const abs = insideRoot(root, ref.path)
      if (!abs || !existsSync(abs)) return ref
      try {
        const parsed = parseResource(ref.path, readFileSync(abs, 'utf-8'))
        if (parsed.kind === 'metatiles') {
          const binding = refreshedTileset()?.metas.find((candidate) => candidate.path === ref.path) ?? null
          return metaRefFrom(ref.path, parsed.doc, defaultExport(ref.path).name, binding)
        }
        if (parsed.kind === 'metabtiles') return metaRefFrom(ref.path, parsed.doc, defaultExport(ref.path).name)
        return ref
      } catch {
        return ref
      }
    })
  }
}

/**
 * Re-reads every meta-tile attached to a tileset and re-resolves its tiles —
 * the build's half of the rule the tile editor follows on load. Through the
 * shared `refreshMetas`, so an export and an open editor resolve the same
 * meta to the same numbers.
 *
 * A meta that is missing or cannot be attached fails the export: its tiles
 * would be whatever the tileset file last recorded, and a map drawn with them
 * would show the old art with no sign anything was wrong.
 */
function refreshTileMetas(root: string, doc: TilesDoc): { doc: TilesDoc; problems: string[] } {
  if (!doc.metas.length) return { doc, problems: [] }
  const loaded = new Map<string, LoadedMeta>()
  for (const binding of doc.metas) {
    const abs = insideRoot(root, binding.path)
    if (!abs || !existsSync(abs)) {
      loaded.set(binding.path, `Meta-tile ${binding.path} is attached but missing — restore it, or detach it in the tile editor`)
      continue
    }
    try {
      const parsed = parseResource(binding.path, readFileSync(abs, 'utf-8'))
      if (parsed.kind !== 'metatiles') {
        loaded.set(binding.path, `${binding.path} is attached as a meta-tile but is not one`)
        continue
      }
      // The window's poses are emitted in the meta's own header, and this
      // tileset's _Animate() names them: no header, no link.
      if (movingCells(parsed.doc).length && !parsed.doc.export?.out) {
        loaded.set(binding.path, `${binding.path} animates, and its poses are written to its own header — give it an export target`)
        continue
      }
      loaded.set(binding.path, { meta: parsed.doc, name: parsed.doc.export?.name || defaultExport(binding.path).name })
    } catch (error) {
      loaded.set(binding.path, `Couldn't read meta-tile ${binding.path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const { doc: refreshed, problems } = refreshMetas(doc, loaded)
  return { doc: refreshed, problems }
}

/** Everything attached to a tileset, re-read: its metas first (they may move windows), then its animations. */
function refreshTileset(root: string, doc: TilesDoc): { doc: TilesDoc; problems: string[] } {
  const metas = refreshTileMetas(root, doc)
  const anims = refreshAnimBindings(root, metas.doc)
  return { doc: anims.doc, problems: [...metas.problems, ...anims.problems] }
}

/**
 * Re-reads every animation attached to a tileset and refreshes the binding's
 * mirror and the window's art (frame 0) from it — the build's half of the rule
 * that a mirror is derived data only a layer with file access can refresh. The
 * tile editor does the same on load, through the same `animRefFrom`; a build
 * that never opens the editor (a fresh clone, CI, an agent editing `res/`) is
 * exactly when this is the only refresh there is.
 *
 * Unlike a missing meta, a missing animation fails the export: the tileset's
 * generated C names the animation's tables, and a stale mirror would export
 * cleanly and then fail to link.
 */
function refreshAnimBindings(root: string, tiles: TilesDoc): { doc: TilesDoc; problems: string[] } {
  if (!tiles.animations.length) return { doc: tiles, problems: [] }
  const problems: string[] = []
  const loaded = new Map<string, TileAnimDoc>()
  let doc = tiles
  const animations = doc.animations.map((binding) => {
    // A meta-tile's window: `refreshTileMetas` has already brought it up to date.
    if (isMetaPath(binding.path)) return binding
    const abs = insideRoot(root, binding.path)
    if (!abs || !existsSync(abs)) {
      problems.push(`Animation ${binding.path} is attached but missing — restore it, or detach it in the tile editor`)
      return binding
    }
    try {
      const parsed = parseResource(binding.path, readFileSync(abs, 'utf-8'))
      if (parsed.kind !== 'anim') {
        problems.push(`${binding.path} is attached as an animation but is not one`)
        return binding
      }
      if (!animModesCompatible(parsed.doc.mode, doc.mode)) {
        problems.push(`${binding.path} holds ${parsed.doc.mode} poses, which a ${doc.mode} tileset cannot show`)
        return binding
      }
      loaded.set(binding.path, parsed.doc)
      return animRefFrom(binding.path, parsed.doc, defaultExport(binding.path).name, binding)
    } catch (error) {
      problems.push(`Couldn't read animation ${binding.path}: ${error instanceof Error ? error.message : String(error)}`)
      return binding
    }
  })
  doc = { ...doc, animations }
  for (const binding of animations) {
    const anim = loaded.get(binding.path)
    if (anim) doc = withAnimFrame(doc, binding, anim)
  }
  return { doc, problems }
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

/** Where software sprites in a pattern mode start borrowing the pattern table — `swsprite.ts:462`'s own `_FIRST_PATTERN`. */
const SW_SPRITE_FIRST_PATTERN = 192

/**
 * The highest pattern index a tileset's art actually occupies: the common
 * range, every bank's own overrides, and the shared (meta-tile) region, which
 * is allocated downward from 255 and so always reaches it the instant any of
 * it exists (see `TilesDoc.sharedTiles`). One expression covers all three
 * sources a tileset can hold art in, rather than one branch per source.
 */
function tilesetHighestIndex(doc: TilesDoc): number {
  return Math.max(
    doc.count - 1,
    ...doc.bankTiles.map((bank) => bank.length - 1),
    doc.sharedTiles > 0 ? MAX_TILES - 1 : -1
  )
}

/**
 * The one cross-resource check neither half of the project can make on its
 * own: `validateTiles` cannot see a `swsprites` resource, and
 * `validateSwSprites` cannot see a tileset. `findResourceFiles` walks every
 * resource, so this layer can see both.
 *
 * Software sprites in a pattern mode (sc1/sc2/sc4 — `swSpriteFamily`'s
 * `'tiled'` branch) reserve pattern indices 192-255 at runtime
 * (`swsprite.ts`'s own `_FIRST_PATTERN`), and `VDP_LoadPattern_GM2` writes
 * that reservation into all three banks — verified in the engine
 * (`vdp.c:2213`), not a bug in the emitter. A tileset whose art reaches that
 * far — common range, a bank's own override, or the shared meta-tile region,
 * which always does once `sharedTiles > 0` — has that art silently
 * overwritten the moment a sprite loads. Not a regression this branch made:
 * the same collision exists unbanked whenever a tileset's `count` alone
 * passes 192, and this check catches that case too.
 *
 * A resource that will not parse contributes nothing here — its own export
 * already reports why it cannot be read.
 */
export function swSpriteOverlapProblems(root: string): ConversionResult[] {
  const tilesets: { relative: string; doc: TilesDoc; out: string }[] = []
  let hasTiledSwSprites = false
  for (const relative of findResourceFiles(root)) {
    const abs = insideRoot(root, relative)
    if (!abs) continue
    try {
      const resource = parseResource(relative, readFileSync(abs, 'utf-8'))
      if (resource.kind === 'swsprites') {
        if (swSpriteFamily(resource.doc.mode) === 'tiled') hasTiledSwSprites = true
      } else if (resource.kind === 'tiles') {
        tilesets.push({ relative, doc: resource.doc, out: resource.doc.export?.out ?? '' })
      }
    } catch {
      // Unreadable — its own export step is what reports that.
    }
  }
  if (!hasTiledSwSprites) return []

  const problems: ConversionResult[] = []
  for (const { relative, doc, out } of tilesets) {
    const highest = tilesetHighestIndex(doc)
    if (highest < SW_SPRITE_FIRST_PATTERN) continue
    problems.push({
      kind: 'resource',
      input: relative,
      out,
      status: 'failed',
      message:
        `${relative} reaches pattern index ${highest}, but this project's software sprites reserve indices ` +
        `${SW_SPRITE_FIRST_PATTERN}-255 at runtime — that art will be overwritten the moment a sprite loads.`
    })
  }
  return problems
}

export function exportResourceFile(root: string, relative: string, options: ExportOptions = {}): ConversionResult {
  const sourceAbs = insideRoot(root, relative)
  const base: ConversionResult = { kind: 'resource', input: relative, out: '', status: 'failed' }
  if (!sourceAbs) return { ...base, message: 'Path escapes the project folder.' }

  try {
    const text = readFileSync(sourceAbs, 'utf-8')
    const resource = parseResource(relative, text)
    const block = resource.doc.export
    if (!block?.out) return { ...base, status: 'skipped', message: 'No export target set.' }

    const outAbs = insideRoot(root, block.out)
    if (!outAbs) return { ...base, out: block.out, message: 'Output path escapes the project folder.' }
    // Both halves must be newer than the resource, or a deleted .c would never
    // come back.
    const pairAbs = block.format === 'bin' ? null : insideRoot(root, sourcePathFor(block.out))
    const dependencies = exportDependencies(root, resource)
    if (
      upToDate(sourceAbs, outAbs, options, dependencies) &&
      (!pairAbs || upToDate(sourceAbs, pairAbs, options, dependencies))
    ) {
      return { ...base, out: block.out, status: 'skipped' }
    }

    // Before validation, not just before rendering: a stale mirror also means
    // stale sizes, and "this placement hangs off the map" must be judged
    // against the meta as it is now.
    replayTilesetLog(root, resource, text)
    refreshMapMetas(root, resource)
    let attachedProblems: string[] = []
    if (resource.kind === 'tiles') {
      const refreshed = refreshTileset(root, resource.doc)
      resource.doc = refreshed.doc
      attachedProblems = refreshed.problems
    }

    const problems =
      resource.kind === 'map'
        ? validateMap(resource.doc, mapValidateOptions(root, resource.doc))
        : [...attachedProblems, ...validateResource(resource)]
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
  results.push(...swSpriteOverlapProblems(root))
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
