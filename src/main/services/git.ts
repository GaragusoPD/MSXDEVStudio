/**
 * Everything GitService does that isn't shelling out to `git`: argument lists
 * for each command, and parsers for git's machine-readable output
 * (`--porcelain=v2 -z` status, `--format` branch listing, `--pretty=format`
 * log). Electron-free on purpose (same split as `build.ts`) so all of it is
 * directly unit-testable against real captured git output — see `git.test.ts`.
 *
 * Every parser here consumes ONLY `--porcelain`/`-z`/`--format` machine
 * output, never git's localized human-readable text (spec 06).
 */

import type { GitBranch, GitChangeCode, GitFileStatus, GitLogEntry, GitStatus } from '../../shared/ipc'
import { IDE_STATE_DIR } from './project'

/** Written by `git:init` when the project has no `.gitignore` yet — same content Spec 03's wizard writes. */
export const STARTER_GITIGNORE = `out/\nemul/\n${IDE_STATE_DIR}/\n`

// ── status ──────────────────────────────────────────────────────────────────

export function statusArgs(): string[] {
  return ['status', '--porcelain=v2', '--branch', '-z']
}

const STATE_BY_CHAR: Record<string, GitChangeCode> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechange'
}

function toChangeCode(ch: string): GitChangeCode | null {
  return ch === '.' ? null : (STATE_BY_CHAR[ch] ?? null)
}

/** A status with no repo/files — the "not a repo yet" / "git missing" / "no project open" starting point. */
export function emptyStatus(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    isRepo: false,
    gitAvailable: true,
    branch: null,
    detached: false,
    initial: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
    ...overrides
  }
}

/**
 * Parses `git status --porcelain=v2 --branch -z` stdout. Record kinds: `1`
 * ordinary changes, `2` renamed/copied (path is followed by one more
 * NUL-terminated token, the origin path), `u` unmerged (conflicts), `?`
 * untracked. `!` (ignored) is never requested (no `--ignored` flag) so it
 * never appears.
 */
export function parsePorcelainStatus(raw: string): GitStatus {
  const tokens = raw.split('\0')
  const status = emptyStatus({ isRepo: true })
  const files: GitFileStatus[] = []

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token) continue

    if (token.startsWith('# branch.oid ')) {
      status.initial = token.slice('# branch.oid '.length) === '(initial)'
    } else if (token.startsWith('# branch.head ')) {
      const head = token.slice('# branch.head '.length)
      status.detached = head === '(detached)'
      status.branch = status.detached ? null : head
    } else if (token.startsWith('# branch.upstream ')) {
      status.upstream = token.slice('# branch.upstream '.length)
    } else if (token.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(token)
      if (match) {
        status.ahead = Number(match[1])
        status.behind = Number(match[2])
      }
    } else if (token[0] === '1') {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const parts = token.split(' ')
      const xy = parts[1]
      files.push({ path: parts.slice(8).join(' '), staged: toChangeCode(xy[0]), unstaged: toChangeCode(xy[1]), conflicted: false })
    } else if (token[0] === '2') {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X-score> <path> \0 <origPath>
      const parts = token.split(' ')
      const xy = parts[1]
      const path = parts.slice(9).join(' ')
      const origPath = tokens[++i] ?? ''
      files.push({ path, origPath, staged: toChangeCode(xy[0]), unstaged: toChangeCode(xy[1]), conflicted: false })
    } else if (token[0] === 'u') {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const parts = token.split(' ')
      files.push({ path: parts.slice(10).join(' '), staged: null, unstaged: null, conflicted: true })
    } else if (token[0] === '?') {
      files.push({ path: token.slice(2), staged: null, unstaged: 'untracked', conflicted: false })
    }
  }

  status.files = files
  return status
}

// ── branches ────────────────────────────────────────────────────────────────

// Tab-separated: branch names can never contain whitespace, so a literal tab
// is a safe field separator (unlike `git log`, `for-each-ref`/`branch
// --format` only expands %00/%09/%0a/%25 — not arbitrary %x.. hex escapes).
const BRANCH_FORMAT = '%(refname:short)\t%(objectname)\t%(upstream:short)\t%(HEAD)'

export function branchListArgs(): string[] {
  return ['branch', '--list', `--format=${BRANCH_FORMAT}`]
}

/**
 * Parses `git branch --list --format=...`. Drops the synthetic
 * "(HEAD detached at ...)" pseudo-entry git prints as the current "branch"
 * when HEAD isn't on one.
 */
export function parseBranchList(raw: string): GitBranch[] {
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [name, , upstream, head] = line.split('\t')
      return { name, current: head === '*', upstream: upstream || null }
    })
    .filter((branch) => !branch.name.startsWith('('))
}

export function checkoutArgs(name: string): string[] {
  return ['checkout', name]
}

export function createBranchArgs(name: string): string[] {
  return ['checkout', '-b', name]
}

// ── log ─────────────────────────────────────────────────────────────────────

// Unit separator (0x1F): a control character that can't appear in author
// names/emails/subjects/bodies, and — unlike `branch --format` — `git log`'s
// pretty-format does support arbitrary `%x..` hex-byte escapes.
const LOG_FIELD_SEP = '\x1f'
const LOG_FORMAT = ['%H', '%h', '%an', '%ae', '%aI', '%s', '%b'].join(LOG_FIELD_SEP)

export function logArgs(limit: number, path?: string): string[] {
  const args = ['log', '-z', `--pretty=format:${LOG_FORMAT}`, `-n${limit}`]
  if (path) args.push('--', path)
  return args
}

/** Parses `git log -z --pretty=format:...` (unit-separator fields, NUL between commits, no trailing NUL). */
export function parseLog(raw: string): GitLogEntry[] {
  if (!raw) return []
  return raw
    .split('\0')
    .filter((record) => record.length > 0)
    .map((record) => {
      const [hash, shortHash, author, email, date, subject, body] = record.split(LOG_FIELD_SEP)
      return { hash, shortHash, author, email, date, subject, body: (body ?? '').replace(/\n+$/, '') }
    })
}

// ── mutations ───────────────────────────────────────────────────────────────

export function stageArgs(paths: string[]): string[] {
  return ['add', '--', ...paths]
}

/** Works even before the first commit, unlike `git restore --staged` (which needs a HEAD to restore from). */
export function unstageArgs(paths: string[]): string[] {
  return ['reset', '--', ...paths]
}

/** Reverts tracked working-tree changes to the index. Untracked files aren't handled here — GitService deletes those directly. */
export function discardArgs(paths: string[]): string[] {
  return ['checkout', '--', ...paths]
}

export function commitArgs(message: string, amend: boolean): string[] {
  return amend ? ['commit', '--amend', '-m', message] : ['commit', '-m', message]
}

export function pushArgs(branch: string, hasUpstream: boolean): string[] {
  return hasUpstream ? ['push'] : ['push', '-u', 'origin', branch]
}

export function pullArgs(): string[] {
  return ['pull']
}

export function initArgs(): string[] {
  return ['init']
}

export function cloneArgs(url: string, targetDir: string): string[] {
  return ['clone', url, targetDir]
}

/** `git show` argument to read a file's blob from the index (`'INDEX'`) or a commit-ish (`'HEAD'`, a sha, …). */
export function showArgs(ref: 'INDEX' | string, path: string): string[] {
  return ['show', ref === 'INDEX' ? `:${path}` : `${ref}:${path}`]
}

// ── availability ────────────────────────────────────────────────────────────

/** True when spawning `git` itself failed (ENOENT) — the binary isn't installed / not on PATH. */
export function isGitMissing(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: string }).code === 'ENOENT'
}
