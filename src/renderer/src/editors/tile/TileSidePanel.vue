<script setup lang="ts">
/**
 * Spec 08's right pane: the 16-color palette (fixed TMS9918A, or an editable
 * GRB333 picker on sc4 that snaps to the V9938's 512 colors), the per-row
 * FG/BG strip, the multi-tile blocks, and the export block Spec 07's
 * converter reads.
 */
import { computed, ref } from 'vue'
import Icon from '../../components/Icon.vue'
import { MODES, TILE_MODES, type TileMode } from '../../../../shared/msx/modes'
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
import { BANK_COUNT, isBanked, MAX_BLOCK, TILE_FLAG_COUNT } from '../../../../shared/msx/tile'
import { splitColorByte, TILE_SIZE } from '../../../../shared/msx/tile'
import { blockColorGroupWarning, renameBlock } from '../../../../shared/tile-editor'
import {
  activeBlock,
  addBlock,
  bankBudgetLabel,
  changeMode,
  commit,
  deleteBlock,
  focusCell,
  nameSelection,
  selectBlock,
  setBlockWide,
  setColor,
  setPalette,
  setRow,
  swapRow,
  tileColorByte,
  toggleFlag,
  type TileSession
} from './session'

const props = defineProps<{ session: TileSession }>()

const doc = computed(() => props.session.doc)
const rgb = computed(() => paletteToRgb(doc.value.palette))
const programmable = computed(() => doc.value.mode === 'sc4')
/** Once any bank has overrides, the row strip and Blocks section follow the same view the grid does. */
const banked = computed(() => isBanked(doc.value))
/**
 * What the canvas is editing when it isn't a single tile — a named block, or
 * the grid marquee acting as one. Named apart from the block list's own `block`
 * rows, which shadow it inside their `v-for`.
 */
const canvasBlock = computed(() => activeBlock(props.session))
const rows = computed(() =>
  Array.from({ length: TILE_SIZE }, (_, y) => ({ y, ...splitColorByte(tileColorByte(props.session, props.session.active, y)) }))
)

/** sc1 shares one pair per group of 8 tiles, so the strip collapses to a single row. */
const strip = computed(() => (doc.value.mode === 'sc1' ? rows.value.slice(0, 1) : rows.value))

/** In a block the strip edits one of its cells, so the heading has to say which. */
const stripHeading = computed(() => {
  const base = doc.value.mode === 'sc1' ? `Group ${props.session.active >> 3} colors` : 'Row colors'
  return canvasBlock.value ? `${base} — tile ${props.session.active}` : base
})

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

/** The unnamed marquee, when that's what the canvas is showing — what "from selection" would name. */
const marquee = computed(() => (props.session.block === null ? activeBlock(props.session) : null))

/** sc1 shares one FG/BG per 8 tiles, so a multi-tile canvas can recolour its neighbours — named or not. */
const blockWarning = computed(() => (canvasBlock.value ? blockColorGroupWarning(doc.value, canvasBlock.value) : null))

function switchMode(mode: TileMode): void {
  if (changeMode(props.session, mode)) return
  // SCREEN 1 has one pattern table, not three, so a banked (or shared-region)
  // doc loses more than colour on the way there: `tileModeConversionLossy`
  // refuses the plain conversion for exactly this doc precisely because every
  // bank override and the whole meta-tile reservation would simply vanish,
  // not just get recoloured — the confirmation has to say that, not the
  // colour-only story every other tileset gets.
  const message =
    banked.value || doc.value.sharedTiles > 0
      ? 'SCREEN 1 has one pattern table, not three: every bank override and the whole shared meta-tile reservation would be lost — not just recoloured. Continue?'
      : 'SCREEN 1 gives one FG/BG pair per group of 8 tiles. Converting keeps the first tile of each group’s top row and drops the rest. Continue?'
  if (window.confirm(message)) {
    changeMode(props.session, mode, true)
  }
}

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

    <section v-if="banked">
      <h3>Banks</h3>
      <p class="hint">
        SCREEN 2/4's three pattern banks, each 256 tiles. A bank's own art plus the shared
        (meta-tile) reservation both cost every bank the same room — this is what decides
        whether the next stroke has anywhere to go, before it hits the wall.
      </p>
      <ul class="bank-budgets">
        <li
          v-for="b in BANK_COUNT"
          :key="b"
        >
          {{ bankBudgetLabel(doc, b - 1) }}
        </li>
      </ul>
    </section>

    <section>
      <h3>{{ stripHeading }}</h3>
      <template v-if="canvasBlock">
        <!-- ponytail: cells shrink to fit; a scrollable mini-map if blocks past ~16 wide become normal -->
        <div
          class="cells"
          :style="{ gridTemplateColumns: `repeat(${canvasBlock.width}, minmax(0, 1fr))` }"
        >
          <button
            v-for="(tile, i) in canvasBlock.tiles"
            :key="i"
            type="button"
            class="cell"
            :class="{ on: tile === session.active }"
            :title="`tile ${tile}`"
            @click="focusCell(session, tile)"
          >
            {{ tile }}
          </button>
        </div>
        <label class="inline">
          <input
            type="checkbox"
            :checked="session.blockWide"
            @change="setBlockWide(session, ($event.target as HTMLInputElement).checked)"
          >
          <span title="A chip or a swap writes that row on every tile of the block, in one undo step. In sc1 the pair belongs to the group of eight, so it can reach further — see the warning under Blocks.">
            Whole block
          </span>
        </label>
      </template>
      <p class="hint">
        Click a chip to choose that role's color.
      </p>
      <div
        v-for="row in strip"
        :key="row.y"
        class="rowpair"
      >
        <span class="label">{{ doc.mode === 'sc1' ? `${session.active >> 3}` : row.y }}</span>
        <span
          class="chip"
          :style="{ background: toHex(rgb[row.fg]) }"
          :title="`Foreground: ${row.fg} — ${grbLabel(row.fg)}`"
        >
          <select
            :value="row.fg"
            @change="setRow(session, row.y, Number(($event.target as HTMLSelectElement).value), row.bg)"
          >
            <option
              v-for="(color, index) in rgb"
              :key="index"
              :value="index"
              :style="{ background: toHex(color) }"
            >
              {{ index }} — {{ grbLabel(index) }}
            </option>
          </select>
        </span>
        <span
          class="chip"
          :style="{ background: toHex(rgb[row.bg]) }"
          :title="`Background: ${row.bg} — ${grbLabel(row.bg)}`"
        >
          <select
            :value="row.bg"
            @change="setRow(session, row.y, row.fg, Number(($event.target as HTMLSelectElement).value))"
          >
            <option
              v-for="(color, index) in rgb"
              :key="index"
              :value="index"
              :style="{ background: toHex(color) }"
            >
              {{ index }} — {{ grbLabel(index) }}
            </option>
          </select>
        </span>
        <button
          type="button"
          class="swap"
          title="Swap FG and BG (the pattern is inverted so the tile looks the same)"
          @click="swapRow(session, row.y)"
        >
          <Icon
            name="swap_horiz"
            :size="14"
          />
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

      <h3>Mode</h3>
      <select
        class="mode-pick"
        :value="doc.mode"
        title="Colour model — converting to SCREEN 1 is lossy"
        @change="switchMode(($event.target as HTMLSelectElement).value as TileMode)"
      >
        <option
          v-for="id in TILE_MODES"
          :key="id"
          :value="id"
        >
          {{ MODES[id].label }}
        </option>
      </select>
      <p class="blurb">
        These are the pattern modes: a tile is 8×8 one-bit pixels plus colour attributes.
        <strong>SCREEN 3 is not one of them</strong> — its tile is a grid of 4×4 colour blocks
        with no attributes at all, so it lives in a bitmap tileset
        (<code>.btiles.json</code>) instead. Create one from the Resources panel and pick
        SCREEN 3 there.
      </p>

      <h3>Blocks</h3>
      <p class="blurb">
        Any rectangle you drag in the grid is already one canvas. Name it here to keep it — a block
        is that selection, stored as the tiles it is made of, and exported with them.
      </p>
      <ul class="blocks">
        <li>
          <button
            type="button"
            class="block-row"
            :class="{ active: session.block === null }"
            @click="selectBlock(session, null)"
          >
            Selection
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
              @keydown.enter="selectBlock(session, index)"
              @change="rename(index, $event)"
            >
            <span class="dims">{{ block.width }}×{{ block.height }}</span>
            <button
              type="button"
              title="Delete block (its tiles stay in the bank)"
              @click.stop="deleteBlock(session, index)"
            >
              <Icon
                name="delete"
                :size="14"
              />
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
        <input
          v-model.number="newBlock.width"
          type="number"
          min="1"
          :max="MAX_BLOCK"
          title="Tiles across"
        >
        <span>×</span>
        <input
          v-model.number="newBlock.height"
          type="number"
          min="1"
          :max="MAX_BLOCK"
          title="Tiles down"
        >
        <button
          type="button"
          :disabled="banked"
          :title="
            banked
              ? `Blocks reference the common tileset, which a bank view doesn't show — not available here`
              : 'Append that many blank tiles as a new block'
          "
          @click="createNewBlock"
        >
          + Block
        </button>
      </div>
      <button
        type="button"
        class="from-selection"
        :disabled="!marquee"
        :title="
          marquee
            ? `Name the ${marquee.width}×${marquee.height} selection as a block — the tiles stay where they are`
            : banked
              ? `Blocks reference the common tileset, which a bank view doesn't show — not available here`
              : 'Drag a rectangle in the grid first'
        "
        @click="nameSelection(session)"
      >
        + Block from selection
      </button>

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
.mode-pick {
  width: 100%;
  margin-bottom: 10px;
  padding: 2px 4px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-tab-inactive);
  color: var(--color-text);
  font-size: 11px;
}

.blurb {
  margin: 0 0 6px;
  font-size: 10px;
  line-height: 1.4;
  color: var(--color-text-muted);
}

.bank-budgets {
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--color-text-muted);
}

.bank-budgets li {
  padding: 1px 0;
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

.block-row button {
  display: flex;
  padding: 0 3px;
  color: var(--color-text-muted);
}

.new-block {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 6px;
  font-size: 11px;
}

.from-selection {
  width: 100%;
  padding: 3px 6px;
  margin-bottom: 10px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-tab-inactive);
  color: var(--color-text);
  font-size: 11px;
}

.from-selection:disabled {
  opacity: 0.4;
}

.new-block input,
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

/* One button per cell of the open block. The column count is the block's, so it
   lives in an inline `:style`; a 32-wide marquee then shrinks its cells rather
   than running off the 220px sidebar. */
.cells {
  display: grid;
  gap: 2px;
  max-height: 120px;
  margin-bottom: 4px;
  overflow-y: auto;
}

.cells .cell {
  aspect-ratio: 1;
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: 2px;
  background: var(--color-bg-tab-inactive);
  color: var(--color-text-muted);
  font-size: 9px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

/* The same amber the canvas outlines the targeted cell with. */
.cells .cell.on {
  border-color: #ffd24e;
  background: var(--color-bg-active-item);
  color: var(--color-text);
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

/* The swatch *is* the picker: a transparent native select lies over it, so
   clicking the colour opens the sixteen entries rather than assigning whichever
   one the palette above happened to have selected. Same mechanism as the sprite
   editor's line colours, and it keeps the keyboard and the tinted option list
   for free. */
.chip {
  position: relative;
  width: 34px;
  height: 16px;
  border: 1px solid var(--color-border);
  border-radius: 2px;
}

.chip:focus-within {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

.chip select {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  padding: 0;
  border: none;
  opacity: 0;
  cursor: pointer;
}

.swap {
  display: flex;
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
