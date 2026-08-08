import { describe, expect, it } from 'vitest'
import { MAX_RECENT_PROJECTS, pushRecentProject } from './state'

describe('pushRecentProject', () => {
  it('adds a new path to the front', () => {
    expect(pushRecentProject(['a', 'b'], 'c')).toEqual(['c', 'a', 'b'])
  })

  it('de-dupes an existing path by moving it to the front', () => {
    expect(pushRecentProject(['a', 'b'], 'b')).toEqual(['b', 'a'])
  })

  it('caps the list at max entries, keeping the newest first', () => {
    const recent = Array.from({ length: 10 }, (_, i) => `p${i}`)
    const result = pushRecentProject(recent, 'new', 10)
    expect(result).toHaveLength(10)
    expect(result[0]).toBe('new')
    expect(result).not.toContain('p9')
  })

  it('defaults to six, dropping the least recently opened', () => {
    const recent = Array.from({ length: MAX_RECENT_PROJECTS }, (_, i) => `p${i}`)
    const result = pushRecentProject(recent, 'new')

    expect(MAX_RECENT_PROJECTS).toBe(6)
    expect(result).toHaveLength(6)
    expect(result[0]).toBe('new')
    // p5 was the oldest of the six; it is the one that falls off.
    expect(result).not.toContain('p5')
    expect(result).toContain('p4')
  })

  it('re-opening an existing entry reorders rather than evicting', () => {
    const recent = Array.from({ length: MAX_RECENT_PROJECTS }, (_, i) => `p${i}`)
    const result = pushRecentProject(recent, 'p5')

    expect(result).toHaveLength(6)
    expect(result[0]).toBe('p5')
    expect(new Set(result)).toEqual(new Set(recent))
  })
})
