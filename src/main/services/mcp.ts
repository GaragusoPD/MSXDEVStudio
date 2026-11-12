/**
 * The MCP tools MSXDEVStudio offers an agent (Spec 17): the same project, the
 * same build, the same resource logic and the same window the user has open —
 * not a second copy of any of it.
 *
 * Everything here goes through `McpDeps`, which `mcp-service.ts` fills with the
 * running app's services and a bridge to the renderer, so the tools are
 * testable with plain stubs and never touch Electron.
 *
 * Four groups, as the user asked for them:
 * - **project & build** — `project_info`, `list_resources`, `export_resources`,
 *   `build`, `get_build_output`, `get_problems`, `list_files`, `read_file`, `write_file`;
 * - **resources** — `read_resource`, `write_resource`, `create_resource`, `preview_resource`;
 * - **run & inspect** — `emulator_start`, `emulator_screenshot`, `emulator_peek`,
 *   `emulator_keys`, `emulator_type`, `emulator_tcl`, `emulator_status`, `emulator_stop`;
 * - **the window** — `list_tabs`, `open_file`, `save_all`, `show_message`.
 *
 * Writes never go around an editor holding unsaved changes: the file would be
 * overwritten under it, or its unsaved work would overwrite the agent's. Such a
 * write is refused with a message saying so.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { BuildCommand, BuildFinished, ConversionResult, FsEntry, OpenProject, ResourceEntry } from '../../shared/ipc'
import {
  parseResource,
  RESOURCE_SUFFIXES,
  resourceKindOf,
  serializeResource,
  validateResource,
  type ResourceKind
} from '../../shared/msx/resource'
import { tclNumbers, peekCommand, matrixKey, MATRIX_KEYS, type EmulatorStatus } from './emulator'

/** One open editor tab, as the renderer reports it. */
export interface TabInfo {
  path: string
  title: string
  dirty: boolean
  active: boolean
}

/** What the renderer can be asked to do — see `renderer/src/mcp-bridge.ts`. */
export interface RendererCalls {
  tabs: { params: void; result: TabInfo[] }
  open: { params: { path: string }; result: void }
  saveAll: { params: void; result: string[] }
  notify: { params: { text: string; level: 'info' | 'warning' | 'error' }; result: void }
  /** A data: URL of the resource drawn as the Resources panel draws it, or null. */
  preview: { params: { path: string }; result: string | null }
  createResource: { params: { kind: ResourceKind; name: string }; result: string }
}
export type RendererMethod = keyof RendererCalls

export interface McpDeps {
  project(): OpenProject | null
  listResources(): ResourceEntry[]
  exportOne(path: string, force: boolean): ConversionResult
  exportAll(force: boolean): Promise<ConversionResult[]>
  build(command: BuildCommand): Promise<BuildFinished>
  buildRunning(): boolean
  /** The last build's output, newest last. */
  buildOutput(): string[]
  lastBuild(): BuildFinished | null
  listDir(path: string): Promise<FsEntry[]>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  exists(path: string): Promise<boolean>
  renderer<M extends RendererMethod>(method: M, params: RendererCalls[M]['params']): Promise<RendererCalls[M]['result']>
  emulatorStart(options: { artifact?: string }): Promise<EmulatorStatus>
  emulatorCommand(tcl: string, timeoutMs?: number): Promise<string>
  emulatorStatus(): EmulatorStatus
  emulatorStop(): void
  /** Takes a screenshot and returns the PNG bytes. */
  emulatorScreenshot(): Promise<Buffer>
  emulatorLog(): string[]
  /** For `emulator_keys`: waits between press and release. */
  sleep(ms: number): Promise<void>
}

const RESOURCE_KINDS = Object.keys(RESOURCE_SUFFIXES) as [ResourceKind, ...ResourceKind[]]

const text = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
})

const failure = (message: string): CallToolResult => ({ content: [{ type: 'text', text: message }], isError: true })

/** Runs a handler, turning a thrown error into a tool error the agent can read. */
async function guarded(run: () => Promise<CallToolResult> | CallToolResult): Promise<CallToolResult> {
  try {
    return await run()
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error))
  }
}

/** A project-relative path, refused when it tries to leave the project. */
export function projectPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`"${path}" is not a path inside the project — use one relative to its root, like res/level.map.json`)
  }
  return normalized
}

/** The BuildFinished an agent wants to read: the problems first, the output's tail after. */
export function buildReport(result: BuildFinished, output: readonly string[], tail = 40): string {
  const errors = result.problems.filter((problem) => problem.severity === 'error')
  const lines = [
    result.ok ? 'Build succeeded.' : `Build failed${result.message ? `: ${result.message}` : '.'}`,
    ...(result.artifacts.length ? [`Artifacts: ${result.artifacts.map((a) => `${a.path} (${a.size} bytes)`).join(', ')}`] : []),
    `Problems: ${result.problems.length} (${errors.length} error${errors.length === 1 ? '' : 's'})`,
    ...result.problems.map((p) => `  ${p.severity}: ${p.file ? `${p.file}${p.line ? `:${p.line}` : ''}: ` : ''}${p.message}`),
    '',
    `Last ${Math.min(tail, output.length)} lines of output:`,
    ...output.slice(-tail)
  ]
  return lines.join('\n')
}

/** Refuses when an editor holds unsaved changes to `path`. */
async function assertNotDirty(deps: McpDeps, path: string): Promise<void> {
  const tab = (await deps.renderer('tabs', undefined)).find((candidate) => candidate.path === path)
  if (tab?.dirty) {
    throw new Error(
      `${path} is open in MSXDEVStudio with unsaved changes. Ask the user to save or close it first ` +
        '(or call save_all), so neither copy overwrites the other.'
    )
  }
}

export function createMcpServer(deps: McpDeps, version: string): McpServer {
  const server = new McpServer(
    { name: 'msxdevstudio', version },
    {
      instructions:
        'MSXDEVStudio is an IDE for MSX games written in C with MSXgl. These tools act on the project open in it, ' +
        'in the window the user is looking at. Resources (tiles, sprites, maps, worlds, music…) are JSON files under res/ ' +
        'that export to C headers; read_resource/write_resource go through the IDE\'s own parser and validation. ' +
        'build runs exactly what the Build button runs. emulator_* drive an openMSX you can inspect: take a screenshot ' +
        'or read VRAM rather than guessing what the game shows. The project\'s CLAUDE.md/AGENTS.md documents the ' +
        'generated C APIs.'
    }
  )

  const requireProject = (): OpenProject => {
    const open = deps.project()
    if (!open) throw new Error('No project is open in MSXDEVStudio. Ask the user to open one.')
    return open
  }

  // ── Project & build ────────────────────────────────────────────────────────

  server.registerTool(
    'project_info',
    {
      title: 'Project info',
      description: 'The project open in MSXDEVStudio: where it is, its machine and target, build state, and the open editor tabs.',
      annotations: { readOnlyHint: true }
    },
    () =>
      guarded(async () => {
        const open = requireProject()
        const tabs = await deps.renderer('tabs', undefined).catch(() => [] as TabInfo[])
        const last = deps.lastBuild()
        return text({
          root: open.root,
          projectFile: open.projectFile,
          name: open.project.name,
          machine: open.project.machine,
          target: open.project.target,
          libModules: open.project.libModules,
          projModules: open.project.projModules,
          emulator: open.project.emulator.preferred,
          building: deps.buildRunning(),
          lastBuild: last ? { ok: last.ok, problems: last.problems.length, artifacts: last.artifacts.map((a) => a.path) } : null,
          tabs,
          emulatorSession: deps.emulatorStatus()
        })
      })
  )

  server.registerTool(
    'list_resources',
    {
      title: 'List resources',
      description: 'Every editor resource in the project (tilesets, sprites, maps, worlds, music…), with its kind and the header it exports to.',
      inputSchema: { kind: z.enum(RESOURCE_KINDS).optional().describe('Only this kind') },
      annotations: { readOnlyHint: true }
    },
    ({ kind }) =>
      guarded(() => {
        requireProject()
        return text(deps.listResources().filter((entry) => !kind || entry.kind === kind))
      })
  )

  server.registerTool(
    'export_resources',
    {
      title: 'Export resources',
      description:
        'Exports resources to their C headers (a build does this too). One path, or every resource when omitted. Up-to-date ones are skipped unless force is set.',
      inputSchema: {
        path: z.string().optional().describe('A resource, e.g. res/level.map.json; omit for all'),
        force: z.boolean().optional()
      }
    },
    ({ path, force }) =>
      guarded(async () => {
        requireProject()
        const results = path ? [deps.exportOne(projectPath(path), force === true)] : await deps.exportAll(force === true)
        const failed = results.filter((result) => result.status === 'failed')
        return {
          content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
          ...(failed.length ? { isError: true } : {})
        }
      })
  )

  server.registerTool(
    'build',
    {
      title: 'Build',
      description:
        'Runs what the toolbar runs — export resources, then MSXgl: build, rebuild, clean, or run (build and launch the emulator the project prefers). ' +
        'Waits for it to finish and returns the result, the problems and the tail of the output. The user sees it all in the IDE.',
      inputSchema: { command: z.enum(['build', 'rebuild', 'clean', 'run']).default('build') }
    },
    ({ command }) =>
      guarded(async () => {
        requireProject()
        if (deps.buildRunning()) throw new Error('A build is already running — wait for it, then ask again.')
        const result = await deps.build(command)
        return { content: [{ type: 'text', text: buildReport(result, deps.buildOutput()) }], ...(result.ok ? {} : { isError: true }) }
      })
  )

  server.registerTool(
    'get_build_output',
    {
      title: 'Build output',
      description: 'The output of the last build (or the one running), newest last.',
      inputSchema: { lines: z.number().int().min(1).max(2000).default(200) },
      annotations: { readOnlyHint: true }
    },
    ({ lines }) => guarded(() => text(deps.buildOutput().slice(-lines).join('\n') || '(no build output yet)'))
  )

  server.registerTool(
    'get_problems',
    {
      title: 'Problems',
      description: 'The errors and warnings the last build reported, with file and line.',
      annotations: { readOnlyHint: true }
    },
    () =>
      guarded(() => {
        const last = deps.lastBuild()
        return text(last ? { ok: last.ok, message: last.message, problems: last.problems } : 'No build has run since the IDE started.')
      })
  )

  server.registerTool(
    'list_files',
    {
      title: 'List files',
      description: 'The entries of a folder in the project (its root when omitted).',
      inputSchema: { path: z.string().optional() },
      annotations: { readOnlyHint: true }
    },
    ({ path }) =>
      guarded(async () => {
        requireProject()
        const entries = await deps.listDir(path ? projectPath(path) : '')
        return text(entries.map((entry) => `${entry.isDirectory ? 'dir ' : 'file'} ${entry.path}`).join('\n') || '(empty)')
      })
  )

  server.registerTool(
    'read_file',
    {
      title: 'Read file',
      description: 'A text file in the project, as it is on disk.',
      inputSchema: { path: z.string() },
      annotations: { readOnlyHint: true }
    },
    ({ path }) =>
      guarded(async () => {
        requireProject()
        return text(await deps.readFile(projectPath(path)))
      })
  )

  server.registerTool(
    'write_file',
    {
      title: 'Write file',
      description:
        'Writes a text file in the project — C source, a header, a README. An editor showing it reloads. Refused when it is open with unsaved changes. ' +
        'For a resource (*.tiles.json, *.map.json…) use write_resource, which validates it.',
      inputSchema: { path: z.string(), content: z.string() }
    },
    ({ path, content }) =>
      guarded(async () => {
        requireProject()
        const target = projectPath(path)
        await assertNotDirty(deps, target)
        await deps.writeFile(target, content)
        return text(`Wrote ${target} (${content.length} characters).`)
      })
  )

  // ── Resources ──────────────────────────────────────────────────────────────

  server.registerTool(
    'read_resource',
    {
      title: 'Read resource',
      description:
        'A resource as the IDE reads it: normalized JSON (every field present, old files upgraded), its kind, and what its export would refuse.',
      inputSchema: { path: z.string().describe('e.g. res/level.map.json') },
      annotations: { readOnlyHint: true }
    },
    ({ path }) =>
      guarded(async () => {
        requireProject()
        const target = projectPath(path)
        const resource = parseResource(target, await deps.readFile(target))
        // A world's problems need its rooms, which only the export reads — say so rather than report them all missing.
        const problems = resource.kind === 'world' ? null : validateResource(resource)
        return text({
          kind: resource.kind,
          problems: problems ?? 'run export_resources on it to check the rooms',
          doc: JSON.parse(serializeResource(resource))
        })
      })
  )

  server.registerTool(
    'write_resource',
    {
      title: 'Write resource',
      description:
        'Writes a resource file through the IDE\'s own parser: the JSON is normalized (missing fields filled in, junk dropped) before it is saved, ' +
        'and what its export would refuse comes back. Creates the file when it does not exist; the kind comes from the name (*.map.json, *.tiles.json, …). ' +
        'An open editor reloads it. Refused when it is open with unsaved changes. Read it first with read_resource and change what you need.',
      inputSchema: {
        path: z.string().describe('e.g. res/level.map.json'),
        doc: z.record(z.string(), z.unknown()).describe('The resource JSON')
      }
    },
    ({ path, doc }) =>
      guarded(async () => {
        requireProject()
        const target = projectPath(path)
        const kind = resourceKindOf(target)
        if (!kind) throw new Error(`${target} is not a resource name — it must end in one of ${Object.values(RESOURCE_SUFFIXES).join(', ')}`)
        await assertNotDirty(deps, target)
        const resource = parseResource(target, JSON.stringify(doc))
        await deps.writeFile(target, serializeResource(resource))
        const problems = resource.kind === 'world' ? [] : validateResource(resource)
        return text({ wrote: target, kind, problems })
      })
  )

  server.registerTool(
    'create_resource',
    {
      title: 'Create resource',
      description:
        'Makes a new, empty resource the way the Resources panel does — named after `name`, with an export block — and opens it in an editor tab.',
      inputSchema: {
        kind: z.enum(RESOURCE_KINDS),
        name: z.string().describe('A file stem, e.g. "forest" → res/forest.map.json')
      }
    },
    ({ kind, name }) =>
      guarded(async () => {
        requireProject()
        const path = await deps.renderer('createResource', { kind, name })
        return text(`Created ${path} and opened it.`)
      })
  )

  server.registerTool(
    'preview_resource',
    {
      title: 'Preview resource',
      description: 'A picture of a resource as the Resources panel draws it — a tileset, a map, a sprite sheet, a screen.',
      inputSchema: { path: z.string() },
      annotations: { readOnlyHint: true }
    },
    ({ path }) =>
      guarded(async () => {
        requireProject()
        const url = await deps.renderer('preview', { path: projectPath(path) })
        const match = url ? /^data:(image\/[a-z]+);base64,(.*)$/.exec(url) : null
        if (!match) return failure(`No picture for ${path} — it may be empty, or a kind without one (sound, music, world).`)
        return { content: [{ type: 'image', data: match[2], mimeType: match[1] }] }
      })
  )

  // ── Run & inspect ──────────────────────────────────────────────────────────

  server.registerTool(
    'emulator_start',
    {
      title: 'Start emulator',
      description:
        'Boots the last built ROM (or disk) in an openMSX the agent can inspect, on the project\'s machine. Build first. ' +
        'C-BIOS takes about 10 seconds before the cartridge runs — wait before screenshots.',
      inputSchema: { artifact: z.string().optional().describe('A built file, e.g. out/game.rom; the project\'s own when omitted') }
    },
    ({ artifact }) =>
      guarded(async () => {
        requireProject()
        const status = await deps.emulatorStart({ artifact: artifact ? projectPath(artifact) : undefined })
        return text({ ...status, note: 'Booting. C-BIOS needs ~10 s before the game runs.' })
      })
  )

  server.registerTool(
    'emulator_screenshot',
    {
      title: 'Emulator screenshot',
      description: 'What the emulated MSX shows right now.',
      annotations: { readOnlyHint: true }
    },
    () =>
      guarded(async () => ({
        content: [{ type: 'image', data: (await deps.emulatorScreenshot()).toString('base64'), mimeType: 'image/png' }]
      }))
  )

  server.registerTool(
    'emulator_peek',
    {
      title: 'Read VRAM or memory',
      description:
        'Reads bytes from the running MSX: VRAM (vpeek — e.g. SCREEN 2 name table at 0x1800, patterns at 0x0000, colours at 0x2000) or the Z80 memory map (peek).',
      inputSchema: {
        space: z.enum(['vram', 'memory']).default('vram'),
        address: z.number().int().min(0).max(0x1ffff),
        length: z.number().int().min(1).max(1024).default(16)
      },
      annotations: { readOnlyHint: true }
    },
    ({ space, address, length }) =>
      guarded(async () => {
        const bytes = tclNumbers(await deps.emulatorCommand(peekCommand(space, address, length)))
        const rows: string[] = []
        for (let i = 0; i < bytes.length; i += 16) {
          rows.push(
            `${(address + i).toString(16).padStart(5, '0')}: ${bytes
              .slice(i, i + 16)
              .map((b) => b.toString(16).padStart(2, '0'))
              .join(' ')}`
          )
        }
        return text(rows.join('\n'))
      })
  )

  server.registerTool(
    'emulator_keys',
    {
      title: 'Press keys',
      description: `Holds keys on the MSX keyboard matrix for a while, then releases them — how to move, jump, fire or start a game. Keys: ${Object.keys(MATRIX_KEYS).join(', ')}.`,
      inputSchema: {
        keys: z.array(z.string()).min(1),
        ms: z.number().int().min(20).max(10000).default(200).describe('How long to hold them')
      }
    },
    ({ keys, ms }) =>
      guarded(async () => {
        const matrix = keys.map((key) => {
          const found = matrixKey(key)
          if (!found) throw new Error(`Unknown key "${key}". Known: ${Object.keys(MATRIX_KEYS).join(', ')}`)
          return found
        })
        for (const [row, mask] of matrix) await deps.emulatorCommand(`keymatrixdown ${row} ${mask}`)
        await deps.sleep(ms)
        for (const [row, mask] of matrix) await deps.emulatorCommand(`keymatrixup ${row} ${mask}`)
        return text(`Held ${keys.join(' + ')} for ${ms} ms.`)
      })
  )

  server.registerTool(
    'emulator_type',
    {
      title: 'Type text',
      description: 'Types text on the MSX keyboard, as a user would (openMSX\'s `type`).',
      inputSchema: { text: z.string().min(1) }
    },
    ({ text: typed }) =>
      guarded(async () => {
        // Tcl braces keep the text literal; a brace inside it is the one thing to escape.
        await deps.emulatorCommand(`type {${typed.replace(/[{}\\]/g, (c) => `\\${c}`)}}`)
        return text(`Typed ${typed.length} characters.`)
      })
  )

  server.registerTool(
    'emulator_tcl',
    {
      title: 'openMSX command',
      description:
        'Runs any openMSX console (Tcl) command and returns its answer — e.g. "reg pc", "debug read_block memory 0xC000 16", "set throttle off", "reset". ' +
        'See https://openmsx.org/manual/commands.html.',
      inputSchema: { command: z.string().min(1), timeoutMs: z.number().int().min(100).max(60000).optional() }
    },
    ({ command, timeoutMs }) => guarded(async () => text((await deps.emulatorCommand(command, timeoutMs)) || '(no output)'))
  )

  server.registerTool(
    'emulator_status',
    {
      title: 'Emulator status',
      description: 'Whether the inspectable openMSX is running, on what machine and media, and its recent log lines.',
      annotations: { readOnlyHint: true }
    },
    () => guarded(() => text({ ...deps.emulatorStatus(), log: deps.emulatorLog().slice(-15) }))
  )

  server.registerTool(
    'emulator_stop',
    { title: 'Stop emulator', description: 'Closes the inspectable openMSX.' },
    () =>
      guarded(() => {
        deps.emulatorStop()
        return text('Stopped.')
      })
  )

  // ── The window ─────────────────────────────────────────────────────────────

  server.registerTool(
    'list_tabs',
    {
      title: 'Open tabs',
      description: 'The editor tabs open in MSXDEVStudio, which one is active, and which have unsaved changes.',
      annotations: { readOnlyHint: true }
    },
    () => guarded(async () => text(await deps.renderer('tabs', undefined)))
  )

  server.registerTool(
    'open_file',
    {
      title: 'Open file',
      description: 'Opens a project file in MSXDEVStudio — in the editor for its kind (the map editor for a map, and so on) — and shows it to the user.',
      inputSchema: { path: z.string() }
    },
    ({ path }) =>
      guarded(async () => {
        requireProject()
        const target = projectPath(path)
        if (!(await deps.exists(target))) throw new Error(`${target} does not exist.`)
        await deps.renderer('open', { path: target })
        return text(`Opened ${target}.`)
      })
  )

  server.registerTool(
    'save_all',
    {
      title: 'Save all',
      description: 'Saves every editor tab with unsaved changes, as File ▸ Save All does.'
    },
    () =>
      guarded(async () => {
        const saved = await deps.renderer('saveAll', undefined)
        return text(saved.length ? `Saved ${saved.join(', ')}.` : 'Nothing was unsaved.')
      })
  )

  server.registerTool(
    'show_message',
    {
      title: 'Show message',
      description: 'Shows a short message to the user in MSXDEVStudio — what you did, or what you need from them.',
      inputSchema: { text: z.string().min(1).max(500), level: z.enum(['info', 'warning', 'error']).default('info') }
    },
    ({ text: message, level }) =>
      guarded(async () => {
        await deps.renderer('notify', { text: message, level })
        return text('Shown.')
      })
  )

  return server
}
