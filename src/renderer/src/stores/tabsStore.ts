import { defineStore } from 'pinia'
import { extensionFor } from '../../../shared/file-kind'
import { nextMru, removeMru, touchMru } from '../../../shared/tabs'

export interface EditorTab {
  id: string
  title: string
  /** File extension (without dot) used to look up a registered editor. */
  extension?: string
  /** Project-root-relative path — unset for non-file tabs (e.g. Welcome). */
  filePath?: string
  dirty: boolean
  closable: boolean
}

const WELCOME_TAB: EditorTab = { id: 'welcome', title: 'Welcome', dirty: false, closable: false }

/**
 * Open tabs in the editor area's tab strip, backed by real files opened from
 * the explorer/search. Tab *ordering and metadata* live here; the actual
 * Monaco models (content, dirty-detection, undo history) live in
 * `editors/monaco-models.ts` so this store stays Monaco-agnostic and the
 * models survive this store's tabs array being touched.
 */
export const useTabsStore = defineStore('tabs', {
  state: () => ({
    tabs: [WELCOME_TAB] as EditorTab[],
    activeTabId: WELCOME_TAB.id as string,
    mruOrder: [WELCOME_TAB.id] as string[],
    /** Absolute path of the project these tabs belong to, for persistence. Null when no project is open. */
    projectRoot: null as string | null,
    /** Set by openFile() when a caller (e.g. search results, Problems panel) wants a specific location revealed once the tab is active. */
    pendingReveal: null as { path: string; line?: number; column?: number } | null
  }),

  getters: {
    activeTab: (state): EditorTab | undefined => state.tabs.find((tab) => tab.id === state.activeTabId)
  },

  actions: {
    activate(id: string): void {
      if (!this.tabs.some((tab) => tab.id === id)) return
      this.activeTabId = id
      this.mruOrder = touchMru(this.mruOrder, id)
      this.persist()
    },

    /** Ctrl+Tab: toggle to the most-recently-used tab that isn't the current one. */
    cycleMru(): void {
      const id = nextMru(this.mruOrder, this.activeTabId)
      if (id) this.activate(id)
    },

    open(tab: EditorTab): void {
      if (!this.tabs.some((t) => t.id === tab.id)) this.tabs.push(tab)
      this.activate(tab.id)
    },

    /** Opens (or activates, if already open) the file at `relPath`. Model/content loading is handled
     *  reactively by the Monaco editor component watching `activeTab`. */
    openFile(relPath: string, name: string, reveal?: { line?: number; column?: number }): void {
      if (!this.tabs.some((t) => t.id === relPath)) {
        this.tabs.push({ id: relPath, title: name, extension: extensionFor(name), filePath: relPath, dirty: false, closable: true })
      }
      this.pendingReveal = reveal ? { path: relPath, ...reveal } : null
      this.activate(relPath)
    },

    clearPendingReveal(): void {
      this.pendingReveal = null
    },

    setDirty(id: string, dirty: boolean): void {
      const tab = this.tabs.find((t) => t.id === id)
      if (tab) tab.dirty = dirty
    },

    close(id: string): void {
      const index = this.tabs.findIndex((tab) => tab.id === id)
      if (index === -1 || !this.tabs[index].closable) return
      this.tabs.splice(index, 1)
      this.mruOrder = removeMru(this.mruOrder, id)
      if (this.activeTabId === id) {
        const neighbor = this.tabs[index] ?? this.tabs[index - 1]
        this.activeTabId = neighbor?.id ?? WELCOME_TAB.id
      }
      this.persist()
    },

    /** Resets to just the Welcome tab and restores `root`'s saved tabs, if any. Content loads lazily on activation. */
    async loadForProject(root: string): Promise<void> {
      this.projectRoot = root
      this.tabs = [WELCOME_TAB]
      this.mruOrder = [WELCOME_TAB.id]
      this.activeTabId = WELCOME_TAB.id

      const saved = await window.api.invoke('project:getIdeState', undefined)
      if (!saved) return
      for (const filePath of saved.openPaths) {
        const name = filePath.split('/').pop() ?? filePath
        this.tabs.push({ id: filePath, title: name, extension: extensionFor(name), filePath, dirty: false, closable: true })
      }
      // Real recency is lost across restarts; approximate it as tab-strip order, most-recent last.
      this.mruOrder = [...saved.openPaths].reverse().concat(WELCOME_TAB.id)
      if (saved.activePath && this.tabs.some((t) => t.id === saved.activePath)) {
        this.activeTabId = saved.activePath
      }
    },

    /** Persists into `<project>/.msxdevstudio/state.json` (main resolves the path from the open project). */
    persist(): void {
      if (!this.projectRoot) return
      const openPaths = this.tabs.filter((t) => t.filePath).map((t) => t.filePath as string)
      const activePath = this.tabs.find((t) => t.id === this.activeTabId)?.filePath ?? null
      void window.api.invoke('project:setIdeState', { openPaths, activePath })
    }
  }
})
