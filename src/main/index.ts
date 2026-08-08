import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { demosRoot, installDemos, planInstall } from './services/demos'
import { docsRoot, resolveDocRequest } from './services/docs'
import icon from '../../resources/icon.png?asset'
import { BuildService } from './services/build-service'
import { ExamplesService } from './services/examples-service'
import { FsService } from './services/fs-service'
import { GitService } from './services/git-service'
import { extractProjectPath } from './services/launch-args'
import { menuTemplate } from './menu'
import { indexMsxglSymbols } from './services/msxgl-symbols'
import { ProjectService } from './services/project-service'
import { ResourceService } from './services/resource-service'
import { StateService } from './services/state-service'
import { TerminalService } from './services/terminal-service'
import { ToolchainService } from './services/toolchain-service'
import type { AppState, BuildCommand, MenuCommand, MsxglSymbol } from '../shared/ipc'

// Single-instance lock: a second `.msxproj` double-click while MSXStudio is
// already running should focus the existing window and open the file there,
// not launch a competing process (see the `second-instance` handler below).
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}

// The bundled documentation is served to the renderer as `docs://app/<path>`.
// Must be declared before `whenReady`, and `standard` is the load-bearing bit:
// it gives the scheme real URL semantics, so a page's relative links and
// `<img src>` resolve against the document they came from.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'docs',
    privileges: {
      // `standard` is the load-bearing one: it gives the scheme real URL
      // semantics, so a page's relative links and `<img src>` resolve against
      // the document they came from. The rest let the renderer `fetch()` it —
      // and CORS applies, because the renderer's own origin is
      // `http://localhost` in dev and `file://` when packaged, never `docs:`.
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true
    }
  }
])

const stateService = new StateService()

// Launched via file association / `msxstudio some.msxproj`: seed `lastProject`
// before the renderer loads so the existing "reopen last project on startup"
// flow (see App.vue) opens it — no separate open path to keep in sync.
const launchProjectPath = extractProjectPath(process.argv)
if (launchProjectPath) stateService.update({ lastProject: launchProjectPath })

let mainWindow: BrowserWindow | null = null
const toolchainService = new ToolchainService(stateService, () => mainWindow)
toolchainService.registerIpc()
// MSXgl API completions: parsing all 117 headers takes ~60ms, so it is done
// once per configured checkout and cached until the path changes.
let symbolCache: { path: string; symbols: MsxglSymbol[] } | null = null
ipcMain.handle('toolchain:msxglSymbols', (_e, req: { force?: boolean } | undefined) => {
  const path = toolchainService.resolveMsxglPath()
  if (!path) return []
  // `force` covers updating MSXgl in place, where the path alone is unchanged.
  if (req?.force || symbolCache?.path !== path) {
    symbolCache = { path, symbols: indexMsxglSymbols(path) }
  }
  return symbolCache.symbols
})

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
  openmsxPath: () => toolchainService.resolveOpenmsxPath(),
  emit: (channel, payload) => mainWindow?.webContents.send(channel, payload),
  openExternal: (url) => shell.openExternal(url)
})
ipcMain.handle('build:start', (_e, req: { command: BuildCommand }) => buildService.start(req.command))
ipcMain.handle('build:kill', () => buildService.kill())
projectService.onClosed = () => buildService.dispose()

ipcMain.handle('shell:open', (_e, req: { target: string }) =>
  req.target.startsWith('http') ? shell.openExternal(req.target) : shell.openPath(req.target)
)

// The demo games are copied *out* of the install rather than opened in place:
// a build writes `out/` into the project folder, and the install directory is
// root-owned on Linux and under Program Files on Windows.
const demoSource = (): string => demosRoot(app.isPackaged, app.getAppPath(), process.resourcesPath)

ipcMain.handle('demos:plan', (_e, req: { targetDir: string }) =>
  planInstall(demoSource(), req.targetDir).map(({ demo, available, conflict }) => ({
    id: demo.id,
    title: demo.title,
    blurb: demo.blurb,
    available,
    conflict
  }))
)
ipcMain.handle('demos:pickFolder', async () => {
  const options = {
    title: 'Where should the demo projects go?',
    properties: ['openDirectory' as const, 'createDirectory' as const],
    buttonLabel: 'Install here'
  }
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
})
ipcMain.handle('demos:install', (_e, req: { targetDir: string; overwrite?: boolean }) =>
  installDemos(demoSource(), req.targetDir, { overwrite: req.overwrite, version: app.getVersion() })
)

const examplesService = new ExamplesService(toolchainService, projectService, buildService)
examplesService.registerIpc()

// Shells open in the project root, so a terminal is already where `make`,
// `git` and the MSXgl scripts expect to be run from.
const terminalService = new TerminalService(
  () => projectService.getOpen()?.root ?? null,
  (channel, payload) => mainWindow?.webContents.send(channel, payload)
)
terminalService.registerIpc()

function broadcastState(state: AppState): void {
  mainWindow?.webContents.send('app:stateChanged', state)
}

const MSXGL_DOCS_URL = 'https://github.com/aoineko-fr/MSXgl/wiki'

/**
 * Menu items either open something the main process owns (the Help links, the
 * About box) or go to the renderer, which runs them through the same store
 * actions its buttons use.
 */
function onMenuCommand(command: MenuCommand): void {
  // `help.docs` / `help.tutorials` are *not* handled here: the documentation
  // ships inside the app and opens in a tab, so they travel to the renderer
  // like every other command. Only the genuinely external link stays.
  if (command === 'help.msxgl') void shell.openExternal(MSXGL_DOCS_URL)
  else if (command === 'help.about') {
    void dialog.showMessageBox({
      type: 'info',
      title: 'About MSXStudio',
      message: `MSXStudio ${app.getVersion()}`,
      detail: `An IDE for MSX game development, built around MSXgl.\n\nElectron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
      buttons: ['OK']
    })
  } else mainWindow?.webContents.send('menu:command', command)
}

function createWindow(): void {
  const { windowBounds } = stateService.get()

  mainWindow = new BrowserWindow({
    ...windowBounds,
    show: false,
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
    // `app.getAppPath()` is the project root in dev and `app.asar` when
    // packaged; `net.fetch` reads a `file:` URL out of either, so the docs are
    // served the same way in both without unpacking them.
    const root = docsRoot(app.getAppPath())
    const notFound = (why: string): Response =>
      new Response(why, { status: 404, headers: { 'content-type': 'text/plain', 'access-control-allow-origin': '*' } })

    protocol.handle('docs', async (request) => {
      const file = resolveDocRequest(root, request.url)
      if (!file) return notFound('Outside the documentation folder')
      let response: Response
      try {
        response = await net.fetch(pathToFileURL(file).toString())
      } catch {
        return notFound(`No such documentation file: ${request.url}`)
      }
      // `net.fetch` of a `file:` URL answers without CORS headers, so the
      // cross-origin read above would be rejected before the renderer sees it.
      const headers = new Headers(response.headers)
      headers.set('access-control-allow-origin', '*')
      return new Response(response.body, { status: response.status, headers })
    })

    Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(onMenuCommand)))
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
  terminalService.dispose()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => stateService.flush())
