<script setup lang="ts">
import type { MaterialSymbol } from '@material-symbols/font-400'
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
import type { TileTool } from '../../../../shared/tile-editor'
import { useResourcesStore } from '../../stores/resourcesStore'
import { useTabsStore } from '../../stores/tabsStore'
import MapCanvas from './MapCanvas.vue'
import MapMetaPicker from './MapMetaPicker.vue'
import MapPicker from './MapPicker.vue'
import MapSidePanel from './MapSidePanel.vue'
import Icon from '../../components/Icon.vue'
import { isTypingTarget } from '../../commands'
import {
  canPaint,
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
  setMode,
  setPaintTool,
  setTool,
  undo,
} from './session'

const tabsStore = useTabsStore()
const resourcesStore = useResourcesStore()

const path = computed(() => tabsStore.activeTab?.filePath ?? '')
const session = computed(() => mapSession(path.value))

const TOOLS: { id: MapTool; icon: MaterialSymbol; title: string }[] = [
  { id: 'stamp', icon: 'edit', title: 'Stamp — drag to paint the picked tile(s)' },
  { id: 'fill', icon: 'format_color_fill', title: 'Fill (flood)' },
  { id: 'rect', icon: 'rectangle', title: 'Rectangle' },
  { id: 'erase', icon: 'ink_eraser', title: 'Erase' }
]

/**
 * The pixel tools, the meta editor's list verbatim — same icons, same names —
 * so a user moving between the two editors reads one vocabulary. Which list is
 * live is the Tiles/Paint toggle's business: never one list holding both,
 * where half the buttons act on cells and half on dots.
 */
const PAINT_TOOLS: { id: TileTool; icon: MaterialSymbol; title: string }[] = [
  { id: 'pencil', icon: 'edit', title: 'Pencil' },
  { id: 'line', icon: 'pen_size_1', title: 'Line' },
  { id: 'rect', icon: 'rectangle', title: 'Rectangle' },
  { id: 'fill', icon: 'format_color_fill', title: 'Fill' },
  { id: 'spray', icon: 'blur_on', title: 'Spray (ordered dither)' }
]

/** `filledRect` serves both rect tools, so the checkbox follows whichever one the mode makes live. */
const rectLive = computed(
  () => (session.value.mode === 'paint' ? session.value.paintTool : session.value.tool) === 'rect'
)

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

function onKeydown(event: KeyboardEvent): void {
  // Typing a filename in a side panel is not an editor shortcut.
  if (isTypingTarget(event)) return
  const active = session.value
  // The cell shortcuts follow their buttons: Copy/Paste/Delete are hidden in
  // paint mode, so the keys sit out too — a hidden control with a live
  // shortcut is an asymmetry nobody can explain from the screen. Undo/redo
  // stay, as their buttons do.
  const cells = active.mode === 'tiles'
  if (event.ctrlKey) {
    const key = event.key.toLowerCase()
    // Ctrl+S is EditorArea's, for every tab kind — see `commands.ts`.
    if (key === 'z' && !event.shiftKey) {
      event.preventDefault()
      undo(active)
    } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
      event.preventDefault()
      redo(active)
    } else if (key === 'c' && cells) {
      copySelection(active)
    } else if (key === 'v' && cells) {
      pasteClipboard(active)
    }
  } else if ((event.key === 'Delete' || event.key === 'Backspace') && cells) {
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
        <!--
          Tiles | Paint: which tool set is live. Only offered where there is a
          pattern tileset to paint into (`canPaint`) — a bitmap map has the
          screen editor. Hiding it cannot strand a map in paint mode, because
          `session.ts` drops the mode back to tiles when a map loses its tileset.
        -->
        <template v-if="canPaint(session)">
          <button
            type="button"
            :class="{ active: session.mode === 'tiles' }"
            title="Tiles — stamp, fill, outline and erase whole cells"
            @click="setMode(session, 'tiles')"
          >
            Tiles
          </button>
          <button
            type="button"
            :class="{ active: session.mode === 'paint' }"
            title="Paint — draw dots straight onto the map; each stroke becomes tiles in the tileset"
            @click="setMode(session, 'paint')"
          >
            Paint
          </button>
          <span class="sep" />
        </template>

        <template v-if="session.mode === 'paint'">
          <button
            v-for="tool in PAINT_TOOLS"
            :key="tool.id"
            type="button"
            :class="{ active: session.paintTool === tool.id }"
            :title="tool.title"
            @click="setPaintTool(session, tool.id)"
          >
            <Icon :name="tool.icon" />
          </button>
        </template>
        <template v-else>
          <button
            v-for="tool in TOOLS"
            :key="tool.id"
            type="button"
            :class="{ active: session.tool === tool.id }"
            :title="tool.title"
            @click="setTool(session, tool.id)"
          >
            <Icon :name="tool.icon" />
          </button>
        </template>
        <label
          v-if="rectLive"
          class="inline"
        >
          <input
            v-model="session.filledRect"
            type="checkbox"
          >
          <span>filled</span>
        </label>

        <!-- Cell selection is a tiles-mode affair; the buttons go with the tools. -->
        <template v-if="session.mode === 'tiles'">
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
        </template>

        <span class="sep" />
        <button
          type="button"
          title="Undo (Ctrl+Z)"
          :disabled="!canUndo(session.history)"
          @click="undo(session)"
        >
          <Icon name="undo" />
        </button>
        <button
          type="button"
          title="Redo (Ctrl+Y)"
          :disabled="!canRedo(session.history)"
          @click="redo(session)"
        >
          <Icon name="redo" />
        </button>

        <span class="sep" />
        <label
          class="zoom"
          title="Zoom"
        >
          <Icon name="zoom_in" />
          <input
            v-model.number="session.zoom"
            type="range"
            :min="4"
            :max="48"
            :step="2"
          >
        </label>
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
        <!-- Tiles above, meta-tiles below: one column, two things to paint with. -->
        <div class="left-rail">
          <MapPicker :session="session" />
          <MapMetaPicker :session="session" />
        </div>
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

/*
 * One rail, one width, one edge. The tile picker takes the space; the meta-tile
 * picker sizes to its content and stops at 40% so it can never squeeze the
 * tiles out.
 */
.left-rail {
  display: flex;
  flex: none;
  flex-direction: column;
  min-height: 0;
  width: 260px;
  border-right: 1px solid var(--color-border);
}

.left-rail > :last-child {
  max-height: 40%;
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

.zoom {
  display: flex;
  align-items: center;
  gap: 4px;
}
.zoom input {
  width: 84px;
}
</style>
