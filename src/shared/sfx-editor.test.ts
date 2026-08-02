import { describe, expect, it } from 'vitest'
import { createSfxDoc, MAX_NOISE, MAX_TONE, normalizeSfx, presetEffect, type SfxFrame } from './msx/sfx'
import {
  addEffect,
  createHistory,
  deleteEffect,
  duplicateEffect,
  heightFromValue,
  laneActive,
  laneValue,
  LANE_MAX,
  moveEffect,
  paintLane,
  pushHistory,
  redo,
  renameEffect,
  setFrameCount,
  undo,
  uniqueName,
  updateEffect,
  valueFromHeight,
  type SfxLane
} from './sfx-editor'

const frame = (over: Partial<SfxFrame> = {}): SfxFrame => ({
  toneOn: true,
  tone: 0,
  noiseOn: false,
  noise: 0,
  volume: 0,
  ...over
})

const blank = (n: number): SfxFrame[] => Array.from({ length: n }, () => frame())

describe('lane geometry', () => {
  it('inverts periods so dragging up raises pitch, and leaves volume upright', () => {
    expect(valueFromHeight('tone', 0)).toBe(MAX_TONE)
    // The tone lane is logarithmic and bottoms out at period 1 — period 0 means 1 to the chip anyway.
    expect(valueFromHeight('tone', 1)).toBe(1)
    expect(valueFromHeight('noise', 0)).toBe(MAX_NOISE)
    expect(valueFromHeight('noise', 1)).toBe(0)
    expect(valueFromHeight('volume', 0)).toBe(0)
    expect(valueFromHeight('volume', 1)).toBe(15)
  })

  it('clamps out-of-lane drags instead of producing invalid values', () => {
    expect(valueFromHeight('volume', 3)).toBe(15)
    expect(valueFromHeight('volume', -2)).toBe(0)
    expect(valueFromHeight('tone', -2)).toBe(MAX_TONE)
    expect(valueFromHeight('tone', 9)).toBe(1)
  })

  it('spreads the pitch lane logarithmically, so real effects use most of it', () => {
    // Linear would put all three of these in the top 9% of the lane; these are the
    // median / p90 / max tone periods in MSXgl's own ayFX sample bank.
    expect(heightFromValue('tone', 107)).toBeCloseTo(0.438, 2)
    expect(heightFromValue('tone', 360)).toBeCloseTo(0.292, 2)
    expect(heightFromValue('tone', 2409)).toBeCloseTo(0.064, 2)
    // Equal screen distance = equal pitch interval: an octave is a constant step.
    const octave = heightFromValue('tone', 100) - heightFromValue('tone', 200)
    expect(heightFromValue('tone', 200) - heightFromValue('tone', 400)).toBeCloseTo(octave, 6)
  })

  it('round-trips value ↔ height across every lane, exhaustively', () => {
    for (const lane of ['tone', 'noise', 'volume'] as SfxLane[]) {
      // Tone period 0 is not on the lane (it is period 1 to the hardware).
      const first = lane === 'tone' ? 1 : 0
      for (let value = first; value <= LANE_MAX[lane]; value++) {
        expect(valueFromHeight(lane, heightFromValue(lane, value))).toBe(value)
      }
    }
  })

  it('reads and reports each lane off the frame', () => {
    const f = frame({ tone: 300, noiseOn: true, noise: 7, volume: 9 })
    expect(laneValue(f, 'tone')).toBe(300)
    expect(laneValue(f, 'noise')).toBe(7)
    expect(laneValue(f, 'volume')).toBe(9)
    expect([laneActive(f, 'tone'), laneActive(f, 'noise'), laneActive(f, 'volume')]).toEqual([true, true, true])
    const off = frame({ toneOn: false, volume: 0 })
    expect([laneActive(off, 'tone'), laneActive(off, 'noise'), laneActive(off, 'volume')]).toEqual([false, false, false])
  })
})

describe('paintLane', () => {
  it('paints a single frame when the drag has not moved', () => {
    const painted = paintLane(blank(4), 'volume', { index: 2, value: 12 }, { index: 2, value: 12 })
    expect(painted.map((f) => f.volume)).toEqual([0, 0, 12, 0])
  })

  it('interpolates across a swept span so a fast drag leaves no gaps', () => {
    const painted = paintLane(blank(5), 'volume', { index: 0, value: 0 }, { index: 4, value: 12 })
    expect(painted.map((f) => f.volume)).toEqual([0, 3, 6, 9, 12])
  })

  it('interpolates the same way when the drag runs right to left', () => {
    const painted = paintLane(blank(5), 'volume', { index: 4, value: 12 }, { index: 0, value: 0 })
    expect(painted.map((f) => f.volume)).toEqual([0, 3, 6, 9, 12])
  })

  it('switches the generator on where it paints', () => {
    const frames = [frame({ toneOn: false }), frame({ toneOn: false })]
    const painted = paintLane(frames, 'tone', { index: 0, value: 400 }, { index: 1, value: 400 })
    expect(painted.every((f) => f.toneOn && f.tone === 400)).toBe(true)
    const noise = paintLane(frames, 'noise', { index: 0, value: 9 }, { index: 1, value: 9 })
    expect(noise.every((f) => f.noiseOn && f.noise === 9)).toBe(true)
  })

  it('erases by turning the generator off, keeping the period for a later re-enable', () => {
    const frames = [frame({ tone: 500, noiseOn: true, noise: 8, volume: 10 })]
    expect(paintLane(frames, 'tone', { index: 0, value: 0 }, { index: 0, value: 0 }, true)[0]).toEqual({
      ...frames[0],
      toneOn: false
    })
    expect(paintLane(frames, 'noise', { index: 0, value: 0 }, { index: 0, value: 0 }, true)[0].noiseOn).toBe(false)
    expect(paintLane(frames, 'volume', { index: 0, value: 0 }, { index: 0, value: 0 }, true)[0].volume).toBe(0)
  })

  it('ignores indices outside the effect and clamps values into the lane', () => {
    const frames = blank(3)
    expect(paintLane(frames, 'volume', { index: -5, value: 5 }, { index: 99, value: 5 }).map((f) => f.volume)).toEqual([5, 5, 5])
    expect(paintLane(frames, 'tone', { index: 0, value: 99999 }, { index: 0, value: 99999 })[0].tone).toBe(MAX_TONE)
  })

  it('returns the same array when the stroke changed nothing, so undo skips it', () => {
    const frames = [frame({ volume: 7 })]
    expect(paintLane(frames, 'volume', { index: 0, value: 7 }, { index: 0, value: 7 })).toBe(frames)
  })
})

describe('setFrameCount', () => {
  it('grows with blank frames and truncates from the end', () => {
    const frames = [frame({ volume: 1 }), frame({ volume: 2 })]
    expect(setFrameCount(frames, 4)).toHaveLength(4)
    expect(setFrameCount(frames, 4)[3]).toEqual(frame())
    expect(setFrameCount(frames, 1).map((f) => f.volume)).toEqual([1])
    expect(setFrameCount(frames, 2)).toBe(frames)
  })

  it('never leaves an effect with zero frames', () => {
    expect(setFrameCount(blank(3), 0)).toHaveLength(1)
    expect(setFrameCount(blank(3), -9)).toHaveLength(1)
    expect(setFrameCount(blank(3), 99999)).toHaveLength(255)
  })
})

describe('effect list', () => {
  const bank = () => normalizeSfx({ effects: [{ name: 'a', frames: [frame({ volume: 1 })] }, { name: 'b', frames: [frame({ volume: 2 })] }] })

  it('adds with a de-duplicated name', () => {
    const doc = addEffect(addEffect(bank(), presetEffect('laser')), presetEffect('laser'))
    expect(doc.effects.map((e) => e.name)).toEqual(['a', 'b', 'laser', 'laser2'])
    expect(uniqueName(doc.effects, 'a')).toBe('a2')
  })

  it('duplicates in place with a deep copy', () => {
    const doc = duplicateEffect(bank(), 0)
    expect(doc.effects.map((e) => e.name)).toEqual(['a', 'a_copy', 'b'])
    doc.effects[1].frames[0].volume = 15
    expect(doc.effects[0].frames[0].volume).toBe(1)
  })

  it('deletes, but never the last effect', () => {
    const doc = deleteEffect(bank(), 0)
    expect(doc.effects.map((e) => e.name)).toEqual(['b'])
    expect(deleteEffect(doc, 0)).toBe(doc)
    expect(deleteEffect(bank(), 7)).toEqual(bank())
  })

  it('reorders, clamping the destination', () => {
    expect(moveEffect(bank(), 0, 1).effects.map((e) => e.name)).toEqual(['b', 'a'])
    expect(moveEffect(bank(), 1, 99).effects.map((e) => e.name)).toEqual(['a', 'b'])
    expect(moveEffect(bank(), 0, 0)).toEqual(bank())
  })

  it('renames, ignoring blank names', () => {
    expect(renameEffect(bank(), 0, '  boom  ').effects[0].name).toBe('boom')
    expect(renameEffect(bank(), 0, '   ')).toEqual(bank())
  })

  it('updates one effect and leaves the rest untouched by reference', () => {
    const doc = bank()
    const next = updateEffect(doc, 1, (effect) => ({ ...effect, frames: setFrameCount(effect.frames, 5) }))
    expect(next.effects[1].frames).toHaveLength(5)
    expect(next.effects[0]).toBe(doc.effects[0])
    expect(updateEffect(doc, 1, (effect) => effect)).toBe(doc)
  })
})

describe('history', () => {
  it('records, undoes and redoes, and no-ops on an unchanged document', () => {
    const first = createSfxDoc()
    let history = createHistory(first)
    expect(pushHistory(history, first)).toBe(history)

    const second = renameEffect(first, 0, 'zap')
    history = pushHistory(history, second)
    expect(history.present).toBe(second)
    history = undo(history)
    expect(history.present).toBe(first)
    history = redo(history)
    expect(history.present).toBe(second)
  })

  it('bottoms out instead of throwing', () => {
    const history = createHistory(createSfxDoc())
    expect(undo(history)).toBe(history)
    expect(redo(history)).toBe(history)
  })

  it('drops a redo branch once a new edit lands', () => {
    const doc = createSfxDoc()
    let history = pushHistory(createHistory(doc), renameEffect(doc, 0, 'one'))
    history = undo(history)
    history = pushHistory(history, renameEffect(doc, 0, 'two'))
    expect(history.future).toEqual([])
    expect(history.present.effects[0].name).toBe('two')
  })
})
