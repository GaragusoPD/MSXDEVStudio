/**
 * The `docs://` scheme, shared by the main process (which serves it) and the
 * renderer (which builds URLs for it). Dependency-free so both can import it.
 *
 * `docs://app/<path>` addresses a published file by its **repo-relative** path
 * — `docs/index.md`, `docs/images/editor_welcome_tab.png`,
 * `demo_msx1/README.md`. Keeping the shape identical to the repository is what
 * lets every page's own relative links resolve without a lookup table, including
 * the demo READMEs reaching back into `docs/images/` for their screenshots.
 */

/** The one host the scheme serves. */
export const DOCS_HOST = 'app'

export const DOCS_ORIGIN = `docs://${DOCS_HOST}`

/** Landing page — what `Help ▸ Documentation` opens. */
export const DOCS_INDEX = 'docs/index.md'

/** What `Help ▸ Tutorials` opens. */
export const DOCS_TUTORIALS = 'docs/tutorials/README.md'

/** The demo walkthroughs, reachable because the scheme mirrors the repo. */
export const DOCS_DEMOS = 'docs/demos.md'

/** Absolute `docs://` URL for a root-relative documentation path. */
export function docsUrl(path: string): string {
  return new URL(path.replace(/^\/+/, ''), `${DOCS_ORIGIN}/`).toString()
}

/**
 * The root-relative documentation path a URL points at, or `null` if it points
 * somewhere else (an `https:` link, a `file:` link a page should not follow).
 * The inverse of {@link docsUrl}, and how the viewer decides whether a clicked
 * link navigates in place or goes out to the browser.
 */
export function docsPathFromUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'docs:' || parsed.host !== DOCS_HOST) return null
  return decodeURIComponent(parsed.pathname).replace(/^\/+/, '')
}

/** Whether a documentation path is a page the viewer can render itself. */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path)
}
