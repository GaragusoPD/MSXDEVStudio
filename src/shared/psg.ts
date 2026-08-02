/**
 * A one-channel AY-3-8910 model, just enough to audition ayFX effects (Spec 11).
 *
 * ponytail: **no hardware envelope generator, one channel, no stereo.** ayFX
 * streams never touch registers 11–13, and effects are mono, so the envelope
 * generator and channels A/B would be dead code. Add them the day an effect
 * format needs them.
 *
 * ponytail: the tone/noise generators are box-averaged over the AY ticks that
 * fall inside each output sample rather than band-limited (no PolyBLEP). It's a
 * few lines instead of a few hundred and the aliasing is inaudible on 20 ms
 * effect frames; swap in BLEP if the audition ever needs to be reference-grade.
 *
 * Everything here is pure and DOM-free so Vitest can drive it in Node — the
 * renderer's audio glue only turns the returned Float32Array into sound.
 */

import type { SfxFrame } from './msx/sfx'

/** MSX PSG input clock: 3.579545 MHz crystal, divided by two. */
export const PSG_CLOCK = 3579545 / 2

/**
 * The counters are clocked at the input clock divided by **8**, and each one
 * flips its output every `period` ticks — two flips per cycle, which is where
 * the familiar `clock / (16 * period)` comes from (1789772.5 / (16·254) ≈ 440 Hz).
 */
export const PSG_TICK_RATE = PSG_CLOCK / 8

/**
 * The AY-3-8910's 16-step *non-linear* DAC, normalized to 0…1 — roughly 3 dB
 * (≈×1.41 in amplitude) per step at the top, compressing towards silence.
 */
export const AY_VOLUME: readonly number[] = [
  0.0, 0.0137, 0.0205, 0.0291, 0.0423, 0.0618, 0.0847, 0.1369, 0.1691, 0.2647, 0.3527, 0.4499, 0.5704, 0.6873, 0.8482,
  1.0
]

/**
 * The 17-bit noise LFSR, taps at bits 0 and 3 (a maximal-length polynomial, so
 * it cycles through all 2¹⁷−1 non-zero states before repeating).
 */
export function lfsrNext(rng: number): number {
  const feedback = (rng ^ (rng >> 3)) & 1
  return (rng >>> 1) | (feedback << 16)
}

/** The seed the chip powers up with; zero would be an absorbing state. */
export const LFSR_SEED = 1

/** `count` successive noise output bits — the pure sequence, for tests and for the tick loop. */
export function noiseBits(count: number, seed = LFSR_SEED): number[] {
  const out: number[] = []
  let rng = seed
  for (let i = 0; i < count; i++) {
    rng = lfsrNext(rng)
    out.push(rng & 1)
  }
  return out
}

/** Hz for a 12-bit tone period. Period 0 is treated as 1, as the chip does. */
export function toneFrequency(period: number, clock = PSG_CLOCK): number {
  return clock / (16 * Math.max(1, period))
}

/** Hz for a 5-bit noise period — the LFSR's shift rate, not a pitch. */
export function noiseFrequency(period: number, clock = PSG_CLOCK): number {
  return clock / (16 * Math.max(1, period))
}

/** The subset of PSG registers an ayFX frame can touch. */
export interface PsgVoice {
  toneOn: boolean
  tone: number
  noiseOn: boolean
  noise: number
  volume: number
}

export interface PsgState {
  voice: PsgVoice
  toneCounter: number
  toneLevel: number
  noiseCounter: number
  /** The noise generator runs at half the tone generator's rate. */
  noisePrescale: number
  noiseLevel: number
  rng: number
}

export function createPsgState(): PsgState {
  return {
    voice: { toneOn: false, tone: 0, noiseOn: false, noise: 0, volume: 0 },
    toneCounter: 0,
    toneLevel: 1,
    noiseCounter: 0,
    noisePrescale: 0,
    noiseLevel: 1,
    rng: LFSR_SEED
  }
}

/** Advances both generators by one AY tick (clock/8). */
export function psgTick(state: PsgState): void {
  if (++state.toneCounter >= Math.max(1, state.voice.tone)) {
    state.toneCounter = 0
    state.toneLevel ^= 1
  }
  if (++state.noiseCounter >= Math.max(1, state.voice.noise)) {
    state.noiseCounter = 0
    state.noisePrescale ^= 1
    if (state.noisePrescale) {
      state.rng = lfsrNext(state.rng)
      state.noiseLevel = state.rng & 1
    }
  }
}

/**
 * The channel's current output, 0…1. The mixer ORs each generator with its
 * *disable* bit, then ANDs the two — so a disabled generator contributes a
 * constant 1 and a channel with both disabled sits at a DC level (which is why
 * `renderSfx` DC-blocks the result).
 */
export function psgLevel(state: PsgState): number {
  const tone = state.voice.toneOn ? state.toneLevel : 1
  const noise = state.voice.noiseOn ? state.noiseLevel : 1
  return (tone & noise) * AY_VOLUME[Math.min(15, Math.max(0, state.voice.volume))]
}

/**
 * One ayFX frame's effect on the registers, faithful to `ayFX_Update`'s two
 * early exits — **both of which leave the previous frame still sounding**:
 *
 *  - volume 0 → `ld (_ayFX_Volume),a / ret z`: nothing is written at all.
 *  - tone *and* noise off → `and #0x90 / cp #0x90 / ret z`: same.
 *
 * That surprises people (a "silent" frame isn't silent), so the audition
 * reproduces it rather than doing the intuitive thing — `validateSfx` is where
 * the warning lives.
 */
export function applyAyfxFrame(voice: PsgVoice, frame: SfxFrame): PsgVoice {
  if (frame.volume === 0) return voice
  if (!frame.toneOn && !frame.noiseOn) return voice
  return {
    toneOn: frame.toneOn,
    // The tone registers are only rewritten when this frame's mixer enables tone.
    tone: frame.toneOn ? frame.tone : voice.tone,
    noiseOn: frame.noiseOn,
    // Likewise register 6 — `bit 7,c` skips it when noise is off.
    noise: frame.noiseOn ? frame.noise : voice.noise,
    volume: frame.volume
  }
}

export interface RenderOptions {
  sampleRate: number
  /** Replay rate, 50 or 60 Hz. */
  rate: number
  clock?: number
  /** Peak amplitude of the returned samples. */
  gain?: number
}

export function samplesPerFrame(sampleRate: number, rate: number): number {
  return Math.round(sampleRate / rate)
}

/**
 * Renders a whole effect offline, one `samplesPerFrame` block per ayFX frame.
 * Because the frame boundaries are computed in samples, the 50 Hz sequencer is
 * exact by construction — there is no scheduler to drift.
 */
export function renderSfx(frames: readonly SfxFrame[], options: RenderOptions): Float32Array {
  const { sampleRate, rate, clock = PSG_CLOCK, gain = 0.6 } = options
  const block = samplesPerFrame(sampleRate, rate)
  const out = new Float32Array(frames.length * block)
  const state = createPsgState()
  const ticksPerSample = clock / 8 / sampleRate
  let pending = 0
  let index = 0
  // One-pole DC blocker: volume steps and disabled-mixer frames are pure DC otherwise.
  let lastIn = 0
  let lastOut = 0
  for (const frame of frames) {
    state.voice = applyAyfxFrame(state.voice, frame)
    for (let i = 0; i < block; i++) {
      pending += ticksPerSample
      let sum = 0
      let ticks = 0
      while (pending >= 1) {
        pending -= 1
        psgTick(state)
        sum += psgLevel(state)
        ticks++
      }
      const raw = ticks ? sum / ticks : psgLevel(state)
      lastOut = raw - lastIn + 0.999 * lastOut
      lastIn = raw
      out[index++] = lastOut * gain
    }
  }
  return out
}
