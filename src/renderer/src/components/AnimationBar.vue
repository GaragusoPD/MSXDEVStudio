<script setup lang="ts">
/**
 * The bottom animation bar every frame-animated editor shares (sprites, pattern
 * meta-tiles and animated tiles, bitmap meta-tiles): a live preview against a
 * checkered or solid background, a filmstrip of thumbnails with each frame's
 * index and how many VBlanks it is held, and the frame list controls.
 *
 * It knows nothing about sprites, poses or tiles. The editor hands it a way to
 * draw frame *i* and an `artKey` that changes whenever the art does, and maps
 * its events onto its own undoable session calls — so every edit made here is
 * one step in that editor's history, and every rule (how long a frame may be
 * held, what "move" does to the selection) stays where it is tested.
 *
 * Playing animates the preview only: the editing canvas stays on the selected
 * frame. The clock is `shared/animation-playback.ts`, the same stepping the
 * generated `_Animate()` does, so the preview plays at the game's speed.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch, watchEffect } from 'vue'
import {
  fitScale,
  parseDuration,
  previewFrame,
  startTick,
  type AnimationBackground,
  type PlaybackLoop
} from '../../../shared/animation-playback'
import Icon from './Icon.vue'

const props = withDefaults(
  defineProps<{
    frameCount: number
    selected: number
    /** VBlanks each frame is held, one per frame. */
    durations: readonly number[]
    loop?: PlaybackLoop
    /** One frame's size in dots. */
    frameSize: { width: number; height: number }
    /**
     * Draws frame `index` from (0, 0) at `scale` canvas pixels a dot — which is
     * fractional, and below 1 for a frame bigger than its box — leaving empty
     * dots transparent so the background shows. The canvas arrives cleared,
     * sized to the frame, with smoothing off; whatever state it sets is undone.
     */
    drawFrame: (ctx: CanvasRenderingContext2D, index: number, scale: number) => void
    /** Anything that changes whenever the art does; a change redraws the thumbnails and the preview. */
    artKey: unknown
    /** Add and Clone are refused at this many frames; no limit when not given. */
    maxFrames?: number
  }>(),
  { loop: 'loop', maxFrames: Number.POSITIVE_INFINITY }
)

const emit = defineEmits<{
  select: [index: number]
  /** A blank frame at the end. */
  add: []
  /** A copy of frame `index`, right after it. */
  duplicate: [index: number]
  remove: [index: number]
  move: [from: number, to: number]
  /** Already whole VBlanks within 1..255, and different from what the frame holds. */
  duration: [index: number, value: number]
}>()

const playing = defineModel<boolean>('playing', { required: true })
const onionSkin = defineModel<boolean>('onionSkin', { required: true })
const background = defineModel<AnimationBackground>('background', { required: true })

/**
 * Fixed boxes, in CSS pixels. The preview keeps today's 64-pixel height and may
 * widen for a strip; a square frame fills 64×64 exactly as it always did.
 */
const PREVIEW_BOX = { width: 128, height: 64 }
const THUMB_BOX = { width: 64, height: 32 }

/** A canvas sized to the frame's own aspect at `scale` — never 0 wide, which a canvas cannot be. */
function fitted(box: { width: number; height: number }): { scale: number; width: number; height: number } {
  const scale = Math.max(0, fitScale(props.frameSize, box))
  return {
    scale,
    width: Math.max(1, Math.round(props.frameSize.width * scale)),
    height: Math.max(1, Math.round(props.frameSize.height * scale))
  }
}
const preview = computed(() => fitted(PREVIEW_BOX))
const thumb = computed(() => fitted(THUMB_BOX))

const frames = computed(() => Array.from({ length: Math.max(0, props.frameCount) }, (_, i) => i))
const atMax = computed(() => props.frameCount >= props.maxFrames)
const clampIndex = (index: number): number => Math.min(Math.max(index, 0), Math.max(0, props.frameCount - 1))

// ── drawing ─────────────────────────────────────────────────────────────────

const previewCanvas = ref<HTMLCanvasElement>()
const thumbRefs = ref<(HTMLCanvasElement | null)[]>([])

function paint(canvas: HTMLCanvasElement | null | undefined, index: number, scale: number): void {
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  if (scale <= 0 || index < 0 || index >= props.frameCount) return
  ctx.save()
  ctx.imageSmoothingEnabled = false
  props.drawFrame(ctx, index, scale)
  ctx.restore()
}

// ── playback ────────────────────────────────────────────────────────────────

const previewIndex = ref(0)
const displayIndex = computed(() => clampIndex(playing.value ? previewIndex.value : props.selected))

let raf = 0
/** The tick Play began at, and when (rAF time); null until the first frame after it. */
let startAt = 0
let startTime: number | null = null

function step(time: number): void {
  if (startTime === null) startTime = time
  // Durations and frame count are read live: an edit while playing takes
  // effect on the next frame, and `previewFrame` never points past the last.
  previewIndex.value = previewFrame(props.durations, props.loop, startAt, time - startTime)
  if (playing.value) raf = requestAnimationFrame(step)
}

function restart(): void {
  cancelAnimationFrame(raf)
  if (!playing.value) return
  startAt = startTick(props.durations, props.loop, props.selected)
  startTime = null
  previewIndex.value = previewFrame(props.durations, props.loop, startAt, 0)
  raf = requestAnimationFrame(step)
}

// immediate: true matters here — switching away to another tab and back
// remounts this component with `playing` already true (it lives on the
// session), which needs to (re)start the loop rather than wait for a
// false→true transition that will never come. A new loop mode restarts too,
// because where Play starts depends on it.
watch([playing, () => props.loop], restart, { immediate: true })
onBeforeUnmount(() => cancelAnimationFrame(raf))

// `drawFrame` reads the editor's state where this component cannot see it, so
// what should redraw is read here explicitly. flush: 'post' so the canvases
// exist, and have their new size, by the time each effect runs.
watchEffect(
  () => {
    void props.artKey
    paint(previewCanvas.value, displayIndex.value, preview.value.scale)
  },
  { flush: 'post' }
)
watchEffect(
  () => {
    void props.artKey
    const { scale } = thumb.value
    for (const index of frames.value) paint(thumbRefs.value[index], index, scale)
  },
  { flush: 'post' }
)

// ── durations ───────────────────────────────────────────────────────────────

/**
 * One undo step per edit, on change rather than per keystroke. An emptied field
 * is NaN here (`valueAsNumber`) and emits nothing; either way the field then
 * shows what the editor holds — once it has had the chance to store the value —
 * so a refused or clamped value snaps back even when the stored one didn't move.
 */
async function onDuration(index: number, event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const value = parseDuration(input.valueAsNumber)
  if (value !== null && value !== props.durations[index]) emit('duration', index, value)
  await nextTick()
  input.value = String(props.durations[index] ?? '')
}

// ── drag to reorder ─────────────────────────────────────────────────────────

/** The frame being dragged, or null when the drag is not one of ours (a file, text). */
let dragFrom: number | null = null
const dropTarget = ref<number | null>(null)

/** No `setData`: a text payload would let a frame dropped on a text field type its index into it. */
function onDragStart(index: number, event: DragEvent): void {
  dragFrom = index
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onDragOver(index: number, event: DragEvent): void {
  if (dragFrom === null) return
  event.preventDefault()
  dropTarget.value = index === dragFrom ? null : index
}

function onDrop(index: number): void {
  if (dragFrom !== null && dragFrom !== index) emit('move', dragFrom, index)
  endDrag()
}

function endDrag(): void {
  dragFrom = null
  dropTarget.value = null
}
</script>

<template>
  <div class="anim-bar">
    <div class="preview">
      <canvas
        ref="previewCanvas"
        :class="background"
        :width="preview.width"
        :height="preview.height"
      />
    </div>

    <div class="filmstrip">
      <div
        v-for="index in frames"
        :key="index"
        class="frame"
        :class="{ active: index === selected, drop: index === dropTarget }"
        @click="emit('select', index)"
        @dragover="onDragOver(index, $event)"
        @drop.prevent="onDrop(index)"
      >
        <canvas
          :ref="(el) => (thumbRefs[index] = el as HTMLCanvasElement | null)"
          :class="background"
          :width="thumb.width"
          :height="thumb.height"
          draggable="true"
          title="Drag to reorder"
          @dragstart="onDragStart(index, $event)"
          @dragend="endDrag"
        />
        <span>{{ index }}</span>
        <input
          class="duration"
          type="number"
          min="1"
          max="255"
          :value="durations[index]"
          title="VBlanks this frame is held — 50 a second on a European MSX, 60 on a Japanese one"
          @click.stop
          @change="onDuration(index, $event)"
        >
      </div>
    </div>

    <div class="controls">
      <button
        type="button"
        :title="atMax ? `At most ${maxFrames} frames` : 'Add blank frame'"
        :disabled="atMax"
        @click="emit('add')"
      >
        + Frame
      </button>
      <button
        type="button"
        :title="atMax ? `At most ${maxFrames} frames` : 'Clone this frame'"
        :disabled="atMax"
        @click="emit('duplicate', selected)"
      >
        Clone
      </button>
      <button
        type="button"
        title="Delete this frame"
        :disabled="frameCount <= 1"
        @click="emit('remove', selected)"
      >
        Delete
      </button>
      <button
        type="button"
        title="Move earlier"
        :disabled="selected <= 0"
        @click="emit('move', selected, selected - 1)"
      >
        <Icon name="arrow_back" />
      </button>
      <button
        type="button"
        title="Move later"
        :disabled="selected >= frameCount - 1"
        @click="emit('move', selected, selected + 1)"
      >
        <Icon name="arrow_forward" />
      </button>

      <span class="sep" />

      <!-- Stays enabled while playing, so a delete down to one frame can still be paused. -->
      <button
        type="button"
        :class="{ active: playing }"
        :title="playing ? 'Pause' : 'Play the animation'"
        :disabled="!playing && frameCount < 2"
        @click="playing = !playing"
      >
        <Icon :name="playing ? 'pause' : 'play_arrow'" />
      </button>
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

      <template v-if="$slots.extra">
        <span class="sep" />
        <slot name="extra" />
      </template>
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
  min-width: 64px;
  height: 64px;
}

canvas {
  image-rendering: pixelated;
}

.checkered {
  background-color: var(--color-bg-tab-inactive);
  background-image:
    linear-gradient(45deg, rgba(128, 128, 128, 0.25) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(128, 128, 128, 0.25) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(128, 128, 128, 0.25) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(128, 128, 128, 0.25) 75%);
  background-size: 12px 12px;
  background-position: 0 0, 0 6px, 6px -6px, -6px 0;
}

.solid {
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

.frame.drop {
  border-style: dashed;
  border-color: var(--color-accent);
}

.frame canvas {
  border: 1px solid var(--color-border);
  cursor: grab;
}

.frame canvas.checkered {
  background-size: 8px 8px;
  background-position: 0 0, 0 4px, 4px -4px, -4px 0;
}

.frame span {
  font-size: 9px;
  color: var(--color-text-muted);
}

.frame .duration {
  width: 38px;
  padding: 1px 2px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-tab-inactive);
  color: var(--color-text);
  font-size: 10px;
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

/* An editor's own controls in the `extra` slot look like the bar's. */
:slotted(button) {
  padding: 3px 8px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-hover);
  font-size: 11px;
}

:slotted(button:disabled) {
  opacity: 0.4;
  cursor: default;
}

:slotted(label) {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  color: var(--color-text-muted);
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

.inline select {
  padding: 2px 4px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-tab-inactive);
  color: var(--color-text);
  font-size: 11px;
}
</style>
