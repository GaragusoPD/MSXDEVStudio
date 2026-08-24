import * as monaco from './monaco-full'
import { type EditorConfigRule, parseEditorConfig, resolveEditorConfig } from '../../../shared/editorconfig'
import { languageFor } from '../../../shared/file-kind'
import { type EditorTab, useTabsStore } from '../stores/tabsStore'
import { watchExternalEdits } from './external-changes'

const models = new Map<string, monaco.editor.ITextModel>()
const savedVersionIds = new Map<string, number>()
const modelRules = new Map<string, EditorConfigRule>()
const viewStates = new Map<string, monaco.editor.ICodeEditorViewState>()

let editorConfigRoot: string | null = null
/** The *promise*, not the result: tabs restored together all call in before the first read resolves. */
let editorConfigSections: Promise<ReturnType<typeof parseEditorConfig>> | null = null

async function loadEditorConfig(): Promise<ReturnType<typeof parseEditorConfig>> {
  try {
    // ponytail: stat first — .editorconfig is optional, and a rejected `fs:read` logs an error in main.
    const exists = await window.api.invoke('fs:stat', { path: '.editorconfig' })
    return parseEditorConfig(exists ? await window.api.invoke('fs:read', { path: '.editorconfig' }) : '')
  } catch {
    return []
  }
}

/** Loads and caches `.editorconfig` from the current project root; re-reads only when the root changes. */
async function getEditorConfigRule(filePath: string): Promise<EditorConfigRule> {
  const root = useTabsStore().projectRoot
  if (root !== editorConfigRoot) {
    editorConfigRoot = root
    editorConfigSections = root ? loadEditorConfig() : null
  }
  return resolveEditorConfig((await editorConfigSections) ?? [], filePath)
}

/** Trims trailing whitespace and (if requested) ensures a final newline, per the effective editorconfig rule. */
export function formatForSave(content: string, rule: EditorConfigRule): string {
  let lines = content.split('\n')
  if (rule.trimTrailingWhitespace !== false) lines = lines.map((line) => line.replace(/[ \t]+$/, ''))
  let out = lines.join('\n')
  if (rule.insertFinalNewline && out.length > 0 && !out.endsWith('\n')) out += '\n'
  return out
}

async function createModel(tab: EditorTab): Promise<monaco.editor.ITextModel> {
  const filePath = tab.filePath as string
  const [content, rule] = await Promise.all([
    window.api.invoke('fs:read', { path: filePath }),
    getEditorConfigRule(filePath)
  ])
  const model = monaco.editor.createModel(content, languageFor(tab.extension ?? ''))
  model.updateOptions({ tabSize: rule.indentSize ?? 4, insertSpaces: rule.indentStyle !== 'tab' })
  modelRules.set(tab.id, rule)
  savedVersionIds.set(tab.id, model.getAlternativeVersionId())
  model.onDidChangeContent(() => {
    const dirty = model.getAlternativeVersionId() !== savedVersionIds.get(tab.id)
    useTabsStore().setDirty(tab.id, dirty)
  })
  models.set(tab.id, model)
  watchers.set(
    tab.id,
    watchExternalEdits(tab.id, filePath, ({ text }) => adoptExternalText(tab.id, model, text))
  )
  return model
}

/**
 * Takes an out-of-band edit into an open buffer.
 *
 * Returns false when it declined — the buffer has unsaved edits and the file
 * has moved on, so the two have genuinely diverged and only the user can say
 * which wins. Clobbering here would silently destroy work.
 */
function adoptExternalText(tabId: string, model: monaco.editor.ITextModel, text: string): boolean {
  // Our own save comes back through the watcher; identical text means it was
  // us. Setting it anyway would push an undo step for a no-op edit.
  if (model.getValue() === text) return true
  const tab = useTabsStore().tabs.find((entry) => entry.id === tabId)
  if (tab?.dirty) {
    useTabsStore().setDiverged(tabId, true)
    return false
  }

  // `pushEditOperations` rather than `setValue`: it keeps the undo stack, the
  // cursor and the folding state, so a file rewritten under you does not also
  // scroll to the top and forget where you were.
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null)
  // Re-baselined, not dirtied: the buffer now matches the file exactly.
  savedVersionIds.set(tabId, model.getAlternativeVersionId())
  useTabsStore().setDirty(tabId, false)
  useTabsStore().setDiverged(tabId, false)
  return true
}

const pending = new Map<string, Promise<monaco.editor.ITextModel>>()
/** One unsubscribe per open model, so a closed tab stops listening. */
const watchers = new Map<string, () => void>()

/** Gets the tab's Monaco model, creating (and loading its file content) on first use. Models persist across
 *  tab switches and across the Monaco editor component being unmounted (e.g. while viewing Welcome). */
export function getOrCreateModel(tab: EditorTab): Promise<monaco.editor.ITextModel> {
  const existing = models.get(tab.id)
  if (existing && !existing.isDisposed()) return Promise.resolve(existing)
  let promise = pending.get(tab.id)
  if (!promise) {
    promise = createModel(tab).finally(() => pending.delete(tab.id))
    pending.set(tab.id, promise)
  }
  return promise
}

/** Writes the tab's current content to disk, applying save-time formatting, and clears its dirty flag. */
export async function saveModel(tab: EditorTab): Promise<void> {
  const model = models.get(tab.id)
  if (!model || !tab.filePath) return
  const rule = modelRules.get(tab.id) ?? {}
  const formatted = formatForSave(model.getValue(), rule)
  if (formatted !== model.getValue()) {
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: formatted }], () => null)
  }
  await window.api.invoke('fs:write', { path: tab.filePath, content: model.getValue() })
  savedVersionIds.set(tab.id, model.getAlternativeVersionId())
  useTabsStore().setDirty(tab.id, false)
  // Saving is how a divergence is resolved: this buffer is now the file.
  useTabsStore().setDiverged(tab.id, false)
}

export function disposeModel(tabId: string): void {
  watchers.get(tabId)?.()
  watchers.delete(tabId)
  models.get(tabId)?.dispose()
  models.delete(tabId)
  savedVersionIds.delete(tabId)
  modelRules.delete(tabId)
  viewStates.delete(tabId)
}

/**
 * The live Monaco widget, so a caller outside it — the application menu's
 * Edit ▸ Undo — can reach the text editor's own undo stack. There is only ever
 * one widget: `EditorArea` renders the active tab's editor and Monaco tabs
 * share it by swapping models.
 */
let mounted: monaco.editor.IStandaloneCodeEditor | null = null

export function setMountedEditor(editor: monaco.editor.IStandaloneCodeEditor | null): void {
  mounted = editor
}

/** Runs a Monaco action on the mounted widget; false when no text editor is up. */
export function triggerMonaco(action: 'undo' | 'redo'): boolean {
  if (!mounted) return false
  mounted.focus()
  mounted.trigger('menu', action, null)
  return true
}

export function saveViewState(editor: monaco.editor.IStandaloneCodeEditor, tabId: string): void {
  const state = editor.saveViewState()
  if (state) viewStates.set(tabId, state)
}

export function restoreViewState(editor: monaco.editor.IStandaloneCodeEditor, tabId: string): void {
  const state = viewStates.get(tabId)
  if (state) editor.restoreViewState(state)
}
