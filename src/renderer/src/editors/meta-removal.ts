/**
 * Removing a meta-tile from a tileset, and from the maps that place it.
 *
 * A map can only place a meta its tileset has attached — the export refuses
 * one that is not — so detaching alone would leave every map that placed it
 * unbuildable. The maps follow instead: each drops the meta and its
 * placements, an open one as an undoable edit in its tab, a closed one
 * rewritten on disk.
 *
 * The meta's tiles go with it (`removeMeta`), except those something else
 * still shows: a baked placement's cells, a map's painted grid, a block,
 * another meta. Dropping a tile renumbers the ones above it, so the mapping
 * goes out on the reorder seam — live for open files, logged for the tileset.
 * When the tileset is saved with the removal, closed maps drawn with it are
 * rewritten in the new numbering here too, since the exporter does not replay
 * the log; otherwise they replay it when they next open.
 *
 * Here rather than in either session because both the tile editor and the
 * meta-tile's own editor start it, and the map session already imports the
 * tile session: open maps hear about it as an event (`onMetaRemoved`) and
 * report themselves through `provideOpenMaps`, not through an import.
 */

import { normalizeMap, removeMetaRef, type MapDoc } from '../../../shared/msx/map'
import type { RemovedMeta } from '../../../shared/msx/meta-owned'
import { replayReorders, samePath } from '../../../shared/map-editor'
import { serializeResource } from '../../../shared/msx/resource'
import { emitTilesReordered, type TilesReorderEvent } from '../../../shared/tile-editor'
import { useResourcesStore } from '../stores/resourcesStore'
import { useTilesetStore } from '../stores/tilesetStore'

export interface MetaRemovedEvent {
  /** The tileset it was removed from. */
  tileset: string
  /** The meta-tile's file. */
  path: string
  /**
   * The tileset is being saved with the removal, so an open map with nothing
   * else unsaved saves too — its file would otherwise place a meta the
   * tileset's file no longer has, and the next build would refuse it.
   */
  persist: boolean
  /**
   * The open maps drawn with the tileset that had nothing unsaved before the
   * removal began — the ones `persist` saves. Taken up front, because the
   * renumbering has already made them dirty by the time this is heard.
   */
  clean: string[]
}

type Listener = (event: MetaRemovedEvent) => void

const listeners = new Set<Listener>()

export function onMetaRemoved(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

interface OpenMap {
  path: string
  doc: MapDoc
  dirty: boolean
}

/** The maps open in tabs; none until the map session registers itself. */
let openMaps: () => OpenMap[] = () => []

export function provideOpenMaps(provider: () => OpenMap[]): void {
  openMaps = provider
}

type SavedMap = MapDoc & { tilesetReorderSeen?: number }

interface MapUse {
  path: string
  /** Where the meta sits in its `metas`, or -1 when it does not know it. */
  slot: number
  placements: number
  /** A closed map: the file's own text, read once, rewritten from. */
  raw: SavedMap | null
}

const fileName = (path: string): string => path.split('/').pop() ?? path

function slotIn(doc: MapDoc, meta: string): number {
  return doc.metas.findIndex((ref) => samePath(ref.path, meta))
}

function placementsOf(doc: MapDoc, slot: number): number {
  return doc.layers.reduce((count, layer) => count + layer.placements.filter((placement) => placement.slot === slot).length, 0)
}

/** The tiles a map's grid shows — baked placements included, since baking writes them there. */
const gridTiles = (doc: MapDoc): number[] => doc.layers.flatMap((layer) => (layer.kind === 'tiles' ? layer.data : []))

/**
 * Every map drawn with `tileset`, with where it knows the meta — placing it
 * or not, since a reference alone is enough to fail the export once it is
 * detached — and every tile their grids show. A closed map is read in the
 * tileset's current numbering (`replayReorders`), as it would open.
 */
async function mapsDrawnWith(tileset: string, meta: string): Promise<{ maps: MapUse[]; used: Set<number> }> {
  const maps: MapUse[] = []
  const used = new Set<number>()
  const take = (path: string, doc: MapDoc, raw: SavedMap | null): void => {
    const slot = slotIn(doc, meta)
    maps.push({ path, slot, placements: slot >= 0 ? placementsOf(doc, slot) : 0, raw })
    for (const tile of gridTiles(doc)) used.add(tile)
  }
  const open = openMaps()
  for (const map of open) if (samePath(map.doc.tileset, tileset)) take(map.path, map.doc, null)
  const resources = useResourcesStore()
  await resources.refresh()
  const log = useTilesetStore().reorderLog(tileset)
  for (const entry of resources.entries) {
    if (entry.kind !== 'map' || open.some((map) => samePath(map.path, entry.path))) continue
    const text = await window.api.invoke('fs:read', { path: entry.path })
    const raw = (text.trim() ? JSON.parse(text) : {}) as SavedMap
    const doc = normalizeMap(raw)
    if (!samePath(doc.tileset, tileset)) continue
    const seen = typeof raw.tilesetReorderSeen === 'number' ? raw.tilesetReorderSeen : null
    take(entry.path, replayReorders(doc, log, seen).doc, raw)
    // Without a stamp it may be new or may be behind — keep what either reading shows.
    if (seen === null) for (const tile of gridTiles(doc)) used.add(tile)
  }
  return { maps, used }
}

/**
 * Removes `meta` from `tileset`, its tiles from the tileset, and it from every
 * map drawn with it.
 *
 * Asks first when a map places it, naming them — a closed map is rewritten on
 * disk, which no undo reaches. `detach` is the tileset's half: given the tiles
 * the maps show, it runs `removeMeta` and keeps the result (one undo step in a
 * tile editor), returning it, or null when there was nothing to detach. It
 * runs once the user has agreed and before any map changes. `persist` says the
 * caller saves the tileset afterwards (see `MetaRemovedEvent.persist`).
 * `confirmed` says the caller already asked about this removal, so it is not
 * asked again.
 *
 * Returns the status line to show, or null when the user declined.
 */
export async function removeMetaFromTileset(
  tileset: string,
  meta: string,
  detach: (used: ReadonlySet<number>) => RemovedMeta | null,
  { persist = false, confirmed = false }: { persist?: boolean; confirmed?: boolean } = {}
): Promise<string | null> {
  let maps: MapUse[]
  let used: Set<number>
  try {
    ;({ maps, used } = await mapsDrawnWith(tileset, meta))
  } catch (error) {
    return `Couldn't check the maps drawn with ${fileName(tileset)}, so nothing was removed: ${String(error)}`
  }
  const uses = maps.filter((map) => map.slot >= 0)
  const placements = uses.reduce((count, use) => count + use.placements, 0)
  const names = uses.map((use) => fileName(use.path)).join(', ')
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
  if (
    uses.length &&
    !confirmed &&
    !window.confirm(
      `Remove ${fileName(meta)} from ${fileName(tileset)}? ${names} ${uses.length === 1 ? 'uses' : 'use'} it, and ` +
        `${placements === 1 ? 'its placement goes' : `its ${placements} placements go`} with it — a map cannot place a ` +
        `meta-tile its tileset does not have. Its tiles go too, except those a map still shows.`
    )
  ) {
    return null
  }
  const clean = openMaps()
    .filter((map) => !map.dirty && samePath(map.doc.tileset, tileset))
    .map((map) => map.path)
  const result = detach(used)
  if (!result) return `${fileName(meta)} is not attached to ${fileName(tileset)}.`

  if (result.mapping) {
    const event: TilesReorderEvent = { path: tileset, mapping: result.mapping, at: Date.now() }
    useTilesetStore().appendReorder(tileset, event)
    emitTilesReordered(event)
  }
  for (const listener of [...listeners]) listener({ tileset, path: meta, persist, clean })

  // A closed map takes the renumbering on disk only when the tileset is saved
  // with it — otherwise its stamp would point past a log the tileset's file
  // may never get — and only when it has a stamp: one without could be new,
  // or never opened since an old reorder, and only the open-time confirm
  // asks which. The rest replay it from the log when they next open.
  const failed: string[] = []
  const log = useTilesetStore().reorderLog(tileset)
  for (const map of maps) {
    const seen = typeof map.raw?.tilesetReorderSeen === 'number' ? map.raw.tilesetReorderSeen : null
    const renumber = result.mapping !== null && persist && seen !== null
    if (!map.raw || (map.slot < 0 && !renumber)) continue
    let doc = normalizeMap(map.raw)
    let seenAt = seen
    if (renumber) ({ doc, seenAt } = replayReorders(doc, log, seen))
    if (map.slot >= 0) doc = removeMetaRef(doc, slotIn(doc, meta))
    const content: SavedMap = { ...doc }
    // A sibling key, like the tileset's reorder log: dropping it would replay
    // every reorder again the next time the map opens.
    if (seenAt !== null) content.tilesetReorderSeen = seenAt
    try {
      await window.api.invoke('fs:write', { path: map.path, content: serializeResource({ kind: 'map', doc: content }) })
    } catch {
      failed.push(fileName(map.path))
    }
  }

  const removed = uses.length
    ? ` and ${placements ? `${plural(placements, 'placement')} from` : 'it from'} ${names}`
    : ''
  const tiles = result.removed
    ? ` ${plural(result.removed, 'tile')} went with it; the tiles above them moved down.`
    : result.refused
      ? ` Its tiles stay as art: ${result.refused}`
      : ' Its tiles stay — something else still shows them.'
  const problem = failed.length ? ` Couldn't write ${failed.join(', ')} — fix it there by hand.` : ''
  return `Removed ${fileName(meta)} from ${fileName(tileset)}${removed}.${tiles}${problem}`
}
