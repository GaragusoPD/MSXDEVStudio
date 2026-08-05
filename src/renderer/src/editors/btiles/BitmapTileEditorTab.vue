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
import type { MaterialSymbol } from '@material-symbols/font-400'
import Icon from '../../components/Icon.vue'
import ImportImageDialog from '../../components/ImportImageDialog.vue'
import type { ImportResult } from '../../composables/useImageImport'
import type { TileTool } from '../../../../shared/bitmap-tile-editor'
import { useResourcesStore } from '../../stores/resourcesStore'
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
  removeTile,
  saveSession
} from './session'

// `EditorArea` renders the active editor with no props — every resource tab
// takes its own path off the tabs store, and the session is keyed on it.
const tabs = useTabsStore()
const path = computed(() => tabs.activeTab?.filePath ?? '')
const session = computed(() => bitmapTileSession(path.value))
const tileset = computed(() => doc(session.value))
const importing = ref(false)
const dedupe = ref(true)

// The same four icons the pattern tile editor uses, so a tool is the same
// picture whichever tileset is open.
const TOOLS: { id: TileTool; icon: MaterialSymbol; title: string }[] = [
  { id: 'pencil', icon: 'edit', title: 'Pencil' },
  { id: 'line', icon: 'pen_size_1', title: 'Line' },
  { id: 'rect', icon: 'rectangle', title: 'Rectangle' },
  { id: 'fill', icon: 'format_color_fill', title: 'Fill' }
]

// Sessions outlive tab switches; drop the ones whose tab is gone. Keyed on
// `filePath`, which is what a session is keyed on — `id` is the tab's own
// identity and would prune every live session on the first change.
watch(
  () => tabs.tabs.length,
  () => pruneBitmapTileSessions(new Set(tabs.tabs.map((tab) => tab.filePath ?? ''))),
  { immediate: true }
)

const resourcesStore = useResourcesStore()

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
            type="button"
            :class="{ active: session.tool === tool.id }"
            :title="tool.title"
            @click="session.tool = tool.id"
          >
            <Icon :name="tool.icon" />
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
            max="40"
          ></label>
        </div>

        <div class="group">
          <button
            type="button"
            title="Add a tile to the end of the bank"
            @click="addTile(session)"
          >
            <Icon name="add" />
          </button>
          <button
            type="button"
            title="Remove the selected tile (flags and blocks renumber)"
            :disabled="tileset.count <= 1"
            @click="removeTile(session, session.selected)"
          >
            <Icon name="delete" />
          </button>
          <button
            type="button"
            title="Move the selected tile earlier"
            :disabled="session.selected <= 0"
            @click="moveTile(session, session.selected, session.selected - 1)"
          >
            <Icon name="arrow_back" />
          </button>
          <button
            type="button"
            title="Move the selected tile later"
            :disabled="session.selected >= tileset.count - 1"
            @click="moveTile(session, session.selected, session.selected + 1)"
          >
            <Icon name="arrow_forward" />
          </button>
        </div>

        <div class="group">
          <button
            type="button"
            title="Cut an image into this bank"
            @click="importing = true"
          >
            <Icon name="image" />
          </button>
          <label class="check"><input
            v-model="dedupe"
            type="checkbox"
          > collapse repeats</label>
        </div>

        <span class="status">
          {{ tileset.count }} tiles of {{ tileset.width }}×{{ tileset.height }} · {{ session.status }}
        </span>
        <span class="spacer" />

        <div class="group">
          <button
            type="button"
            :title="session.dirty ? 'Save (Ctrl+S)' : 'Saved'"
            :disabled="!session.dirty"
            @click="save"
          >
            <Icon name="save" />
          </button>
          <button
            type="button"
            title="Write the C header / binary this tileset exports"
            @click="exportNow"
          >
            <Icon name="output" />
          </button>
        </div>
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
  border-bottom: 1px solid var(--color-border);
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
.toolbar button.active {
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: #ffffff;
}
.status {
  font-size: 11px;
  opacity: 0.65;
}
.spacer {
  flex: 1;
}
.panes {
  display: flex;
  flex: 1;
  min-height: 0;
}
.stage {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 16px;
  overflow: auto;
}
.error {
  padding: 12px;
  color: var(--color-error, #f14c4c);
}
</style>
