<script setup lang="ts">
/**
 * Plays a block as an animation.
 *
 * A block is a named group of tiles, and this codebase already treats a 1×N one
 * as a sequence of poses — `agent-guide.ts` documents exactly that idiom, and it
 * is what the exported `_BASE`/`_W` defines give a game. What a grid of frames
 * cannot show is whether the walk cycle *reads*, so this cycles them.
 *
 * Deliberately not a timeline: the game owns timing, and every animation table
 * the exporter emits is "base plus count". The rate here is a preview control,
 * not something the document stores.
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import { paletteToRgb } from '../../../../shared/msx/palette'
import { tileImage, type BitmapTilesDoc } from '../../../../shared/msx/bitmap-tile'
import { SC3_BLOCK_DOTS } from '../../../../shared/msx/modes'
import type { TileBlock } from '../../../../shared/msx/tile'

const props = defineProps<{ tileset: BitmapTilesDoc; block: TileBlock }>()

const canvas = ref<HTMLCanvasElement | null>(null)
const playing = ref(false)
const fps = ref(8)
const frame = ref(0)
let timer: ReturnType<typeof setInterval> | null = null

/** A block is laid out row-major, so its frames are its tiles in order. */
const frames = computed(() => props.block.tiles)
/** SCREEN 3 pixels are 4×4 blocks; everything else draws a dot per pixel. */
const dots = computed(() => (props.tileset.mode === 'sc3' ? SC3_BLOCK_DOTS : 1))
const zoom = computed(() => Math.max(1, Math.floor(64 / Math.max(1, props.tileset.width * dots.value))) * dots.value)

function stop(): void {
  if (timer !== null) clearInterval(timer)
  timer = null
}

function toggle(): void {
  playing.value = !playing.value
}

watch([playing, fps], () => {
  stop()
  if (!playing.value) return
  timer = setInterval(() => {
    frame.value = frames.value.length ? (frame.value + 1) % frames.value.length : 0
  }, Math.max(1, Math.round(1000 / fps.value)))
})

// A block can be renamed, resized or swapped under us; a frame index past its
// end would draw tile `undefined`.
watch(frames, () => {
  if (frame.value >= frames.value.length) frame.value = 0
})

watch(
  [frame, () => props.tileset, () => props.block],
  () => {
    const element = canvas.value
    if (!element) return
    const { width, height } = props.tileset
    element.width = width
    element.height = height
    const context = element.getContext('2d')
    if (!context) return
    const pixels = tileImage(props.tileset, frames.value[frame.value] ?? 0)
    const rgb = paletteToRgb(props.tileset.palette)
    const image = new ImageData(width, height)
    for (let i = 0; i < pixels.length; i++) {
      const index = pixels[i]
      const color = rgb[index] ?? { r: 255, g: 0, b: 255 }
      image.data[i * 4] = color.r
      image.data[i * 4 + 1] = color.g
      image.data[i * 4 + 2] = color.b
      // The transparent index is drawn as a hole rather than as its colour, so
      // the preview shows what a masked blit will actually put on screen.
      image.data[i * 4 + 3] = index === props.tileset.transparent ? 0 : 255
    }
    context.putImageData(image, 0, 0)
  },
  { immediate: true, deep: true }
)

onUnmounted(stop)
</script>

<template>
  <div class="animation">
    <canvas
      ref="canvas"
      class="frame"
      :style="{ width: `${tileset.width * zoom}px`, height: `${tileset.height * zoom}px` }"
    />
    <div class="controls">
      <button
        type="button"
        :title="playing ? 'Pause' : `Play ${frames.length} frames`"
        @click="toggle"
      >
        {{ playing ? '❙❙' : '▶' }}
      </button>
      <label>
        <input
          v-model.number="fps"
          type="range"
          min="1"
          max="30"
        >
        <span>{{ fps }} fps</span>
      </label>
      <span class="count">{{ frame + 1 }}/{{ frames.length }}</span>
    </div>
  </div>
</template>

<style scoped>
.animation {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-top: 0.4rem;
}

.frame {
  image-rendering: pixelated;
  /* A checker, so a transparent index reads as a hole rather than as black. */
  background:
    repeating-conic-gradient(#3a3a3a 0% 25%, #2c2c2c 0% 50%) 0 0 / 8px 8px;
  border: 1px solid var(--border, #444);
  flex-shrink: 0;
}

.controls {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.75rem;
  min-width: 0;
}

.controls label {
  display: flex;
  align-items: center;
  gap: 0.3rem;
}

.controls input[type='range'] {
  width: 5rem;
}

.count {
  opacity: 0.7;
}
</style>
