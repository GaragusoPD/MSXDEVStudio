/**
 * Pure app-state helpers, kept dependency-free so they can run in main,
 * renderer, or a test runner unchanged.
 */

/**
 * Moves `projectPath` to the front of `recent`, de-duplicating, capped at `max`.
 */
export function pushRecentProject(recent: string[], projectPath: string, max = 10): string[] {
  return [projectPath, ...recent.filter((p) => p !== projectPath)].slice(0, max)
}
