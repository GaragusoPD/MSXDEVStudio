<script setup lang="ts">
import type { MaterialSymbol } from '@material-symbols/font-400'
/**
 * Spec 10 A — the `.map.json` editor tab: tile picker, map canvas
 * (stamp/fill/rect/erase, select + move/cut/copy/paste, flags mode, layer
 * visibility, zoom/grid/screen-outline), and undo/redo. Every shortcut of the
 * map editor is here, on the window, so none of them fires twice.
 *
 * Registered for the `map.json` compound extension in `editors/bootstrap.ts`,
 * so the explorer opens maps here instead of in Monaco.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { SCREEN_COLS, SCREEN_ROWS } from '../../../../shared/msx/map'
import type { MapTool } from '../../../../shared/map-editor'
import type { TileTool } from '../../../../shared/tile-editor'
import { useResourcesStore } from '../../stores/resourcesStore'
import { useTabsStore } from '../../stores/tabsStore'
import MapCanvas from './MapCanvas.vue'
import MapMetaPicker from './MapMetaPicker.vue'
import MapPicker from './MapPicker.vue'
import MapSidePanel from './MapSidePanel.vue'
import Icon from '../../components/Icon.vue'
import Modal from '../../components/Modal.vue'
import { isTypingTarget } from '../../commands'
import { pixelsFromElsewhere } from '../picture-clipboard'
import {
  cancelFloat,
  canPaint,
  canRedo,
  canUndo,
  clearSelection,
  copySelection,
  cutSelection,
  deleteSelectedEntity,
  deleteSelectedPlacement,
  deleteSelection,
  doc,
  dropFloat,
  mapSession,
  maxZoom,
  metaFromSelection,
  MIN_ZOOM,
  nudgeSelection,
  pasteClipboard,
  pruneMapSessions,
  redo,
  saveSession,
  selectAll,
  setMode,
  setPaintTool,
  setTool,
  setZoom,
  sliceIntoRooms,
  undo,
} from './session'

const tabsStore = useTabsStore()
const resourcesStore = useResourcesStore()

const path = computed(() => tabsStore.activeTab?.filePath ?? '')
const session = computed(() => mapSession(path.value))

// A map grown past what its canvas can take at this zoom comes back down to it.
watch(
  () => maxZoom(session.value),
  (max) => {
    if (session.value.zoom > max) setZoom(session.value, max)
  }
)

const TOOLS: { id: MapTool; icon: MaterialSymbol; title: string }[] = [
  { id: 'stamp', icon: 'edit', title: 'Stamp — drag to paint the picked tile(s)' },
  { id: 'fill', icon: 'format_color_fill', title: 'Fill (flood)' },
  { id: 'rect', icon: 'rectangle', title: 'Rectangle' },
  { id: 'erase', icon: 'ink_eraser', title: 'Erase' },
  {
    id: 'select',
    icon: 'select',
    title:
      'Select — drag a rectangle, then drag inside it to move it with the meta-tiles on it (Ctrl+drag copies). ' +
      'Arrows nudge it, Enter places it, Esc takes it back; Ctrl+X/C/V, Delete'
  },
  {
    id: 'entity',
    icon: 'flag',
    title: 'Entities — click to drop one (spawn point, chest, door…), drag to move it, Delete removes it. Pick its type in the side panel.'
  }
]

/** The arrow keys' step, in cells: one, or eight with Shift. */
const NUDGE: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1]
}

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
  // The cell shortcuts follow their buttons: Cut/Copy/Paste/Delete are hidden
  // in paint mode, so the keys sit out too — a hidden control with a live
  // shortcut is an asymmetry nobody can explain from the screen. Undo/redo
  // stay, as their buttons do, and so does whatever handles a float: an
  // imported picture floats in paint mode too, and needs placing.
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
    } else if (key === 'x' && cells) {
      cutSelection(active)
    } else if (key === 'v' && cells) {
      pasteClipboard(active)
    } else if (key === 'a' && cells) {
      event.preventDefault()
      selectAll(active)
    }
    return
  }
  const step = NUDGE[event.key]
  if (step && (active.float || (cells && active.tool === 'select' && active.selection))) {
    event.preventDefault()
    const size = event.shiftKey ? 8 : 1
    nudgeSelection(active, step[0] * size, step[1] * size)
  } else if (event.key === 'Enter' && active.float) {
    event.preventDefault()
    void dropFloat(active)
  } else if (event.key === 'Escape') {
    if (active.float) cancelFloat(active)
    else if (cells) clearSelection(active)
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    // A selected meta-tile first: it is the more specific of the two things
    // a Delete could mean, and the one the user clicked last.
    if (active.float) deleteSelection(active)
    else if (cells && active.tool === 'entity') deleteSelectedEntity(active)
    else if (cells && active.selectedPlacement !== null) deleteSelectedPlacement(active)
    else if (cells) deleteSelection(active)
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

/**
 * Slice into rooms: one screen per room by default, which is the point — a
 * world room is a screen. A HUD makes rooms shorter, so the height is asked.
 */
const slicing = ref(false)
const sliceWidth = ref(SCREEN_COLS)
const sliceHeight = ref(SCREEN_ROWS)
const sliceSkipEmpty = ref(true)
const sliceGrid = computed(() => {
  const current = doc(session.value)
  return {
    cols: Math.ceil(current.width / Math.max(1, sliceWidth.value)),
    rows: Math.ceil(current.height / Math.max(1, sliceHeight.value))
  }
})
const sliceTarget = computed(() => session.value.path.replace(/\.map\.json$/i, ''))

async function slice(): Promise<void> {
  slicing.value = false
  await save()
  await sliceIntoRooms(session.value, {
    roomWidth: sliceWidth.value,
    roomHeight: sliceHeight.value,
    skipEmpty: sliceSkipEmpty.value
  })
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
            title="Cut the selection (Ctrl+X)"
            :disabled="!session.selection"
            @click="cutSelection(session)"
          >
            <Icon name="content_cut" />
          </button>
          <button
            type="button"
            title="Copy the selection (Ctrl+C)"
            :disabled="!session.selection"
            @click="copySelection(session)"
          >
            <Icon name="content_copy" />
          </button>
          <button
            type="button"
            title="Paste — it floats until you drag it into place and press Enter (Ctrl+V). Art copied in another map or a meta-tile comes in as pixels, made into this tileset's tiles."
            :disabled="!session.clipboard && !pixelsFromElsewhere(session.path)"
            @click="pasteClipboard(session)"
          >
            <Icon name="content_paste" />
          </button>
          <button
            type="button"
            title="Make a new meta-tile from the selection — its pixels become the meta-tile's own art, and the map is left as it is"
            :disabled="!session.selection || !!session.float"
            @click="metaFromSelection(session)"
          >
            <Icon name="widgets" />
          </button>
          <button
            type="button"
            title="Clear the selection to tile 0 (Delete)"
            :disabled="!session.selection"
            @click="deleteSelection(session)"
          >
            <Icon name="delete" />
          </button>
        </template>
        <!-- A float can be an imported picture in paint mode too, so these sit outside the tiles-only group. -->
        <template v-if="session.float">
          <button
            type="button"
            title="Put it down here (Enter)"
            @click="dropFloat(session)"
          >
            Place
          </button>
          <button
            type="button"
            title="Take it back (Esc)"
            @click="cancelFloat(session)"
          >
            Cancel
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
            :value="session.zoom"
            type="range"
            :min="MIN_ZOOM"
            :max="maxZoom(session)"
            :step="2"
            :title="`${session.zoom / 8} pixels a dot`"
            @input="setZoom(session, Number(($event.target as HTMLInputElement).value))"
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
        <button
          type="button"
          title="Cut this map into one-screen rooms and a world that places them — design the overworld as one canvas, ship it as rooms"
          @click="slicing = true"
        >
          <Icon name="grid_view" />
          Slice into rooms…
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

      <Modal
        v-if="slicing"
        title="Slice into rooms"
        @close="slicing = false"
      >
        <form
          class="slice"
          @submit.prevent="slice"
        >
          <p class="hint">
            Writes each room as its own map, and a world that places them on a grid. This map stays
            as it is — keep designing on it, or work room by room from now on.
          </p>
          <div class="slice-size">
            <label>
              <span>Room width</span>
              <input
                v-model.number="sliceWidth"
                type="number"
                min="1"
                :max="SCREEN_COLS"
              >
            </label>
            <label>
              <span>Room height</span>
              <input
                v-model.number="sliceHeight"
                type="number"
                min="1"
                :max="SCREEN_ROWS"
              >
            </label>
          </div>
          <p class="hint">
            {{ SCREEN_COLS }}×{{ SCREEN_ROWS }} is one screen. Leave rows for a HUD by making rooms shorter
            (the world draws them lower down) — but a banked tileset only works {{ SCREEN_ROWS }} rows tall.
          </p>
          <label class="inline">
            <input
              v-model="sliceSkipEmpty"
              type="checkbox"
            >
            <span>Leave empty rooms out (all tile 0, nothing placed)</span>
          </label>
          <p class="hint">
            {{ sliceGrid.cols }}×{{ sliceGrid.rows }} rooms:
            <code>{{ sliceTarget }}_r0_c0.map.json</code> … and <code>{{ sliceTarget }}.world.json</code>.
          </p>
          <div class="actions">
            <button
              type="button"
              @click="slicing = false"
            >
              Cancel
            </button>
            <button
              type="submit"
              class="primary"
              :disabled="sliceWidth < 1 || sliceHeight < 1 || sliceWidth > SCREEN_COLS || sliceHeight > SCREEN_ROWS"
            >
              Slice
            </button>
          </div>
        </form>
      </Modal>
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

.slice .hint {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--color-text-muted);
}

.slice-size {
  display: flex;
  gap: 12px;
  margin-bottom: 8px;
}

.slice-size label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 12px;
}

.slice-size input {
  width: 90px;
  padding: 3px 5px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-tab-inactive);
  color: var(--color-text);
}

.slice .inline {
  margin-bottom: 10px;
  font-size: 12px;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.actions button {
  padding: 4px 12px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-hover);
}

.actions button.primary {
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: #ffffff;
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
