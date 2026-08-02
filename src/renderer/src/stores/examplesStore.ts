import { defineStore } from 'pinia'
import catalogData from '../examples/catalog.json'
import type { Machine } from '../../../shared/msxgl-consts'
import type { NewProjectRequest } from '../../../shared/ipc'
import { useAppStore } from './appStore'
import { useBuildStore } from './buildStore'
import { useOutputStore } from './outputStore'
import { useProjectStore } from './projectStore'
import { useTabsStore } from './tabsStore'

export interface CatalogEntry {
  id: string
  title: string
  category: string
  machine: Machine
  target: string
  description: string
  tags: string[]
}

const CATALOG = catalogData as CatalogEntry[]

/**
 * The Examples browser (Spec 12): the static catalog (filtered against what
 * actually exists in the configured MSXgl checkout), opening a read-only
 * viewer tab, "Try it" builds, and the "New project from example" fork flow
 * (state only — `NewProjectDialog.vue` renders it when `forkSource` is set).
 */
export const useExamplesStore = defineStore('examples', {
  state: () => ({
    catalog: [] as CatalogEntry[],
    loaded: false,
    forkSource: null as CatalogEntry | null
  }),

  actions: {
    /** Drops catalog entries whose sample no longer exists (MSXgl version drift), once per session. */
    async load(): Promise<void> {
      if (this.loaded) return
      this.loaded = true
      const ids = CATALOG.map((e) => e.id)
      const existing = new Set(await window.api.invoke('examples:existingIds', { ids }))
      const dropped = ids.filter((id) => !existing.has(id))
      if (dropped.length) console.log('[examples] dropped (missing on disk):', dropped.join(', '))
      this.catalog = CATALOG.filter((e) => existing.has(e.id))
    },

    openViewer(entry: CatalogEntry): void {
      useTabsStore().open({
        id: `example:${entry.id}`,
        title: entry.title,
        extension: 'example-viewer',
        dirty: false,
        closable: true
      })
    },

    /** Builds (and runs, if an emulator is configured) the sample in place. Output goes through
     *  the same build:* events as a project build, so outputStore/problemsStore/buildStore all apply. */
    async tryIt(id: string): Promise<void> {
      if (useBuildStore().running) return
      useAppStore().showBottomPanel('output')
      try {
        await window.api.invoke('examples:tryIt', { id })
      } catch (error) {
        useOutputStore().append('build:err', String(error))
      }
    },

    /** Opens the New Project dialog in fork mode, prefilled from the catalog entry. */
    startFork(entry: CatalogEntry): void {
      this.forkSource = entry
    },

    cancelFork(): void {
      this.forkSource = null
    },

    async submitFork(id: string, request: NewProjectRequest, copyEntireContent: boolean): Promise<boolean> {
      try {
        const { opened, notices } = await window.api.invoke('examples:fork', { id, request, copyEntireContent })
        await useProjectStore().afterOpen(opened)
        this.forkSource = null
        if (notices.length) {
          window.alert(`Project created. A few things need attention:\n\n${notices.join('\n')}`)
        }
        return true
      } catch (error) {
        window.alert(`Couldn't create the project from this example: ${String(error)}`)
        return false
      }
    }
  }
})
