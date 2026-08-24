import { describe, expect, it } from 'vitest'
import { listSystemFonts, normalizeFamilies } from './fonts'

describe('normalizeFamilies', () => {
  it('deduplicates, trims, and sorts case-insensitively', () => {
    expect(normalizeFamilies([' Fira Code ', 'Menlo', 'Fira Code', 'arial'])).toEqual([
      'arial',
      'Fira Code',
      'Menlo'
    ])
  })

  it('orders the same whatever the machine locale, by tie-breaking on the raw name', () => {
    expect(normalizeFamilies(['Arial', 'arial'])).toEqual(['Arial', 'arial'])
  })

  it('drops blanks and the dot-prefixed system faces macOS reports', () => {
    expect(normalizeFamilies(['', '  ', '.SF NS Mono', 'Menlo'])).toEqual(['Menlo'])
  })

  it('keeps names with spaces and punctuation intact', () => {
    expect(normalizeFamilies(['JetBrains Mono NL', 'M+ 1m'])).toEqual(['JetBrains Mono NL', 'M+ 1m'])
  })
})

describe('listSystemFonts', () => {
  it('answers empty on a platform it has no query for, rather than throwing', async () => {
    await expect(listSystemFonts('aix')).resolves.toEqual([])
  })

  it('answers a list or an empty list on this machine — never rejects', async () => {
    // Deliberately not asserting on the contents: a CI box may have no fonts
    // and no `fc-list`, and "gives up quietly" is the actual contract.
    await expect(listSystemFonts()).resolves.toBeInstanceOf(Array)
  })
})
