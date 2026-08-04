import { defineStore } from 'pinia'
import type { ConversionResult, ResourceEntry } from '../../../shared/ipc'
import { useAppStore } from './appStore'
import { useOutputStore } from './outputStore'

/**
 * The Resources panel (Spec 07): what editor resources the project holds and
 * the manual export/convert commands. Builds run the same step automatically
 * via `BuildService`, so this is only for exporting on demand.
 */
export const useResourcesStore = defineStore('resources', {
  state: () => ({
    entries: [] as ResourceEntry[],
    busy: false,
    /** Results of the last export, newest run only. */
    lastRun: [] as ConversionResult[],
    /** Absolute path of MSXgl's bundled `MSXimg.txt`, when available. */
    msximgHelp: null as string | null,
    importVisible: false,
    /** Why the last listing failed, if it did — shown in the panel instead of thrown at the console. */
    error: null as string | null
  }),

  actions: {
    /**
     * Re-lists the project's resources. Called from mounts and watchers with
     * `void`, so a rejection here would be an unhandled one in the console and
     * nothing else — a folder deleted under the app is enough to cause it. The
     * previous list is kept rather than blanked: a stale entry the user can
     * click is more use than an empty panel.
     */
    async refresh(): Promise<void> {
      try {
        this.entries = await window.api.invoke('resources:list', undefined)
        this.msximgHelp = await window.api.invoke('resources:msximgHelp', undefined)
        this.error = null
      } catch (error) {
        this.error = String(error)
      }
    },

    /** Streams the outcome to the Output panel — same place builds report it. */
    async exportAll(force = false): Promise<void> {
      if (this.busy) return
      this.busy = true
      useAppStore().showBottomPanel('output')
      const output = useOutputStore()
      try {
        this.lastRun = await window.api.invoke('resources:exportAll', { force })
        for (const result of this.lastRun) {
          const line = `${result.input} → ${result.out}: ${result.status}${result.message ? ` (${result.message})` : ''}`
          output.append(result.status === 'failed' ? 'build:err' : 'build', line)
        }
        if (!this.lastRun.length) output.append('build', 'No resources or image rules to convert.')
      } catch (error) {
        output.append('build:err', String(error))
      } finally {
        this.busy = false
      }
    },

    async exportOne(path: string): Promise<void> {
      const output = useOutputStore()
      useAppStore().showBottomPanel('output')
      try {
        const result = await window.api.invoke('resources:exportOne', { path, force: true })
        output.append(
          result.status === 'failed' ? 'build:err' : 'build',
          `${result.input} → ${result.out}: ${result.status}${result.message ? ` (${result.message})` : ''}`
        )
      } catch (error) {
        output.append('build:err', String(error))
      }
    }
  }
})
