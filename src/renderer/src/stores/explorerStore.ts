import { defineStore } from 'pinia'
import type { FsChangeEvent, FsEntry } from '../../../shared/ipc'

export type EditingMode = 'rename' | 'create-file' | 'create-folder'

export interface EditingState {
  /** Directory (relative path, '' = root) the edit applies within. */
  parent: string
  mode: EditingMode
  /** Set only for 'rename': the entry being renamed. */
  target?: FsEntry
  initialName: string
}

/**
 * File-tree state for the Explorer side panel: a per-directory children
 * cache (populated lazily, on expand — see spec's "10k files doesn't
 * freeze the UI") plus which directories are expanded and any in-progress
 * inline rename/create. A single `fs:changed` subscription refreshes
 * whichever loaded directory a change lands in.
 */
export const useExplorerStore = defineStore('explorer', {
  state: () => ({
    children: {} as Record<string, FsEntry[]>,
    expanded: {} as Record<string, boolean>,
    editing: null as EditingState | null,
    subscribed: false
  }),

  actions: {
    init(): void {
      if (this.subscribed) return
      this.subscribed = true
      window.api.on('fs:changed', (event) => this.onFsChanged(event))
    },

    reset(): void {
      this.children = {}
      this.expanded = {}
      this.editing = null
    },

    async load(relPath: string): Promise<void> {
      this.children[relPath] = await window.api.invoke('fs:readDir', { path: relPath })
    },

    async toggle(relPath: string): Promise<void> {
      const next = !this.expanded[relPath]
      this.expanded[relPath] = next
      if (next && !this.children[relPath]) await this.load(relPath)
    },

    async refresh(relPath: string): Promise<void> {
      if (this.children[relPath]) await this.load(relPath)
    },

    startCreate(parent: string, mode: 'create-file' | 'create-folder'): void {
      this.expanded[parent] = true
      this.editing = { parent, mode, initialName: '' }
    },

    startRename(parent: string, target: FsEntry): void {
      this.editing = { parent, mode: 'rename', target, initialName: target.name }
    },

    cancelEdit(): void {
      this.editing = null
    },

    async commitEdit(name: string): Promise<void> {
      const editing = this.editing
      this.editing = null
      if (!editing || !name.trim()) return
      const trimmed = name.trim()
      try {
        if (editing.mode === 'rename' && editing.target) {
          const newPath = editing.parent ? `${editing.parent}/${trimmed}` : trimmed
          if (newPath !== editing.target.path) await window.api.invoke('fs:rename', { path: editing.target.path, newPath })
        } else {
          const path = editing.parent ? `${editing.parent}/${trimmed}` : trimmed
          await window.api.invoke('fs:create', { path, kind: editing.mode === 'create-folder' ? 'directory' : 'file' })
        }
      } catch (error) {
        window.alert(`Couldn't ${editing.mode === 'rename' ? 'rename' : 'create'} "${trimmed}": ${String(error)}`)
      } finally {
        await this.refresh(editing.parent)
      }
    },

    async remove(entry: FsEntry): Promise<void> {
      const parent = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''
      try {
        await window.api.invoke('fs:delete', { path: entry.path })
      } catch (error) {
        window.alert(`Couldn't delete "${entry.name}": ${String(error)}`)
      } finally {
        await this.refresh(parent)
      }
    },

    onFsChanged(event: FsChangeEvent): void {
      const parent = event.path.includes('/') ? event.path.slice(0, event.path.lastIndexOf('/')) : ''
      void this.refresh(parent)
    }
  }
})
