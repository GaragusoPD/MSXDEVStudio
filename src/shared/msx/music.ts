/**
 * `*.music.json` (Spec 15): a bank of short PSG songs and the instruments they
 * share, rendered frame by frame to PSG registers and exported as **lVGM** —
 * the stream MSXgl's `vgm/lvgm_player` replays.
 *
 * One renderer serves both ends: `renderSong` produces one 14-register snapshot
 * per frame, the in-app audio plays exactly those frames, and `encodeLvgm`
 * writes exactly those frames. What the IDE plays is what the MSX plays.
 *
 * The lVGM rules below come from the player source (`engine/src/vgm/
 * lvgm_player.c`, `LVGM_Decode`/`LVGM_DecodePSG`), not from `lvgm.txt` alone:
 *
 *  - `En` ends the current `LVGM_Decode` call and adds `n` to the wait, so a
 *    group of writes followed by `En` lasts n+1 frames (16 at most).
 *  - `00 vv`/`02 vv`/`04 vv`/`07 vv` write R#0/2/4/7; `Dr` writes R#r = the
 *    header's "most common byte"; every other PSG opcode is one byte whose high
 *    nibble picks the register through `g_LVGM_RegTable` and whose *whole byte*
 *    is written (the PSG masks it — `0x6F` lands in R#8 as 15).
 *  - `FE` records the loop address as the byte after it, but on `FF` the player
 *    jumps there and then runs `g_LVGM_Pointer++` like after any opcode, so a
 *    repeat **skips the first byte after `FE`**. `encodeLvgm` writes `FE F0`:
 *    `F0` ("PSG chunk") is a one-byte no-op, so skipping it and running it are
 *    the same thing — and it stays right if the player is ever fixed.
 */

import { PSG_CLOCK } from '../psg'
import { defineName, type HelperC } from './emitC'
import type { ExportBlock } from './resource'

// ── model ───────────────────────────────────────────────────────────────────

export interface InstrumentStep {
  /** 0–15. */
  volume: number
  /** Added to the note: arpeggios, drum pitch drops. */
  semitones: number
  /** Fine offset in hundredths of a semitone: vibrato. */
  cents: number
  /** Square wave on. */
  tone: boolean
  /** Noise period 0–31, or null for noise off. */
  noise: number | null
}

export interface Instrument {
  name: string
  /** One per frame from note-on. */
  steps: InstrumentStep[]
  /** Step the sustain repeats from once the steps run out; null holds the last one. */
  loop: number | null
}

export interface Note {
  /** First row, from the top of the song. */
  row: number
  /** In rows. */
  length: number
  /** MIDI note number — 60 is C4, 69 is A4 (440 Hz). */
  pitch: number
  /** Index into `MusicDoc.instruments`. */
  instrument: number
  /** 0–15, scales the instrument: 15 plays it as designed. */
  volume: number
}

export interface Song {
  name: string
  bars: number
  /** Frames per row. Tempo is `rate · 60 / (speed · ROWS_PER_BEAT)` BPM. */
  speed: number
  /** Where a looping song jumps back to. */
  loopBar: number
  /** A, B, C. Each one plays one note at a time. */
  channels: [Note[], Note[], Note[]]
}

export interface MusicDoc {
  version: 1
  /** The rate the songs are authored at — how often the game calls the decoder. */
  rate: 50 | 60
  instruments: Instrument[]
  songs: Song[]
  export: ExportBlock | null
}

export const ROWS_PER_BEAT = 4
export const BEATS_PER_BAR = 4
export const ROWS_PER_BAR = ROWS_PER_BEAT * BEATS_PER_BAR
export const CHANNEL_COUNT = 3
export const CHANNEL_NAMES = ['A', 'B', 'C'] as const
export const MAX_SONGS = 32
export const MAX_INSTRUMENTS = 64
export const MAX_STEPS = 64
export const MAX_BARS = 64
export const MAX_SPEED = 31
/** C1 and B7: below C1 the 12-bit period runs out (A0 is the floor), above B7 the pitch gets coarse. */
export const MIN_PITCH = 24
export const MAX_PITCH = 107
export const MAX_SEMITONES = 48
export const MAX_CENTS = 100
/** The helper's own names: a song called one of these would collide with them. */
const HELPER_NAMES = ['Play', 'Stop', 'Pause', 'Resume', 'Decode', 'Regs']

// ── PSG registers ───────────────────────────────────────────────────────────

/** R#0–R#13. */
export const PSG_REGISTERS = 14
export const R_NOISE = 6
export const R_MIXER = 7
export const R_VOLUME = 8
/** What each register keeps — the chip ignores the rest of the byte. */
export const REGISTER_MASK: readonly number[] = [0xff, 0x0f, 0xff, 0x0f, 0xff, 0x0f, 0x1f, 0xff, 0x1f, 0x1f, 0x1f, 0xff, 0xff, 0x0f]
/**
 * Every channel's tone and noise off. Bits 6–7 are the joystick port
 * directions, which `PSG_Apply` overwrites from the chip anyway; `10` is what
 * the BIOS leaves there, so a register log reads the same as on the machine.
 */
export const MIXER_SILENT = 0xbf
/** Registers the music writes: tone A–C, noise, mixer, volume A–C. Never the envelope. */
export const MUSIC_REGISTERS = 11

export type PsgRegisters = Uint8Array

export function silentRegisters(): PsgRegisters {
  const regs = new Uint8Array(PSG_REGISTERS)
  regs[R_MIXER] = MIXER_SILENT
  // `PSG_Apply` only writes R#13 while bit 7 is clear; set means "leave it".
  regs[13] = 0xff
  return regs
}

/** Hz → 12-bit tone period, as the PSG divides: clock / (16 · period). */
export function periodForFrequency(frequency: number, clock = PSG_CLOCK): number {
  return Math.min(0xfff, Math.max(1, Math.round(clock / (16 * frequency))))
}

/** A MIDI pitch (fractional for cents) → tone period. A4 = 440 Hz, equal temperament. */
export function notePeriod(pitch: number): number {
  return periodForFrequency(440 * Math.pow(2, (pitch - 69) / 12))
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/** `60` → `C4`. */
export function noteName(pitch: number): string {
  return `${NOTE_NAMES[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 1}`
}

export function isBlackKey(pitch: number): boolean {
  return NOTE_NAMES[((pitch % 12) + 12) % 12].includes('#')
}

// ── timing ──────────────────────────────────────────────────────────────────

export function songRows(song: Song): number {
  return song.bars * ROWS_PER_BAR
}

export function songFrames(song: Song): number {
  return songRows(song) * song.speed
}

export function loopFrame(song: Song): number {
  return song.loopBar * ROWS_PER_BAR * song.speed
}

export function tempoBpm(rate: number, speed: number): number {
  return (rate * 60) / (speed * ROWS_PER_BEAT)
}

/** Which instrument step plays `frame` frames after note-on. */
export function stepIndex(instrument: Instrument, frame: number): number {
  const count = instrument.steps.length
  if (frame < count) return frame
  if (instrument.loop === null) return count - 1
  return instrument.loop + ((frame - instrument.loop) % (count - instrument.loop))
}

// ── normalisation ───────────────────────────────────────────────────────────

const int = (value: unknown, min: number, max: number, fallback = min): number => {
  const n = Math.round(Number(value))
  // `+ 0` turns -0 into 0: JSON writes -0 as 0, so a -0 would not survive a save.
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) + 0 : fallback
}

const record = (raw: unknown): Record<string, unknown> => (typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {})

export function normalizeStep(raw: unknown): InstrumentStep {
  const input = record(raw)
  return {
    volume: int(input.volume, 0, 15),
    semitones: int(input.semitones, -MAX_SEMITONES, MAX_SEMITONES, 0),
    cents: int(input.cents, -MAX_CENTS, MAX_CENTS, 0),
    tone: input.tone !== false,
    noise: input.noise === null || input.noise === undefined ? null : int(input.noise, 0, 31)
  }
}

export function normalizeInstrument(raw: unknown, index = 0): Instrument {
  const input = record(raw)
  const steps = (Array.isArray(input.steps) ? input.steps : []).slice(0, MAX_STEPS).map(normalizeStep)
  if (!steps.length) steps.push(normalizeStep({ volume: 12 }))
  const loop = input.loop === null || input.loop === undefined ? null : int(input.loop, 0, steps.length - 1)
  return { name: String(input.name ?? `instrument${index}`), steps, loop }
}

/**
 * A channel plays one note at a time, so overlaps are resolved the way drawing
 * resolves them: a note that starts inside an earlier one cuts it short.
 */
export function monophonic(notes: readonly Note[]): Note[] {
  const sorted = [...notes].sort((a, b) => a.row - b.row || a.pitch - b.pitch)
  const out: Note[] = []
  for (const note of sorted) {
    const last = out[out.length - 1]
    if (last && last.row === note.row) out.pop()
    else if (last && last.row + last.length > note.row) out[out.length - 1] = { ...last, length: note.row - last.row }
    out.push(note)
  }
  return out
}

/** Null for a note that starts outside the song — shortening a song drops what no longer fits. */
function normalizeNote(raw: unknown, rows: number, instruments: number): Note | null {
  const input = record(raw)
  const row = Math.round(Number(input.row))
  if (!Number.isFinite(row) || row < 0 || row >= rows) return null
  return {
    row,
    length: int(input.length, 1, rows - row, 1),
    pitch: int(input.pitch, MIN_PITCH, MAX_PITCH, 60),
    instrument: int(input.instrument, 0, Math.max(0, instruments - 1)),
    volume: int(input.volume, 0, 15, 15)
  }
}

export function normalizeSong(raw: unknown, instruments: number, index = 0): Song {
  const input = record(raw)
  const bars = int(input.bars, 1, MAX_BARS, 4)
  const rows = bars * ROWS_PER_BAR
  const rawChannels = Array.isArray(input.channels) ? input.channels : []
  const channel = (i: number): Note[] =>
    monophonic(
      (Array.isArray(rawChannels[i]) ? (rawChannels[i] as unknown[]) : [])
        .map((note) => normalizeNote(note, rows, instruments))
        .filter((note): note is Note => note !== null)
    )
  return {
    name: String(input.name ?? `song${index}`),
    bars,
    speed: int(input.speed, 1, MAX_SPEED, 5),
    loopBar: int(input.loopBar, 0, bars - 1, 0),
    channels: [channel(0), channel(1), channel(2)]
  }
}

export function normalizeMusic(raw: unknown): MusicDoc {
  const input = record(raw)
  const instruments = Array.isArray(input.instruments) && input.instruments.length
    ? input.instruments.slice(0, MAX_INSTRUMENTS).map(normalizeInstrument)
    : defaultInstruments()
  const songs = Array.isArray(input.songs) && input.songs.length
    ? input.songs.slice(0, MAX_SONGS).map((song, index) => normalizeSong(song, instruments.length, index))
    : [demoSong(instruments)]
  return {
    version: 1,
    rate: Number(input.rate) === 60 ? 60 : 50,
    instruments,
    songs,
    export: (input.export as ExportBlock | null | undefined) ?? null
  }
}

export function createMusicDoc(): MusicDoc {
  return normalizeMusic({})
}

/** `title theme` → `TitleTheme`: the song's part of its C table name. */
export function songSymbol(name: string): string {
  return (
    name
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('') || 'Song'
  )
}

export function validateMusic(doc: MusicDoc): string[] {
  const problems: string[] = []
  if (doc.version !== 1) problems.push(`Unsupported version ${doc.version}`)
  if (!doc.songs.length) problems.push('The bank has no songs')
  if (!doc.instruments.length) problems.push('The bank has no instruments')
  const seen = new Map<string, string>()
  for (const song of doc.songs) {
    const symbol = songSymbol(song.name)
    const clash = seen.get(symbol)
    if (clash !== undefined) problems.push(`"${song.name}" and "${clash}" both export as _${symbol}`)
    seen.set(symbol, song.name)
    if (HELPER_NAMES.includes(symbol)) problems.push(`A song can't be called "${song.name}": the helpers use _${symbol}`)
    if (/^[0-9]/.test(symbol)) problems.push(`"${song.name}" starts with a digit, which C names can't`)
    song.channels.forEach((notes, channel) => {
      if (notes.some((note) => note.instrument >= doc.instruments.length)) {
        problems.push(`"${song.name}" channel ${CHANNEL_NAMES[channel]} uses an instrument the bank doesn't have`)
      }
    })
  }
  return problems
}

// ── rendering ───────────────────────────────────────────────────────────────

/** What one channel sounds like on one frame. Volume 0 means silent. */
export interface Voice {
  volume: number
  period: number
  tone: boolean
  noise: number | null
}

/** For each row, the index of the note sounding there (-1 for none). */
function rowMap(notes: readonly Note[], rows: number): Int32Array {
  const map = new Int32Array(rows).fill(-1)
  notes.forEach((note, index) => {
    for (let row = note.row; row < Math.min(rows, note.row + note.length); row++) map[row] = index
  })
  return map
}

/** The instrument step `frame` frames into `note`, as a voice. */
export function noteVoice(instrument: Instrument, note: Note, frame: number): Voice {
  const step = instrument.steps[stepIndex(instrument, frame)]
  const volume = step.volume && note.volume ? Math.ceil((step.volume * note.volume) / 15) : 0
  return {
    volume,
    period: notePeriod(note.pitch + step.semitones + step.cents / 100),
    tone: step.tone,
    noise: step.noise
  }
}

/** Writes one frame's voices over the previous frame's registers. */
export function applyVoices(previous: PsgRegisters, voices: readonly (Voice | null)[]): PsgRegisters {
  const regs = previous.slice()
  let mixer = regs[R_MIXER]
  let noiseVolume = 0
  voices.forEach((voice, channel) => {
    const volume = voice?.volume ?? 0
    regs[R_VOLUME + channel] = volume
    // A silent channel's tone and mixer bits are inaudible; leaving them alone
    // is what keeps them out of the stream.
    if (!voice || volume === 0) return
    if (voice.tone) {
      regs[channel * 2] = voice.period & 0xff
      regs[channel * 2 + 1] = (voice.period >> 8) & 0x0f
    }
    mixer &= ~((1 << channel) | (8 << channel))
    if (!voice.tone) mixer |= 1 << channel
    if (voice.noise === null) mixer |= 8 << channel
    // One noise generator for three channels: the loudest gets its period,
    // and on a tie the later channel does.
    else if (volume >= noiseVolume) {
      noiseVolume = volume
      regs[R_NOISE] = voice.noise
    }
  })
  regs[R_MIXER] = mixer
  return regs
}

/**
 * The song as PSG register snapshots, one per frame — what `PSG_Apply` would
 * write after `LVGM_Decode`. `muted` silences channels for the editor's solo
 * and mute toggles; an export never passes it.
 */
export function renderSong(doc: MusicDoc, song: Song, muted: readonly boolean[] = []): PsgRegisters[] {
  const rows = songRows(song)
  const maps = song.channels.map((notes) => rowMap(notes, rows))
  const frames: PsgRegisters[] = []
  let previous = silentRegisters()
  for (let frame = 0; frame < rows * song.speed; frame++) {
    const row = Math.floor(frame / song.speed)
    const voices = song.channels.map((notes, channel) => {
      if (muted[channel]) return null
      const index = maps[channel][row]
      if (index < 0) return null
      const note = notes[index]
      const instrument = doc.instruments[note.instrument]
      return instrument ? noteVoice(instrument, note, frame - note.row * song.speed) : null
    })
    previous = applyVoices(previous, voices)
    frames.push(previous)
  }
  return frames
}

// ── lVGM ────────────────────────────────────────────────────────────────────

export const LVGM_WAIT = 0xe0
export const LVGM_PSG = 0xf0
export const LVGM_LOOP = 0xfe
export const LVGM_END = 0xff
export const LVGM_OPTION_50HZ = 0x01
export const LVGM_OPTION_LOOP = 0x02
/** Bytes before the stream: `lVGM`, options, most common byte. */
export const LVGM_HEADER = 6

/** `g_LVGM_RegTable`, indexed by an opcode's high nibble. */
const REG_TABLE = [0, 1, 3, 5, 6, 6, 8, 8, 9, 9, 10, 10, 13]
const TWO_BYTE = new Set([0, 2, 4, 7])

function opcode(register: number, value: number, common: number): number[] {
  if (TWO_BYTE.has(register)) return value === common ? [0xd0 | register] : [register, value]
  const low = value & 0x0f
  switch (register) {
    case 1:
      return [0x10 | low]
    case 3:
      return [0x20 | low]
    case 5:
      return [0x30 | low]
    case 6:
      return [(value & 0x10 ? 0x50 : 0x40) | low]
    case 8:
      return [(value & 0x10 ? 0x70 : 0x60) | low]
    case 9:
      return [(value & 0x10 ? 0x90 : 0x80) | low]
    case 10:
      return [(value & 0x10 ? 0xb0 : 0xa0) | low]
  }
  throw new Error(`lVGM: the music never writes R#${register}`)
}

/**
 * The registers each frame has to write. Frame 0 writes all of them, since
 * nothing is known about the PSG before it. The loop frame writes everything
 * that differs from *either* frame that can come before it — the one above it
 * on the first pass, or the last frame when the song comes round again.
 */
export function frameWrites(frames: readonly PsgRegisters[], loopAt: number): number[][] {
  const last = frames[frames.length - 1]
  return frames.map((regs, index) => {
    const writes: number[] = []
    for (let r = 0; r < MUSIC_REGISTERS; r++) {
      if (index === 0) writes.push(r)
      else if (regs[r] !== frames[index - 1][r] || (index === loopAt && regs[r] !== last[r])) writes.push(r)
    }
    return writes
  })
}

/** The most frequent two-byte value, which the `Dr` opcodes then write in one byte. */
function mostCommonByte(frames: readonly PsgRegisters[], writes: readonly number[][]): number {
  const counts = new Map<number, number>()
  writes.forEach((registers, index) => {
    for (const r of registers) {
      if (TWO_BYTE.has(r)) counts.set(frames[index][r], (counts.get(frames[index][r]) ?? 0) + 1)
    }
  })
  let best = 0
  let bestCount = 0
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && value < best)) {
      best = value
      bestCount = count
    }
  }
  return best
}

export function encodeLvgm(frames: readonly PsgRegisters[], options: { rate: 50 | 60; loopFrame: number }): Uint8Array {
  if (!frames.length) throw new Error('lVGM: a song needs at least one frame')
  const loopAt = Math.min(Math.max(0, options.loopFrame), frames.length - 1)
  const writes = frameWrites(frames, loopAt)
  const common = mostCommonByte(frames, writes)
  const out: number[] = [0x6c, 0x56, 0x47, 0x4d, (options.rate === 50 ? LVGM_OPTION_50HZ : 0) | LVGM_OPTION_LOOP, common]
  let index = 0
  while (index < frames.length) {
    if (index === loopAt) out.push(LVGM_LOOP, LVGM_PSG)
    for (const r of writes[index]) out.push(...opcode(r, frames[index][r], common))
    // This group lasts until the next frame that writes something, or the loop
    // frame — `FE` has to sit right before that frame's writes.
    let span = 1
    while (index + span < frames.length && index + span !== loopAt && !writes[index + span].length) span++
    index += span
    while (span > 0) {
      const wait = Math.min(16, span)
      out.push(LVGM_WAIT | (wait - 1))
      span -= wait
    }
  }
  out.push(LVGM_END)
  return Uint8Array.from(out)
}

export interface LvgmDecoder {
  /** False once a song played without looping has reached its end. */
  readonly playing: boolean
  /** One `LVGM_Decode` call, writing into `regs` the way it writes into `g_PSG_Regs`. */
  decode(regs: Uint8Array): void
}

/**
 * Replays an lVGM stream the way `LVGM_Play` + `LVGM_Decode` do — including
 * the byte the loop jump skips. PSG chunks only: this is the judge
 * `encodeLvgm` is tested against, not a general player. Stepwise, so a test
 * can put ayFX and the helper's register copy around each call exactly where
 * the game does.
 */
export function lvgmDecoder(bytes: Uint8Array, loop = true): LvgmDecoder {
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'lVGM') throw new Error('Not an lVGM stream')
  const common = bytes[5]
  let pointer = LVGM_HEADER
  let loopAddress = pointer
  let wait = 0
  let playing = true
  const need = (at: number): number => {
    if (at >= bytes.length) throw new Error(`lVGM: ran off the end of the stream at byte ${at}`)
    return bytes[at]
  }
  return {
    get playing() {
      return playing
    },
    decode(regs: Uint8Array): void {
      if (!playing) return
      if (wait) {
        wait--
        return
      }
      for (;;) {
        const op = need(pointer)
        if ((op & 0xf0) === 0xe0) {
          wait += op & 0x0f
          pointer++
          return
        }
        if ((op & 0xf0) === 0xf0) {
          if (op === LVGM_LOOP) loopAddress = pointer + 1
          else if (op === LVGM_END) {
            if (!loop) {
              // LVGM_Stop → LVGM_Pause → PSG_Mute.
              playing = false
              regs[8] = regs[9] = regs[10] = 0
              return
            }
            // …and then the `g_LVGM_Pointer++` below, which skips a byte.
            pointer = loopAddress
          } else if (op !== LVGM_PSG) throw new Error(`lVGM: unsupported marker 0x${op.toString(16)}`)
        } else if ((op & 0xf0) === 0x00) regs[op] = need(++pointer)
        else if ((op & 0xf0) === 0xd0) regs[op & 0x0f] = common
        else regs[REG_TABLE[op >> 4]] = op
        pointer++
      }
    }
  }
}

export interface LvgmPlayback {
  /** `g_PSG_Regs` after each `LVGM_Decode` call — unmasked, as the player leaves them. */
  frames: PsgRegisters[]
  /** Whether the song was still playing after each call. */
  playing: boolean[]
}

/** `calls` frames of `lvgmDecoder`, with nothing else touching the registers. */
export function simulateLvgm(bytes: Uint8Array, calls: number, loop = true): LvgmPlayback {
  const decoder = lvgmDecoder(bytes, loop)
  const regs = new Uint8Array(PSG_REGISTERS)
  const frames: PsgRegisters[] = []
  const playing: boolean[] = []
  for (let call = 0; call < calls; call++) {
    decoder.decode(regs)
    frames.push(regs.slice())
    playing.push(decoder.playing)
  }
  return { frames, playing }
}

/** The register as the chip holds it — what a register log on the real machine shows. */
export function maskRegisters(regs: PsgRegisters): PsgRegisters {
  return regs.map((value, r) => value & REGISTER_MASK[r])
}

// ── per-song export ─────────────────────────────────────────────────────────

export interface SongExport {
  song: Song
  symbol: string
  bytes: Uint8Array
  frames: number
  loopFrame: number
}

export function exportSong(doc: MusicDoc, song: Song): SongExport {
  const frames = renderSong(doc, song)
  const loopAt = loopFrame(song)
  return { song, symbol: songSymbol(song.name), bytes: encodeLvgm(frames, { rate: doc.rate, loopFrame: loopAt }), frames: frames.length, loopFrame: loopAt }
}

export function musicExports(doc: MusicDoc): SongExport[] {
  return doc.songs.map((song) => exportSong(doc, song))
}

// ── presets ─────────────────────────────────────────────────────────────────

const step = (fields: Partial<InstrumentStep>): InstrumentStep => normalizeStep({ volume: 12, ...fields })

/** One step per entry of `volumes`, every other field from `fields(i)`. */
function shape(volumes: readonly number[], fields: (i: number) => Partial<InstrumentStep> = () => ({})): InstrumentStep[] {
  return volumes.map((volume, i) => step({ volume, ...fields(i) }))
}

/** A gentle vibrato: `depth` cents either side, one cycle per 8 frames. */
function vibrato(volume: number, depth: number): InstrumentStep[] {
  return [0, 0.6, 1, 0.6, 0, -0.6, -1, -0.6].map((t) => step({ volume, cents: Math.round(t * depth) }))
}

/**
 * The instruments a new bank starts with. Melodic ones first; the drums are
 * tuned so a beat sounds right at the pitches `BEAT_PITCH` puts them on.
 */
export const INSTRUMENT_PRESETS: readonly Instrument[] = [
  { name: 'lead', steps: [...shape([15, 14, 13, 12, 12, 12, 11, 11, 11, 11, 11, 11]), ...vibrato(11, 18)], loop: 12 },
  { name: 'soft lead', steps: [...shape([7, 9, 11, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12]), ...vibrato(12, 14)], loop: 16 },
  { name: 'bass', steps: shape([15, 14, 13, 12, 12, 11, 11, 10]), loop: null },
  { name: 'pluck', steps: shape([15, 13, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]), loop: null },
  { name: 'chord major', steps: shape([11, 11, 11], (i) => ({ semitones: [0, 4, 7][i] })), loop: 0 },
  { name: 'chord minor', steps: shape([11, 11, 11], (i) => ({ semitones: [0, 3, 7][i] })), loop: 0 },
  { name: 'pad', steps: shape([2, 3, 4, 5, 6, 7, 8, 8, 9, 9, 10, 10]), loop: null },
  {
    name: 'kick',
    steps: shape([15, 15, 13, 11, 8, 5, 2, 0], (i) => ({ semitones: [0, -5, -10, -15, -19, -23, -26, -28][i], noise: i === 0 ? 12 : null })),
    loop: null
  },
  {
    name: 'snare',
    steps: shape([15, 14, 12, 10, 8, 6, 4, 3, 2, 1, 0], (i) => ({ noise: [6, 7, 7, 8, 8, 8, 9, 9, 9, 9, 9][i], tone: i < 2, semitones: -2 * i })),
    loop: null
  },
  { name: 'hat', steps: shape([11, 8, 5, 2, 0], () => ({ tone: false, noise: 1 })), loop: null },
  { name: 'open hat', steps: shape([11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0], () => ({ tone: false, noise: 1 })), loop: null },
  { name: 'tom', steps: shape([15, 13, 11, 9, 7, 5, 3, 1, 0], (i) => ({ semitones: -i })), loop: null }
]

export function defaultInstruments(): Instrument[] {
  return INSTRUMENT_PRESETS.map(copyInstrument)
}

export function copyInstrument(instrument: Instrument): Instrument {
  return { name: instrument.name, steps: instrument.steps.map((one) => ({ ...one })), loop: instrument.loop }
}

export function instrumentPreset(name: string): Instrument {
  const preset = INSTRUMENT_PRESETS.find((one) => one.name === name)
  if (!preset) throw new Error(`No such instrument preset: ${name}`)
  return copyInstrument(preset)
}

/** A drum hit in a beat pattern. */
export type DrumKind = 'kick' | 'snare' | 'hat' | 'open hat' | 'tom'

/** Where each drum sits on the piano roll — and the pitch its tone part plays at. */
export const BEAT_PITCH: Readonly<Record<DrumKind, number>> = {
  kick: 48,
  snare: 50,
  hat: 54,
  'open hat': 58,
  tom: 55
}

const BEAT_LETTERS: Readonly<Record<string, DrumKind>> = { K: 'kick', S: 'snare', H: 'hat', O: 'open hat', T: 'tom' }

export interface BeatPreset {
  name: string
  /** One bar, a character per row: K kick, S snare, H hat, O open hat, T tom, `.` rest. */
  pattern: string
}

/** One channel can only play one drum at a time, so each pattern is a single line of hits. */
export const BEAT_PRESETS: readonly BeatPreset[] = [
  { name: 'rock', pattern: 'K.H.S.H.K.K.S.H.' },
  { name: 'disco', pattern: 'K.O.S.O.K.O.S.O.' },
  { name: 'march', pattern: 'S.SSK.S.S.SSK.SS' },
  { name: 'gallop', pattern: 'K.HHS.HHK.HHS.HH' },
  { name: 'shuffle', pattern: 'K..HS..HK..HS..H' },
  { name: 'half-time', pattern: 'K.H.H.H.S.H.H.H.' },
  { name: 'drive', pattern: 'KHSHKHSHKHSHKSTT' },
  { name: 'hats only', pattern: 'H.H.H.H.H.H.H.H.' }
]

/** A beat's hits for one bar: each lasts until the next one starts. */
export function beatHits(pattern: string): { row: number; length: number; drum: DrumKind }[] {
  const rows = [...pattern.slice(0, ROWS_PER_BAR)].flatMap((letter, row) => (BEAT_LETTERS[letter] ? [{ row, drum: BEAT_LETTERS[letter] }] : []))
  return rows.map((hit, index) => ({ ...hit, length: (rows[index + 1]?.row ?? ROWS_PER_BAR) - hit.row }))
}

function instrumentIndex(instruments: readonly Instrument[], name: string): number {
  return Math.max(0, instruments.findIndex((one) => one.name === name))
}

/**
 * The song a new bank opens with, so the first Play makes a sound: four bars
 * in A minor — lead on A, bass on B, drums on C, the channel ayFX borrows by
 * default (losing a drum hit to an explosion is the loss nobody hears).
 */
export function demoSong(instruments: readonly Instrument[]): Song {
  const lead = instrumentIndex(instruments, 'lead')
  const bass = instrumentIndex(instruments, 'bass')
  const melody: [number, number, number][] = [
    [0, 4, 69], [4, 2, 72], [6, 2, 76], [8, 4, 74], [12, 2, 72], [14, 2, 71],
    [16, 4, 72], [20, 4, 69], [24, 8, 64],
    [32, 4, 65], [36, 2, 69], [38, 2, 72], [40, 4, 71], [44, 2, 68], [46, 2, 71],
    [48, 8, 69], [56, 4, 76], [60, 4, 69]
  ]
  const roots = [45, 45, 41, 40]
  const bassLine = roots.flatMap((root, bar) =>
    [0, 0, 12, 0, 0, 0, 12, 0].map((octave, i) => ({ row: bar * ROWS_PER_BAR + i * 2, length: 2, pitch: root + octave, instrument: bass, volume: 13 }))
  )
  const drums = Array.from({ length: 4 }, (_, bar) =>
    beatHits(BEAT_PRESETS[0].pattern).map((hit) => ({
      row: bar * ROWS_PER_BAR + hit.row,
      length: hit.length,
      pitch: BEAT_PITCH[hit.drum],
      instrument: instrumentIndex(instruments, hit.drum),
      volume: 15
    }))
  ).flat()
  return {
    name: 'theme',
    bars: 4,
    speed: 5,
    loopBar: 0,
    channels: [
      melody.map(([row, length, pitch]) => ({ row, length, pitch, instrument: lead, volume: 15 })),
      bassLine,
      drums
    ]
  }
}

// ── export: constants and the ready-made C ──────────────────────────────────

/** Per song: how long it is and where it loops, for a game that wants to sync to it. */
export function musicConstants(doc: MusicDoc, name: string): string[] {
  return doc.songs.flatMap((song) => {
    const prefix = defineName(`${name}_${songSymbol(song.name)}`)
    return [`#define ${prefix}_FRAMES ${songFrames(song)}`, `#define ${prefix}_LOOP_FRAME ${loopFrame(song)}`]
  })
}

/**
 * The helper. Its one job beyond naming MSXgl's calls is `_Decode`'s register
 * copy: lVGM writes only the registers that change, and `ayFX_Update` writes
 * its channel into the same `g_PSG_Regs`, so without a copy of the music's own
 * registers a held note keeps the effect's pitch, volume and mixer bits until
 * the song happens to rewrite them. R#13 is left out: `PSG_Apply` writes it
 * only while bit 7 is clear and then sets that bit, so restoring it each frame
 * would retrigger the envelope.
 */
export function musicHelperC(name: string): HelperC {
  const regs = `${name}_Regs`
  return {
    header: [
      `// Music (lVGM). Once per frame, in this order:`,
      `//   ${name}_Decode();   // this frame of the song`,
      `//   ayFX_Update();      // optional: a sound effect borrows its channel`,
      `//   PSG_Apply();        // the registers go to the PSG`,
      `// Needs LibModules "psg" and "vgm/lvgm_player" ("ayfx/ayfx_player" for effects),`,
      `// and AYFX_BUFFER_DEFAULT in msxgl_config.h when effects play over the music.`,
      `void ${name}_Play(const u8* song, bool loop);`,
      `void ${name}_Stop();`,
      `void ${name}_Pause();`,
      `void ${name}_Resume();`,
      `void ${name}_Decode();`,
      ''
    ],
    source: [
      '#include "vgm/lvgm_player.h"',
      '',
      '#if (PSG_ACCESS != PSG_INDIRECT)',
      '\t#error "The music helpers need PSG_ACCESS PSG_INDIRECT in msxgl_config.h: they keep the song in g_PSG_Regs"',
      '#endif',
      '#if !(LVGM_USE_PSG)',
      '\t#error "The music helpers need LVGM_USE_PSG TRUE in msxgl_config.h"',
      '#endif',
      '',
      '// The song\'s own R#0-R#12, so a sound effect cannot leave its channel wrong:',
      '// lVGM writes only what changes, and ayFX_Update() writes into g_PSG_Regs too.',
      `static u8 ${regs}[13];`,
      '',
      `// Start a song from the top. With loop, it goes round from its loop bar forever.`,
      `void ${name}_Play(const u8* song, bool loop)`,
      '{',
      '\tLVGM_Play(song, loop);',
      '\t// LVGM_Play muted the volumes; the stream\'s first frame writes the rest.',
      `\tMem_Copy(&g_PSG_Regs, ${regs}, 13);`,
      '}',
      '',
      `// Stop for good: the next song starts with ${name}_Play().`,
      `void ${name}_Stop()`,
      '{',
      '\tLVGM_Stop();',
      '}',
      '',
      `// Silence the song where it is; ${name}_Resume() carries on from there.`,
      `void ${name}_Pause()`,
      '{',
      '\tLVGM_Pause();',
      '}',
      '',
      `void ${name}_Resume()`,
      '{',
      '\tLVGM_Resume();',
      '}',
      '',
      `// One frame of the song into g_PSG_Regs. Call before ayFX_Update() and PSG_Apply().`,
      `void ${name}_Decode()`,
      '{',
      '\tif (!LVGM_IsPlaying())',
      '\t\treturn;',
      `\tMem_Copy(${regs}, &g_PSG_Regs, 13);`,
      '\tLVGM_Decode();',
      `\tMem_Copy(&g_PSG_Regs, ${regs}, 13);`,
      '}',
      ''
    ]
  }
}
