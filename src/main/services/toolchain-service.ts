import { BrowserWindow, dialog, ipcMain } from 'electron'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MsxglStatus, OpenmsxStatus, ToolchainSettings, ToolchainStatus } from '../../shared/ipc'
import type { StateService } from './state-service'
import {
  MSXGL_GIT_URL,
  MSXGL_SENTINELS,
  MSXGL_ZIP_URL,
  MSXSTUDIO_META_FILE,
  WINDOWS_DEFAULT_OPENMSX_PATH,
  cloneMsxgl,
  downloadZipFile,
  extractZip,
  findOpenmsxOnPath,
  getMsxglVersion,
  pullMsxgl,
  runOpenmsxVersion,
  validateMsxglRoot,
  writeEmulatorConfig
} from './toolchain'

/**
 * Electron-facing glue for the pure logic in `toolchain.ts`: resolves the
 * effective settings (stored → env/PATH detection), broadcasts
 * `toolchain:progress` while downloading/updating, and registers the
 * `toolchain:*` IPC handlers. Not unit-tested directly (same as
 * StateService) — see `toolchain.test.ts` for the logic this wraps.
 */
export class ToolchainService {
  constructor(
    private readonly stateService: StateService,
    private readonly getWindow: () => BrowserWindow | null
  ) {}

  registerIpc(): void {
    ipcMain.handle('toolchain:getStatus', () => this.getStatus())
    ipcMain.handle('toolchain:setPaths', (_e, partial: Partial<ToolchainSettings>) =>
      this.setPaths(partial)
    )
    ipcMain.handle('toolchain:downloadMsxgl', (_e, req: { targetDir?: string }) =>
      this.downloadMsxgl(req?.targetDir)
    )
    ipcMain.handle('toolchain:updateMsxgl', () => this.updateMsxgl())
    ipcMain.handle('toolchain:pickFolder', () => this.pickFolder())
    ipcMain.handle('toolchain:pickFile', () => this.pickFile())
  }

  private emit(phase: 'clone' | 'download' | 'extract' | 'update', message: string, percent: number | null): void {
    this.getWindow()?.webContents.send('toolchain:progress', { phase, message, percent })
  }

  private settings(): ToolchainSettings {
    return this.stateService.get().toolchain
  }

  /** The effective MSXgl root — every service that shells out to MSXgl asks here. */
  resolveMsxglPath(): string | null {
    return this.settings().msxglPath ?? process.env.MSXGL_PATH ?? null
  }

  /** User's Node override, if any; callers fall back to MSXgl's bundled Node. */
  nodeOverride(): string | null {
    return this.settings().nodePath
  }

  /** The effective openMSX executable — settings, then PATH, then the Windows default install. */
  resolveOpenmsxPath(): string | null {
    return (
      this.settings().openmsxPath ??
      findOpenmsxOnPath() ??
      (process.platform === 'win32' && existsSync(WINDOWS_DEFAULT_OPENMSX_PATH)
        ? WINDOWS_DEFAULT_OPENMSX_PATH
        : null)
    )
  }

  private validateMsxgl(path: string | null): MsxglStatus {
    if (!path) {
      return { valid: false, path: null, version: null, missing: [...MSXGL_SENTINELS], isGitRepo: false }
    }
    const { valid, missing } = validateMsxglRoot(path)
    const { isGitRepo, version } = getMsxglVersion(path)
    return { valid, path, version, missing, isGitRepo }
  }

  private async validateOpenmsx(path: string | null): Promise<OpenmsxStatus> {
    if (!path || !existsSync(path)) return { valid: false, path, version: null }
    const version = await runOpenmsxVersion(path)
    return { valid: version !== null, path, version }
  }

  async getStatus(): Promise<ToolchainStatus> {
    const msxgl = this.validateMsxgl(this.resolveMsxglPath())
    const openmsx = await this.validateOpenmsx(this.resolveOpenmsxPath())
    return { msxgl, openmsx, platform: process.platform }
  }

  async setPaths(partial: Partial<ToolchainSettings>): Promise<ToolchainStatus> {
    this.stateService.update({ toolchain: { ...this.settings(), ...partial } })
    const status = await this.getStatus()
    if (status.msxgl.valid && status.openmsx.valid && status.msxgl.path && status.openmsx.path) {
      try {
        writeEmulatorConfig(status.msxgl.path, status.openmsx.path)
      } catch (error) {
        console.error('[ToolchainService] failed to write default_config.js', error)
      }
    }
    return status
  }

  async downloadMsxgl(targetDir?: string): Promise<ToolchainStatus> {
    const dir = targetDir ?? join(homedir(), 'MSXgl')
    try {
      this.emit('clone', 'Cloning MSXgl…', null)
      await cloneMsxgl(MSXGL_GIT_URL, dir, (p) => this.emit('clone', p.message, p.percent))
    } catch (cloneError) {
      console.warn('[ToolchainService] git clone failed, falling back to zip download', cloneError)
      const zipPath = join(tmpdir(), `msxgl-${Date.now()}.zip`)
      try {
        this.emit('download', 'Downloading MSXgl (zip)…', null)
        await downloadZipFile(MSXGL_ZIP_URL, zipPath, (p) => this.emit('download', p.message, p.percent))
        mkdirSync(dir, { recursive: true })
        await extractZip(zipPath, dir, (p) => this.emit('extract', p.message, p.percent))
        writeFileSync(join(dir, MSXSTUDIO_META_FILE), JSON.stringify({ installedAt: new Date().toISOString() }))
      } finally {
        rmSync(zipPath, { force: true })
      }
    }
    return this.setPaths({ msxglPath: dir })
  }

  async updateMsxgl(): Promise<ToolchainStatus> {
    const path = this.settings().msxglPath
    if (path && existsSync(join(path, '.git'))) {
      const result = await pullMsxgl(path, (p) => this.emit('update', p.message, p.percent))
      this.emit(
        'update',
        result.ok ? 'MSXgl updated.' : `Update failed — re-download recommended: ${result.message}`,
        null
      )
    } else if (path) {
      this.emit('update', 'Not a git checkout — re-download recommended.', null)
    }
    return this.getStatus()
  }

  private async pickFolder(): Promise<string | null> {
    const win = this.getWindow()
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  }

  private async pickFile(): Promise<string | null> {
    const win = this.getWindow()
    const options = { properties: ['openFile' as const] }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  }
}
