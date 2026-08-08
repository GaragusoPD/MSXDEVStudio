import { describe, expect, it } from 'vitest'
import { join, resolve, sep } from 'node:path'
import { docsMounts, isPublishedTopLevel, resolveDocPath, resolveDocRequest, type DocsMounts } from './docs'

const ROOT = resolve('/app')
const DEMOS = resolve('/app/resources/demos')

/** Packaged: `docs/` in the asar, the demos beside it in extraResources. */
const SPLIT: DocsMounts = { root: ROOT, demos: DEMOS }
/** Development: one tree, the repo root. */
const REPO: DocsMounts = { root: ROOT, demos: ROOT }

const inDocs = (...parts: string[]): string => [ROOT, 'docs', ...parts].join(sep)

describe('docsMounts', () => {
  it('is a single tree in development, so nothing is special-cased there', () => {
    expect(docsMounts(false, ROOT, resolve('/elsewhere'))).toEqual({ root: ROOT, demos: ROOT })
  })

  it('splits the demos out to extraResources when packaged', () => {
    const mounts = docsMounts(true, resolve('/app.asar'), resolve('/res'))
    expect(mounts).toEqual({ root: resolve('/app.asar'), demos: join(resolve('/res'), 'demos') })
  })
})

describe('isPublishedTopLevel', () => {
  it.each(['docs', 'demo_msx1', 'demo_msx2'])('publishes %s', (name) => {
    expect(isPublishedTopLevel(name)).toBe(true)
  })

  it.each(['src', 'node_modules', 'out', 'package.json', '.git', ''])('refuses %s', (name) => {
    expect(isPublishedTopLevel(name)).toBe(false)
  })
})

describe('resolveDocRequest', () => {
  it('maps a docs page onto the root mount', () => {
    expect(resolveDocRequest(SPLIT, 'docs://app/docs/tutorials/01-hello-world.md')).toBe(
      inDocs('tutorials', '01-hello-world.md')
    )
  })

  it('maps a demo walkthrough onto the demos mount, keeping its folder name', () => {
    expect(resolveDocRequest(SPLIT, 'docs://app/demo_msx1/README.md')).toBe(
      [DEMOS, 'demo_msx1', 'README.md'].join(sep)
    )
  })

  it('resolves both from one tree in development', () => {
    expect(resolveDocRequest(REPO, 'docs://app/demo_msx2/README.md')).toBe(
      [ROOT, 'demo_msx2', 'README.md'].join(sep)
    )
    expect(resolveDocRequest(REPO, 'docs://app/docs/index.md')).toBe(inDocs('index.md'))
  })

  it("resolves a demo README's reach back into docs/images, the link that made this necessary", () => {
    // `![](../docs/images/x.png)` from `demo_msx1/README.md` — the browser
    // resolves it against the page URL before we ever see it.
    const fromDemo = new URL('../docs/images/demo_msx1_title.png', 'docs://app/demo_msx1/README.md')
    expect(fromDemo.toString()).toBe('docs://app/docs/images/demo_msx1_title.png')
    expect(resolveDocRequest(SPLIT, fromDemo.toString())).toBe(inDocs('images', 'demo_msx1_title.png'))
  })

  it('decodes percent-escapes, and drops query and fragment', () => {
    expect(resolveDocRequest(SPLIT, 'docs://app/docs/images/a%20b.png')).toBe(inDocs('images', 'a b.png'))
    expect(resolveDocRequest(SPLIT, 'docs://app/docs/resources.md#exporting')).toBe(inDocs('resources.md'))
  })

  it.each([
    ['the repo root itself', 'docs://app/'],
    ['application source', 'docs://app/src/main/index.ts'],
    ['dependencies', 'docs://app/node_modules/marked/package.json'],
    ['build output', 'docs://app/out/main/index.js'],
    ['a traversal that lands outside anything published', 'docs://app/../../etc/passwd'],
    ['an encoded traversal', 'docs://app/%2e%2e/%2e%2e/etc/passwd'],
    ['a traversal behind encoded slashes', 'docs://app/a%2f..%2f..%2fetc/passwd'],
    ['another host', 'docs://elsewhere/docs/index.md'],
    ['another scheme', 'file:///etc/passwd'],
    ['a malformed escape', 'docs://app/%zz'],
    ['a non-URL', 'not a url']
  ])('refuses %s', (_label, url) => {
    expect(resolveDocRequest(SPLIT, url)).toBeNull()
  })

  it('allows a `..` that stays inside a published subtree', () => {
    expect(resolveDocRequest(SPLIT, 'docs://app/docs/tutorials/../resources.md')).toBe(inDocs('resources.md'))
  })
})

describe('resolveDocPath', () => {
  it('treats a leading separator as root-relative, not absolute', () => {
    expect(resolveDocPath(SPLIT, '/docs/index.md')).toBe(inDocs('index.md'))
  })

  it('rejects an embedded NUL', () => {
    expect(resolveDocPath(SPLIT, 'docs/index.md\0.png')).toBeNull()
  })

  it('does not let a sibling directory pass the prefix test', () => {
    // `/app/resources/demos-private` shares the demos mount's string prefix.
    expect(resolveDocPath(SPLIT, 'demo_msx1/../../demos-private/secret.md')).toBeNull()
  })
})
