import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GitStatus } from '../../shared/ipc'
import { GitService } from './git-service'

const tmpDirs: string[] = []
const services: GitService[] = []

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

/** A real repo with identity configured and one commit already made — the common starting point for stage/diff/branch tests. */
function makeRepo(prefix: string): string {
  const root = makeTmpDir(prefix)
  git(root, ['init', '-q'])
  git(root, ['config', 'user.email', 'test@example.com'])
  git(root, ['config', 'user.name', 'Test'])
  writeFileSync(join(root, 'README.md'), 'hello\n')
  git(root, ['add', 'README.md'])
  git(root, ['commit', '-q', '-m', 'initial'])
  return root
}

interface Harness {
  service: GitService
  events: GitStatus[]
}

function harness(): Harness {
  const events: GitStatus[] = []
  const service = new GitService((status) => events.push(status))
  services.push(service)
  return { service, events }
}

afterEach(() => {
  for (const service of services.splice(0)) service.dispose()
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('GitService.status — no project / non-repo folder', () => {
  it('resolves to isRepo:false without a project open, never throwing', async () => {
    const { service } = harness()
    expect(await service.status()).toMatchObject({ isRepo: false, gitAvailable: true, files: [] })
  })

  it('resolves to isRepo:false for a plain (non-git) folder', async () => {
    const root = makeTmpDir('plain-')
    const { service } = harness()
    service.setRoot(root)
    expect(await service.status()).toMatchObject({ isRepo: false, gitAvailable: true })
  })
})

describe('GitService.init', () => {
  it('runs `git init`, writes the starter .gitignore, and broadcasts the fresh status', async () => {
    const root = makeTmpDir('init-')
    const { service, events } = harness()
    service.setRoot(root)

    const status = await service.init()

    expect(existsSync(join(root, '.git'))).toBe(true)
    expect(readFileSync(join(root, '.gitignore'), 'utf-8')).toBe('out/\nemul/\n.msxstudio/\n')
    expect(status.isRepo).toBe(true)
    expect(status.initial).toBe(true) // no commits yet
    expect(events.at(-1)).toEqual(status)
  })

  it('never overwrites an existing .gitignore', async () => {
    const root = makeTmpDir('init-keep-')
    writeFileSync(join(root, '.gitignore'), 'custom/\n')
    const { service } = harness()
    service.setRoot(root)

    await service.init()

    expect(readFileSync(join(root, '.gitignore'), 'utf-8')).toBe('custom/\n')
  })
})

describe('GitService — stage / unstage / commit / amend, matching real `git status`', () => {
  it('walks a file through untracked → staged → unstaged → staged → committed', async () => {
    const root = makeRepo('flow-')
    const { service } = harness()
    service.setRoot(root)

    writeFileSync(join(root, 'a.c'), 'int main(){}\n')
    let status = await service.status()
    expect(status.files).toEqual([{ path: 'a.c', staged: null, unstaged: 'untracked', conflicted: false }])

    status = await service.stage(['a.c'])
    expect(status.files).toEqual([{ path: 'a.c', staged: 'added', unstaged: null, conflicted: false }])

    status = await service.unstage(['a.c'])
    expect(status.files).toEqual([{ path: 'a.c', staged: null, unstaged: 'untracked', conflicted: false }])

    await service.stage(['a.c'])
    status = await service.commit('add a.c', false)
    expect(status.files).toEqual([])

    const log = await service.log(10)
    expect(log).toHaveLength(2) // this commit + makeRepo's "initial"
    expect(log[0].subject).toBe('add a.c')
    expect(log[0].author).toBe('Test')
  })

  it('amends the last commit instead of adding a new one', async () => {
    const root = makeRepo('amend-')
    const { service } = harness()
    service.setRoot(root)

    writeFileSync(join(root, 'README.md'), 'hello again\n')
    await service.stage(['README.md'])
    await service.commit('fixed message', true)

    const log = await service.log(10)
    expect(log).toHaveLength(1)
    expect(log[0].subject).toBe('fixed message')
  })
})

describe('GitService.discard', () => {
  it('deletes an untracked file, and reverts a tracked working-tree change to the index copy', async () => {
    const root = makeRepo('discard-')
    const { service } = harness()
    service.setRoot(root)

    writeFileSync(join(root, 'untracked.c'), 'x\n')
    writeFileSync(join(root, 'README.md'), 'changed\n')

    const status = await service.discard(['untracked.c', 'README.md'])

    expect(existsSync(join(root, 'untracked.c'))).toBe(false)
    expect(readFileSync(join(root, 'README.md'), 'utf-8')).toBe('hello\n')
    expect(status.files).toEqual([])
  })
})

describe('GitService — branch create + checkout', () => {
  it('creates and switches branches, listing them with the current one marked', async () => {
    const root = makeRepo('branch-')
    const { service } = harness()
    service.setRoot(root)
    const original = (await service.status()).branch as string
    expect(original).toBeTruthy()

    const afterCreate = await service.createBranch('feature')
    expect(afterCreate.branch).toBe('feature')

    const branches = await service.branches()
    expect(branches.find((b) => b.name === 'feature')).toMatchObject({ current: true })
    expect(branches.find((b) => b.name === original)).toMatchObject({ current: false })

    const afterCheckout = await service.checkout(original)
    expect(afterCheckout.branch).toBe(original)
  })
})

describe('GitService.diff', () => {
  it('returns index-vs-worktree contents for an unstaged change', async () => {
    const root = makeRepo('diff-unstaged-')
    const { service } = harness()
    service.setRoot(root)
    writeFileSync(join(root, 'README.md'), 'edited\n')

    expect(await service.diff('README.md', false)).toEqual({ old: 'hello\n', new: 'edited\n' })
  })

  it('returns HEAD-vs-index contents for a staged change', async () => {
    const root = makeRepo('diff-staged-')
    const { service } = harness()
    service.setRoot(root)
    writeFileSync(join(root, 'README.md'), 'edited\n')
    await service.stage(['README.md'])

    expect(await service.diff('README.md', true)).toEqual({ old: 'hello\n', new: 'edited\n' })
  })

  it('treats an untracked file as an empty old side', async () => {
    const root = makeRepo('diff-untracked-')
    const { service } = harness()
    service.setRoot(root)
    writeFileSync(join(root, 'new.c'), 'brand new\n')

    expect(await service.diff('new.c', false)).toEqual({ old: '', new: 'brand new\n' })
  })
})

describe('GitService — push/pull against a local bare origin (offline, file://)', () => {
  it('publishes with -u on the first push, then the other side pulls it', async () => {
    const bare = makeTmpDir('bare-')
    git(bare, ['init', '-q', '--bare'])
    const bareUrl = `file://${bare}`

    const repoA = makeRepo('remote-a-')
    git(repoA, ['remote', 'add', 'origin', bareUrl])
    const { service: a } = harness()
    a.setRoot(repoA)

    expect(await a.push()).toEqual({ ok: true, stderr: '' })
    expect((await a.status()).upstream).toMatch(/^origin\//)

    const repoB = makeTmpDir('remote-b-')
    git(tmpdir(), ['clone', '-q', bareUrl, repoB])
    git(repoB, ['config', 'user.email', 'test@example.com'])
    git(repoB, ['config', 'user.name', 'Test'])
    const { service: b } = harness()
    b.setRoot(repoB)

    writeFileSync(join(repoA, 'from-a.txt'), 'a\n')
    await a.stage(['from-a.txt'])
    await a.commit('from A', false)
    expect(await a.push()).toEqual({ ok: true, stderr: '' }) // upstream already set — plain `push`

    expect(await b.pull()).toEqual({ ok: true, stderr: '' })
    expect(existsSync(join(repoB, 'from-a.txt'))).toBe(true)
  })

  it('surfaces stderr instead of crashing on a rejected non-fast-forward push', async () => {
    const bare = makeTmpDir('bare-reject-')
    git(bare, ['init', '-q', '--bare'])
    const bareUrl = `file://${bare}`

    const repoA = makeRepo('reject-a-')
    git(repoA, ['remote', 'add', 'origin', bareUrl])
    const { service: a } = harness()
    a.setRoot(repoA)
    await a.push()

    const repoB = makeTmpDir('reject-b-')
    git(tmpdir(), ['clone', '-q', bareUrl, repoB])
    git(repoB, ['config', 'user.email', 'test@example.com'])
    git(repoB, ['config', 'user.name', 'Test'])
    writeFileSync(join(repoB, 'b.txt'), 'b\n')
    git(repoB, ['add', 'b.txt'])
    git(repoB, ['commit', '-q', '-m', 'from B'])
    git(repoB, ['push', '-q'])

    writeFileSync(join(repoA, 'a.txt'), 'a\n')
    await a.stage(['a.txt'])
    await a.commit('from A, diverged', false)

    const result = await a.push()
    expect(result.ok).toBe(false)
    expect(result.stderr.toLowerCase()).toContain('rejected')
  })

  it('reports a friendly failure instead of throwing when there is no project open', async () => {
    const { service } = harness()
    expect(await service.push()).toEqual({ ok: false, stderr: 'No project is open.' })
    expect(await service.pull()).toEqual({ ok: false, stderr: 'No project is open.' })
  })
})

describe('GitService.clone', () => {
  it('clones a local (file://) repo into a fresh target directory', async () => {
    const bare = makeTmpDir('clone-bare-')
    git(bare, ['init', '-q', '--bare'])
    const seed = makeRepo('clone-seed-')
    git(seed, ['remote', 'add', 'origin', `file://${bare}`])
    git(seed, ['push', '-q', 'origin', 'HEAD'])

    const target = join(makeTmpDir('clone-target-'), 'checkout')
    const { service } = harness()
    await service.clone(`file://${bare}`, target)

    expect(readFileSync(join(target, 'README.md'), 'utf-8')).toBe('hello\n')
  })
})

describe('GitService — project folder nested inside a bigger repo', () => {
  // `git status --porcelain` reports paths relative to the repo root, so a project opened at a
  // subdirectory gets paths that don't resolve against its own folder. Every command has to run
  // from the top level for the two to agree.
  it('stages, diffs and discards a file living above the project folder', async () => {
    const repo = makeRepo('nested-')
    mkdirSync(join(repo, 'game'))
    writeFileSync(join(repo, 'game', 'main.c'), 'int main(){}\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-q', '-m', 'add project'])

    const { service } = harness()
    service.setRoot(join(repo, 'game')) // the project is the subdirectory, not the repo root

    writeFileSync(join(repo, 'README.md'), 'hello\nchanged\n') // tracked, at the repo root
    writeFileSync(join(repo, 'notes.txt'), 'scratch\n') // untracked, at the repo root

    expect((await service.status()).files).toEqual([
      { path: 'README.md', staged: null, unstaged: 'modified', conflicted: false },
      { path: 'notes.txt', staged: null, unstaged: 'untracked', conflicted: false }
    ])

    // The bug: `git add -- README.md` ran with cwd=<repo>/game and died on "pathspec did not match".
    const staged = await service.stage(['README.md'])
    expect(staged.files).toContainEqual({ path: 'README.md', staged: 'modified', unstaged: null, conflicted: false })

    expect(await service.diff('README.md', false, undefined)).toEqual({
      old: 'hello\nchanged\n', // already staged, so the index side matches the working tree
      new: 'hello\nchanged\n'
    })

    await service.unstage(['README.md'])
    await service.discard(['README.md', 'notes.txt'])
    expect(readFileSync(join(repo, 'README.md'), 'utf-8')).toBe('hello\n') // reverted
    expect(existsSync(join(repo, 'notes.txt'))).toBe(false) // untracked → deleted
    expect((await service.status()).files).toEqual([])
  })

  it('init still creates a repo in the project folder, not in the one enclosing it', async () => {
    const outer = makeRepo('nested-init-')
    const inner = join(outer, 'game')
    mkdirSync(inner)
    const { service } = harness()
    service.setRoot(inner)

    await service.init()

    expect(existsSync(join(inner, '.git'))).toBe(true)
    expect((await service.status()).initial).toBe(true) // the inner repo's own history, not outer's
  })
})
