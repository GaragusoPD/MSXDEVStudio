import { type BrowserWindow, dialog, ipcMain } from 'electron'
import { existsSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { NewProjectRequest, OpenProject } from '../../shared/ipc'
import type { MsxProject } from '../../shared/msxproj'
import type { ProjectTabsState } from '../../shared/tabs'
import {
  createProject,
  hasMsxglConfig,
  importProject,
  loadProject,
  PROJECT_EXT,
  readIdeState,
  resolveNodeBinary,
  saveProject,
  scanLibModules,
  writeGeneratedConfig,
  writeIdeState
} from './project'
import type { FsService } from './fs-service'
import { generatedSourceModules } from './resources'
import type { GitService } from './git-service'
import type { StateService } from './state-service'
import type { ToolchainService } from './toolchain-service'

/**
 * Owns the open-project lifecycle: it's the only thing that switches the
 * FsService/GitService root, records recent projects, and pushes
 * `project:changed`. Disk work lives in `project.ts`; this is the Electron
 * glue around it.
 */
export class ProjectService {
  private current: OpenProject | null = null

  /** Set by main to tear down per-project services (Spec 04's build/artifact server). */
  onClosed: (() => void) | null = null

  constructor(
    private readonly stateService: StateService,
    private readonly toolchainService: ToolchainService,
    private readonly fsService: FsService,
    private readonly gitService: GitService,
    private readonly getWindow: () => BrowserWindow | null
  ) {}

  registerIpc(): void {
    ipcMain.handle('project:create', (_e, req: NewProjectRequest) => this.create(req))
    ipcMain.handle('project:open', (_e, req: { path?: string }) => this.open(req?.path))
    ipcMain.handle('project:save', (_e, req: { project: MsxProject }) => this.save(req.project))
    ipcMain.handle('project:close', () => this.close())
    ipcMain.handle('project:libModules', () => this.libModules())
    ipcMain.handle('project:getIdeState', () => (this.current ? readIdeState(this.current.root) : null))
    ipcMain.handle('project:setIdeState', (_e, state: ProjectTabsState) => {
      if (this.current) writeIdeState(this.current.root, state)
    })
  }

  private msxglPath(): string {
    const path = this.toolchainService.resolveMsxglPath()
    if (!path) throw new Error('MSXgl is not configured — set it up in Settings first.')
    return path
  }

  /** Makes `opened` the current project: fs root, recents, and a `project:changed` push. */
  private async activate(opened: OpenProject): Promise<OpenProject> {
    await this.fsService.setRoot(opened.root)
    this.gitService.setRoot(opened.root)
    this.current = opened
    this.stateService.addRecentProject(opened.root)
    this.getWindow()?.webContents.send('project:changed', opened)
    return opened
  }

  async create(request: NewProjectRequest): Promise<OpenProject> {
    return this.activate(createProject(request, this.msxglPath()))
  }

  /** Spec 12: the examples browser forks a sample straight to disk itself, then routes the
   *  result through the normal open flow (fs root, recents, `project:changed`) via this. */
  async openCreated(opened: OpenProject): Promise<OpenProject> {
    return this.activate(opened)
  }

  /**
   * `path` may be a project folder or a `.msxproj` file; without one, a folder
   * picker is shown (null when canceled). A folder with only
   * `project_config.js` is imported.
   */
  async open(path?: string): Promise<OpenProject | null> {
    const picked = path ?? (await this.pickFolder())
    if (!picked) return null

    const root = picked.endsWith(PROJECT_EXT) ? dirname(picked) : picked
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new Error(`Project folder no longer exists: ${root}`)
    }

    const existing = loadProject(root)
    if (existing) return this.activate(existing)

    if (!hasMsxglConfig(root)) {
      throw new Error(`No MSXStudio project (*${PROJECT_EXT}) or MSXgl project_config.js in ${root}`)
    }
    const msxglPath = this.msxglPath()
    const nodeBinary = resolveNodeBinary(msxglPath, this.toolchainService.nodeOverride())
    if (!nodeBinary) throw new Error('No Node executable found in the configured MSXgl checkout.')
    return this.activate(await importProject(root, msxglPath, nodeBinary))
  }

  /** Writes the `.msxproj` and (unless `customConfig`) regenerates `project_config.js`. */
  async save(project: MsxProject): Promise<OpenProject> {
    if (!this.current) throw new Error('No project is open')
    const { root } = this.current
    // Keep the .msxproj filename in step with a renamed project.
    const wanted = `${project.name}${PROJECT_EXT}`
    const previous = this.current.projectFile
    const saved = saveProject(root, wanted, project)
    if (previous !== wanted) rmSync(join(root, previous), { force: true })

    this.current = { ...saved, imported: this.current.imported }
    this.getWindow()?.webContents.send('project:changed', this.current)
    return this.current
  }

  close(): void {
    this.current = null
    this.gitService.setRoot(null)
    this.onClosed?.()
    this.getWindow()?.webContents.send('project:changed', null)
  }

  /** Read-only access for services that follow the open project (BuildService). */
  getOpen(): OpenProject | null {
    return this.current
  }

  /**
   * Pre-build step (Spec 04): brings `project_config.js` back in sync with the
   * `.msxproj` before MSXgl reads it. A no-op for `customConfig` projects.
   */
  regenerateConfig(): void {
    if (!this.current) return
    writeGeneratedConfig(
      this.current.root,
      this.current.projectFile,
      this.current.project,
      generatedSourceModules(this.current.root)
    )
  }

  private libModules(): string[] {
    const path = this.toolchainService.resolveMsxglPath()
    return path ? scanLibModules(path) : []
  }

  private async pickFolder(): Promise<string | null> {
    const win = this.getWindow()
    const options = { properties: ['openDirectory' as const], title: 'Open MSX project folder' }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  }
}
