import { defineStore } from 'pinia'
import type { BuildArtifact, BuildCommand } from '../../../shared/ipc'
import { useAppStore } from './appStore'
import { useOutputStore } from './outputStore'
import { useProblemsStore } from './problemsStore'
import { useProjectStore } from './projectStore'

/**
 * The renderer's view of Spec 04's BuildService: which build is running, what
 * it produced, and the toolbar/status-bar actions that drive it. Streamed
 * output goes to `outputStore` and parsed diagnostics to `problemsStore` —
 * this store only keeps what's specific to building.
 */
export const useBuildStore = defineStore('build', {
  state: () => ({
    running: false,
    /** The command currently running, or the last one that ran. */
    command: null as BuildCommand | null,
    artifacts: [] as BuildArtifact[],
    /** Null before the first build; then the exit code (null when killed). */
    lastCode: null as number | null,
    lastOk: null as boolean | null
  }),

  actions: {
    /** Subscribes to the main-process build events. Called once, from App.vue. */
    init(): void {
      const outputStore = useOutputStore()
      const problemsStore = useProblemsStore()

      window.api.on('build:started', ({ command }) => {
        this.running = true
        this.command = command
        this.artifacts = []
        outputStore.clear()
        problemsStore.clear()
      })

      window.api.on('build:output', ({ channel, lines }) => {
        for (const line of lines) outputStore.append(channel, line)
      })

      window.api.on('build:finished', (result) => {
        this.running = false
        this.lastOk = result.ok
        this.lastCode = result.code
        this.artifacts = result.artifacts
        problemsStore.set(result.problems)
        if (result.message) {
          for (const line of result.message.split('\n')) outputStore.append('build:err', line)
        }
        if (result.problems.length) useAppStore().showBottomPanel('problems')
      })
    },

    async start(command: BuildCommand): Promise<void> {
      if (this.running) return
      const appStore = useAppStore()
      appStore.showBottomPanel('output')
      try {
        await window.api.invoke('build:start', { command })
      } catch (error) {
        this.running = false
        useOutputStore().append('build:err', String(error))
      }
    },

    kill(): void {
      void window.api.invoke('build:kill', undefined)
    },

    /** Persists the emulator choice into the `.msxproj` (Spec 04 binds the picker to it). */
    async setPreferredEmulator(preferred: 'openmsx' | 'webmsx'): Promise<void> {
      const projectStore = useProjectStore()
      if (!projectStore.project || projectStore.project.emulator.preferred === preferred) return
      projectStore.patch((project) => {
        project.emulator.preferred = preferred
      })
      await projectStore.save()
    },

    reveal(artifact: BuildArtifact): void {
      void window.api.invoke('fs:reveal', { path: artifact.path })
    }
  }
})
