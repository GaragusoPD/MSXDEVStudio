<script setup lang="ts">
import { computed } from 'vue'
import { useBuildStore } from '../stores/buildStore'
import { useProjectStore } from '../stores/projectStore'

const buildStore = useBuildStore()
const projectStore = useProjectStore()

const disabled = computed(() => !projectStore.open || buildStore.running)
const preferred = computed(() => projectStore.project?.emulator.preferred ?? 'openmsx')
</script>

<template>
  <div class="build-toolbar">
    <button
      type="button"
      class="action"
      title="Build (Ctrl+Shift+B)"
      :disabled="disabled"
      @click="buildStore.start('build')"
    >
      Build
    </button>
    <button
      type="button"
      class="action primary"
      title="Build & Run (F5)"
      :disabled="disabled"
      @click="buildStore.start('run')"
    >
      ▶ Run
    </button>
    <button
      v-if="buildStore.running"
      type="button"
      class="action stop"
      title="Terminate the running build"
      @click="buildStore.kill()"
    >
      ■ Stop
    </button>
    <select
      class="emulator"
      title="Emulator used by Build & Run"
      :value="preferred"
      :disabled="!projectStore.open"
      @change="buildStore.setPreferredEmulator(($event.target as HTMLSelectElement).value as 'openmsx' | 'webmsx')"
    >
      <option value="openmsx">
        openMSX
      </option>
      <option value="webmsx">
        WebMSX
      </option>
    </select>
  </div>
</template>

<style scoped>
.build-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  flex-shrink: 0;
}

.action {
  padding: 4px 10px;
  font-size: 12px;
  border-radius: 3px;
  color: var(--color-text);
}

.action:hover:not(:disabled) {
  background: var(--color-bg-hover);
}

.action:disabled {
  color: var(--color-text-muted);
  cursor: default;
}

.action.primary {
  color: var(--color-accent);
}

.action.stop {
  color: #e06c62;
}

.emulator {
  font-family: inherit;
  font-size: 11px;
  padding: 2px 4px;
  color: var(--color-text);
  background: var(--color-bg-tab-inactive);
  border: 1px solid var(--color-border);
  border-radius: 3px;
}
</style>
