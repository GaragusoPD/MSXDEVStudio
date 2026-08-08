import { describe, expect, it } from 'vitest'
import { resolve, sep } from 'node:path'
import { docsRoot, resolveDocPath, resolveDocRequest } from './docs'

const ROOT = resolve('/app/docs')
const inRoot = (...parts: string[]): string => [ROOT, ...parts].join(sep)

describe('resolveDocRequest', () => {
  it('maps a docs:// URL onto a file under the root', () => {
    expect(resolveDocRequest(ROOT, 'docs://app/tutorials/01-hello-world.md')).toBe(
      inRoot('tutorials', '01-hello-world.md')
    )
  })

  it('serves the root itself for an empty path', () => {
    expect(resolveDocRequest(ROOT, 'docs://app/')).toBe(ROOT)
  })

  it('decodes percent-escapes in the path', () => {
    expect(resolveDocRequest(ROOT, 'docs://app/images/a%20b.png')).toBe(inRoot('images', 'a b.png'))
  })

  it('drops the query and fragment a link may carry', () => {
    expect(resolveDocRequest(ROOT, 'docs://app/resources.md#exporting')).toBe(inRoot('resources.md'))
  })

  it.each([
    ['another host', 'docs://elsewhere/index.md'],
    ['another scheme', 'file:///etc/passwd'],
    ['a malformed escape', 'docs://app/%zz'],
    ['a non-URL', 'not a url']
  ])('refuses %s', (_label, url) => {
    expect(resolveDocRequest(ROOT, url)).toBeNull()
  })

  it.each([
    ['a plain traversal', 'docs://app/../../etc/passwd', 'etc/passwd'],
    ['an encoded one', 'docs://app/%2e%2e/%2e%2e/etc/passwd', 'etc/passwd'],
    ['one hidden mid-path', 'docs://app/tutorials/../../secrets.txt', 'secrets.txt'],
    // `%2f` is the one escape URL parsing leaves alone — the `..` it hides only
    // appears after decoding. `normalize()` then clamps it at its own root, so
    // it lands inside `docs/` rather than beside it.
    ['one behind encoded slashes', 'docs://app/a%2f..%2f..%2fetc/passwd', 'etc/passwd']
  ])('clamps %s to the root rather than escaping', (_label, url, expected) => {
    // Two independent mechanisms already neuter these before the containment
    // check runs. Asserted so that a future switch to a raw-path API, or
    // dropping the `normalize()`, fails here instead of shipping a hole.
    expect(resolveDocRequest(ROOT, url)).toBe(inRoot(...expected.split('/')))
  })

  it('allows a `..` that stays inside the root', () => {
    expect(resolveDocRequest(ROOT, 'docs://app/tutorials/../resources.md')).toBe(inRoot('resources.md'))
  })

  it('does not let a sibling directory pass the prefix test', () => {
    // `/app/docs-private` shares the root's string prefix but is not inside it.
    expect(resolveDocPath(ROOT, '../docs-private/secret.md')).toBeNull()
  })
})

describe('resolveDocPath', () => {
  it('treats a leading separator as root-relative, not absolute', () => {
    expect(resolveDocPath(ROOT, '/index.md')).toBe(inRoot('index.md'))
  })

  it('rejects an embedded NUL', () => {
    expect(resolveDocPath(ROOT, 'index.md\0.png')).toBeNull()
  })
})

describe('docsRoot', () => {
  it('sits beside the app code, so dev and asar resolve the same way', () => {
    expect(docsRoot(resolve('/app'))).toBe(resolve('/app', 'docs'))
  })
})
