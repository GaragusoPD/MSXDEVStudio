<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import type { FsEntry } from '../../../shared/ipc'
import { useExplorerStore } from '../stores/explorerStore'
import { useProjectStore } from '../stores/projectStore'
import ExplorerNode from './ExplorerNode.vue'

const projectStore = useProjectStore()
const explorerStore = useExplorerStore()

const rootEntry = computed<FsEntry | null>(() => {
  const path = projectStore.currentProjectPath
  if (!path) return null
  return { name: path.split(/[/\\]/).pop() ?? path, path: '', isDirectory: true, absolutePath: path }
})

async function loadRoot(): Promise<void> {
  explorerStore.reset()
  if (projectStore.currentProjectPath) await explorerStore.toggle('')
}

onMounted(() => {
  explorerStore.init()
  void loadRoot()
})

watch(() => projectStore.currentProjectPath, () => void loadRoot())
</script>

<template>
  <div class="explorer">
    <h2 class="header">
      Explorer
    </h2>
    <div
      v-if="!rootEntry"
      class="empty"
    >
      <p>No folder opened.</p>
      <button
        type="button"
        @click="projectStore.openProject()"
      >
        Open Folder
      </button>
    </div>
    <ul
      v-else
      class="tree"
    >
      <ExplorerNode
        :entry="rootEntry"
        :depth="0"
      />
    </ul>
  </div>
</template>

<style scoped>
.explorer {
  height: 100%;
  display: flex;
  flex-direction: column;
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

.empty button {
  margin-top: 8px;
  padding: 6px 12px;
  border-radius: 4px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-hover);
}

.tree {
  margin: 0;
  padding: 0 0 12px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
  font-size: 13px;
}
</style>
