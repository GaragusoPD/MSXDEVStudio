/**
 * Path-safety guard for the `fs:*` IPC channels — the trust boundary between
 * the (untrusted-ish) renderer and real disk access in the main process.
 * Every `fs:*` handler must resolve its `path` argument through this before
 * touching disk.
 *
 * Kept dependency-free (no `node:path`) so it runs identically on any OS and
 * in a plain Vitest run, matching the convention in `state.ts`.
 */

/** Directory names never surfaced by the explorer, watcher, or search. */
export const IGNORED_DIR_NAMES = ['node_modules', 'out', 'emul', '.git', '.msxdevstudio']

/**
 * Normalizes a (possibly untrusted) project-relative path: resolves `.` and
 * `..` segments, strips any leading slash/drive-letter styling (treating it
 * as relative rather than OS-absolute), and rejects any path that would
 * climb above the root via `..`. Returns `null` when the path escapes the
 * root; otherwise a forward-slash relative path with no leading/trailing
 * slash (`''` for the root itself).
 */
export function resolveRelativePath(relativePath: string): string | null {
  // These arrive over IPC, so "a string" is an assumption rather than a fact.
  // A missing path used to reach `.split` and surface as a TypeError from deep
  // inside the fs service, which says nothing about what actually went wrong.
  if (typeof relativePath !== 'string') return null
  const segments = relativePath.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== '.')
  const stack: string[] = []
  for (const segment of segments) {
    if (segment === '..') {
      if (stack.length === 0) return null
      stack.pop()
    } else {
      stack.push(segment)
    }
  }
  return stack.join('/')
}

/** True if `name` (a single path segment, e.g. a directory entry) should be
 *  hidden from the tree, watcher, and search. */
export function isIgnoredName(name: string): boolean {
  return IGNORED_DIR_NAMES.includes(name)
}
