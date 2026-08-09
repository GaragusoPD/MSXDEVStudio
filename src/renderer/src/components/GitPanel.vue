<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { GitChangeCode, GitFileStatus } from '../../../shared/ipc'
import { useGitStore } from '../stores/gitStore'
import { useProjectStore } from '../stores/projectStore'
import { useTabsStore } from '../stores/tabsStore'
import { useToolchainStore } from '../stores/toolchainStore'
import Icon from './Icon.vue'

const gitStore = useGitStore()
const projectStore = useProjectStore()
const tabsStore = useTabsStore()
const toolchainStore = useToolchainStore()

const historyOpen = ref(false)
const busy = ref(false)

const installHint = computed(() => {
  const platform = toolchainStore.status?.platform
  if (platform === 'win32') return 'Install Git from git-scm.com, then restart MSXDEVStudio.'
  if (platform === 'linux') return "Install git via your distro's package manager, e.g. `apt install git`."
  return 'Install git, then restart MSXDEVStudio.'
})

async function refresh(): Promise<void> {
  if (projectStore.currentProjectPath) await gitStore.refresh()
}

onMounted(refresh)
watch(() => projectStore.currentProjectPath, refresh)
watch(historyOpen, (open) => {
  if (open && !gitStore.log.length) void gitStore.loadLog()
})

function onCommitKeydown(event: KeyboardEvent): void {
  if (event.ctrlKey && event.key === 'Enter') void gitStore.commit()
}

function onAmendToggle(event: Event): void {
  if ((event.target as HTMLInputElement).checked) void gitStore.startAmend()
  else gitStore.cancelAmend()
}

const BADGE_LABEL: Record<GitChangeCode, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  typechange: 'T',
  untracked: 'U'
}
const BADGE_COLOR: Record<GitChangeCode, string> = {
  added: '#3dc98f',
  modified: '#c9a63d',
  deleted: '#e06c75',
  renamed: '#8a5ac9',
  copied: '#8a5ac9',
  typechange: '#5a5a5a',
  untracked: '#5a5a5a'
}

function badge(file: GitFileStatus, group: 'staged' | 'unstaged'): { label: string; color: string } {
  const code = group === 'staged' ? file.staged : file.unstaged
  return code ? { label: BADGE_LABEL[code], color: BADGE_COLOR[code] } : { label: '', color: '' }
}

async function discardOne(file: GitFileStatus): Promise<void> {
  if (!window.confirm(`Discard changes in "${file.path}"? This can't be undone.`)) return
  await gitStore.discard([file.path])
}

function openConflicted(path: string): void {
  tabsStore.openFile(path, path.split('/').pop() ?? path)
}

/** No dedicated dialog — a URL prompt + folder picker is enough for an occasional clone. */
function repoNameFromUrl(url: string): string {
  const cleaned = url.trim().replace(/\/+$/, '').replace(/\.git$/, '')
  return cleaned.split(/[/\\]/).pop() || 'repository'
}

async function cloneRepo(): Promise<void> {
  const url = window.prompt('Repository URL to clone:')
  if (!url?.trim()) return
  const parent = await toolchainStore.pickFolder()
  if (!parent) return
  const target = `${parent}/${repoNameFromUrl(url)}`
  busy.value = true
  try {
    const ok = await gitStore.cloneRepo(url.trim(), target)
    if (ok) await projectStore.openProject(target)
  } finally {
    busy.value = false
  }
}

async function initRepo(): Promise<void> {
  busy.value = true
  try {
    await gitStore.initRepo()
  } finally {
    busy.value = false
  }
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31536000],
  ['month', 2592000],
  ['week', 604800],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60]
]

function relativeDate(iso: string): string {
  const diffSec = Math.round((new Date(iso).getTime() - Date.now()) / 1000)
  for (const [unit, secs] of RELATIVE_UNITS) {
    if (Math.abs(diffSec) >= secs) return rtf.format(Math.round(diffSec / secs), unit)
  }
  return rtf.format(diffSec, 'second')
}
</script>

<template>
  <div class="git-panel">
    <h2 class="header">
      Source Control
    </h2>

    <div
      v-if="!projectStore.currentProjectPath"
      class="empty"
    >
      <p>No project is open.</p>
    </div>

    <div
      v-else-if="!gitStore.status.gitAvailable"
      class="empty"
    >
      <p>Git isn't installed, or isn't on PATH.</p>
      <p class="hint">
        {{ installHint }}
      </p>
    </div>

    <div
      v-else-if="!gitStore.status.isRepo"
      class="empty"
    >
      <p>This folder isn't a git repository yet.</p>
      <div class="empty-actions">
        <button
          type="button"
          class="primary"
          :disabled="busy"
          @click="initRepo"
        >
          Initialize Repository
        </button>
        <button
          type="button"
          :disabled="busy"
          @click="cloneRepo"
        >
          Clone Repository…
        </button>
      </div>
    </div>

    <div
      v-else
      class="content"
    >
      <div class="commit-box">
        <textarea
          v-model="gitStore.commitMessage"
          class="commit-message"
          placeholder="Commit message (Ctrl+Enter to commit)"
          rows="3"
          @keydown="onCommitKeydown"
        />
        <div class="commit-actions">
          <label class="inline">
            <input
              type="checkbox"
              :checked="gitStore.amend"
              @change="onAmendToggle($event)"
            >
            <span>Amend</span>
          </label>
          <button
            type="button"
            class="primary"
            :disabled="!gitStore.commitMessage.trim()"
            @click="gitStore.commit()"
          >
            Commit
          </button>
        </div>
      </div>

      <section
        v-if="gitStore.conflicts.length"
        class="group"
      >
        <h3>Merge Conflicts ({{ gitStore.conflicts.length }})</h3>
        <div
          v-for="file in gitStore.conflicts"
          :key="file.path"
          class="file-row"
          @click="openConflicted(file.path)"
        >
          <span
            class="badge"
            style="background: #e06c75"
          >!</span>
          <span class="path">{{ file.path }}</span>
          <button
            type="button"
            class="action"
            title="Mark resolved"
            @click.stop="gitStore.stage([file.path])"
          >
            <Icon
              name="check"
              :size="14"
            />
          </button>
        </div>
      </section>

      <section class="group">
        <h3>Staged Changes ({{ gitStore.staged.length }})</h3>
        <p
          v-if="!gitStore.staged.length"
          class="hint"
        >
          Nothing staged.
        </p>
        <div
          v-for="file in gitStore.staged"
          :key="`s${file.path}`"
          class="file-row"
          @click="gitStore.openDiff(file.path, true, file.origPath)"
        >
          <span
            class="badge"
            :style="{ background: badge(file, 'staged').color }"
          >{{ badge(file, 'staged').label }}</span>
          <span class="path">{{ file.path }}</span>
          <button
            type="button"
            class="action"
            title="Unstage"
            @click.stop="gitStore.unstage([file.path])"
          >
            <Icon
              name="remove"
              :size="14"
            />
          </button>
        </div>
      </section>

      <section class="group">
        <h3>
          Changes ({{ gitStore.unstaged.length }})
          <button
            v-if="gitStore.unstaged.length"
            type="button"
            class="action"
            title="Stage all changes"
            @click="gitStore.stage(gitStore.unstaged.map((f) => f.path))"
          >
            <Icon
              name="add"
              :size="14"
            />
          </button>
        </h3>
        <p
          v-if="!gitStore.unstaged.length"
          class="hint"
        >
          No changes.
        </p>
        <div
          v-for="file in gitStore.unstaged"
          :key="`u${file.path}`"
          class="file-row"
          @click="gitStore.openDiff(file.path, false, file.origPath)"
        >
          <span
            class="badge"
            :style="{ background: badge(file, 'unstaged').color }"
          >{{ badge(file, 'unstaged').label }}</span>
          <span class="path">{{ file.path }}</span>
          <button
            type="button"
            class="action"
            title="Stage"
            @click.stop="gitStore.stage([file.path])"
          >
            <Icon
              name="add"
              :size="14"
            />
          </button>
          <button
            type="button"
            class="action"
            title="Discard changes"
            @click.stop="discardOne(file)"
          >
            <Icon
              name="undo"
              :size="14"
            />
          </button>
        </div>
      </section>

      <section class="group">
        <button
          type="button"
          class="history-toggle"
          @click="historyOpen = !historyOpen"
        >
          {{ historyOpen ? '▾' : '▸' }} History
        </button>
        <div
          v-if="historyOpen"
          class="history"
        >
          <p
            v-if="!gitStore.log.length"
            class="hint"
          >
            No commits yet.
          </p>
          <div
            v-for="entry in gitStore.log"
            :key="entry.hash"
            class="commit-row"
          >
            <div
              class="commit-summary"
              @click="gitStore.toggleCommit(entry.hash)"
            >
              <span class="subject">{{ entry.subject }}</span>
              <span class="meta">{{ entry.author }} · {{ relativeDate(entry.date) }}</span>
            </div>
            <div
              v-if="gitStore.expandedCommit === entry.hash"
              class="commit-detail"
            >
              <p
                v-if="entry.body"
                class="body"
              >
                {{ entry.body }}
              </p>
              <p class="hash">
                {{ entry.shortHash }} · {{ entry.email }}
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.git-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

.header {
  margin: 0;
  padding: 10px 12px 8px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.empty {
  padding: 0 12px;
  color: var(--color-text-muted);
  font-size: 12px;
}

.empty-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
  margin-top: 8px;
}

.empty-actions button {
  padding: 6px 12px;
  border-radius: 4px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-hover);
  font-size: 12px;
}

.empty-actions button.primary {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: #ffffff;
}

.content {
  padding-bottom: 16px;
}

.commit-box {
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border);
}

.commit-message {
  width: 100%;
  resize: vertical;
  padding: 6px 8px;
  font: inherit;
  font-size: 12px;
  color: inherit;
  background: var(--color-bg-tab-inactive);
  border: 1px solid var(--color-border);
  border-radius: 3px;
}

.commit-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 6px;
}

.commit-actions .inline {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--color-text-muted);
}

.commit-actions .primary {
  padding: 5px 14px;
  border: 1px solid var(--color-accent);
  border-radius: 4px;
  background: var(--color-accent);
  color: #ffffff;
  font-size: 12px;
}

.commit-actions .primary:disabled {
  opacity: 0.5;
  cursor: default;
}

.group {
  padding: 6px 0;
  border-bottom: 1px solid var(--color-border);
}

.group h3 {
  display: flex;
  align-items: center;
  margin: 0;
  padding: 4px 12px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
}

/* `.action` hides itself until its row is hovered; a header button has no row to hover. */
.group h3 .action {
  visibility: visible;
  margin-left: auto;
}

.hint {
  margin: 0;
  padding: 2px 12px 6px;
  font-size: 11px;
  color: var(--color-text-muted);
}

.file-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 12px;
  cursor: pointer;
  font-size: 12px;
}

.file-row:hover {
  background: var(--color-bg-hover);
}

.file-row:hover .action {
  visibility: visible;
}

.badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 600;
  color: #ffffff;
  flex-shrink: 0;
}

.path {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.action {
  visibility: hidden;
  /* The box is fixed at 18px but the icon is 14px, so centre it explicitly —
     baseline alignment would drop it below the row's badge and path. */
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  border-radius: 3px;
  color: var(--color-text);
}

.action:hover {
  background: var(--color-bg-active-item);
}

.history-toggle {
  width: 100%;
  text-align: left;
  padding: 4px 12px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
}

.commit-row {
  border-top: 1px solid var(--color-border);
}

.commit-summary {
  padding: 6px 12px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.commit-summary:hover {
  background: var(--color-bg-hover);
}

.subject {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta {
  font-size: 11px;
  color: var(--color-text-muted);
}

.commit-detail {
  padding: 0 12px 8px 12px;
  font-size: 11px;
  color: var(--color-text-muted);
}

.commit-detail .body {
  white-space: pre-wrap;
  margin: 0 0 4px;
}

.commit-detail .hash {
  margin: 0;
  font-family: var(--font-mono);
}
</style>
