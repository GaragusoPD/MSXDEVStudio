<script setup lang="ts">
/**
 * The `*.swsprites.json` editor: a list of characters, each with its own size
 * and its own animation frames, drawn as images.
 *
 * The counterpart to the hardware sprite editor, not a replacement for it —
 * these are blitted into the picture, so they cost CPU and RAM instead of the
 * VDP's 32 slots, and in exchange they have no per-line limit, no plane stack
 * and no fixed size.
 *
 * One file rather than the four the tile editors split into: the panes are
 * small and share a lot of state, and splitting is what happens when that stops
 * being true.
 */
import { computed, onUnmounted, ref, watch, watchEffect } from 'vue'
import Icon from '../../components/Icon.vue'
import { MODES } from '../../../../shared/msx/modes'
import { useTabsStore } from '../../stores/tabsStore'
import { fromHex, grbToRgb, paletteToRgb, rgbToGrb, toHex } from '../../../../shared/msx/palette'
import { defaultExport } from '../../../../shared/msx/resource'
import {
  MAX_SW_FRAMES,
  MAX_SW_SIZE,
  swFramePixels,
  swSizeStep,
  swSpriteDots,
  swSpriteFamily,
  SW_MODES,
  type SwMode
} from '../../../../shared/msx/swsprite'
import type { Point } from '../../../../shared/tile-editor'
import {
  addSprite,
  canRedo,
  canUndo,
  character,
  clearFrame,
  doc,
  dropSprite,
  duplicateFrame,
  framePixels,
  patchExport,
  pickAt,
  pruneSwSpriteSessions,
  redo,
  renameSprite,
  saveSession,
  selectFrame,
  selectSprite,
  setFrames,
  setMode,
  setPaletteEntry,
  setSize,
  setTransparent,
  setupExport,
  strokeEnd,
  strokeMove,
  strokeStart,
  swSpriteSession,
  undo,
  type SwTool
} from './session'

// `EditorArea` mounts the registered component with no props at all, so a tab
// takes its own path off the tabs store, and the session is keyed on it — the
// same way every other resource editor does it.
const tabs = useTabsStore()
const path = computed(() => tabs.activeTab?.filePath ?? '')
const session = computed(() => swSpriteSession(path.value))
const sheet = computed(() => doc(session.value))
const open = computed(() => character(session.value))
const rgb = computed(() => paletteToRgb(sheet.value.palette))
const family = computed(() => swSpriteFamily(sheet.value.mode))
/** SCREEN 3 measures in 4×4 blocks; everything else in dots. */
const dots = computed(() => swSpriteDots(sheet.value.mode))
const unit = computed(() => (dots.value > 1 ? 'blocks' : 'dots'))
const step = computed(() => swSizeStep(sheet.value.mode))

// Sessions outlive tab switches; drop the ones whose tab is gone. Keyed on
// `filePath`, which is what a session is keyed on — `id` is the tab's own
// identity and would prune every live session on the first change.
watch(
  () => tabs.tabs.length,
  () => pruneSwSpriteSessions(new Set(tabs.tabs.map((tab) => tab.filePath ?? ''))),
  { immediate: true }
)

const canvas = ref<HTMLCanvasElement | null>(null)
const newName = ref('')
const widthInput = ref(0)
const heightInput = ref(0)

const TOOLS: { id: SwTool; icon: string; title: string }[] = [
  { id: 'pencil', icon: 'edit', title: 'Pencil' },
  { id: 'line', icon: 'timeline', title: 'Line' },
  { id: 'rect', icon: 'crop_square', title: 'Rectangle' },
  { id: 'fill', icon: 'format_color_fill', title: 'Fill' },
  { id: 'pick', icon: 'colorize', title: 'Pick the colour under the cursor' }
]

/** Screen dots per document unit, times zoom — so a SCREEN 3 sprite shows at its real proportions. */
const scale = computed(() => session.value.zoom)

function pointAt(event: PointerEvent): Point {
  const rect = (event.currentTarget as HTMLCanvasElement).getBoundingClientRect()
  const w = open.value?.width ?? 1
  const h = open.value?.height ?? 1
  const x = Math.floor(((event.clientX - rect.left) / rect.width) * w)
  const y = Math.floor(((event.clientY - rect.top) / rect.height) * h)
  return { x: Math.min(w - 1, Math.max(0, x)), y: Math.min(h - 1, Math.max(0, y)) }
}

let drawing = false

function onDown(event: PointerEvent): void {
  const point = pointAt(event)
  ;(event.currentTarget as HTMLCanvasElement).setPointerCapture(event.pointerId)
  if (session.value.tool === 'pick') {
    pickAt(session.value, point)
    return
  }
  drawing = true
  strokeStart(session.value, point)
}

function onMove(event: PointerEvent): void {
  if (!drawing) return
  strokeMove(session.value, pointAt(event))
}

function onUp(): void {
  if (!drawing) return
  drawing = false
  strokeEnd(session.value)
}

// ── the animation preview ───────────────────────────────────────────────────

const playFrame = ref(0)
let timer: ReturnType<typeof setInterval> | null = null

function stop(): void {
  if (timer !== null) clearInterval(timer)
  timer = null
}

watch(
  [() => session.value.playing, () => session.value.fps, () => open.value?.frames],
  () => {
    stop()
    if (!session.value.playing) return
    timer = setInterval(() => {
      playFrame.value = open.value?.frames ? (playFrame.value + 1) % open.value.frames : 0
    }, Math.max(1, Math.round(1000 / session.value.fps)))
  },
  { immediate: true }
)

onUnmounted(stop)

/** Paints one frame's indices into a canvas, transparent left as a hole. */
function paint(element: HTMLCanvasElement | null, pixels: Uint8Array, width: number, height: number): void {
  if (!element || !width || !height) return
  element.width = width
  element.height = height
  const context = element.getContext('2d')
  if (!context) return
  const image = new ImageData(width, height)
  const palette = rgb.value
  for (let i = 0; i < pixels.length; i++) {
    const index = pixels[i]
    const color = palette[index] ?? { r: 255, g: 0, b: 255 }
    image.data[i * 4] = color.r
    image.data[i * 4 + 1] = color.g
    image.data[i * 4 + 2] = color.b
    image.data[i * 4 + 3] = index === sheet.value.transparent ? 0 : 255
  }
  context.putImageData(image, 0, 0)
}

watchEffect(() => {
  const current = open.value
  if (!current) return
  paint(canvas.value, framePixels(session.value), current.width, current.height)
})

/** The filmstrip and the player both need a thumbnail per frame. */
const thumbs = ref<HTMLCanvasElement[]>([])
watchEffect(() => {
  const current = open.value
  if (!current) return
  // Touch the document so a stroke repaints the strip too.
  void sheet.value
  thumbs.value.forEach((element, index) => {
    paint(element, swFramePixels(sheet.value, session.value.sprite, index), current.width, current.height)
  })
})

const player = ref<HTMLCanvasElement | null>(null)
watchEffect(() => {
  const current = open.value
  if (!current) return
  void sheet.value
  paint(player.value, swFramePixels(sheet.value, session.value.sprite, playFrame.value), current.width, current.height)
})

watchEffect(() => {
  widthInput.value = open.value?.width ?? 0
  heightInput.value = open.value?.height ?? 0
})

function applySize(): void {
  setSize(session.value, widthInput.value, heightInput.value)
}

function addNew(): void {
  const name = newName.value.trim()
  if (!name) return
  addSprite(session.value, name)
  newName.value = ''
}

const familyNote = computed(() => {
  if (family.value === 'sc3') {
    return 'SCREEN 3: frames are blitted out of ROM into the shadow buffer a screen resource flushes. Widths are even because two blocks share a VRAM byte.'
  }
  if (family.value === 'bitmap') {
    return 'Bitmap mode: every frame goes into one strip, uploaded to off-screen VRAM once — each draw is then a single VDP blit with the transparent colour skipped.'
  }
  return 'Pattern mode: there are no pixels to blit, so a frame becomes whole 8×8 cells written into a reserved range of the pattern table. Sizes are multiples of 8, and two colours per row is the hardware rule.'
})
</script>

<template>
  <div
    v-if="session.error"
    class="error"
  >
    {{ session.error }}
  </div>
  <div
    v-else-if="session.loading"
    class="hint"
  >
    Loading…
  </div>
  <div
    v-else
    class="editor"
  >
    <div class="bar">
      <button
        :disabled="!canUndo(session.history)"
        title="Undo"
        @click="undo(session)"
      >
        <Icon name="undo" />
      </button>
      <button
        :disabled="!canRedo(session.history)"
        title="Redo"
        @click="redo(session)"
      >
        <Icon name="redo" />
      </button>
      <span class="sep" />
      <button
        v-for="tool in TOOLS"
        :key="tool.id"
        type="button"
        :class="{ active: session.tool === tool.id }"
        :title="tool.title"
        @click="session.tool = tool.id"
      >
        <Icon :name="(tool.icon as never)" />
      </button>
      <label class="inline">
        <input
          v-model="session.filled"
          type="checkbox"
        >
        <span>Filled</span>
      </label>
      <span class="sep" />
      <label class="inline">
        <span>Zoom</span>
        <input
          v-model.number="session.zoom"
          type="range"
          min="2"
          max="24"
        >
      </label>
      <label class="inline">
        <input
          v-model="session.grid"
          type="checkbox"
        >
        <span>Grid</span>
      </label>
      <span class="spacer" />
      <button
        :disabled="!session.dirty"
        title="Save"
        @click="saveSession(session)"
      >
        <Icon name="save" />
      </button>
    </div>

    <div class="panes">
      <aside class="list">
        <h3>Sprites</h3>
        <ul>
          <li
            v-for="(entry, index) in sheet.sprites"
            :key="index"
            :class="{ active: session.sprite === index }"
            @click="selectSprite(session, index)"
          >
            <input
              class="name"
              spellcheck="false"
              :value="entry.name"
              @change="renameSprite(session, index, ($event.target as HTMLInputElement).value)"
            >
            <span class="dim">{{ entry.width }}×{{ entry.height }} · {{ entry.frames }}f</span>
            <button
              :disabled="sheet.sprites.length < 2"
              title="Remove"
              @click.stop="dropSprite(session, index)"
            >
              <Icon
                name="delete"
                :size="14"
              />
            </button>
          </li>
        </ul>
        <form
          class="add"
          @submit.prevent="addNew"
        >
          <input
            v-model="newName"
            placeholder="new sprite"
            spellcheck="false"
          >
          <button
            type="submit"
            :disabled="!newName.trim()"
          >
            Add
          </button>
        </form>
      </aside>

      <section class="stage">
        <div class="scroller">
          <canvas
            v-if="open"
            ref="canvas"
            class="paper"
            :class="{ grid: session.grid && scale >= 6 }"
            :style="{
              width: `${open.width * scale}px`,
              height: `${open.height * scale}px`,
              backgroundSize: `${scale}px ${scale}px`
            }"
            @pointerdown="onDown"
            @pointermove="onMove"
            @pointerup="onUp"
            @pointercancel="onUp"
          />
        </div>

        <div
          v-if="open"
          class="film"
        >
          <button
            v-for="index in open.frames"
            :key="index"
            class="thumb"
            :class="{ active: session.frame === index - 1 }"
            :title="`Frame ${index}`"
            @click="selectFrame(session, index - 1)"
          >
            <canvas
              :ref="(el) => { if (el) thumbs[index - 1] = el as HTMLCanvasElement }"
              :style="{ width: `${open.width * 3}px`, height: `${open.height * 3}px` }"
            />
          </button>
          <button
            title="Copy this frame to a new one"
            @click="duplicateFrame(session)"
          >
            <Icon name="add" />
          </button>
        </div>
      </section>

      <aside class="side">
        <section>
          <h3>Mode</h3>
          <select
            :value="sheet.mode"
            @change="setMode(session, ($event.target as HTMLSelectElement).value as SwMode)"
          >
            <option
              v-for="id in SW_MODES"
              :key="id"
              :value="id"
            >
              {{ MODES[id].label }}
            </option>
          </select>
          <p class="hint">
            {{ familyNote }}
          </p>
        </section>

        <section>
          <h3>Palette</h3>
          <div class="swatches">
            <button
              v-for="(color, index) in rgb"
              :key="index"
              class="swatch"
              :class="{ on: session.color === index, clear: index === sheet.transparent }"
              :style="{ background: toHex(color) }"
              :title="index === sheet.transparent ? `${index} — transparent` : String(index)"
              @click="session.color = index"
            >
              <span>{{ index }}</span>
            </button>
          </div>
          <label class="field">
            <span>Transparent</span>
            <select
              :value="String(sheet.transparent)"
              @change="setTransparent(session, Number(($event.target as HTMLSelectElement).value))"
            >
              <option
                v-for="index in 16"
                :key="index - 1"
                :value="String(index - 1)"
              >
                {{ index - 1 }}
              </option>
            </select>
          </label>
          <label
            v-if="sheet.palette"
            class="field"
          >
            <span>Entry {{ session.color }}</span>
            <input
              type="color"
              :value="toHex(grbToRgb(sheet.palette[session.color] ?? 0))"
              @input="setPaletteEntry(session, session.color, rgbToGrb(fromHex(($event.target as HTMLInputElement).value)))"
            >
          </label>
        </section>

        <section v-if="open">
          <h3>Size and frames</h3>
          <p class="hint">
            {{ open.width }}×{{ open.height }} {{ unit }}<template v-if="dots > 1">
              ({{ open.width * dots }}×{{ open.height * dots }} dots)</template>. Multiples of
            {{ step.x }}×{{ step.y }} — the blitter cannot see inside one. Resizing crops.
          </p>
          <div class="field">
            <input
              v-model.number="widthInput"
              type="number"
              min="1"
              :max="MAX_SW_SIZE"
            >
            <span>×</span>
            <input
              v-model.number="heightInput"
              type="number"
              min="1"
              :max="MAX_SW_SIZE"
            >
            <button @click="applySize">
              Apply
            </button>
          </div>
          <label class="field">
            <span>Frames</span>
            <input
              type="number"
              min="1"
              :max="MAX_SW_FRAMES"
              :value="open.frames"
              @change="setFrames(session, Number(($event.target as HTMLInputElement).value))"
            >
          </label>
          <button
            class="wide"
            @click="clearFrame(session)"
          >
            Clear this frame
          </button>
        </section>

        <section v-if="open && open.frames > 1">
          <h3>Animation</h3>
          <div class="player">
            <canvas
              ref="player"
              :style="{ width: `${open.width * 4}px`, height: `${open.height * 4}px` }"
            />
            <div class="controls">
              <button @click="session.playing = !session.playing">
                {{ session.playing ? '❙❙' : '▶' }}
              </button>
              <label>
                <input
                  v-model.number="session.fps"
                  type="range"
                  min="1"
                  max="30"
                >
                <span>{{ session.fps }} fps</span>
              </label>
            </div>
          </div>
        </section>

        <section>
          <h3>Export</h3>
          <button
            v-if="!sheet.export"
            class="wide"
            @click="setupExport(session)"
          >
            Export to {{ defaultExport(session.path).out }}
          </button>
          <template v-else>
            <label class="field">
              <span>Name</span>
              <input
                spellcheck="false"
                :value="sheet.export.name"
                @change="patchExport(session, { name: ($event.target as HTMLInputElement).value })"
              >
            </label>
            <label class="field">
              <span>Output</span>
              <input
                spellcheck="false"
                :value="sheet.export.out"
                @change="patchExport(session, { out: ($event.target as HTMLInputElement).value })"
              >
            </label>
            <label class="inline">
              <input
                type="checkbox"
                :checked="sheet.export.helpers === true"
                @change="patchExport(session, { helpers: ($event.target as HTMLInputElement).checked })"
              >
              <span>Export ready-made C</span>
            </label>
          </template>
        </section>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.bar {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.3rem 0.5rem;
  border-bottom: 1px solid var(--color-border);
  flex-wrap: wrap;
}

.bar .sep {
  width: 1px;
  height: 1.2rem;
  background: var(--color-border);
  margin: 0 0.2rem;
}

.bar .spacer {
  flex: 1;
}

.bar button.active {
  outline: 1px solid var(--color-accent, #58a6ff);
}

.inline {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.8rem;
}

.inline input[type='range'] {
  width: 5rem;
}

.panes {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 1px;
  background: var(--color-border);
}

.list,
.side {
  width: 15rem;
  flex-shrink: 0;
  overflow-y: auto;
  padding: 0.5rem;
  background: var(--color-bg-editor);
}

.stage {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-editor);
}

.scroller {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}

.paper {
  image-rendering: pixelated;
  flex-shrink: 0;
  background:
    repeating-conic-gradient(#3a3a3a 0% 25%, #2c2c2c 0% 50%) 0 0 / 16px 16px;
  border: 1px solid var(--color-border);
  cursor: crosshair;
}

.paper.grid {
  background-image:
    linear-gradient(to right, rgba(255, 255, 255, 0.14) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(255, 255, 255, 0.14) 1px, transparent 1px),
    repeating-conic-gradient(#3a3a3a 0% 25%, #2c2c2c 0% 50%);
}

.film {
  display: flex;
  align-items: flex-end;
  gap: 0.4rem;
  padding: 0.4rem;
  border-top: 1px solid var(--color-border);
  overflow-x: auto;
}

.thumb {
  padding: 2px;
  line-height: 0;
}

.thumb.active {
  outline: 2px solid var(--color-accent, #58a6ff);
}

.thumb canvas,
.player canvas {
  image-rendering: pixelated;
  background: repeating-conic-gradient(#3a3a3a 0% 25%, #2c2c2c 0% 50%) 0 0 / 8px 8px;
}

.list ul {
  list-style: none;
  margin: 0;
  padding: 0;
}

.list li {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.2rem;
  cursor: pointer;
}

.list li.active {
  outline: 1px solid var(--color-accent, #58a6ff);
}

.list .name {
  flex: 1;
  min-width: 0;
}

.dim {
  opacity: 0.65;
  font-size: 0.75rem;
  white-space: nowrap;
}

.add {
  display: flex;
  gap: 0.3rem;
  margin-top: 0.5rem;
}

.add input {
  flex: 1;
  min-width: 0;
}

.swatches {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 2px;
}

.swatch {
  aspect-ratio: 1;
  border: 1px solid var(--color-border);
  font-size: 0.6rem;
  padding: 0;
}

.swatch.on {
  outline: 2px solid var(--color-accent, #58a6ff);
}

.swatch.clear {
  border-style: dashed;
}

.field {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin: 0.35rem 0;
}

.field > span:first-child {
  flex: 0 0 5.5rem;
  font-size: 0.8rem;
}

.field input,
.field select {
  flex: 1;
  min-width: 0;
}

.wide {
  width: 100%;
  margin-top: 0.4rem;
}

.player {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.player .controls {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.75rem;
}

.hint {
  font-size: 0.75rem;
  opacity: 0.8;
  margin: 0.3rem 0;
}

.error {
  padding: 1rem;
  color: var(--color-error, #f66);
}
</style>
