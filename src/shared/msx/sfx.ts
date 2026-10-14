/**
 * `*.sfx.json` (Spec 11): a bank of PSG sound effects, plus the **ayFX** bank
 * codec MSXgl's `ayfx/ayfx_player` replays.
 *
 * The byte layout below is derived from the player source itself
 * (`engine/src/ayfx/ayfx_player.c`, ayFX REPLAYER v1.31 by SapphiRe), not from
 * documentation — the line references are to that file:
 *
 * **Bank** (`.afb`)
 * ```
 * +0            u8    effect count (0 means 256)                 — `ld a,(hl)` L115
 * +1 + 2*i      u16le increment for effect i                     — L155-165
 * ```
 * `ayFX_PlayBank` walks `hl = bank + 1 + 2*i`, reads the u16 into `de` leaving
 * `hl` on the entry's **high** byte (`bank + 2 + 2*i`), then `add hl,de`. So an
 * effect stored at byte offset `off` has increment `off - (2 + 2*i)`. Streams
 * follow the table back to back, so the first increment is always `2*count - 1`.
 *
 * **Frame** (one control byte, then 0–3 payload bytes) — `ayFX_Update` L217-254
 * ```
 * bit 7  noise OFF   (set = this frame's mixer disables noise)   — `bit 7,c` L271
 * bit 6  new noise follows (1 byte)                              — `bit 6,c` L233
 * bit 5  new tone follows (2 bytes, u16le, 12-bit period)        — `bit 5,c` L223
 * bit 4  tone OFF    (set = this frame's mixer disables tone)    — `and #0x90` L277
 * bits 3-0  volume 0-15                                          — `and #0x0F` L253
 * ```
 * Tone and noise are *sticky*: a frame without bit 5 / bit 6 reuses the last
 * value the player latched. **End of stream** is a frame whose bit 6 is set and
 * whose noise byte is `0x20` — an illegal 5-bit noise period, used as the
 * sentinel (L238). Every real MSXgl effect terminates with `D0 20`, which is
 * what `encodeAyfxStream` emits.
 *
 * A single-effect `.afx` file (what AYFX Editor saves) is just one such stream
 * with no bank header — `ayFX_Play` takes a pointer straight to it (L187).
 */

import { defineName, type HelperC } from './emitC'
import type { ExportBlock } from './resource'

/** One 50/60 Hz tick of an effect. */
export interface SfxFrame {
  toneOn: boolean
  /** 12-bit tone period; frequency = clock / (16 * period), so bigger = lower. */
  tone: number
  noiseOn: boolean
  /** 5-bit noise period (0–31). 0x20 is reserved as the end-of-stream marker. */
  noise: number
  /** 0–15. **Zero means "leave the PSG alone"** to the real player, not silence. */
  volume: number
}

export interface SfxEffect {
  name: string
  frames: SfxFrame[]
  /**
   * 0–15, **0 the most important** — ayFX's own scale. A new effect plays only
   * if it is at least as important as the one sounding, so a death cry is
   * never cut off by a coin. Absent means `DEFAULT_PRIORITY`.
   */
  priority?: number
}

export interface SfxDoc {
  version: 1
  /** Replay rate the effects were authored at; 50 (PAL/VBlank) or 60 (NTSC). */
  rate: 50 | 60
  effects: SfxEffect[]
  /** The PSG channel the effects borrow, 0–2 for A–C. Absent means C, ayFX's own default. */
  channel?: number
  export: ExportBlock | null
}

export const MAX_TONE = 0xfff
export const MAX_NOISE = 0x1f
export const MAX_VOLUME = 15
/** `ayFX_PlayBank` indexes the table with a byte, and 0 in the count byte means 256. */
export const MAX_EFFECTS = 256
/** The end-of-stream sentinel: an out-of-range noise period. */
export const AYFX_END_NOISE = 0x20
/** New effects start here; the frame count is editable per effect. */
export const DEFAULT_FRAMES = 16
/** The middle of ayFX's 0–15: room for effects that matter more, and for ones that matter less. */
export const DEFAULT_PRIORITY = 8
export const MAX_PRIORITY = 15
/** Channel C: what `ayfx_player.c` starts on, and the one music minds losing least. */
export const DEFAULT_SFX_CHANNEL = 2

export function effectPriority(effect: SfxEffect): number {
  return effect.priority ?? DEFAULT_PRIORITY
}

export function sfxChannel(doc: SfxDoc): number {
  return doc.channel ?? DEFAULT_SFX_CHANNEL
}

const clamp = (value: unknown, max: number): number => {
  const n = Math.round(Number(value))
  return Number.isFinite(n) ? Math.min(max, Math.max(0, n)) : 0
}

export function blankFrame(): SfxFrame {
  return { toneOn: true, tone: 0, noiseOn: false, noise: 0, volume: 0 }
}

export function normalizeFrame(raw: unknown): SfxFrame {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<SfxFrame>
  return {
    toneOn: input.toneOn !== false,
    tone: clamp(input.tone, MAX_TONE),
    noiseOn: input.noiseOn === true,
    noise: clamp(input.noise, MAX_NOISE),
    volume: clamp(input.volume, MAX_VOLUME)
  }
}

export function createSfxDoc(): SfxDoc {
  return normalizeSfx({ effects: [{ name: 'fx0', frames: [] }] })
}

export function normalizeSfx(raw: unknown): SfxDoc {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<SfxDoc>
  const rawEffects = Array.isArray(input.effects) && input.effects.length ? input.effects : [{}]
  const effects: SfxEffect[] = rawEffects.slice(0, MAX_EFFECTS).map((entry, index) => {
    const effect = (typeof entry === 'object' && entry !== null ? entry : {}) as Partial<SfxEffect>
    const frames = Array.isArray(effect.frames) ? effect.frames.map(normalizeFrame) : []
    return {
      name: String(effect.name ?? `fx${index}`),
      frames: frames.length ? frames : Array.from({ length: DEFAULT_FRAMES }, blankFrame),
      // Only written when set, so a bank from before priorities reads back unchanged.
      ...(effect.priority === undefined ? {} : { priority: clamp(effect.priority, MAX_PRIORITY) })
    }
  })
  return {
    version: 1,
    rate: Number(input.rate) === 60 ? 60 : 50,
    effects,
    ...(input.channel === undefined ? {} : { channel: clamp(input.channel, 2) }),
    export: input.export ?? null
  }
}

export function validateSfx(doc: SfxDoc): string[] {
  const problems: string[] = []
  if (doc.version !== 1) problems.push(`Unsupported version ${doc.version}`)
  if (!doc.effects.length) problems.push('Bank has no effects')
  if (doc.effects.length > MAX_EFFECTS) problems.push(`Bank holds ${doc.effects.length} effects; the format allows ${MAX_EFFECTS}`)
  doc.effects.forEach((effect, index) => {
    if (!effect.name.trim()) problems.push(`Effect ${index} has no name`)
    if (!effect.frames.length) problems.push(`"${effect.name}" has no frames`)
    if (effect.frames.some((frame) => frame.volume > 0 && !frame.toneOn && !frame.noiseOn)) {
      // The player bails out of a frame whose mixer disables both (`cp #0x90; ret z`),
      // so it holds the previous frame's sound instead of going quiet.
      problems.push(`"${effect.name}" has audible frames with both tone and noise off — the player will hold the previous sound`)
    }
  })
  const size = encodeAyfxBank(doc.effects).length
  if (size > 0xffff) problems.push(`Bank is ${size} bytes; the 16-bit offset table tops out at 65535`)
  return problems
}

// ── ayFX codec ──────────────────────────────────────────────────────────────

/**
 * One effect → one ayFX stream, terminated by `D0 20`. Tone/noise bytes are
 * emitted only when the value differs from what the player has latched, which
 * is exactly the rule AYFX Editor uses — see the byte-identity test.
 */
export function encodeAyfxStream(frames: readonly SfxFrame[]): Uint8Array {
  const out: number[] = []
  // -1 = "the player has latched nothing yet", so the first frame always writes both.
  let tone = -1
  let noise = -1
  for (const frame of frames) {
    // Out-of-range noise would collide with the end marker, so this never silently truncates.
    if (frame.noise > MAX_NOISE || frame.tone > MAX_TONE || frame.volume > MAX_VOLUME || frame.noise < 0 || frame.tone < 0 || frame.volume < 0) {
      throw new Error(`Frame out of range for ayFX: tone=${frame.tone} noise=${frame.noise} volume=${frame.volume}`)
    }
    const newTone = frame.tone !== tone
    const newNoise = frame.noise !== noise
    let control = frame.volume & 0x0f
    if (!frame.toneOn) control |= 0x10
    if (newTone) control |= 0x20
    if (newNoise) control |= 0x40
    if (!frame.noiseOn) control |= 0x80
    out.push(control)
    if (newTone) {
      out.push(frame.tone & 0xff, (frame.tone >> 8) & 0xff)
      tone = frame.tone
    }
    if (newNoise) {
      out.push(frame.noise & 0xff)
      noise = frame.noise
    }
  }
  out.push(0xd0, AYFX_END_NOISE)
  return Uint8Array.from(out)
}

export interface DecodedStream {
  frames: SfxFrame[]
  /** Byte offset just past the end marker — where the next stream in a bank starts. */
  end: number
}

export function decodeAyfxStream(bytes: Uint8Array, start = 0): DecodedStream {
  const frames: SfxFrame[] = []
  let tone = 0
  let noise = 0
  let p = start
  const need = (count: number): void => {
    if (p + count > bytes.length) throw new Error(`Truncated ayFX stream at byte ${p}`)
  }
  for (;;) {
    need(1)
    const control = bytes[p++]
    if (control & 0x20) {
      need(2)
      tone = bytes[p] | (bytes[p + 1] << 8)
      p += 2
    }
    if (control & 0x40) {
      need(1)
      const value = bytes[p++]
      if (value === AYFX_END_NOISE) return { frames, end: p }
      noise = value
    }
    frames.push({
      toneOn: (control & 0x10) === 0,
      tone,
      noiseOn: (control & 0x80) === 0,
      noise,
      volume: control & 0x0f
    })
  }
}

export function encodeAyfxBank(effects: readonly SfxEffect[]): Uint8Array {
  if (effects.length > MAX_EFFECTS) throw new Error(`An ayFX bank holds at most ${MAX_EFFECTS} effects`)
  const streams = effects.map((effect) => encodeAyfxStream(effect.frames))
  const count = effects.length
  const header = 1 + 2 * count
  const out = new Uint8Array(header + streams.reduce((sum, s) => sum + s.length, 0))
  out[0] = count & 0xff // 256 wraps to 0, which is what the player reads as "256 samples"
  let offset = header
  for (let i = 0; i < count; i++) {
    // The player's `hl` sits on the entry's high byte (bank + 2 + 2i) when it adds the increment.
    const increment = offset - (2 + 2 * i)
    out[1 + 2 * i] = increment & 0xff
    out[2 + 2 * i] = (increment >> 8) & 0xff
    out.set(streams[i], offset)
    offset += streams[i].length
  }
  return out
}

export function decodeAyfxBank(bytes: Uint8Array): SfxEffect[] {
  if (bytes.length < 3) throw new Error('Not an ayFX bank: too short')
  const count = bytes[0] === 0 ? MAX_EFFECTS : bytes[0]
  if (bytes.length < 1 + 2 * count) throw new Error(`Not an ayFX bank: ${count} effects need a ${1 + 2 * count}-byte offset table`)
  const effects: SfxEffect[] = []
  for (let i = 0; i < count; i++) {
    const increment = bytes[1 + 2 * i] | (bytes[2 + 2 * i] << 8)
    const start = 2 + 2 * i + increment
    if (start < 1 + 2 * count || start >= bytes.length) throw new Error(`Not an ayFX bank: effect ${i} points outside the file`)
    effects.push({ name: `fx${i}`, frames: decodeAyfxStream(bytes, start).frames })
  }
  return effects
}

/**
 * Import an AYFX Editor file: `.afb` is a bank, `.afx` a single stream. Both
 * are untagged blobs, so the extension picks the first reading and the other
 * one is the fallback — a whole real `.afx` is exactly one stream, so "the
 * decode didn't reach the end of the file" is a reliable "this isn't one".
 */
export function importAyfx(bytes: Uint8Array, filename: string): SfxEffect[] {
  const base = (filename.split(/[\\/]/).pop() ?? filename).replace(/\.[^.]*$/, '') || 'imported'
  const asBank = (): SfxEffect[] => decodeAyfxBank(bytes)
  const asStream = (): SfxEffect[] => {
    const { frames, end } = decodeAyfxStream(bytes)
    if (end !== bytes.length) throw new Error(`Not a single ayFX effect: ${bytes.length - end} trailing bytes`)
    return [{ name: base, frames }]
  }
  // A hand-edited file can carry a 13-bit tone in its high byte; clamp on the way
  // in so a bad import can't produce a document the encoder later refuses to save.
  const clean = (effects: SfxEffect[]): SfxEffect[] =>
    effects.map((effect) => ({ name: effect.name, frames: effect.frames.map(normalizeFrame) }))
  const bankFirst = filename.toLowerCase().endsWith('.afb')
  try {
    return clean(bankFirst ? asBank() : asStream())
  } catch (error) {
    try {
      return clean(bankFirst ? asStream() : asBank())
    } catch {
      throw error
    }
  }
}

// ── presets ─────────────────────────────────────────────────────────────────

/** `steps` frames interpolating each named field from its first value to its second. */
function ramp(steps: number, spec: { tone?: [number, number]; noise?: [number, number]; volume: [number, number]; noiseOn?: boolean; toneOn?: boolean }): SfxFrame[] {
  const at = (pair: [number, number] | undefined, i: number, fallback = 0): number => {
    if (!pair) return fallback
    return Math.round(pair[0] + ((pair[1] - pair[0]) * i) / Math.max(1, steps - 1))
  }
  return Array.from({ length: steps }, (_, i) => ({
    toneOn: spec.toneOn !== false,
    tone: at(spec.tone, i),
    noiseOn: spec.noiseOn === true,
    noise: at(spec.noise, i),
    volume: Math.max(1, at(spec.volume, i))
  }))
}

/** The five starting points on the toolbar. Frame values are periods, so tone rising = pitch falling. */
export const SFX_PRESETS: readonly SfxEffect[] = [
  // Downward chirp, ~1.9 kHz to ~220 Hz over a quarter second.
  { name: 'laser', frames: ramp(12, { tone: [60, 500], volume: [15, 3] }) },
  // Upward chirp, quieter tail.
  { name: 'jump', frames: ramp(10, { tone: [520, 140], volume: [13, 5] }) },
  // Noise only, period opening up from a hiss to a rumble as it decays.
  { name: 'explosion', frames: ramp(24, { noise: [1, 26], volume: [15, 1], noiseOn: true, toneOn: false }) },
  // Two-note blip.
  {
    name: 'pickup',
    frames: [...ramp(4, { tone: [300, 300], volume: [14, 14] }), ...ramp(5, { tone: [200, 200], volume: [14, 6] })]
  },
  // Low thud: a short noise burst under a low tone.
  {
    name: 'hit',
    frames: ramp(7, { tone: [900, 1400], noise: [3, 9], volume: [15, 2], noiseOn: true })
  }
]

export function presetEffect(name: string): SfxEffect {
  const preset = SFX_PRESETS.find((entry) => entry.name === name)
  if (!preset) throw new Error(`No such ayFX preset: ${name}`)
  return { name: preset.name, frames: preset.frames.map((frame) => ({ ...frame })) }
}

// ── export: ids and the ready-made C ────────────────────────────────────────

/**
 * One `#define` per effect, so game code says `G_SFX_JUMP` rather than 1 and
 * reordering the bank cannot silently change which sound plays. A name that
 * would collide — with another effect's, or with the table's own `_SIZE` and
 * `_COUNT` — gets its index appended rather than a duplicate definition.
 */
export function sfxIds(doc: SfxDoc, name: string): { define: string; index: number }[] {
  const prefix = defineName(name)
  const taken = new Set([`${prefix}_SIZE`, `${prefix}_COUNT`])
  return doc.effects.map((effect, index) => {
    const base = `${prefix}_${defineName(effect.name.trim()) || 'FX'}`
    const define = taken.has(base) ? `${base}_${index}` : base
    taken.add(define)
    return { define, index }
  })
}

export function sfxConstants(doc: SfxDoc, name: string): string[] {
  return [`#define ${defineName(name)}_COUNT ${doc.effects.length}`, ...sfxIds(doc, name).map(({ define, index }) => `#define ${define} ${index}`)]
}

const CHANNEL_MACROS = ['PSG_CHANNEL_A', 'PSG_CHANNEL_B', 'PSG_CHANNEL_C']

/**
 * The bank's ready-made C: set ayFX up on the bank's channel, play by id at
 * each effect's own priority, and — for a game with no music — the per-frame
 * call. A game with music calls the music bank's `_Update()` instead, which
 * runs `ayFX_Update()` between the song and `PSG_Apply()`.
 */
export function sfxHelperC(doc: SfxDoc, name: string): HelperC {
  const priorities = doc.effects.map(effectPriority)
  return {
    header: [
      `// Sound effects (ayFX). ${name}_Init() once, then ${name}_Play(id) — ids are the defines above.`,
      `// Once per frame: ${name}_Update() — or, with music, the music bank's _Update(), which does it.`,
      `// Needs LibModules "psg" and "ayfx/ayfx_player", and AYFX_BUFFER_DEFAULT in msxgl_config.h.`,
      `void ${name}_Init();`,
      `u8 ${name}_Play(u8 id);`,
      `u8 ${name}_PlayPriority(u8 id, u8 priority);`,
      `void ${name}_Stop();`,
      `bool ${name}_IsPlaying();`,
      `void ${name}_Update();`,
      ''
    ],
    source: [
      '#include "ayfx/ayfx_player.h"',
      '',
      '// Each effect\'s priority, 0 the most important: a sound only cuts off one that',
      '// matters as much or less.',
      `static const u8 ${name}_Priority[] = { ${priorities.join(', ')} };`,
      '',
      `// The bank, on channel ${'ABC'[sfxChannel(doc)]}, nothing playing.`,
      `void ${name}_Init()`,
      '{',
      // The bank is const (it lives in ROM) and ayFX_InitBank takes a plain void*
      // although it only reads through it: the cast is what the API forces.
      '#pragma save',
      '#pragma disable_warning 357',
      `\tayFX_InitBank((void*)${name});`,
      '#pragma restore',
      '\tayFX_SetMode(AYFX_MODE_FIXED);',
      `\tayFX_SetChannel(${CHANNEL_MACROS[sfxChannel(doc)]});`,
      '\tayFX_Stop();',
      '}',
      '',
      '// Play an effect at its own priority. 0 when it plays; 1 when a more important',
      '// one is sounding and it does not.',
      `u8 ${name}_Play(u8 id)`,
      '{',
      `\treturn ayFX_PlayBank(id, ${name}_Priority[id]);`,
      '}',
      '',
      `// The same, overriding the effect's priority for this one call.`,
      `u8 ${name}_PlayPriority(u8 id, u8 priority)`,
      '{',
      '\treturn ayFX_PlayBank(id, priority);',
      '}',
      '',
      `// Cut the effect off and silence its channel — music there comes back next frame.`,
      `void ${name}_Stop()`,
      '{',
      `\tif (${name}_IsPlaying())`,
      '\t\tayFX_Mute();',
      '}',
      '',
      `bool ${name}_IsPlaying()`,
      '{',
      '\treturn (ayFX_Priority & 0x80) == 0;',
      '}',
      '',
      `// Once per frame, in a game without music: the effect, then out to the PSG.`,
      `void ${name}_Update()`,
      '{',
      '\tayFX_Update();',
      '\tPSG_Apply();',
      '}',
      ''
    ]
  }
}
