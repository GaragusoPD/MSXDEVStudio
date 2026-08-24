/**
 * The one renderer module with its own tests, and the reason for the exception:
 * this store is *lifecycle* logic, not a view over something in `src/shared`.
 * Nothing it does is reachable from a shared module, so nothing else can cover
 * it — and the bug that made it worth testing (a document dropped while another
 * tab still held it, taking the reorder log with it) was invisible to every
 * other suite.
 *
 * No DOM: the store touches `window.api` and one other Pinia store, both of
 * which stub in a few lines.
 */

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { serializeResource } from '../../../shared/msx/resource'
import { normalizeTiles, type TilesDoc } from '../../../shared/msx/tile'
import type { TilesReorderEvent } from '../../../shared/tile-editor'
import { resetExternalWatches } from '../editors/external-changes'
import { useTilesetStore } from './tilesetStore'

const PATH = 'res/tiles.tiles.json'

/** What the fake filesystem holds, and what was last written to it. */
let files: Record<string, string>
let writes: { path: string; content: string }[]
/** Push-event handlers the code under test registered, so tests can fire them. */
let pushed: Record<string, ((payload: unknown) => void)[]>

/** Fires `fs:changed` and waits for the watcher's debounce and its read. */
async function fileChangedOutside(path: string, text: string): Promise<void> {
  files[path] = text
  for (const handler of pushed['fs:changed'] ?? []) handler({ type: 'change', path })
  await new Promise((resolve) => setTimeout(resolve, 140))
}

function stubApi(): void {
  writes = []
  pushed = {}
  const invoke = vi.fn(async (channel: string, args: { path: string; content?: string }) => {
    if (channel === 'fs:read') return files[args.path] ?? ''
    if (channel === 'fs:write') {
      files[args.path] = args.content ?? ''
      writes.push({ path: args.path, content: args.content ?? '' })
      return undefined
    }
    throw new Error(`unexpected channel ${channel}`)
  })
  const on = vi.fn((channel: string, handler: (payload: unknown) => void) => {
    ;(pushed[channel] ??= []).push(handler)
  })
  ;(globalThis as { window?: unknown }).window = { api: { invoke, on } }
}

const withLog = (log: TilesReorderEvent[]): string =>
  serializeResource({
    kind: 'tiles',
    doc: { ...normalizeTiles({ mode: 'sc2', count: 4 }), reorderLog: log } as never
  })

beforeEach(() => {
  resetExternalWatches()
  setActivePinia(createPinia())
  files = { [PATH]: serializeResource({ kind: 'tiles', doc: normalizeTiles({ mode: 'sc2', count: 4 }) }) }
  stubApi()
})

describe('one document per path', () => {
  it('reads the file once however many sessions ask', async () => {
    const store = useTilesetStore()
    const [a, b] = await Promise.all([store.load(PATH), store.load(PATH)])
    expect(a).toBe(b)
  })

  it('a brand-new file reserves tile 0, an existing one keeps what it saved', async () => {
    const store = useTilesetStore()
    files['res/new.tiles.json'] = ''
    expect((await store.load('res/new.tiles.json')).reserveTile0).toBe(true)
    expect((await store.load(PATH)).reserveTile0).toBe(false)
  })
})

describe('release is refcounted', () => {
  it('keeps the document while another session still holds it', async () => {
    const store = useTilesetStore()
    await store.load(PATH) // the tile editor
    await store.load(PATH) // a meta editor
    store.release(PATH) // the meta tab closes
    expect(store.doc(PATH)).not.toBeNull()
    store.release(PATH) // the tile tab closes
    expect(store.doc(PATH)).toBeNull()
  })

  it('keeps the reorder log while another session still holds it', async () => {
    files[PATH] = withLog([{ path: PATH, mapping: [1, 0, 2, 3], at: 1 }])
    const store = useTilesetStore()
    await store.load(PATH)
    await store.load(PATH)
    store.release(PATH)
    // The bug this test exists for: the surviving session's next save would
    // have written the file without its log, and every closed map that needed
    // to replay it would have been silently stranded.
    expect(store.reorderLog(PATH)).toHaveLength(1)
  })

  it('never drops a dirty document, even when the last session lets go', async () => {
    const store = useTilesetStore()
    const doc = await store.load(PATH)
    store.set(PATH, { ...doc, count: 5 }, 'someone')
    store.release(PATH)
    expect(store.doc(PATH)).not.toBeNull()
    expect(store.isDirty(PATH)).toBe(true)
  })
})

describe('saving', () => {
  it('writes the reorder log beside the document', async () => {
    const store = useTilesetStore()
    const doc = await store.load(PATH)
    store.set(PATH, { ...doc, count: 5 }, 'tile-editor')
    store.appendReorder(PATH, { path: PATH, mapping: [1, 0, 2, 3], at: 7 })
    await store.save(PATH)
    expect(JSON.parse(writes[0].content).reorderLog).toEqual([{ path: PATH, mapping: [1, 0, 2, 3], at: 7 }])
  })

  it('omits the key entirely when there is no log, so ordinary files stay clean', async () => {
    const store = useTilesetStore()
    const doc = await store.load(PATH)
    store.set(PATH, { ...doc, count: 5 }, 'tile-editor')
    await store.save(PATH)
    expect(writes[0].content).not.toContain('reorderLog')
  })

  it('clears the dirty flag', async () => {
    const store = useTilesetStore()
    const doc = await store.load(PATH)
    store.set(PATH, { ...doc, count: 5 }, 'tile-editor')
    expect(store.isDirty(PATH)).toBe(true)
    await store.save(PATH)
    expect(store.isDirty(PATH)).toBe(false)
  })
})

describe('external change', () => {
  it('tells every session except the one that made the change', async () => {
    const store = useTilesetStore()
    const doc = await store.load(PATH)
    const tileEditor = vi.fn()
    const metaEditor = vi.fn()
    store.onExternalChange(PATH, 'tile-tab', tileEditor)
    store.onExternalChange(PATH, 'meta-tab', metaEditor)

    store.set(PATH, { ...doc, count: 5 }, 'meta-tab')
    expect(tileEditor).toHaveBeenCalledTimes(1)
    // A session never hears its own write back — it already has the document.
    expect(metaEditor).not.toHaveBeenCalled()
  })

  it('stops telling a session that unsubscribed', async () => {
    const store = useTilesetStore()
    const doc = await store.load(PATH)
    const listener = vi.fn()
    const stop = store.onExternalChange(PATH, 'tile-tab', listener)
    stop()
    store.set(PATH, { ...doc, count: 5 }, 'meta-tab')
    expect(listener).not.toHaveBeenCalled()
  })

  it('survives a release by another session — the listener belongs to its own', async () => {
    const store = useTilesetStore()
    const doc = await store.load(PATH)
    await store.load(PATH)
    const listener = vi.fn()
    store.onExternalChange(PATH, 'tile-tab', listener)
    store.release(PATH)
    store.set(PATH, { ...doc, count: 5 }, 'meta-tab')
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('edits made outside the app', () => {
  const rewritten = (count: number): string =>
    serializeResource({ kind: 'tiles', doc: normalizeTiles({ mode: 'sc2', count }) })

  it('adopts a file rewritten on disk, and tells every session', async () => {
    const store = useTilesetStore()
    await store.load(PATH)
    const listener = vi.fn()
    store.onExternalChange(PATH, 'tile-tab', listener)

    await fileChangedOutside(PATH, rewritten(9))
    expect(store.doc(PATH)!.count).toBe(9)
    // 'external' belongs to no editor, so even the tab that would have been the
    // writer hears about it.
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('ignores the app\'s own save coming back through the watcher', async () => {
    const store = useTilesetStore()
    const doc = await store.load(PATH)
    const listener = vi.fn()
    store.onExternalChange(PATH, 'tile-tab', listener)

    // Exactly what `save` writes — the same serializer produced it.
    await fileChangedOutside(PATH, serializeResource({ kind: 'tiles', doc: doc as TilesDoc }))
    expect(listener).not.toHaveBeenCalled()
    expect(store.doc(PATH)).toBe(doc)
  })

  it('never discards unsaved work — a dirty document declines', async () => {
    const store = useTilesetStore()
    const doc = await store.load(PATH)
    store.set(PATH, { ...doc, count: 5 }, 'tile-tab')

    await fileChangedOutside(PATH, rewritten(9))
    // The buffer wins until the user decides; the file is not silently taken.
    expect(store.doc(PATH)!.count).toBe(5)
    expect(store.isDirty(PATH)).toBe(true)
  })

  it('stops listening once the last session lets go', async () => {
    const store = useTilesetStore()
    await store.load(PATH)
    store.release(PATH)

    await fileChangedOutside(PATH, rewritten(9))
    expect(store.doc(PATH)).toBeNull()
  })
})
