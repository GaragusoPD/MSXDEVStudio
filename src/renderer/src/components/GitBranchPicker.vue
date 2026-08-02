<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useGitStore } from '../stores/gitStore'

const gitStore = useGitStore()
const newBranchName = ref('')

onMounted(() => void gitStore.loadBranches())

function close(): void {
  gitStore.branchPickerOpen = false
}

async function create(): Promise<void> {
  const name = newBranchName.value.trim()
  if (!name) return
  await gitStore.createBranch(name)
  newBranchName.value = ''
}
</script>

<template>
  <div
    class="backdrop"
    @click.self="close"
  >
    <div class="dialog">
      <h2>Branches</h2>
      <ul class="branch-list">
        <li
          v-for="branch in gitStore.branches"
          :key="branch.name"
          class="branch-row"
          :class="{ current: branch.current }"
          @click="branch.current ? undefined : gitStore.checkout(branch.name)"
        >
          <span class="name">{{ branch.current ? '● ' : '' }}{{ branch.name }}</span>
          <span
            v-if="branch.upstream"
            class="upstream"
          >{{ branch.upstream }}</span>
        </li>
        <li
          v-if="!gitStore.branches.length"
          class="hint"
        >
          No branches yet.
        </li>
      </ul>
      <div class="create-row">
        <input
          v-model="newBranchName"
          type="text"
          placeholder="New branch name"
          spellcheck="false"
          @keydown.enter="create"
        >
        <button
          type="button"
          class="primary"
          :disabled="!newBranchName.trim()"
          @click="create"
        >
          Create
        </button>
      </div>
      <div class="actions">
        <button
          type="button"
          @click="close"
        >
          Close
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
  z-index: 100;
}

.dialog {
  width: 360px;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  padding: 16px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-editor);
  color: var(--color-text);
}

h2 {
  margin: 0 0 10px;
  font-size: 14px;
  font-weight: 600;
}

.branch-list {
  list-style: none;
  margin: 0 0 10px;
  padding: 0;
  overflow-y: auto;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  max-height: 240px;
}

.branch-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
}

.branch-row:hover {
  background: var(--color-bg-hover);
}

.branch-row.current {
  cursor: default;
  color: var(--color-accent);
}

.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.upstream {
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.hint {
  padding: 10px;
  font-size: 12px;
  color: var(--color-text-muted);
}

.create-row {
  display: flex;
  gap: 6px;
  margin-bottom: 12px;
}

.create-row input {
  flex: 1;
  padding: 5px 8px;
  font-size: 12px;
  color: inherit;
  background: var(--color-bg-tab-inactive);
  border: 1px solid var(--color-border);
  border-radius: 3px;
}

.create-row button,
.actions button {
  padding: 5px 12px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-bg-hover);
  font-size: 12px;
}

.create-row button.primary {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: #ffffff;
}

.create-row button:disabled {
  opacity: 0.5;
  cursor: default;
}

.actions {
  display: flex;
  justify-content: flex-end;
}
</style>
