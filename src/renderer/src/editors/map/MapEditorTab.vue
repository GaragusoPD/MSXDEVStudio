<script setup lang="ts">
/**
 * Spec 10 A — the `.map.json` editor tab: tile picker, map canvas
 * (stamp/fill/rect/erase, rect-select + copy/paste, flags mode, layer
 * visibility, zoom/grid/screen-outline), and undo/redo.
 *
 * Registered for the `map.json` compound extension in `editors/bootstrap.ts`,
 * so the explorer opens maps here instead of in Monaco.
 */
import { computed, onMounted, onUnmounted, watch } from 'vue'
import type { MapTool } from '../../../../shared/map-editor'
import { useResourcesStore } from '../../stores/resourcesStore'
import { useTabsStore } from '../../stores/tabsStore'
import MapCanvas from './MapCanvas.vue'
import MapPicker from './MapPicker.vue'
import MapSidePanel from './MapSidePanel.vue'
import {
  canRedo,
  canUndo,
  copySelection,
  deleteSelection,
  doc,
  mapSession,
  pasteClipboard,
  pruneMapSessions,
  redo,
  saveSession,
  setFlagsMode,
  setTool,
  undo,
  type MapSession
} from './session'

const tabsStore = useTabsStore()
const resourcesStore = useResourcesStore()

const path = computed(() => tabsStore.activeTab?.filePath ?? '')
const session = computed(() => mapSession(path.value))

const TOOLS: { id: MapTool; label: string; title: string }[] = [
  { id: 'stamp', label: '✎', title: 'Stamp — drag to paint the picked tile(s)' },
  { id: 'fill', label: '🪣', title: 'Fill (flood)' },
  { id: 'rect', label: '▭', title: 'Rectangle' },
  { id: 'erase', label: '⌫', title: 'Erase' }
]

async function save(): Promise<void> {
  try {
    await saveSession(session.value)
  } catch (error) {
    session.value.status = `Save failed: ${String(error)}`
  }
}

/** Export goes through Spec 07's converter, so the file on disk has to be current first. */
async function exportNow(): Promise<void> {
  await save()
  await resourcesStore.exportOne(session.value.path)
}

function zoom(delta: number): void {
  const active = session.value
  active.zoom = Math.max(4, Math.min(48, active.zoom + delta))
}

function onKeydown(event: KeyboardEvent): void {
  const active = session.value
  if (event.ctrlKey) {
    const key = event.key.toLowerCase()
    if (key === 's') {
      event.preventDefault()
      void save()
    } else if (key === 'z' && !event.shiftKey) {
      event.preventDefault()
      undo(active)
    } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
      event.preventDefault()
      redo(active)
    } else if (key === 'c') {
      copySelection(active)
    } else if (key === 'v') {
      pasteClipboard(active)
    }
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    deleteSelection(active)
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

// Sessions outlive tab switches (like Monaco models do); drop the ones whose tab is gone.
watch(
  () => tabsStore.tabs.length,
  () => pruneMapSessions(new Set(tabsStore.tabs.map((tab) => tab.filePath ?? ''))),
  { immediate: true }
)

// The tileset dropdown reads from the Resources panel's list.
onMounted(() => void resourcesStore.refresh())

function flagsToggleLabel(active: MapSession): string {
  return active.flagsMode ? 'Flags mode: ON' : 'Flags mode'
}
</script>

<template>
  <div class="map-editor">
    <p
      v-if="session.error"
      class="error"
    >
      {{ session.error }}
    </p>
    <template v-else-if="!session.loading">
      <div class="toolbar">
        <button
          v-for="tool in TOOLS"
          :key="tool.id"
          type="button"
          :class="{ active: session.tool === tool.id && !session.flagsMode }"
          :title="tool.title"
          @click="setTool(session, tool.id)"
        >
          {{ tool.label }}
        </button>
        <label
          v-if="session.tool === 'rect'"
          class="inline"
        >
          <input
            v-model="session.filledRect"
            type="checkbox"
          >
          <span>filled</span>
        </label>

        <span class="sep" />
        <button
          type="button"
          :class="{ active: session.flagsMode }"
          title="Paint tileMeta flags on the active flags layer instead of tiles"
          @click="setFlagsMode(session, !session.flagsMode)"
        >
          {{ flagsToggleLabel(session) }}
        </button>

        <span class="sep" />
        <button
          type="button"
          title="Copy the selection (Ctrl+C)"
          :disabled="!session.selection"
          @click="copySelection(session)"
        >
          Copy
        </button>
        <button
          type="button"
          title="Paste as the stamp brush (Ctrl+V)"
          :disabled="!session.clipboard"
          @click="pasteClipboard(session)"
        >
          Paste
        </button>
        <button
          type="button"
          title="Clear the selection (Delete)"
          :disabled="!session.selection"
          @click="deleteSelection(session)"
        >
          Delete
        </button>

        <span class="sep" />
        <button
          type="button"
          title="Undo (Ctrl+Z)"
          :disabled="!canUndo(session.history)"
          @click="undo(session)"
        >
          ↶
        </button>
        <button
          type="button"
          title="Redo (Ctrl+Y)"
          :disabled="!canRedo(session.history)"
          @click="redo(session)"
        >
          ↷
        </button>

        <span class="sep" />
        <button
          type="button"
          title="Zoom out"
          @click="zoom(-4)"
        >
          −
        </button>
        <button
          type="button"
          title="Zoom in"
          @click="zoom(4)"
        >
          +
        </button>
        <label class="inline">
          <input
            v-model="session.gridVisible"
            type="checkbox"
          >
          <span>grid</span>
        </label>
        <label class="inline">
          <input
            v-model="session.screenOutline"
            type="checkbox"
          >
          <span>32×24 outline</span>
        </label>

        <span class="spacer" />
        <button
          type="button"
          :disabled="!session.dirty"
          @click="save"
        >
          {{ session.dirty ? 'Save' : 'Saved' }}
        </button>
        <button
          type="button"
          title="Write the tile-index / flag tables this map exports"
          @click="exportNow"
        >
          Export
        </button>
      </div>

      <div class="panes">
        <MapPicker :session="session" />
        <MapCanvas :session="session" />
        <MapSidePanel :session="session" />
      </div>

      <p
        v-if="doc(session).layers.length === 0"
        class="status"
      >
        This map has no layers.
      </p>
      <p
        v-if="session.status"
        class="status"
      >
        {{ session.status }}
      </p>
    </template>
  </div>
</template>

<style scoped>
.map-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--color-border);
  flex-wrap: wrap;
}

.toolbar button {
  min-width: 24px;
  padding: 2px 6px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-hover);
  font-size: 12px;
}

.toolbar button.active {
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: #ffffff;
}

.toolbar button:disabled {
  opacity: 0.4;
  cursor: default;
}

.sep {
  width: 1px;
  align-self: stretch;
  margin: 0 4px;
  background: var(--color-border);
}

.spacer {
  flex: 1;
}

.inline {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  color: var(--color-text-muted);
}

.panes {
  flex: 1;
  min-height: 0;
  display: flex;
}

.status,
.error {
  margin: 0;
  padding: 5px 10px;
  border-top: 1px solid var(--color-border);
  font-size: 11px;
  color: var(--color-text-muted);
}

.error {
  color: var(--color-error, #f14c4c);
}
</style>
