/**
 * Builds a code-completion index from the MSXgl headers.
 *
 * MSXgl documents its own API in NaturalDocs-style comment blocks
 * (`// Function:` / `// Parameters:`), so parsing those gets real signatures,
 * descriptions and per-parameter docs without running a C frontend. That
 * matters here: clangd has no Z80 target and does not know SDCC's dialect
 * (`__sfr`, `__at`, `__naked`), so it reports false errors on this code.
 *
 * Electron-free on purpose (same split as `toolchain.ts` / `build.ts`) so the
 * parsing is directly unit-testable; `main/index.ts` owns the IPC and cache.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { MsxglSymbol } from '../../shared/ipc'

// ── one header ──────────────────────────────────────────────────────────────

/** `// Function: VDP_SetPalette` opens a documented block. */
const FUNCTION_TAG = /^\s*\/\/\s*Function:\s*(\w+)/
/** `// Parameters:` switches the block from description to parameter list. */
const PARAMS_TAG = /^\s*\/\/\s*Parameters:/
/** A parameter line: `//   pal - Address of the palette in RAM`. */
const PARAM_LINE = /^\s*\/\/\s{2,}(\w+)\s*-\s*(.+)$/
/** Any comment line, with its text. */
const COMMENT_LINE = /^\s*\/\/\s?(.*)$/
/** The `[MSX2/2+/TR]` compatibility tag MSXgl puts at the end of a description. */
const MACHINE_TAG = /\[(MSX[^\]]*)\]/
/**
 * A declaration that exists only as a comment, used for the macro-generated
 * VDP command family: `// inline void VDP_CommandHMMM(u16 sx, …); // desc`.
 */
const COMMENTED_DECL = /^\s*\/\/\s*(?:inline\s+)?[A-Za-z_][\w]*\s*\**\s+(\w+)\s*\(([^)]*)\)\s*;\s*(?:\/\/\s*(.*))?$/
/** `#define NAME value // comment`, function-like when the name is followed by `(`. */
const DEFINE_LINE = /^\s*#define\s+(\w+)(\([^)]*\))?[ \t]+(.*)$/
const ENUM_OPEN = /^\s*enum\s+\w*\s*$|^\s*enum\s+\w*\s*\{/
/**
 * An enum member, matched against the line with its trailing comment already
 * removed. The initialiser is `.*` rather than a comma-free run because
 * MSXgl's values are often macro calls: `KEY_ESC = MAKE_KEY(7, 2),`.
 */
const ENUM_MEMBER = /^\s*([A-Za-z_]\w*)\s*(?:=.*?)?,?\s*$/
/** SDCC calling-convention and register attributes, noise in a signature. */
const ATTRIBUTES = /\s*__[A-Z][A-Z0-9_]*(\([^)]*\))?/g

/** Include guards and private helpers, never worth completing. */
function isNoise(name: string): boolean {
  return name.startsWith('_') || /_H$/.test(name) || name.length < 3
}

function cleanSignature(text: string): string {
  const cut = text.split('{')[0].split(';')[0]
  return cut.replace(ATTRIBUTES, '').replace(/\s+/g, ' ').trim()
}

/**
 * Every symbol a single header contributes. `file` is stored on each symbol so
 * the completion popup can say where it came from.
 */
export function parseHeaderSymbols(text: string, file: string): MsxglSymbol[] {
  const out: MsxglSymbol[] = []
  // MSXgl's headers are CRLF; a stray \r defeats every `$`-anchored rule below.
  const lines = text.split(/\r?\n/)
  let enumDepth = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Track enum bodies so their members can be picked up as constants.
    if (enumDepth === 0 && ENUM_OPEN.test(line)) {
      enumDepth = line.includes('{') ? 1 : 0
      if (enumDepth === 0) {
        // `enum NAME` on its own line; the brace is on the next one.
        if (lines[i + 1]?.trim().startsWith('{')) {
          enumDepth = 1
          i++
        }
      }
      continue
    }
    if (enumDepth > 0) {
      if (line.includes('}')) {
        enumDepth = 0
        continue
      }
      if (line.trim().startsWith('//') || line.trim().startsWith('#')) continue
      const mark = line.indexOf('//')
      const member = ENUM_MEMBER.exec(mark === -1 ? line : line.slice(0, mark))
      if (member && !isNoise(member[1])) {
        const comment = mark === -1 ? undefined : line.slice(mark + 2).trim()
        out.push({ name: member[1], kind: 'constant', detail: comment || undefined, file })
      }
      continue
    }

    const documented = FUNCTION_TAG.exec(line)
    if (documented) {
      out.push(readDocumentedFunction(lines, i, documented[1], file))
      continue
    }

    const commented = COMMENTED_DECL.exec(line)
    if (commented && !isNoise(commented[1])) {
      out.push({
        name: commented[1],
        kind: 'function',
        signature: cleanSignature(line.replace(/^\s*\/\/\s*/, '')),
        detail: commented[3]?.trim(),
        file
      })
      continue
    }

    const define = DEFINE_LINE.exec(line)
    if (define && !isNoise(define[1])) {
      const [, name, args, rest] = define
      const comment = rest.split('//')[1]?.trim()
      out.push({
        name,
        kind: args ? 'function' : 'constant',
        signature: args ? `${name}${args}` : undefined,
        detail: comment,
        file
      })
    }
  }

  return out
}

/**
 * Reads one `// Function:` block: the description lines, the `Parameters:`
 * list, and the declaration that follows it. The declaration is found by
 * looking for the name we already know rather than by parsing C, which keeps
 * this robust against SDCC attributes and `#if` guards in between.
 */
function readDocumentedFunction(
  lines: readonly string[],
  start: number,
  name: string,
  file: string
): MsxglSymbol {
  const description: string[] = []
  const params: string[] = []
  let inParams = false
  let cursor = start + 1

  for (; cursor < lines.length; cursor++) {
    const line = lines[cursor]
    if (!COMMENT_LINE.test(line)) break
    if (PARAMS_TAG.test(line)) {
      inParams = true
      continue
    }
    if (inParams) {
      const param = PARAM_LINE.exec(line)
      // Continuation lines of a parameter description are appended to it.
      if (param) params.push(`${param[1]} - ${param[2].trim()}`)
      else if (params.length) {
        const extra = COMMENT_LINE.exec(line)?.[1]?.trim()
        if (extra) params[params.length - 1] += ` ${extra}`
      }
      continue
    }
    const body = COMMENT_LINE.exec(line)?.[1]?.trim()
    if (body) description.push(body)
  }

  // The declaration is the next few non-comment, non-preprocessor lines.
  let signature: string | undefined
  for (let look = cursor; look < Math.min(cursor + 6, lines.length); look++) {
    const candidate = lines[look]
    if (!candidate.trim() || candidate.trim().startsWith('#')) continue
    if (!candidate.includes(name)) break
    let text = candidate
    // Accumulate a signature split across lines.
    for (let more = look + 1; !/[;{]/.test(text) && more < Math.min(look + 4, lines.length); more++) {
      text += ` ${lines[more]}`
    }
    signature = cleanSignature(text)
    break
  }

  const joined = description.join(' ')
  return {
    name,
    kind: 'function',
    signature,
    detail: joined || undefined,
    params: params.length ? params : undefined,
    machines: MACHINE_TAG.exec(joined)?.[1],
    file
  }
}

// ── the whole checkout ──────────────────────────────────────────────────────

function collectHeaders(dir: string, out: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry)
    let isDir: boolean
    try {
      isDir = statSync(path).isDirectory()
    } catch {
      continue
    }
    if (isDir) collectHeaders(path, out)
    else if (entry.endsWith('.h')) out.push(path)
  }
}

/**
 * Indexes `<msxgl>/engine/src`. Duplicate names keep whichever entry carries
 * the most documentation, so a `// Function:` block always beats a bare
 * `#define` alias of the same name.
 */
export function indexMsxglSymbols(msxglRoot: string): MsxglSymbol[] {
  const root = join(msxglRoot, 'engine', 'src')
  const headers: string[] = []
  collectHeaders(root, headers)

  const best = new Map<string, MsxglSymbol>()
  for (const header of headers) {
    let text: string
    try {
      text = readFileSync(header, 'utf-8')
    } catch {
      continue
    }
    const file = relative(msxglRoot, header).split(sep).join('/')
    for (const symbol of parseHeaderSymbols(text, file)) {
      const existing = best.get(symbol.name)
      if (!existing || score(symbol) > score(existing)) best.set(symbol.name, symbol)
    }
  }
  return [...best.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** How useful an entry is in the popup, used to break duplicate-name ties. */
function score(symbol: MsxglSymbol): number {
  return (symbol.signature ? 2 : 0) + (symbol.detail ? 1 : 0) + (symbol.params ? 2 : 0)
}
