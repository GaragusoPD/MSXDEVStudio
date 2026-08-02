<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useBuildStore } from '../stores/buildStore'
import { useTabsStore } from '../stores/tabsStore'
import { getEditorFor } from '../editors/registry'
import { disposeModel, saveModel } from '../editors/monaco-models'
import BuildToolbar from './BuildToolbar.vue'
import WelcomeTab from './WelcomeTab.vue'

const tabsStore = useTabsStore()
const buildStore = useBuildStore()

// Welcome isn't a file-type editor, so it's special-cased rather than going
// through the registry; anything else is looked up by extension.
const activeComponent = computed(() => {
  const tab = tabsStore.activeTab
  if (!tab || tab.id === 'welcome') return WelcomeTab
  return tab.extension ? getEditorFor(tab.extension)?.component : undefined
})

async function closeWithPrompt(id: string): Promise<void> {
  const tab = tabsStore.tabs.find((t) => t.id === id)
  if (!tab) return
  if (tab.dirty && !window.confirm(`"${tab.title}" has unsaved changes. Close without saving?`)) return
  disposeModel(id)
  tabsStore.close(id)
}

function onTabAuxClick(event: MouseEvent, id: string): void {
  if (event.button === 1) void closeWithPrompt(id) // middle-click
}

function onKeydown(event: KeyboardEvent): void {
  // Build & run first: F5 has no modifier, Ctrl+Shift+B would otherwise fall
  // through to the plain-Ctrl shortcuts below.
  if (event.key === 'F5') {
    event.preventDefault()
    void buildStore.start('run')
    return
  }
  if (event.ctrlKey && event.shiftKey && (event.key === 'B' || event.key === 'b')) {
    event.preventDefault()
    void buildStore.start('build')
    return
  }
  if (!event.ctrlKey) return
  if (event.key === 's' || event.key === 'S') {
    event.preventDefault()
    const tab = tabsStore.activeTab
    if (tab?.filePath) void saveModel(tab)
  } else if (event.key === 'w' || event.key === 'W') {
    event.preventDefault()
    if (tabsStore.activeTabId) void closeWithPrompt(tabsStore.activeTabId)
  } else if (event.key === 'Tab') {
    event.preventDefault()
    tabsStore.cycleMru()
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="editor-area">
    <div class="tab-strip">
      <button
        v-for="tab in tabsStore.tabs"
        :key="tab.id"
        type="button"
        class="tab"
        :class="{ active: tab.id === tabsStore.activeTabId }"
        @click="tabsStore.activate(tab.id)"
        @auxclick="onTabAuxClick($event, tab.id)"
      >
        <span
          v-if="tab.dirty"
          class="dirty-dot"
        />
        <span>{{ tab.title }}</span>
        <span
          v-if="tab.closable"
          class="close"
          @click.stop="closeWithPrompt(tab.id)"
        >×</span>
      </button>
      <div class="tab-spacer" />
      <BuildToolbar />
    </div>
    <div class="editor-content">
      <component
        :is="activeComponent"
        v-if="activeComponent"
      />
      <div
        v-else
        class="no-editor"
      >
        No editor registered for this file type yet.
      </div>
    </div>
  </div>
</template>

<style scoped>
.editor-area {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--color-bg-editor);
}

.tab-strip {
  display: flex;
  align-items: center;
  background: var(--color-bg-tab-inactive);
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.tab-spacer {
  flex: 1;
  min-width: 12px;
}

.tab {
  display: flex;
  align-items: center;
  align-self: stretch;
  gap: 8px;
  padding: 8px 14px;
  border-right: 1px solid var(--color-border);
  color: var(--color-text-muted);
  background: var(--color-bg-tab-inactive);
}

.tab.active {
  background: var(--color-bg-tab-active);
  color: var(--color-text);
}

.dirty-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}

.close {
  border-radius: 3px;
  padding: 0 3px;
}

.close:hover {
  background: var(--color-bg-hover);
}

.editor-content {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.no-editor {
  padding: 24px;
  color: var(--color-text-muted);
}
</style>
