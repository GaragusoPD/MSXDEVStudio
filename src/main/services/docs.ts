/**
 * The bundled user documentation — `docs/` as it ships inside the app.
 *
 * The renderer reads it over a `docs://app/<path>` scheme rather than an IPC
 * channel, because a documentation page is mostly *links and images*: served
 * as a URL, `<img src>` and relative-link resolution are the browser's job
 * instead of ours, and the same code path works in dev (renderer on
 * `http://localhost`) and packaged (renderer on `file://`, docs inside the
 * asar), which a bare `file://` src does not.
 *
 * Everything here is the pure half: turning a request URL into a path on disk,
 * and refusing the ones that try to leave `docs/`.
 */
import { join, normalize, resolve, sep } from 'node:path'
import { DOCS_HOST } from '../../shared/docs'

/**
 * Absolute path for a `docs://` request, or `null` if it names anything the
 * docs root does not contain.
 *
 * `root` is trusted (the app's own `docs/`); `url` is not — a page could carry
 * `![](../../../etc/passwd)` and the scheme handler must not follow it. The
 * containment check is done on the resolved path, so `..` segments, encoded
 * ones (`%2e%2e`) and absolute-looking paths are all caught by the same test.
 */
export function resolveDocRequest(root: string, url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'docs:' || parsed.host !== DOCS_HOST) return null

  let relative: string
  try {
    relative = decodeURIComponent(parsed.pathname)
  } catch {
    return null // malformed percent-escape
  }
  return resolveDocPath(root, relative)
}

/**
 * Same containment rule as {@link resolveDocRequest}, for a path that did not
 * arrive as a URL. `relative` is treated as relative to the docs root even
 * when it starts with a separator — the scheme's pathname always does.
 */
export function resolveDocPath(root: string, relative: string): string | null {
  // A NUL byte truncates the path in some syscalls; reject rather than trim.
  if (relative.includes('\0')) return null

  const base = resolve(root)
  // Strip leading separators so an absolute-looking pathname stays inside the
  // root rather than replacing it, then let `resolve` collapse any `..`.
  const target = resolve(base, normalize(relative).replace(/^[/\\]+/, ''))

  return target === base || target.startsWith(base + sep) ? target : null
}

/** Where `docs/` sits at runtime — beside the app code in dev and in the asar. */
export function docsRoot(appPath: string): string {
  return join(appPath, 'docs')
}
