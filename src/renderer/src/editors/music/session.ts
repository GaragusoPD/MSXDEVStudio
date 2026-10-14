/**
 * Per-tab state for the music editor (Spec 15) — the same shape as
 * `editors/sfx/session.ts`: a module-level map keyed by the project-relative
 * path, so a bank keeps its selection, playhead and undo stack while the user
 * switches tabs.
 *
 * Every edit goes through the pure functions in `shared/music-editor.ts`;
 * nothing here knows an lVGM byte. A pointer drag works on `draft` and lands as
 * one undo step when the button comes up.
 */

import { shallowReactive } from 'vue'
import { parseResource, serializeResource } from '../../../../shared/msx/resource'
import { createMusicDoc, type MusicDoc, type Song } from '../../../../shared/msx/music'
import type { SfxEffect } from '../../../../shared/msx/sfx'
import {
  createHistory,
  dragNote,
  dragSong,
  indexOfNote,
  pushHistory,
  redo as redoHistory,
  undo as undoHistory,
  updateSong,
  type MusicHistory,
  type RollDrag
} from '../../../../shared/music-editor'
import { useTabsStore } from '../../stores/tabsStore'
import { watchResourceFile } from '../external-changes'

export interface MusicSession {
  path: string
  stopWatching: (() => void) | null
  history: MusicHistory
  loading: boolean
  error: string | null
  dirty: boolean
  /** Index into `doc.songs`. */
  song: number
  /** The channel being drawn on, 0–2. */
  channel: number
  /** The instrument new notes get. */
  instrument: number
  /** How many rows a click draws — a drag sets its own length. */
  noteLength: number
  /** Index of the selected note on `channel`, or -1. */
  selected: number
  muted: [boolean, boolean, boolean]
  loop: boolean
  playing: boolean
  /** Song frame under the playhead, or -1. */
  playhead: number
  /** Where Play starts. */
  startRow: number
  /** Width of one row on the piano roll, in pixels. */
  zoom: number
  /** The song while a drag is in progress, drawn in place of the real one. */
  draft: Song | null
  drag: RollDrag | null
  dragBase: Song | null
  /** Where the pointer last was during the drag. */
  dragAt: { row: number; pitch: number }
  /** The `.sfx.json` whose effects keys 1–9 fire, or ''. */
  effectsPath: string
  effects: SfxEffect[]
  /** Where those effects play, 0–2 — ayFX's default is C. */
  effectChannel: number
  status: string
}

const sessions = new Map<string, MusicSession>()

export function musicSession(path: string): MusicSession {
  const existing = sessions.get(path)
  if (existing) return existing
  const session = shallowReactive<MusicSession>({
    path,
    stopWatching: null,
    history: createHistory(createMusicDoc()),
    loading: true,
    error: null,
    dirty: false,
    song: 0,
    channel: 0,
    instrument: 0,
    noteLength: 2,
    selected: -1,
    muted: [false, false, false],
    loop: true,
    playing: false,
    playhead: -1,
    startRow: 0,
    zoom: 14,
    draft: null,
    drag: null,
    dragBase: null,
    dragAt: { row: 0, pitch: 0 },
    effectsPath: '',
    effects: [],
    effectChannel: 2,
    status: ''
  })
  sessions.set(path, session)
  // An agent or a checkout can rewrite this file underneath the editor.
  session.stopWatching = watchResourceFile(path, {
    serialize: () => serializeResource({ kind: 'music', doc: doc(session) }),
    reload: () => void load(session),
    isDirty: () => session.dirty
  })
  void load(session)
  return session
}

export function pruneMusicSessions(openPaths: Set<string>): void {
  for (const path of [...sessions.keys()]) {
    if (openPaths.has(path)) continue
    sessions.get(path)?.stopWatching?.()
    sessions.delete(path)
  }
}

async function load(session: MusicSession): Promise<void> {
  try {
    const text = await window.api.invoke('fs:read', { path: session.path })
    const parsed = parseResource(session.path, text) as { kind: 'music'; doc: MusicDoc }
    session.history = createHistory(parsed.doc)
    session.error = null
    clampSelection(session)
  } catch (error) {
    session.error = `Couldn't open ${session.path}: ${String(error)}`
  } finally {
    session.loading = false
  }
}

export function doc(session: MusicSession): MusicDoc {
  return session.history.present
}

/** The song on screen: the drag's draft while one is in progress. */
export function currentSong(session: MusicSession): Song {
  const d = doc(session)
  return session.draft ?? d.songs[Math.min(session.song, d.songs.length - 1)]
}

export async function saveSession(session: MusicSession): Promise<void> {
  const content = serializeResource({ kind: 'music', doc: doc(session) })
  await window.api.invoke('fs:write', { path: session.path, content })
  session.dirty = false
  useTabsStore().setDirty(session.path, false)
  session.status = 'Saved'
}

function markDirty(session: MusicSession): void {
  session.dirty = true
  useTabsStore().setDirty(session.path, true)
}

function clampSelection(session: MusicSession): void {
  const d = doc(session)
  session.song = Math.max(0, Math.min(session.song, d.songs.length - 1))
  session.instrument = Math.max(0, Math.min(session.instrument, d.instruments.length - 1))
  const song = d.songs[session.song]
  if (session.selected >= song.channels[session.channel].length) session.selected = -1
  session.startRow = Math.min(session.startRow, song.bars * 16 - 1)
}

/** Every edit goes through here so the undo stack and the dirty flag stay honest. */
export function commit(session: MusicSession, next: MusicDoc): void {
  const history = pushHistory(session.history, next)
  if (history === session.history) return
  session.history = history
  clampSelection(session)
  markDirty(session)
}

/** Edits the song on screen. */
export function commitSong(session: MusicSession, fn: (song: Song) => Song): void {
  commit(session, updateSong(doc(session), session.song, fn))
}

export function undo(session: MusicSession): void {
  const next = undoHistory(session.history)
  if (next === session.history) return
  session.history = next
  session.selected = -1
  clampSelection(session)
  markDirty(session)
}

export function redo(session: MusicSession): void {
  const next = redoHistory(session.history)
  if (next === session.history) return
  session.history = next
  session.selected = -1
  clampSelection(session)
  markDirty(session)
}

export function canUndo(session: MusicSession): boolean {
  return session.history.past.length > 0
}

export function canRedo(session: MusicSession): boolean {
  return session.history.future.length > 0
}

// ── drags ───────────────────────────────────────────────────────────────────

export function beginDrag(session: MusicSession, drag: RollDrag, row: number, pitch: number): void {
  const base = currentSong(session)
  session.drag = drag
  session.dragBase = base
  session.dragAt = { row, pitch }
  session.draft = dragSong(base, drag, row, pitch)
}

export function moveDrag(session: MusicSession, row: number, pitch: number): void {
  const { drag, dragBase, draft } = session
  if (!drag || !dragBase || !draft) return
  session.dragAt = { row, pitch }
  // Erasing accumulates what it crossed; the others recompute from the press.
  const next = dragSong(drag.kind === 'erase' ? draft : dragBase, drag, row, pitch)
  if (next !== draft) session.draft = next
}

/** Lands the drag as one undo step, and keeps the note it made or moved selected. */
export function endDrag(session: MusicSession): void {
  const { drag, draft, dragBase, dragAt } = session
  cancelDrag(session)
  if (!drag || !draft || !dragBase) return
  commitSong(session, () => draft)
  const note = dragNote(dragBase, drag, dragAt.row, dragAt.pitch)
  session.selected = note ? indexOfNote(currentSong(session).channels[drag.channel], note.row, note.pitch) : -1
}

export function cancelDrag(session: MusicSession): void {
  session.drag = null
  session.dragBase = null
  session.draft = null
}
