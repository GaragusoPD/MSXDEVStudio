import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import icon from '../../resources/icon.png?asset'
import { BuildService } from './services/build-service'
import { ExamplesService } from './services/examples-service'
import { FsService } from './services/fs-service'
import { GitService } from './services/git-service'
import { extractProjectPath } from './services/launch-args'
import { ProjectService } from './services/project-service'
import { ResourceService } from './services/resource-service'
import { StateService } from './services/state-service'
import { ToolchainService } from './services/toolchain-service'
import type { AppState, BuildCommand } from '../shared/ipc'

// Single-instance lock: a second `.msxproj` double-click while MSXStudio is
// already running should focus the existing window and open the file there,
// not launch a competing process (see the `second-instance` handler below).
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}

const stateService = new StateService()

// Launched via file association / `msxstudio some.msxproj`: seed `lastProject`
// before the renderer loads so the existing "reopen last project on startup"
// flow (see App.vue) opens it — no separate open path to keep in sync.
const launchProjectPath = extractProjectPath(process.argv)
if (launchProjectPath) stateService.update({ lastProject: launchProjectPath })

let mainWindow: BrowserWindow | null = null
const toolchainService = new ToolchainService(stateService, () => mainWindow)
toolchainService.registerIpc()
const fsService = new FsService(() => mainWindow)
fsService.registerIpc()
const gitService = new GitService((status) => mainWindow?.webContents.send('git:changed', status))
ipcMain.handle('git:status', () => gitService.status())
ipcMain.handle('git:stage', (_e, req: { paths: string[] }) => gitService.stage(req.paths))
ipcMain.handle('git:unstage', (_e, req: { paths: string[] }) => gitService.unstage(req.paths))
ipcMain.handle('git:discard', (_e, req: { paths: string[] }) => gitService.discard(req.paths))
ipcMain.handle('git:commit', (_e, req: { message: string; amend?: boolean }) => gitService.commit(req.message, !!req.amend))
ipcMain.handle('git:log', (_e, req: { limit?: number; path?: string }) => gitService.log(req?.limit ?? 100, req?.path))
ipcMain.handle('git:branches', () => gitService.branches())
ipcMain.handle('git:checkout', (_e, req: { name: string }) => gitService.checkout(req.name))
ipcMain.handle('git:createBranch', (_e, req: { name: string }) => gitService.createBranch(req.name))
ipcMain.handle('git:push', () => gitService.push())
ipcMain.handle('git:pull', () => gitService.pull())
ipcMain.handle('git:diff', (_e, req: { path: string; staged?: boolean; origPath?: string }) =>
  gitService.diff(req.path, !!req.staged, req.origPath)
)
ipcMain.handle('git:init', () => gitService.init())
ipcMain.handle('git:clone', (_e, req: { url: string; targetDir: string }) => gitService.clone(req.url, req.targetDir))
const projectService = new ProjectService(stateService, toolchainService, fsService, gitService, () => mainWindow)
projectService.registerIpc()

// A second launch (another `.msxproj` double-click, or `msxstudio some.msxproj`
// while already running) hits this instance instead of starting a competing
// process — focus the window and open whatever project it was launched with.
app.on('second-instance', (_event, argv) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
  const projectPath = extractProjectPath(argv)
  if (projectPath) void projectService.open(projectPath)
})

const resourceService = new ResourceService(projectService, toolchainService)
resourceService.registerIpc()

const buildService = new BuildService({
  getProject: () => projectService.getOpen(),
  prepare: () => projectService.regenerateConfig(),
  exportResources: () => resourceService.exportAll(),
  msxglPath: () => toolchainService.resolveMsxglPath(),
  nodeOverride: () => toolchainService.nodeOverride(),
  emit: (channel, payload) => mainWindow?.webContents.send(channel, payload),
  openExternal: (url) => shell.openExternal(url)
})
ipcMain.handle('build:start', (_e, req: { command: BuildCommand }) => buildService.start(req.command))
ipcMain.handle('build:kill', () => buildService.kill())
projectService.onClosed = () => buildService.dispose()

ipcMain.handle('shell:open', (_e, req: { target: string }) =>
  req.target.startsWith('http') ? shell.openExternal(req.target) : shell.openPath(req.target)
)

const examplesService = new ExamplesService(toolchainService, projectService, buildService)
examplesService.registerIpc()

function broadcastState(state: AppState): void {
  mainWindow?.webContents.send('app:stateChanged', state)
}

function createWindow(): void {
  const { windowBounds } = stateService.get()

  mainWindow = new BrowserWindow({
    ...windowBounds,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  const persistBounds = (): void => {
    if (!mainWindow) return
    stateService.update({ windowBounds: mainWindow.getBounds() })
  }
  mainWindow.on('resize', persistBounds)
  mainWindow.on('move', persistBounds)

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

ipcMain.handle('app:getState', (): AppState => stateService.get())

ipcMain.handle('app:setState', (_event, partial: Partial<AppState>): AppState => {
  const state = stateService.update(partial)
  broadcastState(state)
  return state
})

// Guarded (rather than relying on `app.quit()` alone) so a losing second
// instance can never race a window into existence before it exits.
if (gotSingleInstanceLock) {
  app.whenReady().then(() => {
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  stateService.flush()
  buildService.dispose()
  void fsService.dispose()
  gitService.dispose()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => stateService.flush())
