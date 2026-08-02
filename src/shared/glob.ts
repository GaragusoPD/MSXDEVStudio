/**
 * A deliberately small glob matcher — supports `*`, `**`, `?`, and `{a,b}`
 * alternation. Covers what the search panel's include/exclude fields and
 * `.editorconfig` section headers need; not a full minimatch replacement.
 *
 * ponytail: no `[abc]` character classes, no negated groups — extend here if
 * a real project's .editorconfig or search box ever needs them.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*'
        i++
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') {
      out += '[^/]'
    } else if (c === '{') {
      const end = pattern.indexOf('}', i)
      if (end === -1) {
        out += '\\{'
      } else {
        out += `(?:${pattern
          .slice(i + 1, end)
          .split(',')
          .map((option) => escapeRegExpLiteral(option))
          .join('|')})`
        i = end
      }
    } else {
      out += escapeRegExpLiteral(c)
    }
  }
  return new RegExp(`^${out}$`, 'i')
}

function escapeRegExpLiteral(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}

/**
 * Matches `relPath` (forward-slash, project-root-relative) against `pattern`.
 * A pattern with no `/` matches against the basename only (so `*.c` matches
 * `src/main.c`); a pattern containing `/` matches the full relative path.
 */
export function matchesGlob(relPath: string, pattern: string): boolean {
  const target = pattern.includes('/') ? relPath : (relPath.split('/').pop() ?? relPath)
  return globToRegExp(pattern).test(target)
}

/** True if `relPath` matches any pattern in `patterns`. Empty list matches nothing. */
export function matchesAnyGlob(relPath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesGlob(relPath, pattern))
}

/** Splits a comma-separated glob list from a UI text field into trimmed, non-empty patterns. */
export function splitGlobList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}
