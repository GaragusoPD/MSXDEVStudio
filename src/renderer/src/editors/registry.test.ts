/**
 * The lookup that decides what opens a file.
 *
 * Worth its own test because the rule inverted: it used to be an allowlist of
 * blessed extensions, so every shell script, batch file and README landed on
 * "no editor registered". Text is the default now, and only the known-binary
 * kinds get nothing.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { getEditorFor, registerEditor, registerFallbackEditor } from './registry'

const Text = { name: 'Text' }
const Tiles = { name: 'Tiles' }

beforeEach(() => {
  registerFallbackEditor({ extensions: [], component: Text })
  registerEditor({ extensions: ['tiles.json'], component: Tiles })
})

describe('getEditorFor', () => {
  it('gives a specific editor the file it claimed', () => {
    expect(getEditorFor('tiles.json')?.component).toBe(Tiles)
  })

  it('gives everything else the text editor', () => {
    for (const extension of ['sh', 'bat', 'txt', 'md', 'yml', 'gitignore', 'makefile', 'xyz']) {
      expect(getEditorFor(extension)?.component, extension).toBe(Text)
    }
  })

  it('gives a file with no extension the text editor — LICENSE, Makefile', () => {
    expect(getEditorFor('')?.component).toBe(Text)
  })

  it('gives binary kinds nothing, so they are not opened as mojibake', () => {
    for (const extension of ['rom', 'png', 'wav', 'exe']) {
      expect(getEditorFor(extension), extension).toBeUndefined()
    }
  })

  it('matches extensions case-insensitively', () => {
    expect(getEditorFor('TILES.JSON')?.component).toBe(Tiles)
    expect(getEditorFor('ROM')).toBeUndefined()
    expect(getEditorFor('SH')?.component).toBe(Text)
  })
})
