<script setup lang="ts">
/**
 * Side panel for Spec 07: the project's editor resources, the manual export
 * command, and the standalone entry point for the Import-image dialog.
 * Specs 08–10 add "open in editor" once those editors register.
 */
import { computed, onMounted, watch } from 'vue'
import { useProjectStore } from '../stores/projectStore'
import { useResourcesStore } from '../stores/resourcesStore'
import ImportImageDialog from './ImportImageDialog.vue'

const projectStore = useProjectStore()
const resourcesStore = useResourcesStore()

const grouped = computed<[string, typeof resourcesStore.entries][]>(() => {
  const map = new Map<string, typeof resourcesStore.entries>()
  for (const entry of resourcesStore.entries) {
    const list = map.get(entry.kind) ?? []
    list.push(entry)
    map.set(entry.kind, list)
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
})

const imgRuleCount = computed(() => projectStore.project?.resources.imgRules.length ?? 0)

onMounted(() => void resourcesStore.refresh())
watch(() => projectStore.open?.root, () => void resourcesStore.refresh())
</script>

<template>
  <div class="resources-panel">
    <h2 class="header">
      Resources
    </h2>

    <p
      v-if="!projectStore.open"
      class="hint"
    >
      Open a project to see its graphics resources.
    </p>

    <template v-else>
      <div class="actions">
        <button
          type="button"
          :disabled="resourcesStore.busy"
          @click="resourcesStore.exportAll()"
        >
          Export all
        </button>
        <button
          type="button"
          :disabled="resourcesStore.busy"
          title="Ignore the mtime check and re-convert everything"
          @click="resourcesStore.exportAll(true)"
        >
          Force
        </button>
        <button
          type="button"
          @click="resourcesStore.importVisible = true"
        >
          Import image…
        </button>
      </div>

      <p class="hint">
        Exports also run automatically before every build, skipping anything already up to date.
      </p>

      <p
        v-if="!resourcesStore.entries.length"
        class="hint empty"
      >
        No <code>.tiles.json</code>, <code>.sprites.json</code>, <code>.map.json</code> or
        <code>.screen.json</code> files yet.
      </p>

      <section
        v-for="[kind, entries] in grouped"
        :key="kind"
      >
        <h3>{{ kind }}</h3>
        <div
          v-for="entry in entries"
          :key="entry.path"
          class="row"
        >
          <span
            class="path"
            :title="entry.path"
          >{{ entry.path }}</span>
          <span
            class="out"
            :title="entry.out ?? 'No export target set'"
          >{{ entry.out ?? '—' }}</span>
          <button
            type="button"
            title="Export this resource now"
            @click="resourcesStore.exportOne(entry.path)"
          >
            ↻
          </button>
        </div>
      </section>

      <section>
        <h3>Image rules</h3>
        <p class="hint">
          {{ imgRuleCount }} MSXimg rule{{ imgRuleCount === 1 ? '' : 's' }} — edit them in Project Settings.
        </p>
      </section>
    </template>

    <ImportImageDialog
      v-if="resourcesStore.importVisible"
      @close="resourcesStore.importVisible = false"
    />
  </div>
</template>

<style scoped>
.resources-panel {
  padding: 8px 10px 20px;
}

.header {
  margin: 0 0 8px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-text);
}

h3 {
  margin: 14px 0 4px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
}

.actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.actions button {
  padding: 3px 10px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-hover);
  font-size: 11px;
}

.actions button:disabled {
  opacity: 0.5;
  cursor: default;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  font-size: 12px;
}

.path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.out {
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--color-text-muted);
}

.row button {
  padding: 0 5px;
  color: var(--color-text-muted);
}

.row button:hover {
  color: var(--color-text);
}

.hint {
  margin: 0 0 4px;
  font-size: 11px;
  color: var(--color-text-muted);
  line-height: 1.5;
}

.empty {
  margin-top: 12px;
}
</style>
