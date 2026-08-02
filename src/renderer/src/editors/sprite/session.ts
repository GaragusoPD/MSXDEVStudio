/**
 * Per-tab state for the sprite editor (Spec 09).
 *
 * Same shape as `editors/tile/session.ts` and `editors/monaco-models.ts`: a
 * module-level map keyed by tab id (= the project-relative path), so a
 * sprite sheet keeps its selection, tool and undo stack while the user
 * switches tabs. Every mutation goes through the pure functions in
 * `shared/sprite-editor.ts` and `shared/msx/sprite.ts` — nothing here knows
 * a hardware rule.
 */

import { shallowReactive } from 'vue'
import { parseResource, serializeResource } from '../../../../shared/msx/resource'
import { createSpritesDoc, type SpritesDoc } from '../../../../shared/msx/sprite'
import {
  createHistory,
  pushHistory,
  redo as redoHistory,
  undo as undoHistory,
  type SpriteHistory,
  type SpriteTarget,
  type SpriteTool
} from '../../../../shared/sprite-editor'
import { useTabsStore } from '../../stores/tabsStore'

export type PlaybackBackground = 'checkered' | 'solid'

export interface SpriteSession {
  path: string
  history: SpriteHistory
  loading: boolean
  error: string | null
  dirty: boolean
  selection: SpriteTarget
  tool: SpriteTool
  fps: number
  playing: boolean
  background: PlaybackBackground
  onionSkin: boolean
  status: string
}

const sessions = new Map<string, SpriteSession>()

export function spriteSession(path: string): SpriteSession {
  const existing = sessions.get(path)
  if (existing) return existing
  const session = shallowReactive<SpriteSession>({
    path,
    history: createHistory(createSpritesDoc()),
    loading: true,
    error: null,
    dirty: false,
    selection: { sprite: 0, frame: 0, layer: 0 },
    tool: 'pencil',
    fps: 6,
    playing: false,
    background: 'checkered',
    onionSkin: false,
    status: ''
  })
  sessions.set(path, session)
  void load(session)
  return session
}

/** Drops sessions for tabs that were closed. Called by the tab component when the tab set changes. */
export function pruneSpriteSessions(openPaths: Set<string>): void {
  for (const path of [...sessions.keys()]) if (!openPaths.has(path)) sessions.delete(path)
}

async function load(session: SpriteSession): Promise<void> {
  try {
    const text = await window.api.invoke('fs:read', { path: session.path })
    const parsed = parseResource(session.path, text) as { kind: 'sprites'; doc: SpritesDoc }
    session.history = createHistory(parsed.doc)
    session.error = null
  } catch (error) {
    session.error = `Couldn't open ${session.path}: ${String(error)}`
  } finally {
    session.loading = false
  }
}

export function doc(session: SpriteSession): SpritesDoc {
  return session.history.present
}

export async function saveSession(session: SpriteSession): Promise<void> {
  const content = serializeResource({ kind: 'sprites', doc: session.history.present })
  await window.api.invoke('fs:write', { path: session.path, content })
  session.dirty = false
  useTabsStore().setDirty(session.path, false)
  session.status = 'Saved'
}

function markDirty(session: SpriteSession): void {
  session.dirty = true
  useTabsStore().setDirty(session.path, true)
}

function clampSelection(session: SpriteSession): void {
  const d = doc(session)
  const sprite = Math.min(session.selection.sprite, d.sprites.length - 1)
  const frame = Math.min(session.selection.frame, d.sprites[sprite].frames.length - 1)
  const layer = Math.min(session.selection.layer, d.sprites[sprite].frames[frame].layers.length - 1)
  session.selection = { sprite, frame, layer }
}

/** Every mutation (color changes, list ops, canvas stroke commits, imports) goes through here. */
export function commit(session: SpriteSession, next: SpritesDoc): void {
  const history = pushHistory(session.history, next)
  if (history === session.history) return
  session.history = history
  clampSelection(session)
  markDirty(session)
}

export function selectSprite(session: SpriteSession, index: number): void {
  session.selection = { sprite: index, frame: 0, layer: 0 }
}

export function selectFrame(session: SpriteSession, index: number): void {
  session.selection = { ...session.selection, frame: index }
  clampSelection(session)
}

export function selectLayer(session: SpriteSession, index: number): void {
  session.selection = { ...session.selection, layer: index }
}

export function undo(session: SpriteSession): void {
  const next = undoHistory(session.history)
  if (next === session.history) return
  session.history = next
  clampSelection(session)
  markDirty(session)
}

export function redo(session: SpriteSession): void {
  const next = redoHistory(session.history)
  if (next === session.history) return
  session.history = next
  clampSelection(session)
  markDirty(session)
}

export function canUndo(session: SpriteSession): boolean {
  return session.history.past.length > 0
}

export function canRedo(session: SpriteSession): boolean {
  return session.history.future.length > 0
}
