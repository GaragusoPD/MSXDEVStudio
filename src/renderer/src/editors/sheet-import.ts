/**
 * Applying a sheet import (`components/SheetImportDialog.vue`) to where it
 * goes: a new file, or one that exists — then through its own editor, so the
 * import is one undo step there and the tab shows it unsaved, like any edit.
 *
 * The rules — what a cell becomes in each kind of resource — are in
 * `shared/msx/sheet-convert.ts`. This is the wiring: which file, which
 * session, which tab, and the line that says what happened.
 */

import { watch } from 'vue'
import { normalizeMap, type MapDoc } from '../../../shared/msx/map'
import { isOwnedMeta, normalizeOwnedMeta, type OwnedMetaDoc } from '../../../shared/msx/meta-owned'
import type { TileMode } from '../../../shared/msx/modes'
import type { Rgb } from '../../../shared/msx/palette'
import {
  defaultExport,
  parseResource,
  RESOURCE_DIR,
  RESOURCE_SUFFIXES,
  resourceKindOf,
  serializeResource,
  type ResourceDoc,
  type ResourceKind
} from '../../../shared/msx/resource'
import {
  cellsToBitmapMeta,
  cellsToBitmapTiles,
  cellsToOwnedMeta,
  cellsToSprite,
  cellsToSwSprite,
  cellsToTileAnim,
  cellsToTiles,
  layoutCells,
  selectionPicture,
  unusedEntries,
  type SheetCell
} from '../../../shared/msx/sheet-convert'
import { createSpritesDoc, type SpriteCharacter, type SpriteMode, type SpriteSize, type SpritesDoc } from '../../../shared/msx/sprite'
import { createBitmapTilesDoc, normalizeBitmapTiles, sheetCols, tilePixels as bitmapTilePixels, type BitmapTilesDoc } from '../../../shared/msx/bitmap-tile'
import type { MetaTileDoc } from '../../../shared/msx/meta-tile'
import { MODES, type BitmapMode, type ScreenMode } from '../../../shared/msx/modes'
import { MSX1_PALETTE_GRB } from '../../../shared/msx/palette'
import { screenPixels } from '../../../shared/msx/screen'
import { normalizeSwSprites, swFramePixels, type SwMode, type SwSpriteChar, type SwSpritesDoc } from '../../../shared/msx/swsprite'
import type { TileAnimDoc } from '../../../shared/msx/tile-anim'
import { createTilesDoc, TILE_SIZE, type TilesDoc } from '../../../shared/msx/tile'
import { useResourcesStore } from '../stores/resourcesStore'
import { useTabsStore } from '../stores/tabsStore'
import { useTilesetStore } from '../stores/tilesetStore'
import { animSession, commit as commitPoses, doc as posesOf } from './anim/session'
import { floatPicture, mapSession } from './map/session'
import { commit as commitSprites, doc as spritesOf, spriteSession } from './sprite/session'
import { commit as commitTiles, tileSession } from './tile/session'
import { bitmapTileSession, commit as commitBitmapTiles, doc as bitmapDocOf } from './btiles/session'
import { commit as commitMeta, doc as metaDocOf, metaSession } from './meta/session'
import { importImage as floatOnScreen, screenSession } from './screen/session'
import { commit as commitSwSprites, doc as swSpritesOf, swSpriteSession } from './swsprites/session'

export type SheetDestination = 'tiles' | 'map' | 'anim' | 'meta' | 'sprites' | 'btiles' | 'metab' | 'swsprites' | 'screen'

/** The resource kind each destination writes. */
export const DESTINATION_KIND: Readonly<Record<SheetDestination, ResourceKind>> = {
  tiles: 'tiles',
  map: 'map',
  anim: 'anim',
  meta: 'metatiles',
  sprites: 'sprites',
  btiles: 'btiles',
  metab: 'metabtiles',
  swsprites: 'swsprites',
  screen: 'screen'
}

/** The destinations that take an MSX2 bitmap mode's colours — or SCREEN 3's, or a software sprite's. */
export const BITMAP_DESTINATIONS: readonly SheetDestination[] = ['btiles', 'metab', 'swsprites', 'screen']

/** The destination a file is, by its suffix — what an editor opens the dialog for. */
export function destinationOf(path: string): SheetDestination | null {
  const kind = resourceKindOf(path)
  const found = (Object.keys(DESTINATION_KIND) as SheetDestination[]).find((destination) => DESTINATION_KIND[destination] === kind)
  return found ?? null
}

/** What converting for an existing file has to respect. */
export interface TargetInfo {
  /**
   * The mode the cells must be converted for: a tile mode for the pattern
   * destinations, the file's own mode for the MSX2 ones.
   */
  mode: ScreenMode | null
  /** A palette the conversion must use: an sc4 tileset's, an MSX2 sheet's, a screen's. */
  palette: number[] | null
  /** Entries of `palette` nothing is drawn with yet, which the conversion may refill. */
  freeEntries: number[]
  /** An animated tile's or meta-tile's size in tiles — new poses must match it. */
  size: { width: number; height: number } | null
  /** A bitmap tileset's tile size in dots — cells are cut into tiles of it. */
  tileSize: { width: number; height: number } | null
  /** A bitmap meta-tile's tileset. */
  tileset: string | null
  /** A software-sprite sheet's transparent index. */
  transparent: number
  sprite: { mode: SpriteMode; size: SpriteSize } | null
  /** Why this file cannot take a sheet; nothing else is set. */
  error?: string
}

const fileName = (path: string): string => path.split('/').pop() ?? path
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** A name safe as a file stem and a C identifier part. */
export function sheetName(raw: string): string {
  return raw.replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'sheet'
}

/** Where a new resource of `kind` named `name` goes. */
export function newPath(kind: ResourceKind, name: string): string {
  return `${RESOURCE_DIR}/${sheetName(name)}${RESOURCE_SUFFIXES[kind]}`
}

/** A tileset as open editors see it — unsaved edits included — or as the file has it. */
async function readTileset(path: string): Promise<TilesDoc | null> {
  const held = useTilesetStore().patternDoc(path)
  if (held) return held
  const parsed = parseResource(path, await window.api.invoke('fs:read', { path }))
  return parsed.kind === 'tiles' ? parsed.doc : null
}

/** The same for a bitmap tileset. */
async function readBitmapTileset(path: string): Promise<BitmapTilesDoc | null> {
  const held = useTilesetStore().bitmapDoc(path)
  if (held) return held
  const parsed = parseResource(path, await window.api.invoke('fs:read', { path }))
  return parsed.kind === 'btiles' ? parsed.doc : null
}

/** A programmable palette, and the entries of it nothing in `drawn` uses. */
function paletteOf(mode: ScreenMode, palette: number[] | null, drawn: ArrayLike<number>[]): { palette: number[] | null; freeEntries: number[] } {
  if (MODES[mode].palette !== 'grb333' || !palette) return { palette: null, freeEntries: [] }
  return { palette, freeEntries: unusedEntries(drawn, palette.length) }
}

/** Reads an existing destination for what the conversion has to fit. */
export async function describeTarget(destination: SheetDestination, path: string): Promise<TargetInfo> {
  const none: TargetInfo = { mode: null, palette: null, freeEntries: [], size: null, tileSize: null, tileset: null, transparent: 0, sprite: null }
  try {
    if (destination === 'btiles' || destination === 'metab') {
      // A bitmap meta-tile converts for the tileset it is drawn with.
      let tileset = path
      let size: TargetInfo['size'] = null
      if (destination === 'metab') {
        const parsed = parseResource(path, await window.api.invoke('fs:read', { path }))
        if (parsed.kind !== 'metabtiles') return { ...none, error: `${fileName(path)} is not a bitmap meta-tile.` }
        if (resourceKindOf(parsed.doc.tileset) !== 'btiles') {
          return { ...none, error: `${fileName(path)} is not drawn with a bitmap tileset (.btiles.json) — set one in its editor first.` }
        }
        tileset = parsed.doc.tileset
        size = { width: parsed.doc.width, height: parsed.doc.height }
      }
      const tiles = await readBitmapTileset(tileset)
      if (!tiles) return { ...none, error: `Couldn't read ${tileset}.` }
      return {
        ...none,
        mode: tiles.mode,
        ...paletteOf(tiles.mode, tiles.palette, [bitmapTilePixels(tiles)]),
        size,
        tileSize: { width: tiles.width, height: tiles.height },
        tileset
      }
    }
    if (destination === 'tiles') {
      const tiles = await readTileset(path)
      if (!tiles) return { ...none, error: `${fileName(path)} is not a tileset.` }
      return { ...none, mode: tiles.mode, palette: tiles.palette }
    }
    const parsed = parseResource(path, await window.api.invoke('fs:read', { path }))
    if (destination === 'map' && parsed.kind === 'map') {
      if (!parsed.doc.tileset || resourceKindOf(parsed.doc.tileset) !== 'tiles') {
        return { ...none, error: `${fileName(path)} is not drawn with a pattern tileset — sheets go onto SCREEN 1, 2 and 4 maps.` }
      }
      const tiles = await readTileset(parsed.doc.tileset)
      if (!tiles) return { ...none, error: `Couldn't read ${parsed.doc.tileset}.` }
      return { ...none, mode: tiles.mode, palette: tiles.palette }
    }
    if ((destination === 'anim' && parsed.kind === 'anim') || (destination === 'meta' && parsed.kind === 'metatiles')) {
      return { ...none, mode: parsed.doc.mode, size: { width: parsed.doc.width, height: parsed.doc.height } }
    }
    if (destination === 'sprites' && parsed.kind === 'sprites') {
      return { ...none, palette: parsed.doc.palette, sprite: { mode: parsed.doc.mode, size: parsed.doc.size } }
    }
    if (destination === 'swsprites' && parsed.kind === 'swsprites') {
      const sheet = parsed.doc
      const drawn = sheet.sprites.map((_, i) => Array.from({ length: sheet.sprites[i].frames }, (__, f) => swFramePixels(sheet, i, f))).flat()
      return { ...none, mode: sheet.mode, ...paletteOf(sheet.mode, sheet.palette, drawn), transparent: sheet.transparent }
    }
    if (destination === 'screen' && parsed.kind === 'screen') {
      const pixels = screenPixels(parsed.doc)
      return { ...none, mode: parsed.doc.mode, ...paletteOf(parsed.doc.mode, parsed.doc.converted?.palette ?? null, pixels ? [pixels.indices] : []) }
    }
    return { ...none, error: `${fileName(path)} is not that kind of resource.` }
  } catch (error) {
    return { ...none, error: `Couldn't read ${path}: ${String(error)}` }
  }
}

export interface SheetImport {
  destination: SheetDestination
  /** Add to this file; null makes a new one, named after `name`. */
  target: string | null
  name: string
  /** The tile mode the cells were converted for (pattern destinations). */
  mode: TileMode
  /** The mode a new bitmap tileset or software-sprite sheet is made in. */
  bitmapMode: BitmapMode | SwMode
  /** A new bitmap meta-tile's tileset. */
  tileset: string | null
  /** A new sprite sheet's sprite mode and size. */
  sprite: { mode: SpriteMode; size: SpriteSize }
  /** Converted, in reading order. */
  cells: SheetCell[]
  /** Where each cell sits on the sheet, in cells. */
  at: { col: number; row: number }[]
  /** Indices into `cells`, one group per animation or character — one per row, or all in one. */
  groups: number[][]
  /** The conversion's GRB333 palette, when the mode has one. */
  palette: number[] | null
  /** The conversion's palette as RGB. */
  rgb: Rgb[]
  /** Tileset: a named block per cell. */
  blocks: boolean
  /** New tileset: a map beside it laying the cells out as on the sheet. */
  withMap: boolean
  /** Frames each pose is held. */
  duration: number
  /** Sprites: planes per cell at most. */
  maxPlanes: number
}

/** What happened: a line for the dialog, and whether it was a refusal. */
export interface SheetImportOutcome {
  status: string
  failed?: boolean
}

const failed = (status: string): SheetImportOutcome => ({ status, failed: true })

/** Resolves once an editor session has read its file. */
function loaded(session: { loading: boolean }): Promise<void> {
  if (!session.loading) return Promise.resolve()
  return new Promise((resolve) => {
    const stop = watch(
      () => session.loading,
      (loading) => {
        if (loading) return
        stop()
        resolve()
      }
    )
  })
}

async function exists(path: string): Promise<boolean> {
  return Boolean(await window.api.invoke('fs:stat', { path }))
}

/** Writes new files, refusing to overwrite any; all are checked before any is written. */
async function writeNew(resources: { path: string; resource: ResourceDoc }[]): Promise<string | null> {
  for (const { path } of resources) if (await exists(path)) return `${path} already exists — pick another name, or add to it instead.`
  await window.api.invoke('fs:create', { path: RESOURCE_DIR, kind: 'directory' })
  for (const { path, resource } of resources) {
    resource.doc.export = defaultExport(path)
    await window.api.invoke('fs:write', { path, content: serializeResource(resource) })
  }
  await useResourcesStore().refresh()
  return null
}

function openTab(path: string): void {
  useTabsStore().openFile(path, fileName(path))
}

/** The cells of each group, and a name per group: the base name alone, or numbered when there are several. */
function grouped(request: SheetImport): { cells: SheetCell[]; name: string }[] {
  const base = sheetName(request.name)
  return request.groups
    .filter((group) => group.length)
    .map((group, g, all) => ({ cells: group.map((i) => request.cells[i]), name: all.length > 1 ? `${base}_${g + 1}` : base }))
}

/** Applies the import; never throws — a refusal comes back as the outcome. */
export async function applySheetImport(request: SheetImport): Promise<SheetImportOutcome> {
  if (!request.cells.length) return failed('Select at least one cell.')
  try {
    switch (request.destination) {
      case 'tiles':
        return await importTiles(request)
      case 'map':
        return await importMap(request)
      case 'anim':
      case 'meta':
        return await importPoses(request)
      case 'sprites':
        return await importSprites(request)
      case 'btiles':
        return await importBitmapTiles(request)
      case 'metab':
        return await importBitmapMeta(request)
      case 'swsprites':
        return await importSwSprites(request)
      case 'screen':
        return await importScreen(request)
    }
  } catch (error) {
    return failed(`The import failed: ${String(error)}`)
  }
}

// ── tileset ─────────────────────────────────────────────────────────────────

async function importTiles(request: SheetImport): Promise<SheetImportOutcome> {
  const base = sheetName(request.name)
  const describe = (added: number, reused: number, lossy: number): string =>
    `${plural(request.cells.length, 'cell')}: ${plural(added, 'new tile')}, ${reused} reused` +
    (lossy ? `, ${plural(lossy, 'tile')} drawn with two colours a row where the art had more` : '')

  if (request.target) {
    openTab(request.target)
    const session = tileSession(request.target)
    await loaded(session)
    if (session.error) return failed(session.error)
    const names = request.blocks ? request.cells.map((_, i) => `${base}_${session.doc.blocks.length + i}`) : null
    const result = cellsToTiles(session.doc, request.cells, names)
    if (result.refused) return failed(result.refused)
    commitTiles(session, result.doc, 'import sheet')
    session.status = `Imported ${describe(result.added, result.reused, result.lossy)}.`
    return { status: `${session.status} ${fileName(request.target)} is open, unsaved.` }
  }

  const path = newPath('tiles', base)
  const fresh: TilesDoc = { ...createTilesDoc(request.mode, 1, true), palette: request.mode === 'sc4' ? request.palette : null }
  const names = request.blocks ? request.cells.map((_, i) => `${base}_${i}`) : null
  const result = cellsToTiles(fresh, request.cells, names)
  if (result.refused) return failed(result.refused)
  const files: { path: string; resource: ResourceDoc }[] = [{ path, resource: { kind: 'tiles', doc: result.doc } }]
  const mapPath = newPath('map', base)
  if (request.withMap) {
    const first = request.cells[0]
    const layout = layoutCells(result.cellTiles, request.at, Math.ceil(first.width / TILE_SIZE), Math.ceil(first.height / TILE_SIZE))
    const map: MapDoc = normalizeMap({
      tileset: path,
      width: layout.width,
      height: layout.height,
      layers: [{ name: 'background', data: layout.tiles }]
    })
    files.push({ path: mapPath, resource: { kind: 'map', doc: map } })
  }
  const refused = await writeNew(files)
  if (refused) return failed(refused)
  openTab(path)
  if (request.withMap) openTab(mapPath)
  return { status: `Created ${fileName(path)}${request.withMap ? ` and ${fileName(mapPath)}` : ''} — ${describe(result.added, result.reused, result.lossy)}.` }
}

// ── map ─────────────────────────────────────────────────────────────────────

async function importMap(request: SheetImport): Promise<SheetImportOutcome> {
  if (!request.target) return failed('Pick the map to place the cells on.')
  openTab(request.target)
  const session = mapSession(request.target)
  await loaded(session)
  if (session.error) return failed(session.error)
  if (!session.tileset) return failed(`${fileName(request.target)} is not drawn with a pattern tileset.`)
  const picture = selectionPicture(request.cells, request.at)
  floatPicture(session, { ...picture, rgb: request.rgb }, request.mode)
  return session.float ? { status: `The cells float over ${fileName(request.target)} — drag them into place and press Enter.` } : failed(session.status)
}

// ── animated tiles and meta-tiles ───────────────────────────────────────────

/** True for a pose document nobody has drawn in yet: one pose, every tile blank. */
function untouched(doc: TileAnimDoc | OwnedMetaDoc): boolean {
  return doc.frames.length === 1 && doc.frames[0].tiles.every((tile) => tile.pattern.every((byte) => byte === 0))
}

async function importPoses(request: SheetImport): Promise<SheetImportOutcome> {
  const meta = request.destination === 'meta'
  const kind: ResourceKind = meta ? 'metatiles' : 'anim'
  const what = meta ? 'meta-tile' : 'animated tile'

  if (request.target) {
    openTab(request.target)
    const session = animSession(request.target)
    await loaded(session)
    if (session.error) return failed(session.error)
    const current = posesOf(session)
    const pair = current.mode === 'sc1' ? current.pair : undefined
    const made = meta
      ? cellsToOwnedMeta(current.mode, request.cells, request.duration, pair)
      : cellsToTileAnim(current.mode, request.cells, request.duration, pair)
    if (typeof made === 'string') return failed(made)
    if (made.doc.width !== current.width || made.doc.height !== current.height) {
      return failed(
        `${fileName(request.target)} is ${current.width}×${current.height} tiles and the cells are ${made.doc.width}×${made.doc.height}. ` +
          'Resize one of them, or import into a new file.'
      )
    }
    let next: TileAnimDoc | OwnedMetaDoc
    if (untouched(current)) {
      // A fresh file's blank pose is a placeholder, not art to keep.
      next = { ...made.doc, loop: current.loop, export: current.export, ...(isOwnedMeta(current) ? { flags: current.flags } : {}) } as typeof current
    } else {
      const frames = [...current.frames, ...made.doc.frames]
      const added = made.doc
      // A cell stays see-through only if the new poses leave it empty too.
      next = isOwnedMeta(current) && isOwnedMeta(added)
        ? normalizeOwnedMeta({ ...current, frames, holes: current.holes.map((hole, i) => hole && added.holes[i]) })
        : { ...current, frames }
    }
    commitPoses(session, next)
    session.status = `Added ${plural(made.doc.frames.length, 'pose')}${made.lossy ? ` (${plural(made.lossy, 'tile')} reduced to two colours a row)` : ''}.`
    return { status: `${session.status} ${fileName(request.target)} is open, unsaved.` }
  }

  const files: { path: string; resource: ResourceDoc }[] = []
  let lossy = 0
  for (const group of grouped(request)) {
    const made = meta
      ? cellsToOwnedMeta(request.mode, group.cells, request.duration)
      : cellsToTileAnim(request.mode, group.cells, request.duration)
    if (typeof made === 'string') return failed(`${group.name}: ${made}`)
    lossy += made.lossy
    files.push({
      path: newPath(kind, group.name),
      resource: meta ? { kind: 'metatiles', doc: made.doc as OwnedMetaDoc } : { kind: 'anim', doc: made.doc as TileAnimDoc }
    })
  }
  const refused = await writeNew(files)
  if (refused) return failed(refused)
  for (const { path } of files) openTab(path)
  const created = files.map(({ path }) => fileName(path)).join(', ')
  const attach = meta
    ? 'Attach it to a tileset from the tile editor, or place it on a map.'
    : "Attach it to a tileset from the tile editor's Animations panel."
  return {
    status:
      `Created ${plural(files.length, what)}: ${created}.${lossy ? ` ${plural(lossy, 'tile')} reduced to two colours a row.` : ''} ${attach}`
  }
}

// ── sprites ─────────────────────────────────────────────────────────────────

/** True for a sprite sheet nobody has drawn in yet: the one blank sprite a new file has. */
function blankSheet(doc: SpritesDoc): boolean {
  return (
    doc.sprites.length === 1 &&
    doc.sprites[0].frames.length === 1 &&
    doc.sprites[0].frames[0].layers.every((layer) => layer.pattern.every((byte) => byte === 0))
  )
}

function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name
  let n = 2
  while (taken.has(`${name}_${n}`)) n++
  return `${name}_${n}`
}

async function importSprites(request: SheetImport): Promise<SheetImportOutcome> {
  const session = request.target ? spriteSession(request.target) : null
  if (request.target && session) {
    openTab(request.target)
    await loaded(session)
    if (session.error) return failed(session.error)
  }
  const current = session ? spritesOf(session) : null
  const { mode, size } = current ?? request.sprite
  const replace = current ? blankSheet(current) : true
  const taken = new Set(replace || !current ? [] : current.sprites.map((sprite) => sprite.name))

  const characters: SpriteCharacter[] = []
  let worstLine = 0
  let merged = 0
  for (const group of grouped(request)) {
    const name = uniqueName(group.name, taken)
    taken.add(name)
    const made = cellsToSprite(group.cells, { mode, size, maxPlanes: request.maxPlanes, palette: request.rgb, name })
    if (typeof made === 'string') return failed(`${group.name}: ${made}`)
    characters.push(made.character)
    worstLine = Math.max(worstLine, made.spritesPerLine)
    merged += made.merged
  }
  const limit = mode === 1 ? 4 : 8
  const summary =
    `${plural(characters.length, 'character')}, ${plural(characters.reduce((n, c) => n + c.frames.length, 0), 'frame')}` +
    (merged ? `; ${plural(merged, 'dot')} given the nearest colour a plane had` : '') +
    (worstLine > limit
      ? `. Up to ${worstLine} sprites share a line — the VDP shows ${limit}; lower the planes or split the character.`
      : '.')

  if (current && session && request.target) {
    const next: SpritesDoc = { ...current, sprites: replace ? characters : [...current.sprites, ...characters] }
    commitSprites(session, next)
    session.status = `Imported ${summary}`
    return { status: `${session.status} ${fileName(request.target)} is open, unsaved.` }
  }
  const path = newPath('sprites', request.name)
  const doc: SpritesDoc = { ...createSpritesDoc(mode, size), sprites: characters, palette: mode === 2 ? request.palette : null }
  const refused = await writeNew([{ path, resource: { kind: 'sprites', doc } }])
  if (refused) return failed(refused)
  openTab(path)
  return { status: `Created ${fileName(path)} — ${summary}` }
}

// ── MSX2: bitmap tiles ──────────────────────────────────────────────────────

/**
 * A file's palette after the conversion, where its mode has one: what the
 * conversion made of it — or, converted to the fixed MSX1 colours (which come
 * back as no palette), those colours written out, since the indices were
 * chosen against them and a V9938 file has to say what they are. A file that
 * kept its own palette always gets one back.
 */
function adopt<T extends { mode: ScreenMode; palette: number[] | null }>(doc: T, palette: number[] | null): T {
  if (MODES[doc.mode].palette !== 'grb333') return doc
  return { ...doc, palette: palette ? [...palette] : [...MSX1_PALETTE_GRB] }
}

async function importBitmapTiles(request: SheetImport): Promise<SheetImportOutcome> {
  const base = sheetName(request.name)
  const describe = (added: number, reused: number): string => `${plural(request.cells.length, 'cell')}: ${plural(added, 'new tile')}, ${reused} reused`

  if (request.target) {
    openTab(request.target)
    const session = bitmapTileSession(request.target)
    await loaded(session)
    if (session.error) return failed(session.error)
    const current = bitmapDocOf(session)
    const names = request.blocks ? request.cells.map((_, i) => `${base}_${current.blocks.length + i}`) : null
    const made = cellsToBitmapTiles(adopt(current, request.palette), request.cells, names)
    if (typeof made === 'string') return failed(made)
    if (made.refused) return failed(made.refused)
    commitBitmapTiles(session, made.doc)
    session.status = `Imported ${describe(made.added, made.reused)}.`
    return { status: `${session.status} ${fileName(request.target)} is open, unsaved.` }
  }

  const mode = request.bitmapMode as BitmapMode
  const first = request.cells[0]
  const path = newPath('btiles', base)
  const fresh = adopt(
    { ...createBitmapTilesDoc(mode, first.width, first.height, 1), reserveTile0: true, transparent: 0 },
    request.palette
  )
  const names = request.blocks ? request.cells.map((_, i) => `${base}_${i}`) : null
  const made = cellsToBitmapTiles(normalizeBitmapTiles(fresh), request.cells, names)
  if (typeof made === 'string') return failed(made)
  if (made.refused) return failed(made.refused)
  const files: { path: string; resource: ResourceDoc }[] = [{ path, resource: { kind: 'btiles', doc: made.doc } }]
  const mapPath = newPath('map', base)
  if (request.withMap) {
    const layout = layoutCells(made.cellTiles, request.at, made.cols, made.rows)
    const map: MapDoc = normalizeMap({
      tileset: path,
      width: layout.width,
      height: layout.height,
      cell: { width: made.doc.width, height: made.doc.height, cols: sheetCols(made.doc), ...(mode === 'sc3' ? { sc3: true } : {}) },
      layers: [{ name: 'background', data: layout.tiles }]
    })
    files.push({ path: mapPath, resource: { kind: 'map', doc: map } })
  }
  const refused = await writeNew(files)
  if (refused) return failed(refused)
  openTab(path)
  if (request.withMap) openTab(mapPath)
  return { status: `Created ${fileName(path)}${request.withMap ? ` and ${fileName(mapPath)}` : ''} — ${describe(made.added, made.reused)}.` }
}

// ── MSX2: bitmap meta-tiles ─────────────────────────────────────────────────

async function importBitmapMeta(request: SheetImport): Promise<SheetImportOutcome> {
  const store = useTilesetStore()

  if (request.target) {
    openTab(request.target)
    const session = metaSession(request.target)
    await loaded(session)
    if (session.error) return failed(session.error)
    const tiles = store.bitmapDoc(session.tilesetPath)
    if (!tiles) return failed(session.tilesetError ?? `${fileName(request.target)} has no bitmap tileset loaded.`)
    const current = metaDocOf(session)
    const made = cellsToBitmapMeta(adopt(tiles, request.palette), session.tilesetPath, request.cells)
    if (typeof made === 'string') return failed(made)
    if (made.meta.width !== current.width || made.meta.height !== current.height) {
      return failed(
        `${fileName(request.target)} is ${current.width}×${current.height} tiles and the cells are ${made.meta.width}×${made.meta.height}. ` +
          'Resize one of them, or import into a new file.'
      )
    }
    const untouchedMeta = current.frames.length === 1 && current.frames[0].tiles.every((tile) => tile === 0)
    store.set(session.tilesetPath, made.tiles, session.path)
    commitMeta(session, { ...current, frames: untouchedMeta ? made.meta.frames : [...current.frames, ...made.meta.frames] })
    session.status = `Added ${plural(made.meta.frames.length, 'frame')}, ${plural(made.added, 'new tile')} in ${fileName(session.tilesetPath)}.`
    return { status: `${session.status} ${fileName(request.target)} is open, unsaved — saving it saves the tileset too.` }
  }

  if (!request.tileset) return failed('Pick the bitmap tileset the meta-tile is drawn with.')
  const tileset = request.tileset
  try {
    await store.load(tileset)
  } catch (error) {
    store.release(tileset)
    return failed(`Couldn't open ${tileset}: ${String(error)}`)
  }
  try {
    const tiles = store.bitmapDoc(tileset)
    if (!tiles) return failed(`${fileName(tileset)} is not a bitmap tileset.`)
    const files: { path: string; meta: MetaTileDoc }[] = []
    let next = adopt(tiles, request.palette)
    let added = 0
    for (const group of grouped(request)) {
      const made = cellsToBitmapMeta(next, tileset, group.cells)
      if (typeof made === 'string') return failed(`${group.name}: ${made}`)
      next = made.tiles
      added += made.added
      files.push({ path: newPath('metabtiles', group.name), meta: made.meta })
    }
    const wasDirty = store.isDirty(tileset)
    const refused = await writeNew(files.map(({ path, meta }) => ({ path, resource: { kind: 'metabtiles' as const, doc: meta } })))
    if (refused) return failed(refused)
    store.set(tileset, next, 'sheet-import')
    // The metas name tiles only this version of the tileset has: write it now
    // unless it holds someone else's unsaved edits, which saving would publish.
    if (!wasDirty) await store.save(tileset)
    for (const { path } of files) openTab(path)
    return {
      status:
        `Created ${files.map(({ path }) => fileName(path)).join(', ')} — ${plural(added, 'new tile')} in ${fileName(tileset)}` +
        (wasDirty ? `, which has other unsaved edits: save it to keep these.` : '.')
    }
  } finally {
    store.release(tileset)
  }
}

// ── MSX2: software sprites ──────────────────────────────────────────────────

/** True for a sheet nobody has drawn in yet: the one blank character a new file has. */
function blankSwSheet(doc: SwSpritesDoc): boolean {
  // A fresh character is zeros whatever the sheet's transparent index is.
  return (
    doc.sprites.length === 1 &&
    doc.sprites[0].frames === 1 &&
    swFramePixels(doc, 0, 0).every((value) => value === 0 || value === doc.transparent)
  )
}

async function importSwSprites(request: SheetImport): Promise<SheetImportOutcome> {
  const session = request.target ? swSpriteSession(request.target) : null
  if (request.target && session) {
    openTab(request.target)
    await loaded(session)
    if (session.error) return failed(session.error)
  }
  const current = session ? swSpritesOf(session) : null
  const mode = current?.mode ?? (request.bitmapMode as SwMode)
  const transparent = current?.transparent ?? 0
  const replace = current ? blankSwSheet(current) : true
  const taken = new Set(replace || !current ? [] : current.sprites.map((sprite) => sprite.name))
  const characters: SwSpriteChar[] = []
  for (const group of grouped(request)) {
    const name = uniqueName(group.name, taken)
    taken.add(name)
    const made = cellsToSwSprite(mode, group.cells, name, transparent)
    if (typeof made === 'string') return failed(`${group.name}: ${made}`)
    characters.push(made)
  }
  const summary = `${plural(characters.length, 'character')}, ${plural(characters.reduce((n, c) => n + c.frames, 0), 'frame')} of ${characters[0].width}×${characters[0].height}.`
  if (current && session && request.target) {
    const next = adopt({ ...current, sprites: replace ? characters : [...current.sprites, ...characters] }, request.palette)
    commitSwSprites(session, next)
    return { status: `Imported ${summary} ${fileName(request.target)} is open, unsaved.` }
  }
  const path = newPath('swsprites', request.name)
  const doc = adopt(normalizeSwSprites({ mode, transparent, sprites: characters }), request.palette)
  const refused = await writeNew([{ path, resource: { kind: 'swsprites', doc } }])
  if (refused) return failed(refused)
  openTab(path)
  return { status: `Created ${fileName(path)} — ${summary}` }
}

// ── MSX2: a screen ──────────────────────────────────────────────────────────

async function importScreen(request: SheetImport): Promise<SheetImportOutcome> {
  if (!request.target) return failed('Pick the screen to place the cells on.')
  openTab(request.target)
  const session = screenSession(request.target)
  await loaded(session)
  if (session.error) return failed(session.error)
  const picture = selectionPicture(request.cells, request.at)
  floatOnScreen(
    session,
    {
      width: picture.width,
      height: picture.height,
      indices: Uint8Array.from(picture.indices as ArrayLike<number>),
      palette: request.palette,
      rgb: request.rgb,
      report: { colorsUsed: 0, colorsMerged: 0, rowsAltered: 0, pixelsChanged: 0 }
    },
    0
  )
  return session.float ? { status: `The cells float over ${fileName(request.target)} — drag them into place and press Enter.` } : failed(session.status)
}
