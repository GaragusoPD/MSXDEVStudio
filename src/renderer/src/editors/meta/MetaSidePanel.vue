<script setup lang="ts">
/**
 * The meta-tile editor's right pane: the tileset reference (and the tile-0
 * reservation the whole feature rests on), the meta's size in tiles, its eight
 * gameplay flags, the palette, how full the bank is, and the export block.
 */
import { computed } from 'vue'
import { MSX1_PALETTE_GRB, paletteToRgb, toHex } from '../../../../shared/msx/palette'
import { MAX_META_SIZE, META_FLAG_COUNT } from '../../../../shared/msx/meta-tile'
import { MAX_TILES, colorByteAt, splitColorByte } from '../../../../shared/msx/tile'
import { defaultExport, type ExportBlock, type ResourceKind } from '../../../../shared/msx/resource'
import { useResourcesStore } from '../../stores/resourcesStore'
import {
  bitmapTiles,
  commit,
  compact,
  doc,
  frameTileAt,
  reserveBitmapTile0,
  reserveTile0,
  resize,
  setColor,
  setGroupPair,
  setTileset,
  tileUsage,
  tiles,
  toggleFlag,
  type MetaSession
} from './session'

const props = defineProps<{ session: MetaSession }>()
const resourcesStore = useResourcesStore()

const meta = computed(() => doc(props.session))
const tileset = computed(() => tiles(props.session))
const usage = computed(() => tileUsage(props.session))

/** A pattern meta groups a `.tiles.json`; a bitmap one groups the bitmap forms. */
const TILESET_KINDS = computed<ResourceKind[]>(() =>
  props.session.kind === 'metatiles' ? ['tiles'] : ['btiles', 'screen']
)
const tilesetOptions = computed(() =>
  resourcesStore.entries.filter((entry) => TILESET_KINDS.value.includes(entry.kind)).map((entry) => entry.path)
)

const bitmap = computed(() => bitmapTiles(props.session))
const rgb = computed(() => paletteToRgb(bitmap.value?.palette ?? tileset.value?.palette ?? null))

/** Whichever tileset this meta references needs tile 0 reserved before it can be see-through. */
const needsReserve = computed(() => {
  if (bitmap.value) return !bitmap.value.reserveTile0
  return tileset.value ? !tileset.value.reserveTile0 : false
})

const sc1 = computed(() => tileset.value?.mode === 'sc1')

/** In SCREEN 1, the pair in force for the cell the last stroke touched. */
const groupPair = computed(() => {
  const doc0 = tileset.value
  if (!doc0 || !sc1.value) return null
  const tile = frameTileAt(meta.value, props.session.frame, props.session.activeCell.x, props.session.activeCell.y)
  return { group: tile >> 3, ...splitColorByte(colorByteAt(doc0, tile, 0)) }
})

/**
 * The colours the palette offers.
 *
 * In SCREEN 1 that is only the two the *active cell's* group already spends —
 * every pixel of all eight tiles in a group shares one pair, so offering the
 * other fourteen would just produce dropped pixels. Elsewhere it is all
 * sixteen, and the row's own two-colour rule is enforced per stroke.
 */
const palette = computed<number[]>(() => {
  // Every pixel carries its own colour in a bitmap mode, so all sixteen are on
  // offer and nothing can be refused.
  if (bitmap.value) return Array.from({ length: MSX1_PALETTE_GRB.length }, (_, i) => i)
  const doc0 = tileset.value
  if (!doc0) return []
  if (!sc1.value) return Array.from({ length: MSX1_PALETTE_GRB.length }, (_, i) => i)
  const pair = groupPair.value
  // 0 is always offered: it is how a cell is erased back to transparent.
  return pair ? [...new Set([0, pair.bg, pair.fg])] : [0]
})

const ALL_COLORS = Array.from({ length: MSX1_PALETTE_GRB.length }, (_, i) => i)

function changePair(fg: number, bg: number): void {
  const pair = groupPair.value
  if (!pair) return
  if (!window.confirm(`Recolour group ${pair.group}? All 8 tiles in it change, wherever else they are used.`)) return
  setGroupPair(props.session, fg, bg)
}

function patchExport(patch: Partial<ExportBlock>): void {
  const current = meta.value.export
  if (!current) return
  commit(props.session, { ...meta.value, export: { ...current, ...patch } })
}

function setupExport(): void {
  commit(props.session, { ...meta.value, export: defaultExport(props.session.path) })
}
</script>

<template>
  <div class="side-panel">
    <section>
      <h3>Tileset</h3>
      <select
        :value="meta.tileset"
        @change="setTileset(session, ($event.target as HTMLSelectElement).value)"
      >
        <option value="">
          (none)
        </option>
        <option
          v-for="path in tilesetOptions"
          :key="path"
          :value="path"
        >
          {{ path }}
        </option>
      </select>
      <p
        v-if="session.tilesetError"
        class="hint warn"
      >
        {{ session.tilesetError }}
      </p>
      <template v-if="needsReserve">
        <p class="hint warn">
          You can draw, but this meta-tile will be <strong>opaque</strong>: the tileset has not
          reserved tile 0, so there is no index that means "skip this cell". Reserving it shifts
          every tile up by one and renumbers the maps drawn with this tileset.
        </p>
        <button
          type="button"
          class="wide"
          @click="bitmap ? reserveBitmapTile0(session) : reserveTile0(session)"
        >
          Reserve tile 0
        </button>
      </template>
      <p
        v-else-if="bitmap"
        class="hint"
      >
        {{
          bitmap.transparent === 0
            ? 'Colour 0 is see-through inside a cell too — the VDP skips it, so silhouettes can be any shape.'
            : bitmap.transparent === null
              ? 'Cells holding tile 0 are skipped. This tileset nominates no transparent colour, so the cells that are drawn are solid rectangles.'
              : `Cells holding tile 0 are skipped. Per-pixel transparency is off: the VDP only ever skips colour 0, and this tileset nominates ${bitmap.transparent}.`
        }}
      </p>
    </section>

    <section>
      <h3>Size</h3>
      <div class="size-row">
        <label>
          <span>W</span>
          <input
            type="number"
            min="1"
            :max="MAX_META_SIZE"
            :value="meta.width"
            @change="resize(session, Number(($event.target as HTMLInputElement).value), meta.height)"
          >
        </label>
        <label>
          <span>H</span>
          <input
            type="number"
            min="1"
            :max="MAX_META_SIZE"
            :value="meta.height"
            @change="resize(session, meta.width, Number(($event.target as HTMLInputElement).value))"
          >
        </label>
      </div>
      <p class="hint">
        {{ meta.width * 8 }}×{{ meta.height * 8 }} dots, {{ meta.width * meta.height }} tiles per frame.
      </p>
    </section>

    <section v-if="palette.length">
      <h3>Colour</h3>
      <div class="swatches">
        <button
          v-for="index in palette"
          :key="index"
          class="swatch"
          :class="{ active: index === session.color, transparent: index === 0 }"
          :style="index === 0 ? undefined : { background: toHex(rgb[index]) }"
          :title="index === 0 ? 'Transparent' : `Colour ${index}`"
          @click="setColor(session, index)"
        />
      </div>
      <p
        v-if="!bitmap"
        class="hint"
      >
        <strong>Left</strong> button paints the ink of the row you click,
        <strong>right</strong> its paper — {{ sc1 ? 'for the whole group of 8 tiles' : 'for that 8-pixel row' }}.
        That is the mode's two-colours rule, so a third colour replaces one of them rather than
        being refused.
      </p>
      <template v-if="groupPair">
        <p class="hint">
          SCREEN 1 shares one colour pair across every group of 8 tiles. The cell at
          {{ session.activeCell.x }},{{ session.activeCell.y }} is in group
          <strong>{{ groupPair.group }}</strong>, so only its pair is on offer.
        </p>
        <div class="pair">
          <label>
            <span>Ink</span>
            <select
              :value="groupPair.fg"
              @change="changePair(Number(($event.target as HTMLSelectElement).value), groupPair.bg)"
            >
              <option
                v-for="index in ALL_COLORS"
                :key="index"
                :value="index"
              >
                {{ index }}
              </option>
            </select>
          </label>
          <label>
            <span>Paper</span>
            <select
              :value="groupPair.bg"
              @change="changePair(groupPair.fg, Number(($event.target as HTMLSelectElement).value))"
            >
              <option
                v-for="index in ALL_COLORS"
                :key="index"
                :value="index"
              >
                {{ index }}
              </option>
            </select>
          </label>
        </div>
      </template>
    </section>

    <section>
      <h3>Flags</h3>
      <p class="hint">
        Eight bits describing what this meta-tile <em>means</em> to the game. Exported as
        <code>_FLAGS</code>, and mirrored into the placement table of any map that places it.
      </p>
      <div class="flags">
        <label
          v-for="bit in META_FLAG_COUNT"
          :key="bit"
          class="inline"
        >
          <input
            type="checkbox"
            :checked="(meta.flags & (1 << (bit - 1))) !== 0"
            @change="toggleFlag(session, bit - 1)"
          >
          <span>{{ bit }}</span>
        </label>
      </div>
    </section>

    <section v-if="tileset">
      <h3>Tiles</h3>
      <p class="hint">
        This meta uses {{ usage.used }} tile{{ usage.used === 1 ? '' : 's' }}; the bank holds
        {{ usage.total }} of {{ MAX_TILES }}.
      </p>
      <p
        v-if="usage.orphans"
        class="hint"
      >
        {{ usage.orphans }} tile{{ usage.orphans === 1 ? '' : 's' }} created in this session are no
        longer used — undo leaves them behind.
      </p>
      <button
        type="button"
        class="wide"
        :disabled="!usage.orphans"
        @click="compact(session)"
      >
        Compact unused tiles
      </button>
    </section>

    <section>
      <h3>Export</h3>
      <template v-if="meta.export">
        <label>
          <span>Table name</span>
          <input
            type="text"
            spellcheck="false"
            :value="meta.export.name"
            @change="patchExport({ name: ($event.target as HTMLInputElement).value })"
          >
        </label>
        <label>
          <span>Output</span>
          <input
            type="text"
            spellcheck="false"
            :value="meta.export.out"
            @change="patchExport({ out: ($event.target as HTMLInputElement).value })"
          >
        </label>
        <label>
          <span>Format</span>
          <select
            :value="meta.export.format"
            @change="patchExport({ format: ($event.target as HTMLSelectElement).value as 'c' | 'bin' })"
          >
            <option value="c">C header</option>
            <option value="bin">Raw binary</option>
          </select>
        </label>
        <label class="inline">
          <input
            type="checkbox"
            :checked="meta.export.helpers === true"
            @change="patchExport({ helpers: ($event.target as HTMLInputElement).checked })"
          >
          <span title="Appends a _Draw() that stamps one frame, skipping transparent cells. Needs msxgl.h included first.">
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
.side-panel {
  width: 260px;
  padding: 12px;
  overflow-y: auto;
  border-left: 1px solid var(--border, #333);
}

section {
  margin-bottom: 18px;
}

h3 {
  margin: 0 0 6px;
  font-size: 12px;
  text-transform: uppercase;
  opacity: 0.7;
}

label {
  display: block;
  margin-bottom: 6px;
  font-size: 12px;
}

label.inline {
  display: flex;
  align-items: center;
  gap: 4px;
}

select,
input[type='text'] {
  width: 100%;
}

.size-row {
  display: flex;
  gap: 8px;
}

.size-row label {
  display: flex;
  align-items: center;
  gap: 4px;
}

.size-row input {
  width: 56px;
}

.pair {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}

.pair label {
  display: flex;
  align-items: center;
  gap: 4px;
}

.pair select {
  width: 60px;
}

.swatches {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
}

.swatch {
  width: 22px;
  height: 22px;
  border: 1px solid var(--border, #555);
  border-radius: 2px;
  cursor: pointer;
}

.swatch.active {
  outline: 2px solid #ffd24e;
}

/* The checker marks index 0 as a hole rather than as a colour. */
.swatch.transparent {
  background:
    linear-gradient(45deg, #3a3a3a 25%, transparent 25%, transparent 75%, #3a3a3a 75%) 0 0 / 8px 8px,
    linear-gradient(45deg, #3a3a3a 25%, #4a4a4a 25%, #4a4a4a 75%, #3a3a3a 75%) 4px 4px / 8px 8px;
}

.flags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.hint {
  margin: 6px 0 0;
  font-size: 11px;
  opacity: 0.75;
}

.hint.warn {
  color: #ffb454;
  opacity: 1;
}

.wide {
  width: 100%;
  margin-top: 6px;
}
</style>
