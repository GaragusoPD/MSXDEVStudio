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
import type { BuildProblem } from '../../shared/ipc'
import type { ImgRule, MsxProject } from '../../shared/msxproj'
import { defaultExport, parseResource, renderResourceFiles,
  sourcePathFor, resourceKindOf, validateResource, type ExportBlock, type ResourceDoc } from '../../shared/msx/resource'
import { metaRefFrom, remapTiles, validateMap, type MapDoc } from '../../shared/msx/map'
import { remapMetaTiles } from '../../shared/msx/meta-tile'
import { pendingReorders } from '../../shared/map-editor'
import type { TilesReorderEvent } from '../../shared/tile-editor'
import { movingCells, refreshMetas, type LoadedMeta } from '../../shared/msx/meta-owned'
import { isBanked, isMetaPath, MAX_TILES, type TilesDoc } from '../../shared/msx/tile'
import { animModesCompatible, animRefFrom, withAnimFrame, type TileAnimDoc } from '../../shared/msx/tile-anim'
import { swSpriteFamily } from '../../shared/msx/swsprite'
import { loadedTileset, type LoadedRoom, type LoadedTileset, type WorldDoc } from '../../shared/msx/world'

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
  /**
   * Which resources write each output file (`exportClaims`). `exportAll`
   * builds it once for the whole pass; a single export builds its own.
   */
  claims?: ExportClaims
}

function safeEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * Every `*.tiles|sprites|map|screen.json` under `root`, project-relative, sorted for deterministic order.
 *
 * Nothing whose name starts with a dot, file or folder, at any depth below the
 * root: that is where scratch copies live (`.scratch/`, an editor's backup), and
 * a copy is a resource with the same `out` as the real one — exported at every
 * build, it silently replaced the real header whenever it was the newer file.
 * Here and not in `IGNORED_DIR_NAMES`, which would also hide those folders from
 * the explorer. The root's own name is never looked at, so a project kept
 * inside a dot folder is walked as usual.
 */
export function findResourceFiles(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const entry of safeEntries(dir).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || isIgnoredName(entry.name)) continue
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(join(dir, entry.name), relative)
      else if (resourceKindOf(entry.name)) found.push(relative)
    }
  }
  walk(root, '')
  return found
}

/** Output file (`outputKey`) → the resources that write it, project-relative. */
export type ExportClaims = Map<string, string[]>

/**
 * The form two output paths are compared in: normalized (`./`, doubled or back
 * slashes), and without case on Windows, where `Content/A.h` is `content/a.h`.
 * Null for a path that escapes the project — its export fails on that anyway.
 */
export function outputKey(path: string, platform: NodeJS.Platform = process.platform): string | null {
  const safe = resolveRelativePath(path)
  if (!safe) return null
  return platform === 'win32' ? safe.toLowerCase() : safe
}

/** Every file an export block writes: its `out`, and for C the `.c` beside it. */
function exportOutputs(block: ExportBlock): string[] {
  return block.format === 'bin' ? [block.out] : [block.out, sourcePathFor(block.out)]
}

/**
 * Which resources write each output file. A resource that will not parse, or
 * has no export target, claims nothing — its own export says why.
 */
export function exportClaims(root: string, relatives: readonly string[] = findResourceFiles(root)): ExportClaims {
  const claims: ExportClaims = new Map()
  for (const relative of relatives) {
    const abs = insideRoot(root, relative)
    if (!abs) continue
    let block: ExportBlock | null
    try {
      block = parseResource(relative, readFileSync(abs, 'utf-8')).doc.export
    } catch {
      continue
    }
    if (!block?.out) continue
    for (const key of new Set(exportOutputs(block).map((path) => outputKey(path)))) {
      if (key === null) continue
      claims.set(key, [...(claims.get(key) ?? []), relative])
    }
  }
  return claims
}

/**
 * Why `relative` may not write `block`'s files, or null when it may: some
 * other resource writes one of them too. Whichever ran second would overwrite
 * the first, and the build would compile whichever header happened to be
 * newer — so none of them is exported, and each says who the others are.
 * `relative` itself need not be among the claimants: a copy in a dot folder,
 * exported by name, still collides with the resource it was copied from.
 */
function claimConflict(relative: string, block: ExportBlock, claims: ExportClaims): string | null {
  const self = outputKey(relative)
  const clashes: string[] = []
  const claimants = new Set<string>([relative])
  for (const path of exportOutputs(block)) {
    const key = outputKey(path)
    const rivals = (key === null ? [] : (claims.get(key) ?? [])).filter((claimant) => outputKey(claimant) !== self)
    if (!rivals.length) continue
    clashes.push(path)
    for (const rival of rivals) claimants.add(rival)
  }
  if (!clashes.length) return null
  const names = [...claimants].sort()
  return (
    `${names.join(', ')} all export to ${clashes.join(' and ')}, so each would overwrite the others — ` +
    'none of them is exported until each has its own "out"'
  )
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
  // A world embeds its rooms, and each room follows its tileset's renumbering
  // and says whether that tileset is banked.
  if (resource.kind === 'world') {
    for (const path of new Set(resource.doc.cells)) {
      if (!path) continue
      paths.push(path)
      const room = resource.rooms?.get(path)
      if (room?.doc.tileset) paths.push(room.doc.tileset)
    }
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

/**
 * Reads every room a world places, the way a map's own export would see it:
 * in its tileset's current numbering — and what the world's ready-made C needs
 * to know about that tileset to load it through its own export. A room that
 * cannot be read is left out, and `validateWorld` names it.
 */
export function loadWorldRooms(root: string, doc: WorldDoc): Map<string, LoadedRoom> {
  const rooms = new Map<string, LoadedRoom>()
  const tilesets = new Map<string, LoadedTileset | undefined>()
  const tilesetOf = (path: string): LoadedTileset | undefined => {
    if (!tilesets.has(path)) {
      const tiles = readTileset(root, path)
      tilesets.set(path, tiles ? loadedTileset(path, tiles) : undefined)
    }
    return tilesets.get(path)
  }
  for (const path of new Set(doc.cells)) {
    if (!path) continue
    const abs = insideRoot(root, path)
    if (!abs || !existsSync(abs)) continue
    try {
      const text = readFileSync(abs, 'utf-8')
      const parsed = parseResource(path, text)
      if (parsed.kind !== 'map') continue
      replayTilesetLog(root, parsed, text)
      const tileset = parsed.doc.tileset ? tilesetOf(parsed.doc.tileset) : undefined
      rooms.set(path, { doc: parsed.doc, banked: tileset?.banked === true, ...(tileset ? { tileset } : {}) })
    } catch {
      // Unreadable: reported by validation as a room that could not be read.
    }
  }
  return rooms
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
    const path = (resource.doc as MapDoc).tileset
    const read = readTileset(root, path)
    tileset = read ? refreshTileset(root, read, path).doc : null
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

/** Whether a tileset's export emits `_Animate()`, which names every attached window's pose tables. */
function emitsAnimate(doc: TilesDoc): boolean {
  return doc.export?.format === 'c' && doc.export.helpers === true
}

/**
 * Why the poses of something attached to a tileset — an animation, or a
 * meta-tile that animates — cannot go out with the tileset's export, or null.
 *
 * The poses are only ever written to the attached file's *own* export: the
 * tileset carries the window, never a copy of the pose bytes (one per tileset
 * the file is attached to would cost ROM for nothing). So no export target
 * means the poses reach no header at all — `_Animate()` cannot link, and with
 * no ready-made C a custom loader has nothing to read. And `_Animate()` reads
 * them as C symbols (`<name>_Patterns`, …), which a raw binary never defines;
 * without it a binary is fine, a custom loader can read one.
 */
function posesProblem(
  path: string,
  poses: number,
  block: ExportBlock | null,
  tileset: TilesDoc,
  tilesetPath: string,
  editor: string
): string | null {
  const animate = emitsAnimate(tileset)
  const fix = `(Export in the ${editor}'s side panel, or "export": {…} in the file)`
  if (!block?.out) {
    const lost = animate ? `${tilesetPath}'s _Animate() cannot link` : 'the game has nothing to play them from'
    return (
      `${path} has ${poses} pose${poses === 1 ? '' : 's'} but no export target, so its poses are not exported and ` +
      `${lost} — give it an export target ${fix}`
    )
  }
  if (animate && block.format !== 'c') {
    return (
      `${path} exports its poses as raw binary, but ${tilesetPath}'s _Animate() reads them from a C header — ` +
      `export it as C ${fix}, or turn off ready-made C for ${tilesetPath} and play them from your own code`
    )
  }
  return null
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
function refreshTileMetas(root: string, doc: TilesDoc, tilesetPath: string): { doc: TilesDoc; problems: string[] } {
  if (!doc.metas.length) return { doc, problems: [] }
  const loaded = new Map<string, LoadedMeta>()
  const problems: string[] = []
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
      // Only a meta that animates has a window, and so poses to lose. Without
      // an export target it is not resolved at all, as before; one that only
      // exports the wrong format still resolves, so a map drawn with this
      // tileset keeps agreeing with it.
      const poses = movingCells(parsed.doc).length
        ? posesProblem(binding.path, parsed.doc.frames.length, parsed.doc.export, doc, tilesetPath, 'meta-tile editor')
        : null
      if (poses && !parsed.doc.export?.out) {
        loaded.set(binding.path, poses)
        continue
      }
      if (poses) problems.push(poses)
      loaded.set(binding.path, { meta: parsed.doc, name: parsed.doc.export?.name || defaultExport(binding.path).name })
    } catch (error) {
      loaded.set(binding.path, `Couldn't read meta-tile ${binding.path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const refreshed = refreshMetas(doc, loaded)
  return { doc: refreshed.doc, problems: [...refreshed.problems, ...problems] }
}

/** Everything attached to a tileset, re-read: its metas first (they may move windows), then its animations. */
function refreshTileset(root: string, doc: TilesDoc, tilesetPath: string): { doc: TilesDoc; problems: string[] } {
  const metas = refreshTileMetas(root, doc, tilesetPath)
  const anims = refreshAnimBindings(root, metas.doc, tilesetPath)
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
function refreshAnimBindings(root: string, tiles: TilesDoc, tilesetPath: string): { doc: TilesDoc; problems: string[] } {
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
      // Every animation is a window `_Animate()` names, one pose or many; with
      // no _Animate(), a single pose loses nothing — it is the window's art.
      const poses = parsed.doc.frames.length > 1 || emitsAnimate(doc)
        ? posesProblem(binding.path, parsed.doc.frames.length, parsed.doc.export, doc, tilesetPath, 'animated-tile editor')
        : null
      if (poses) problems.push(poses)
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

/**
 * Makes a parsed resource ready to export, and says what its export would
 * refuse — the one path every caller takes, so a check and an export cannot
 * disagree about the same file (bug report items 7 and 9: an agent was told
 * "not attached" about a map whose forced export drew the meta fine, because
 * the check validated the file as written and the export did not).
 *
 * In order: a world's rooms (unless the caller already loaded them), the
 * tileset's renumberings this file has not seen (`text` is where its stamp is
 * read from), the mirrors of other files it keeps, and validation. Before
 * validation, not just before rendering: a stale mirror also means stale
 * sizes, and "this placement hangs off the map" must be judged against the
 * meta as it is now.
 *
 * Changes `resource` in place and returns it. It is replayed: never write it
 * back over the file without moving the stamp too (`inspectResource`).
 */
export function prepareResource(
  root: string,
  relative: string,
  resource: ResourceDoc,
  text: string
): { resource: ResourceDoc; problems: string[] } {
  if (resource.kind === 'world' && !resource.rooms) resource.rooms = loadWorldRooms(root, resource.doc)
  replayTilesetLog(root, resource, text)
  refreshMapMetas(root, resource)
  let attachedProblems: string[] = []
  if (resource.kind === 'tiles') {
    const refreshed = refreshTileset(root, resource.doc, relative)
    resource.doc = refreshed.doc
    attachedProblems = refreshed.problems
  }
  const problems =
    resource.kind === 'map'
      ? validateMap(resource.doc, mapValidateOptions(root, resource.doc))
      : [...attachedProblems, ...validateResource(resource)]
  return { resource, problems }
}

/**
 * A resource as an agent should see it (MCP `read_resource`/`write_resource`):
 * the problems its export would report, and the document with the mirrors it
 * keeps of other files brought up to date — so a map's `metas` entry written by
 * hand comes back, and is saved, resolved from the meta and its attachment.
 *
 * The problems include another resource writing the same file
 * (`claimConflict`), which `exportResourceFile` checks before it gets as far as
 * `prepareResource`: judged on `text`'s export block, against what the other
 * files on disk claim — so `write_resource` hears about the clash it is about to
 * save, and `read_resource` about the one `export_resources` would refuse.
 *
 * The document is **not** replayed into the tileset's current numbering, unlike
 * the one the problems were judged on: its stamp is not part of it, and a grid
 * renumbered under an old stamp would be renumbered again by the next replay.
 */
export function inspectResource(root: string, relative: string, text: string): { resource: ResourceDoc; problems: string[] } {
  const resource = parseResource(relative, text)
  const block = resource.doc.export
  const conflict = block?.out ? claimConflict(relative, block, exportClaims(root)) : null
  const { problems } = prepareResource(root, relative, parseResource(relative, text), text)
  refreshMapMetas(root, resource)
  return { resource, problems: conflict ? [conflict, ...problems] : problems }
}

/** Converts one editor resource into the file its `export` block names. */
export function exportResourceFile(root: string, relative: string, options: ExportOptions = {}): ConversionResult {
  const sourceAbs = insideRoot(root, relative)
  const base: ConversionResult = { kind: 'resource', input: relative, out: '', status: 'failed' }
  if (!sourceAbs) return { ...base, message: 'Path escapes the project folder.' }

  try {
    const text = readFileSync(sourceAbs, 'utf-8')
    const resource = parseResource(relative, text)
    // Before the up-to-date check: what a world depends on is its rooms' tilesets.
    if (resource.kind === 'world') resource.rooms = loadWorldRooms(root, resource.doc)
    const block = resource.doc.export
    if (!block?.out) return { ...base, status: 'skipped', message: 'No export target set.' }

    const outAbs = insideRoot(root, block.out)
    if (!outAbs) return { ...base, out: block.out, message: 'Output path escapes the project folder.' }
    // Before the up-to-date check too: a duplicate whose header is newer than
    // both resources is still a duplicate, and the header may be the wrong one.
    const conflict = claimConflict(relative, block, options.claims ?? exportClaims(root))
    if (conflict) return { ...base, out: block.out, message: conflict }
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

    const { problems } = prepareResource(root, relative, resource, text)
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
  const relatives = findResourceFiles(root)
  const claims = options.claims ?? exportClaims(root, relatives)
  const results = relatives.map((relative) => exportResourceFile(root, relative, { ...options, claims }))
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

/**
 * Every failed conversion as an error for the Problems panel. The build goes on
 * after one — MSXgl reports a header that is missing — but one that is merely
 * stale compiles cleanly, so the output channel alone left the failure where
 * nobody looks (bug report item 4). `r<n>`, so they never share an id with the
 * build's own `p<n>`. `file` only when the input is inside the project, which is
 * what lets the panel open it.
 */
export function conversionProblems(results: readonly ConversionResult[]): BuildProblem[] {
  return results
    .filter((result) => result.status === 'failed')
    .map((result, index) => {
      const file = resolveRelativePath(result.input)
      return {
        id: `r${index}`,
        severity: 'error' as const,
        ...(file ? { file } : {}),
        message: result.message || 'Export failed.'
      }
    })
}

/** One-line summary for the Output panel. */
export function summarize(results: readonly ConversionResult[]): string {
  const count = (status: ConversionStatus): number => results.filter((result) => result.status === status).length
  return `Resources: ${count('converted')} converted, ${count('skipped')} up to date, ${count('failed')} failed.`
}
