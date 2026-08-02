import { describe, expect, it } from 'vitest'
import { nextMru, removeMru, touchMru } from './tabs'

describe('touchMru', () => {
  it('moves an existing id to the front', () => {
    expect(touchMru(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b'])
  })

  it('adds a new id to the front', () => {
    expect(touchMru(['a', 'b'], 'z')).toEqual(['z', 'a', 'b'])
  })
})

describe('removeMru', () => {
  it('removes the id and keeps order', () => {
    expect(removeMru(['a', 'b', 'c'], 'b')).toEqual(['a', 'c'])
  })

  it('is a no-op for an id not present', () => {
    expect(removeMru(['a', 'b'], 'z')).toEqual(['a', 'b'])
  })
})

describe('nextMru', () => {
  it('returns the most-recently-used tab that is not current', () => {
    expect(nextMru(['a', 'b', 'c'], 'a')).toBe('b')
  })

  it('toggles back to front when current is not the front (already switched once)', () => {
    expect(nextMru(['a', 'b', 'c'], 'b')).toBe('a')
  })

  it('returns current when it is the only entry', () => {
    expect(nextMru(['a'], 'a')).toBe('a')
  })

  it('returns the front entry when current is undefined', () => {
    expect(nextMru(['a', 'b'], undefined)).toBe('a')
  })
})
