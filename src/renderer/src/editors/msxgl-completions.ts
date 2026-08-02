/**
 * Code completion for the MSXgl API, in C files.
 *
 * The symbols come from the main process, which parses MSXgl's own header doc
 * comments (`main/services/msxgl-symbols.ts`). This is deliberately not a
 * language server: clangd has no Z80 target and rejects SDCC's dialect, and
 * MSXgl's headers already carry signatures and per-parameter documentation.
 *
 * Monaco's own word-based suggestions still cover identifiers from the file
 * being edited, so between the two you get the library API plus your own code.
 */

import * as monaco from './monaco-full'
// The generated shim re-exports values only; these two are top-level types,
// and a type-only import is erased at build so it pulls in nothing extra.
import type { IDisposable, IRange } from 'monaco-editor'
import type { MsxglSymbol } from '../../../shared/ipc'

let registered: IDisposable | null = null
let loading: Promise<MsxglSymbol[]> | null = null
let stale = false

/** Markdown shown in the details pane beside the suggestion list. */
function documentation(symbol: MsxglSymbol): string {
  const parts: string[] = []
  if (symbol.detail) parts.push(symbol.detail)
  if (symbol.machines) parts.push(`**Machines:** ${symbol.machines}`)
  if (symbol.params?.length) {
    parts.push(['**Parameters**', '', ...symbol.params.map((p) => `- \`${p}\``)].join('\n'))
  }
  parts.push(`_${symbol.file}_`)
  return parts.join('\n\n')
}

/**
 * Functions insert a call with the cursor between the parentheses; ones known
 * to take no arguments skip straight past them. Constants insert as-is.
 */
function insertion(symbol: MsxglSymbol): { text: string; snippet: boolean } {
  if (symbol.kind !== 'function') return { text: symbol.name, snippet: false }
  const noArgs = symbol.signature ? /\(\s*\)\s*$/.test(symbol.signature) : false
  return noArgs ? { text: `${symbol.name}()`, snippet: false } : { text: `${symbol.name}($0)`, snippet: true }
}

/** Everything about a suggestion except where it will be inserted. */
type PreparedItem = Omit<monaco.languages.CompletionItem, 'range'>

let prepared: PreparedItem[] = []
const byName = new Map<string, MsxglSymbol>()

/**
 * Builds the suggestion list once per index. Documentation is deliberately
 * left off here and filled in by `resolveCompletionItem` for the highlighted
 * entry only, so opening the popup does not render markdown for 5,000 symbols.
 */
function prepare(symbols: readonly MsxglSymbol[]): void {
  byName.clear()
  prepared = symbols.map((symbol) => {
    byName.set(symbol.name, symbol)
    const { text, snippet } = insertion(symbol)
    return {
      label: symbol.name,
      kind:
        symbol.kind === 'function'
          ? monaco.languages.CompletionItemKind.Function
          : monaco.languages.CompletionItemKind.Constant,
      // The signature is the most useful thing to show inline next to the name.
      detail: symbol.signature ?? symbol.detail,
      insertText: text,
      insertTextRules: snippet
        ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
        : undefined
    }
  })
}

/**
 * Registers the provider once. Safe to call repeatedly; later calls are no-ops
 * so hot reload does not stack duplicate providers.
 */
export function registerMsxglCompletions(): void {
  if (registered) return

  registered = monaco.languages.registerCompletionItemProvider('c', {
    async provideCompletionItems(model, position) {
      const symbols = await load()
      if (!symbols.length) return { suggestions: [] }
      if (prepared.length !== symbols.length) prepare(symbols)

      const word = model.getWordUntilPosition(position)
      const range: IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn
      }
      // The list is complete, so Monaco filters it on later keystrokes itself
      // instead of calling back into here.
      return { suggestions: prepared.map((item) => ({ ...item, range })) }
    },

    resolveCompletionItem(item) {
      const symbol = byName.get(String(item.label))
      if (!symbol) return item
      return { ...item, documentation: { value: documentation(symbol), isTrusted: false } }
    }
  })
}

/** Fetches the index once; a failure is cached as empty rather than retried per keystroke. */
function load(): Promise<MsxglSymbol[]> {
  if (!loading) {
    const force = stale
    stale = false
    loading = window.api.invoke('toolchain:msxglSymbols', { force }).catch(() => [] as MsxglSymbol[])
  }
  return loading
}

/**
 * Called when the toolchain changes so the next completion re-fetches. `stale`
 * makes that re-fetch bypass the main process's cache too, which matters when
 * MSXgl was updated in place and the path alone did not change.
 */
export function invalidateMsxglCompletions(): void {
  loading = null
  stale = true
  prepared = []
  byName.clear()
}
