import { describe, expect, it } from 'vitest'
import { presetEffect, type SfxFrame } from './msx/sfx'
import {
  applyAyfxFrame,
  AY_VOLUME,
  createPsgState,
  lfsrNext,
  LFSR_SEED,
  noiseBits,
  noiseFrequency,
  PSG_CLOCK,
  PSG_TICK_RATE,
  psgLevel,
  psgTick,
  renderSfx,
  samplesPerFrame,
  toneFrequency,
  type PsgVoice
} from './psg'

const frame = (over: Partial<SfxFrame> = {}): SfxFrame => ({
  toneOn: true,
  tone: 0,
  noiseOn: false,
  noise: 0,
  volume: 0,
  ...over
})

describe('noise LFSR', () => {
  it('is maximal length: 2^17 - 1 states before it repeats', () => {
    let rng = LFSR_SEED
    let steps = 0
    do {
      rng = lfsrNext(rng)
      steps++
    } while (rng !== LFSR_SEED)
    expect(steps).toBe(131071)
    expect(steps).toBe(2 ** 17 - 1)
  })

  it('matches the known seed-1 output: sixteen zeros while the feedback bit shifts down', () => {
    // Seed 1 has only bit 0 set, so the first feedback bit lands at bit 16 and
    // takes 16 shifts to reach the output.
    expect(noiseBits(32)).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0
    ])
  })

  it('never reaches the all-zero absorbing state and stays inside 17 bits', () => {
    let rng = LFSR_SEED
    let outOfRange = 0
    for (let i = 0; i < 200000; i++) {
      rng = lfsrNext(rng)
      if (rng === 0 || rng >= 2 ** 17) outOfRange++
    }
    expect(outOfRange).toBe(0)
  })

  it('produces a roughly balanced bit stream', () => {
    const bits = noiseBits(131071)
    const ones = bits.reduce((sum, bit) => sum + bit, 0)
    // A maximal-length LFSR emits exactly 2^16 ones per period.
    expect(ones).toBe(65536)
  })
})

describe('volume table', () => {
  it('has 16 non-linear steps from silence to full scale', () => {
    expect(AY_VOLUME).toHaveLength(16)
    expect(AY_VOLUME[0]).toBe(0)
    expect(AY_VOLUME[15]).toBe(1)
    for (let i = 1; i < 16; i++) expect(AY_VOLUME[i]).toBeGreaterThan(AY_VOLUME[i - 1])
    // Non-linear: the bottom half is far below a linear ramp would put it.
    expect(AY_VOLUME[8]).toBeLessThan(0.3)
  })
})

describe('tone and noise periods', () => {
  it('turns a period into the documented frequency', () => {
    expect(PSG_TICK_RATE).toBe(PSG_CLOCK / 8)
    // MSX A4: period 254 → ~440 Hz.
    expect(toneFrequency(254)).toBeCloseTo(440.4, 1)
    expect(toneFrequency(1)).toBeCloseTo(PSG_CLOCK / 16, 3)
    expect(toneFrequency(0)).toBe(toneFrequency(1))
    expect(noiseFrequency(16)).toBeCloseTo(PSG_CLOCK / 256, 3)
  })

  it('the tick engine actually oscillates at that frequency', () => {
    for (const period of [16, 254, 1000]) {
      const state = createPsgState()
      state.voice = { toneOn: true, tone: period, noiseOn: false, noise: 0, volume: 15 }
      let flips = 0
      let previous = state.toneLevel
      // One second of ticks.
      for (let i = 0; i < Math.round(PSG_TICK_RATE); i++) {
        psgTick(state)
        if (state.toneLevel !== previous) flips++
        previous = state.toneLevel
      }
      // Two flips per cycle.
      expect(flips / 2).toBeCloseTo(toneFrequency(period), -1)
    }
  })

  it('shifts the noise LFSR at half the tone rate, per the /2 prescaler', () => {
    const period = 4
    const ticks = 8000
    const state = createPsgState()
    state.voice = { toneOn: false, tone: 0, noiseOn: true, noise: period, volume: 15 }
    let shifts = 0
    let previous = state.rng
    for (let i = 0; i < ticks; i++) {
      psgTick(state)
      if (state.rng !== previous) shifts++
      previous = state.rng
    }
    // The counter reaches `period` every 4 ticks; only every second hit shifts.
    expect(shifts).toBe(ticks / (2 * period))
  })
})

describe('mixer', () => {
  const voice = (over: Partial<PsgVoice>): PsgVoice => ({
    toneOn: false,
    tone: 100,
    noiseOn: false,
    noise: 4,
    volume: 15,
    ...over
  })

  it('scales the output by the volume table', () => {
    const state = createPsgState()
    state.voice = voice({ toneOn: true, volume: 15 })
    state.toneLevel = 1
    expect(psgLevel(state)).toBe(1)
    state.voice = { ...state.voice, volume: 8 }
    expect(psgLevel(state)).toBe(AY_VOLUME[8])
    state.toneLevel = 0
    expect(psgLevel(state)).toBe(0)
  })

  it('treats a disabled generator as a constant 1, so both-off is DC', () => {
    const state = createPsgState()
    state.voice = voice({ toneOn: false, noiseOn: false, volume: 15 })
    state.toneLevel = 0
    state.noiseLevel = 0
    expect(psgLevel(state)).toBe(1)
  })

  it('ANDs tone and noise when both are enabled', () => {
    const state = createPsgState()
    state.voice = voice({ toneOn: true, noiseOn: true, volume: 15 })
    state.toneLevel = 1
    state.noiseLevel = 0
    expect(psgLevel(state)).toBe(0)
    state.noiseLevel = 1
    expect(psgLevel(state)).toBe(1)
  })
})

describe('applyAyfxFrame (the player\'s two early exits)', () => {
  const start: PsgVoice = { toneOn: true, tone: 300, noiseOn: false, noise: 7, volume: 9 }

  it('leaves the registers untouched on a volume-0 frame', () => {
    expect(applyAyfxFrame(start, frame({ tone: 111, volume: 0 }))).toBe(start)
  })

  it('leaves the registers untouched when the frame disables both tone and noise', () => {
    expect(applyAyfxFrame(start, frame({ toneOn: false, noiseOn: false, volume: 12 }))).toBe(start)
  })

  it('holds the tone period when the frame has tone off, and the noise period when noise is off', () => {
    const next = applyAyfxFrame(start, frame({ toneOn: false, tone: 999, noiseOn: true, noise: 3, volume: 5 }))
    expect(next).toEqual({ toneOn: false, tone: 300, noiseOn: true, noise: 3, volume: 5 })
    const back = applyAyfxFrame(next, frame({ toneOn: true, tone: 42, noiseOn: false, noise: 31, volume: 6 }))
    expect(back).toEqual({ toneOn: true, tone: 42, noiseOn: false, noise: 3, volume: 6 })
  })
})

describe('renderSfx', () => {
  const RATE_44K = 44100

  it('advances the frame sequencer at exactly 50 or 60 Hz', () => {
    expect(samplesPerFrame(RATE_44K, 50)).toBe(882)
    expect(samplesPerFrame(48000, 50)).toBe(960)
    expect(samplesPerFrame(48000, 60)).toBe(800)
    const frames = Array.from({ length: 10 }, () => frame({ tone: 254, volume: 15 }))
    expect(renderSfx(frames, { sampleRate: 48000, rate: 50 })).toHaveLength(10 * 960)
    expect(renderSfx(frames, { sampleRate: 48000, rate: 60 })).toHaveLength(10 * 800)
  })

  it('renders the authored pitch: measured zero crossings match toneFrequency', () => {
    for (const period of [100, 254, 600]) {
      const frames = Array.from({ length: 50 }, () => frame({ tone: period, volume: 15 }))
      const samples = renderSfx(frames, { sampleRate: 48000, rate: 50 })
      let crossings = 0
      for (let i = 1; i < samples.length; i++) if (samples[i - 1] < 0 !== samples[i] < 0) crossings++
      // 50 frames at 50 Hz = 1 second; two crossings per cycle.
      expect(crossings / 2).toBeCloseTo(toneFrequency(period), -1.4)
    }
  })

  it('is silent while volume stays 0', () => {
    const samples = renderSfx(Array.from({ length: 8 }, () => frame({ tone: 200, volume: 0 })), {
      sampleRate: RATE_44K,
      rate: 50
    })
    expect(Math.max(...samples.map(Math.abs))).toBe(0)
  })

  it('keeps output inside the gain and drifts no DC', () => {
    const samples = renderSfx(presetEffect('explosion').frames, { sampleRate: RATE_44K, rate: 50, gain: 0.6 })
    expect(samples.length).toBeGreaterThan(0)
    expect(Math.max(...samples.map(Math.abs))).toBeLessThanOrEqual(0.6 + 1e-6)
    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length
    expect(Math.abs(mean)).toBeLessThan(0.02)
  })

  it('makes every preset audible', () => {
    for (const name of ['laser', 'jump', 'explosion', 'pickup', 'hit']) {
      const samples = renderSfx(presetEffect(name).frames, { sampleRate: RATE_44K, rate: 50 })
      const rms = Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length)
      expect(rms).toBeGreaterThan(0.01)
    }
  })

  it('is deterministic', () => {
    const frames = presetEffect('hit').frames
    const options = { sampleRate: RATE_44K, rate: 50 }
    expect(renderSfx(frames, options)).toEqual(renderSfx(frames, options))
  })
})
