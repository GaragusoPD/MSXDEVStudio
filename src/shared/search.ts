import { IGNORED_DIR_NAMES } from './fs-safety'
import { splitGlobList } from './glob'

export interface SearchMatch {
  /** Project-root-relative, forward-slash path. */
  file: string
  /** 1-based line number. */
  line: number
  /** 1-based column of the first submatch on the line. */
  column: number
  /** The matched line's text, trimmed. */
  preview: string
}

export interface SearchableFile {
  /** Project-root-relative, forward-slash path. */
  path: string
  content: string
}

/**
 * The fallback (no-ripgrep) scanner: plain case-insensitive substring search
 * over already-collected file contents. `FsService` does the disk walk
 * (skipping ignored/binary/oversized files) and hands the result here so the
 * matching logic itself stays pure and unit-testable.
 */
export function scanForMatches(files: SearchableFile[], query: string): SearchMatch[] {
  if (!query) return []
  const needle = query.toLowerCase()
  const matches: SearchMatch[] = []
  for (const file of files) {
    const lines = file.content.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const haystack = lines[i].toLowerCase()
      let column = haystack.indexOf(needle)
      while (column !== -1) {
        matches.push({ file: file.path, line: i + 1, column: column + 1, preview: lines[i].trim() })
        column = haystack.indexOf(needle, column + needle.length)
      }
    }
  }
  return matches
}

/** Builds the `rg` argument list for a search rooted at cwd `.` (caller sets `cwd`). */
export function buildRgArgs(query: string, opts: { include?: string; exclude?: string } = {}): string[] {
  const args = ['--json', '-i', '-F', '--max-count', '200']
  for (const dir of IGNORED_DIR_NAMES) args.push('--glob', `!${dir}`)
  for (const pattern of splitGlobList(opts.include)) args.push('--glob', pattern)
  for (const pattern of splitGlobList(opts.exclude)) args.push('--glob', `!${pattern}`)
  args.push('--', query, '.')
  return args
}

interface RgMatchData {
  path: { text: string }
  lines: { text: string }
  line_number: number
  submatches?: { start: number }[]
}

/** Parses one line of `rg --json` output; returns `null` for non-match lines
 *  (begin/end/summary) or anything malformed. */
export function parseRgLine(line: string): SearchMatch | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as { type?: string; data?: RgMatchData }
  if (record.type !== 'match' || !record.data) return null
  const { path, lines, line_number: lineNumber, submatches } = record.data
  if (!path?.text || !lines?.text || typeof lineNumber !== 'number') return null
  return {
    file: path.text.replace(/\\/g, '/').replace(/^\.\//, ''),
    line: lineNumber,
    column: (submatches?.[0]?.start ?? 0) + 1,
    preview: lines.text.replace(/\r?\n$/, '')
  }
}
