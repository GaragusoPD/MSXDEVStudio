/**
 * Runs MSXgl's build tool for the open project: one build at a time, output
 * streamed line-by-line to the renderer, diagnostics parsed into problems,
 * artifacts resolved on success, and the emulator hand-off (openMSX via
 * MSXgl's own `run` step, WebMSX via `ArtifactServer` + the browser).
 *
 * Electron-free: everything it needs from the app (the open project, the
 * MSXgl path, the renderer, the browser) is injected, so the whole service —
 * including real builds and kills — is unit-testable. `src/main/index.ts`
 * supplies the real implementations.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type {
  BuildArtifact,
  BuildCommand,
  BuildFinished,
  BuildProblem,
  ConversionResult,
  IpcEvents,
  OpenProject
} from '../../shared/ipc'
import type { MsxProject } from '../../shared/msxproj'
import { resolveNodeBinary } from './project'
import { summarize } from './resources'
import { openmsxSystemDataDir } from './toolchain'
import {
  ArtifactServer,
  buildArgs,
  buildScript,
  buildStamp,
  exitCodeMessage,
  needsFullRebuild,
  parseProblem,
  resolveArtifacts,
  runnableArtifact,
  stripAnsi,
  webmsxUrl,
  writeBuildStamp
} from './build'

export interface BuildDeps {
  /** The currently open project, or null. */
  getProject(): OpenProject | null
  /** Pre-build step: regenerate `project_config.js` from the `.msxproj` (a no-op for `customConfig`). */
  prepare(): void
  /** Pre-build step (Spec 07): export editor resources and run `imgRules`, both mtime-skipped. */
  exportResources(): Promise<ConversionResult[]>
  msxglPath(): string | null
  /** User's Node override; null falls back to MSXgl's bundled Node. */
  nodeOverride(): string | null
  /** The effective openMSX executable, or null — used to help relocatable builds find their data. */
  openmsxPath(): string | null
  emit<K extends keyof IpcEvents>(channel: K, payload: IpcEvents[K]): void
  openExternal(url: string): Promise<void>
}

/** Kill a whole tree: build.js spawns sdcc/sdasz80 children that must go too. */
function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'])
    return
  }
  // The child was spawned detached, so it leads its own process group: a
  // negative pid signals the whole group in one call.
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  const hardKill = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }, 2000)
  child.once('close', () => clearTimeout(hardKill))
}

export class BuildService {
  private child: ChildProcess | null = null
  /**
   * Claimed synchronously on entry to `start()`/`startExternal()`, not when
   * the process spawns: the pre-build resource step runs first and awaits, so
   * `child` alone would let a second build slip in during that window.
   */
  private busy = false
  private killed = false
  private readonly artifactServer = new ArtifactServer()

  // Unlike the other services this one doesn't register its own `build:*`
  // handlers — staying Electron-free is what makes real builds unit-testable,
  // so `main/index.ts` wires the two channels to `start()`/`kill()` instead.
  constructor(private readonly deps: BuildDeps) {}

  get running(): boolean {
    return this.busy
  }

  /**
   * Runs one command to completion. Rejects immediately when a build is
   * already running, or when the toolchain/project isn't ready.
   */
  async start(command: BuildCommand): Promise<BuildFinished> {
    if (this.busy) throw new Error('A build is already in progress.')
    this.busy = true
    try {
      return await this.startInner(command)
    } finally {
      this.busy = false
    }
  }

  private async startInner(command: BuildCommand): Promise<BuildFinished> {
    const open = this.deps.getProject()
    if (!open) throw new Error('No project is open.')
    const msxglPath = this.deps.msxglPath()
    if (!msxglPath) throw new Error('MSXgl is not configured — set it up in Toolchain Settings.')
    const node = resolveNodeBinary(msxglPath, this.deps.nodeOverride())
    if (!node) throw new Error('No Node executable found in the configured MSXgl checkout.')

    this.deps.prepare()

    const webmsx = command === 'run' && open.project.emulator.preferred === 'webmsx'
    this.deps.emit('build:started', { command })
    this.reportConversions(await this.deps.exportResources())

    // After exportResources — converted resources land as headers and must count.
    const stamp = buildStamp(open.root, open.project)
    const forceFull =
      (command === 'build' || command === 'run') && needsFullRebuild(open.root, stamp)
    if (forceFull) {
      this.deps.emit('build:output', {
        channel: 'build',
        lines: ['Headers or build settings changed since the last build — rebuilding everything.']
      })
    }
    const args = buildArgs(msxglPath, open.project, command, !webmsx, forceFull)
    this.deps.emit('build:output', { channel: 'build', lines: [`> ${node} ${args.join(' ')}`] })

    const result = await this.run(node, args, open.root, open.project)
    // After the build: a rebuild's clean step wipes out/ (stamp included), so a
    // stamp written before the spawn would force full rebuilds forever after.
    if (command !== 'clean') writeBuildStamp(open.root, stamp)
    if (result.ok && webmsx) await this.launchWebmsx(open, result.artifacts)
    return result
  }

  /**
   * Spec 12's "Try it": builds (and, via `extraArgs`, optionally runs) a sample directly in
   * `<msxgl>/projects/samples` — no open project, no `.msxproj`, no config regeneration. Reuses
   * the same spawn/stream/kill machinery as `start()`, including the one-build-at-a-time rule
   * (both share `this.busy`).
   */
  async startExternal(cwd: string, extraArgs: string[]): Promise<BuildFinished> {
    if (this.busy) throw new Error('A build is already in progress.')
    this.busy = true
    try {
      const msxglPath = this.deps.msxglPath()
      if (!msxglPath) throw new Error('MSXgl is not configured — set it up in Toolchain Settings.')
      const node = resolveNodeBinary(msxglPath, this.deps.nodeOverride())
      if (!node) throw new Error('No Node executable found in the configured MSXgl checkout.')

      const args = [buildScript(msxglPath), ...extraArgs]
      this.deps.emit('build:started', { command: 'run' })
      this.deps.emit('build:output', { channel: 'build', lines: [`> ${node} ${args.join(' ')}`] })
      return await this.run(node, args, cwd)
    } finally {
      this.busy = false
    }
  }

  /**
   * Logs the Spec 07 pre-build step. Nothing converted and nothing failed is
   * the common case and stays silent; failures are reported but do **not**
   * abort — MSXgl reports the missing/stale header itself, with a file and
   * line the Problems panel can link to.
   */
  private reportConversions(results: readonly ConversionResult[]): void {
    const converted = results.filter((result) => result.status === 'converted')
    const failed = results.filter((result) => result.status === 'failed')
    if (converted.length) {
      this.deps.emit('build:output', {
        channel: 'build',
        lines: [...converted.map((result) => `Converted ${result.input} → ${result.out}`), summarize(results)]
      })
    }
    if (failed.length) {
      this.deps.emit('build:output', {
        channel: 'build:err',
        lines: failed.map((result) => `Resource export failed: ${result.input} → ${result.out}: ${result.message}`)
      })
    }
  }

  /** Spawns build.js, streams its output, and resolves once it has exited. `project` (absent for
   *  Spec 12's "Try it") is only needed to resolve which artifacts were deployed. */
  private run(node: string, args: string[], root: string, project?: MsxProject): Promise<BuildFinished> {
    const problems: BuildProblem[] = []
    const stderrTail: string[] = []
    this.killed = false

    // MSXgl's `run` step execs openMSX as our grandchild; relocatable tarball
    // builds need OPENMSX_SYSTEM_DATA to find the share/ next to their bin/.
    const openmsxShare = openmsxSystemDataDir(this.deps.openmsxPath())
    const env =
      openmsxShare && !process.env.OPENMSX_SYSTEM_DATA
        ? { ...process.env, OPENMSX_SYSTEM_DATA: openmsxShare }
        : process.env

    const child = spawn(node, args, {
      cwd: root,
      env,
      // Own process group (POSIX) so the kill button can take down sdcc too.
      detached: process.platform !== 'win32',
      windowsHide: true
    })
    this.child = child

    /** Line-buffers one stream: ANSI-stripped lines out, diagnostics collected on the way. */
    const consume = (channel: 'build' | 'build:err'): { onData: (chunk: Buffer) => void; flush: () => void } => {
      let buffer = ''
      const push = (lines: string[]): void => {
        for (const line of lines) {
          if (channel === 'build:err') stderrTail.push(line)
          const problem = parseProblem(line, root)
          if (problem) problems.push({ ...problem, id: `p${problems.length}` })
        }
        if (lines.length) this.deps.emit('build:output', { channel, lines })
      }
      return {
        onData: (chunk) => {
          buffer += chunk.toString('utf-8')
          const parts = buffer.split('\n')
          buffer = parts.pop() ?? ''
          push(parts.map(stripAnsi))
        },
        // A tool that doesn't end its output with a newline still gets its last line out.
        flush: () => {
          if (!buffer) return
          const last = stripAnsi(buffer)
          buffer = ''
          push([last])
        }
      }
    }
    const stdout = consume('build')
    const stderr = consume('build:err')
    child.stdout.on('data', stdout.onData)
    child.stderr.on('data', stderr.onData)

    return new Promise((resolvePromise) => {
      let settled = false
      const finish = (code: number | null, error?: Error): void => {
        // A failed spawn emits both 'error' and 'close'; only the first counts.
        if (settled) return
        settled = true
        this.child = null
        stdout.flush()
        stderr.flush()
        const ok = !error && !this.killed && code === 0
        const finished: BuildFinished = {
          ok,
          code: this.killed ? null : code,
          artifacts: ok && project ? resolveArtifacts(root, project) : [],
          problems,
          message: error ? error.message : this.killed ? 'Build canceled.' : exitCodeMessage(code, stderrTail)
        }
        this.deps.emit('build:finished', finished)
        resolvePromise(finished)
      }
      child.on('error', (error) => finish(null, error))
      child.on('close', (code) => finish(code))
    })
  }

  /** Serves the runnable artifact over loopback and opens webmsx.org pointed at it. */
  private async launchWebmsx(open: OpenProject, artifacts: BuildArtifact[]): Promise<void> {
    const runnable = runnableArtifact(artifacts)
    if (!runnable) {
      this.deps.emit('build:output', {
        channel: 'build:err',
        lines: [`No ROM or DSK artifact to run in WebMSX for target ${open.project.target}.`]
      })
      return
    }
    const [url] = await this.artifactServer.serve([join(open.root, ...runnable.artifact.path.split('/'))])
    const target = webmsxUrl(open.project.machine, runnable.slot, url)
    this.deps.emit('build:output', {
      channel: 'build',
      lines: [
        `Opening ${target}`,
        // Chrome 141+ gates public-site → localhost fetches behind a permission.
        `If the browser asks to allow "local network access", allow it — webmsx.org needs it to load the ROM from this machine (Site settings → Local network access if it was denied before).`,
        // webmsx.org needs the network; say what to do when it isn't there.
        `If webmsx.org is unreachable, load ${join(open.root, runnable.artifact.path)} into any MSX emulator.`
      ]
    })
    try {
      await this.deps.openExternal(target)
    } catch (error) {
      this.deps.emit('build:output', {
        channel: 'build:err',
        lines: [
          `Could not open the browser: ${String(error)}`,
          `Load ${join(open.root, runnable.artifact.path)} into any MSX emulator instead.`
        ]
      })
    }
  }

  kill(): void {
    if (!this.child) return
    this.killed = true
    this.deps.emit('build:output', { channel: 'build', lines: ['Terminating build…'] })
    killTree(this.child)
  }

  /** App quit / project close: stop serving artifacts and don't leave a build behind. */
  dispose(): void {
    this.kill()
    this.artifactServer.stop()
  }
}
