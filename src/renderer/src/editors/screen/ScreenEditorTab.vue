<script setup lang="ts">
/**
 * Spec 10 B — the `.screen.json` editor tab: source PNG + convert settings +
 * retouch strokes. Side-by-side original/converted preview at real MSX
 * resolution, a palette panel, and pencil/fill retouch on the converted
 * indexed image.
 *
 * Registered for the `screen.json` compound extension in
 * `editors/bootstrap.ts`, so the explorer opens screens here instead of in
 * Monaco. Conversion itself runs in the renderer (Spec 07's rule — main can't
 * decode PNGs); `ImportImageDialog` + its quantize worker do the heavy work,
 * and the result floats over the canvas until it is dragged into place.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import ImportImageDialog from '../../components/ImportImageDialog.vue'
import type { ImportResult } from '../../composables/useImageImport'
import { isBlankScreen } from '../../../../shared/screen-editor'
import { useResourcesStore } from '../../stores/resourcesStore'
import { useTabsStore } from '../../stores/tabsStore'
import ScreenCanvas from './ScreenCanvas.vue'
import ScreenPalettePanel from './ScreenPalettePanel.vue'
import { isTypingTarget } from '../../commands'
import Icon from '../../components/Icon.vue'
import {
  canRedo,
  canUndo,
  cancelFloat,
  clearRetouchAction,
  clearSelection,
  copySelection,
  cutSelection,
  deleteSelection,
  doc,
  dropFloat,
  importImage,
  nudgeSelection,
  pasteClipboard,
  pruneScreenSessions,
  redo,
  saveSession,
  screenSession,
  selectAll,
  startBlank,
  undo
} from './session'

const tabsStore = useTabsStore()
const resourcesStore = useResourcesStore()

const path = computed(() => tabsStore.activeTab?.filePath ?? '')
const session = computed(() => screenSession(path.value))
const importVisible = ref(false)

async function save(): Promise<void> {
  try {
    await saveSession(session.value)
  } catch (error) {
    session.value.status = `Save failed: ${String(error)}`
  }
}

/** Export goes through Spec 07's converter, so the file on disk has to be current first. It refuses
 *  (with a message routed to the Output panel) when there's no `converted` cache yet — see
 *  `resourceTables` in `shared/msx/resource.ts`. */
async function exportNow(): Promise<void> {
  await save()
  await resourcesStore.exportOne(session.value.path)
}

function onImported(result: ImportResult): void {
  importImage(session.value, result)
  importVisible.value = false
}

/** The arrow keys' step, in pixels: one, or a character cell with Shift. */
const NUDGE: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1]
}

function onKeydown(event: KeyboardEvent): void {
  // Typing a filename in a side panel is not an editor shortcut.
  if (isTypingTarget(event)) return
  const active = session.value
  if (event.ctrlKey) {
    const key = event.key.toLowerCase()
    // Ctrl+S is EditorArea's, for every tab kind — see `commands.ts`.
    if (key === 'z' && !event.shiftKey) {
      event.preventDefault()
      undo(active)
    } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
      event.preventDefault()
      redo(active)
    } else if (key === 'c') {
      copySelection(active)
    } else if (key === 'x') {
      cutSelection(active)
    } else if (key === 'v') {
      pasteClipboard(active)
    } else if (key === 'a') {
      event.preventDefault()
      selectAll(active)
    }
    return
  }
  const step = NUDGE[event.key]
  if (step && active.tool === 'select' && (active.float || active.selection)) {
    event.preventDefault()
    const size = event.shiftKey ? 8 : 1
    nudgeSelection(active, step[0] * size, step[1] * size)
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    deleteSelection(active)
  } else if (event.key === 'Enter' && active.float) {
    event.preventDefault()
    dropFloat(active)
  } else if (event.key === 'Escape') {
    if (active.float) cancelFloat(active)
    else clearSelection(active)
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
onMounted(() => void resourcesStore.refresh())

// Sessions outlive tab switches (like Monaco models do); drop the ones whose tab is gone.
watch(
  () => tabsStore.tabs.length,
  () => pruneScreenSessions(new Set(tabsStore.tabs.map((tab) => tab.filePath ?? ''))),
  { immediate: true }
)

</script>

<template>
  <div class="screen-editor">
    <p
      v-if="session.error"
      class="error"
    >
      {{ session.error }}
    </p>
    <template v-else-if="!session.loading">
      <div class="toolbar">
        <button
          type="button"
          title="Convert an image and paste it onto the screen — drag it into place before it lands"
          @click="importVisible = true"
        >
          Import image…
        </button>
        <button
          v-if="doc(session).source"
          type="button"
          title="Drop every retouch pixel, back to the raw conversion"
          @click="clearRetouchAction(session)"
        >
          Clear retouch
        </button>

        <span class="sep" />
        <button
          type="button"
          title="Cut the selection (Ctrl+X)"
          :disabled="!session.selection && !session.float"
          @click="cutSelection(session)"
        >
          <Icon name="content_cut" />
        </button>
        <button
          type="button"
          title="Copy the selection (Ctrl+C)"
          :disabled="!session.selection && !session.float"
          @click="copySelection(session)"
        >
          <Icon name="content_copy" />
        </button>
        <button
          type="button"
          title="Paste — it floats until you drag it into place and press Enter (Ctrl+V)"
          :disabled="!session.clipboard"
          @click="pasteClipboard(session)"
        >
          <Icon name="content_paste" />
        </button>
        <button
          type="button"
          title="Clear the selection to colour 0 (Delete)"
          :disabled="!session.selection && !session.float"
          @click="deleteSelection(session)"
        >
          <Icon name="delete" />
        </button>
        <template v-if="session.float">
          <button
            type="button"
            title="Put the floating pixels down here (Enter)"
            @click="dropFloat(session)"
          >
            Place
          </button>
          <button
            type="button"
            title="Take the floating pixels back (Esc)"
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
            v-model.number="session.zoom"
            type="range"
            :min="1"
            :max="8"
            :step="1"
          >
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
          title="Write the palette / packed bitmap this screen exports"
          @click="exportNow"
        >
          Export
        </button>
      </div>

      <p
        v-if="!doc(session).source"
        class="hint"
      >
        <template v-if="doc(session).mode === 'sc3'">
          SCREEN 3 is 64×48 blocks of 4×4 dots with no colour clash, on any machine —
          draw here with the pencil, line, rectangle and fill tools, or import an image
          and it is reduced to fit. Name fragments for software-sprite frames.
        </template>
        <template v-else>
          Bitmap screens are for the MSX2 modes (SCREEN 5–12): import an image and drag it
          into place, then retouch it with the pencil/fill tools and palette panel.
          For MSX1 full-screen art, either switch this to SCREEN 3 and draw, or draw a
          tileset in the tile editor and place it in a map — a 32×24 map is one screen.
        </template>
      </p>

      <!-- An empty document is a dead editor until this is pressed, so it is a
           button in its own right rather than a link inside a paragraph. New
           screens are created with a canvas already, so this is the way back
           from a document that has none. -->
      <div
        v-if="!doc(session).converted"
        class="empty"
      >
        <p>Nothing to draw on yet.</p>
        <div class="empty-actions">
          <button
            type="button"
            class="primary"
            @click="startBlank(session)"
          >
            <Icon name="add" />
            Start a blank canvas
          </button>
          <button
            type="button"
            @click="importVisible = true"
          >
            <Icon name="image" />
            Import an image…
          </button>
        </div>
      </div>

      <div class="panes">
        <ScreenCanvas :session="session" />
        <ScreenPalettePanel :session="session" />
      </div>

      <p
        v-if="session.status"
        class="status"
      >
        {{ session.status }}
      </p>
    </template>

    <!-- The screen has a mode and a size; the picture is converted into both,
         and to the colours already on it unless the user picks otherwise. -->
    <ImportImageDialog
      v-if="importVisible"
      :mode="doc(session).mode"
      :fit-width="doc(session).width"
      :fit-height="doc(session).height"
      :standalone="false"
      lock-mode
      :current-palette="doc(session).converted?.palette ?? null"
      :prefer-current="!isBlankScreen(doc(session))"
      use-label="Place this image"
      @close="importVisible = false"
      @imported="onImported"
    />
  </div>
</template>

<style scoped>
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.6rem;
  padding: 2rem 1rem;
}

.empty p {
  margin: 0;
  opacity: 0.75;
}

.empty-actions {
  display: flex;
  gap: 0.5rem;
}

.screen-editor {
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

.hint {
  margin: 0;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--color-text-muted);
}

.hint .link {
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: var(--color-accent);
  text-decoration: underline;
  cursor: pointer;
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
