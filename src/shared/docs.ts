/**
 * The `docs://` scheme, shared by the main process (which serves it) and the
 * renderer (which builds URLs for it). Dependency-free so both can import it.
 *
 * `docs://app/<path>` addresses a file under the app's bundled `docs/` folder,
 * `<path>` being exactly the repo-relative path — `tutorials/README.md`,
 * `images/editor_welcome_tab.png`. Keeping the shape identical to the folder
 * is what lets a page's own relative links resolve without a lookup table.
 */

/** The one host the scheme serves. */
export const DOCS_HOST = 'app'

export const DOCS_ORIGIN = `docs://${DOCS_HOST}`

/** Landing page — what `Help ▸ Documentation` opens. */
export const DOCS_INDEX = 'index.md'

/** What `Help ▸ Tutorials` opens. */
export const DOCS_TUTORIALS = 'tutorials/README.md'

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
