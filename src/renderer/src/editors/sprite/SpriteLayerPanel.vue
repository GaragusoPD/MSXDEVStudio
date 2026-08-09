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
import Icon from '../../components/Icon.vue'

const props = defineProps<{ doc: SpritesDoc; target: SpriteTarget; hiddenLayers: number[] }>()
const emit = defineEmits<{
  selectLayer: [index: number]
  mutate: [doc: SpritesDoc]
  toggleLayer: [index: number]
  moveLayer: [move: { from: number; to: number }]
}>()

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
  // The eyes follow for the same reason, and after the mutate: they are indices
  // into the list the mutate has just reordered.
  emit('moveLayer', { from, to })
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

/**
 * CC on the first plane is the one setting the VDP silently throws away — it
 * means "share the priority of the nearest plane above me whose CC is 0", and
 * above the first plane there is nothing, so that plane is not drawn. The model
 * clears it either way (`lockLeadingCc`); disabling the box is how the person
 * finds out, instead of watching a checkbox refuse to stay ticked.
 */
const ccLocked = computed(() => props.target.layer === 0)
const ccTitle = computed(() =>
  ccLocked.value
    ? 'The first plane cannot use CC: it OR-blends with the plane above, and there is none. The VDP would not draw this plane at all. Move it below another plane to enable.'
    : 'OR-blend this plane with the plane above it'
)

/** Names the fixed TMS9918A entries; a programmable palette has only indices to give. */
function colorLabel(index: number): string {
  return props.doc.palette ? `${index}` : `${index} — ${MSX1_COLOR_NAMES[index]}`
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
          :class="{
            active: index === target.layer,
            dim: isMeta && (layer.cx !== activeCell.cx || layer.cy !== activeCell.cy),
            off: hiddenLayers.includes(index)
          }"
          @click="emit('selectLayer', index)"
        >
          <button
            type="button"
            class="eye"
            :title="hiddenLayers.includes(index) ? 'Show this plane on the canvas' : 'Hide this plane while drawing (it still exports)'"
            @click.stop="emit('toggleLayer', index)"
          >
            <Icon
              :name="hiddenLayers.includes(index) ? 'visibility_off' : 'visibility'"
              :size="14"
            />
          </button>
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
            <Icon
              name="arrow_upward"
              :size="14"
            />
          </button>
          <button
            type="button"
            title="Move layer down"
            :disabled="index === layers.length - 1"
            @click.stop="moveLayer(index, index + 1)"
          >
            <Icon
              name="arrow_downward"
              :size="14"
            />
          </button>
          <button
            type="button"
            title="Remove layer"
            :disabled="layers.length <= 1"
            @click.stop="emit('mutate', removeLayer(doc, target.sprite, index))"
          >
            <Icon
              name="delete"
              :size="14"
            />
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
        <label
          class="inline"
          :class="{ locked: ccLocked }"
          :title="ccTitle"
        >
          <input
            type="checkbox"
            :checked="activeLayer.cc"
            :disabled="ccLocked"
            @change="toggleCc(($event.target as HTMLInputElement).checked)"
          >
          <span>CC (all lines)</span>
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
            class="chip"
            :style="{ background: swatch(lineByte(y - 1) & 0x0f) }"
            :title="colorLabel(lineByte(y - 1) & 0x0f)"
          >
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
                {{ colorLabel(c - 1) }}
              </option>
            </select>
          </span>
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
            :class="{ locked: ccLocked }"
            :title="ccTitle"
          >
            <input
              type="checkbox"
              :checked="(lineByte(y - 1) & SPRITE_CC) !== 0"
              :disabled="ccLocked"
              @change="toggleLineBit(y - 1, SPRITE_CC, ($event.target as HTMLInputElement).checked)"
            >
            CC
          </label>
          <label
            class="bit"
            title="Inhibit collision — this line stops setting the VDP's collision flag. It stays visible."
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

/* Hidden planes stay legible — the thumbnail is how you find the one to bring
   back — so the row fades rather than greys out, and the eye keeps full
   contrast. */
.row.off .thumb,
.row.off .label,
.row.off .dot {
  opacity: 0.4;
}

.eye {
  display: flex;
  flex: none;
  padding: 0 2px;
  color: var(--color-text-muted);
}

.row.off .eye {
  color: var(--color-accent);
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
  display: flex;
  padding: 0 3px;
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

/* No cap and no scroller of its own: sixteen rows fit the sidebar, and `.panel`
   already scrolls, so capping this only bought a second scrollbar inside the
   first. */
.lines {
  display: flex;
  flex-direction: column;
  gap: 2px;
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

/* The swatch *is* the picker, as in the tile editor's row colours: a transparent
   native select lies over it, so a line's colour is chosen by clicking the colour
   rather than by reading its number out of a dropdown beside it. */
.line-row .chip {
  position: relative;
  flex: 1;
  min-width: 0;
  height: 14px;
  border: 1px solid var(--color-border);
  border-radius: 2px;
}

.line-row .chip:focus-within {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

.line-row .chip select {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  padding: 0;
  border: none;
  opacity: 0;
  cursor: pointer;
}

.bit {
  display: flex;
  align-items: center;
  gap: 1px;
  color: var(--color-text-muted);
  white-space: nowrap;
}

/* Faded rather than hidden: the box has to stay visible for its tooltip to be
   the place someone learns why the first plane can't OR-blend. */
.locked {
  opacity: 0.45;
  cursor: not-allowed;
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
