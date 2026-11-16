/**
 * The one playback clock every animation preview runs on (sprite frames, pose
 * animations, bitmap meta-tile frames): the same stepping the generated
 * `_Animate()` does, so a preview tells the truth about timing, ping-pong and
 * play-once. Dependency-free; the editors keep only their own wiring.
 */
import type { AnimLoop } from './msx/tile'

export type PlaybackLoop = AnimLoop

/** How the preview paints behind a frame. Lives here so sessions can name it without importing a component. */
export type AnimationBackground = 'checkered' | 'solid'

/**
 * One VBlank on a European MSX — the clock a game steps its animation on, and
 * the one every editor previews on, so a duration plays the same length in all.
 */
export const VBLANK_MS = 20

/** What a duration is held for: at least one VBlank, so a bad value never spins. */
const held = (duration: number): number => (Number.isFinite(duration) && duration >= 1 ? duration : 1)

/** The frame shown `ticks` VBlanks after the start. Ping-pong runs 0..n-1, n-2..1; `once` holds the last frame. */
export function frameAtTick(durations: readonly number[], loop: PlaybackLoop, ticks: number): number {
  const count = durations.length
  if (count <= 1) return 0
  const order: number[] = []
  for (let f = 0; f < count; f++) order.push(f)
  if (loop === 'pingpong') for (let f = count - 2; f > 0; f--) order.push(f)
  const total = order.reduce((sum, f) => sum + held(durations[f]), 0)
  if (loop === 'once' && ticks >= total - held(durations[count - 1])) return count - 1
  let t = ticks % total
  for (const f of order) {
    if (t < held(durations[f])) return f
    t -= held(durations[f])
  }
  return order[order.length - 1]
}

/** The tick Play starts from: `loop` begins at the selected frame, `pingpong` and `once` at the first. */
export function startTick(durations: readonly number[], loop: PlaybackLoop, selected: number): number {
  if (loop !== 'loop' || durations.length === 0) return 0
  const last = Math.min(Math.max(Math.trunc(selected) || 0, 0), durations.length - 1)
  let ticks = 0
  for (let f = 0; f < last; f++) ticks += held(durations[f])
  return ticks
}

/** The frame to show `elapsedMs` after Play began at tick `start`; always a real frame, even if the frames shrank meanwhile. */
export function previewFrame(durations: readonly number[], loop: PlaybackLoop, start: number, elapsedMs: number): number {
  return frameAtTick(durations, loop, start + Math.floor(elapsedMs / VBLANK_MS))
}

/** A typed duration: `null` when it isn't a number, otherwise whole VBlanks within 1..255. */
export function parseDuration(raw: number): number | null {
  if (!Number.isFinite(raw)) return null
  return Math.min(255, Math.max(1, Math.round(raw)))
}

/** The largest scale (fractional below 1) at which `frame` fits `box`; 0 for an empty frame. */
export function fitScale(frame: { width: number; height: number }, box: { width: number; height: number }): number {
  if (frame.width <= 0 || frame.height <= 0) return 0
  return Math.min(box.width / frame.width, box.height / frame.height)
}
