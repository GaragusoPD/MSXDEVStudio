<script setup lang="ts">
/**
 * Palette, gameplay flags, tile size and blocks — everything about the tileset
 * that is not a pixel.
 *
 * The flags are the reason this editor exists rather than a screen being read
 * as a grid: eight bits per tile, meaning entirely the game's to decide, and
 * exported as a table indexed by tile so collision is a lookup.
 */
import { computed, ref } from 'vue'
import Icon from '../../components/Icon.vue'
import BitmapTileAnimation from './BitmapTileAnimation.vue'
import { fromHex, grbToRgb, paletteToRgb, rgbToGrb, toHex } from '../../../../shared/msx/palette'
import { MAX_TILE_SIZE, sc3NameTableCapable } from '../../../../shared/msx/bitmap-tile'
import { BITMAP_MODES, MODES, type BitmapMode } from '../../../../shared/msx/modes'
import { sheetCols } from '../../../../shared/msx/bitmap-tile'
import {
  activeBlock,
  addBlock,
  addBlockFromGrid,
  doc,
  focusCell,
  selectBlock,
  dropBlock,
  renameBlock,
  patchExport,
  setFlagBit,
  setMode,
  setPaletteEntry,
  setTileSize,
  setTransparent,
  setupExport,
  type BitmapTileSession
} from './session'

const props = defineProps<{ session: BitmapTileSession }>()
// The session belongs to the tab, so picking a colour is reported rather than
// written here — same reason the grid emits `select`.
const emit = defineEmits<{ color: [index: number] }>()

const tileset = computed(() => doc(props.session))
/** SCREEN 3: a "pixel" is a 4×4 block, so sizes read in blocks and dots both. */
const blockMode = computed(() => tileset.value.mode === 'sc3')
const rgb = computed(() => paletteToRgb(tileset.value.palette))
const flags = computed(() => tileset.value.flags[props.session.selected] ?? 0)

/** The open block, when there is one — what the cell picker offers to aim the flags at. */
const block = computed(() => activeBlock(props.session))

const tileW = ref(0)
const tileH = ref(0)
const blockW = ref(2)
const blockH = ref(2)

/** A picked colour, snapped to the V9938's 3 bits per channel. */
function pickColor(index: number, hex: string): void {
  setPaletteEntry(props.session, index, rgbToGrb(fromHex(hex)))
}

/** The marquee, described for the button that would keep it. */
const marquee = computed(() => props.session.selection)

function keepSelection(): void {
  addBlockFromGrid(props.session, sheetCols(tileset.value))
}

/** Auto-named like the pattern tile editor's; rename it in the list above. */
function newBlock(): void {
  addBlock(props.session, `block_${tileset.value.blocks.length}`, blockW.value, blockH.value)
}

function applySize(): void {
  const w = tileW.value || tileset.value.width
  const h = tileH.value || tileset.value.height
  setTileSize(props.session, w, h)
  tileW.value = 0
  tileH.value = 0
}
</script>

<template>
  <div class="panel">
    <section>
      <h3>Palette</h3>
      <div
        v-if="tileset.palette"
        class="swatches"
      >
        <button
          v-for="(_entry, index) in tileset.palette"
          :key="index"
          class="swatch"
          :class="{ on: session.color === index }"
          :style="{ background: `rgb(${rgb[index]?.r ?? 0},${rgb[index]?.g ?? 0},${rgb[index]?.b ?? 0})` }"
          :title="`${index}: ${toHex(rgb[index] ?? { r: 0, g: 0, b: 0 })}`"
          @click="emit('color', index)"
        />
      </div>
      <p
        v-else
        class="hint"
      >
        This mode has a fixed palette.
      </p>
      <label
        v-if="tileset.palette"
        class="row"
        :title="`Entry ${session.color} — snapped to the V9938's three bits per channel`"
      >
        <span>Entry {{ session.color }}</span>
        <input
          type="color"
          :value="toHex(grbToRgb(tileset.palette[session.color] ?? 0))"
          @input="pickColor(session.color, ($event.target as HTMLInputElement).value)"
        >
      </label>
    </section>

    <section>
      <h3>Mode</h3>
      <label class="row">
        <span>Screen</span>
        <select
          :value="tileset.mode"
          @change="setMode(session, ($event.target as HTMLSelectElement).value as BitmapMode)"
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
      <p
        v-if="blockMode"
        class="hint"
      >
        A pixel here is one 4×4 block, so {{ tileset.width }}×{{ tileset.height }} is
        {{ tileset.width * 4 }}×{{ tileset.height * 4 }} dots.
        <template v-if="sc3NameTableCapable(tileset)">
          At 2×2 each tile is one name-table entry, so a map over this set is drawn by the
          VDP — 768 bytes a screen, and it can scroll.
        </template>
        <template v-else>
          Bigger than a name-table entry, so maps over this set are blitted into the shadow
          buffer. Use 2×2 if it needs to scroll.
        </template>
      </p>
    </section>

    <section v-if="blockMode">
      <h3>Transparent colour</h3>
      <p class="hint">
        The index a masked blit leaves alone. Set one to use this bank as software sprites —
        tiles are frames, and a 1×N block is an animation.
      </p>
      <label class="row">
        <span>Index</span>
        <select
          :value="tileset.transparent === null ? '' : String(tileset.transparent)"
          @change="setTransparent(session, ($event.target as HTMLSelectElement).value === ''
            ? null
            : Number(($event.target as HTMLSelectElement).value))"
        >
          <option value="">
            None — opaque tiles
          </option>
          <option
            v-for="index in 16"
            :key="index - 1"
            :value="String(index - 1)"
          >
            {{ index - 1 }}
          </option>
        </select>
      </label>
    </section>

    <section>
      <h3>Flags — tile {{ session.selected }}</h3>
      <p class="hint">
        Eight bits, meaning is yours. Exported as <code>_Flags</code>, indexed by tile.
      </p>
      <!-- ponytail: cells shrink to fit; a scrollable mini-map if blocks past ~16 wide become normal -->
      <div
        v-if="block"
        class="cells"
        :style="{ gridTemplateColumns: `repeat(${block.width}, minmax(0, 1fr))` }"
      >
        <button
          v-for="(tile, i) in block.tiles"
          :key="i"
          class="cell"
          :class="{ on: tile === session.selected }"
          :title="`tile ${tile}`"
          @click="focusCell(session, tile)"
        >
          {{ tile }}
        </button>
      </div>
      <div class="flags">
        <label
          v-for="bit in 8"
          :key="bit"
          class="flag"
        >
          <input
            type="checkbox"
            :checked="(flags & (1 << (bit - 1))) !== 0"
            @change="setFlagBit(session, bit - 1, ($event.target as HTMLInputElement).checked)"
          >
          <span>{{ bit }}</span>
        </label>
      </div>
      <p class="hint">
        Byte: 0x{{ flags.toString(16).padStart(2, '0') }}
      </p>
    </section>

    <section>
      <h3>Tile size</h3>
      <p class="hint">
        Currently {{ tileset.width }}×{{ tileset.height }}. Resizing crops; it does not scale.
      </p>
      <div class="row">
        <input
          v-model.number="tileW"
          type="number"
          min="1"
          :max="MAX_TILE_SIZE"
          :placeholder="String(tileset.width)"
        >
        <span>×</span>
        <input
          v-model.number="tileH"
          type="number"
          min="1"
          :max="MAX_TILE_SIZE"
          :placeholder="String(tileset.height)"
        >
        <button @click="applySize">
          Apply
        </button>
      </div>
    </section>

    <section>
      <h3>{{ blockMode ? 'Blocks and animations' : 'Blocks' }}</h3>
      <p class="hint">
        Named groups of tiles — a door, a tree. Drag across the bank to select a
        rectangle, then keep it. Open one to draw across it as a single picture:
        a block owns no pixels, only references, so painting it paints the tiles
        it points at — everywhere else they are used.
      </p>
      <p
        v-if="blockMode"
        class="hint"
      >
        <strong>A 1×N block is an animation.</strong> Draw each pose as its own tile, drag
        across that run in the bank, and keep it as a block named <code>walk</code> — the
        export gives the game <code>..._WALK_BASE</code> and <code>..._WALK_W</code>, and the
        player below shows whether the cycle reads. With a transparent colour set above, this
        bank <em>is</em> a SCREEN 3 software-sprite sheet: tiles are frames, and
        <code>_DrawTileMasked()</code> puts one over the playfield.
      </p>
      <ul class="blocks">
        <li>
          <!-- "Single tile", not "Selection": closing a block here goes back to the one
               picked tile, since a bitmap marquee is never itself a canvas. -->
          <button
            class="block-row"
            :class="{ active: session.block === null }"
            @click="selectBlock(session, null)"
          >
            Single tile
          </button>
        </li>
        <li
          v-for="(entry, index) in tileset.blocks"
          :key="index"
          class="block-row"
          :class="{ active: session.block === index }"
          @click="selectBlock(session, index)"
        >
          <!-- The whole row opens the block, so the name needs no click of its own —
               and Enter on it is the keyboard path the caret button used to be. -->
          <input
            class="block-name"
            spellcheck="false"
            :value="entry.name"
            @change="renameBlock(session, index, ($event.target as HTMLInputElement).value)"
            @keydown.enter="selectBlock(session, index)"
          >
          <span class="dim">{{ entry.width }}×{{ entry.height }}</span>
          <button
            title="Remove"
            @click.stop="dropBlock(session, index)"
          >
            <Icon
              name="delete"
              :size="14"
            />
          </button>
        </li>
      </ul>
      <!-- A 1xN block is a sequence of poses — the idiom `agent-guide.ts` already
           documents. A grid of frames cannot show whether a walk cycle reads. -->
      <BitmapTileAnimation
        v-if="block && block.tiles.length > 1"
        :key="session.block ?? -1"
        :tileset="tileset"
        :block="block"
      />
      <button
        class="wide"
        :disabled="!marquee"
        @click="keepSelection"
      >
        {{ marquee ? `Keep ${marquee.width}×${marquee.height} selection as a block` : 'Drag the bank to select tiles' }}
      </button>
      <div class="row">
        <span class="dim">empty</span>
        <input
          v-model.number="blockW"
          type="number"
          min="1"
          max="16"
        >
        <span>×</span>
        <input
          v-model.number="blockH"
          type="number"
          min="1"
          max="16"
        >
        <button @click="newBlock">
          Add
        </button>
      </div>
    </section>

    <section>
      <h3>Export</h3>
      <template v-if="tileset.export">
        <label class="field">
          <span>Table name</span>
          <input
            type="text"
            spellcheck="false"
            :value="tileset.export.name"
            @change="patchExport(session, { name: ($event.target as HTMLInputElement).value })"
          >
        </label>
        <label class="field">
          <span>Output</span>
          <input
            type="text"
            spellcheck="false"
            :value="tileset.export.out"
            @change="patchExport(session, { out: ($event.target as HTMLInputElement).value })"
          >
        </label>
        <label class="field">
          <span>Format</span>
          <select
            :value="tileset.export.format"
            @change="patchExport(session, { format: ($event.target as HTMLSelectElement).value as 'c' | 'bin' })"
          >
            <option value="c">C header</option>
            <option value="bin">Raw binary</option>
          </select>
        </label>
        <label class="flag">
          <input
            type="checkbox"
            :checked="tileset.export.helpers === true"
            @change="patchExport(session, { helpers: ($event.target as HTMLInputElement).checked })"
          >
          <span title="Adds _Upload() and _Draw(), which blit a tile from the sheet. Needs msxgl.h included first.">
            Ready-made C
          </span>
        </label>
      </template>
      <button
        v-else
        class="wide"
        @click="setupExport(session)"
      >
        Set an export target
      </button>
    </section>
  </div>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 10px;
  overflow-y: auto;
  /* Fixed, like the bank: whatever is left over belongs to the tile. */
  flex: 0 0 196px;
  width: 196px;
}
h3 {
  margin: 0 0 6px;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.75;
}
.hint {
  margin: 4px 0;
  font-size: 11px;
  opacity: 0.6;
}
.swatches {
  display: grid;
  /* Sixteen chips in two rows. The index lives in the tooltip — printing it in
     the swatch is what forced them big enough to read. */
  grid-template-columns: repeat(8, 18px);
  gap: 2px;
}
.swatch {
  width: 18px;
  height: 18px;
  border: 1px solid var(--color-border);
  cursor: pointer;
  padding: 0;
}
.swatch.on {
  outline: 2px solid var(--color-accent);
}
/* A block is up to 255 tiles per axis, and a marquee across the bank is easily 16
   wide, so the columns come from the block (inline, since the count is dynamic)
   and the cells shrink into whatever the 196px panel has left. The index label
   clips at that point; the tooltip and the heading carry the truth. */
.cells {
  display: grid;
  gap: 2px;
  margin: 4px 0;
  max-height: 120px;
  overflow-y: auto;
}
.cell {
  aspect-ratio: 1;
  overflow: hidden;
  padding: 0;
  border: 1px solid var(--color-border);
  background: var(--color-bg-tab-inactive);
  color: var(--color-text-muted);
  font-size: 9px;
  cursor: pointer;
}
.cell.on {
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: #fff;
}
.flags {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 4px;
}
.flag {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
}
.row {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 6px;
}
.row input {
  flex: 1;
  min-width: 3.5em;
}
.wide {
  width: 100%;
  margin-top: 6px;
}
.blocks {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
/* Same shape as the pattern tile editor's list, down to the class names: the two
   editors open a block the same way, so they should not look like two ideas. */
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
.block-row button {
  display: flex;
  padding: 0 3px;
  color: var(--color-text-muted);
}
.dim {
  opacity: 0.6;
  font-size: 11px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 6px;
  font-size: 11px;
}
.field input,
.field select {
  width: 100%;
  min-width: 0;
}
</style>
