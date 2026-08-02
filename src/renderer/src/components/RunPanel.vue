<script setup lang="ts">
import { computed } from 'vue'
import { useBuildStore } from '../stores/buildStore'
import { useProjectStore } from '../stores/projectStore'
import { MSX_MACHINES } from '../../../shared/msxgl-consts'

const buildStore = useBuildStore()
const projectStore = useProjectStore()

const machineLabel = computed(
  () => MSX_MACHINES.find((m) => m.value === projectStore.project?.machine)?.label ?? '—'
)

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 1024 * 100 ? 1 : 0)} KB`
}
</script>

<template>
  <div class="run-panel">
    <h2>Run</h2>

    <p
      v-if="!projectStore.open"
      class="note"
    >
      Open a project to build it.
    </p>

    <template v-else>
      <p class="note">
        {{ machineLabel }} · {{ projectStore.project?.target }}
      </p>

      <div class="buttons">
        <button
          type="button"
          :disabled="buildStore.running"
          @click="buildStore.start('build')"
        >
          Build
        </button>
        <button
          type="button"
          :disabled="buildStore.running"
          @click="buildStore.start('rebuild')"
        >
          Rebuild
        </button>
        <button
          type="button"
          :disabled="buildStore.running"
          @click="buildStore.start('clean')"
        >
          Clean
        </button>
        <button
          type="button"
          :disabled="buildStore.running"
          @click="buildStore.start('run')"
        >
          Build &amp; Run
        </button>
        <button
          v-if="buildStore.running"
          type="button"
          class="stop"
          @click="buildStore.kill()"
        >
          Stop
        </button>
      </div>

      <h3>Artifacts</h3>
      <p
        v-if="!buildStore.artifacts.length"
        class="note"
      >
        {{ buildStore.running ? 'Building…' : 'Nothing built yet.' }}
      </p>
      <ul v-else>
        <li
          v-for="artifact in buildStore.artifacts"
          :key="artifact.path"
        >
          <span class="path">{{ artifact.path }}</span>
          <span class="size">{{ formatSize(artifact.size) }}</span>
          <button
            type="button"
            class="reveal"
            title="Show in file manager"
            @click="buildStore.reveal(artifact)"
          >
            Reveal
          </button>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.run-panel {
  padding: 12px;
  font-size: 12px;
}

.run-panel h2,
.run-panel h3 {
  margin: 0 0 8px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-text);
}

.run-panel h3 {
  margin-top: 16px;
}

.note {
  margin: 0 0 10px;
  color: var(--color-text-muted);
}

.buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.buttons button {
  padding: 4px 10px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-tab-inactive);
}

.buttons button:hover:not(:disabled) {
  background: var(--color-bg-hover);
}

.buttons button:disabled {
  color: var(--color-text-muted);
  cursor: default;
}

.buttons .stop {
  color: #e06c62;
}

.run-panel ul {
  list-style: none;
  margin: 0;
  padding: 0;
}

.run-panel li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
}

.path {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
}

.size {
  color: var(--color-text-muted);
  white-space: nowrap;
}

.reveal {
  color: var(--color-text-muted);
  text-decoration: underline;
  text-decoration-style: dotted;
}

.reveal:hover {
  color: var(--color-accent);
}
</style>
