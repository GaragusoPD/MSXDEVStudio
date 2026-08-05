<script setup lang="ts">
/**
 * Right panel: the active sprite's layer list (max 4, image-editor style)
 * plus per-layer color controls — a single color picker in mode 1, a
 * 16-entry per-line color strip with EC/CC/IC bits in mode 2 — and the
 * size/mode toggles (mode 2→1 and 16→8 warn on real data loss).
 */
import { computed, ref, watchEffect } from 'vue'
import { MSX1_COLOR_NAMES, paletteToRgb, type Rgb } from '../../../../shared/msx/palette'
import {
  compositeFrame,
  convertSpriteMode,
  lineColorByte,
  MAX_GRID,
  MAX_LAYERS,
  setLayerCc,
  setLineColorByte,
  SPRITE_CC,
  SPRITE_EC,
  SPRITE_IC,
  type SpriteMode,
  type SpriteSize,
  type SpritesDoc
} from '../../../../shared/msx/sprite'
import {
  addLayer,
  convertSpriteSize,
  gridShrinkLossy,
  modeConversionLossy,
  removeLayer,
  reorderLayer,
  setCharacterGrid,
  sizeConversionLossy,
  updateLayer,
  type SpriteTarget
} from '../../../../shared/sprite-editor'
import { drawIndices } from './draw'

const props = defineProps<{ doc: SpritesDoc; target: SpriteTarget }>()
const emit = defineEmits<{ selectLayer: [index: number]; mutate: [doc: SpritesDoc] }>()

const rgb = computed<Rgb[]>(() => paletteToRgb(props.doc.palette))
const character = computed(() => props.doc.sprites[props.target.sprite])
const frame = computed(() => character.value?.frames[props.target.frame])
const layers = computed(() => frame.value?.layers ?? [])
const activeLayer = computed(() => layers.value[props.target.layer])
const lines = computed(() => props.doc.size) // 8×8 sprites only use the first 8 of the 16 line-color bytes
const isMeta = computed(() => (character.value?.cols ?? 1) * (character.value?.rows ?? 1) > 1)
/** New planes land on the active plane's cell — the one the canvas is outlining. */
const activeCell = computed(() => ({ cx: activeLayer.value?.cx ?? 0, cy: activeLayer.value?.cy ?? 0 }))
const cellFull = computed(
  () => layers.value.filter((l) => l.cx === activeCell.value.cx && l.cy === activeCell.value.cy).length >= MAX_LAYERS
)

const THUMB = 32
const thumbRefs = ref<(HTMLCanvasElement | null)[]>([])

/** Moves a plane one step; the buttons only ever swap neighbours, so the selection just follows. */
function moveLayer(from: number, to: number): void {
  emit('mutate', reorderLayer(props.doc, props.target.sprite, from, to))
  if (props.target.layer === from) emit('selectLayer', to)
  else if (props.target.layer === to) emit('selectLayer', from)
}

function redrawThumbs(): void {
  layers.value.forEach((layer, i) => {
    const canvas = thumbRefs.value[i]
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    ctx.clearRect(0, 0, THUMB, THUMB)
    const size = props.doc.size
    // Drawn at the origin whatever cell it belongs to, so the thumbnail is the plane itself.
    drawIndices(ctx, compositeFrame([{ ...layer, cx: 0, cy: 0 }], props.doc.mode, size), size, THUMB / size, rgb.value)
  })
}
// flush: 'post' so the layer-row canvas refs exist on the very first run, not just later ones.
watchEffect(redrawThumbs, { flush: 'post' })

function swatch(index: number): string {
  const c = rgb.value[index] ?? { r: 0, g: 0, b: 0 }
  return `rgb(${c.r}, ${c.g}, ${c.b})`
}

function setColor(color: number): void {
  emit('mutate', updateLayer(props.doc, props.target, (layer) => ({ ...layer, color })))
}

function setEc(ec: boolean): void {
  emit('mutate', updateLayer(props.doc, props.target, (layer) => ({ ...layer, ec })))
}

function lineByte(y: number): number {
  return activeLayer.value ? lineColorByte(activeLayer.value, y, 2) : 0
}

function setLineColor(y: number, color: number): void {
  const byte = (lineByte(y) & ~0x0f) | (color & 0x0f)
  emit('mutate', updateLayer(props.doc, props.target, (layer) => setLineColorByte(layer, y, byte)))
}

function toggleLineBit(y: number, bit: number, on: boolean): void {
  const byte = on ? lineByte(y) | bit : lineByte(y) & ~bit
  emit('mutate', updateLayer(props.doc, props.target, (layer) => setLineColorByte(layer, y, byte & 0xff)))
}

function toggleCc(on: boolean): void {
  emit('mutate', updateLayer(props.doc, props.target, (layer) => setLayerCc(layer, on)))
}

function changeMode(mode: SpriteMode): void {
  if (mode === props.doc.mode) return
  if (modeConversionLossy(props.doc, mode) && !window.confirm('Switching to mode 1 keeps only line 0’s color per layer and drops OR-color blending. Continue?')) return
  emit('mutate', convertSpriteMode(props.doc, mode))
}

function setHelpers(helpers: boolean): void {
  if (!props.doc.export) return
  emit('mutate', { ...props.doc, export: { ...props.doc.export, helpers } })
}

function changeGrid(cols: number, rows: number): void {
  if (
    gridShrinkLossy(props.doc, props.target.sprite, cols, rows) &&
    !window.confirm('Shrinking the grid deletes the hardware sprites outside it, with their pixels. Continue?')
  ) {
    return
  }
  emit('mutate', setCharacterGrid(props.doc, props.target.sprite, cols, rows))
  // The active plane may have just been dropped; the first one always exists.
  emit('selectLayer', 0)
}

function changeSize(size: SpriteSize): void {
  if (size === props.doc.size) return
  if (sizeConversionLossy(props.doc, size) && !window.confirm('Shrinking to 8×8 crops every pattern to its top-left corner and discards the rest. Continue?')) return
  emit('mutate', convertSpriteSize(props.doc, size))
}
</script>

<template>
  <div class="panel">
    <section v-if="character">
      <h3>Character grid</h3>
      <div class="grid-pick">
        <select
          :value="character.cols"
          title="Hardware sprites across"
          @change="changeGrid(Number(($event.target as HTMLSelectElement).value), character.rows)"
        >
          <option
            v-for="c in MAX_GRID"
            :key="c"
            :value="c"
          >
            {{ c }}
          </option>
        </select>
        <span>×</span>
        <select
          :value="character.rows"
          title="Hardware sprites down"
          @change="changeGrid(character.cols, Number(($event.target as HTMLSelectElement).value))"
        >
          <option
            v-for="r in MAX_GRID"
            :key="r"
            :value="r"
          >
            {{ r }}
          </option>
        </select>
        <span class="dims">= {{ character.cols * doc.size }}×{{ character.rows * doc.size }} px</span>
      </div>
      <p
        v-if="isMeta"
        class="hint"
      >
        Click a cell on the canvas to paint it — an empty one gets a plane back. Each cell is one
        hardware sprite, and each of its layers costs another: the 4/8-per-scanline limit counts
        them all.
      </p>
      <label
        v-if="doc.export"
        class="inline helpers"
      >
        <input
          type="checkbox"
          :checked="doc.export.helpers === true"
          @change="setHelpers(($event.target as HTMLInputElement).checked)"
        >
        <span title="Appends a _SetMeta() that places a whole character from one coordinate. Needs msxgl.h included first.">
          Export ready-made C
        </span>
      </label>
    </section>

    <section>
      <div class="section-head">
        <h3>Layers</h3>
        <button
          type="button"
          :title="isMeta ? `Add a plane on cell (${activeCell.cx}, ${activeCell.cy})` : 'Add a plane'"
          :disabled="cellFull"
          @click="emit('mutate', addLayer(doc, target.sprite, activeCell.cx, activeCell.cy))"
        >
          + Layer
        </button>
      </div>
      <ul>
        <li
          v-for="(layer, index) in layers"
          :key="index"
          class="row"
          :class="{ active: index === target.layer, dim: isMeta && (layer.cx !== activeCell.cx || layer.cy !== activeCell.cy) }"
          @click="emit('selectLayer', index)"
        >
          <canvas
            :ref="(el) => (thumbRefs[index] = el as HTMLCanvasElement)"
            class="thumb"
            :width="THUMB"
            :height="THUMB"
          />
          <span class="label">
            Layer {{ index + 1 }}
            <span
              v-if="isMeta"
              class="cell"
            >({{ layer.cx }}, {{ layer.cy }})</span>
          </span>
          <span
            class="dot"
            :style="{ background: swatch(layer.color) }"
          />
          <button
            type="button"
            title="Move layer up"
            :disabled="index === 0"
            @click.stop="moveLayer(index, index - 1)"
          >
            ↑
          </button>
          <button
            type="button"
            title="Move layer down"
            :disabled="index === layers.length - 1"
            @click.stop="moveLayer(index, index + 1)"
          >
            ↓
          </button>
          <button
            type="button"
            title="Remove layer"
            :disabled="layers.length <= 1"
            @click.stop="emit('mutate', removeLayer(doc, target.sprite, index))"
          >
            ×
          </button>
        </li>
      </ul>
    </section>

    <section v-if="activeLayer && doc.mode === 1">
      <h3>Color</h3>
      <div class="swatch-grid">
        <button
          v-for="(name, index) in MSX1_COLOR_NAMES"
          :key="index"
          type="button"
          class="swatch-btn"
          :class="{ active: activeLayer.color === index }"
          :style="{ background: swatch(index) }"
          :title="`${index}: ${name}`"
          @click="setColor(index)"
        />
      </div>
      <label class="inline">
        <input
          type="checkbox"
          :checked="activeLayer.ec"
          @change="setEc(($event.target as HTMLInputElement).checked)"
        >
        <span>EC (shift 32 dots left)</span>
      </label>
    </section>

    <section v-else-if="activeLayer && doc.mode === 2">
      <div class="section-head">
        <h3>Line colors</h3>
        <label class="inline">
          <input
            type="checkbox"
            :checked="activeLayer.cc"
            @change="toggleCc(($event.target as HTMLInputElement).checked)"
          >
          <span title="OR-blend every line with the sprite above it">CC (all lines)</span>
        </label>
      </div>
      <div class="lines">
        <div
          v-for="y in lines"
          :key="y - 1"
          class="line-row"
        >
          <span class="y">{{ y - 1 }}</span>
          <span
            class="dot"
            :style="{ background: swatch(lineByte(y - 1) & 0x0f) }"
          />
          <select
            :value="lineByte(y - 1) & 0x0f"
            @change="setLineColor(y - 1, Number(($event.target as HTMLSelectElement).value))"
          >
            <option
              v-for="c in 16"
              :key="c - 1"
              :value="c - 1"
              :style="{ background: swatch(c - 1) }"
            >
              {{ c - 1 }}
            </option>
          </select>
          <label
            class="bit"
            title="Early clock"
          >
            <input
              type="checkbox"
              :checked="(lineByte(y - 1) & SPRITE_EC) !== 0"
              @change="toggleLineBit(y - 1, SPRITE_EC, ($event.target as HTMLInputElement).checked)"
            >
            EC
          </label>
          <label
            class="bit"
            title="OR-color blend"
          >
            <input
              type="checkbox"
              :checked="(lineByte(y - 1) & SPRITE_CC) !== 0"
              @change="toggleLineBit(y - 1, SPRITE_CC, ($event.target as HTMLInputElement).checked)"
            >
            CC
          </label>
          <label
            class="bit"
            title="Invisible (still collides)"
          >
            <input
              type="checkbox"
              :checked="(lineByte(y - 1) & SPRITE_IC) !== 0"
              @change="toggleLineBit(y - 1, SPRITE_IC, ($event.target as HTMLInputElement).checked)"
            >
            IC
          </label>
        </div>
      </div>
    </section>

    <section>
      <h3>Sprite mode</h3>
      <div class="toggle">
        <button
          type="button"
          :class="{ active: doc.mode === 1 }"
          @click="changeMode(1)"
        >
          Mode 1
        </button>
        <button
          type="button"
          :class="{ active: doc.mode === 2 }"
          @click="changeMode(2)"
        >
          Mode 2
        </button>
      </div>
      <h3>Size</h3>
      <div class="toggle">
        <button
          type="button"
          :class="{ active: doc.size === 8 }"
          @click="changeSize(8)"
        >
          8×8
        </button>
        <button
          type="button"
          :class="{ active: doc.size === 16 }"
          @click="changeSize(16)"
        >
          16×16
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.panel {
  width: 240px;
  flex-shrink: 0;
  border-left: 1px solid var(--color-border);
  padding: 8px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

h3 {
  margin: 0 0 6px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.section-head h3 {
  margin: 0;
}

section > button {
  padding: 2px 8px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-hover);
  font-size: 11px;
}

section > button:disabled {
  opacity: 0.4;
  cursor: default;
}

ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
}

.row:hover {
  background: var(--color-bg-hover);
}

.row.active {
  border-color: var(--color-accent);
  background: var(--color-bg-active-item);
}

.thumb {
  image-rendering: pixelated;
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  background-color: var(--color-bg-tab-inactive);
  border: 1px solid var(--color-border);
}

.label {
  flex: 1;
  font-size: 11px;
}

.row.dim {
  opacity: 0.55;
}

.cell {
  color: var(--color-text-muted);
}

.grid-pick {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
}

.grid-pick select {
  padding: 2px 4px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-tab-inactive);
  color: var(--color-text);
  font-size: 11px;
}

.grid-pick .dims {
  color: var(--color-text-muted);
}

.helpers {
  margin-top: 6px;
}

.hint {
  margin: 6px 0 0;
  font-size: 10px;
  line-height: 1.4;
  color: var(--color-text-muted);
}

.dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border: 1px solid var(--color-border);
  flex-shrink: 0;
}

.row button {
  padding: 0 4px;
  color: var(--color-text-muted);
}

.row button:disabled {
  opacity: 0.3;
}

.swatch-grid {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 3px;
  margin-bottom: 8px;
}

.swatch-btn {
  width: 100%;
  aspect-ratio: 1;
  border: 2px solid var(--color-border);
  border-radius: 3px;
  padding: 0;
}

.swatch-btn.active {
  border-color: var(--color-accent);
}

.inline {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--color-text-muted);
}

.lines {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 320px;
  overflow-y: auto;
}

.line-row {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
}

.line-row .y {
  width: 16px;
  color: var(--color-text-muted);
  text-align: right;
}

.line-row select {
  flex: 1;
  min-width: 0;
  padding: 1px 2px;
  border: 1px solid var(--color-border);
  border-radius: 2px;
  background: var(--color-bg-tab-inactive);
  color: var(--color-text);
  font-size: 10px;
}

.bit {
  display: flex;
  align-items: center;
  gap: 1px;
  color: var(--color-text-muted);
  white-space: nowrap;
}

.toggle {
  display: flex;
  gap: 4px;
  margin-bottom: 8px;
}

.toggle button {
  flex: 1;
  padding: 4px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-hover);
  font-size: 11px;
}

.toggle button.active {
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: #ffffff;
}
</style>
