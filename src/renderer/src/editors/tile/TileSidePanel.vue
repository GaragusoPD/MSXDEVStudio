<script setup lang="ts">
/**
 * Spec 08's right pane: the 16-color palette (fixed TMS9918A, or an editable
 * GRB333 picker on sc4 that snaps to the V9938's 512 colors), the per-row
 * FG/BG strip, the multi-tile blocks, and the export block Spec 07's
 * converter reads.
 */
import { computed, ref } from 'vue'
import { MODES } from '../../../../shared/msx/modes'
import {
  fromHex,
  grbToRgb,
  MSX1_COLOR_NAMES,
  MSX1_PALETTE_GRB,
  paletteToRgb,
  rgbToGrb,
  toHex,
  unpackGrb
} from '../../../../shared/msx/palette'
import { defaultExport } from '../../../../shared/msx/resource'
import { MAX_BLOCK, TILE_FLAG_COUNT } from '../../../../shared/msx/tile'
import { colorByteAt, splitColorByte, TILE_SIZE } from '../../../../shared/msx/tile'
import { blockColorGroupWarning, renameBlock } from '../../../../shared/tile-editor'
import {
  addBlock,
  commit,
  deleteBlock,
  selectBlock,
  setColor,
  setPalette,
  setRow,
  swapRow,
  toggleFlag,
  type TileSession
} from './session'

const props = defineProps<{ session: TileSession }>()

const doc = computed(() => props.session.doc)
const rgb = computed(() => paletteToRgb(doc.value.palette))
const programmable = computed(() => doc.value.mode === 'sc4')
const rows = computed(() =>
  Array.from({ length: TILE_SIZE }, (_, y) => ({ y, ...splitColorByte(colorByteAt(doc.value, props.session.active, y)) }))
)

/** sc1 shares one pair per group of 8 tiles, so the strip collapses to a single row. */
const strip = computed(() => (doc.value.mode === 'sc1' ? rows.value.slice(0, 1) : rows.value))

function togglePalette(on: boolean): void {
  commit(props.session, { ...doc.value, palette: on ? [...MSX1_PALETTE_GRB] : null }, 'palette mode')
}

/** The native picker gives 8-bit RGB; the V9938 only has 3 bits per channel, so it snaps here. */
function pickColor(index: number, hex: string): void {
  setPalette(props.session, index, rgbToGrb(fromHex(hex)))
}

function grbLabel(index: number): string {
  const packed = doc.value.palette?.[index]
  if (packed === undefined) return MSX1_COLOR_NAMES[index]
  const { r, g, b } = unpackGrb(packed)
  return `GRB ${g}${r}${b}`
}

const newBlock = ref({ width: 2, height: 2 })

/** sc1 shares one FG/BG per 8 tiles, so a block can end up recolouring its neighbours. */
const blockWarning = computed(() => {
  const block = props.session.block === null ? null : doc.value.blocks[props.session.block]
  return block ? blockColorGroupWarning(doc.value, block) : null
})

function createNewBlock(): void {
  const name = `block_${doc.value.blocks.length}`
  addBlock(props.session, name, newBlock.value.width, newBlock.value.height)
}

function rename(index: number, event: Event): void {
  const name = (event.target as HTMLInputElement).value.trim()
  if (name) commit(props.session, renameBlock(doc.value, index, name), 'rename block')
}

function setupExport(): void {
  commit(props.session, { ...doc.value, export: defaultExport(props.session.path) }, 'export target')
}

function patchExport(patch: Partial<NonNullable<typeof doc.value.export>>): void {
  if (!doc.value.export) return
  commit(props.session, { ...doc.value, export: { ...doc.value.export, ...patch } }, 'export target')
}
</script>

<template>
  <div class="side">
    <section>
      <h3>Palette</h3>
      <p class="mode">
        {{ MODES[doc.mode].label }}
      </p>
      <div class="swatches">
        <button
          v-for="(color, index) in rgb"
          :key="index"
          type="button"
          class="swatch"
          :class="{ current: session.color === index, transparent: index === 0 }"
          :style="{ background: toHex(color) }"
          :title="`${index} — ${grbLabel(index)}`"
          @click="setColor(session, index)"
        >
          <span>{{ index }}</span>
        </button>
      </div>

      <template v-if="programmable">
        <label class="inline">
          <input
            type="checkbox"
            :checked="!!doc.palette"
            @change="togglePalette(($event.target as HTMLInputElement).checked)"
          >
          <span>Programmable palette (V9938)</span>
        </label>
        <div
          v-if="doc.palette"
          class="pickers"
        >
          <label
            v-for="(packed, index) in doc.palette"
            :key="index"
            class="picker"
            :title="`Entry ${index} — snapped to ${grbLabel(index)}`"
          >
            <input
              type="color"
              :value="toHex(grbToRgb(packed))"
              @input="pickColor(index, ($event.target as HTMLInputElement).value)"
            >
            <span>{{ index }}</span>
          </label>
        </div>
        <p
          v-else
          class="hint"
        >
          Using the MSX1 colors. Turn this on to write a palette table into the export.
        </p>
      </template>
      <p
        v-else
        class="hint"
      >
        {{ MODES[doc.mode].label }} uses the TMS9918A's fixed 16 colors.
      </p>
    </section>

    <section>
      <h3>{{ doc.mode === 'sc1' ? `Group ${session.active >> 3} colors` : 'Row colors' }}</h3>
      <p class="hint">
        Click a chip to give that role the selected palette color ({{ session.color }}).
      </p>
      <div
        v-for="row in strip"
        :key="row.y"
        class="rowpair"
      >
        <span class="label">{{ doc.mode === 'sc1' ? `${session.active >> 3}` : row.y }}</span>
        <button
          type="button"
          class="chip"
          :style="{ background: toHex(rgb[row.fg]) }"
          :title="`Foreground: ${row.fg} — ${grbLabel(row.fg)}`"
          @click="setRow(session, row.y, session.color, row.bg)"
        />
        <button
          type="button"
          class="chip"
          :style="{ background: toHex(rgb[row.bg]) }"
          :title="`Background: ${row.bg} — ${grbLabel(row.bg)}`"
          @click="setRow(session, row.y, row.fg, session.color)"
        />
        <button
          type="button"
          class="swap"
          title="Swap FG and BG (the pattern is inverted so the tile looks the same)"
          @click="swapRow(session, row.y)"
        >
          ⇄
        </button>
      </div>
    </section>

    <section>
      <h3>Flags</h3>
      <p class="hint">
        Eight gameplay bits for tile {{ session.active }}. What they mean is up
        to your game; they export as <code>_Flags</code>, one byte per tile.
      </p>
      <div class="flag-row">
        <button
          v-for="bit in TILE_FLAG_COUNT"
          :key="bit"
          type="button"
          class="flag"
          :class="{ on: ((doc.flags[session.active] ?? 0) >> (bit - 1) & 1) === 1 }"
          :title="`Flag ${bit} (bit ${bit - 1}, mask 0x${(1 << (bit - 1)).toString(16).toUpperCase()})`"
          @click="toggleFlag(session, bit - 1)"
        >
          {{ bit }}
        </button>
      </div>

      <h3>Blocks</h3>
      <p class="blurb">
        A design bigger than one tile — drawn on one canvas, stored as the tiles it is made of.
      </p>
      <ul class="blocks">
        <li>
          <button
            type="button"
            class="block-row"
            :class="{ active: session.block === null }"
            @click="selectBlock(session, null)"
          >
            Single tile
          </button>
        </li>
        <li
          v-for="(block, index) in doc.blocks"
          :key="index"
        >
          <div
            class="block-row"
            :class="{ active: session.block === index }"
            @click="selectBlock(session, index)"
          >
            <input
              class="block-name"
              type="text"
              spellcheck="false"
              :value="block.name"
              @click.stop
              @change="rename(index, $event)"
            >
            <span class="dims">{{ block.width }}×{{ block.height }}</span>
            <button
              type="button"
              title="Delete block (its tiles stay in the bank)"
              @click.stop="deleteBlock(session, index)"
            >
              ×
            </button>
          </div>
        </li>
      </ul>
      <p
        v-if="blockWarning"
        class="warn"
      >
        {{ blockWarning }}
      </p>
      <div class="new-block">
        <select
          v-model.number="newBlock.width"
          title="Tiles across"
        >
          <option
            v-for="w in MAX_BLOCK"
            :key="w"
            :value="w"
          >
            {{ w }}
          </option>
        </select>
        <span>×</span>
        <select
          v-model.number="newBlock.height"
          title="Tiles down"
        >
          <option
            v-for="h in MAX_BLOCK"
            :key="h"
            :value="h"
          >
            {{ h }}
          </option>
        </select>
        <button
          type="button"
          @click="createNewBlock"
        >
          + Block
        </button>
      </div>

      <h3>Export</h3>
      <template v-if="doc.export">
        <label>
          <span>Table name</span>
          <input
            type="text"
            spellcheck="false"
            :value="doc.export.name"
            @change="patchExport({ name: ($event.target as HTMLInputElement).value })"
          >
        </label>
        <label>
          <span>Output</span>
          <input
            type="text"
            spellcheck="false"
            :value="doc.export.out"
            @change="patchExport({ out: ($event.target as HTMLInputElement).value })"
          >
        </label>
        <label>
          <span>Format</span>
          <select
            :value="doc.export.format"
            @change="patchExport({ format: ($event.target as HTMLSelectElement).value as 'c' | 'bin' })"
          >
            <option value="c">C header</option>
            <option value="bin">Raw binary</option>
          </select>
        </label>
        <label class="inline">
          <input
            type="checkbox"
            :checked="doc.export.helpers === true"
            @change="patchExport({ helpers: ($event.target as HTMLInputElement).checked })"
          >
          <span title="Appends a _DrawBlock() that stamps a block into the name table. Needs msxgl.h included first.">
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
.blurb {
  margin: 0 0 6px;
  font-size: 10px;
  line-height: 1.4;
  color: var(--color-text-muted);
}

.blocks {
  list-style: none;
  margin: 0 0 6px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.block-row {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 2px 4px;
  border: 1px solid transparent;
  border-radius: 3px;
  background: var(--color-bg-hover);
  font-size: 11px;
  text-align: left;
  cursor: pointer;
}

.block-row.active {
  border-color: var(--color-accent);
  background: var(--color-bg-active-item);
}

.block-name {
  flex: 1;
  min-width: 0;
  border: 1px solid transparent;
  border-radius: 2px;
  background: transparent;
  color: var(--color-text);
  font-size: 11px;
}

.block-row .dims {
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

.new-block {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 10px;
  font-size: 11px;
}

.new-block select,
.new-block button {
  padding: 2px 6px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-tab-inactive);
  color: var(--color-text);
  font-size: 11px;
}

.warn {
  margin: 0 0 6px;
  padding: 4px 6px;
  border-radius: 3px;
  background: rgba(230, 160, 30, 0.15);
  font-size: 10px;
  line-height: 1.4;
}

.inline {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--color-text-muted);
}
.side {
  width: 220px;
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
  margin-bottom: 18px;
}

.mode {
  margin: 0 0 6px;
  font-size: 11px;
  color: var(--color-text-muted);
}

.swatches {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 2px;
}

.swatch {
  position: relative;
  height: 22px;
  border: 1px solid var(--color-border);
  border-radius: 2px;
}

.swatch span {
  position: absolute;
  right: 1px;
  bottom: 0;
  font-size: 8px;
  color: rgba(255, 255, 255, 0.75);
  text-shadow: 0 0 2px #000000;
}

.swatch.current {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

.swatch.transparent {
  background-image: linear-gradient(45deg, transparent 45%, #ff6666 45%, #ff6666 55%, transparent 55%);
}

.pickers {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 2px;
  margin-top: 4px;
}

.picker {
  display: block;
  text-align: center;
  font-size: 8px;
  color: var(--color-text-muted);
}

.picker input {
  width: 100%;
  height: 18px;
  padding: 0;
  border: 1px solid var(--color-border);
  background: none;
}

.rowpair {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 2px;
}

.rowpair .label {
  width: 14px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--color-text-muted);
}

.flag-row {
  display: flex;
  gap: 4px;
  margin: 2px 0 4px;
}

.flag-row .flag {
  width: 22px;
  height: 22px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-tab-inactive);
  color: var(--color-text-muted);
  font-size: 10px;
  cursor: pointer;
}

.flag-row .flag.on {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: #fff;
}

.chip {
  width: 34px;
  height: 16px;
  border: 1px solid var(--color-border);
  border-radius: 2px;
}

.swap {
  padding: 0 5px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-hover);
  font-size: 11px;
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

label.inline {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}

label.inline > span:first-child {
  display: inline;
  margin: 0;
}

input[type='text'],
select {
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

.hint {
  margin: 4px 0 0;
  font-size: 10px;
  color: var(--color-text-muted);
}
</style>
