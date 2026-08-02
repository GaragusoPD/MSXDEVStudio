<script setup lang="ts">
import * as monaco from './monaco-full'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { MSX_MACHINES } from '../../../shared/msxgl-consts'
import { useAppStore } from '../stores/appStore'
import { useBuildStore } from '../stores/buildStore'
import { useExamplesStore } from '../stores/examplesStore'
import { useTabsStore } from '../stores/tabsStore'

const EXAMPLE_PREFIX = 'example:'

const tabsStore = useTabsStore()
const examplesStore = useExamplesStore()
const appStore = useAppStore()
const buildStore = useBuildStore()

const container = ref<HTMLDivElement>()
let editor: monaco.editor.IStandaloneCodeEditor | undefined

const exampleId = computed<string | null>(() => {
  const id = tabsStore.activeTab?.id ?? ''
  return id.startsWith(EXAMPLE_PREFIX) ? id.slice(EXAMPLE_PREFIX.length) : null
})

const entry = computed(() => examplesStore.catalog.find((e) => e.id === exampleId.value) ?? null)
const machineLabel = computed(
  () => MSX_MACHINES.find((m) => m.value === entry.value?.machine)?.label ?? entry.value?.machine ?? ''
)

// Read-only source cache, keyed by sample id — re-opening the same sample in another
// tab (or switching back to it) shouldn't re-fetch it.
const sourceCache = new Map<string, string>()

async function loadContent(id: string): Promise<string> {
  const cached = sourceCache.get(id)
  if (cached !== undefined) return cached
  const content = await window.api.invoke('examples:read', { id })
  sourceCache.set(id, content)
  return content
}

async function render(): Promise<void> {
  const id = exampleId.value
  if (!editor || !id) return
  const content = await loadContent(id)
  if (exampleId.value !== id) return // switched tabs again while loading
  editor.setValue(content)
}

onMounted(() => {
  if (!container.value) return
  editor = monaco.editor.create(container.value, {
    value: '',
    language: 'c',
    readOnly: true,
    automaticLayout: true,
    minimap: { enabled: true },
    theme: appStore.theme === 'light' ? 'vs' : 'vs-dark'
  })
  void render()
})

watch(exampleId, () => void render())
watch(
  () => appStore.theme,
  (theme) => monaco.editor.setTheme(theme === 'light' ? 'vs' : 'vs-dark')
)

onBeforeUnmount(() => editor?.dispose())

function tryIt(): void {
  if (exampleId.value) void examplesStore.tryIt(exampleId.value)
}

function forkExample(): void {
  if (entry.value) examplesStore.startFork(entry.value)
}
</script>

<template>
  <div class="viewer">
    <header v-if="entry">
      <div class="info">
        <h2>{{ entry.title }}</h2>
        <p>{{ entry.description }}</p>
        <div class="chips">
          <span class="chip">{{ machineLabel }}</span>
          <span class="chip">{{ entry.target }}</span>
        </div>
      </div>
      <div class="actions">
        <button
          type="button"
          :disabled="buildStore.running"
          @click="tryIt"
        >
          ▶ Try it
        </button>
        <button
          type="button"
          @click="forkExample"
        >
          ⧉ New project from example
        </button>
      </div>
    </header>
    <div
      ref="container"
      class="monaco-host"
    />
  </div>
</template>

<style scoped>
.viewer {
  height: 100%;
  display: flex;
  flex-direction: column;
}

header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.info h2 {
  margin: 0 0 4px;
  font-size: 14px;
  font-weight: 600;
}

.info p {
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--color-text-muted);
  max-width: 60ch;
}

.chips {
  display: flex;
  gap: 6px;
}

.chip {
  padding: 1px 8px;
  border-radius: 8px;
  background: var(--color-bg-hover);
  font-size: 11px;
  color: var(--color-text-muted);
}

.actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0;
}

.actions button {
  padding: 5px 12px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-bg-hover);
  font-size: 12px;
  white-space: nowrap;
}

.actions button:disabled {
  opacity: 0.5;
  cursor: default;
}

.monaco-host {
  flex: 1;
  min-height: 0;
}
</style>
