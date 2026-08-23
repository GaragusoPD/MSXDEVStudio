/**
 * One `TilesDoc` per path, shared by every editor that draws with it.
 *
 * The meta-tile editor writes tiles *into* the tileset it references — that is
 * what "paint a meta in pixels" has to mean when a meta owns no pixels. With a
 * copy per editor, the same `.tiles.json` open in a tile tab and two meta tabs
 * would be three documents, and whichever saved last would silently discard the
 * other two. So there is one document, and it lives here.
 *
 * Undo stays with the editors. Each keeps its own history of the snapshots *it*
 * made; when the store changes underneath one, it rebases — pushes the external
 * doc as its new present. That is safe precisely because painting only ever
 * *appends* tiles: two editors can disagree about which tiles exist, never
 * about what an existing tile looks like.
 *
 * Written in Pinia's **setup style**, unlike the option-style stores beside it.
 * The deviation is deliberate and confined to this file: the state is a keyed
 * map plus a per-key listener registry, and those listeners are closures that
 * must not become reactive state. Follow the option style for any store that
 * does not have this shape.
 */

import { defineStore } from 'pinia'
import { ref } from 'vue'
import { normalizeTiles, type TilesDoc } from '../../../shared/msx/tile'
import { serializeResource } from '../../../shared/msx/resource'
import type { TilesReorderEvent } from '../../../shared/tile-editor'
import { useTabsStore } from './tabsStore'

interface Listener {
  /** The editor that registered it, so it never hears its own writes back. */
  source: string
  fn: (doc: TilesDoc) => void
}

/** `.tiles.json` carries the reorder log as an extra key `normalizeTiles` ignores. */
type SavedTiles = TilesDoc & { reorderLog?: TilesReorderEvent[] }

export const useTilesetStore = defineStore('tileset', () => {
  const docs = ref(new Map<string, TilesDoc>())
  const dirty = ref(new Set<string>())
  const inflight = new Map<string, Promise<TilesDoc>>()
  const listeners = new Map<string, Listener[]>()
  /** Per path, the reorder log that travels beside the document on disk. */
  const logs = new Map<string, TilesReorderEvent[]>()

  function doc(path: string): TilesDoc | null {
    return docs.value.get(path) ?? null
  }

  /** Reads the file once, however many editors ask for it at the same moment. */
  async function load(path: string): Promise<TilesDoc> {
    const held = docs.value.get(path)
    if (held) return held
    const pending = inflight.get(path)
    if (pending) return pending
    const promise = (async () => {
      const text = await window.api.invoke('fs:read', { path })
      const raw = (text.trim() ? JSON.parse(text) : {}) as SavedTiles
      // An empty file is a tileset being created right now, and this is the
      // only moment reserving tile 0 is free: no art to shift, nothing drawing
      // it yet. See `TilesDoc.reserveTile0`.
      const parsed = normalizeTiles(text.trim() ? raw : { ...raw, reserveTile0: true })
      logs.set(path, Array.isArray(raw.reorderLog) ? raw.reorderLog : [])
      docs.value.set(path, parsed)
      docs.value = new Map(docs.value)
      return parsed
    })().finally(() => inflight.delete(path))
    inflight.set(path, promise)
    return promise
  }

  /** Publishes a new document. Every listener except `source`'s hears about it. */
  function set(path: string, next: TilesDoc, source: string): void {
    if (docs.value.get(path) === next) return
    docs.value.set(path, next)
    docs.value = new Map(docs.value)
    dirty.value.add(path)
    dirty.value = new Set(dirty.value)
    useTabsStore().setDirty(path, true)
    for (const listener of listeners.get(path) ?? []) {
      if (listener.source !== source) listener.fn(next)
    }
  }

  async function save(path: string): Promise<void> {
    const current = docs.value.get(path)
    if (!current) return
    // `reorderLog` is a *sibling key* of the document, not part of it — every
    // map and meta drawn with this tileset replays it on open to renumber
    // itself after a reorder. Serializing the doc alone silently deletes it,
    // and the damage only shows up the next time some other file is opened.
    const saved: SavedTiles = { ...current }
    const log = logs.get(path)
    if (log?.length) saved.reorderLog = log
    await window.api.invoke('fs:write', { path, content: serializeResource({ kind: 'tiles', doc: saved }) })
    dirty.value.delete(path)
    dirty.value = new Set(dirty.value)
    useTabsStore().setDirty(path, false)
  }

  function isDirty(path: string): boolean {
    return dirty.value.has(path)
  }

  /** Records a tile renumbering so it survives the save. Emitting it is the caller's job. */
  function appendReorder(path: string, event: TilesReorderEvent): void {
    logs.set(path, [...(logs.get(path) ?? []), event])
  }

  function reorderLog(path: string): TilesReorderEvent[] {
    return logs.get(path) ?? []
  }

  function onExternalChange(path: string, source: string, fn: (doc: TilesDoc) => void): () => void {
    const entry: Listener = { source, fn }
    listeners.set(path, [...(listeners.get(path) ?? []), entry])
    return () => listeners.set(path, (listeners.get(path) ?? []).filter((other) => other !== entry))
  }

  /**
   * Drops a tileset no tab holds any more. Unsaved work is never discarded —
   * a dirty document stays until it is saved, because the tab that closed may
   * not have been the one that dirtied it.
   */
  function release(path: string): void {
    if (dirty.value.has(path)) return
    docs.value.delete(path)
    docs.value = new Map(docs.value)
    listeners.delete(path)
    logs.delete(path)
  }

  return { doc, load, set, save, isDirty, release, onExternalChange, appendReorder, reorderLog }
})
