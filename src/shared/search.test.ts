import { describe, expect, it } from 'vitest'
import { buildRgArgs, parseRgLine, scanForMatches, type SearchableFile } from './search'

describe('scanForMatches (fallback scanner)', () => {
  const files: SearchableFile[] = [
    { path: 'src/main.c', content: 'int main() {\n  printf("hello");\n  return 0;\n}\n' },
    { path: 'src/util.c', content: 'void HELLO_world() {}\n' },
    { path: 'README.md', content: 'nothing to see here\n' }
  ]

  it('returns nothing for an empty query', () => {
    expect(scanForMatches(files, '')).toEqual([])
  })

  it('finds a single match with correct 1-based line/column', () => {
    const matches = scanForMatches(files, 'printf')
    expect(matches).toEqual([{ file: 'src/main.c', line: 2, column: 3, preview: 'printf("hello");' }])
  })

  it('is case-insensitive', () => {
    const matches = scanForMatches(files, 'hello')
    expect(matches.map((m) => m.file)).toEqual(['src/main.c', 'src/util.c'])
  })

  it('finds multiple matches on the same line', () => {
    const matches = scanForMatches([{ path: 'a.c', content: 'ab ab ab\n' }], 'ab')
    expect(matches).toHaveLength(3)
    expect(matches.map((m) => m.column)).toEqual([1, 4, 7])
  })

  it('finds matches across multiple files', () => {
    const matches = scanForMatches(files, 'main')
    expect(matches.map((m) => m.file)).toEqual(['src/main.c'])
  })
})

describe('buildRgArgs', () => {
  it('always excludes the ignored directory names', () => {
    const args = buildRgArgs('needle')
    expect(args).toEqual(
      expect.arrayContaining(['--glob', '!node_modules', '--glob', '!out', '--glob', '!emul', '--glob', '!.git'])
    )
  })

  it('appends include globs as-is and exclude globs negated', () => {
    const args = buildRgArgs('needle', { include: '*.c, *.h', exclude: '*.min.js' })
    expect(args).toEqual(expect.arrayContaining(['--glob', '*.c', '--glob', '*.h', '--glob', '!*.min.js']))
  })

  it('terminates the flag list with -- query .', () => {
    const args = buildRgArgs('needle')
    expect(args.slice(-3)).toEqual(['--', 'needle', '.'])
  })
})

describe('parseRgLine', () => {
  it('parses a real rg --json match line', () => {
    const line =
      '{"type":"match","data":{"path":{"text":"./src/main.c"},"lines":{"text":"  printf(\\"hi\\");\\n"},"line_number":2,"absolute_offset":13,"submatches":[{"match":{"text":"printf"},"start":2,"end":8}]}}'
    expect(parseRgLine(line)).toEqual({ file: 'src/main.c', line: 2, column: 3, preview: '  printf("hi");' })
  })

  it('ignores begin/end/summary lines', () => {
    expect(parseRgLine('{"type":"begin","data":{"path":{"text":"./a.c"}}}')).toBeNull()
    expect(parseRgLine('{"type":"summary","data":{}}')).toBeNull()
  })

  it('returns null for blank or malformed input', () => {
    expect(parseRgLine('')).toBeNull()
    expect(parseRgLine('not json')).toBeNull()
  })

  it('normalizes backslashes and strips a leading ./ (Windows rg output)', () => {
    const line =
      '{"type":"match","data":{"path":{"text":".\\\\src\\\\main.c"},"lines":{"text":"x\\n"},"line_number":1,"submatches":[]}}'
    expect(parseRgLine(line)?.file).toBe('src/main.c')
  })
})
