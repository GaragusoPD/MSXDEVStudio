<script setup lang="ts">
/**
 * Spec 10 B's right pane: the palette (editable GRB333 swatches for sc5/6/7,
 * a fixed-256 note for sc8, an import-only note for the YJK modes), convert
 * settings (mode/dither/palette source), retouch color/tool, and the export
 * block Spec 07's converter reads.
 */
import { computed } from 'vue'
import { BITMAP_MODES, MODES, type BitmapMode } from '../../../../shared/msx/modes'
import { fromHex, grbToRgb, paletteToRgb, rgbToGrb, toHex, unpackGrb } from '../../../../shared/msx/palette'
import type { DitherMode } from '../../../../shared/msx/quantize'
import { rgb332Palette } from '../../../../shared/msx/quantize'
import { defaultExport, type ExportBlock } from '../../../../shared/msx/resource'
import {
  commit,
  doc,
  reconvertNow,
  reconvertWith,
  removeFragment,
  renameFragment,
  setColor,
  setPalette,
  setTool,
  type ScreenSession,
  type ScreenTool
} from './session'

const props = defineProps<{ session: ScreenSession }>()

const screenDoc = computed(() => doc(props.session))
const info = computed(() => MODES[screenDoc.value.mode])
const editablePalette = computed(() => info.value.palette === 'grb333')
const swatchRgb = computed(() => {
  if (info.value.palette === 'rgb332' || info.value.palette === 'yjk') return rgb332Palette()
  return paletteToRgb(screenDoc.value.converted?.palette ?? null)
})
const swatchColumns = computed(() => Math.min(16, swatchRgb.value.length))
const convertedPalette = computed(() => screenDoc.value.converted?.palette ?? null)

const TOOLS: { id: ScreenTool; label: string; title: string }[] = [
  { id: 'pencil', label: '✎', title: 'Pencil' },
  { id: 'fill', label: '🪣', title: 'Fill (flood)' },
  { id: 'cut', label: '⛶', title: 'Cut a fragment — drag a rectangle on the converted image' }
]

function grbLabel(index: number): string {
  const packed = screenDoc.value.converted?.palette?.[index]
  if (packed === undefined) return `index ${index}`
  const { r, g, b } = unpackGrb(packed)
  return `GRB ${g}${r}${b}`
}

/** The native picker gives 8-bit RGB; the V9938 only has 3 bits per channel, so it snaps here. */
function pickColor(index: number, hex: string): void {
  setPalette(props.session, index, rgbToGrb(fromHex(hex)))
}

function swatchHex(packed: number): string {
  return toHex(grbToRgb(packed))
}

function setupExport(): void {
  commit(props.session, { ...screenDoc.value, export: defaultExport(props.session.path) })
}

function patchExport(patch: Partial<ExportBlock>): void {
  const current = screenDoc.value
  if (!current.export) return
  commit(props.session, { ...current, export: { ...current.export, ...patch } })
}
</script>

<template>
  <div class="side">
    <section>
      <h3>Palette</h3>
      <p class="mode">
        {{ info.label }}
      </p>
      <div
        class="swatches"
        :style="{ gridTemplateColumns: `repeat(${swatchColumns}, 1fr)` }"
      >
        <button
          v-for="(color, index) in swatchRgb"
          :key="index"
          type="button"
          class="swatch"
          :class="{ current: session.color === index }"
          :style="{ background: toHex(color) }"
          :title="`${index} — ${grbLabel(index)}`"
          @click="setColor(session, index)"
        />
      </div>
      <div
        v-if="editablePalette && convertedPalette"
        class="pickers"
      >
        <label
          v-for="(packed, index) in convertedPalette"
          :key="index"
          class="picker"
          :title="`Entry ${index} — ${grbLabel(index)}`"
        >
          <input
            type="color"
            :value="swatchHex(packed)"
            @input="pickColor(index, ($event.target as HTMLInputElement).value)"
          >
        </label>
      </div>
      <p
        v-else-if="info.palette === 'rgb332'"
        class="hint"
      >
        Fixed 256-color RGB332 palette — not editable.
      </p>
      <p
        v-else-if="info.palette === 'yjk'"
        class="hint"
      >
        Import-only: YJK colors are approximated for preview; export/retouch support is best-effort.
      </p>
    </section>

    <section>
      <h3>Tool</h3>
      <div class="tool-row">
        <button
          v-for="tool in TOOLS"
          :key="tool.id"
          type="button"
          :class="{ active: session.tool === tool.id }"
          :title="tool.title"
          @click="setTool(session, tool.id)"
        >
          {{ tool.label }}
        </button>
      </div>
    </section>

    <section>
      <h3>Fragments</h3>
      <p class="blurb">
        Named cut-outs of the converted image: bitmap-mode blocks, and the frames of a software
        sprite. Pick the ⛶ tool and drag a rectangle to cut one.
      </p>
      <ul
        v-if="screenDoc.fragments.length"
        class="fragments"
      >
        <li
          v-for="(fragment, index) in screenDoc.fragments"
          :key="index"
        >
          <input
            class="fragment-name"
            type="text"
            spellcheck="false"
            :value="fragment.name"
            @change="renameFragment(session, index, ($event.target as HTMLInputElement).value.trim() || fragment.name)"
          >
          <span class="dims">{{ fragment.width }}×{{ fragment.height }}</span>
          <button
            type="button"
            title="Remove fragment"
            @click="removeFragment(session, index)"
          >
            ×
          </button>
        </li>
      </ul>
    </section>

    <section>
      <h3>Convert</h3>
      <label>
        <span>Mode</span>
        <select
          :value="screenDoc.mode"
          @change="reconvertWith(session, { mode: ($event.target as HTMLSelectElement).value as BitmapMode })"
        >
          <option
            v-for="id in BITMAP_MODES"
            :key="id"
            :value="id"
          >
            {{ MODES[id].label }}
          </option>
        </select>
      </label>
      <label>
        <span>Palette source</span>
        <select
          :value="Array.isArray(screenDoc.convert.palette) ? 'optimized' : screenDoc.convert.palette"
          :disabled="!editablePalette"
          @change="reconvertWith(session, { convert: { palette: ($event.target as HTMLSelectElement).value as 'msx1' | 'optimized' } })"
        >
          <option value="optimized">
            Optimized (median cut)
          </option>
          <option value="msx1">
            Fixed MSX1 palette
          </option>
        </select>
      </label>
      <label>
        <span>Dither</span>
        <select
          :value="screenDoc.convert.dither"
          @change="reconvertWith(session, { convert: { dither: ($event.target as HTMLSelectElement).value as DitherMode } })"
        >
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
      <button
        type="button"
        class="wide"
        :disabled="!session.sourceImage || session.busy"
        @click="reconvertNow(session)"
      >
        {{ session.busy ? 'Converting…' : 'Reconvert' }}
      </button>
      <p class="hint">
        Reconversion re-applies your retouch strokes on top automatically.
      </p>
    </section>

    <section>
      <h3>Export</h3>
      <p
        v-if="!screenDoc.converted"
        class="hint warn"
      >
        No converted image yet — export will refuse until you convert once.
      </p>
      <template v-if="screenDoc.export">
        <label>
          <span>Table name</span>
          <input
            type="text"
            spellcheck="false"
            :value="screenDoc.export.name"
            @change="patchExport({ name: ($event.target as HTMLInputElement).value })"
          >
        </label>
        <label>
          <span>Output</span>
          <input
            type="text"
            spellcheck="false"
            :value="screenDoc.export.out"
            @change="patchExport({ out: ($event.target as HTMLInputElement).value })"
          >
        </label>
        <label>
          <span>Format</span>
          <select
            :value="screenDoc.export.format"
            @change="patchExport({ format: ($event.target as HTMLSelectElement).value as 'c' | 'bin' })"
          >
            <option value="c">
              C header
            </option>
            <option value="bin">
              Raw binary
            </option>
          </select>
        </label>
        <label
          v-if="screenDoc.fragments.length"
          class="inline"
        >
          <input
            type="checkbox"
            :checked="screenDoc.export.helpers === true"
            @change="patchExport({ helpers: ($event.target as HTMLInputElement).checked })"
          >
          <span title="Appends the software-sprite runtime: upload the frames once, then restore/draw each object. Needs msxgl.h included first.">
            Export ready-made C
          </span>
        </label>
      </template>
      <button
        v-else
        type="button"
        class="wide"
        @click="setupExport"
      >
        Set up export
      </button>
    </section>
  </div>
</template>

<style scoped>
.inline {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--color-text-muted);
}

.blurb {
  margin: 0 0 6px;
  font-size: 10px;
  line-height: 1.4;
  color: var(--color-text-muted);
}

.fragments {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.fragments li {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
}

.fragment-name {
  flex: 1;
  min-width: 0;
  padding: 1px 3px;
  border: 1px solid var(--color-border);
  border-radius: 2px;
  background: var(--color-bg-tab-inactive);
  color: var(--color-text);
  font-size: 11px;
}

.fragments .dims {
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}
.side {
  width: 240px;
  flex: none;
  padding: 8px 10px 20px;
  overflow-y: auto;
  border-left: 1px solid var(--color-border);
}

h3 {
  margin: 0 0 4px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-text-muted);
}

section {
  margin-bottom: 16px;
}

.mode {
  margin: 0 0 6px;
  font-size: 11px;
  color: var(--color-text-muted);
}

.swatches {
  display: grid;
  gap: 2px;
}

.swatch {
  height: 16px;
  border: 1px solid var(--color-border);
  border-radius: 2px;
}

.swatch.current {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

.pickers {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 2px;
  margin-top: 4px;
}

.picker input {
  width: 100%;
  height: 18px;
  padding: 0;
  border: 1px solid var(--color-border);
  background: none;
}

.tool-row {
  display: flex;
  gap: 6px;
}

.tool-row button {
  flex: 1;
  padding: 4px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-hover);
  font-size: 13px;
}

.tool-row button.active {
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: #ffffff;
}

label {
  display: block;
  margin-bottom: 6px;
  font-size: 11px;
}

label > span:first-child {
  display: block;
  margin-bottom: 2px;
  color: var(--color-text-muted);
}

select,
input[type='text'] {
  width: 100%;
  padding: 3px 5px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-tab-inactive);
  color: var(--color-text);
  font-size: 11px;
}

.wide {
  width: 100%;
  padding: 4px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-hover);
  font-size: 11px;
}

.wide:disabled {
  opacity: 0.5;
  cursor: default;
}

.hint {
  margin: 4px 0 0;
  font-size: 10px;
  color: var(--color-text-muted);
}

.hint.warn {
  color: #e0a020;
}
</style>
