<script setup lang="ts">
import Icon from './Icon.vue'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useBuildStore } from '../stores/buildStore'
import { useTabsStore } from '../stores/tabsStore'
import { getEditorFor } from '../editors/registry'
import { closeTabWithPrompt, saveAllTabs, saveTab, toggleTerminal } from '../commands'
import BuildToolbar from './BuildToolbar.vue'
import WelcomeTab from './WelcomeTab.vue'

const tabsStore = useTabsStore()
const buildStore = useBuildStore()

/**
 * Activating a tab that has scrolled out of the strip — Ctrl+Tab, or opening a
 * file from the Explorer — should bring it back into view rather than leaving
 * the editor showing a file whose tab is nowhere.
 */
const tabStrip = ref<HTMLElement | null>(null)
watch(
  () => tabsStore.activeTabId,
  async (id) => {
    if (!id) return
    await nextTick()
    tabStrip.value?.querySelector(`[data-tab-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
)

// Welcome isn't a file-type editor, so it's special-cased rather than going
// through the registry; anything else is looked up by extension.
const activeComponent = computed(() => {
  const tab = tabsStore.activeTab
  if (!tab || tab.id === 'welcome') return WelcomeTab
  return tab.extension ? getEditorFor(tab.extension)?.component : undefined
})

function onTabAuxClick(event: MouseEvent, id: string): void {
  if (event.button === 1) closeTabWithPrompt(id) // middle-click
}

function onKeydown(event: KeyboardEvent): void {
  // Before the terminal guard below, so it works from inside a terminal too —
  // it is the way back out of one.
  // `code`, not `key`: on the Nordic and Spanish layouts backtick is a dead
  // key, so this binds the physical key left of `1` the way VS Code does.
  if (event.ctrlKey && event.code === 'Backquote') {
    event.preventDefault()
    toggleTerminal()
    return
  }
  // A focused terminal owns every other key: in a shell Ctrl+W is delete-word
  // and Ctrl+S is flow control, not close-tab and save.
  if ((event.target as HTMLElement | null)?.closest('.xterm')) return
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
    // Shift saves every dirty tab; both go through the same command the File menu uses.
    void (event.shiftKey ? saveAllTabs() : saveTab(tabsStore.activeTab))
  } else if (event.key === 'w' || event.key === 'W') {
    event.preventDefault()
    if (tabsStore.activeTabId) closeTabWithPrompt(tabsStore.activeTabId)
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
      <div
        ref="tabStrip"
        class="tabs"
      >
        <button
          v-for="tab in tabsStore.tabs"
          :key="tab.id"
          :data-tab-id="tab.id"
          type="button"
          class="tab"
          :class="{ active: tab.id === tabsStore.activeTabId }"
          @click="tabsStore.activate(tab.id)"
          @auxclick="onTabAuxClick($event, tab.id)"
        >
          <span
            v-if="tab.dirty"
            class="dirty-dot"
            :class="{ diverged: tab.diverged }"
            :title="
              tab.diverged
                ? 'This file changed on disk while you had unsaved edits — nothing was reloaded. Save to keep yours.'
                : 'Unsaved changes'
            "
          />
          <span class="label">{{ tab.title }}</span>
          <span
            v-if="tab.closable"
            class="close"
            title="Close tab"
            @click.stop="closeTabWithPrompt(tab.id)"
          ><Icon
            name="close"
            :size="13"
          /></span>
        </button>
      </div>
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
        This looks like a binary file, so there is nothing useful to show as text.
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
  align-items: stretch;
  background: var(--color-bg-tab-inactive);
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
  /* The toolbar is the last child: without this it is what overflows once the
     tabs no longer fit, and Build/Run walk off the right edge of the window. */
  min-width: 0;
}

/* The tabs scroll; the toolbar beside them does not move. */
.tabs {
  display: flex;
  align-items: stretch;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
}

.tabs::-webkit-scrollbar {
  height: 3px;
}

.tabs::-webkit-scrollbar-thumb {
  background: var(--color-border);
}

.tab {
  display: flex;
  align-items: center;
  align-self: stretch;
  gap: 8px;
  /* A long filename shortens rather than crowding every other tab out. */
  flex: none;
  max-width: 200px;
  padding: 8px 14px;
  border-right: 1px solid var(--color-border);
  color: var(--color-text-muted);
  background: var(--color-bg-tab-inactive);
}

.tab.active {
  background: var(--color-bg-tab-active);
  color: var(--color-text);
}

.tab .label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dirty-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}

/* Diverged: the buffer and the file both moved, and neither was discarded. */
.dirty-dot.diverged {
  background: var(--color-error);
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
