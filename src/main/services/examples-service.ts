import { ipcMain } from 'electron'
import type { BuildFinished, NewProjectRequest, OpenProject } from '../../shared/ipc'
import type { BuildService } from './build-service'
import { existingSampleIds, forkSample, readSampleSource, samplesDir } from './examples'
import { evaluateProjectConfig, resolveNodeBinary } from './project'
import type { ProjectService } from './project-service'
import type { ToolchainService } from './toolchain-service'

/**
 * Electron-facing glue for the Examples browser (Spec 12): registers the
 * `examples:*` IPC handlers around the pure disk logic in `examples.ts`,
 * reusing `ProjectService` (to open a forked project the normal way) and
 * `BuildService` (to build/run a sample in place via `startExternal`).
 */
export class ExamplesService {
  constructor(
    private readonly toolchainService: ToolchainService,
    private readonly projectService: ProjectService,
    private readonly buildService: BuildService
  ) {}

  registerIpc(): void {
    ipcMain.handle('examples:existingIds', (_e, req: { ids: string[] }) => this.existingIds(req.ids))
    ipcMain.handle('examples:read', (_e, req: { id: string }) => this.read(req.id))
    ipcMain.handle('examples:tryIt', (_e, req: { id: string }) => this.tryIt(req.id))
    ipcMain.handle(
      'examples:fork',
      (_e, req: { id: string; request: NewProjectRequest; copyEntireContent?: boolean }) =>
        this.fork(req.id, req.request, req.copyEntireContent ?? false)
    )
  }

  private msxglPath(): string {
    const path = this.toolchainService.resolveMsxglPath()
    if (!path) throw new Error('MSXgl is not configured — set it up in Settings first.')
    return path
  }

  private nodeBinary(msxglPath: string): string {
    const node = resolveNodeBinary(msxglPath, this.toolchainService.nodeOverride())
    if (!node) throw new Error('No Node executable found in the configured MSXgl checkout.')
    return node
  }

  private existingIds(ids: string[]): string[] {
    const path = this.toolchainService.resolveMsxglPath()
    return path ? existingSampleIds(path, ids) : []
  }

  private read(id: string): string {
    return readSampleSource(this.msxglPath(), id)
  }

  tryIt(id: string): Promise<BuildFinished> {
    const msxglPath = this.msxglPath()
    return this.buildService.startExternal(samplesDir(msxglPath), [`projname=${id}`, 'run'])
  }

  async fork(
    id: string,
    request: NewProjectRequest,
    copyEntireContent: boolean
  ): Promise<{ opened: OpenProject; notices: string[] }> {
    const msxglPath = this.msxglPath()
    const node = this.nodeBinary(msxglPath)
    const globals = await evaluateProjectConfig(msxglPath, samplesDir(msxglPath), node, `${id}.js`)
    const { opened, notices } = forkSample(msxglPath, id, request, globals, copyEntireContent)
    return { opened: await this.projectService.openCreated(opened), notices }
  }
}
