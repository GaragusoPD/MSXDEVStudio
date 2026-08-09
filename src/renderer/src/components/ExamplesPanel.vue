<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { MSX_MACHINES } from '../../../shared/msxgl-consts'
import { useExamplesStore, type CatalogEntry } from '../stores/examplesStore'
import { useToolchainStore } from '../stores/toolchainStore'

const examplesStore = useExamplesStore()
const toolchainStore = useToolchainStore()
const query = ref('')

onMounted(() => void examplesStore.load())

function machineLabel(entry: CatalogEntry): string {
  return MSX_MACHINES.find((m) => m.value === entry.machine)?.label ?? entry.machine
}

const filtered = computed<CatalogEntry[]>(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return examplesStore.catalog
  return examplesStore.catalog.filter(
    (e) =>
      e.title.toLowerCase().includes(q) ||
      e.id.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      e.tags.some((t) => t.toLowerCase().includes(q))
  )
})

const byCategory = computed<[string, CatalogEntry[]][]>(() => {
  const map = new Map<string, CatalogEntry[]>()
  for (const entry of filtered.value) {
    const list = map.get(entry.category) ?? []
    list.push(entry)
    map.set(entry.category, list)
  }
  return [...map.entries()]
})

const localDocsPath = computed(() => {
  const path = toolchainStore.status?.msxgl.path
  return path ? `${path}/engine/doc/html/index.html` : null
})

function openLink(target: string): void {
  void window.api.invoke('shell:open', { target })
}
</script>

<template>
  <div class="examples-panel">
    <h2 class="header">
      MSXgl Official Examples
    </h2>

    <div class="search">
      <input
        v-model="query"
        type="search"
        placeholder="Search examples…"
        spellcheck="false"
      >
    </div>

    <p
      v-if="!examplesStore.catalog.length"
      class="empty"
    >
      No samples found. Set up MSXgl in Toolchain Settings first.
    </p>

    <div
      v-else-if="!filtered.length"
      class="empty"
    >
      No examples match "{{ query }}".
    </div>

    <div
      v-else
      class="tree"
    >
      <details
        v-for="[category, entries] in byCategory"
        :key="category"
        open
      >
        <summary>{{ category }} <span class="count">({{ entries.length }})</span></summary>
        <ul>
          <li
            v-for="entry in entries"
            :key="entry.id"
          >
            <button
              type="button"
              class="entry"
              @click="examplesStore.openViewer(entry)"
            >
              <span class="title">{{ entry.title }}</span>
              <span class="badge">{{ machineLabel(entry) }}</span>
            </button>
          </li>
        </ul>
      </details>
    </div>

    <footer class="docs">
      <button
        type="button"
        class="link"
        @click="openLink('https://aoineko.org/msxgl-doc')"
      >
        MSXgl documentation
      </button>
      <button
        v-if="localDocsPath"
        type="button"
        class="link"
        @click="openLink(localDocsPath)"
      >
        Offline docs
      </button>
    </footer>
  </div>
</template>

<style scoped>
.examples-panel {
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

.search {
  padding: 0 12px 8px;
  flex-shrink: 0;
}

.search input {
  width: 100%;
  padding: 5px 8px;
  font: inherit;
  color: inherit;
  background: var(--color-bg-editor);
  border: 1px solid var(--color-border);
  border-radius: 3px;
}

.empty {
  padding: 0 12px;
  color: var(--color-text-muted);
  font-size: 12px;
}

.tree {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 0 8px;
}

details {
  padding: 0 12px;
}

summary {
  padding: 4px 0;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  user-select: none;
}

.count {
  font-weight: 400;
  color: var(--color-text-muted);
}

ul {
  list-style: none;
  margin: 0 0 4px;
  padding: 0;
}

.entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 4px 6px 4px 12px;
  border-radius: 3px;
  font-size: 12px;
  text-align: left;
}

.entry:hover {
  background: var(--color-bg-hover);
}

.entry .title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.badge {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--color-bg-hover);
  color: var(--color-text-muted);
  font-size: 10px;
}

.docs {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 12px;
  border-top: 1px solid var(--color-border);
}

.docs .link {
  align-self: flex-start;
  color: var(--color-accent);
  text-decoration: underline;
  text-decoration-style: dotted;
  font-size: 11px;
}
</style>
