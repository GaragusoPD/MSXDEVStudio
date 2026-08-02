/**
 * Per-tab state for the SFX editor (Spec 11) — same shape as
 * `editors/sprite/session.ts`: a module-level map keyed by tab id (= the
 * project-relative path) so an effect bank keeps its selection, playhead and
 * undo stack while the user switches tabs.
 *
 * Every mutation goes through the pure functions in `shared/sfx-editor.ts`;
 * nothing here knows an ayFX byte.
 */

import { shallowReactive } from 'vue'
import { parseResource, serializeResource } from '../../../../shared/msx/resource'
import { createSfxDoc, type SfxDoc } from '../../../../shared/msx/sfx'
import {
  createHistory,
  pushHistory,
  redo as redoHistory,
  undo as undoHistory,
  updateEffect,
  type SfxHistory
} from '../../../../shared/sfx-editor'
import { useTabsStore } from '../../stores/tabsStore'

export interface SfxSession {
  path: string
  history: SfxHistory
  loading: boolean
  error: string | null
  dirty: boolean
  /** Index into `doc.effects` — also the id `ayFX_PlayBank()` takes. */
  selected: number
  loop: boolean
  playing: boolean
  /** Frame the playhead is on while playing/scrubbing; -1 when idle. */
  playhead: number
  status: string
}

const sessions = new Map<string, SfxSession>()

export function sfxSession(path: string): SfxSession {
  const existing = sessions.get(path)
  if (existing) return existing
  const session = shallowReactive<SfxSession>({
    path,
    history: createHistory(createSfxDoc()),
    loading: true,
    error: null,
    dirty: false,
    selected: 0,
    loop: false,
    playing: false,
    playhead: -1,
    status: ''
  })
  sessions.set(path, session)
  void load(session)
  return session
}

/** Drops sessions for tabs that were closed. Called by the tab component when the tab set changes. */
export function pruneSfxSessions(openPaths: Set<string>): void {
  for (const path of [...sessions.keys()]) if (!openPaths.has(path)) sessions.delete(path)
}

async function load(session: SfxSession): Promise<void> {
  try {
    const text = await window.api.invoke('fs:read', { path: session.path })
    const parsed = parseResource(session.path, text) as { kind: 'sfx'; doc: SfxDoc }
    session.history = createHistory(parsed.doc)
    session.error = null
  } catch (error) {
    session.error = `Couldn't open ${session.path}: ${String(error)}`
  } finally {
    session.loading = false
  }
}

export function doc(session: SfxSession): SfxDoc {
  return session.history.present
}

export function selectedEffect(session: SfxSession) {
  const d = doc(session)
  return d.effects[Math.min(session.selected, d.effects.length - 1)]
}

export async function saveSession(session: SfxSession): Promise<void> {
  const content = serializeResource({ kind: 'sfx', doc: doc(session) })
  await window.api.invoke('fs:write', { path: session.path, content })
  session.dirty = false
  useTabsStore().setDirty(session.path, false)
  session.status = 'Saved'
}

function markDirty(session: SfxSession): void {
  session.dirty = true
  useTabsStore().setDirty(session.path, true)
}

function clampSelection(session: SfxSession): void {
  session.selected = Math.max(0, Math.min(session.selected, doc(session).effects.length - 1))
}

/** Every mutation goes through here so the undo stack and the dirty flag stay honest. */
export function commit(session: SfxSession, next: SfxDoc): void {
  const history = pushHistory(session.history, next)
  if (history === session.history) return
  session.history = history
  clampSelection(session)
  markDirty(session)
}

/** Convenience for the common case: edit the effect that's selected. */
export function commitSelected(session: SfxSession, fn: Parameters<typeof updateEffect>[2]): void {
  commit(session, updateEffect(doc(session), session.selected, fn))
}

export function undo(session: SfxSession): void {
  const next = undoHistory(session.history)
  if (next === session.history) return
  session.history = next
  clampSelection(session)
  markDirty(session)
}

export function redo(session: SfxSession): void {
  const next = redoHistory(session.history)
  if (next === session.history) return
  session.history = next
  clampSelection(session)
  markDirty(session)
}

export function canUndo(session: SfxSession): boolean {
  return session.history.past.length > 0
}

export function canRedo(session: SfxSession): boolean {
  return session.history.future.length > 0
}
