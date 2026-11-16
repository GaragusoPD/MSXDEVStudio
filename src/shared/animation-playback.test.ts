import { describe, expect, it } from 'vitest'
import { fitScale, frameAtTick, parseDuration, previewFrame, startTick, VBLANK_MS, type PlaybackLoop } from './animation-playback'

describe('frameAtTick keeps the generated C’s time', () => {
  const run = (loop: PlaybackLoop, durations: number[], ticks: number): number[] =>
    Array.from({ length: ticks }, (_, t) => frameAtTick(durations, loop, t))

  it('holds each frame for its duration and loops', () => {
    expect(run('loop', [2, 1, 3], 8)).toEqual([0, 0, 1, 2, 2, 2, 0, 0])
  })

  it('ping-pong turns at both ends without repeating them', () => {
    expect(run('pingpong', [1, 1, 1], 8)).toEqual([0, 1, 2, 1, 0, 1, 2, 1])
  })

  it('once holds the last frame', () => {
    expect(run('once', [1, 2, 1], 7)).toEqual([0, 1, 1, 2, 2, 2, 2])
  })

  it('counts a bad duration as one VBlank', () => {
    expect(run('loop', [0, Number.NaN, 2], 5)).toEqual([0, 1, 2, 2, 0])
  })

  it('shows frame 0 for none or one frame', () => {
    expect(frameAtTick([], 'loop', 50)).toBe(0)
    expect(frameAtTick([], 'once', 50)).toBe(0)
    expect(frameAtTick([4], 'pingpong', 50)).toBe(0)
    expect(frameAtTick([4], 'once', 50)).toBe(0)
  })
})

describe('startTick', () => {
  it('loop starts at the selected frame, the others at the first', () => {
    expect(startTick([3, 6, 9], 'loop', 2)).toBe(9)
    expect(startTick([3, 6, 9], 'loop', 0)).toBe(0)
    expect(startTick([3, 6, 9], 'pingpong', 2)).toBe(0)
    expect(startTick([3, 6, 9], 'once', 2)).toBe(0)
  })

  it('clamps a selection outside the frames', () => {
    expect(startTick([3, 6, 9], 'loop', 7)).toBe(9)
    expect(startTick([3, 6, 9], 'loop', -1)).toBe(0)
    expect(startTick([], 'loop', 2)).toBe(0)
  })
})

describe('previewFrame', () => {
  it('advances a frame per its duration at one VBlank per 20 ms', () => {
    expect(VBLANK_MS).toBe(20)
    expect(previewFrame([5, 5, 5], 'loop', 0, 99)).toBe(0)
    expect(previewFrame([5, 5, 5], 'loop', 0, 100)).toBe(1)
    expect(previewFrame([5, 5, 5], 'loop', 0, 300)).toBe(0)
  })

  it('starts from the tick it was given', () => {
    expect(previewFrame([2, 2, 2], 'loop', startTick([2, 2, 2], 'loop', 2), 0)).toBe(2)
  })

  it('stays in range when the frames shrank since the start was taken', () => {
    expect([0, 1]).toContain(previewFrame([4, 4], 'loop', 999, 0))
    expect(previewFrame([], 'loop', 0, 500)).toBe(0)
    expect(previewFrame([4], 'once', 999, 5000)).toBe(0)
  })
})

describe('parseDuration', () => {
  it('rejects what is not a number, rounds and clamps the rest to 1..255', () => {
    expect(parseDuration(Number.NaN)).toBeNull()
    expect(parseDuration(Infinity)).toBeNull()
    expect(parseDuration(-Infinity)).toBeNull()
    expect(parseDuration(0)).toBe(1)
    expect(parseDuration(-4)).toBe(1)
    expect(parseDuration(999)).toBe(255)
    expect(parseDuration(1e3)).toBe(255)
    expect(parseDuration(7.6)).toBe(8)
  })
})

describe('fitScale', () => {
  const box = { width: 64, height: 64 }
  it('is the largest scale that fits, fractional below one', () => {
    expect(fitScale({ width: 128, height: 128 }, box)).toBe(0.5)
    expect(fitScale({ width: 128, height: 8 }, box)).toBe(0.5)
    expect(fitScale({ width: 8, height: 8 }, box)).toBe(8)
  })

  it('is 0 for an empty frame', () => {
    expect(fitScale({ width: 0, height: 8 }, box)).toBe(0)
    expect(fitScale({ width: 8, height: 0 }, box)).toBe(0)
  })
})
