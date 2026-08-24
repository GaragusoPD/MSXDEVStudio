import { describe, expect, it } from 'vitest'
import { extensionFor, isBinaryExtension, languageFor } from './file-kind'

describe('extensionFor', () => {
  it('returns a simple extension', () => {
    expect(extensionFor('main.c')).toBe('c')
    expect(extensionFor('README.MD')).toBe('md')
  })

  it('returns "" for an extensionless file', () => {
    expect(extensionFor('Makefile')).toBe('')
  })

  it('recognizes compound resource extensions over the trailing .json', () => {
    expect(extensionFor('hero.tiles.json')).toBe('tiles.json')
    expect(extensionFor('level1.map.json')).toBe('map.json')
  })

  it('falls back to plain json for a non-resource .json file', () => {
    expect(extensionFor('msxproj.json')).toBe('json')
  })
})

describe('languageFor', () => {
  it('maps c/h to the c language', () => {
    expect(languageFor('c')).toBe('c')
    expect(languageFor('h')).toBe('c')
  })

  it('maps json and markdown', () => {
    expect(languageFor('json')).toBe('json')
    expect(languageFor('md')).toBe('markdown')
  })

  it('falls back to plaintext for assembly and unknown extensions', () => {
    expect(languageFor('s')).toBe('plaintext')
    expect(languageFor('asm')).toBe('plaintext')
    expect(languageFor('tiles.json')).toBe('plaintext')
  })
})

describe('what can be opened as text', () => {
  it('knows the binary kinds a project actually holds', () => {
    for (const extension of ['rom', 'png', 'wav', 'zip', 'exe', 'ttf']) {
      expect(isBinaryExtension(extension), extension).toBe(true)
    }
  })

  it('treats everything else as text, whether or not it has a language', () => {
    // The bug this replaced: an allowlist meant each of these was a bug report.
    for (const extension of ['sh', 'bat', 'txt', 'md', 'yml', 'ini', 'gitignore', 'cfg', '']) {
      expect(isBinaryExtension(extension), extension).toBe(false)
    }
  })

  it('is case-insensitive, because Windows writes .ROM', () => {
    expect(isBinaryExtension('ROM')).toBe(true)
    expect(isBinaryExtension('PNG')).toBe(true)
  })

  it('highlights the shells and configs, and leaves the rest plain', () => {
    expect(languageFor('sh')).toBe('shell')
    expect(languageFor('bat')).toBe('bat')
    expect(languageFor('yml')).toBe('yaml')
    expect(languageFor('txt')).toBe('plaintext')
    // Unknown is not an error — it is plaintext, and still opens.
    expect(languageFor('xyz')).toBe('plaintext')
  })

  it('gives Z80 assembly plaintext rather than a C-like highlighter that gets it wrong', () => {
    expect(languageFor('s')).toBe('plaintext')
    expect(languageFor('asm')).toBe('plaintext')
  })
})
