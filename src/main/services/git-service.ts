/**
 * Electron-facing glue for the pure logic in `git.ts`: shells out to the
 * system `git` binary via `execFile` (never isomorphic-git/nodegit — Spec 06)
 * and watches `.git/HEAD` and `.git/index` for out-of-band changes (another
 * terminal, a merge tool…).
 *
 * Electron-free on purpose (same split as `BuildService`): the only thing it
 * needs from the app is a way to push a fresh status to the renderer, passed
 * in as `onChanged` — so the whole service, including real git commands
 * against real repos, is directly unit-testable. `src/main/index.ts` wires
 * its methods to the `git:*` IPC channels and supplies the real `onChanged`.
 *
 * The root tracks the open project, set by `ProjectService` the same way it
 * sets `FsService`'s. Every command runs with `cwd = root`. If `git` isn't
 * installed, every read resolves to a `{ gitAvailable: false }` status
 * instead of throwing — the panel shows an install hint, never an error.
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { watch, type FSWatcher } from 'chokidar'
import type { GitBranch, GitDiffResult, GitLogEntry, GitResult, GitStatus } from '../../shared/ipc'
import { resolveRelativePath } from '../../shared/fs-safety'
import {
  branchListArgs,
  checkoutArgs,
  cloneArgs,
  commitArgs,
  createBranchArgs,
  discardArgs,
  emptyStatus,
  initArgs,
  isGitMissing,
  logArgs,
  parseBranchList,
  parseLog,
  parsePorcelainStatus,
  pullArgs,
  pushArgs,
  showArgs,
  stageArgs,
  STARTER_GITIGNORE,
  statusArgs,
  topLevelArgs,
  unstageArgs
} from './git'

interface ExecResult {
  stdout: string
  stderr: string
}

/** Best-effort extraction of a git failure's stderr (falls back to the error message, which
 *  Node's execFile already appends stderr to for a non-zero exit). */
function errorStderr(error: unknown): string {
  const withStderr = error as { stderr?: string; message?: string } | null
  const stderr = withStderr?.stderr?.trim()
  if (stderr) return stderr
  return withStderr?.message ?? String(error)
}

export class GitService {
  private root: string | null = null
  /** The repo root enclosing `root` — see `topLevelArgs`. Held as the in-flight promise so commands
   *  issued before it resolves await the same lookup. Falls back to `root` (not a repo / no git). */
  private topLevel: Promise<string> | null = null
  private watcher: FSWatcher | null = null
  private gitAvailable = true
  /** Tail of the one-at-a-time git chain; see `run`. */
  private queue: Promise<void> = Promise.resolve()

  /** `onChanged` is called with the fresh status after every mutation and on out-of-band `.git` changes. */
  constructor(private readonly onChanged: (status: GitStatus) => void) {}

  /** Called by ProjectService on open/create/close — same pattern as `FsService.setRoot`. */
  setRoot(root: string | null): void {
    this.root = root
    void this.watcher?.close()
    this.watcher = null
    if (!root) {
      this.topLevel = null
      return
    }
    const pending = (this.topLevel = this.resolveTopLevel(root))
    void pending.then((top) => {
      if (this.root !== root) return // a later setRoot won while this lookup was in flight
      // Watching these two files (not `.git/refs/**`) is enough to catch a
      // commit/checkout/merge made outside the IDE; chokidar tolerates them not
      // existing yet (a non-repo project) and picks them up once `git init` runs.
      this.watcher = watch([join(top, '.git', 'HEAD'), join(top, '.git', 'index')], { ignoreInitial: true })
      this.watcher.on('all', () => void this.pushChanged())
    })
  }

  private async resolveTopLevel(root: string): Promise<string> {
    try {
      const { stdout } = await this.run(topLevelArgs(), root)
      return stdout.trim() || root
    } catch {
      return root
    }
  }

  /**
   * Resolves once nothing of ours is touching the repo any more: the watcher's
   * handles are closed *and* the last git child has exited. On Windows a folder
   * that is some process's cwd cannot be removed (EBUSY), and the watcher fires
   * a status refresh after every index change — so a `git status` can easily
   * outlive the command that triggered it.
   */
  async dispose(): Promise<void> {
    await this.watcher?.close()
    await this.queue
  }

  // ── plumbing ────────────────────────────────────────────────────────────

  /** `cwd` defaults to the enclosing repo root; pass it explicitly to run somewhere else (and to avoid
   *  awaiting the very lookup that resolves it). */
  private async run(args: string[], explicitCwd?: string): Promise<ExecResult> {
    const cwd = explicitCwd ?? (await this.topLevel)
    if (!cwd) return Promise.reject(new Error('No project is open'))
    // Git takes `.git/index.lock` even to refresh the index for `status`, and
    // the watcher fires a status on every index change — so a status and the
    // command that triggered it can collide ("Unable to create index.lock",
    // reliably on Windows). One chain, one git at a time. The cwd is resolved
    // *before* queueing: `resolveTopLevel` runs git too, and awaiting it from
    // inside the queue would wait on a command queued behind this one.
    const result = this.queue.then(
      () => this.exec(args, cwd),
      () => this.exec(args, cwd)
    )
    this.queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private exec(args: string[], cwd: string): Promise<ExecResult> {
    return new Promise((resolvePromise, reject) => {
      execFile('git', args, { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          this.gitAvailable = !isGitMissing(error)
          reject(Object.assign(error, { stderr }))
          return
        }
        this.gitAvailable = true
        resolvePromise({ stdout, stderr })
      })
    })
  }

  private async computeStatus(): Promise<GitStatus> {
    if (!this.root) return emptyStatus()
    try {
      const { stdout } = await this.run(statusArgs())
      return parsePorcelainStatus(stdout)
    } catch {
      // Not a repo (exit 128, "not a git repository…") and "git missing" both
      // collapse to the same shape — `gitAvailable` is what the panel branches on.
      return emptyStatus({ gitAvailable: this.gitAvailable })
    }
  }

  /** Runs a mutating git command, then refreshes+broadcasts status. A thrown error propagates to the caller (the renderer sees a rejected invoke()). */
  private async mutate(run: () => Promise<unknown>): Promise<GitStatus> {
    await run()
    return this.pushChanged()
  }

  private async pushChanged(): Promise<GitStatus> {
    const fresh = await this.computeStatus()
    this.onChanged(fresh)
    return fresh
  }

  // ── reads ───────────────────────────────────────────────────────────────

  async status(): Promise<GitStatus> {
    return this.computeStatus()
  }

  async branches(): Promise<GitBranch[]> {
    if (!this.root) return []
    try {
      const { stdout } = await this.run(branchListArgs())
      return parseBranchList(stdout)
    } catch {
      return []
    }
  }

  async log(limit: number, path?: string): Promise<GitLogEntry[]> {
    if (!this.root) return []
    try {
      const { stdout } = await this.run(logArgs(limit, path))
      return parseLog(stdout)
    } catch {
      return []
    }
  }

  private async show(ref: 'HEAD' | 'INDEX', path: string): Promise<string> {
    try {
      const { stdout } = await this.run(showArgs(ref, path))
      return stdout
    } catch {
      // Missing from that ref (new/untracked/deleted file) — an empty old/new side is correct, not an error.
      return ''
    }
  }

  private async readWorkingFile(path: string): Promise<string> {
    const top = await this.topLevel
    const safe = top ? resolveRelativePath(path) : null
    if (safe === null || !top) return ''
    try {
      return readFileSync(join(top, ...safe.split('/')), 'utf-8')
    } catch {
      return '' // deleted on disk
    }
  }

  async diff(path: string, staged: boolean, origPath?: string): Promise<GitDiffResult> {
    if (!this.root) return { old: '', new: '' }
    const oldPath = origPath ?? path
    const oldContent = await this.show(staged ? 'HEAD' : 'INDEX', oldPath)
    const newContent = staged ? await this.show('INDEX', path) : await this.readWorkingFile(path)
    return { old: oldContent, new: newContent }
  }

  // ── mutations ───────────────────────────────────────────────────────────

  stage(paths: string[]): Promise<GitStatus> {
    return this.mutate(() => this.run(stageArgs(paths)))
  }

  unstage(paths: string[]): Promise<GitStatus> {
    return this.mutate(() => this.run(unstageArgs(paths)))
  }

  discard(paths: string[]): Promise<GitStatus> {
    return this.mutate(() => this.discardFiles(paths))
  }

  /** Untracked paths are deleted directly (git can't `checkout --` something that isn't tracked); tracked paths go through `git checkout --`. */
  private async discardFiles(paths: string[]): Promise<void> {
    const top = await this.topLevel
    if (!top) return
    const status = await this.computeStatus()
    const tracked: string[] = []
    for (const path of paths) {
      const file = status.files.find((f) => f.path === path)
      if (file?.unstaged === 'untracked') {
        const safe = resolveRelativePath(path)
        if (safe !== null) await rm(join(top, ...safe.split('/')), { force: true })
      } else {
        tracked.push(path)
      }
    }
    if (tracked.length) await this.run(discardArgs(tracked))
  }

  commit(message: string, amend: boolean): Promise<GitStatus> {
    return this.mutate(() => this.run(commitArgs(message, amend)))
  }

  checkout(name: string): Promise<GitStatus> {
    return this.mutate(() => this.run(checkoutArgs(name)))
  }

  createBranch(name: string): Promise<GitStatus> {
    return this.mutate(() => this.run(createBranchArgs(name)))
  }

  async init(): Promise<GitStatus> {
    if (!this.root) throw new Error('No project is open')
    // Explicit cwd: "init" means *this* folder. Left to default it would re-init the enclosing
    // repo when the project sits inside one — which is also why the top level is re-read after.
    // ponytail: the watcher still points at whatever `setRoot` found, so init-inside-another-repo
    // needs a reopen to catch out-of-band commits. Unreachable from the UI — the Init button only
    // appears when `isRepo` is false, and a nested project reports the outer repo's status.
    await this.run(initArgs(), this.root)
    this.topLevel = Promise.resolve(this.root)
    const gitignore = join(this.root, '.gitignore')
    if (!existsSync(gitignore)) await writeFile(gitignore, STARTER_GITIGNORE, 'utf-8')
    return this.pushChanged()
  }

  async clone(url: string, targetDir: string): Promise<void> {
    // No project needs to be open yet (and cwd doesn't matter — targetDir is absolute).
    await this.run(cloneArgs(url, targetDir), process.cwd())
  }

  async push(): Promise<GitResult> {
    if (!this.root) return { ok: false, stderr: 'No project is open.' }
    const status = await this.computeStatus()
    if (!status.branch) return { ok: false, stderr: 'Not on a branch — nothing to push.' }
    try {
      await this.run(pushArgs(status.branch, !!status.upstream))
      await this.pushChanged()
      return { ok: true, stderr: '' }
    } catch (error) {
      return { ok: false, stderr: errorStderr(error) }
    }
  }

  async pull(): Promise<GitResult> {
    if (!this.root) return { ok: false, stderr: 'No project is open.' }
    try {
      await this.run(pullArgs())
      await this.pushChanged()
      return { ok: true, stderr: '' }
    } catch (error) {
      return { ok: false, stderr: errorStderr(error) }
    }
  }
}
