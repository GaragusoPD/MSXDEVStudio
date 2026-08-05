<script setup lang="ts">
/**
 * The bitmap tileset editor: the bank on the left, the selected tile at zoom in
 * the middle, everything that is not a pixel on the right.
 *
 * The one control here that a pattern tileset has no equivalent for is Import:
 * it slices a picture into the bank, optionally collapsing repeats. That is the
 * reason this resource exists — art that came from outside can become a tileset
 * without being redrawn cell by cell.
 */
import { computed, ref, watch } from 'vue'
import ImportImageDialog from '../../components/ImportImageDialog.vue'
import type { ImportResult } from '../../composables/useImageImport'
import type { TileTool } from '../../../../shared/bitmap-tile-editor'
import { useTabsStore } from '../../stores/tabsStore'
import BitmapTileCanvas from './BitmapTileCanvas.vue'
import BitmapTileGrid from './BitmapTileGrid.vue'
import BitmapTileSidePanel from './BitmapTileSidePanel.vue'
import {
  addTile,
  bitmapTileSession,
  doc,
  importImage,
  moveTile,
  pruneBitmapTileSessions,
  removeTile
} from './session'

// `EditorArea` renders the active editor with no props — every resource tab
// takes its own path off the tabs store, and the session is keyed on it.
const tabs = useTabsStore()
const path = computed(() => tabs.activeTab?.filePath ?? '')
const session = computed(() => bitmapTileSession(path.value))
const tileset = computed(() => doc(session.value))
const importing = ref(false)
const dedupe = ref(true)

const TOOLS: { id: TileTool; label: string }[] = [
  { id: 'pencil', label: 'Pencil' },
  { id: 'line', label: 'Line' },
  { id: 'rect', label: 'Rect' },
  { id: 'fill', label: 'Fill' }
]

// Sessions outlive tab switches; drop the ones whose tab is gone. Keyed on
// `filePath`, which is what a session is keyed on — `id` is the tab's own
// identity and would prune every live session on the first change.
watch(
  () => tabs.tabs.length,
  () => pruneBitmapTileSessions(new Set(tabs.tabs.map((tab) => tab.filePath ?? ''))),
  { immediate: true }
)

function onImported(result: ImportResult): void {
  importImage(session.value, result, dedupe.value)
  importing.value = false
}
</script>

<template>
  <div class="btiles">
    <p
      v-if="session.error"
      class="error"
    >
      {{ session.error }}
    </p>
    <template v-else-if="!session.loading">
      <header class="toolbar">
        <div class="group">
          <button
            v-for="tool in TOOLS"
            :key="tool.id"
            :class="{ on: session.tool === tool.id }"
            @click="session.tool = tool.id"
          >
            {{ tool.label }}
          </button>
          <label
            v-if="session.tool === 'rect'"
            class="check"
          >
            <input
              v-model="session.filled"
              type="checkbox"
            > filled
          </label>
        </div>

        <div class="group">
          <label class="check">Zoom <input
            v-model.number="session.zoom"
            type="range"
            min="4"
            max="24"
          ></label>
        </div>

        <div class="group">
          <button @click="addTile(session)">
            Add tile
          </button>
          <button
            :disabled="tileset.count <= 1"
            @click="removeTile(session, session.selected)"
          >
            Remove
          </button>
          <button
            :disabled="session.selected <= 0"
            @click="moveTile(session, session.selected, session.selected - 1)"
          >
            ←
          </button>
          <button
            :disabled="session.selected >= tileset.count - 1"
            @click="moveTile(session, session.selected, session.selected + 1)"
          >
            →
          </button>
        </div>

        <div class="group">
          <button @click="importing = true">
            Import image…
          </button>
          <label class="check"><input
            v-model="dedupe"
            type="checkbox"
          > collapse repeats</label>
        </div>

        <span class="status">
          {{ tileset.count }} tiles of {{ tileset.width }}×{{ tileset.height }} · {{ session.status }}
        </span>
      </header>

      <div class="panes">
        <BitmapTileGrid
          :session="session"
          @select="session.selected = $event"
        />
        <div class="stage">
          <BitmapTileCanvas :session="session" />
        </div>
        <BitmapTileSidePanel
          :session="session"
          @color="session.color = $event"
        />
      </div>
    </template>

    <ImportImageDialog
      v-if="importing"
      :mode="tileset.mode"
      :standalone="false"
      @close="importing = false"
      @imported="onImported"
    />
  </div>
</template>

<style scoped>
.btiles {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border, #333);
  flex-wrap: wrap;
}
.group {
  display: flex;
  align-items: center;
  gap: 4px;
}
.check {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  opacity: 0.85;
}
button.on {
  outline: 2px solid #4ea1ff;
}
.status {
  margin-left: auto;
  font-size: 11px;
  opacity: 0.65;
}
.panes {
  display: flex;
  flex: 1;
  min-height: 0;
}
.stage {
  flex: 1;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 16px;
  overflow: auto;
}
.error {
  padding: 12px;
  color: #ff6b6b;
}
</style>
