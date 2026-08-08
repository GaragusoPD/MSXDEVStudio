/**
 * The one Documentation tab and where it is currently pointed.
 *
 * There is deliberately a *single* tab rather than one per page: following a
 * link inside the docs navigates in place and pushes onto a history, the way a
 * help viewer behaves, instead of leaving a trail of tabs behind. The current
 * page therefore cannot live in the tab id, so it lives here — the same shape
 * the resource editors use for their per-path sessions.
 */
import { computed, ref } from 'vue'
import { DOCS_INDEX } from '../../../../shared/docs'
import { useTabsStore } from '../../stores/tabsStore'

export const DOCS_TAB_ID = 'docs'

/** Visited pages, oldest first; the last one is what the tab shows. */
const history = ref<string[]>([DOCS_INDEX])

export const currentPath = computed(() => history.value[history.value.length - 1])
export const canGoBack = computed(() => history.value.length > 1)

function openTab(): void {
  useTabsStore().open({
    id: DOCS_TAB_ID,
    title: 'Documentation',
    extension: 'docs',
    dirty: false,
    closable: true
  })
}

/**
 * Opens the docs at `path` (root-relative, e.g. `tutorials/README.md`) and
 * focuses the tab. Asking for the page already shown just focuses it, so
 * hitting the menu item twice doesn't stack duplicate history entries.
 */
export function openDocs(path: string): void {
  if (currentPath.value !== path) history.value.push(path)
  openTab()
}

/** Follows a link inside the docs; the tab is already open and focused. */
export function navigate(path: string): void {
  if (currentPath.value !== path) history.value.push(path)
}

export function back(): void {
  if (canGoBack.value) history.value.pop()
}

export function home(): void {
  navigate(DOCS_INDEX)
}
