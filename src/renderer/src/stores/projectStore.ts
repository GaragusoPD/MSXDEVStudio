import { defineStore } from 'pinia'
import type { NewProjectRequest, OpenProject } from '../../../shared/ipc'
import type { MsxProject } from '../../../shared/msxproj'
import { useTabsStore } from './tabsStore'

/**
 * The renderer's mirror of the open project. Main owns the files
 * (`ProjectService`); this holds the in-memory `.msxproj` the settings form
 * edits, the dirty flag, and the New Project wizard's visibility.
 */
export const useProjectStore = defineStore('project', {
  state: () => ({
    open: null as OpenProject | null,
    dirty: false,
    /** LibModules candidates scanned from `<msxgl>/engine/src/`; loaded on demand. */
    libModules: [] as string[],
    wizardVisible: false
  }),

  getters: {
    /** Absolute project root, or null. Used by the status bar and Monaco's editorconfig lookup. */
    currentProjectPath: (state): string | null => state.open?.root ?? null,
    project: (state): MsxProject | null => state.open?.project ?? null
  },

  actions: {
    init(): void {
      window.api.on('project:changed', (opened) => {
        this.open = opened
        this.dirty = false
      })
    },

    async afterOpen(opened: OpenProject | null): Promise<void> {
      if (!opened) return
      this.open = opened
      this.dirty = false
      await useTabsStore().loadForProject(opened.root)
    },

    /** With no `path`, shows a folder picker; with one (a recent project), reopens it directly. */
    async openProject(path?: string): Promise<void> {
      try {
        await this.afterOpen(await window.api.invoke('project:open', { path }))
      } catch (error) {
        window.alert(`Couldn't open the project: ${String(error)}`)
      }
    },

    newProject(): void {
      this.wizardVisible = true
    },

    async createProject(request: NewProjectRequest): Promise<boolean> {
      try {
        await this.afterOpen(await window.api.invoke('project:create', request))
        this.wizardVisible = false
        return true
      } catch (error) {
        window.alert(`Couldn't create the project: ${String(error)}`)
        return false
      }
    },

    /** Applies a settings change locally and marks the project dirty (saved explicitly). */
    patch(mutate: (project: MsxProject) => void): void {
      if (!this.open) return
      mutate(this.open.project)
      this.dirty = true
    },

    async save(): Promise<void> {
      if (!this.open) return
      // Pinia state is a reactive proxy; structuredClone-via-JSON keeps IPC's serializer happy.
      const project = JSON.parse(JSON.stringify(this.open.project)) as MsxProject
      this.open = await window.api.invoke('project:save', { project })
      this.dirty = false
    },

    async loadLibModules(): Promise<void> {
      if (this.libModules.length) return
      this.libModules = await window.api.invoke('project:libModules', undefined)
    }
  }
})
