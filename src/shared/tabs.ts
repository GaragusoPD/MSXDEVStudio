/**
 * Pure tab-ordering and tab-persistence helpers, kept dependency-free like
 * `state.ts` so `tabsStore` (Pinia, has side effects) can stay a thin
 * wrapper around logic that's cheap to unit-test here.
 */

/** Moves `id` to the front of a most-recently-used order, adding it if new. */
export function touchMru(order: string[], id: string): string[] {
  return [id, ...order.filter((x) => x !== id)]
}

/** Removes `id` from an MRU order (e.g. on tab close). */
export function removeMru(order: string[], id: string): string[] {
  return order.filter((x) => x !== id)
}

/**
 * The tab to switch to on Ctrl+Tab: the most-recently-used tab that isn't
 * the current one — a simple "toggle to previous" rather than a full
 * VS Code-style cycling switcher (which needs a visible popup to be usable
 * across more than two tabs; add one if that's ever requested).
 */
export function nextMru(order: string[], currentId: string | undefined): string | undefined {
  return order.find((id) => id !== currentId) ?? currentId
}

/** Contents of `<project>/.msxdevstudio/state.json` — volatile, gitignored IDE state. */
export interface ProjectTabsState {
  /** Root-relative file paths of open tabs, in tab-strip order. */
  openPaths: string[]
  activePath: string | null
}
