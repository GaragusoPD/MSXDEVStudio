import { defineStore } from 'pinia'
import type { GitBranch, GitFileStatus, GitLogEntry, GitStatus } from '../../../shared/ipc'
import { useAppStore } from './appStore'
import { useOutputStore } from './outputStore'
import { useTabsStore } from './tabsStore'

function emptyStatus(): GitStatus {
  return {
    isRepo: false,
    gitAvailable: true,
    branch: null,
    detached: false,
    initial: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    files: []
  }
}

/**
 * The folder name a clone URL becomes: the last path segment, minus a trailing
 * `.git` or slashes. Lives here rather than in `GitPanel.vue` because `.vue`
 * files are outside vitest and this is string munging with edge cases —
 * `ssh://` forms, a trailing slash, a bare host.
 */
export function repoNameFromUrl(url: string): string {
  const cleaned = url.trim().replace(/\/+$/, '').replace(/\.git$/, '')
  return cleaned.split(/[/\\]/).pop() || 'repository'
}

export interface DiffRequest {
  path: string
  staged: boolean
  origPath?: string
}

/**
 * The renderer's view of Spec 06's GitService: current status (mirrored via
 * the `git:changed` push event, same pattern as `fs:changed`), branches, and
 * commit log. Diff-tab requests are kept here (keyed by tab id) rather than
 * added to `tabsStore.EditorTab`, so `GitDiffTab.vue` can look up what to
 * diff without growing the generic tab shape every editor type would have to
 * carry a field for.
 */
export const useGitStore = defineStore('git', {
  state: () => ({
    status: emptyStatus(),
    branches: [] as GitBranch[],
    log: [] as GitLogEntry[],
    commitMessage: '',
    amend: false,
    branchPickerOpen: false,
    /** The clone dialog — `window.prompt` throws in Electron, so a URL needs a real modal. */
    cloneVisible: false,
    expandedCommit: null as string | null,
    subscribed: false,
    diffRequests: {} as Record<string, DiffRequest>
  }),

  getters: {
    staged: (state): GitFileStatus[] => state.status.files.filter((f) => !f.conflicted && f.staged !== null),
    unstaged: (state): GitFileStatus[] => state.status.files.filter((f) => !f.conflicted && f.unstaged !== null),
    conflicts: (state): GitFileStatus[] => state.status.files.filter((f) => f.conflicted),
    branchLabel: (state): string => (state.status.detached ? 'detached' : (state.status.branch ?? ''))
  },

  actions: {
    /** Subscribes to main-pushed status refreshes; called once from App.vue (same pattern as buildStore.init()). */
    init(): void {
      if (this.subscribed) return
      this.subscribed = true
      window.api.on('git:changed', (status) => {
        this.status = status
      })
      // Every project switch needs a fresh read — main only pushes `git:changed` on mutations/watcher events.
      window.api.on('project:changed', () => void this.refresh())
    },

    async refresh(): Promise<void> {
      this.status = await window.api.invoke('git:status', undefined)
    },

    async stage(paths: string[]): Promise<void> {
      this.status = await window.api.invoke('git:stage', { paths })
    },

    async unstage(paths: string[]): Promise<void> {
      this.status = await window.api.invoke('git:unstage', { paths })
    },

    /** Renderer-side confirm happens at the call site (destructive — see spec 06). */
    async discard(paths: string[]): Promise<void> {
      this.status = await window.api.invoke('git:discard', { paths })
    },

    async commit(): Promise<void> {
      const message = this.commitMessage.trim()
      if (!message) return
      try {
        this.status = await window.api.invoke('git:commit', { message, amend: this.amend })
        this.commitMessage = ''
        this.amend = false
      } catch (error) {
        window.alert(`Couldn't commit: ${String(error)}`)
      }
    },

    /** Prefills the commit box with the last commit's message so it's ready to edit. */
    async startAmend(): Promise<void> {
      this.amend = true
      if (this.commitMessage.trim()) return
      const [last] = await window.api.invoke('git:log', { limit: 1 })
      if (last) this.commitMessage = last.body ? `${last.subject}\n\n${last.body}` : last.subject
    },

    cancelAmend(): void {
      this.amend = false
    },

    async loadLog(): Promise<void> {
      this.log = await window.api.invoke('git:log', { limit: 100 })
    },

    toggleCommit(hash: string): void {
      this.expandedCommit = this.expandedCommit === hash ? null : hash
    },

    async loadBranches(): Promise<void> {
      this.branches = await window.api.invoke('git:branches', undefined)
    },

    async checkout(name: string): Promise<void> {
      try {
        this.status = await window.api.invoke('git:checkout', { name })
        this.branchPickerOpen = false
      } catch (error) {
        window.alert(`Couldn't switch to "${name}": ${String(error)}`)
      }
    },

    async createBranch(name: string): Promise<void> {
      try {
        this.status = await window.api.invoke('git:createBranch', { name })
        this.branchPickerOpen = false
      } catch (error) {
        window.alert(`Couldn't create branch "${name}": ${String(error)}`)
      }
    },

    async push(): Promise<void> {
      const result = await window.api.invoke('git:push', undefined)
      if (!result.ok) this.reportFailure('Push', result.stderr)
    },

    async pull(): Promise<void> {
      const result = await window.api.invoke('git:pull', undefined)
      if (!result.ok) this.reportFailure('Pull', result.stderr)
    },

    reportFailure(op: string, stderr: string): void {
      const outputStore = useOutputStore()
      outputStore.append('git', `${op} failed:`)
      for (const line of stderr.split('\n')) if (line.trim()) outputStore.append('git', line)
      useAppStore().showBottomPanel('output')
    },

    async initRepo(): Promise<void> {
      try {
        this.status = await window.api.invoke('git:init', undefined)
      } catch (error) {
        window.alert(`Couldn't initialize the repository: ${String(error)}`)
      }
    },

    async cloneRepo(url: string, targetDir: string): Promise<boolean> {
      try {
        await window.api.invoke('git:clone', { url, targetDir })
        return true
      } catch (error) {
        window.alert(`Couldn't clone "${url}": ${String(error)}`)
        return false
      }
    },

    /** Opens (or activates) a read-only Monaco diff tab for `path` — registry entry `git-diff`. */
    openDiff(path: string, staged: boolean, origPath?: string): void {
      const id = `git-diff:${staged ? 'staged' : 'work'}:${path}`
      this.diffRequests[id] = { path, staged, origPath }
      const name = path.split('/').pop() ?? path
      useTabsStore().open({
        id,
        title: `${name} (${staged ? 'Staged' : 'Working Tree'})`,
        extension: 'git-diff',
        dirty: false,
        closable: true
      })
    }
  }
})
