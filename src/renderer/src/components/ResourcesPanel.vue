<script setup lang="ts">
/**
 * Side panel for Spec 07: the project's editor resources — create/open them in
 * their editors (Specs 08–11), the manual export command, and the standalone
 * entry point for the Import-image dialog.
 */
import { computed, onMounted, ref, watch } from 'vue'
import {
  RESOURCE_DIR,
  RESOURCE_SUFFIXES,
  defaultExport,
  parseResource,
  serializeResource,
  type ResourceKind
} from '../../../shared/msx/resource'
import { useProjectStore } from '../stores/projectStore'
import { useResourcesStore } from '../stores/resourcesStore'
import Icon from './Icon.vue'
import { useTabsStore } from '../stores/tabsStore'
import ImportImageDialog from './ImportImageDialog.vue'

const projectStore = useProjectStore()
const resourcesStore = useResourcesStore()
const tabsStore = useTabsStore()

const newKind = ref<ResourceKind>('tiles')
const newName = ref('')

function openResource(path: string): void {
  tabsStore.openFile(path, path.split('/').pop() ?? path)
}

/** Writes a fresh default doc (or just opens an existing file of that name) and its editor tab. */
async function createResource(): Promise<void> {
  const base = newName.value.replace(/[^A-Za-z0-9_-]/g, '')
  if (!base) return
  const path = `${RESOURCE_DIR}/${base}${RESOURCE_SUFFIXES[newKind.value]}`
  if (!(await window.api.invoke('fs:stat', { path }))) {
    const resource = parseResource(path, '{}')
    resource.doc.export = defaultExport(path)
    // `fs:write` doesn't create parent folders, and a project made before this
    // (or one whose res/ was deleted) hasn't got one. mkdir is idempotent.
    await window.api.invoke('fs:create', { path: RESOURCE_DIR, kind: 'directory' })
    await window.api.invoke('fs:write', { path, content: serializeResource(resource) })
    await resourcesStore.refresh()
  }
  newName.value = ''
  openResource(path)
}

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
      <form
        class="actions"
        @submit.prevent="createResource"
      >
        <select v-model="newKind">
          <option
            v-for="(suffix, kind) in RESOURCE_SUFFIXES"
            :key="kind"
            :value="kind"
          >
            {{ kind }}
          </option>
        </select>
        <input
          v-model="newName"
          type="text"
          placeholder="name"
          spellcheck="false"
        >
        <button
          type="submit"
          :disabled="!newName.trim()"
          title="Create the resource file and open its editor"
        >
          New
        </button>
      </form>

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
          <button
            type="button"
            class="path"
            :title="`Open ${entry.path} in its editor`"
            @click="openResource(entry.path)"
          >
            {{ entry.path }}
          </button>
          <span
            class="out"
            :title="entry.out ?? 'No export target set'"
          >{{ entry.out ?? '—' }}</span>
          <button
            type="button"
            title="Export this resource now"
            @click="resourcesStore.exportOne(entry.path)"
          >
            <Icon name="refresh" />
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

.actions select,
.actions input {
  padding: 3px 6px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-hover);
  color: var(--color-text);
  font-size: 11px;
}

.actions input {
  flex: 1;
  min-width: 60px;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  font-size: 12px;
}

.row .path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0;
  border: none;
  background: none;
  text-align: left;
  font-size: 12px;
  color: var(--color-text);
  cursor: pointer;
}

.row .path:hover {
  color: var(--color-accent);
  text-decoration: underline;
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
