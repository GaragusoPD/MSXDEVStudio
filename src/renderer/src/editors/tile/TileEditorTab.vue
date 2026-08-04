<script setup lang="ts">
/**
 * Spec 08 — the `.tiles.json` editor tab: tileset grid, pixel canvas, palette
 * and row colors, with the mode's color constraint enforced on every stroke.
 *
 * Registered for the `tiles.json` compound extension in `editors/bootstrap.ts`,
 * so the explorer opens tilesets here instead of in Monaco.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import ImportImageDialog from '../../components/ImportImageDialog.vue'
import type { ImportResult } from '../../composables/useImageImport'
import { MAX_TILES, normalizeTiles, packTiles } from '../../../../shared/msx/tile'
import type { TileTool, TileTransform } from '../../../../shared/tile-editor'
import { useResourcesStore } from '../../stores/resourcesStore'
import { useTabsStore } from '../../stores/tabsStore'
import TileCanvas from './TileCanvas.vue'
import TileGrid from './TileGrid.vue'
import TileMapPreview from './TileMapPreview.vue'
import TileSidePanel from './TileSidePanel.vue'
import {
  canRedo,
  canUndo,
  commit,
  copySelection,
  pasteClipboard,
  pruneTileSessions,
  redo,
  saveSession,
  setTool,
  tileSession,
  transform,
  undo,
  zoom
} from './session'

const tabsStore = useTabsStore()
const resourcesStore = useResourcesStore()

const importVisible = ref(false)
const importMode = ref<'replace' | 'merge'>('replace')
const importDedup = ref(true)

const path = computed(() => tabsStore.activeTab?.filePath ?? '')
const session = computed(() => tileSession(path.value))

const TOOLS: { id: TileTool; label: string; title: string }[] = [
  { id: 'pencil', label: '✎', title: 'Pencil' },
  { id: 'line', label: '／', title: 'Line' },
  { id: 'rect', label: '▭', title: 'Rectangle' },
  { id: 'fill', label: '🪣', title: 'Fill' }
]

const TRANSFORMS: { id: TileTransform; label: string; title: string }[] = [
  { id: 'shiftLeft', label: '←', title: 'Shift left (wraps)' },
  { id: 'shiftRight', label: '→', title: 'Shift right (wraps)' },
  { id: 'shiftUp', label: '↑', title: 'Shift up (row colors move too)' },
  { id: 'shiftDown', label: '↓', title: 'Shift down (row colors move too)' },
  { id: 'mirrorH', label: '⇋', title: 'Mirror horizontally' },
  { id: 'mirrorV', label: '⇅', title: 'Mirror vertically' },
  { id: 'rotateCW', label: '⟳', title: 'Rotate 90° clockwise' }
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

function onImported(result: ImportResult): void {
  const active = session.value
  const packed = packTiles(result.indices, result.width, result.height, active.doc.mode, { dedup: importDedup.value })
  const tiles =
    importMode.value === 'replace'
      ? packed.doc.tiles
      : [...active.doc.tiles, ...packed.doc.tiles].slice(0, MAX_TILES)
  const doc = normalizeTiles({
    ...active.doc,
    // sc4 can adopt the converter's optimized palette; MSX1 modes keep the fixed one.
    palette: active.doc.mode === 'sc4' ? (result.palette ?? active.doc.palette) : null,
    count: tiles.length,
    tiles,
    groupColors: importMode.value === 'replace' ? packed.doc.groupColors : active.doc.groupColors
  })
  commit(active, doc, 'import image')
  active.status =
    `Imported ${packed.doc.count} tiles` +
    (packed.lossyTiles.length ? ` — ${packed.lossyTiles.length} needed color reduction` : '')
}

function onKeydown(event: KeyboardEvent): void {
  if (!event.ctrlKey) return
  const key = event.key.toLowerCase()
  // Ctrl+S is EditorArea's, for every tab kind — see `commands.ts`.
  if (key === 'c') {
    event.preventDefault()
    copySelection(session.value)
  } else if (key === 'v') {
    event.preventDefault()
    pasteClipboard(session.value)
  } else if (key === 'z' && !event.shiftKey) {
    event.preventDefault()
    undo(session.value)
  } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
    event.preventDefault()
    redo(session.value)
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

// Sessions outlive tab switches (like Monaco models do); drop the ones whose tab is gone.
watch(
  () => tabsStore.tabs.length,
  () => pruneTileSessions(new Set(tabsStore.tabs.map((tab) => tab.filePath ?? ''))),
  { immediate: true }
)
</script>

<template>
  <div class="tile-editor">
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
          :class="{ active: session.tool === tool.id }"
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
          v-for="op in TRANSFORMS"
          :key="op.id"
          type="button"
          :title="op.title"
          @click="transform(session, op.id)"
        >
          {{ op.label }}
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
          @click="zoom(session, 'zoom', -8)"
        >
          −
        </button>
        <button
          type="button"
          title="Zoom in"
          @click="zoom(session, 'zoom', 8)"
        >
          +
        </button>

        <span class="spacer" />
        <select
          v-model="importMode"
          title="What an imported image does to this tileset"
        >
          <option value="replace">
            replace
          </option>
          <option value="merge">
            merge
          </option>
        </select>
        <label class="inline">
          <input
            v-model="importDedup"
            type="checkbox"
          >
          <span>dedup</span>
        </label>
        <button
          type="button"
          @click="importVisible = true"
        >
          Import image…
        </button>
        <button
          type="button"
          :disabled="!session.dirty"
          @click="save"
        >
          {{ session.dirty ? 'Save' : 'Saved' }}
        </button>
        <button
          type="button"
          title="Write the C header / binary this tileset exports"
          @click="exportNow"
        >
          Export
        </button>
      </div>

      <div class="panes">
        <TileGrid :session="session" />
        <TileCanvas :session="session" />
        <TileSidePanel :session="session" />
      </div>

      <TileMapPreview :session="session" />

      <p
        v-if="session.status"
        class="status"
      >
        {{ session.status }}
      </p>
    </template>

    <ImportImageDialog
      v-if="importVisible"
      :mode="session.doc.mode"
      :standalone="false"
      @close="importVisible = false"
      @imported="onImported"
    />
  </div>
</template>

<style scoped>
.tile-editor {
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

.toolbar select {
  padding: 2px 4px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-tab-inactive);
  color: var(--color-text);
  font-size: 11px;
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

.panes > :nth-child(2) {
  flex: 1;
  min-width: 0;
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
