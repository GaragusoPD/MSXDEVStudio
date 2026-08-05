import { describe, expect, it } from 'vitest'
import { isIgnoredName, resolveRelativePath } from './fs-safety'

describe('resolveRelativePath', () => {
  it('passes through a simple relative path', () => {
    expect(resolveRelativePath('a/b')).toBe('a/b')
  })

  it('collapses "." segments', () => {
    expect(resolveRelativePath('./a/./b')).toBe('a/b')
  })

  it('resolves an internal ".." that stays within the root', () => {
    expect(resolveRelativePath('a/../b')).toBe('b')
  })

  it('rejects a ".." that climbs above the root', () => {
    expect(resolveRelativePath('../x')).toBeNull()
  })

  it('rejects a ".." that climbs above the root after descending and returning', () => {
    expect(resolveRelativePath('a/../../b')).toBeNull()
  })

  it('treats a leading slash as relative, not OS-absolute', () => {
    expect(resolveRelativePath('/etc/passwd')).toBe('etc/passwd')
  })

  it('normalizes backslashes', () => {
    expect(resolveRelativePath('a\\b\\c')).toBe('a/b/c')
  })

  it('treats a drive-letter-looking path as a literal relative segment', () => {
    expect(resolveRelativePath('C:/Windows')).toBe('C:/Windows')
  })

  it('resolves the empty/root path to an empty string', () => {
    expect(resolveRelativePath('')).toBe('')
    expect(resolveRelativePath('.')).toBe('')
  })
})

describe('isIgnoredName', () => {
  it('flags known ignored directory names', () => {
    expect(isIgnoredName('node_modules')).toBe(true)
    expect(isIgnoredName('.git')).toBe(true)
  })

  it('does not flag ordinary names', () => {
    expect(isIgnoredName('src')).toBe(false)
  })

  it('rejects a path that is not a string, rather than throwing from inside split', () => {
    // These come over IPC; a renderer bug should read as a rejected path.
    expect(resolveRelativePath(undefined as unknown as string)).toBeNull()
    expect(resolveRelativePath(null as unknown as string)).toBeNull()
  })
})
