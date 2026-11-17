/**
 * The MCP tools, called the way an agent calls them: through a real MCP client,
 * over an in-memory transport, against stub app services.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { beforeEach, describe, expect, it } from 'vitest'
import type { BuildFinished, BuildProblem, ConversionResult, OpenProject } from '../../shared/ipc'
import { normalizeMap } from '../../shared/msx/map'
import { defaultExport, parseResource, serializeResource } from '../../shared/msx/resource'
import { defaultProject } from '../../shared/msxproj'
import { buildReport, createMcpServer, projectPath, type McpDeps, type TabInfo } from './mcp'
import { conversionProblems, inspectResource } from './resources'

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
    // The real thing, over a root with nothing in it: these resources name no other file.
    inspectResource: (path, text) => inspectResource(PROJECT.root, path, text),
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

  it('gives a new resource the export block create_resource would — unless its doc says export: null', async () => {
    const write = async (path: string, doc: Record<string, unknown>): Promise<unknown> => {
      const result = await call('write_resource', { path, doc })
      expect(result.isError, textOf(result)).toBeFalsy()
      return JSON.parse(files[path]).export
    }
    expect(await write('res/forest.map.json', { tileset: 'res/t.tiles.json' })).toEqual(defaultExport('res/forest.map.json'))
    expect(await write('res/notes.map.json', { tileset: 'res/t.tiles.json', export: null })).toBeNull()
    // A file that is already there keeps what the agent sends: here, none.
    expect(JSON.parse(files['res/level.map.json']).export).toBeNull()
    expect(await write('res/level.map.json', { tileset: 'res/t.tiles.json' })).toBeNull()
  })

  describe('keys the editors keep beside the document', () => {
    const LOG = [{ path: 'res/t.tiles.json', mapping: [1, 0], at: 20 }]
    const stamped = (seen: unknown): string => JSON.stringify({ ...JSON.parse(files['res/level.map.json']), tilesetReorderSeen: seen })
    const onDisk = (path: string): Record<string, unknown> => JSON.parse(files[path])
    const read = async (path: string): Promise<Record<string, unknown>> => JSON.parse(textOf(await call('read_resource', { path }))).doc
    const write = async (path: string, doc: Record<string, unknown>): Promise<void> => {
      const result = await call('write_resource', { path, doc })
      expect(result.isError, textOf(result)).toBeFalsy()
    }

    it('a map read and written back keeps its reorder stamp', async () => {
      files['res/level.map.json'] = stamped(20)
      const doc = await read('res/level.map.json')
      expect(doc.tilesetReorderSeen).toBe(20)
      await write('res/level.map.json', doc)
      expect(onDisk('res/level.map.json').tilesetReorderSeen).toBe(20)
    })

    it('a tileset read and written back keeps its reorder log', async () => {
      files['res/t.tiles.json'] = JSON.stringify({ mode: 'sc2', count: 2, reorderLog: LOG })
      const doc = await read('res/t.tiles.json')
      expect(doc.reorderLog).toEqual(LOG)
      await write('res/t.tiles.json', doc)
      expect(onDisk('res/t.tiles.json').reorderLog).toEqual(LOG)
    })

    it('a doc without one keeps the file’s; a doc with one wins; none is ever made up', async () => {
      files['res/level.map.json'] = stamped(20)
      await write('res/level.map.json', { tileset: 'res/t.tiles.json' })
      expect(onDisk('res/level.map.json').tilesetReorderSeen).toBe(20)
      await write('res/level.map.json', { tileset: 'res/t.tiles.json', tilesetReorderSeen: 30 })
      expect(onDisk('res/level.map.json').tilesetReorderSeen).toBe(30)
      await write('res/fresh.map.json', { tileset: 'res/t.tiles.json' })
      expect('tilesetReorderSeen' in onDisk('res/fresh.map.json')).toBe(false)
      expect('tilesetReorderSeen' in (await read('res/fresh.map.json'))).toBe(false)
    })

    it('covers every kind that carries one: maps and bitmap metas their stamp, both tileset kinds their log', async () => {
      const cases: [string, string, unknown, Record<string, unknown>][] = [
        ['res/a.map.json', 'tilesetReorderSeen', 7, { tileset: 'res/t.tiles.json' }],
        ['res/b.meta-btiles.json', 'tilesetReorderSeen', 7, { tileset: 'res/t.btiles.json' }],
        ['res/c.tiles.json', 'reorderLog', LOG, { mode: 'sc2' }],
        ['res/d.btiles.json', 'reorderLog', LOG, {}]
      ]
      for (const [path, key, value, doc] of cases) {
        files[path] = JSON.stringify({ ...doc, [key]: value })
        await write(path, doc)
        expect(onDisk(path)[key], path).toEqual(value)
      }
    })

    it('returns the problems of the text it wrote, stamp included', async () => {
      files['res/level.map.json'] = stamped(20)
      // Problems that say which text they were judged on.
      deps.inspectResource = (path, text) => ({ resource: parseResource(path, text), problems: [text] })
      const result = JSON.parse(textOf(await call('write_resource', { path: 'res/level.map.json', doc: { tileset: 'res/t.tiles.json' } })))
      expect(result.problems).toEqual([files['res/level.map.json']])
    })
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

/** Resources whose export failed, as the build reports them: through the real `conversionProblems`, so its ids are the ones `buildReport` sees. */
const exportFailures = (...inputs: string[]): BuildProblem[] =>
  conversionProblems(
    inputs.map((input): ConversionResult => ({ kind: 'resource', input, out: 'content/x.h', status: 'failed', message: `${input}: no export target` }))
  )
const WARNING: BuildProblem = { id: 'p0', severity: 'warning', message: 'unreferenced function', file: 'main.c', line: 3 }
/** A build MSXgl calls a success, with `problems` before its own warning. */
const succeeded = (problems: BuildProblem[]): BuildFinished => ({
  ok: true,
  code: 0,
  artifacts: [{ path: 'emul/rom/game.rom', size: 32768 }],
  problems: [...problems, { ...WARNING, id: `p${problems.length}` }],
  message: null
})
const firstLine = (report: string): string => report.split('\n')[0]

describe('the build report', () => {
  it('leads with the verdict and the problems, and ends with the output’s tail', () => {
    const report = buildReport({ ...BUILT, ok: true, problems: [], artifacts: [{ path: 'out/game.rom', size: 32768 }], message: null }, ['a', 'b', 'c'], 2)
    expect(report.split('\n')).toEqual(['Build succeeded.', 'Artifacts: out/game.rom (32768 bytes)', 'Problems: 0 (0 errors)', '', 'Last 2 lines of output:', 'b', 'c'])
  })

  it('a success with failed resource exports says so in its first line, not only in the list below', () => {
    expect(firstLine(buildReport(succeeded(exportFailures('res/a.tiles.json')), []))).toBe(
      'Build succeeded, but 1 resource export failed — the ROM may not match res/ (see the problems below).'
    )
    const two = buildReport(succeeded(exportFailures('res/a.tiles.json', 'res/b.map.json')), [])
    expect(firstLine(two)).toBe('Build succeeded, but 2 resource exports failed — the ROM may not match res/ (see the problems below).')
    // ...and the problems follow, each against its resource.
    expect(two).toContain('  error: res/b.map.json: res/b.map.json: no export target')
    // A clean builds nothing, so it claims nothing about what was built.
    expect(firstLine(buildReport(succeeded(exportFailures('res/a.tiles.json')), [], 40, 'clean'))).toBe(
      'Build succeeded, but 1 resource export failed.'
    )
  })

  it('a failure with failed resource exports says both', () => {
    const problems = [...exportFailures('res/a.tiles.json', 'res/b.map.json'), { ...BUILT.problems[0], id: 'p0' }]
    expect(firstLine(buildReport({ ...BUILT, problems }, []))).toBe('Build failed: Compile error; 2 resource exports failed before it.')
    expect(firstLine(buildReport({ ...BUILT, problems, message: null }, []))).toBe('Build failed; 2 resource exports failed before it.')
  })

  it("MSXgl's own problems, errors included, leave the verdict as MSXgl gave it", () => {
    const own: BuildProblem[] = [{ ...BUILT.problems[0], id: 'p1', severity: 'error' }]
    expect(firstLine(buildReport(succeeded(own), []))).toBe('Build succeeded.')
    expect(firstLine(buildReport(BUILT, []))).toBe('Build failed: Compile error')
  })

  it('the build tool is an error when an export failed, though MSXgl succeeded — and only then', async () => {
    let result = succeeded(exportFailures('res/a.tiles.json'))
    deps.build = async () => result
    const failed = await call('build')
    expect(failed.isError).toBe(true)
    expect(firstLine(textOf(failed))).toBe('Build succeeded, but 1 resource export failed — the ROM may not match res/ (see the problems below).')
    result = succeeded([])
    const clean = await call('build')
    expect(clean.isError).toBeFalsy()
    expect(firstLine(textOf(clean))).toBe('Build succeeded.')
    // The command reaches the report: a clean claims nothing about what was built.
    result = succeeded(exportFailures('res/a.tiles.json'))
    expect(firstLine(textOf(await call('build', { command: 'clean' })))).toBe('Build succeeded, but 1 resource export failed.')
  })
})
