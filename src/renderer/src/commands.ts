/**
 * The workbench commands — save, save all, close tab, undo, build, show a view
 * — with one implementation each, whoever triggers them: the application menu
 * (`main/menu.ts` → `menu:command`), a keyboard shortcut, or a button.
 *
 * Most are a straight call into the store action the equivalent button already
 * uses; nothing new belongs here that could live in a store instead. The two
 * that genuinely had no owner are `saveTab` and `closeTabWithPrompt`: every
 * editor handled its own Ctrl+S, so "save whatever tab is active" had nowhere
 * to live. They go through the editor registry's hooks, which keeps them right
 * as new editors are registered.
 */

import { DOCS_DEMOS, DOCS_INDEX, DOCS_TUTORIALS } from '../../shared/docs'
import type { MenuCommand } from '../../shared/ipc'
import { getEditorFor } from './editors/registry'
import { disposeModel, saveModel, triggerMonaco } from './editors/monaco-models'
import { openDocs } from './editors/docs/session'
import { newTerminalId } from './editors/terminal/session'
import { router } from './router'
import { useAppStore } from './stores/appStore'
import { useBuildStore } from './stores/buildStore'
import { useOutputStore } from './stores/outputStore'
import { useProjectStore } from './stores/projectStore'
import { useTabsStore, type EditorTab } from './stores/tabsStore'

/**
 * True when the keystroke belongs to whatever the user is typing in. The editors
 * listen on `window`, so without this a name typed into the Resources panel
 * reaches the map editor as Backspace-deletes-the-selection, and Ctrl+C in a
 * text field copies tiles instead of text.
 */
export function isTypingTarget(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null
  if (!target) return false
  return target.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)
}

/** Saves one tab through its own editor, whatever kind it is. Synthetic tabs have no path and are skipped. */
export async function saveTab(tab: EditorTab | undefined): Promise<void> {
  if (!tab?.filePath) return
  const save = tab.extension ? getEditorFor(tab.extension)?.save : undefined
  if (save) await save(tab.filePath)
  else await saveModel(tab)
}

/**
 * Saves every dirty tab. One that fails — its file deleted or renamed under the
 * editor, a permission problem — must not stop the rest: the whole point of the
 * command is that afterwards nothing is left unsaved.
 *
 * Failures go to the Output panel, where build and export failures already go,
 * and deliberately *not* through `window.alert`: in Electron that is a
 * window-modal dialog, so an alert that opens behind the window or on another
 * desktop leaves the app painted but unable to take a click or a keystroke —
 * indistinguishable from a frozen UI.
 */
export async function saveAllTabs(): Promise<void> {
  const failed: string[] = []
  // Sequential: these are small files, and a burst of concurrent writes buys nothing.
  for (const tab of useTabsStore().tabs.filter((tab) => tab.dirty && tab.filePath)) {
    try {
      await saveTab(tab)
    } catch (error) {
      failed.push(`${tab.filePath}: ${String(error)}`)
    }
  }
  if (!failed.length) return
  const output = useOutputStore()
  useAppStore().showBottomPanel('output')
  output.append('build:err', `Save all: ${failed.length} file${failed.length === 1 ? '' : 's'} could not be saved.`)
  for (const line of failed) output.append('build:err', `  ${line}`)
}

export function closeTabWithPrompt(id: string): void {
  const tabsStore = useTabsStore()
  const tab = tabsStore.tabs.find((t) => t.id === id)
  if (!tab) return
  if (tab.dirty && !window.confirm(`"${tab.title}" has unsaved changes. Close without saving?`)) return
  disposeModel(id)
  if (tab.extension) getEditorFor(tab.extension)?.close?.(id)
  tabsStore.close(id)
}

/**
 * Opens a shell as an editor-area tab — the full-height layout VS Code calls
 * "terminal in the editor area", and the one worth having for a long-running
 * agent session. Each is its own shell; the bottom panel's is a fourth.
 */
export function openTerminalTab(): void {
  const id = newTerminalId()
  useTabsStore().open({
    id,
    title: `Terminal ${id.slice('terminal:'.length)}`,
    extension: 'terminal',
    dirty: false,
    closable: true
  })
}

/** Ctrl+` — shows the bottom panel's terminal, or collapses the panel if it is already there. */
export function toggleTerminal(): void {
  const appStore = useAppStore()
  if (appStore.panelLayout.bottomVisible && appStore.bottomTab === 'terminal') appStore.toggleBottomPanel()
  else appStore.showBottomPanel('terminal')
}

/** Undo/redo on the active tab: its editor's own stack, or Monaco's for a text file. */
function history(action: 'undo' | 'redo'): void {
  const tab = useTabsStore().activeTab
  const hook = tab?.extension ? getEditorFor(tab.extension)?.[action] : undefined
  if (hook && tab?.filePath) hook(tab.filePath)
  else triggerMonaco(action)
}

/** Shows a side-panel view, opening the panel when it was collapsed. */
function showView(route: string): void {
  const appStore = useAppStore()
  if (!appStore.panelLayout.sideVisible) appStore.toggleSidePanel()
  void router.push(route)
}

export function runMenuCommand(command: MenuCommand): void {
  const appStore = useAppStore()
  const buildStore = useBuildStore()
  const projectStore = useProjectStore()
  const tabsStore = useTabsStore()

  switch (command) {
    case 'file.newProject':
      projectStore.newProject()
      break
    case 'file.newGame':
      projectStore.newGame()
      break
    case 'file.openProject':
      void projectStore.openProject()
      break
    case 'file.save':
      void saveTab(tabsStore.activeTab)
      break
    case 'file.saveAll':
      void saveAllTabs()
      break
    case 'file.projectSettings': {
      // The `.msxproj` is registered as an editor type, so opening it *is* the settings UI.
      const file = projectStore.open?.projectFile
      if (file) tabsStore.openFile(file, file)
      break
    }
    case 'file.toolchainSettings':
      showView('/settings')
      break
    case 'file.preferences':
      useAppStore().preferencesVisible = true
      break
    case 'file.closeTab':
      if (tabsStore.activeTabId) closeTabWithPrompt(tabsStore.activeTabId)
      break
    case 'edit.undo':
      history('undo')
      break
    case 'edit.redo':
      history('redo')
      break
    case 'edit.findInFiles':
      showView('/search')
      break
    case 'build.build':
    case 'build.rebuild':
    case 'build.clean':
    case 'build.run':
      void buildStore.start(command.slice('build.'.length) as 'build' | 'rebuild' | 'clean' | 'run')
      break
    case 'build.stop':
      buildStore.kill()
      break
    case 'view.explorer':
    case 'view.search':
    case 'view.git':
    case 'view.resources':
    case 'view.examples':
      showView(`/${command.slice('view.'.length)}`)
      break
    case 'view.toggleSide':
      appStore.toggleSidePanel()
      break
    case 'view.toggleBottom':
      appStore.toggleBottomPanel()
      break
    case 'view.output':
      appStore.showBottomPanel('output')
      break
    case 'view.problems':
      appStore.showBottomPanel('problems')
      break
    case 'view.terminal':
      toggleTerminal()
      break
    case 'view.terminalTab':
      openTerminalTab()
      break
    case 'help.docs':
      openDocs(DOCS_INDEX)
      break
    case 'help.tutorials':
      openDocs(DOCS_TUTORIALS)
      break
    case 'help.demos':
      openDocs(DOCS_DEMOS)
      break
    case 'help.installDemos':
      void useProjectStore().installDemos()
      break
    default:
      // The rest of `help.*` never reaches the renderer — the main process
      // answers those itself.
      break
  }
}
