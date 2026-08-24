import { defineStore } from 'pinia'
import type { AppState, PanelLayout, Preferences, Theme } from '../../../shared/ipc'
import { LICENSE_VERSION } from '../../../shared/license'

const DEFAULT_STATE: AppState = {
  windowBounds: { width: 1280, height: 800 },
  lastProject: null,
  recentProjects: [],
  theme: 'dark',
  panelLayout: { sideVisible: true, sideWidth: 260, bottomVisible: true, bottomHeight: 220 },
  toolchain: { msxglPath: null, openmsxPath: null, nodePath: null },
  licenseAccepted: null,
  // null family = the theme's own, so a fresh install looks the way it always
  // did and only a deliberate choice changes it.
  preferences: { editor: { family: null, size: 13 }, terminal: { family: null, size: 13 } }
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
  // `stateLoaded` is the same kind of thing: App.vue renders nothing until it
  // flips, so an accepted user never sees the licence gate flash past.
  // `structuredClone`, not a spread: a spread shares every nested object with
  // `DEFAULT_STATE`, and `$patch` merges *into* those — so the first preference
  // anyone changed rewrote the defaults themselves, for the rest of the session.
  state: (): AppState & { bottomTab: BottomTab; stateLoaded: boolean; preferencesVisible: boolean } => ({
    ...structuredClone(DEFAULT_STATE),
    bottomTab: 'output',
    stateLoaded: false,
    /** View state: the Preferences modal is open. Not persisted. */
    preferencesVisible: false
  }),

  getters: {
    hasProject: (state): boolean => state.lastProject !== null,

    /** False until the current licence version has been accepted at startup. */
    licenseAgreed: (state): boolean => state.licenseAccepted === LICENSE_VERSION
  },

  actions: {
    async load(): Promise<void> {
      const state = await window.api.invoke('app:getState', undefined)
      this.$patch(state)
      this.stateLoaded = true
    },

    /** Ticked the box and pressed Accept — recorded so the gate stays away. */
    async acceptLicense(): Promise<void> {
      await this.persist({ licenseAccepted: LICENSE_VERSION })
    },

    /** Declined: nothing is recorded, so the gate returns on the next launch. */
    async declineLicense(): Promise<void> {
      await window.api.invoke('app:quit', undefined)
    },

    /**
     * Applies a partial update locally and asks main to persist it.
     *
     * Sent as plain data, not as it sits in the store: anything read back off
     * a Pinia state object is a reactive proxy, and structured clone — which is
     * what IPC uses — refuses to copy one. A nested value is where this bites,
     * since spreading the top level leaves the groups underneath still
     * proxied. These are all JSON settings, so a round trip is the cheap way to
     * be sure.
     */
    async persist(partial: Partial<AppState>): Promise<void> {
      this.$patch(partial)
      await window.api.invoke('app:setState', JSON.parse(JSON.stringify(partial)) as Partial<AppState>)
    },

    /**
     * Merges one preference group onto the current preferences and persists it.
     *
     * By group rather than by leaf: `app:setState` replaces a top-level key
     * wholesale, so sending a half-built `preferences` would drop every other
     * group.
     */
    async patchPreferences<K extends keyof Preferences>(
      group: K,
      partial: Partial<Preferences[K]>
    ): Promise<void> {
      await this.persist({
        preferences: { ...this.preferences, [group]: { ...this.preferences[group], ...partial } }
      })
    },

    /** Merges a partial layout update onto the current one and persists it. */
    async patchLayout(partial: Partial<PanelLayout>): Promise<void> {
      await this.persist({ panelLayout: { ...this.panelLayout, ...partial } })
    },

    /** Drops one entry from the Welcome tab's list. The project on disk is untouched. */
    forgetRecentProject(path: string): void {
      void this.persist({
        recentProjects: this.recentProjects.filter((entry) => entry !== path),
        // App.vue reopens `lastProject` at startup, and opening it would put it
        // straight back in the list — so forgetting it has to clear that too.
        ...(this.lastProject === path ? { lastProject: null } : {})
      })
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
