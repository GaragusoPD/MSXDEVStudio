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
import { shallowRef } from 'vue'
import { normalizeTiles, type TilesDoc } from '../../../shared/msx/tile'
import { normalizeBitmapTiles, type BitmapTilesDoc } from '../../../shared/msx/bitmap-tile'
import { resourceKindOf, serializeResource } from '../../../shared/msx/resource'
import type { TilesReorderEvent } from '../../../shared/tile-editor'
import { useTabsStore } from './tabsStore'

/**
 * Either kind of tileset. They are shared for the same reason and by the same
 * editors — a meta-tile writes into whichever one it references — so one store
 * holds both rather than two stores holding one each.
 */
export type AnyTilesDoc = TilesDoc | BitmapTilesDoc

/** Which normalizer and which serializer, decided by the suffix alone. */
const isBitmapPath = (path: string): boolean => resourceKindOf(path) === 'btiles'

interface Listener {
  /** The editor that registered it, so it never hears its own writes back. */
  source: string
  fn: (doc: AnyTilesDoc) => void
}

/** Both kinds carry the reorder log as an extra key the normalizers ignore. */
type SavedTiles = AnyTilesDoc & { reorderLog?: TilesReorderEvent[] }

export const useTilesetStore = defineStore('tileset', () => {
  /**
   * `shallowRef`, not `ref`: these documents are immutable snapshots replaced
   * wholesale, and a deep `ref` would proxy every tile of every one of them —
   * expensive, and it hands callers a proxy rather than the object they put in,
   * so identity comparisons (including this store's own early-return below)
   * silently never match.
   */
  const docs = shallowRef(new Map<string, AnyTilesDoc>())
  const dirty = shallowRef(new Set<string>())
  const inflight = new Map<string, Promise<AnyTilesDoc>>()
  const listeners = new Map<string, Listener[]>()
  /** Per path, the reorder log that travels beside the document on disk. */
  const logs = new Map<string, TilesReorderEvent[]>()
  /**
   * How many editor sessions currently hold each path.
   *
   * The whole point of this store is that a `.tiles.json` open in several tabs
   * is one document. Dropping it when *any* one of them closes would undo that:
   * the survivors would keep stale copies, the reorder log would be gone by the
   * next save, and the last save would win again.
   */
  const holders = new Map<string, number>()

  function doc(path: string): AnyTilesDoc | null {
    return docs.value.get(path) ?? null
  }

  /**
   * The two typed accessors. Callers know which kind they want — a pattern
   * meta-tile can only reference a `.tiles.json` — and this is where that
   * knowledge is asserted once instead of at every call site.
   */
  function patternDoc(path: string): TilesDoc | null {
    const held = docs.value.get(path)
    return held && !isBitmapPath(path) ? (held as TilesDoc) : null
  }

  function bitmapDoc(path: string): BitmapTilesDoc | null {
    const held = docs.value.get(path)
    return held && isBitmapPath(path) ? (held as BitmapTilesDoc) : null
  }

  /** Reads the file once, however many editors ask for it at the same moment. */
  async function load(path: string): Promise<AnyTilesDoc> {
    holders.set(path, (holders.get(path) ?? 0) + 1)
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
      // A brand-new file of either kind reserves tile 0: it is only free at
      // this moment, before anything is drawn or points at it.
      const source = text.trim() ? raw : { ...raw, reserveTile0: true }
      const parsed = isBitmapPath(path) ? normalizeBitmapTiles(source) : normalizeTiles(source)
      logs.set(path, Array.isArray(raw.reorderLog) ? raw.reorderLog : [])
      docs.value.set(path, parsed)
      docs.value = new Map(docs.value)
      return parsed
    })().finally(() => inflight.delete(path))
    inflight.set(path, promise)
    return promise
  }

  /** Publishes a new document. Every listener except `source`'s hears about it. */
  function set(path: string, next: AnyTilesDoc, source: string): void {
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
    const saved = { ...current } as SavedTiles
    const log = logs.get(path)
    if (log?.length) saved.reorderLog = log
    const resource = isBitmapPath(path)
      ? ({ kind: 'btiles', doc: saved as unknown as BitmapTilesDoc } as const)
      : ({ kind: 'tiles', doc: saved as TilesDoc } as const)
    await window.api.invoke('fs:write', { path, content: serializeResource(resource) })
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

  function onExternalChange(path: string, source: string, fn: (doc: AnyTilesDoc) => void): () => void {
    const entry: Listener = { source, fn }
    listeners.set(path, [...(listeners.get(path) ?? []), entry])
    return () => listeners.set(path, (listeners.get(path) ?? []).filter((other) => other !== entry))
  }

  /**
   * Gives up one session's hold. The document is dropped only when the last one
   * lets go, and never while it is dirty — the tab that closed may not be the
   * one that dirtied it.
   *
   * Listeners are deliberately not touched here: each session unregisters its
   * own through the handle `onExternalChange` returned, so a session that is
   * still open keeps hearing about changes even as another one lets go.
   */
  function release(path: string): void {
    const remaining = (holders.get(path) ?? 0) - 1
    if (remaining > 0) {
      holders.set(path, remaining)
      return
    }
    holders.delete(path)
    if (dirty.value.has(path)) return
    docs.value.delete(path)
    docs.value = new Map(docs.value)
    logs.delete(path)
  }

  return {
    doc,
    patternDoc,
    bitmapDoc,
    load,
    set,
    save,
    isDirty,
    release,
    onExternalChange,
    appendReorder,
    reorderLog
  }
})
