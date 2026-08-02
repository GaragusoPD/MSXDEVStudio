/**
 * Audition glue (Spec 11): turns the pure PSG core in `shared/psg.ts` into
 * sound. All the DSP is over there and unit-tested; this file only owns the
 * `AudioContext`, which is why it has no tests of its own.
 *
 * ponytail: the effect is **rendered offline into an AudioBuffer** and handed
 * to the audio thread in one piece, rather than streamed from an AudioWorklet
 * as Spec 11 sketches. Effects are short and fully known up front, so there is
 * nothing to stream — and this makes the 50 Hz frame sequencer sample-exact
 * (frame boundaries are integer sample offsets, computed once) instead of
 * depending on a worklet's 128-sample render quantum lining up with 20 ms.
 * Looping and the playhead come free from `AudioBufferSourceNode`. Revisit if
 * the editor ever needs to change an effect *while* it sounds.
 */

import type { SfxFrame } from '../../../../shared/msx/sfx'
import { renderSfx, samplesPerFrame } from '../../../../shared/psg'

let context: AudioContext | null = null
let playing: AudioBufferSourceNode | null = null
let ticker = 0

function audio(): AudioContext {
  context ??= new AudioContext()
  // Browsers start the context suspended until a user gesture; every call here is one.
  if (context.state === 'suspended') void context.resume()
  return context
}

export function stopSfx(): void {
  if (ticker) cancelAnimationFrame(ticker)
  ticker = 0
  if (playing) {
    playing.onended = null
    try {
      playing.stop()
    } catch {
      // Already finished — nothing to stop.
    }
    playing = null
  }
}

export interface PlayOptions {
  /** Replay rate in Hz, 50 or 60. */
  rate: number
  loop?: boolean
  /** Called with the frame index under the playhead, then -1 when playback ends. */
  onFrame?: (frame: number) => void
}

/** Plays `frames` from the beginning. Any effect already sounding is cut off. */
export function playSfx(frames: readonly SfxFrame[], options: PlayOptions): void {
  stopSfx()
  if (!frames.length) return
  const ctx = audio()
  const samples = renderSfx(frames, { sampleRate: ctx.sampleRate, rate: options.rate })
  const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate)
  buffer.getChannelData(0).set(samples)

  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.loop = options.loop === true
  source.connect(ctx.destination)
  playing = source

  const startedAt = ctx.currentTime
  const perFrame = samplesPerFrame(ctx.sampleRate, options.rate) / ctx.sampleRate
  source.onended = (): void => {
    if (playing === source) stopSfx()
    options.onFrame?.(-1)
  }
  source.start()

  if (options.onFrame) {
    const follow = (): void => {
      if (playing !== source) return
      const elapsed = ctx.currentTime - startedAt
      const index = Math.floor(elapsed / perFrame)
      options.onFrame?.(source.loop ? index % frames.length : Math.min(index, frames.length - 1))
      ticker = requestAnimationFrame(follow)
    }
    ticker = requestAnimationFrame(follow)
  }
}

/** One frame, for scrubbing: the same DSP, just a one-frame effect. */
export function scrubFrame(frame: SfxFrame, rate: number): void {
  playSfx([frame, frame], { rate })
}
