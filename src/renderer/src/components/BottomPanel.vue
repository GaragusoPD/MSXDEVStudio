<script setup lang="ts">
import { openTerminalTab } from '../commands'
import { PANEL_TERMINAL } from '../editors/terminal/session'
import { useAppStore } from '../stores/appStore'
import { useProblemsStore } from '../stores/problemsStore'
import OutputPane from './OutputPane.vue'
import ProblemsPane from './ProblemsPane.vue'
import TerminalView from './TerminalView.vue'

const appStore = useAppStore()
const problemsStore = useProblemsStore()
</script>

<template>
  <div class="bottom-panel">
    <div class="tab-strip">
      <button
        type="button"
        class="tab"
        :class="{ active: appStore.bottomTab === 'output' }"
        @click="appStore.bottomTab = 'output'"
      >
        Output
      </button>
      <button
        type="button"
        class="tab"
        :class="{ active: appStore.bottomTab === 'problems' }"
        @click="appStore.bottomTab = 'problems'"
      >
        {{ problemsStore.problems.length ? `Problems (${problemsStore.problems.length})` : 'Problems' }}
      </button>
      <button
        type="button"
        class="tab"
        :class="{ active: appStore.bottomTab === 'terminal' }"
        @click="appStore.bottomTab = 'terminal'"
      >
        Terminal
      </button>
      <div class="spacer" />
      <button
        type="button"
        class="collapse"
        title="Open a terminal in the editor area"
        @click="openTerminalTab()"
      >
        ⧉
      </button>
      <button
        type="button"
        class="collapse"
        title="Close panel"
        @click="appStore.toggleBottomPanel()"
      >
        ×
      </button>
    </div>
    <div class="content">
      <OutputPane v-if="appStore.bottomTab === 'output'" />
      <ProblemsPane v-else-if="appStore.bottomTab === 'problems'" />
      <TerminalView
        v-else
        :id="PANEL_TERMINAL"
      />
    </div>
  </div>
</template>

<style scoped>
.bottom-panel {
  display: flex;
  flex-direction: column;
  background: var(--color-bg-panel);
  min-height: 0;
}

.tab-strip {
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.tab {
  padding: 6px 12px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
}

.tab.active {
  color: var(--color-text);
  box-shadow: inset 0 -2px 0 var(--color-accent);
}

.spacer {
  flex: 1;
}

.collapse {
  padding: 4px 10px;
  color: var(--color-text-muted);
}

.collapse:hover {
  color: var(--color-text);
}

.content {
  flex: 1;
  min-height: 0;
}
</style>
