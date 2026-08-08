import { describe, expect, it } from 'vitest'
import { nextZoomLevel, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP, zoomActionFor, type ZoomKeyInput } from './zoom'

const key = (over: Partial<ZoomKeyInput>): ZoomKeyInput => ({
  type: 'keyDown',
  key: '=',
  control: true,
  meta: false,
  alt: false,
  ...over
})

describe('zoomActionFor', () => {
  it.each([
    ['Ctrl+= — what "Ctrl plus" actually produces unshifted', { key: '=' }, 'in'],
    ['Ctrl++ — the same key with Shift down', { key: '+' }, 'in'],
    ['Ctrl+-', { key: '-' }, 'out'],
    ['Ctrl+_ — shifted minus', { key: '_' }, 'out'],
    ['Ctrl+0', { key: '0' }, 'reset']
  ])('reads %s', (_label, over, expected) => {
    expect(zoomActionFor(key(over))).toBe(expected)
  })

  it.each([
    ['NumpadAdd', 'in'],
    ['NumpadSubtract', 'out'],
    ['Numpad0', 'reset']
  ])('reads the keypad: %s', (code, expected) => {
    // The keypad reports a layout-dependent `key`; `code` is what identifies it.
    expect(zoomActionFor(key({ code, key: 'Unidentified' }))).toBe(expected)
  })

  it('accepts Command as well as Control', () => {
    expect(zoomActionFor(key({ control: false, meta: true }))).toBe('in')
  })

  it.each([
    ['no modifier — plain typing must not zoom', { control: false }],
    ['Ctrl+Alt+= — a different gesture', { alt: true }],
    ['keyUp', { type: 'keyUp' }],
    ['an unrelated key', { key: 'a' }],
    ['Ctrl+S', { key: 's' }]
  ])('ignores %s', (_label, over) => {
    expect(zoomActionFor(key(over))).toBeNull()
  })
})

describe('nextZoomLevel', () => {
  it('steps in and out', () => {
    expect(nextZoomLevel(0, 'in')).toBe(ZOOM_STEP)
    expect(nextZoomLevel(0, 'out')).toBe(-ZOOM_STEP)
  })

  it('returns to 100% on reset, from either direction', () => {
    expect(nextZoomLevel(3, 'reset')).toBe(0)
    expect(nextZoomLevel(-2.5, 'reset')).toBe(0)
  })

  it('clamps rather than running away', () => {
    expect(nextZoomLevel(ZOOM_MAX, 'in')).toBe(ZOOM_MAX)
    expect(nextZoomLevel(ZOOM_MIN, 'out')).toBe(ZOOM_MIN)
  })

  it('round-trips: stepping out then in returns to where it started', () => {
    expect(nextZoomLevel(nextZoomLevel(1, 'out'), 'in')).toBe(1)
  })
})
