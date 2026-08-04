/**
 * The undo stack the sprite, map and screen editors share.
 *
 * All three edit one immutable document per step, so undo is a plain
 * past/present/future triple over whole documents — no diffing, no command
 * objects. `shared/tile-editor.ts` keeps its own: its entries carry a label
 * and a tile-renumbering map, which this doesn't model.
 *
 * Every function returns a new history, or the *same* one when nothing
 * changed, so a Vue `shallowReactive` session only re-renders on real edits.
 */

export interface History<T> {
  past: T[]
  present: T
  future: T[]
}

/** Steps kept per document — plenty for one editing session without unbounded memory growth. */
const HISTORY_LIMIT = 200

export function createHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] }
}

/** Records `next` as the new present; no-ops when nothing actually changed (reference-equal). */
export function pushHistory<T>(history: History<T>, next: T): History<T> {
  if (next === history.present) return history
  return { past: [...history.past, history.present].slice(-HISTORY_LIMIT), present: next, future: [] }
}

export function undo<T>(history: History<T>): History<T> {
  if (!history.past.length) return history
  const present = history.past[history.past.length - 1]
  return { past: history.past.slice(0, -1), present, future: [history.present, ...history.future] }
}

export function redo<T>(history: History<T>): History<T> {
  if (!history.future.length) return history
  const [present, ...future] = history.future
  return { past: [...history.past, history.present], present, future }
}

export function canUndo<T>(history: History<T>): boolean {
  return history.past.length > 0
}

export function canRedo<T>(history: History<T>): boolean {
  return history.future.length > 0
}
