/**
 * Music editor (Spec 15) — the editing logic that isn't format knowledge: what
 * drawing a note does to the notes around it, beats, the song and instrument
 * lists, and the undo stack.
 *
 * Pure, so Vitest drives it directly; `editors/music/*.vue` turns pointer
 * positions into these calls. The document shape, rendering and lVGM live in
 * `shared/msx/music.ts`; playback in `shared/music-play.ts`.
 *
 * Every function returns a new document, or the *same* one when nothing
 * changed, so the session's undo stack only records real edits.
 */

import {
  BEAT_PITCH,
  BEAT_PRESETS,
  beatHits,
  copyInstrument,
  instrumentPreset,
  MAX_BARS,
  MAX_INSTRUMENTS,
  MAX_PITCH,
  MAX_SONGS,
  MAX_SPEED,
  MIN_PITCH,
  monophonic,
  ROWS_PER_BAR,
  songRows,
  type Instrument,
  type MusicDoc,
  type Note,
  type Song
} from './msx/music'
import type { History } from './history'

export type MusicHistory = History<MusicDoc>
export { createHistory, pushHistory, undo, redo, canUndo, canRedo } from './history'

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(value)))

/** `base`, or `base2`, `base3`… — whichever no entry already has. */
export function uniqueName(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base
  for (let n = 2; ; n++) if (!taken.includes(`${base}${n}`)) return `${base}${n}`
}

// ── songs ───────────────────────────────────────────────────────────────────

export function updateSong(doc: MusicDoc, index: number, fn: (song: Song) => Song): MusicDoc {
  const song = doc.songs[index]
  if (!song) return doc
  const next = fn(song)
  if (next === song) return doc
  return { ...doc, songs: doc.songs.map((one, i) => (i === index ? next : one)) }
}

export function blankSong(name: string): Song {
  return { name, bars: 4, speed: 5, loopBar: 0, channels: [[], [], []] }
}

export function addSong(doc: MusicDoc): MusicDoc {
  if (doc.songs.length >= MAX_SONGS) return doc
  return { ...doc, songs: [...doc.songs, blankSong(uniqueName('song', doc.songs.map((song) => song.name)))] }
}

export function duplicateSong(doc: MusicDoc, index: number): MusicDoc {
  const song = doc.songs[index]
  if (!song || doc.songs.length >= MAX_SONGS) return doc
  const copy: Song = {
    ...song,
    name: uniqueName(song.name, doc.songs.map((one) => one.name)),
    channels: song.channels.map((notes) => notes.map((note) => ({ ...note }))) as Song['channels']
  }
  return { ...doc, songs: [...doc.songs.slice(0, index + 1), copy, ...doc.songs.slice(index + 1)] }
}

/** A bank always keeps one song: the editor has nothing to show without it. */
export function deleteSong(doc: MusicDoc, index: number): MusicDoc {
  if (doc.songs.length <= 1 || !doc.songs[index]) return doc
  return { ...doc, songs: doc.songs.filter((_, i) => i !== index) }
}

export function renameSong(doc: MusicDoc, index: number, name: string): MusicDoc {
  const trimmed = name.trim()
  return trimmed ? updateSong(doc, index, (song) => (song.name === trimmed ? song : { ...song, name: trimmed })) : doc
}

/** Shortening drops the notes that start past the end and cuts the ones that run over it. */
export function setBars(song: Song, bars: number): Song {
  const count = clamp(bars, 1, MAX_BARS)
  if (count === song.bars) return song
  const rows = count * ROWS_PER_BAR
  const fit = (notes: Note[]): Note[] =>
    notes.filter((note) => note.row < rows).map((note) => (note.row + note.length > rows ? { ...note, length: rows - note.row } : note))
  return {
    ...song,
    bars: count,
    loopBar: Math.min(song.loopBar, count - 1),
    channels: song.channels.map(fit) as Song['channels']
  }
}

export function setSpeed(song: Song, speed: number): Song {
  const value = clamp(speed, 1, MAX_SPEED)
  return value === song.speed ? song : { ...song, speed: value }
}

export function setLoopBar(song: Song, bar: number): Song {
  const value = clamp(bar, 0, song.bars - 1)
  return value === song.loopBar ? song : { ...song, loopBar: value }
}

// ── notes ───────────────────────────────────────────────────────────────────

/** The note sounding at `row` on this channel, or -1. A channel has at most one. */
export function noteAtRow(notes: readonly Note[], row: number): number {
  return notes.findIndex((note) => row >= note.row && row < note.row + note.length)
}

/** The note drawn at (`row`, `pitch`) — what a click on the piano roll hits — or -1. */
export function noteAt(notes: readonly Note[], row: number, pitch: number): number {
  const index = noteAtRow(notes, row)
  return index >= 0 && notes[index].pitch === pitch ? index : -1
}

function setChannel(song: Song, channel: number, notes: Note[]): Song {
  return { ...song, channels: song.channels.map((one, i) => (i === channel ? notes : one)) as Song['channels'] }
}

/** Clamps a note into the song and the PSG's range. */
export function fitNote(song: Song, note: Note): Note {
  const rows = songRows(song)
  const row = clamp(note.row, 0, rows - 1)
  return {
    row,
    length: clamp(note.length, 1, rows - row),
    pitch: clamp(note.pitch, MIN_PITCH, MAX_PITCH),
    instrument: Math.max(0, Math.round(note.instrument)),
    volume: clamp(note.volume, 0, 15)
  }
}

/**
 * Draws a note. The channel plays one note at a time, so a note already
 * sounding when this one starts is cut short, and any note that would start
 * underneath it is removed.
 */
export function placeNote(song: Song, channel: number, raw: Note): Song {
  const note = fitNote(song, raw)
  const end = note.row + note.length
  const kept: Note[] = []
  for (const other of song.channels[channel]) {
    if (other.row >= end || other.row + other.length <= note.row) kept.push(other)
    else if (other.row < note.row) kept.push({ ...other, length: note.row - other.row })
  }
  return setChannel(song, channel, monophonic([...kept, note]))
}

export function removeNote(song: Song, channel: number, index: number): Song {
  const notes = song.channels[channel]
  if (!notes[index]) return song
  return setChannel(song, channel, notes.filter((_, i) => i !== index))
}

/** Moving or resizing: the note comes out, and goes back in under `placeNote`'s rules. */
export function replaceNote(song: Song, channel: number, index: number, note: Note): Song {
  const current = song.channels[channel][index]
  if (!current) return song
  const fitted = fitNote(song, note)
  if (Object.entries(fitted).every(([key, value]) => current[key as keyof Note] === value)) return song
  return placeNote(removeNote(song, channel, index), channel, fitted)
}

/** Every note on a channel, in the rows `[from, to)`. */
export function clearRows(song: Song, channel: number, from = 0, to = songRows(song)): Song {
  const notes = song.channels[channel]
  const kept = notes.filter((note) => note.row < from || note.row >= to)
  return kept.length === notes.length ? song : setChannel(song, channel, kept)
}

/** Copies bar `from` over bar `to` on every channel — the quickest way to build a loop out of one bar. */
export function copyBar(song: Song, from: number, to: number): Song {
  if (from === to || from < 0 || to < 0 || from >= song.bars || to >= song.bars) return song
  const shift = (to - from) * ROWS_PER_BAR
  let next = song
  for (let channel = 0; channel < song.channels.length; channel++) {
    next = clearRows(next, channel, to * ROWS_PER_BAR, (to + 1) * ROWS_PER_BAR)
    for (const note of song.channels[channel]) {
      if (note.row < from * ROWS_PER_BAR || note.row >= (from + 1) * ROWS_PER_BAR) continue
      next = placeNote(next, channel, { ...note, row: note.row + shift, length: Math.min(note.length, (from + 1) * ROWS_PER_BAR - note.row) })
    }
  }
  return next
}

// ── instruments ─────────────────────────────────────────────────────────────

export function instrumentInUse(doc: MusicDoc, index: number): boolean {
  return doc.songs.some((song) => song.channels.some((notes) => notes.some((note) => note.instrument === index)))
}

/** The index of the bank's instrument with this name, adding the preset of that name if there is none. */
export function ensureInstrument(doc: MusicDoc, presetName: string): { doc: MusicDoc; index: number } {
  const found = doc.instruments.findIndex((one) => one.name === presetName)
  if (found >= 0) return { doc, index: found }
  return addInstrument(doc, instrumentPreset(presetName))
}

export function addInstrument(doc: MusicDoc, instrument: Instrument): { doc: MusicDoc; index: number } {
  if (doc.instruments.length >= MAX_INSTRUMENTS) return { doc, index: doc.instruments.length - 1 }
  const copy = { ...copyInstrument(instrument), name: uniqueName(instrument.name, doc.instruments.map((one) => one.name)) }
  return { doc: { ...doc, instruments: [...doc.instruments, copy] }, index: doc.instruments.length }
}

export function renameInstrument(doc: MusicDoc, index: number, name: string): MusicDoc {
  const trimmed = name.trim()
  const current = doc.instruments[index]
  if (!current || !trimmed || trimmed === current.name) return doc
  return { ...doc, instruments: doc.instruments.map((one, i) => (i === index ? { ...one, name: trimmed } : one)) }
}

export function updateInstrument(doc: MusicDoc, index: number, instrument: Instrument): MusicDoc {
  if (!doc.instruments[index] || doc.instruments[index] === instrument) return doc
  return { ...doc, instruments: doc.instruments.map((one, i) => (i === index ? instrument : one)) }
}

/**
 * Only an instrument no note plays can go — removing one that is in use would
 * either delete notes or silently re-voice them. Later instruments shift down
 * one, and every note's index follows.
 */
export function deleteInstrument(doc: MusicDoc, index: number): MusicDoc {
  if (doc.instruments.length <= 1 || !doc.instruments[index] || instrumentInUse(doc, index)) return doc
  const shift = (notes: Note[]): Note[] => notes.map((note) => (note.instrument > index ? { ...note, instrument: note.instrument - 1 } : note))
  return {
    ...doc,
    instruments: doc.instruments.filter((_, i) => i !== index),
    songs: doc.songs.map((song) => ({ ...song, channels: song.channels.map(shift) as Song['channels'] }))
  }
}

// ── beats ───────────────────────────────────────────────────────────────────

/**
 * Fills one channel of a song with a ready-made beat, every bar, replacing
 * whatever that channel played. The drums it needs are added to the bank if
 * the bank has none of that name.
 */
export function applyBeat(doc: MusicDoc, songIndex: number, channel: number, beatName: string): MusicDoc {
  const beat = BEAT_PRESETS.find((one) => one.name === beatName)
  const song = doc.songs[songIndex]
  if (!beat || !song) return doc
  const hits = beatHits(beat.pattern)
  let next = doc
  const drums = new Map<string, number>()
  for (const hit of hits) {
    if (drums.has(hit.drum)) continue
    const ensured = ensureInstrument(next, hit.drum)
    next = ensured.doc
    drums.set(hit.drum, ensured.index)
  }
  const notes: Note[] = []
  for (let bar = 0; bar < song.bars; bar++) {
    for (const hit of hits) {
      notes.push({ row: bar * ROWS_PER_BAR + hit.row, length: hit.length, pitch: BEAT_PITCH[hit.drum], instrument: drums.get(hit.drum) ?? 0, volume: 15 })
    }
  }
  return updateSong(next, songIndex, (one) => setChannel(one, channel, notes))
}

// ── piano roll ──────────────────────────────────────────────────────────────
// The geometry and what a drag does, so `PianoRoll.vue` only draws and forwards
// pointer positions. x is measured from the grid's left edge (past the
// keyboard), y from its top (below the ruler).

/** Height of one pitch row. */
export const KEY_H = 12
/** Default width of one row (a 16th note); the editor zooms between these. */
export const ROW_W = 14
export const MIN_ROW_W = 6
export const MAX_ROW_W = 32

/** Top row is the highest pitch. */
export function pitchAtY(y: number): number {
  return clamp(MAX_PITCH - Math.floor(y / KEY_H), MIN_PITCH, MAX_PITCH)
}

export function yOfPitch(pitch: number): number {
  return (MAX_PITCH - pitch) * KEY_H
}

export function rowAtX(x: number, rowWidth: number, rows: number): number {
  return clamp(Math.floor(x / rowWidth), 0, rows - 1)
}

export interface NoteHit {
  channel: number
  index: number
  /** The last few pixels of a note resize it; the rest moves it. */
  part: 'body' | 'end'
}

/** The note under (x, y) on one channel. */
export function hitNote(song: Song, channel: number, x: number, y: number, rowWidth: number): NoteHit | null {
  const row = Math.floor(x / rowWidth)
  const index = noteAt(song.channels[channel], row, pitchAtY(y))
  if (index < 0) return null
  const note = song.channels[channel][index]
  const right = (note.row + note.length) * rowWidth
  const grip = Math.min(6, (note.length * rowWidth) / 3)
  return { channel, index, part: x >= right - grip ? 'end' : 'body' }
}

/** The channel being edited wins; a click that only finds another channel's note switches to it. */
export function hitAnyChannel(song: Song, preferred: number, x: number, y: number, rowWidth: number): NoteHit | null {
  const order = [preferred, ...[0, 1, 2].filter((channel) => channel !== preferred)]
  for (const channel of order) {
    const hit = hitNote(song, channel, x, y, rowWidth)
    if (hit) return hit
  }
  return null
}

/** Where a note is after an edit re-sorted its channel. */
export function indexOfNote(notes: readonly Note[], row: number, pitch: number): number {
  return notes.findIndex((note) => note.row === row && note.pitch === pitch)
}

export type RollDrag =
  /** A new note, from where the press landed to wherever the pointer is; `origin.length` is a click's. */
  | { kind: 'draw'; channel: number; origin: Note }
  | { kind: 'move'; channel: number; index: number; original: Note; grabRow: number; grabPitch: number }
  | { kind: 'resize'; channel: number; index: number; original: Note }
  /** Right-drag: every note the pointer crosses goes. */
  | { kind: 'erase'; channel: number }

/** The note a draw, move or resize drag makes at the pointer's row and pitch; null for erase. */
export function dragNote(base: Song, drag: RollDrag, row: number, pitch: number): Note | null {
  switch (drag.kind) {
    case 'draw':
      // A click places the origin's own length; dragging along the row sets it.
      return fitNote(base, { ...drag.origin, length: row === drag.origin.row ? drag.origin.length : Math.max(1, row - drag.origin.row + 1) })
    case 'move':
      return fitNote(base, { ...drag.original, row: drag.original.row + row - drag.grabRow, pitch: drag.original.pitch + pitch - drag.grabPitch })
    case 'resize':
      return fitNote(base, { ...drag.original, length: Math.max(1, row - drag.original.row + 1) })
    case 'erase':
      return null
  }
}

/**
 * The song a drag leaves, given the pointer's row and pitch. Draw, move and
 * resize are recomputed from the song as it was when the press landed (`base`),
 * so dragging back undoes what dragging forward did; erase accumulates, so
 * pass it the previous result.
 */
export function dragSong(base: Song, drag: RollDrag, row: number, pitch: number): Song {
  if (drag.kind === 'erase') {
    const index = noteAt(base.channels[drag.channel], row, pitch)
    return index >= 0 ? removeNote(base, drag.channel, index) : base
  }
  const note = dragNote(base, drag, row, pitch) as Note
  return drag.kind === 'draw' ? placeNote(base, drag.channel, note) : replaceNote(base, drag.channel, drag.index, note)
}
