import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ipcMain } from 'electron'
import type { ConversionResult, ResourceEntry } from '../../shared/ipc'
import { parseResource, resourceKindOf } from '../../shared/msx/resource'
import { exportAll, exportResourceFile, findResourceFiles, msximgHelpPath } from './resources'
import type { ProjectService } from './project-service'
import type { ToolchainService } from './toolchain-service'

/**
 * Electron glue for `resources.ts`: registers the `resources:*` channels and
 * is the single entry point BuildService calls before a build. All the disk
 * and MSXimg work lives in the pure module (see `resources.test.ts`).
 */
export class ResourceService {
  constructor(
    private readonly projectService: ProjectService,
    private readonly toolchainService: ToolchainService
  ) {}

  registerIpc(): void {
    ipcMain.handle('resources:list', () => this.list())
    ipcMain.handle('resources:exportOne', (_e, req: { path: string; force?: boolean }) =>
      this.exportOne(req.path, req.force)
    )
    ipcMain.handle('resources:exportAll', (_e, req: { force?: boolean }) => this.exportAll(req?.force))
    ipcMain.handle('resources:msximgHelp', () => {
      const path = this.toolchainService.resolveMsxglPath()
      const help = path ? msximgHelpPath(path) : null
      return help && existsSync(help) ? help : null
    })
  }

  private list(): ResourceEntry[] {
    const open = this.projectService.getOpen()
    if (!open) return []
    return findResourceFiles(open.root).map((path) => {
      let out: string | null = null
      try {
        out = parseResource(path, readFileSync(join(open.root, path), 'utf-8')).doc.export?.out ?? null
      } catch {
        // A malformed resource still belongs in the list — exporting it will report why.
      }
      return { path, kind: resourceKindOf(path) ?? 'tiles', out }
    })
  }

  private exportOne(path: string, force?: boolean): ConversionResult {
    const open = this.projectService.getOpen()
    if (!open) throw new Error('No project is open.')
    return exportResourceFile(open.root, path, { force, configMtimeMs: this.configMtime(open.root, open.projectFile) })
  }

  /** Also the pre-build hook: BuildService awaits this and logs the results. */
  async exportAll(force?: boolean): Promise<ConversionResult[]> {
    const open = this.projectService.getOpen()
    if (!open) return []
    return exportAll(open.root, open.project, {
      force,
      msxglPath: this.toolchainService.resolveMsxglPath(),
      configMtimeMs: this.configMtime(open.root, open.projectFile)
    })
  }

  /** Editing a rule's args changes the `.msxproj`, not the input image — outputs must beat it too. */
  private configMtime(root: string, projectFile: string): number {
    try {
      return statSync(join(root, projectFile)).mtimeMs
    } catch {
      return 0
    }
  }
}
