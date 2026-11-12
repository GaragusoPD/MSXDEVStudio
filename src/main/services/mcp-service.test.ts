/**
 * The MCP server over real HTTP on localhost, with a real MCP client — what
 * Claude Code does — plus the guards a browser would hit.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppState, McpRendererRequest, McpRendererResponse } from '../../shared/ipc'
import { defaultProject } from '../../shared/msxproj'
import { bootControlled, McpService, projectMcpConfig, requestAllowed, type McpServiceDeps } from './mcp-service'

const services: McpService[] = []
let root: string | null = null

afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose()
  if (root) rmSync(root, { recursive: true, force: true })
  root = null
})

/** A free port, found by asking the OS for one and letting it go. */
async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

/** An McpService over stubs, with a fake window whose renderer answers the bridge. */
function service(): { mcp: McpService; sent: McpRendererRequest[] } {
  root = mkdtempSync(join(tmpdir(), 'mcp-'))
  let state = { mcp: { enabled: false, port: 47811 } } as AppState
  const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()
  const sent: McpRendererRequest[] = []
  const window = {
    webContents: {
      send: (channel: string, payload: McpRendererRequest) => {
        if (channel !== 'mcp:request') return
        sent.push(payload)
        // The renderer: answers `tabs` with one dirty tab, refuses anything else.
        const response: McpRendererResponse =
          payload.method === 'tabs'
            ? { id: payload.id, ok: true, result: [{ path: 'main.c', title: 'main.c', dirty: true, active: true }] }
            : { id: payload.id, ok: false, error: `no ${payload.method}` }
        setTimeout(() => void handlers.get('mcp:respond')?.(null, response), 1)
      }
    }
  }
  const project = { root, projectFile: 'g.msxproj', project: defaultProject('g'), imported: false }
  const deps = {
    state: { get: () => state, update: (partial: Partial<AppState>) => (state = { ...state, ...partial }) },
    project: { getOpen: () => project },
    resources: { list: () => [], exportOne: () => ({}), exportAll: async () => [] },
    build: { start: async () => ({}), running: false },
    fs: { readDir: async () => [], read: async () => '', write: async () => undefined, stat: async () => null },
    toolchain: { resolveOpenmsxPath: () => null },
    window: () => window,
    version: '0.0.0-test'
  } as unknown as McpServiceDeps
  const mcp = new McpService(deps)
  mcp.registerIpc({ handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => handlers.set(channel, handler) } as never)
  services.push(mcp)
  return { mcp, sent }
}

/** A raw request with whatever headers a test wants — fetch would set Host itself. */
function raw(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end('{}')
  })
}

describe('the MCP server over HTTP', () => {
  it('is off until turned on, then answers an MCP client on localhost', async () => {
    const { mcp, sent } = service()
    await mcp.init()
    const port = await freePort()
    const status = await mcp.configure({ enabled: true, port })
    expect(status).toMatchObject({ enabled: true, running: true, url: `http://127.0.0.1:${port}/mcp`, error: null })

    const client = new Client({ name: 'test', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(status.url)))
    const { tools } = await client.listTools()
    expect(tools.some((tool) => tool.name === 'build')).toBe(true)
    // A tool that needs the window goes through the bridge and comes back.
    const tabs = (await client.callTool({ name: 'list_tabs', arguments: {} })) as CallToolResult
    expect(JSON.parse((tabs.content[0] as { text: string }).text)).toEqual([{ path: 'main.c', title: 'main.c', dirty: true, active: true }])
    expect(sent.map((request) => request.method)).toEqual(['tabs'])
    // A renderer refusal comes back as a tool error with its words.
    const failed = (await client.callTool({ name: 'save_all', arguments: {} })) as CallToolResult
    expect(failed.isError).toBe(true)
    expect((failed.content[0] as { text: string }).text).toContain('no saveAll')
    await client.close()

    expect((await mcp.configure({ enabled: false })).running).toBe(false)
  })

  it('refuses a browser and a rebound host name', async () => {
    const { mcp } = service()
    const port = await freePort()
    await mcp.configure({ enabled: true, port })
    expect(await raw(port, { origin: 'https://evil.example' })).toBe(403)
    expect(await raw(port, { host: `evil.example:${port}` })).toBe(403)
    expect(requestAllowed({ host: `localhost:${port}` }, port)).toBeNull()
    expect(requestAllowed({ host: `127.0.0.1:${port}`, origin: 'null' }, port)).toContain('Browser')
  })

  it('says so when the port is taken, and recovers on another', async () => {
    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const taken = (blocker.address() as AddressInfo).port
    try {
      const { mcp } = service()
      const status = await mcp.configure({ enabled: true, port: taken })
      expect(status.running).toBe(false)
      expect(status.error).toContain(`Port ${taken} is in use`)
      expect((await mcp.configure({ port: await freePort() })).running).toBe(true)
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })

  it('writes the project’s .mcp.json with the URL only, keeping other servers', async () => {
    const { mcp } = service()
    writeFileSync(join(root!, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }))
    await mcp.writeProjectConfig()
    expect(JSON.parse(readFileSync(join(root!, '.mcp.json'), 'utf-8'))).toEqual({
      mcpServers: { other: { command: 'x' }, msxdevstudio: { type: 'http', url: 'http://127.0.0.1:47811/mcp' } }
    })
    expect(JSON.parse(projectMcpConfig('not json', 'http://127.0.0.1:1/mcp'))).toEqual({
      mcpServers: { msxdevstudio: { type: 'http', url: 'http://127.0.0.1:1/mcp' } }
    })
  })
})

describe('booting a controlled openMSX', () => {
  it('turns on a renderer and the power — GL first, plain SDL where GL is missing', async () => {
    const sent: string[] = []
    await bootControlled(async (tcl) => {
      sent.push(tcl)
      if (tcl === 'set renderer SDLGL-PP') throw new Error('no GL')
      return ''
    })
    expect(sent).toEqual(['set renderer SDLGL-PP', 'set renderer SDL', 'set power on'])
  })
})
