<script setup lang="ts">
/**
 * The bitmap meta-tile editor's right pane: the tileset reference (and the
 * tile-0 reservation see-through cells rest on), the meta's size in tiles, its
 * eight gameplay flags, the palette, how full the set is, and the export block.
 */
import { computed } from 'vue'
import { MSX1_PALETTE_GRB, paletteToRgb, toHex } from '../../../../shared/msx/palette'
import { MAX_META_SIZE, META_FLAG_COUNT } from '../../../../shared/msx/meta-tile'
import { MAX_BITMAP_TILES } from '../../../../shared/msx/bitmap-tile'
import { defaultExport, type ExportBlock, type ResourceKind } from '../../../../shared/msx/resource'
import { useResourcesStore } from '../../stores/resourcesStore'
import {
  bitmapTiles,
  cellSize,
  commit,
  compact,
  doc,
  reserveBitmapTile0,
  resize,
  setColor,
  setTileset,
  tileUsage,
  toggleFlag,
  type MetaSession
} from './session'

const props = defineProps<{ session: MetaSession }>()
const resourcesStore = useResourcesStore()

const meta = computed(() => doc(props.session))
const usage = computed(() => tileUsage(props.session))

/** A bitmap meta groups a `.btiles.json`, or a screen read as an atlas. */
const TILESET_KINDS: ResourceKind[] = ['btiles', 'screen']
const tilesetOptions = computed(() =>
  resourcesStore.entries.filter((entry) => TILESET_KINDS.includes(entry.kind)).map((entry) => entry.path)
)

const bitmap = computed(() => bitmapTiles(props.session))
const rgb = computed(() => paletteToRgb(bitmap.value?.palette ?? null))
const cell = computed(() => cellSize(props.session))

/** A bitmap set needs tile 0 reserved before a meta's cells can be see-through. */
const needsReserve = computed(() => (bitmap.value ? !bitmap.value.reserveTile0 : false))

/** Every pixel carries its own colour in a bitmap mode, so all sixteen are on offer. */
const palette = Array.from({ length: MSX1_PALETTE_GRB.length }, (_, i) => i)

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
          @click="reserveBitmapTile0(session)"
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
        {{ meta.width * cell.width }}×{{ meta.height * cell.height }} dots, {{ meta.width * meta.height }} tiles per frame.
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

    <section v-if="bitmap">
      <h3>Tiles</h3>
      <p class="hint">
        This meta uses {{ usage.used }} tile{{ usage.used === 1 ? '' : 's' }}; the set holds
        {{ usage.total }} of {{ MAX_BITMAP_TILES }}.
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
          <span title="Appends a _Draw() that blits one frame out of the atlas, skipping transparent cells. Needs msxgl.h included first.">
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
