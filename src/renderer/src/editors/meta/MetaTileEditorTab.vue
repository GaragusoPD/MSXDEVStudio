<script setup lang="ts">
/**
 * The `*.meta-btiles.json` editor: a bitmap meta-tile.
 *
 * One design bigger than a tile of a `.btiles.json` set — a tree, a door, a
 * rock — painted here as a picture and stored as references into that set.
 * Painting resolves each stroke to tile indices, creating tiles in the set as
 * it goes (see `shared/msx/meta-paint.ts`), which is how a thing that owns no
 * pixels gets a pixel editor. (A pattern meta-tile owns its pixels and is
 * edited with the pose editor instead.)
 *
 * This file is a shell: the canvas, the frame strip and the side panel are their
 * own components, and every mutation is a call into `./session`.
 */
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { isTypingTarget } from '../../commands'
import { MAX_FRAMES, MAX_META_SIZE, type MetaFrame } from '../../../../shared/msx/meta-tile'
import type { TileTool } from '../../../../shared/tile-editor'
import type { MaterialSymbol } from '@material-symbols/font-400'
import AnimationBar from '../../components/AnimationBar.vue'
import Icon from '../../components/Icon.vue'
import { metaThumbnail } from '../map/sheet'
import MetaCanvas from './MetaCanvas.vue'
import MetaSidePanel from './MetaSidePanel.vue'
import { useResourcesStore } from '../../stores/resourcesStore'
import { useTabsStore } from '../../stores/tabsStore'
import {
  addFrame,
  bitmapTiles,
  canRedo,
  canUndo,
  doc,
  frameDots,
  frameRgba,
  metaSession,
  pruneMetaSessions,
  redo,
  reloadTileset,
  removeFrame,
  reorderFrames,
  saveSession,
  setBackground,
  setBrush,
  setColor,
  setDuration,
  setFilledRect,
  setFrame,
  setGridVisible,
  setOnionSkin,
  setTool,
  setZoom,
  sheet,
  togglePlaying,
  undo,
  type MetaSession
} from './session'

// `EditorArea` mounts `<component :is>` with no props — every editor reads the
// active tab for itself. Taking a `path` prop instead leaves it undefined and
// blanks the pane.
const tabsStore = useTabsStore()
const resourcesStore = useResourcesStore()

const path = computed(() => tabsStore.activeTab?.filePath ?? '')
const session = computed<MetaSession>(() => metaSession(path.value))
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

const durations = computed(() => meta.value.frames.map((frame) => frame.duration))
const frameSize = computed(() => frameDots(session.value))
/** Every frame's art, and what draws it: the tileset (or the atlas) changes under a frame that did not. */
const artKey = computed(() => [
  meta.value.frames,
  meta.value.width,
  meta.value.height,
  meta.value.cell,
  bitmapTiles(session.value),
  session.value.atlas
])

/**
 * One 1:1 image per frame, kept while neither that frame nor what it is drawn
 * from changes: the bar redraws its preview on every frame of playback, and a
 * meta may have 255 frames to thumbnail. A plain Map, not reactive, because
 * `drawFrame` runs inside the bar's effects.
 */
let frameImages = new Map<number, { frame: MetaFrame; source: object; canvas: HTMLCanvasElement }>()
let frameImagesShape = ''

/**
 * A bitmap tileset's frame is drawn from `frameRgba`, the composition the
 * canvas paints, so colour 0 and tile-0 cells stay clear and the bar's
 * background shows through them as the canvas's checkerboard does. An atlas
 * (which the canvas does not draw) keeps its copy out of the picture's sheet.
 */
function frameImage(index: number): HTMLCanvasElement | null {
  const current = meta.value
  const frame = current.frames[index]
  const bitmap = bitmapTiles(session.value)
  const atlas = bitmap ? null : sheet(session.value)
  const source = bitmap ?? atlas
  if (!frame || !source) return null
  const shape = `${current.width}x${current.height}`
  if (frameImagesShape !== shape) {
    frameImages = new Map()
    frameImagesShape = shape
  }
  const cached = frameImages.get(index)
  if (cached && cached.frame === frame && cached.source === source) return cached.canvas
  const canvas = atlas ? metaThumbnail(atlas, current, index) : rgbaCanvas(frameRgba(session.value, index))
  frameImages.set(index, { frame, source, canvas })
  return canvas
}

function rgbaCanvas(rgba: { width: number; height: number; data: Uint8ClampedArray }): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, rgba.width)
  canvas.height = Math.max(1, rgba.height)
  const ctx = canvas.getContext('2d')
  if (!ctx || !rgba.width || !rgba.height) return canvas
  const image = new ImageData(rgba.width, rgba.height)
  image.data.set(rgba.data)
  ctx.putImageData(image, 0, 0)
  return canvas
}

function drawFrame(ctx: CanvasRenderingContext2D, index: number, scale: number): void {
  const image = frameImage(index)
  if (!image) return
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(image, 0, 0, image.width * scale, image.height * scale)
}

/** A meta with no tileset yet has nothing to paint into. */
const paintable = computed(() => Boolean(bitmapTiles(session.value)))

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
          title="Add frames cut from a sheet, their tiles made in this meta's tileset"
          @click="resourcesStore.sheetImport = { destination: 'metab', target: session.path }"
        >
          Import sheet…
        </button>
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
      {{ session.tilesetError ?? 'Pick a tileset in the side panel before drawing.' }}
    </p>

    <!--
      A refusal stops every stroke, so it belongs where the user is looking —
      the canvas — not in the toolbar's ellipsised status span, which is where
      "the tileset is full" went unread while the pencil looked broken.
    -->
    <p
      v-else-if="session.blocked"
      class="banner error"
    >
      {{ session.blocked }}
    </p>

    <div class="body">
      <div class="centre">
        <MetaCanvas :session="session" />
        <AnimationBar
          :playing="session.playing"
          :background="session.background"
          :onion-skin="session.onionSkin"
          :frame-count="meta.frames.length"
          :selected="session.frame"
          :durations="durations"
          loop="loop"
          :frame-size="frameSize"
          :draw-frame="drawFrame"
          :art-key="artKey"
          :max-frames="MAX_FRAMES"
          @update:playing="togglePlaying(session)"
          @update:background="setBackground(session, $event)"
          @update:onion-skin="setOnionSkin(session, $event)"
          @select="setFrame(session, $event)"
          @add="addFrame(session)"
          @duplicate="addFrame(session, $event)"
          @remove="removeFrame(session, $event)"
          @move="(from, to) => reorderFrames(session, from, to)"
          @duration="(index, value) => setDuration(session, index, value)"
        >
          <template #extra>
            <label class="grid-toggle">
              <input
                type="checkbox"
                :checked="session.gridVisible"
                @change="setGridVisible(session, ($event.target as HTMLInputElement).checked)"
              >
              <span>Grid</span>
            </label>
          </template>
        </AnimationBar>
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

.grid-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
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
