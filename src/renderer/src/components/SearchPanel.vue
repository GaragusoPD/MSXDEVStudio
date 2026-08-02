<script setup lang="ts">
import { computed, ref } from 'vue'
import type { SearchMatch } from '../../../shared/search'
import { useTabsStore } from '../stores/tabsStore'

const tabsStore = useTabsStore()

const query = ref('')
const include = ref('')
const exclude = ref('')
const results = ref<SearchMatch[]>([])
const searching = ref(false)
const searched = ref(false)

async function runSearch(): Promise<void> {
  if (!query.value.trim()) {
    results.value = []
    searched.value = false
    return
  }
  searching.value = true
  try {
    results.value = await window.api.invoke('search:query', {
      query: query.value,
      include: include.value || undefined,
      exclude: exclude.value || undefined
    })
  } finally {
    searching.value = false
    searched.value = true
  }
}

const grouped = computed(() => {
  const map = new Map<string, SearchMatch[]>()
  for (const match of results.value) {
    if (!map.has(match.file)) map.set(match.file, [])
    map.get(match.file)?.push(match)
  }
  return [...map.entries()]
})

function jump(match: SearchMatch): void {
  const name = match.file.split('/').pop() ?? match.file
  tabsStore.openFile(match.file, name, { line: match.line, column: match.column })
}
</script>

<template>
  <div class="search">
    <h2 class="header">
      Search
    </h2>
    <div class="fields">
      <input
        v-model="query"
        type="text"
        placeholder="Search"
        @keydown.enter="runSearch"
      >
      <input
        v-model="include"
        type="text"
        placeholder="files to include (e.g. *.c)"
        @keydown.enter="runSearch"
      >
      <input
        v-model="exclude"
        type="text"
        placeholder="files to exclude"
        @keydown.enter="runSearch"
      >
      <button
        type="button"
        @click="runSearch"
      >
        Search
      </button>
    </div>

    <p
      v-if="searching"
      class="status"
    >
      Searching…
    </p>
    <p
      v-else-if="searched && !results.length"
      class="status"
    >
      No results.
    </p>
    <ul
      v-else
      class="results"
    >
      <li
        v-for="[file, matches] in grouped"
        :key="file"
        class="file-group"
      >
        <div class="file-name">
          {{ file }} <span class="count">{{ matches.length }}</span>
        </div>
        <ul>
          <li
            v-for="(match, i) in matches"
            :key="i"
            class="match"
            @click="jump(match)"
          >
            <span class="line-no">{{ match.line }}</span>
            <span class="preview">{{ match.preview }}</span>
          </li>
        </ul>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.search {
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

.fields {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0 12px 10px;
  flex-shrink: 0;
}

.fields input {
  padding: 5px 8px;
  font: inherit;
  color: inherit;
  background: var(--color-bg-editor);
  border: 1px solid var(--color-border);
  border-radius: 3px;
}

.fields button {
  align-self: flex-start;
  padding: 5px 12px;
  border-radius: 4px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-hover);
}

.status {
  padding: 0 12px;
  color: var(--color-text-muted);
  font-size: 12px;
}

.results {
  overflow-y: auto;
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 0 0 12px;
  list-style: none;
  font-size: 12px;
}

.file-group {
  margin-bottom: 6px;
}

.file-name {
  padding: 4px 12px;
  color: var(--color-accent);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.count {
  color: var(--color-text-muted);
  font-weight: 400;
}

.match {
  display: flex;
  gap: 8px;
  padding: 2px 12px 2px 20px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
}

.match:hover {
  background: var(--color-bg-hover);
}

.line-no {
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.preview {
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--font-mono);
}
</style>
