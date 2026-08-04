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

import type { MenuCommand } from '../../shared/ipc'
import { getEditorFor } from './editors/registry'
import { disposeModel, saveModel, triggerMonaco } from './editors/monaco-models'
import { router } from './router'
import { useAppStore } from './stores/appStore'
import { useBuildStore } from './stores/buildStore'
import { useProjectStore } from './stores/projectStore'
import { useTabsStore, type EditorTab } from './stores/tabsStore'

/** Saves one tab through its own editor, whatever kind it is. Synthetic tabs have no path and are skipped. */
export async function saveTab(tab: EditorTab | undefined): Promise<void> {
  if (!tab?.filePath) return
  const save = tab.extension ? getEditorFor(tab.extension)?.save : undefined
  if (save) await save(tab.filePath)
  else await saveModel(tab)
}

export async function saveAllTabs(): Promise<void> {
  // Sequential: these are small files, and a burst of concurrent writes buys nothing.
  for (const tab of useTabsStore().tabs.filter((tab) => tab.dirty && tab.filePath)) await saveTab(tab)
}

export function closeTabWithPrompt(id: string): void {
  const tabsStore = useTabsStore()
  const tab = tabsStore.tabs.find((t) => t.id === id)
  if (!tab) return
  if (tab.dirty && !window.confirm(`"${tab.title}" has unsaved changes. Close without saving?`)) return
  disposeModel(id)
  tabsStore.close(id)
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
    default:
      // `help.*` never reaches the renderer — the main process answers those itself.
      break
  }
}
