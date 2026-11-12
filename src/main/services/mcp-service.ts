/**
 * Spec 17: hosts the MCP server (`mcp.ts`) on localhost, so an agent — Claude
 * Code, Claude Desktop, anything that speaks MCP over HTTP — can act in the
 * running IDE: the project the user has open, the window they are looking at.
 *
 * Streamable HTTP, stateless: every POST gets a fresh `McpServer` and
 * transport, which is all a tool-calling client needs and leaves nothing to
 * clean up between clients.
 *
 * Only this machine can reach it — it binds to 127.0.0.1 — and a web page in a
 * browser cannot either: a request whose Host is not this server's own
 * (DNS rebinding) or that carries an Origin (every browser request does; an
 * MCP client does not) is refused.
 *
 * Things only the renderer knows — the open tabs, which are dirty, how to open
 * an editor, a resource's picture — are asked for over `mcp:request` /
 * `mcp:respond` (`renderer/src/mcp-bridge.ts`).
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { BrowserWindow } from 'electron'
import type { BuildFinished, McpRendererResponse, McpSettings, McpStatus } from '../../shared/ipc'
import type { BuildService } from './build-service'
import { resolveArtifacts, runnableArtifact } from './build'
import { launchArgs, OpenMsxSession, openmsxMachine } from './emulator'
import type { FsService } from './fs-service'
import { createMcpServer, type McpDeps, type RendererCalls, type RendererMethod } from './mcp'
import type { ProjectService } from './project-service'
import type { ResourceService } from './resource-service'
import type { StateService } from './state-service'
import { openmsxSystemDataDir } from './toolchain'
import type { ToolchainService } from './toolchain-service'

/** How long a renderer call may take before the tool gives up on it. */
const RENDERER_TIMEOUT_MS = 15000
/** Lines of build output kept for `get_build_output`. */
const OUTPUT_LINES = 2000

export interface McpServiceDeps {
  state: StateService
  project: ProjectService
  resources: ResourceService
  build: BuildService
  fs: FsService
  toolchain: ToolchainService
  window: () => BrowserWindow | null
  version: string
}

/** The `.mcp.json` entry Claude Code reads — the URL only, so it is safe to commit. */
export function projectMcpConfig(existing: string | null, url: string): string {
  let config: { mcpServers?: Record<string, unknown> } = {}
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as unknown
      if (typeof parsed === 'object' && parsed !== null) config = parsed as typeof config
    } catch {
      // A broken file is replaced rather than merged into.
    }
  }
  config.mcpServers = { ...(config.mcpServers ?? {}), msxdevstudio: { type: 'http', url } }
  return `${JSON.stringify(config, null, 2)}\n`
}

/**
 * The guard in front of every request. `Host` must name this server (a
 * rebinding attack arrives with the attacker's host name); an `Origin` means a
 * browser, which has no business here.
 */
export function requestAllowed(headers: IncomingMessage['headers'], port: number): string | null {
  const host = String(headers.host ?? '').toLowerCase()
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]
  if (!allowed.includes(host)) return `Host "${host}" is not allowed`
  if (headers.origin !== undefined) return 'Browser requests are not allowed'
  return null
}

export class McpService {
  private server: Server | null = null
  private status: McpStatus
  private nextRequest = 1
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  private output: string[] = []
  private last: BuildFinished | null = null
  private readonly emulator = new OpenMsxSession()

  constructor(private readonly deps: McpServiceDeps) {
    const { enabled, port } = this.settings()
    this.status = { enabled, port, running: false, url: urlFor(port), error: null, requests: 0 }
  }

  private settings(): McpSettings {
    const stored = this.deps.state.get().mcp as Partial<McpSettings> | undefined
    return { enabled: stored?.enabled === true, port: Number(stored?.port) || 47811 }
  }

  registerIpc(ipcMain: Electron.IpcMain): void {
    ipcMain.handle('mcp:status', () => this.status)
    ipcMain.handle('mcp:configure', (_e, req: Partial<McpSettings>) => this.configure(req))
    ipcMain.handle('mcp:respond', (_e, res: McpRendererResponse) => this.respond(res))
    ipcMain.handle('mcp:writeProjectConfig', () => this.writeProjectConfig())
  }

  /** Starts the server when the saved settings say so. Called once the window exists. */
  async init(): Promise<void> {
    if (this.settings().enabled) await this.start()
  }

  /**
   * Fed every build event `BuildService` emits (wired in `index.ts`), so the
   * tools see exactly the output and problems the user sees.
   */
  observeBuild(channel: string, payload: unknown): void {
    if (channel === 'build:started') this.output = []
    else if (channel === 'build:output') {
      this.output.push(...(payload as { lines: string[] }).lines)
      if (this.output.length > OUTPUT_LINES) this.output.splice(0, this.output.length - OUTPUT_LINES)
    } else if (channel === 'build:finished') this.last = payload as BuildFinished
  }

  async configure(req: Partial<McpSettings>): Promise<McpStatus> {
    const next = { ...this.settings(), ...req }
    next.port = Math.min(65535, Math.max(1024, Math.round(Number(next.port) || 47811)))
    this.deps.state.update({ mcp: next })
    await this.stop()
    this.status = { ...this.status, enabled: next.enabled, port: next.port, url: urlFor(next.port), error: null }
    if (next.enabled) await this.start()
    else this.publish()
    return this.status
  }

  async writeProjectConfig(): Promise<{ path: string }> {
    const open = this.deps.project.getOpen()
    if (!open) throw new Error('No project is open.')
    const path = join(open.root, '.mcp.json')
    const existing = await readFile(path, 'utf-8').catch(() => null)
    await writeFile(path, projectMcpConfig(existing, this.status.url), 'utf-8')
    return { path }
  }

  async dispose(): Promise<void> {
    this.emulator.stop()
    await this.stop()
  }

  private publish(): void {
    this.deps.window()?.webContents.send('mcp:statusChanged', this.status)
  }

  private async start(): Promise<void> {
    const port = this.status.port
    const server = createServer((req, res) => void this.handle(req, res))
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject)
          resolve()
        })
      })
      this.server = server
      this.status = { ...this.status, running: true, error: null, requests: 0 }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      this.status = {
        ...this.status,
        running: false,
        error: code === 'EADDRINUSE' ? `Port ${port} is in use — pick another.` : String(error)
      }
    }
    this.publish()
  }

  private async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (server) {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    this.status = { ...this.status, running: false }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const refused = requestAllowed(req.headers, this.status.port)
    const path = (req.url ?? '').split('?')[0]
    if (refused) return reply(res, 403, refused)
    if (path !== '/mcp') return reply(res, 404, 'MSXDEVStudio serves MCP at /mcp')
    // Stateless: no server-sent stream to open (GET) and no session to end (DELETE).
    if (req.method !== 'POST') return reply(res, 405, 'POST only', { allow: 'POST' })

    let body: unknown
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      return reply(res, 400, 'The body is not JSON')
    }
    const server = createMcpServer(this.mcpDeps(), this.deps.version)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (error) {
      if (!res.headersSent) reply(res, 500, String(error))
    }
    this.status = { ...this.status, requests: this.status.requests + 1 }
    this.publish()
  }

  // ── The renderer bridge ───────────────────────────────────────────────────

  private callRenderer<M extends RendererMethod>(method: M, params: RendererCalls[M]['params']): Promise<RendererCalls[M]['result']> {
    const window = this.deps.window()
    if (!window) return Promise.reject(new Error('The MSXDEVStudio window is not open.'))
    const id = this.nextRequest++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`The IDE did not answer "${method}" within ${RENDERER_TIMEOUT_MS / 1000} s.`))
      }, RENDERER_TIMEOUT_MS)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      window.webContents.send('mcp:request', { id, method, params })
    })
  }

  private respond(res: McpRendererResponse): void {
    const waiter = this.pending.get(res.id)
    if (!waiter) return
    this.pending.delete(res.id)
    clearTimeout(waiter.timer)
    if (res.ok) waiter.resolve(res.result)
    else waiter.reject(new Error(res.error ?? 'The IDE could not do that.'))
  }

  // ── The tools' view of the app ────────────────────────────────────────────

  private mcpDeps(): McpDeps {
    const { project, resources, build, fs, toolchain } = this.deps
    const root = (): string => {
      const open = project.getOpen()
      if (!open) throw new Error('No project is open.')
      return open.root
    }
    return {
      project: () => project.getOpen(),
      listResources: () => resources.list(),
      exportOne: (path, force) => resources.exportOne(path, force),
      exportAll: (force) => resources.exportAll(force),
      build: (command) => build.start(command),
      buildRunning: () => build.running,
      buildOutput: () => [...this.output],
      lastBuild: () => this.last,
      listDir: (path) => fs.readDir(path),
      readFile: (path) => fs.read(path),
      writeFile: async (path, content) => {
        // `fs.write` stays inside the project; the folder may not exist yet.
        await mkdir(dirname(join(root(), ...path.split('/'))), { recursive: true })
        await fs.write(path, content)
      },
      exists: async (path) => (await fs.stat(path)) !== null,
      renderer: (method, params) => this.callRenderer(method, params),
      emulatorStart: async ({ artifact }) => {
        const open = project.getOpen()
        if (!open) throw new Error('No project is open.')
        const binary = toolchain.resolveOpenmsxPath()
        if (!binary) throw new Error('openMSX is not configured — set it in Toolchain Settings.')
        const media = artifact ?? runnableArtifact(resolveArtifacts(open.root, open.project))?.artifact.path
        if (!media) throw new Error('Nothing built to run — call build first.')
        const share = openmsxSystemDataDir(binary)
        const env = share && !process.env.OPENMSX_SYSTEM_DATA ? { ...process.env, OPENMSX_SYSTEM_DATA: share } : process.env
        this.emulator.start(binary, launchArgs(open.project, join(open.root, ...media.split('/'))), env, {
          machine: openmsxMachine(open.project),
          media
        })
        await bootControlled((tcl) => this.emulator.command(tcl))
        return this.emulator.current
      },
      emulatorCommand: (tcl, timeoutMs) => this.emulator.command(tcl, timeoutMs),
      emulatorStatus: () => this.emulator.current,
      emulatorStop: () => this.emulator.stop(),
      emulatorScreenshot: async () => {
        const file = join(tmpdir(), `msxdevstudio-shot-${process.pid}-${Date.now()}.png`)
        // `-raw`: the MSX picture itself, no OSD, at its own resolution.
        await this.emulator.command(`screenshot -raw ${tclQuote(file)}`)
        try {
          return await readFile(file)
        } finally {
          await rm(file, { force: true })
        }
      },
      emulatorLog: () => [...this.emulator.log],
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    }
  }
}

/**
 * Under `-control stdio` openMSX waits for its controller the way it waits for
 * Catapult: no renderer (so no window and no screenshots) and the power off.
 * Turn both on. The OpenGL renderer first; plain SDL where there is no GL.
 */
export async function bootControlled(command: (tcl: string) => Promise<string>): Promise<void> {
  try {
    await command('set renderer SDLGL-PP')
  } catch {
    await command('set renderer SDL').catch(() => undefined)
  }
  await command('set power on')
}

function urlFor(port: number): string {
  return `http://127.0.0.1:${port}/mcp`
}

/** A Tcl word holding `text` literally — braces, unless the text holds one. */
function tclQuote(text: string): string {
  return /[{}\\]/.test(text) ? `"${text.replace(/["\\$[\]]/g, (c) => `\\${c}`)}"` : `{${text}}`
}

function reply(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers })
  res.end(message)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      // A resource document can be large (a SCREEN 5 picture); a runaway client cannot.
      if (size > 32 * 1024 * 1024) {
        reject(new Error('too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}
