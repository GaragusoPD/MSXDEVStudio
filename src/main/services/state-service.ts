import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppState } from '../../shared/ipc'
import { pushRecentProject } from '../../shared/state'

const DEFAULT_STATE: AppState = {
  windowBounds: { width: 1280, height: 800 },
  lastProject: null,
  recentProjects: [],
  theme: 'dark',
  panelLayout: { sideVisible: true, sideWidth: 260, bottomVisible: true, bottomHeight: 220 },
  toolchain: { msxglPath: null, openmsxPath: null, nodePath: null }
}

const SAVE_DEBOUNCE_MS = 300

/**
 * Owns `state.json` in the userData directory: loads it on startup, merges
 * partial updates, and persists on a debounced timer so frequent changes
 * (dragging a splitter, resizing the window) don't hammer disk I/O.
 */
export class StateService {
  private readonly filePath = join(app.getPath('userData'), 'state.json')
  private state: AppState
  private writeTimer: NodeJS.Timeout | null = null

  constructor() {
    this.state = this.load()
  }

  private load(): AppState {
    try {
      if (existsSync(this.filePath)) {
        const raw = JSON.parse(readFileSync(this.filePath, 'utf-8')) as Partial<AppState>
        return { ...DEFAULT_STATE, ...raw }
      }
    } catch (error) {
      console.error('[StateService] failed to load state.json, using defaults', error)
    }
    return { ...DEFAULT_STATE }
  }

  get(): AppState {
    return this.state
  }

  update(partial: Partial<AppState>): AppState {
    this.state = { ...this.state, ...partial }
    this.scheduleSave()
    return this.state
  }

  addRecentProject(projectPath: string): AppState {
    return this.update({
      lastProject: projectPath,
      recentProjects: pushRecentProject(this.state.recentProjects, projectPath)
    })
  }

  private scheduleSave(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer)
    this.writeTimer = setTimeout(() => this.flush(), SAVE_DEBOUNCE_MS)
  }

  /** Writes immediately, bypassing the debounce. Call before quit. */
  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    try {
      writeFileSync(this.filePath, JSON.stringify(this.state, null, 2))
    } catch (error) {
      console.error('[StateService] failed to save state.json', error)
    }
  }
}
