import { describe, expect, it } from 'vitest'
import { matchesAnyGlob, matchesGlob, splitGlobList } from './glob'

describe('matchesGlob', () => {
  it('matches a basename-only pattern against the basename anywhere in the tree', () => {
    expect(matchesGlob('src/main.c', '*.c')).toBe(true)
    expect(matchesGlob('main.c', '*.c')).toBe(true)
    expect(matchesGlob('src/main.h', '*.c')).toBe(false)
  })

  it('matches a path-shaped pattern against the full relative path', () => {
    expect(matchesGlob('src/main.c', 'src/*.c')).toBe(true)
    expect(matchesGlob('lib/main.c', 'src/*.c')).toBe(false)
  })

  it('supports ** across directory separators', () => {
    expect(matchesGlob('a/b/c/main.c', '**/main.c')).toBe(true)
  })

  it('supports {a,b} alternation', () => {
    expect(matchesGlob('main.c', '*.{c,h}')).toBe(true)
    expect(matchesGlob('main.h', '*.{c,h}')).toBe(true)
    expect(matchesGlob('main.s', '*.{c,h}')).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(matchesGlob('MAIN.C', '*.c')).toBe(true)
  })
})

describe('matchesAnyGlob', () => {
  it('matches if any pattern matches', () => {
    expect(matchesAnyGlob('main.c', ['*.h', '*.c'])).toBe(true)
  })

  it('matches nothing against an empty pattern list', () => {
    expect(matchesAnyGlob('main.c', [])).toBe(false)
  })
})

describe('splitGlobList', () => {
  it('splits and trims a comma-separated list', () => {
    expect(splitGlobList('*.c, *.h ,, *.s')).toEqual(['*.c', '*.h', '*.s'])
  })

  it('returns an empty array for undefined/empty input', () => {
    expect(splitGlobList(undefined)).toEqual([])
    expect(splitGlobList('')).toEqual([])
  })
})
