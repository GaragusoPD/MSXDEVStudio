import { type BrowserWindow, ipcMain, shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { mkdir, readdir, readFile, rename as renameFs, stat as statFs, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { watch, type FSWatcher } from 'chokidar'
import type { FsChangeEvent, FsEntry, FsStat } from '../../shared/ipc'
import { isIgnoredName, resolveRelativePath } from '../../shared/fs-safety'
import { buildRgArgs, parseRgLine, scanForMatches, type SearchMatch } from '../../shared/search'
import { matchesAnyGlob, splitGlobList } from '../../shared/glob'

const MAX_SEARCH_MATCHES = 500
const MAX_SCAN_FILE_BYTES = 2 * 1024 * 1024 // skip anything bigger in the fallback scanner

/** Cached once per process — a missing `rg` binary shouldn't be re-probed on every search. */
let rgAvailable: boolean | null = null

async function isRipgrepAvailable(): Promise<boolean> {
  if (rgAvailable !== null) return rgAvailable
  rgAvailable = await new Promise<boolean>((resolvePromise) => {
    const probe = spawn('rg', ['--version'])
    probe.on('error', () => resolvePromise(false))
    probe.on('close', (code) => resolvePromise(code === 0))
  })
  return rgAvailable
}

/**
 * Owns the open project's root directory: scoped, path-safe fs access for
 * the explorer/editor, a chokidar watcher pushing `fs:changed`, and search
 * (ripgrep when on PATH, else a recursive fallback scan). Registers all
 * `fs:*` and `search:query` IPC handlers itself (same shape as
 * `ToolchainService`).
 *
 * The root is set by `ProjectService` only (project open/create) — there is
 * no `fs:*` channel to point it somewhere else.
 *
 * Every handler resolves its `path` argument through `resolveRelativePath`
 * before touching disk — the renderer is never trusted to hand back a safe
 * absolute path.
 */
export class FsService {
  private root: string | null = null
  private watcher: FSWatcher | null = null

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  registerIpc(): void {
    ipcMain.handle('fs:readDir', (_e, req: { path: string }) => this.readDir(req.path))
    ipcMain.handle('fs:stat', (_e, req: { path: string }) => this.stat(req.path))
    ipcMain.handle('fs:read', (_e, req: { path: string }) => this.read(req.path))
    ipcMain.handle('fs:write', (_e, req: { path: string; content: string }) => this.write(req.path, req.content))
    ipcMain.handle('fs:readBinary', (_e, req: { path: string }) => this.readBinary(req.path))
    ipcMain.handle('fs:writeBinary', (_e, req: { path: string; content: ArrayBuffer }) =>
      this.writeBinary(req.path, req.content)
    )
    ipcMain.handle('fs:rename', (_e, req: { path: string; newPath: string }) => this.rename(req.path, req.newPath))
    ipcMain.handle('fs:delete', (_e, req: { path: string }) => this.delete(req.path))
    ipcMain.handle('fs:create', (_e, req: { path: string; kind: 'file' | 'directory' }) =>
      this.create(req.path, req.kind)
    )
    ipcMain.handle('fs:reveal', (_e, req: { path: string }) => this.reveal(req.path))
    ipcMain.handle('search:query', (_e, req: { query: string; include?: string; exclude?: string }) =>
      this.search(req.query, req)
    )
  }

  /** Resolves an untrusted relative path to an absolute one, rejecting escapes above `root`. */
  private resolve(relPath: string): string {
    if (!this.root) throw new Error('No project folder is open')
    const safe = resolveRelativePath(relPath)
    if (safe === null) throw new Error(`Path escapes project root: ${relPath}`)
    return safe ? join(this.root, ...safe.split('/')) : this.root
  }

  private toRelative(absPath: string): string {
    if (!this.root) return absPath
    return relative(this.root, absPath).split(/\\/g).join('/')
  }

  async setRoot(path: string): Promise<boolean> {
    if (!existsSync(path) || !statSync(path).isDirectory()) return false
    await this.watcher?.close()
    this.root = path
    this.watcher = watch(path, {
      ignoreInitial: true,
      ignored: (p: string) => p.split(/[\\/]+/).some((segment) => isIgnoredName(segment))
    })
    const knownTypes: FsChangeEvent['type'][] = ['add', 'addDir', 'change', 'unlink', 'unlinkDir']
    this.watcher.on('all', (type, absPath) => {
      if (!knownTypes.includes(type as FsChangeEvent['type'])) return // 'ready'/'raw'/'error' have their own listeners
      const event: FsChangeEvent = { type: type as FsChangeEvent['type'], path: this.toRelative(absPath) }
      this.getWindow()?.webContents.send('fs:changed', event)
    })
    return true
  }

  async readDir(relPath: string): Promise<FsEntry[]> {
    const abs = this.resolve(relPath)
    const base = resolveRelativePath(relPath) ?? ''
    const entries = await readdir(abs, { withFileTypes: true })
    return entries
      .filter((entry) => !isIgnoredName(entry.name))
      .map((entry) => ({
        name: entry.name,
        path: base ? `${base}/${entry.name}` : entry.name,
        isDirectory: entry.isDirectory(),
        absolutePath: join(abs, entry.name)
      }))
      .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))
  }

  async stat(relPath: string): Promise<FsStat | null> {
    try {
      const s = await statFs(this.resolve(relPath))
      return { isDirectory: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs }
    } catch {
      return null
    }
  }

  async read(relPath: string): Promise<string> {
    return readFile(this.resolve(relPath), 'utf-8')
  }

  async write(relPath: string, content: string): Promise<void> {
    await writeFile(this.resolve(relPath), content, 'utf-8')
  }

  /** For binary assets (Spec 10's source images) — `read`/`write` above assume UTF-8 text. */
  async readBinary(relPath: string): Promise<ArrayBuffer> {
    const buffer = await readFile(this.resolve(relPath))
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
  }

  async writeBinary(relPath: string, content: ArrayBuffer): Promise<void> {
    await writeFile(this.resolve(relPath), Buffer.from(content))
  }

  async rename(relPath: string, newRelPath: string): Promise<void> {
    await renameFs(this.resolve(relPath), this.resolve(newRelPath))
  }

  async delete(relPath: string): Promise<void> {
    await shell.trashItem(this.resolve(relPath))
  }

  async create(relPath: string, kind: 'file' | 'directory'): Promise<void> {
    const abs = this.resolve(relPath)
    if (kind === 'directory') await mkdir(abs, { recursive: true })
    else await writeFile(abs, '', { flag: 'wx' })
  }

  private async reveal(relPath: string): Promise<void> {
    shell.showItemInFolder(this.resolve(relPath))
  }

  async search(query: string, opts: { include?: string; exclude?: string }): Promise<SearchMatch[]> {
    if (!this.root || !query) return []
    if (await isRipgrepAvailable()) return this.searchWithRipgrep(query, opts)
    return this.searchFallback(query, opts)
  }

  private searchWithRipgrep(query: string, opts: { include?: string; exclude?: string }): Promise<SearchMatch[]> {
    return new Promise((resolvePromise) => {
      const root = this.root!
      const proc = spawn('rg', buildRgArgs(query, opts), { cwd: root })
      const matches: SearchMatch[] = []
      let buffer = ''
      proc.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8')
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const match = parseRgLine(line)
          if (match) matches.push(match)
        }
        if (matches.length >= MAX_SEARCH_MATCHES) proc.kill()
      })
      const finish = (): void => resolvePromise(matches.slice(0, MAX_SEARCH_MATCHES))
      proc.on('close', finish)
      proc.on('error', finish)
    })
  }

  private async searchFallback(query: string, opts: { include?: string; exclude?: string }): Promise<SearchMatch[]> {
    const root = this.root!
    const include = splitGlobList(opts.include)
    const exclude = splitGlobList(opts.exclude)
    const files: { path: string; content: string }[] = []

    const walk = async (dirRel: string): Promise<void> => {
      if (files.length >= MAX_SEARCH_MATCHES) return
      const entries = await readdir(join(root, dirRel), { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (isIgnoredName(entry.name)) continue
        const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          await walk(rel)
          continue
        }
        if (include.length && !matchesAnyGlob(rel, include)) continue
        if (exclude.length && matchesAnyGlob(rel, exclude)) continue
        const abs = join(root, rel)
        const info = await statFs(abs).catch(() => null)
        if (!info || info.size > MAX_SCAN_FILE_BYTES) continue
        const buffer = await readFile(abs).catch(() => null)
        if (!buffer || buffer.subarray(0, 8000).includes(0)) continue // skip binary-looking files (NUL byte)
        files.push({ path: rel, content: buffer.toString('utf-8') })
      }
    }

    await walk('')
    return scanForMatches(files, query).slice(0, MAX_SEARCH_MATCHES)
  }

  async dispose(): Promise<void> {
    await this.watcher?.close()
  }
}
