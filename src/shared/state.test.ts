import { describe, expect, it } from 'vitest'
import { pushRecentProject } from './state'

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
})
