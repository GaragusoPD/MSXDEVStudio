/**
 * SFX editor (Spec 11) — the editing logic that isn't format knowledge: what a
 * drag across a lane paints, how the frame count changes, the effect-list
 * operations and the undo stack.
 *
 * Pure, so Vitest drives it directly; `editors/sfx/*.vue` is a thin shell that
 * turns mouse positions into `paintLane` calls. The ayFX byte format and the
 * document shape live in `shared/msx/sfx.ts`; the audition DSP in `shared/psg.ts`.
 */

import { blankFrame, MAX_EFFECTS, MAX_NOISE, MAX_TONE, MAX_VOLUME, type SfxDoc, type SfxEffect, type SfxFrame } from './msx/sfx'

// ── undo stack ──────────────────────────────────────────────────────────────
// ponytail: same four functions as `sprite-editor.ts`, typed to SfxDoc. Worth
// hoisting into one generic `History<T>` the day a third editor needs it.

export interface SfxHistory {
  past: SfxDoc[]
  present: SfxDoc
  future: SfxDoc[]
}

const HISTORY_LIMIT = 200

export function createHistory(doc: SfxDoc): SfxHistory {
  return { past: [], present: doc, future: [] }
}

/** Records `next` as the new present; no-ops when nothing actually changed (reference-equal). */
export function pushHistory(history: SfxHistory, next: SfxDoc): SfxHistory {
  if (next === history.present) return history
  return { past: [...history.past, history.present].slice(-HISTORY_LIMIT), present: next, future: [] }
}

export function undo(history: SfxHistory): SfxHistory {
  if (!history.past.length) return history
  const present = history.past[history.past.length - 1]
  return { past: history.past.slice(0, -1), present, future: [history.present, ...history.future] }
}

export function redo(history: SfxHistory): SfxHistory {
  if (!history.future.length) return history
  const [present, ...future] = history.future
  return { past: [...history.past, history.present], present, future }
}

// ── lanes ───────────────────────────────────────────────────────────────────

/** The three stacked lanes of the frame grid. */
export type SfxLane = 'tone' | 'noise' | 'volume'

export const LANE_MAX: Readonly<Record<SfxLane, number>> = {
  tone: MAX_TONE,
  noise: MAX_NOISE,
  volume: MAX_VOLUME
}

export const LANE_LABEL: Readonly<Record<SfxLane, string>> = {
  tone: 'Pitch',
  noise: 'Noise',
  volume: 'Volume'
}

/**
 * Lane value for a height `t` (0 at the lane's bottom, 1 at its top).
 *
 * Tone and noise are *periods*, so they're inverted: dragging up shortens the
 * period, which is what "up = higher pitch / brighter hiss" has to mean.
 *
 * The tone lane is **logarithmic**, because a period is the reciprocal of a
 * frequency: a linear 0–4095 lane puts every musically useful period in its top
 * few pixels (in MSXgl's own ayFX bank, 90% of frames are under period 360).
 * Log spacing makes equal screen distance an equal pitch interval, which is
 * what "pitch curve" has to mean. Noise and volume have small enough ranges to
 * stay linear.
 */
export function valueFromHeight(lane: SfxLane, t: number): number {
  const clamped = Math.min(1, Math.max(0, t))
  const max = LANE_MAX[lane]
  if (lane === 'volume') return Math.round(clamped * max)
  if (lane === 'noise') return Math.round((1 - clamped) * max)
  return Math.round(max ** (1 - clamped))
}

/** The inverse — where a value sits in its lane, 0 at the bottom. */
export function heightFromValue(lane: SfxLane, value: number): number {
  const max = LANE_MAX[lane]
  if (lane === 'tone') {
    // Period 0 means "1" to the hardware, and log(0) has no home on the lane.
    return 1 - Math.log(Math.min(max, Math.max(1, value))) / Math.log(max)
  }
  const t = Math.min(1, Math.max(0, value / max))
  return lane === 'volume' ? t : 1 - t
}

export function laneValue(frame: SfxFrame, lane: SfxLane): number {
  return lane === 'tone' ? frame.tone : lane === 'noise' ? frame.noise : frame.volume
}

/** True when the lane is contributing to this frame's sound (drawn "on" in the grid). */
export function laneActive(frame: SfxFrame, lane: SfxLane): boolean {
  return lane === 'tone' ? frame.toneOn : lane === 'noise' ? frame.noiseOn : frame.volume > 0
}

function withLane(frame: SfxFrame, lane: SfxLane, value: number): SfxFrame {
  if (lane === 'tone') return { ...frame, toneOn: true, tone: Math.min(MAX_TONE, Math.max(0, Math.round(value))) }
  if (lane === 'noise') return { ...frame, noiseOn: true, noise: Math.min(MAX_NOISE, Math.max(0, Math.round(value))) }
  return { ...frame, volume: Math.min(MAX_VOLUME, Math.max(0, Math.round(value))) }
}

/** Right-drag: switch the generator off (or, for volume, back to zero). */
function erasedLane(frame: SfxFrame, lane: SfxLane): SfxFrame {
  if (lane === 'tone') return { ...frame, toneOn: false }
  if (lane === 'noise') return { ...frame, noiseOn: false }
  return { ...frame, volume: 0 }
}

export interface LaneStroke {
  /** Frame index under the pointer. */
  index: number
  /** Lane value there (use `valueFromHeight` to get it from a pixel position). */
  value: number
}

/**
 * Paints one lane over the span the pointer just swept, interpolating between
 * the two samples so a fast drag doesn't leave gaps. `from === to` paints a
 * single frame. Out-of-range indices are ignored, and a stroke that changes
 * nothing returns the same array so the undo stack skips it.
 */
export function paintLane(frames: readonly SfxFrame[], lane: SfxLane, from: LaneStroke, to: LaneStroke, erase = false): SfxFrame[] {
  const first = Math.min(from.index, to.index)
  const last = Math.max(from.index, to.index)
  let changed = false
  const next = frames.map((frame, index) => {
    if (index < first || index > last) return frame
    const span = to.index - from.index
    const t = span === 0 ? 1 : (index - from.index) / span
    const value = from.value + (to.value - from.value) * t
    const painted = erase ? erasedLane(frame, lane) : withLane(frame, lane, value)
    if (
      painted.tone !== frame.tone ||
      painted.noise !== frame.noise ||
      painted.volume !== frame.volume ||
      painted.toneOn !== frame.toneOn ||
      painted.noiseOn !== frame.noiseOn
    ) {
      changed = true
      return painted
    }
    return frame
  })
  return changed ? next : (frames as SfxFrame[])
}

// ── frames ──────────────────────────────────────────────────────────────────

export const MAX_FRAMES = 255

/** Grows with blank frames or truncates. Frame count is per effect. */
export function setFrameCount(frames: readonly SfxFrame[], count: number): SfxFrame[] {
  const target = Math.min(MAX_FRAMES, Math.max(1, Math.round(count) || 1))
  if (target === frames.length) return frames as SfxFrame[]
  if (target < frames.length) return frames.slice(0, target)
  return [...frames, ...Array.from({ length: target - frames.length }, blankFrame)]
}

// ── effect list ─────────────────────────────────────────────────────────────

/** A name not already taken in the bank: `fx`, `fx2`, `fx3`… */
export function uniqueName(effects: readonly SfxEffect[], base: string): string {
  const taken = new Set(effects.map((effect) => effect.name))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}${n}`
    if (!taken.has(candidate)) return candidate
  }
}

function withEffects(doc: SfxDoc, effects: SfxEffect[]): SfxDoc {
  return { ...doc, effects }
}

export function addEffect(doc: SfxDoc, effect: SfxEffect): SfxDoc {
  if (doc.effects.length >= MAX_EFFECTS) return doc
  return withEffects(doc, [...doc.effects, { ...effect, name: uniqueName(doc.effects, effect.name) }])
}

export function duplicateEffect(doc: SfxDoc, index: number): SfxDoc {
  const source = doc.effects[index]
  if (!source) return doc
  const copy: SfxEffect = {
    name: uniqueName(doc.effects, `${source.name}_copy`),
    frames: source.frames.map((frame) => ({ ...frame }))
  }
  const effects = [...doc.effects]
  effects.splice(index + 1, 0, copy)
  return withEffects(doc, effects)
}

/** Deleting the last effect is refused — an empty bank has nothing to export. */
export function deleteEffect(doc: SfxDoc, index: number): SfxDoc {
  if (doc.effects.length <= 1 || !doc.effects[index]) return doc
  return withEffects(
    doc,
    doc.effects.filter((_, i) => i !== index)
  )
}

/**
 * Moves an effect. **The bank index is the id `ayFX_PlayBank(id, …)` takes**, so
 * reordering renumbers sounds in already-written game code — the UI says so.
 */
export function moveEffect(doc: SfxDoc, from: number, to: number): SfxDoc {
  const target = Math.min(doc.effects.length - 1, Math.max(0, to))
  if (from === target || !doc.effects[from]) return doc
  const effects = [...doc.effects]
  const [moved] = effects.splice(from, 1)
  effects.splice(target, 0, moved)
  return withEffects(doc, effects)
}

export function updateEffect(doc: SfxDoc, index: number, fn: (effect: SfxEffect) => SfxEffect): SfxDoc {
  const source = doc.effects[index]
  if (!source) return doc
  const next = fn(source)
  if (next === source) return doc
  return withEffects(
    doc,
    doc.effects.map((effect, i) => (i === index ? next : effect))
  )
}

export function renameEffect(doc: SfxDoc, index: number, name: string): SfxDoc {
  const trimmed = name.trim()
  if (!trimmed) return doc
  return updateEffect(doc, index, (effect) => (effect.name === trimmed ? effect : { ...effect, name: trimmed }))
}
