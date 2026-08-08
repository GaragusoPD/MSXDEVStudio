/**
 * The bundled documentation — `docs/` and the demo walkthroughs — as they ship
 * inside the app.
 *
 * The renderer reads them over a `docs://app/<path>` scheme rather than an IPC
 * channel, because a documentation page is mostly *links and images*: served as
 * a URL, `<img src>` and relative-link resolution are the browser's job instead
 * of ours, and the same code path works in dev (renderer on `http://localhost`)
 * and packaged (renderer on `file://`, docs inside the asar), which a bare
 * `file://` src does not.
 *
 * **The scheme mirrors the repository layout**, not the `docs/` folder: a page
 * is `docs/index.md`, a walkthrough is `demo_msx1/README.md`. That is what lets
 * the demo READMEs — which sit beside `docs/` and reach back into it for their
 * screenshots (`../docs/images/…`) — render unchanged in the app and on GitHub.
 * Rooting at `docs/` instead made everything outside it unreachable, and any
 * link that pointed there silently 404'd.
 *
 * Two subtrees are mounted, because packaging splits them: `docs/` is inside
 * the asar, and the demos are `extraResources` beside it so they can be copied
 * out (see `demos.ts`). In development both are the repo root, so no
 * special-casing applies there at all.
 *
 * Everything here is the pure half: turning a request URL into a path on disk,
 * and refusing everything the app does not mean to publish.
 */
import { join, normalize, resolve, sep } from 'node:path'
import { DOCS_HOST } from '../../shared/docs'
import { DEMO_PROJECTS } from './demos'

/** The only top-level folder of `docs/` content. */
const DOCS_DIR = 'docs'

export interface DocsMounts {
  /** Holds `docs/` — the asar when packaged, the repo root in development. */
  root: string
  /** Holds the demo folders — `resources/demos/` when packaged, the repo root otherwise. */
  demos: string
}

/**
 * Where each subtree is at runtime. `appPath` is `app.getAppPath()` and
 * `resourcesPath` is `process.resourcesPath`.
 */
export function docsMounts(packaged: boolean, appPath: string, resourcesPath: string): DocsMounts {
  return { root: appPath, demos: packaged ? join(resourcesPath, 'demos') : appPath }
}

/**
 * The top-level names the scheme will serve. Anything else — `src/`,
 * `node_modules/`, `package.json`, and in development the whole working tree —
 * is not documentation and is refused before a path is even built.
 */
export function isPublishedTopLevel(segment: string): boolean {
  return segment === DOCS_DIR || DEMO_PROJECTS.some((demo) => demo.id === segment)
}

/**
 * Absolute path for a `docs://` request, or `null` if it names anything the app
 * does not publish.
 *
 * The URL is untrusted — a page could carry `![](../../../etc/passwd)` — so the
 * result is checked for containment in the subtree it claimed, and the
 * top-level name is whitelisted rather than merely filtered.
 */
export function resolveDocRequest(mounts: DocsMounts, url: string): string | null {
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
  return resolveDocPath(mounts, relative)
}

/**
 * Same rules as {@link resolveDocRequest}, for a path that did not arrive as a
 * URL. `relative` is treated as relative to the package root even when it
 * starts with a separator — the scheme's pathname always does.
 */
export function resolveDocPath(mounts: DocsMounts, relative: string): string | null {
  // A NUL byte truncates the path in some syscalls; reject rather than trim.
  if (relative.includes('\0')) return null

  // Strip leading separators so an absolute-looking pathname stays inside the
  // root rather than replacing it, then let `normalize` collapse any `..`.
  const cleaned = normalize(relative).replace(/^[/\\]+/, '')
  const [top] = cleaned.split(/[/\\]/)
  if (!isPublishedTopLevel(top)) return null

  // `docs/` and the demos live in different places once packaged; a demo path
  // is rebased onto its own mount, keeping its `demo_msx1/…` prefix so both
  // layouts address it identically.
  const base = resolve(top === DOCS_DIR ? mounts.root : mounts.demos)
  const target = resolve(base, cleaned)

  return target === base || target.startsWith(base + sep) ? target : null
}
