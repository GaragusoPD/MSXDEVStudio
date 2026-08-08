import { defineStore } from 'pinia'
import type { AppState, PanelLayout, Theme } from '../../../shared/ipc'

const DEFAULT_STATE: AppState = {
  windowBounds: { width: 1280, height: 800 },
  lastProject: null,
  recentProjects: [],
  theme: 'dark',
  panelLayout: { sideVisible: true, sideWidth: 260, bottomVisible: true, bottomHeight: 220 },
  toolchain: { msxglPath: null, openmsxPath: null, nodePath: null }
}

/**
 * Mirrors the main process's StateService. `load()` pulls the persisted
 * state once at startup; every mutation goes through `persist()`, which
 * updates local state immediately (snappy UI) and forwards the same partial
 * to main via `app:setState` for debounced disk persistence.
 */
export type BottomTab = 'output' | 'problems' | 'terminal'

export const useAppStore = defineStore('app', {
  // `bottomTab` is view state, not persisted settings — it rides along with the
  // panel layout it belongs to rather than earning a store of its own.
  state: (): AppState & { bottomTab: BottomTab } => ({ ...DEFAULT_STATE, bottomTab: 'output' }),

  getters: {
    hasProject: (state): boolean => state.lastProject !== null
  },

  actions: {
    async load(): Promise<void> {
      const state = await window.api.invoke('app:getState', undefined)
      this.$patch(state)
    },

    /** Applies a partial update locally and asks main to persist it. */
    async persist(partial: Partial<AppState>): Promise<void> {
      this.$patch(partial)
      await window.api.invoke('app:setState', partial)
    },

    /** Merges a partial layout update onto the current one and persists it. */
    async patchLayout(partial: Partial<PanelLayout>): Promise<void> {
      await this.persist({ panelLayout: { ...this.panelLayout, ...partial } })
    },

    setTheme(theme: Theme): void {
      void this.persist({ theme })
    },

    toggleSidePanel(): void {
      void this.patchLayout({ sideVisible: !this.panelLayout.sideVisible })
    },

    toggleBottomPanel(): void {
      void this.patchLayout({ bottomVisible: !this.panelLayout.bottomVisible })
    },

    /** Opens the bottom panel on a given tab (build output, problem counts…). */
    showBottomPanel(tab: BottomTab): void {
      this.bottomTab = tab
      if (!this.panelLayout.bottomVisible) void this.patchLayout({ bottomVisible: true })
    },

    setSideWidth(width: number): void {
      void this.patchLayout({ sideWidth: Math.round(width) })
    },

    setBottomHeight(height: number): void {
      void this.patchLayout({ bottomHeight: Math.round(height) })
    },

    /** Applied when main pushes `app:stateChanged` (e.g. window resize). */
    applyRemoteState(state: AppState): void {
      this.$patch(state)
    }
  }
})
