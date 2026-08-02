import { describe, expect, it } from 'vitest'
import { extensionFor, languageFor } from './file-kind'

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
