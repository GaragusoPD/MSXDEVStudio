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
 * this tab just persists the result.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import ImportImageDialog from '../../components/ImportImageDialog.vue'
import type { ImportResult } from '../../composables/useImageImport'
import type { ScreenMode } from '../../../../shared/msx/modes'
import { useResourcesStore } from '../../stores/resourcesStore'
import { useTabsStore } from '../../stores/tabsStore'
import ScreenCanvas from './ScreenCanvas.vue'
import ScreenPalettePanel from './ScreenPalettePanel.vue'
import { isTypingTarget } from '../../commands'
import {
  canRedo,
  canUndo,
  clearRetouchAction,
  doc,
  importSource,
  pruneScreenSessions,
  redo,
  saveSession,
  screenSession,
  startBlank,
  undo,
  type ScreenSession
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

function zoom(delta: number): void {
  const active = session.value
  active.zoom = Math.max(1, Math.min(8, active.zoom + delta))
}

async function onImported(result: ImportResult, file: File | null, mode: ScreenMode): Promise<void> {
  await importSource(session.value, result, file, mode)
  importVisible.value = false
}

function onKeydown(event: KeyboardEvent): void {
  // Typing a filename in a side panel is not an editor shortcut.
  if (isTypingTarget(event)) return
  if (!event.ctrlKey) return
  const key = event.key.toLowerCase()
  // Ctrl+S is EditorArea's, for every tab kind — see `commands.ts`.
  if (key === 'z' && !event.shiftKey) {
    event.preventDefault()
    undo(session.value)
  } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
    event.preventDefault()
    redo(session.value)
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

function sourceButtonLabel(active: ScreenSession): string {
  return doc(active).source ? 'Replace source image…' : 'Import source image…'
}
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
          @click="importVisible = true"
        >
          {{ sourceButtonLabel(session) }}
        </button>
        <button
          type="button"
          title="Drop every retouch pixel, back to the raw conversion"
          @click="clearRetouchAction(session)"
        >
          Clear retouch
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
          @click="zoom(-1)"
        >
          −
        </button>
        <button
          type="button"
          title="Zoom in"
          @click="zoom(1)"
        >
          +
        </button>

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
        Bitmap screens are for the MSX2 modes (SCREEN 5–12): import a source image,
        then retouch the conversion with the pencil/fill tools and palette panel.
        For MSX1 full-screen art (SCREEN 1/2), draw a tileset in the tile editor and
        place it in a map instead — a 32×24 map is one screen.
        <template v-if="!doc(session).converted">
          Or
          <button
            type="button"
            class="link"
            @click="startBlank(session)"
          >
            start a blank canvas
          </button>
          and draw here — which is what an atlas or a sprite sheet usually wants.
        </template>
      </p>

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

    <ImportImageDialog
      v-if="importVisible"
      :mode="doc(session).mode"
      :standalone="false"
      @close="importVisible = false"
      @imported="onImported"
    />
  </div>
</template>

<style scoped>
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
</style>
