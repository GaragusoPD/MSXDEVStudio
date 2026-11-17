import { describe, expect, it } from 'vitest'
import { anchoredScroll, NOTCH_PIXELS, stepZoom, wheelNotch, type WheelState } from './wheel-zoom'

describe('wheelNotch', () => {
  it('makes one notch of each mouse click, whatever size the platform reports', () => {
    for (const delta of [53, 100, 120, 480]) {
      const state: WheelState = { pending: 0 }
      expect(wheelNotch(state, -delta, 0)).toBe(1)
      expect(wheelNotch(state, delta, 0)).toBe(-1)
    }
    expect(wheelNotch({ pending: 0 }, -3, 1)).toBe(1) // three lines
    expect(wheelNotch({ pending: 0 }, 1, 2)).toBe(-1) // a page
  })

  it('adds a trackpad’s small deltas up to one notch', () => {
    const state: WheelState = { pending: 0 }
    const steps: number[] = []
    for (let i = 0; i < 10; i++) steps.push(wheelNotch(state, -10, 0))
    expect(steps.filter((step) => step === 1)).toHaveLength(Math.floor(100 / NOTCH_PIXELS))
    expect(steps.every((step) => step >= 0)).toBe(true)
  })

  it('drops the backlog when the direction changes', () => {
    const state: WheelState = { pending: 0 }
    wheelNotch(state, -40, 0)
    expect(wheelNotch(state, 20, 0)).toBe(0)
    expect(state.pending).toBe(20)
  })
})

describe('stepZoom', () => {
  const range = { min: 8, max: 64, quantum: 4 }

  it('zooms by about a quarter, on the slider’s step', () => {
    expect(stepZoom(32, 1, range)).toBe(40)
    expect(stepZoom(32, -1, range)).toBe(24)
  })

  it('always moves at least one step, even where a quarter rounds to nothing', () => {
    expect(stepZoom(2, 1, { min: 1, max: 8, quantum: 1 })).toBe(3)
    expect(stepZoom(2, -1, { min: 1, max: 8, quantum: 1 })).toBe(1)
  })

  it('stops at the ends of the range', () => {
    expect(stepZoom(64, 1, range)).toBe(64)
    expect(stepZoom(8, -1, range)).toBe(8)
    expect(stepZoom(60, 1, range)).toBe(64)
  })

  it('comes back where it started after a notch in and a notch out', () => {
    expect(stepZoom(stepZoom(16, 1, { min: 4, max: 256, quantum: 2 }), -1, { min: 4, max: 256, quantum: 2 })).toBe(16)
  })
})

describe('anchoredScroll', () => {
  it('keeps the dot under the pointer under it', () => {
    // Pointer 100 px into the pane, scrolled 300: content offset 400 at zoom 8.
    // At zoom 16 that dot is at 800, so the pane scrolls to 700.
    expect(anchoredScroll(300, 100, 8, 16)).toBe(700)
    expect(anchoredScroll(700, 100, 16, 8)).toBe(300)
  })

  it('never scrolls before the start', () => {
    expect(anchoredScroll(0, 50, 16, 8)).toBe(0)
  })
})
