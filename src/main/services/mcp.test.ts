/**
 * The MCP tools, called the way an agent calls them: through a real MCP client,
 * over an in-memory transport, against stub app services.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { beforeEach, describe, expect, it } from 'vitest'
import type { BuildFinished, OpenProject } from '../../shared/ipc'
import { normalizeMap } from '../../shared/msx/map'
import { serializeResource } from '../../shared/msx/resource'
import { defaultProject } from '../../shared/msxproj'
import { buildReport, createMcpServer, projectPath, type McpDeps, type TabInfo } from './mcp'

let files: Record<string, string>
let tabs: TabInfo[]
let calls: string[]
let deps: McpDeps

const PROJECT: OpenProject = { root: '/home/me/game', projectFile: 'game.msxproj', project: defaultProject('game'), imported: false } as OpenProject

const BUILT: BuildFinished = {
  ok: false,
  code: 1,
  artifacts: [],
  problems: [{ id: 'p0', severity: 'error', message: "undefined symbol 'g_Foo'", file: 'main.c', line: 12 }],
  message: 'Compile error'
}

beforeEach(() => {
  files = { 'res/level.map.json': serializeResource({ kind: 'map', doc: normalizeMap({ tileset: 'res/t.tiles.json' }) }) }
  tabs = [{ path: 'res/level.map.json', title: 'level.map.json', dirty: false, active: true }]
  calls = []
  deps = {
    project: () => PROJECT,
    listResources: () => [{ path: 'res/level.map.json', kind: 'map', out: 'content/level.h' }],
    exportOne: (path) => ({ kind: 'resource', input: path, out: 'content/level.h', status: 'converted' }) as never,
    exportAll: async () => [],
    build: async (command) => {
      calls.push(`build:${command}`)
      return BUILT
    },
    buildRunning: () => false,
    buildOutput: () => ['> node build.js', 'main.c:12: error 20: undefined symbol'],
    lastBuild: () => BUILT,
    listDir: async () => [{ name: 'res', path: 'res', isDirectory: true, absolutePath: '/x/res' }] as never,
    readFile: async (path) => {
      if (!(path in files)) throw new Error(`ENOENT ${path}`)
      return files[path]
    },
    writeFile: async (path, content) => {
      files[path] = content
    },
    exists: async (path) => path in files,
    renderer: (async (method: string, params: unknown) => {
      calls.push(`renderer:${method}:${JSON.stringify(params ?? null)}`)
      if (method === 'tabs') return tabs
      if (method === 'preview') return 'data:image/png;base64,iVBORw0KGgo='
      if (method === 'createResource') return 'res/forest.map.json'
      if (method === 'saveAll') return ['res/level.map.json']
      return undefined
    }) as McpDeps['renderer'],
    emulatorStart: async ({ artifact }) => ({ running: true, machine: 'C-BIOS_MSX1_EU', media: artifact ?? 'out/game.rom' }),
    emulatorCommand: async (tcl) => {
      calls.push(`tcl:${tcl}`)
      return tcl.includes('vpeek') ? '1 2 3 255' : ''
    },
    emulatorStatus: () => ({ running: false, machine: null, media: null }),
    emulatorStop: () => calls.push('stop'),
    emulatorScreenshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    emulatorLog: () => ['warning: something'],
    sleep: async () => undefined
  }
})

async function connect(): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await createMcpServer(deps, '0.0.0-test').connect(serverSide)
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(clientSide)
  return client
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await (await connect()).callTool({ name, arguments: args })) as CallToolResult
}

const textOf = (result: CallToolResult): string => result.content.map((part) => ('text' in part ? part.text : '')).join('')

describe('the MSXDEVStudio MCP tools', () => {
  it('offers the four groups the user asked for', async () => {
    const { tools } = await (await connect()).listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        'build', 'create_resource', 'emulator_keys', 'emulator_peek', 'emulator_screenshot', 'emulator_start', 'emulator_status',
        'emulator_stop', 'emulator_tcl', 'emulator_type', 'export_resources', 'get_build_output', 'get_problems', 'list_files',
        'list_resources', 'list_tabs', 'open_file', 'preview_resource', 'project_info', 'read_file', 'read_resource',
        'save_all', 'show_message', 'write_file', 'write_resource'
      ].sort()
    )
  })

  it('says plainly when no project is open', async () => {
    deps.project = () => null
    const result = await call('project_info')
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('No project is open')
  })

  it('reports the project with its open tabs', async () => {
    const info = JSON.parse(textOf(await call('project_info')))
    expect(info).toMatchObject({ name: 'game', machine: '1', target: 'ROM_32K', tabs: [{ path: 'res/level.map.json', active: true }] })
  })

  it('builds the way the toolbar does and reports problems first', async () => {
    const result = await call('build', { command: 'rebuild' })
    expect(calls).toContain('build:rebuild')
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain("error: main.c:12: undefined symbol 'g_Foo'")
  })

  it('reads a resource normalized, and writes one through the parser', async () => {
    const read = JSON.parse(textOf(await call('read_resource', { path: 'res/level.map.json' })))
    expect(read.kind).toBe('map')
    expect(read.doc.layers[0].name).toBe('background')
    // A bare map: everything missing is filled in on the way to disk.
    const wrote = JSON.parse(textOf(await call('write_resource', { path: 'res/new.map.json', doc: { tileset: 'res/t.tiles.json', width: 4, height: 2 } })))
    expect(wrote).toMatchObject({ wrote: 'res/new.map.json', kind: 'map' })
    expect(JSON.parse(files['res/new.map.json'])).toMatchObject({ version: 1, width: 4, height: 2, layers: [{ name: 'background' }] })
  })

  it('refuses to write over an editor holding unsaved changes', async () => {
    tabs[0].dirty = true
    const result = await call('write_resource', { path: 'res/level.map.json', doc: {} })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('unsaved changes')
    expect((await call('write_file', { path: 'res/level.map.json', content: 'x' })).isError).toBe(true)
  })

  it('refuses a resource name of no known kind, and paths that leave the project', async () => {
    expect(textOf(await call('write_resource', { path: 'res/thing.json', doc: {} }))).toContain('not a resource name')
    expect(textOf(await call('read_file', { path: '../secret.txt' }))).toContain('not a path inside the project')
    expect(() => projectPath('/etc/passwd')).toThrow()
    expect(() => projectPath('C:/x')).toThrow()
    expect(projectPath('./src\\main.c')).toBe('src/main.c')
  })

  it('returns pictures as images: a resource preview and an emulator screenshot', async () => {
    const preview = await call('preview_resource', { path: 'res/level.map.json' })
    expect(preview.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' })
    const shot = await call('emulator_screenshot')
    expect(shot.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64') })
  })

  it('reads VRAM as a hex dump, and holds keys then lets go', async () => {
    expect(textOf(await call('emulator_peek', { address: 0x1800, length: 4 }))).toBe('01800: 01 02 03 ff')
    await call('emulator_keys', { keys: ['space', 'RIGHT'], ms: 100 })
    expect(calls.filter((c) => c.startsWith('tcl:keymatrix'))).toEqual([
      'tcl:keymatrixdown 8 1',
      'tcl:keymatrixdown 8 128',
      'tcl:keymatrixup 8 1',
      'tcl:keymatrixup 8 128'
    ])
    expect(textOf(await call('emulator_keys', { keys: ['HYPERSPACE'] }))).toContain('Unknown key')
  })

  it('types text literally, braces escaped', async () => {
    await call('emulator_type', { text: 'RUN {x}' })
    expect(calls).toContain('tcl:type {RUN \\{x\\}}')
  })

  it('drives the window: open, save all, show a message, create a resource', async () => {
    expect(textOf(await call('open_file', { path: 'res/level.map.json' }))).toBe('Opened res/level.map.json.')
    expect((await call('open_file', { path: 'res/missing.c' })).isError).toBe(true)
    expect(textOf(await call('save_all'))).toBe('Saved res/level.map.json.')
    await call('show_message', { text: 'Built it.', level: 'info' })
    expect(calls).toContain('renderer:notify:{"text":"Built it.","level":"info"}')
    expect(textOf(await call('create_resource', { kind: 'map', name: 'forest' }))).toContain('res/forest.map.json')
  })
})

describe('the build report', () => {
  it('leads with the verdict and the problems, and ends with the output’s tail', () => {
    const report = buildReport({ ...BUILT, ok: true, problems: [], artifacts: [{ path: 'out/game.rom', size: 32768 }], message: null }, ['a', 'b', 'c'], 2)
    expect(report.split('\n')).toEqual(['Build succeeded.', 'Artifacts: out/game.rom (32768 bytes)', 'Problems: 0 (0 errors)', '', 'Last 2 lines of output:', 'b', 'c'])
  })
})
