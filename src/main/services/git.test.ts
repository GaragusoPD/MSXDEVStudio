import { describe, expect, it } from 'vitest'
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
  statusArgs,
  STARTER_GITIGNORE,
  unstageArgs
} from './git'

/** Every fixture below is a token list exactly as captured from a real `git
 * status --porcelain=v2 --branch -z` run in a temp repo (see the spec 06
 * implementation notes) — joined with `\0` to reproduce the real byte stream. */
function statusFixture(tokens: string[]): string {
  return tokens.join('\0') + '\0'
}

describe('parsePorcelainStatus', () => {
  it('parses ordinary changes: staged-only, unstaged-only, and both at once', () => {
    const raw = statusFixture([
      '# branch.oid 6960bc6205b501fc374f5068440d35e0563ba026',
      '# branch.head master',
      '1 .M N... 100644 100644 100644 ce013625030ba8dba906f756967f9e9ca394464a ce013625030ba8dba906f756967f9e9ca394464a a.txt',
      '1 D. N... 100644 000000 000000 cc628ccd10742baea8241c5924df992b5c019f71 0000000000000000000000000000000000000000 b.txt',
      '1 AM N... 000000 100644 100644 0000000000000000000000000000000000000000 3e757656cf36eca53338e520d134963a44f793f8 c.txt',
      '? d.txt',
      '? sub/'
    ])

    const status = parsePorcelainStatus(raw)

    expect(status.isRepo).toBe(true)
    expect(status.branch).toBe('master')
    expect(status.detached).toBe(false)
    expect(status.initial).toBe(false)
    expect(status.upstream).toBeNull()
    expect(status.ahead).toBe(0)
    expect(status.behind).toBe(0)
    expect(status.files).toEqual([
      { path: 'a.txt', staged: null, unstaged: 'modified', conflicted: false },
      { path: 'b.txt', staged: 'deleted', unstaged: null, conflicted: false },
      { path: 'c.txt', staged: 'added', unstaged: 'modified', conflicted: false },
      { path: 'd.txt', staged: null, unstaged: 'untracked', conflicted: false },
      { path: 'sub/', staged: null, unstaged: 'untracked', conflicted: false }
    ])
  })

  it('parses ahead/behind counts from branch.ab', () => {
    const ahead = parsePorcelainStatus(
      statusFixture([
        '# branch.oid 33770e2b1f0557a1e97eb3035f82c468325e59c4',
        '# branch.head master',
        '# branch.upstream origin/master',
        '# branch.ab +1 -0'
      ])
    )
    expect(ahead).toMatchObject({ upstream: 'origin/master', ahead: 1, behind: 0, files: [] })

    const behind = parsePorcelainStatus(
      statusFixture([
        '# branch.oid 23f9c337c2ce7cd3fce6149eb2e44b1e0932a047',
        '# branch.head master',
        '# branch.upstream origin/master',
        '# branch.ab +0 -1'
      ])
    )
    expect(behind).toMatchObject({ ahead: 0, behind: 1 })
  })

  it('parses a rename (kind 2) with its origin path as the following NUL token', () => {
    const status = parsePorcelainStatus(
      statusFixture([
        '# branch.oid 2a600a4094cd214c9c7fe5da440b9ab4741b91f0',
        '# branch.head master',
        '2 RM N... 100644 100644 100644 3367afdbbf91e638efe983616377c60477cc6612 3367afdbbf91e638efe983616377c60477cc6612 R100 new.txt',
        'old.txt'
      ])
    )
    expect(status.files).toEqual([
      { path: 'new.txt', origPath: 'old.txt', staged: 'renamed', unstaged: 'modified', conflicted: false }
    ])
  })

  it('parses an unmerged (conflict) entry as conflicted with null staged/unstaged', () => {
    const status = parsePorcelainStatus(
      statusFixture([
        '# branch.oid b3740ae45d50d98bf2faac04d6a388f34582f584',
        '# branch.head branch1',
        'u UU N... 100644 100644 100644 100644 df967b96a579e45a18b8251732d16804b2e56a55 e3369c56f1c0f89ea1f3243025b29b49a03593ed a37505dc42af4adeb861454560df1401503fa818 f.txt'
      ])
    )
    expect(status.branch).toBe('branch1')
    expect(status.files).toEqual([{ path: 'f.txt', staged: null, unstaged: null, conflicted: true }])
  })

  it('marks `initial: true` when branch.oid is "(initial)" (no commits yet)', () => {
    const status = parsePorcelainStatus(
      statusFixture([
        '# branch.oid (initial)',
        '# branch.head master',
        '1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 587be6b4c3f93f93c489c0111bba5596147a26cb x.txt'
      ])
    )
    expect(status.initial).toBe(true)
    expect(status.files).toEqual([{ path: 'x.txt', staged: 'added', unstaged: null, conflicted: false }])
  })

  it('marks `detached: true` and a null branch when HEAD is detached', () => {
    const status = parsePorcelainStatus(
      statusFixture(['# branch.oid 0e1e82e77d4c04730c6030d65fbd0c14a15c6751', '# branch.head (detached)'])
    )
    expect(status.detached).toBe(true)
    expect(status.branch).toBeNull()
    expect(status.files).toEqual([])
  })
})

describe('emptyStatus', () => {
  it('defaults to a non-repo, git-available, empty status', () => {
    expect(emptyStatus()).toEqual({
      isRepo: false,
      gitAvailable: true,
      branch: null,
      detached: false,
      initial: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      files: []
    })
  })

  it('applies overrides', () => {
    expect(emptyStatus({ gitAvailable: false }).gitAvailable).toBe(false)
  })
})

describe('parseBranchList', () => {
  it('parses local branches, marking the current one and its upstream', () => {
    const raw = [
      ['feature', '40ee8f26dbd188943d5468d39aafee957eff81ea', '', ' '].join('\t'),
      ['master', '40ee8f26dbd188943d5468d39aafee957eff81ea', 'origin/master', '*'].join('\t')
    ].join('\n')

    expect(parseBranchList(raw)).toEqual([
      { name: 'feature', current: false, upstream: null },
      { name: 'master', current: true, upstream: 'origin/master' }
    ])
  })

  it('drops the synthetic "(HEAD detached at ...)" pseudo-branch', () => {
    const raw = [
      ['(HEAD detached at 2c87a1e)', '2c87a1e5027a04ea98fd6895698e5e0ae7661496', '', '*'].join('\t'),
      ['master', '2c87a1e5027a04ea98fd6895698e5e0ae7661496', '', ' '].join('\t')
    ].join('\n')

    expect(parseBranchList(raw)).toEqual([{ name: 'master', current: false, upstream: null }])
  })

  it('ignores blank trailing lines', () => {
    expect(parseBranchList('master\tabc\t\t*\n')).toHaveLength(1)
  })
})

describe('parseLog', () => {
  it('parses unit-separator fields and NUL-separated commit records (captured from a real run)', () => {
    const raw =
      [
        'cf3ab9549efc97d2ff1f45f5cddfe271ca596d9e',
        'cf3ab95',
        'Test',
        'a@b.com',
        '2026-08-02T18:52:00+03:00',
        'two',
        ''
      ].join('\x1f') +
      '\0' +
      ['0e1e82e77d4c04730c6030d65fbd0c14a15c6751', '0e1e82e', 'Test', 'a@b.com', '2026-08-02T18:52:00+03:00', 'one', ''].join(
        '\x1f'
      )

    expect(parseLog(raw)).toEqual([
      {
        hash: 'cf3ab9549efc97d2ff1f45f5cddfe271ca596d9e',
        shortHash: 'cf3ab95',
        author: 'Test',
        email: 'a@b.com',
        date: '2026-08-02T18:52:00+03:00',
        subject: 'two',
        body: ''
      },
      {
        hash: '0e1e82e77d4c04730c6030d65fbd0c14a15c6751',
        shortHash: '0e1e82e',
        author: 'Test',
        email: 'a@b.com',
        date: '2026-08-02T18:52:00+03:00',
        subject: 'one',
        body: ''
      }
    ])
  })

  it('trims trailing newlines off a multi-line body', () => {
    const raw = ['h', 'h', 'a', 'e', 'd', 'subject line', 'body line one\nbody line two\n\n'].join('\x1f')
    expect(parseLog(raw)[0].body).toBe('body line one\nbody line two')
  })

  it('returns an empty array for empty input', () => {
    expect(parseLog('')).toEqual([])
  })
})

describe('argument builders', () => {
  it('status', () => expect(statusArgs()).toEqual(['status', '--porcelain=v2', '--branch', '-z']))

  it('stage/unstage/discard batch every path with `--`', () => {
    expect(stageArgs(['a.c', 'b.c'])).toEqual(['add', '--', 'a.c', 'b.c'])
    expect(unstageArgs(['a.c'])).toEqual(['reset', '--', 'a.c'])
    expect(discardArgs(['a.c', 'b.c'])).toEqual(['checkout', '--', 'a.c', 'b.c'])
  })

  it('commit plain vs amend', () => {
    expect(commitArgs('msg', false)).toEqual(['commit', '-m', 'msg'])
    expect(commitArgs('msg', true)).toEqual(['commit', '--amend', '-m', 'msg'])
  })

  it('branch list/checkout/create', () => {
    expect(branchListArgs()).toEqual(['branch', '--list', '--format=%(refname:short)\t%(objectname)\t%(upstream:short)\t%(HEAD)'])
    expect(checkoutArgs('main')).toEqual(['checkout', 'main'])
    expect(createBranchArgs('feature')).toEqual(['checkout', '-b', 'feature'])
  })

  it('push adds -u origin <branch> only when there is no upstream yet', () => {
    expect(pushArgs('main', false)).toEqual(['push', '-u', 'origin', 'main'])
    expect(pushArgs('main', true)).toEqual(['push'])
  })

  it('pull/init/clone', () => {
    expect(pullArgs()).toEqual(['pull'])
    expect(initArgs()).toEqual(['init'])
    expect(cloneArgs('https://example.test/repo.git', '/tmp/repo')).toEqual(['clone', 'https://example.test/repo.git', '/tmp/repo'])
  })

  it('log adds a path filter only when given one', () => {
    expect(logArgs(50)).toEqual(['log', '-z', expect.stringContaining('--pretty=format:'), '-n50'])
    expect(logArgs(50, 'src/x.c')).toEqual(expect.arrayContaining(['--', 'src/x.c']))
  })

  it('show reads the index with a bare `:path`, else `<ref>:path`', () => {
    expect(showArgs('INDEX', 'a.c')).toEqual(['show', ':a.c'])
    expect(showArgs('HEAD', 'a.c')).toEqual(['show', 'HEAD:a.c'])
    expect(showArgs('abc123', 'a.c')).toEqual(['show', 'abc123:a.c'])
  })
})

describe('isGitMissing', () => {
  it('is true only for an ENOENT error (the git binary itself is missing)', () => {
    expect(isGitMissing(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }))).toBe(true)
    expect(isGitMissing(Object.assign(new Error('not a repo'), { code: 128 }))).toBe(false)
    expect(isGitMissing(new Error('anything'))).toBe(false)
    expect(isGitMissing(null)).toBe(false)
  })
})

describe('STARTER_GITIGNORE', () => {
  it('matches Spec 03´s project-wizard .gitignore', () => {
    expect(STARTER_GITIGNORE).toBe('out/\nemul/\n.msxdevstudio/\n')
  })
})
