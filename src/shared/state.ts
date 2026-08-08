/**
 * Pure app-state helpers, kept dependency-free so they can run in main,
 * renderer, or a test runner unchanged.
 */

/** How many recent projects the Welcome tab lists; the oldest drops off. */
export const MAX_RECENT_PROJECTS = 6

/**
 * Moves `projectPath` to the front of `recent`, de-duplicating, capped at `max`.
 * Capping here rather than in the Welcome tab means the oldest entry is really
 * evicted, instead of being hidden but kept in the stored state forever.
 */
export function pushRecentProject(recent: string[], projectPath: string, max = MAX_RECENT_PROJECTS): string[] {
  return [projectPath, ...recent.filter((p) => p !== projectPath)].slice(0, max)
}
