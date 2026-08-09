<script setup lang="ts">
/**
 * Import PNG strip → frames (Spec 09). Reuses Spec 07's quantizer through
 * `useImageImport` directly (not `ImportImageDialog.vue`, whose UI is tuned
 * for tiles/screens) since sprites need one extra manual step: which
 * quantized palette entry lands on which of up to 4 hardware layers.
 *
 * The quantizer always runs against a `perPixel` bitmap mode (sc5) so
 * `fitRowConstraint` never touches the result — sprites have no such
 * constraint. Mode 1 forces the fixed MSX1 palette (indices already are the
 * sprite's own 0-15 color codes); mode 2 uses an optimized 16-entry palette
 * and adopts it as the document's palette when one isn't set yet.
 */
import { computed, reactive, ref, watch } from 'vue'
import Icon from '../../components/Icon.vue'
import { MAX_LAYERS, type SpriteFrame, type SpriteMode, type SpriteSize } from '../../../../shared/msx/sprite'
import { stripToFrames } from '../../../../shared/sprite-editor'
import { useImageImport } from '../../composables/useImageImport'

const props = defineProps<{ mode: SpriteMode; size: SpriteSize }>()
const emit = defineEmits<{ close: []; imported: [frames: SpriteFrame[], palette: number[] | null] }>()

const importer = useImageImport({ mode: 'sc5', palette: props.mode === 1 ? 'msx1' : 'optimized', dither: 'none' })
const beforeCanvas = ref<HTMLCanvasElement | null>(null)
const afterCanvas = ref<HTMLCanvasElement | null>(null)

/** source palette index → target layer (0..3), or -1 for "unused". */
const assignment = reactive<Record<number, number>>({})

const usedIndices = computed(() => {
  const result = importer.result.value
  if (!result) return []
  return [...new Set(result.indices)].filter((i) => i !== 0).sort((a, b) => a - b)
})

// Default: the first MAX_LAYERS distinct colors go to layers 0..3 in order; the rest start unused.
watch(usedIndices, (indices) => {
  for (const key of Object.keys(assignment)) delete assignment[Number(key)]
  indices.forEach((source, i) => {
    assignment[source] = i < MAX_LAYERS ? i : -1
  })
})

const frameCount = computed(() => {
  const result = importer.result.value
  return result ? Math.max(1, Math.floor(result.width / props.size)) : 0
})

function paint(canvas: HTMLCanvasElement | null, image: ImageData | null): void {
  if (!canvas || !image) return
  canvas.width = image.width
  canvas.height = image.height
  canvas.getContext('2d')?.putImageData(image, 0, 0)
}

watch(importer.source, (image) => paint(beforeCanvas.value, image), { flush: 'post' })
watch(importer.result, (result) => paint(afterCanvas.value, result ? importer.toImageData(result) : null), { flush: 'post' })

function onPick(event: Event): void {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (file) void importer.loadFile(file)
}

function doImport(): void {
  const result = importer.result.value
  if (!result) return
  const assign = (source: number): number | null => {
    const layer = assignment[source]
    return layer === undefined || layer < 0 ? null : layer
  }
  const frames = stripToFrames(result.indices, result.width, result.height, props.size, assign)
  emit('imported', frames, props.mode === 2 ? result.palette : null)
}
</script>

<template>
  <div
    class="backdrop"
    @click.self="emit('close')"
  >
    <div class="dialog">
      <header>
        <h2>Import PNG strip</h2>
        <button
          type="button"
          class="close"
          title="Close"
          @click="emit('close')"
        >
          <Icon name="close" />
        </button>
      </header>

      <p class="hint">
        A horizontal filmstrip of {{ size }}×{{ size }} frames. Colors are quantized first, then you
        assign each one to a hardware layer (max {{ MAX_LAYERS }}) below.
      </p>

      <div class="controls">
        <label>
          <span>Image</span>
          <input
            type="file"
            accept="image/*"
            @change="onPick"
          >
        </label>
        <label>
          <span>Dither</span>
          <select v-model="importer.options.dither">
            <option value="none">
              None
            </option>
            <option value="bayer4">
              Bayer 4×4
            </option>
            <option value="floyd">
              Floyd–Steinberg
            </option>
          </select>
        </label>
      </div>

      <div class="previews">
        <figure>
          <figcaption>Original</figcaption>
          <canvas ref="beforeCanvas" />
        </figure>
        <figure>
          <figcaption>Quantized ({{ frameCount }} frame{{ frameCount === 1 ? '' : 's' }})</figcaption>
          <canvas ref="afterCanvas" />
        </figure>
      </div>

      <p
        v-if="importer.error.value"
        class="error"
      >
        {{ importer.error.value }}
      </p>
      <p
        v-else-if="importer.busy.value"
        class="hint"
      >
        Converting…
      </p>

      <table
        v-if="usedIndices.length"
        class="mapping"
      >
        <thead>
          <tr>
            <th>Color</th>
            <th>Layer</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="source in usedIndices"
            :key="source"
          >
            <td>
              <span
                class="swatch"
                :style="{ background: `rgb(${importer.result.value?.rgb[source]?.r}, ${importer.result.value?.rgb[source]?.g}, ${importer.result.value?.rgb[source]?.b})` }"
              />
              #{{ source }}
            </td>
            <td>
              <select v-model.number="assignment[source]">
                <option :value="-1">
                  Unused
                </option>
                <option
                  v-for="l in MAX_LAYERS"
                  :key="l"
                  :value="l - 1"
                >
                  Layer {{ l }}
                </option>
              </select>
            </td>
          </tr>
        </tbody>
      </table>

      <p
        v-if="mode === 2 && importer.result.value"
        class="hint"
      >
        Mode 2: the imported palette becomes the document's palette only if none is set yet — check
        colors after import otherwise.
      </p>

      <footer>
        <button
          type="button"
          class="primary"
          :disabled="!importer.result.value"
          @click="doImport"
        >
          Import
        </button>
        <button
          type="button"
          @click="emit('close')"
        >
          Close
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 40;
}

.dialog {
  width: min(700px, 92vw);
  max-height: 90vh;
  overflow-y: auto;
  padding: 16px 20px 20px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 6px;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.close {
  font-size: 18px;
  line-height: 1;
  color: var(--color-text-muted);
}

.hint {
  margin: 0 0 10px;
  font-size: 11px;
  color: var(--color-text-muted);
  line-height: 1.5;
}

.controls {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 16px;
  margin-bottom: 12px;
}

label {
  display: block;
  font-size: 12px;
}

label > span:first-child {
  display: block;
  margin-bottom: 3px;
  color: var(--color-text-muted);
}

input[type='text'],
select {
  width: 100%;
  padding: 4px 6px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-tab-inactive);
  color: var(--color-text);
  font-size: 12px;
}

.previews {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 12px;
}

figure {
  margin: 0;
  min-width: 0;
}

figcaption {
  margin-bottom: 4px;
  font-size: 11px;
  color: var(--color-text-muted);
}

canvas {
  width: 100%;
  height: auto;
  image-rendering: pixelated;
  border: 1px solid var(--color-border);
  background-color: var(--color-bg-tab-inactive);
}

.mapping {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  margin-bottom: 8px;
}

.mapping th {
  text-align: left;
  font-weight: normal;
  color: var(--color-text-muted);
  padding: 2px 8px 4px 0;
}

.mapping td {
  padding: 2px 8px 2px 0;
}

.swatch {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 4px;
  border: 1px solid var(--color-border);
  vertical-align: middle;
}

.error {
  font-size: 12px;
  color: var(--color-error, #f14c4c);
}

footer {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

footer button {
  padding: 5px 14px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-bg-hover);
  font-size: 12px;
}

footer .primary {
  margin-left: auto;
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: #ffffff;
}

footer .primary:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
