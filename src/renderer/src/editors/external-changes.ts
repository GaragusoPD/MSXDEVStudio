/**
 * Picking up edits made to an open file by something that is not this editor —
 * an agent working in the project, a `git checkout`, another tool.
 *
 * The main process already watches the project and pushes `fs:changed`; until
 * now only the explorer listened, so the tree updated while the buffer showing
 * the same file went stale. This is the editor half: one subscription, a
 * registry of open documents, and a handler per document that decides what to
 * do with the new text.
 *
 * **Our own writes come back through here too.** Saving fires the watcher, so
 * every handler is handed the text and compares it against what it already
 * holds; identical means it was us and nothing happens. That is deliberately a
 * content comparison rather than suppressing events around a save — a timing
 * window is a race, and an agent that writes while a save is in flight would
 * fall through it.
 *
 * **Unsaved work is never discarded.** A handler that is dirty declines the
 * reload and says so; the file on disk and the buffer have genuinely diverged
 * and only the user can say which one wins.
 */

import type { FsChangeEvent } from '../../../shared/ipc'

export interface ExternalChange {
  /** The file's new contents. */
  text: string
  /** Project-relative path, as `fs:changed` reports it. */
  path: string
}

/**
 * Returns true if it took the change. False means "I am dirty and kept my own
 * version", which is what marks the document as diverged.
 */
export type ExternalChangeHandler = (change: ExternalChange) => boolean

interface Entry {
  path: string
  handler: ExternalChangeHandler
}

/**
 * Keyed by *document*, not by path: two tabs can show one file, and each has
 * its own buffer and its own dirty state.
 */
const entries = new Map<string, Entry>()
let subscribed = false
/** Coalesces the burst a single logical write can produce. */
const pendingReads = new Map<string, ReturnType<typeof setTimeout>>()

/** Called when a handler declined a change because it had unsaved edits. */
type DivergedListener = (path: string) => void
const divergedListeners = new Set<DivergedListener>()

export function onDiverged(listener: DivergedListener): () => void {
  divergedListeners.add(listener)
  return () => divergedListeners.delete(listener)
}

function subscribe(): void {
  if (subscribed) return
  subscribed = true
  window.api.on('fs:changed', (event: FsChangeEvent) => {
    if (event.type !== 'change') return
    if (![...entries.values()].some((entry) => entry.path === event.path)) return
    // A write is rarely one event — an editor that truncates then writes
    // produces two, and a formatter can produce several. Read once, shortly
    // after the last of them.
    clearTimeout(pendingReads.get(event.path))
    pendingReads.set(
      event.path,
      setTimeout(() => {
        pendingReads.delete(event.path)
        void deliver(event.path)
      }, 80)
    )
  })
}

async function deliver(path: string): Promise<void> {
  let text: string
  try {
    text = await window.api.invoke('fs:read', { path })
  } catch {
    // Deleted or unreadable between the event and now. `unlink` is the
    // explorer's business, not ours.
    return
  }
  for (const [id, entry] of entries) {
    if (entry.path !== path) continue
    if (!entry.handler({ text, path })) {
      for (const listener of divergedListeners) listener(id)
    }
  }
}

/**
 * Registers a document to be told when its file changes underneath it. Returns
 * the unsubscribe, which callers must run when the document goes away.
 */
export function watchExternalEdits(id: string, path: string, handler: ExternalChangeHandler): () => void {
  subscribe()
  entries.set(id, { path, handler })
  return () => {
    entries.delete(id)
  }
}

/**
 * Test seam: forget every registration *and* the subscription itself, so the
 * next `watchExternalEdits` re-subscribes against a fresh `window.api`.
 */
export function resetExternalWatches(): void {
  subscribed = false
  entries.clear()
  for (const timer of pendingReads.values()) clearTimeout(timer)
  pendingReads.clear()
  divergedListeners.clear()
}
