import { defineStore } from 'pinia'
import type { ToolchainProgress, ToolchainSettings, ToolchainStatus } from '../../../shared/ipc'

/**
 * Mirrors `toolchain:getStatus` from main and drives the settings view.
 * `status` is null until the first `loadStatus()` — App.vue kicks that off
 * on mount so the Welcome screen's CTA and the settings view both see it.
 */
export const useToolchainStore = defineStore('toolchain', {
  state: () => ({
    status: null as ToolchainStatus | null,
    loading: false,
    busy: false,
    progress: null as ToolchainProgress | null
  }),

  getters: {
    /** True once a status has been loaded and both tools validate. */
    ready: (state): boolean => state.status?.msxgl.valid === true && state.status?.openmsx.valid === true,
    /** False (blocking) until we actually know — avoids a false "not ready" flash before the first load. */
    needsSetup: (state): boolean =>
      state.status !== null && (!state.status.msxgl.valid || !state.status.openmsx.valid)
  },

  actions: {
    async loadStatus(): Promise<void> {
      this.loading = true
      try {
        this.status = await window.api.invoke('toolchain:getStatus', undefined)
      } finally {
        this.loading = false
      }
    },

    async setPaths(partial: Partial<ToolchainSettings>): Promise<void> {
      this.status = await window.api.invoke('toolchain:setPaths', partial)
    },

    async downloadMsxgl(targetDir?: string): Promise<void> {
      this.busy = true
      this.progress = null
      try {
        this.status = await window.api.invoke('toolchain:downloadMsxgl', { targetDir })
      } finally {
        this.busy = false
        this.progress = null
      }
    },

    async updateMsxgl(): Promise<void> {
      this.busy = true
      this.progress = null
      try {
        this.status = await window.api.invoke('toolchain:updateMsxgl', undefined)
      } finally {
        this.busy = false
        this.progress = null
      }
    },

    pickFolder(): Promise<string | null> {
      return window.api.invoke('toolchain:pickFolder', undefined)
    },

    pickFile(): Promise<string | null> {
      return window.api.invoke('toolchain:pickFile', undefined)
    },

    /** Applied when main pushes `toolchain:progress` during download/update. */
    applyProgress(progress: ToolchainProgress): void {
      this.progress = progress
    }
  }
})
