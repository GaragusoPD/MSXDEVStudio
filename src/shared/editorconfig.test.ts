import { describe, expect, it } from 'vitest'
import { parseEditorConfig, resolveEditorConfig } from './editorconfig'

const SAMPLE = `
root = true

[*]
indent_style = space
indent_size = 4
trim_trailing_whitespace = true
insert_final_newline = true

[*.md]
trim_trailing_whitespace = false

[*.{c,h}]
indent_size = 2
`

describe('parseEditorConfig', () => {
  it('parses sections and their keys', () => {
    const sections = parseEditorConfig(SAMPLE)
    expect(sections).toEqual([
      { pattern: '*', rule: { indentStyle: 'space', indentSize: 4, trimTrailingWhitespace: true, insertFinalNewline: true } },
      { pattern: '*.md', rule: { trimTrailingWhitespace: false } },
      { pattern: '*.{c,h}', rule: { indentSize: 2 } }
    ])
  })

  it('ignores comments and blank lines', () => {
    expect(parseEditorConfig('# just a comment\n\n; another one\n')).toEqual([])
  })

  it('returns an empty list for content with no sections', () => {
    expect(parseEditorConfig('root = true')).toEqual([])
  })
})

describe('resolveEditorConfig', () => {
  const sections = parseEditorConfig(SAMPLE)

  it('applies the [*] defaults to any file', () => {
    expect(resolveEditorConfig(sections, 'README.txt')).toEqual({
      indentStyle: 'space',
      indentSize: 4,
      trimTrailingWhitespace: true,
      insertFinalNewline: true
    })
  })

  it('lets a later, more specific section override one key', () => {
    expect(resolveEditorConfig(sections, 'notes.md')).toEqual({
      indentStyle: 'space',
      indentSize: 4,
      trimTrailingWhitespace: false,
      insertFinalNewline: true
    })
  })

  it('applies a brace-alternation section', () => {
    expect(resolveEditorConfig(sections, 'src/main.c').indentSize).toBe(2)
    expect(resolveEditorConfig(sections, 'src/main.h').indentSize).toBe(2)
  })

  it('returns an empty rule when nothing matches', () => {
    expect(resolveEditorConfig([], 'main.c')).toEqual({})
  })
})
