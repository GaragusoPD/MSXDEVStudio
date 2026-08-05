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
import { paletteToRgb, toHex } from '../../../../shared/msx/palette'
import { MAX_TILE_SIZE } from '../../../../shared/msx/bitmap-tile'
import { sheetCols } from '../../../../shared/msx/bitmap-tile'
import {
  addBlock,
  addBlockFromGrid,
  doc,
  dropBlock,
  renameBlock,
  setFlagBit,
  setPaletteEntry,
  setTileSize,
  type BitmapTileSession
} from './session'

const props = defineProps<{ session: BitmapTileSession }>()
// The session belongs to the tab, so picking a colour is reported rather than
// written here — same reason the grid emits `select`.
const emit = defineEmits<{ color: [index: number] }>()

const tileset = computed(() => doc(props.session))
const rgb = computed(() => paletteToRgb(tileset.value.palette))
const flags = computed(() => tileset.value.flags[props.session.selected] ?? 0)

const tileW = ref(0)
const tileH = ref(0)
const blockW = ref(2)
const blockH = ref(2)

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
        >
          <span>{{ index }}</span>
        </button>
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
      >
        <span>Entry {{ session.color }}</span>
        <input
          type="number"
          min="0"
          max="1911"
          :value="tileset.palette[session.color] ?? 0"
          @change="setPaletteEntry(session, session.color, Number(($event.target as HTMLInputElement).value))"
        >
      </label>
    </section>

    <section>
      <h3>Flags — tile {{ session.selected }}</h3>
      <p class="hint">
        Eight bits, meaning is yours. Exported as <code>_Flags</code>, indexed by tile.
      </p>
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
      <h3>Blocks</h3>
      <p class="hint">
        Named groups of tiles — a door, a tree. They own no pixels, only
        references. Drag across the bank to select a rectangle, then keep it;
        rename it in the list.
      </p>
      <ul class="blocks">
        <li
          v-for="(block, index) in tileset.blocks"
          :key="index"
        >
          <input
            :value="block.name"
            @change="renameBlock(session, index, ($event.target as HTMLInputElement).value)"
          >
          <span class="dim">{{ block.width }}×{{ block.height }}</span>
          <button
            title="Remove"
            @click="dropBlock(session, index)"
          >
            ×
          </button>
        </li>
      </ul>
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
  </div>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 10px;
  overflow-y: auto;
  min-width: 220px;
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
  grid-template-columns: repeat(8, 1fr);
  gap: 2px;
}
.swatch {
  aspect-ratio: 1;
  border: 1px solid var(--border, #333);
  cursor: pointer;
  font-size: 9px;
  color: #fff;
  text-shadow: 0 0 2px #000;
  padding: 0;
}
.swatch.on {
  outline: 2px solid #4ea1ff;
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
.blocks li {
  display: flex;
  align-items: center;
  gap: 4px;
}
.blocks input {
  flex: 1;
  min-width: 4em;
}
.dim {
  opacity: 0.6;
  font-size: 11px;
}
</style>
