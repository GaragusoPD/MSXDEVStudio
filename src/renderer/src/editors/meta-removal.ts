/**
 * Removing a meta-tile from a tileset, and from the maps that place it.
 *
 * A map can only place a meta its tileset has attached — the export refuses
 * one that is not — so detaching alone would leave every map that placed it
 * unbuildable. The maps follow instead: each drops the meta and its
 * placements, an open one as an undoable edit in its tab, a closed one
 * rewritten on disk. What a baked placement wrote stays in its grid, and the
 * meta's tiles stay in the tileset as ordinary art, so nothing else drawn with
 * them changes; a map's *Remove unused tiles* reclaims what nothing uses.
 *
 * Here rather than in either session because both the tile editor and the
 * meta-tile's own editor start it, and the map session already imports the
 * tile session: open maps hear about it as an event (`onMetaRemoved`) and
 * report themselves through `provideOpenMaps`, not through an import.
 */

import { normalizeMap, removeMetaRef, type MapDoc } from '../../../shared/msx/map'
import { samePath } from '../../../shared/map-editor'
import { serializeResource } from '../../../shared/msx/resource'
import { useResourcesStore } from '../stores/resourcesStore'

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
}

/** The maps open in tabs; none until the map session registers itself. */
let openMaps: () => OpenMap[] = () => []

export function provideOpenMaps(provider: () => OpenMap[]): void {
  openMaps = provider
}

interface MapUse {
  path: string
  placements: number
  /** A closed map: the file's own text, read once, rewritten from. */
  raw: (MapDoc & { tilesetReorderSeen?: number }) | null
}

const fileName = (path: string): string => path.split('/').pop() ?? path

function slotIn(doc: MapDoc, meta: string): number {
  return doc.metas.findIndex((ref) => samePath(ref.path, meta))
}

function placementsOf(doc: MapDoc, slot: number): number {
  return doc.layers.reduce((count, layer) => count + layer.placements.filter((placement) => placement.slot === slot).length, 0)
}

/**
 * Every map drawn with `tileset` that knows the meta — placing it or not, since
 * a reference alone is enough to fail the export once it is detached.
 */
async function mapsUsing(tileset: string, meta: string): Promise<MapUse[]> {
  const uses: MapUse[] = []
  const open = openMaps()
  for (const map of open) {
    if (!samePath(map.doc.tileset, tileset)) continue
    const slot = slotIn(map.doc, meta)
    if (slot >= 0) uses.push({ path: map.path, placements: placementsOf(map.doc, slot), raw: null })
  }
  const resources = useResourcesStore()
  await resources.refresh()
  for (const entry of resources.entries) {
    if (entry.kind !== 'map' || open.some((map) => samePath(map.path, entry.path))) continue
    const text = await window.api.invoke('fs:read', { path: entry.path })
    const raw = (text.trim() ? JSON.parse(text) : {}) as MapDoc & { tilesetReorderSeen?: number }
    const doc = normalizeMap(raw)
    if (!samePath(doc.tileset, tileset)) continue
    const slot = slotIn(doc, meta)
    if (slot >= 0) uses.push({ path: entry.path, placements: placementsOf(doc, slot), raw })
  }
  return uses
}

/**
 * Removes `meta` from `tileset` and from every map drawn with it.
 *
 * Asks first when a map places it, naming them — a closed map is rewritten on
 * disk, which no undo reaches. `detach` takes the meta out of the tileset
 * itself; it runs once the user has agreed and before any map changes, and
 * answers false when there was nothing to detach. `persist` says the caller
 * saves the tileset afterwards (see `MetaRemovedEvent.persist`). `confirmed`
 * says the caller already asked about this removal, so it is not asked again.
 *
 * Returns the status line to show, or null when the user declined.
 */
export async function removeMetaFromTileset(
  tileset: string,
  meta: string,
  detach: () => boolean,
  { persist = false, confirmed = false }: { persist?: boolean; confirmed?: boolean } = {}
): Promise<string | null> {
  let uses: MapUse[]
  try {
    uses = await mapsUsing(tileset, meta)
  } catch (error) {
    return `Couldn't check the maps drawn with ${fileName(tileset)}, so nothing was removed: ${String(error)}`
  }
  const placements = uses.reduce((count, use) => count + use.placements, 0)
  const names = uses.map((use) => fileName(use.path)).join(', ')
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
  if (
    uses.length &&
    !confirmed &&
    !window.confirm(
      `Remove ${fileName(meta)} from ${fileName(tileset)}? ${names} ${uses.length === 1 ? 'uses' : 'use'} it, and ` +
        `${placements === 1 ? 'its placement goes' : `its ${placements} placements go`} with it — a map cannot place a ` +
        `meta-tile its tileset does not have. Its tiles stay in the tileset as art.`
    )
  ) {
    return null
  }
  if (!detach()) return `${fileName(meta)} is not attached to ${fileName(tileset)}.`

  for (const listener of [...listeners]) listener({ tileset, path: meta, persist })
  const failed: string[] = []
  for (const use of uses) {
    if (!use.raw) continue
    const doc = normalizeMap(use.raw)
    const content: MapDoc & { tilesetReorderSeen?: number } = { ...removeMetaRef(doc, slotIn(doc, meta)) }
    // A sibling key, like the tileset's reorder log: dropping it would replay
    // every reorder again the next time the map opens.
    if (typeof use.raw.tilesetReorderSeen === 'number') content.tilesetReorderSeen = use.raw.tilesetReorderSeen
    try {
      await window.api.invoke('fs:write', { path: use.path, content: serializeResource({ kind: 'map', doc: content }) })
    } catch {
      failed.push(fileName(use.path))
    }
  }

  const removed = uses.length
    ? ` and ${placements ? `${plural(placements, 'placement')} from` : 'it from'} ${names}`
    : ''
  const problem = failed.length ? ` Couldn't write ${failed.join(', ')} — remove it there by hand.` : ''
  return (
    `Removed ${fileName(meta)} from ${fileName(tileset)}${removed}. Its tiles stay as art — a map's ` +
    `Remove unused tiles reclaims them.${problem}`
  )
}
