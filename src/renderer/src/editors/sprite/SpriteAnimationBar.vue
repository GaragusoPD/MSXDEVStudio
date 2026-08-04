<script setup lang="ts">
/**
 * Bottom bar: the active sprite's frames as a filmstrip (add/clone/reorder),
 * and playback of the whole animation at a configurable fps against a
 * checkered or solid background — independent of which frame is selected
 * for editing.
 */
import { computed, onBeforeUnmount, ref, watch, watchEffect } from 'vue'
import { paletteToRgb } from '../../../../shared/msx/palette'
import { compositeFrame, type SpritesDoc } from '../../../../shared/msx/sprite'
import { addFrame, cloneFrame, removeFrame, reorderFrame, tickPlayback, type SpriteTarget } from '../../../../shared/sprite-editor'
import { drawIndices } from './draw'
import Icon from '../../components/Icon.vue'

const props = defineProps<{ doc: SpritesDoc; target: SpriteTarget }>()
const emit = defineEmits<{ selectFrame: [index: number]; mutate: [doc: SpritesDoc] }>()

const fps = defineModel<number>('fps', { required: true })
const playing = defineModel<boolean>('playing', { required: true })
const background = defineModel<'checkered' | 'solid'>('background', { required: true })
const onionSkin = defineModel<boolean>('onionSkin', { required: true })

const THUMB = 40
const thumbRefs = ref<(HTMLCanvasElement | null)[]>([])
const previewCanvas = ref<HTMLCanvasElement>()

const sprite = computed(() => props.doc.sprites[props.target.sprite])
const frames = computed(() => sprite.value?.frames ?? [])
const cols = computed(() => sprite.value?.cols ?? 1)
const rows = computed(() => sprite.value?.rows ?? 1)
/** Longest side of the character in dots — what both the preview and the thumbnails scale against. */
const span = computed(() => Math.max(cols.value, rows.value) * props.doc.size)

const previewIndex = ref(0)
const displayIndex = computed(() => (playing.value ? previewIndex.value : props.target.frame))

let raf = 0
let lastTime = 0
let elapsedMs = 0

function step(time: number): void {
  if (!lastTime) lastTime = time
  const delta = time - lastTime
  lastTime = time
  const state = tickPlayback({ frameIndex: previewIndex.value, elapsedMs }, delta, fps.value, frames.value.length)
  previewIndex.value = state.frameIndex
  elapsedMs = state.elapsedMs
  if (playing.value) raf = requestAnimationFrame(step)
}

// immediate: true matters here — switching away to a non-sprite tab and back remounts this
// component with `playing` already true (from the session), which needs to (re)start the loop
// rather than wait for a false→true transition that will never come.
watch(
  playing,
  (isPlaying) => {
    cancelAnimationFrame(raf)
    if (!isPlaying) return
    lastTime = 0
    elapsedMs = 0
    previewIndex.value = props.target.frame
    raf = requestAnimationFrame(step)
  },
  { immediate: true }
)
onBeforeUnmount(() => cancelAnimationFrame(raf))

function drawPreview(): void {
  const canvas = previewCanvas.value
  const ctx = canvas?.getContext('2d')
  const frame = frames.value[displayIndex.value]
  if (!canvas || !ctx || !frame) return
  const size = props.doc.size
  const scale = canvas.width / span.value
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  const indices = compositeFrame(frame.layers, props.doc.mode, size, cols.value, rows.value)
  drawIndices(ctx, indices, cols.value * size, scale, paletteToRgb(props.doc.palette))
}
// flush: 'post' so both effects' canvas refs exist on the very first run.
watchEffect(drawPreview, { flush: 'post' })

function redrawThumbs(): void {
  const rgb = paletteToRgb(props.doc.palette)
  frames.value.forEach((frame, i) => {
    const canvas = thumbRefs.value[i]
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    ctx.clearRect(0, 0, THUMB, THUMB)
    const size = props.doc.size
    const indices = compositeFrame(frame.layers, props.doc.mode, size, cols.value, rows.value)
    drawIndices(ctx, indices, cols.value * size, THUMB / span.value, rgb)
  })
}
watchEffect(redrawThumbs, { flush: 'post' })
</script>

<template>
  <div class="anim-bar">
    <div
      class="preview"
      :class="background"
    >
      <canvas
        ref="previewCanvas"
        :width="span * 6"
        :height="span * 6"
      />
    </div>

    <div class="filmstrip">
      <div
        v-for="(f, index) in frames"
        :key="index"
        class="frame"
        :class="{ active: index === target.frame }"
        @click="emit('selectFrame', index)"
      >
        <canvas
          :ref="(el) => (thumbRefs[index] = el as HTMLCanvasElement)"
          :width="THUMB"
          :height="THUMB"
        />
        <span>{{ index }}</span>
      </div>
    </div>

    <div class="controls">
      <button
        type="button"
        title="Add blank frame"
        @click="emit('mutate', addFrame(doc, target.sprite))"
      >
        + Frame
      </button>
      <button
        type="button"
        title="Clone this frame"
        @click="emit('mutate', cloneFrame(doc, target.sprite, target.frame))"
      >
        Clone
      </button>
      <button
        type="button"
        title="Delete this frame"
        :disabled="frames.length <= 1"
        @click="emit('mutate', removeFrame(doc, target.sprite, target.frame))"
      >
        Delete
      </button>
      <button
        type="button"
        title="Move earlier"
        :disabled="target.frame === 0"
        @click="emit('mutate', reorderFrame(doc, target.sprite, target.frame, target.frame - 1))"
      >
        ↑
      </button>
      <button
        type="button"
        title="Move later"
        :disabled="target.frame >= frames.length - 1"
        @click="emit('mutate', reorderFrame(doc, target.sprite, target.frame, target.frame + 1))"
      >
        ↓
      </button>

      <span class="sep" />

      <button
        type="button"
        :class="{ active: playing }"
        @click="playing = !playing"
      >
        <Icon :name="playing ? 'pause' : 'play_arrow'" />
      </button>
      <label class="inline">
        <span>fps</span>
        <input
          v-model.number="fps"
          type="number"
          min="1"
          max="60"
        >
      </label>
      <label class="inline">
        <input
          v-model="onionSkin"
          type="checkbox"
        >
        <span>Onion skin</span>
      </label>
      <label class="inline">
        <span>Background</span>
        <select v-model="background">
          <option value="checkered">
            Checkered
          </option>
          <option value="solid">
            Solid
          </option>
        </select>
      </label>
    </div>
  </div>
</template>

<style scoped>
.anim-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-top: 1px solid var(--color-border);
  flex-wrap: wrap;
}

.preview {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
}

.preview canvas {
  image-rendering: pixelated;
  max-width: 100%;
  max-height: 100%;
}

.preview.checkered {
  background-color: var(--color-bg-tab-inactive);
  background-image:
    linear-gradient(45deg, rgba(128, 128, 128, 0.25) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(128, 128, 128, 0.25) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(128, 128, 128, 0.25) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(128, 128, 128, 0.25) 75%);
  background-size: 12px 12px;
  background-position: 0 0, 0 6px, 6px -6px, -6px 0;
}

.preview.solid {
  background: #000000;
}

.filmstrip {
  display: flex;
  gap: 4px;
  overflow-x: auto;
  flex: 1;
  min-width: 80px;
}

.frame {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border: 1px solid transparent;
  border-radius: 3px;
  cursor: pointer;
  flex-shrink: 0;
}

.frame:hover {
  background: var(--color-bg-hover);
}

.frame.active {
  border-color: var(--color-accent);
  background: var(--color-bg-active-item);
}

.frame canvas {
  image-rendering: pixelated;
  width: 28px;
  height: 28px;
  background-color: var(--color-bg-tab-inactive);
  border: 1px solid var(--color-border);
}

.frame span {
  font-size: 9px;
  color: var(--color-text-muted);
}

.controls {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}

.controls button {
  padding: 3px 8px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-hover);
  font-size: 11px;
}

.controls button.active {
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: #ffffff;
}

.controls button:disabled {
  opacity: 0.4;
  cursor: default;
}

.sep {
  width: 1px;
  align-self: stretch;
  background: var(--color-border);
}

.inline {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  color: var(--color-text-muted);
}

.inline input[type='number'] {
  width: 42px;
  padding: 2px 4px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-tab-inactive);
  color: var(--color-text);
  font-size: 11px;
}

.inline select {
  padding: 2px 4px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-tab-inactive);
  color: var(--color-text);
  font-size: 11px;
}
</style>
