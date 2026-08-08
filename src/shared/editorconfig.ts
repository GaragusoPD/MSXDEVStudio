import { matchesGlob } from './glob'

export interface EditorConfigRule {
  indentStyle?: 'tab' | 'space'
  indentSize?: number
  trimTrailingWhitespace?: boolean
  insertFinalNewline?: boolean
}

interface EditorConfigSection {
  pattern: string
  rule: EditorConfigRule
}

/**
 * Parses a minimal, project-root-only subset of `.editorconfig`: `[glob]`
 * section headers and the four keys MSXDEVStudio's editor cares about. No
 * `root = true` handling and no directory cascading — good enough for a
 * single-folder MSXgl project; extend if per-subfolder configs matter later.
 */
export function parseEditorConfig(content: string): EditorConfigSection[] {
  const sections: EditorConfigSection[] = []
  let current: EditorConfigSection | null = null

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.split(/[;#]/)[0].trim()
    if (!line) continue

    const header = /^\[(.+)]$/.exec(line)
    if (header) {
      current = { pattern: header[1], rule: {} }
      sections.push(current)
      continue
    }
    if (!current) continue // keys before any [section] (e.g. root=true) aren't rule keys

    const [rawKey, rawValue] = line.split('=').map((s) => s.trim())
    const key = rawKey?.toLowerCase()
    const value = rawValue?.toLowerCase()
    if (!key || !value) continue

    if (key === 'indent_style' && (value === 'tab' || value === 'space')) current.rule.indentStyle = value
    else if (key === 'indent_size' && /^\d+$/.test(value)) current.rule.indentSize = Number(value)
    else if (key === 'trim_trailing_whitespace') current.rule.trimTrailingWhitespace = value === 'true'
    else if (key === 'insert_final_newline') current.rule.insertFinalNewline = value === 'true'
  }
  return sections
}

/** Resolves the effective rule for `filename`: later matching sections
 *  override earlier ones key-by-key (matches real .editorconfig semantics). */
export function resolveEditorConfig(sections: EditorConfigSection[], filename: string): EditorConfigRule {
  let rule: EditorConfigRule = {}
  for (const section of sections) {
    if (matchesGlob(filename, section.pattern)) rule = { ...rule, ...section.rule }
  }
  return rule
}
