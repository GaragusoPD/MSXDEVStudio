<script setup lang="ts">
/**
 * The `*.meta-tiles.json` / `*.meta-btiles.json` editor.
 *
 * A meta-tile is one design bigger than the hardware's 8×8 cell — a tree, a
 * door, a coin — painted here as a picture and stored as references into a
 * tileset. Painting resolves each stroke to tile indices, creating tiles in the
 * referenced `.tiles.json` as it goes (see `shared/msx/meta-paint.ts`), which is
 * how a thing that owns no pixels gets a pixel editor.
 *
 * This file is a shell: the canvas, the frame strip and the side panel are their
 * own components, and every mutation is a call into `./session`.
 */
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { isTypingTarget } from '../../commands'
import { MAX_META_SIZE } from '../../../../shared/msx/meta-tile'
import type { TileTool } from '../../../../shared/tile-editor'
import type { MaterialSymbol } from '@material-symbols/font-400'
import Icon from '../../components/Icon.vue'
import MetaCanvas from './MetaCanvas.vue'
import MetaFrameBar from './MetaFrameBar.vue'
import MetaSidePanel from './MetaSidePanel.vue'
import { useResourcesStore } from '../../stores/resourcesStore'
import { useTabsStore } from '../../stores/tabsStore'
import {
  canRedo,
  canUndo,
  doc,
  metaSession,
  pruneMetaSessions,
  redo,
  reloadTileset,
  saveSession,
  setBrush,
  setColor,
  setFilledRect,
  setTool,
  setZoom,
  undo,
  type MetaSession
} from './session'

const props = defineProps<{ path: string }>()

const tabsStore = useTabsStore()
const resourcesStore = useResourcesStore()

const session = computed<MetaSession>(() => metaSession(props.path))
const meta = computed(() => doc(session.value))

/**
 * Spray is the one tool the tile editor does not have. Its dither is ordered
 * rather than random, so the same drag twice gives the same art — see
 * `sprayPoints`.
 */
const TOOLS: { id: TileTool; icon: MaterialSymbol; title: string }[] = [
  { id: 'pencil', icon: 'edit', title: 'Pencil' },
  { id: 'line', icon: 'pen_size_1', title: 'Line' },
  { id: 'rect', icon: 'rectangle', title: 'Rectangle' },
  { id: 'fill', icon: 'format_color_fill', title: 'Fill' },
  { id: 'spray', icon: 'blur_on', title: 'Spray (ordered dither)' }
]

/**
 * Stage 1 paints pattern modes. A `.meta-btiles.json` references a bitmap
 * tileset, which is not a `TilesDoc` at all, so its pixel editor waits for
 * stage 2 rather than being half-wired now.
 */
const paintable = computed(() => session.value.kind === 'metatiles')

async function save(): Promise<void> {
  await saveSession(session.value)
}

async function exportNow(): Promise<void> {
  await save()
  await resourcesStore.exportOne(session.value.path)
}

function onKeydown(event: KeyboardEvent): void {
  if (isTypingTarget(event)) return
  if (!event.ctrlKey) return
  const key = event.key.toLowerCase()
  if (key === 'z' && !event.shiftKey) {
    event.preventDefault()
    undo(session.value)
  } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
    event.preventDefault()
    redo(session.value)
  } else if (key === 's') {
    event.preventDefault()
    void save()
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

watch(
  () => tabsStore.tabs.length,
  () => pruneMetaSessions(new Set(tabsStore.tabs.map((tab) => tab.filePath ?? ''))),
  { immediate: true }
)
</script>

<template>
  <div class="meta-editor">
    <p
      v-if="session.error"
      class="banner error"
    >
      {{ session.error }}
    </p>

    <header class="toolbar">
      <div class="group">
        <button
          v-for="tool in TOOLS"
          :key="tool.id"
          type="button"
          :class="{ active: session.tool === tool.id }"
          :disabled="!paintable"
          :title="tool.title"
          @click="setTool(session, tool.id)"
        >
          <Icon :name="tool.icon" />
        </button>
        <button
          type="button"
          class="erase"
          :class="{ active: session.color === 0 }"
          :disabled="!paintable"
          title="Erase — paints the transparent index, so it works with every tool above"
          @click="setColor(session, 0)"
        >
          <Icon name="ink_eraser" />
        </button>
        <label
          v-if="session.tool === 'rect'"
          class="inline"
        >
          <input
            type="checkbox"
            :checked="session.filledRect"
            @change="setFilledRect(session, ($event.target as HTMLInputElement).checked)"
          >
          <span>Filled</span>
        </label>
        <template v-if="session.tool === 'spray'">
          <label class="inline">
            <span>Size</span>
            <input
              type="number"
              min="1"
              max="16"
              :value="session.brushRadius"
              @change="setBrush(session, Number(($event.target as HTMLInputElement).value), session.density)"
            >
          </label>
          <label class="inline">
            <span>Density</span>
            <input
              type="range"
              min="0"
              max="16"
              :value="session.density"
              @input="setBrush(session, session.brushRadius, Number(($event.target as HTMLInputElement).value))"
            >
          </label>
        </template>
      </div>

      <div class="group">
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
        <button
          type="button"
          title="Zoom out"
          @click="setZoom(session, session.zoom - 2)"
        >
          <Icon name="zoom_out" />
        </button>
        <button
          type="button"
          title="Zoom in"
          @click="setZoom(session, session.zoom + 2)"
        >
          <Icon name="zoom_in" />
        </button>
        <button
          type="button"
          title="Re-read the tileset from disk"
          :disabled="!meta.tileset"
          @click="reloadTileset(session)"
        >
          <Icon name="refresh" />
        </button>
      </div>

      <div class="group right">
        <span class="status">{{ session.status }}</span>
        <button
          type="button"
          @click="save"
        >
          Save
        </button>
        <button
          type="button"
          :disabled="!meta.export"
          title="Save, then write the C header"
          @click="exportNow"
        >
          Export
        </button>
      </div>
    </header>

    <p
      v-if="!paintable"
      class="banner"
    >
      Pixel editing for bitmap-mode meta-tiles is not here yet, and a bitmap map cannot place one.
      This file records its size, frames and flags, and exports a <code>_Draw</code> that blits a
      frame out of the atlas.
    </p>

    <div class="body">
      <div class="centre">
        <MetaCanvas :session="session" />
        <MetaFrameBar :session="session" />
      </div>
      <MetaSidePanel :session="session" />
    </div>

    <footer class="statusbar">
      {{ meta.width }}×{{ meta.height }} tiles (max {{ MAX_META_SIZE }}) ·
      frame {{ session.frame + 1 }} of {{ meta.frames.length }} ·
      {{ meta.tileset || 'no tileset' }}
    </footer>
  </div>
</template>

<style scoped>
.meta-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border, #333);
}

.group {
  display: flex;
  align-items: center;
  gap: 4px;
}

.group.right {
  margin-left: auto;
}

.toolbar button.active {
  outline: 2px solid #ffd24e;
}

/* Separated from the tools: it sets the colour, it is not a fifth tool. */
.erase {
  margin-left: 8px;
}

.inline {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}

.inline input[type='number'] {
  width: 52px;
}

.status {
  font-size: 11px;
  opacity: 0.8;
  max-width: 42ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.centre {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.banner {
  margin: 0;
  padding: 6px 10px;
  font-size: 12px;
  background: #2f2a1a;
}

.banner.error {
  background: #3a2020;
  color: #ffb0b0;
}

.statusbar {
  padding: 4px 10px;
  font-size: 11px;
  opacity: 0.7;
  border-top: 1px solid var(--border, #333);
}
</style>
