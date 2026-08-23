<script setup lang="ts">
/**
 * Spec 10 A's right pane: the layer list (visibility, add/remove/rename), the
 * the layer list (gameplay flags live on the tileset, edited in the tile
 * tile, choose the paint brush for flags mode), the tileset reference, map
 * size, and the export block Spec 07's converter reads.
 */
import { computed, ref, watch } from 'vue'
import { mapExport } from '../../../../shared/msx/map'
import { MODES } from '../../../../shared/msx/modes'
import { defaultExport, type ExportBlock, type ResourceKind } from '../../../../shared/msx/resource'
import { addLayer, commit, doc, reloadTileset, removeLayer, renameLayer, reorderLayer, resize, selectLayer, setBaked, setCell, setTileset, setTransparent, toggleLayerVisible, type MapSession } from './session'
import { useResourcesStore } from '../../stores/resourcesStore'
import Icon from '../../components/Icon.vue'

const props = defineProps<{ session: MapSession }>()
const resourcesStore = useResourcesStore()

const mapDoc = computed(() => doc(props.session))
const widthInput = computed({ get: () => mapDoc.value.width, set: (v) => resize(props.session, v, mapDoc.value.height) })
const heightInput = computed({ get: () => mapDoc.value.height, set: (v) => resize(props.session, mapDoc.value.width, v) })

/**
 * Tilesets and screens both qualify. A `.screen.json` makes this a bitmap-mode
 * map: its converted image is read as a grid of cells and the game copies them
 * with the VDP rather than writing a name table (see `MapCell`).
 */
/**
 * Everything a map can draw with: a pattern tileset, a bitmap tileset, or a
 * screen read as a grid — the older bitmap path, kept for maps that still point
 * at one.
 */
const TILESET_KINDS: ResourceKind[] = ['tiles', 'btiles', 'screen']
const tilesetOptions = computed(() =>
  resourcesStore.entries.filter((entry) => TILESET_KINDS.includes(entry.kind)).map((entry) => entry.path)
)

/**
 * Points the map at a tileset.
 *
 * Placed meta-tiles do not survive it: a placement names a meta by slot, and
 * those metas draw with the *old* tileset's tiles, so pointing the map
 * elsewhere makes every one of them meaningless rather than merely wrong.
 */
async function chooseTileset(path: string): Promise<void> {
  const placed = mapDoc.value.layers.some((layer) => layer.placements.length)
  if (placed && !window.confirm('Changing the tileset removes every placed meta-tile from this map. Continue?')) {
    return
  }
  await setTileset(props.session, path)
}

/** The placement the canvas has selected, with the meta it names. */
const selectedPlacement = computed(() => {
  const index = props.session.selectedPlacement
  if (index === null) return null
  const placement = mapDoc.value.layers[props.session.activeLayer]?.placements[index]
  const ref = placement && mapDoc.value.metas[placement.slot]
  return placement && ref ? { placement, ref } : null
})

const cell = computed(() => mapDoc.value.cell)
const sc3 = computed(() => cell.value?.sc3 === true)

/**
 * What this map is actually going to draw on, read from the tileset the editor
 * has open rather than stored here — a map has no mode of its own, and that is
 * exactly why it needed saying out loud somewhere.
 */
const target = computed(() => {
  const mode = props.session.bitmapTileset?.mode ?? props.session.atlas?.mode ?? null
  if (!mode) {
    return {
      label: props.session.tileset ? MODES[props.session.tileset.mode].label : 'no tileset yet',
      how: props.session.tileset ? 'name table, one VDP_WriteLayout_GM2' : 'pick one below'
    }
  }
  if (mode === 'sc3') {
    const nameTable = cell.value?.width === 2 && cell.value?.height === 2
    return {
      label: MODES.sc3.label,
      how: nameTable ? 'name table, drawn by the VDP — scrolls' : 'blitted into the shadow buffer'
    }
  }
  return { label: MODES[mode].label, how: 'blitted with the VDP command engine' }
})

function patchCell(patch: Partial<NonNullable<typeof cell.value>>): void {
  const current = cell.value
  if (current) setCell(props.session, { ...current, ...patch })
}

/** "Reloaded" only stays up until the next edit, so it can't be mistaken for live state. */
const reloading = ref(false)
const reloaded = ref(false)

async function reload(): Promise<void> {
  reloading.value = true
  reloaded.value = false
  try {
    await reloadTileset(props.session)
    reloaded.value = !props.session.tilesetError
  } finally {
    reloading.value = false
  }
}

watch(
  () => mapDoc.value.layers,
  () => (reloaded.value = false)
)

function setupExport(): void {
  commit(props.session, { ...mapDoc.value, export: defaultExport(props.session.path) })
}

function patchExport(patch: Partial<ExportBlock>): void {
  const current = mapDoc.value
  if (!current.export) return
  commit(props.session, { ...current, export: { ...current.export, ...patch } })
}

/**
 * What the layer tables cost either way, so the trade is visible before it is
 * taken. A name table is mostly runs of one tile, so this is usually a large
 * number — but it is measured, not promised.
 */
const packing = computed(() => {
  const raw = mapDoc.value.layers.reduce((total, layer) => total + layer.data.length, 0)
  const packed = mapExport(mapDoc.value, 'rlep').layers.reduce((total, layer) => total + layer.bytes.length, 0)
  return { raw, packed, saved: raw ? Math.round(((raw - packed) / raw) * 100) : 0 }
})

</script>

<template>
  <div class="side">
    <section>
      <h3>Tileset</h3>
      <p class="hint target">
        Target: <strong>{{ target.label }}</strong> — {{ target.how }}
      </p>
      <div class="tileset-row">
        <select
          :value="mapDoc.tileset"
          @change="chooseTileset(($event.target as HTMLSelectElement).value)"
        >
          <option value="">
            — choose —
          </option>
          <option
            v-for="path in tilesetOptions"
            :key="path"
            :value="path"
          >
            {{ path }}
          </option>
        </select>
        <button
          type="button"
          title="Re-read the tileset from disk — a map draws with its own copy, so tiles edited and saved elsewhere land here on reload"
          :disabled="!mapDoc.tileset || reloading"
          @click="reload"
        >
          <Icon name="refresh" />
        </button>
      </div>
      <p
        v-if="session.tilesetError"
        class="hint error"
      >
        {{ session.tilesetError }}
      </p>
      <p
        v-else-if="reloaded"
        class="hint"
      >
        Tileset reloaded.
      </p>
      <p
        v-if="mapDoc.metas.length"
        class="hint"
      >
        Places {{ mapDoc.metas.length }} meta-tile{{ mapDoc.metas.length === 1 ? '' : 's' }}:
        {{ mapDoc.metas.map((entry) => entry.name).join(', ') }}.
      </p>
    </section>

    <section v-if="selectedPlacement">
      <h3>Placement</h3>
      <p class="hint">
        <strong>{{ selectedPlacement.ref.name }}</strong> at
        {{ selectedPlacement.placement.x }},{{ selectedPlacement.placement.y }} —
        {{ selectedPlacement.ref.width }}×{{ selectedPlacement.ref.height }} tiles,
        {{ selectedPlacement.ref.frames }} frame{{ selectedPlacement.ref.frames === 1 ? '' : 's' }}.
      </p>
      <label class="inline">
        <input
          type="checkbox"
          :checked="selectedPlacement.placement.baked === true"
          @change="setBaked(session, ($event.target as HTMLInputElement).checked)"
        >
        <span title="Writes frame 0 into the tile grid, so the layer write already draws it and it costs nothing at runtime. An animated meta-tile should stay unbaked.">
          Bake into the layer
        </span>
      </label>
      <p class="hint">
        {{
          selectedPlacement.placement.baked
            ? 'Its tiles are in the grid. It is skipped at runtime, and painting over it drops this record.'
            : 'Drawn at runtime from the placement table, so it can animate.'
        }}
      </p>
    </section>

    <section v-if="cell">
      <h3>Cell</h3>
      <div class="size-row">
        <label>
          <span>W</span>
          <input
            :value="cell.width"
            type="number"
            min="2"
            step="2"
            @change="patchCell({ width: Number(($event.target as HTMLInputElement).value) })"
          >
        </label>
        <label>
          <span>H</span>
          <input
            :value="cell.height"
            type="number"
            min="1"
            @change="patchCell({ height: Number(($event.target as HTMLInputElement).value) })"
          >
        </label>
        <label>
          <span>Cols</span>
          <input
            :value="cell.cols"
            type="number"
            min="1"
            @change="patchCell({ cols: Number(($event.target as HTMLInputElement).value) })"
          >
        </label>
      </div>
      <p
        v-if="sc3"
        class="hint"
      >
        SCREEN 3: a cell is {{ cell?.width }}×{{ cell?.height }} blocks of 4×4 dots.
        <template v-if="cell?.width === 2 && cell?.height === 2">
          At 2×2 a cell is exactly one name-table entry, so this map is drawn by the VDP with
          one <code>VDP_WriteLayout_GM2</code> — 768 bytes for a whole screen, and it can scroll
          under MSXgl's camera. That is the fast path; keep it if the world is bigger than a screen.
        </template>
        <template v-else>
          Bigger than a name-table entry, so this map is blitted cell by cell into the shadow
          buffer the screen resource flushes. Fine for a single-screen playfield; switch the
          tileset to 2×2 blocks if it needs to scroll.
        </template>
        The mode comes from the tileset — change it there, not here.
      </p>
      <p
        v-else
        class="hint"
      >
        This map draws in a bitmap mode, where there is no name table: a cell is
        a rectangle of dots the game copies out of the atlas image, not an index
        the VDP resolves. <strong>Cols</strong> is how many cells fit across that
        image — cell <em>n</em> is the <em>n</em>th block, read left to right and
        top to bottom. Keep it a power of two and the helper's divide becomes a
        shift. Width must be even: the VDP copies whole bytes, and every bitmap
        mode packs at least two dots into one.
      </p>

      <label class="inline">
        <input
          type="checkbox"
          :checked="mapDoc.transparent !== null"
          @change="setTransparent(session, ($event.target as HTMLInputElement).checked ? 0 : null)"
        >
        <span title="A cell index that a layer drawn over another skips instead of blitting">
          Has a transparent cell
        </span>
      </label>
      <div
        v-if="mapDoc.transparent !== null"
        class="size-row"
      >
        <label>
          <span>Cell</span>
          <input
            :value="mapDoc.transparent"
            type="number"
            min="0"
            max="255"
            @change="setTransparent(session, Number(($event.target as HTMLInputElement).value))"
          >
        </label>
      </div>
      <p class="hint">
        A cell index that means <em>draw nothing</em>, for a layer painted over
        another. Off by default and never assumed: cell 0 is an ordinary picture
        like any other, so no index can stand for empty unless you say which.
        With one set the export also emits <code>_DrawRowOver()</code> — the same
        row blit, skipping that cell instead of copying it. Draw the background
        row first, then the overlay.
      </p>
    </section>

    <section>
      <h3>Size</h3>
      <div class="size-row">
        <label>
          <span>W</span>
          <input
            v-model.number="widthInput"
            type="number"
            min="1"
          >
        </label>
        <label>
          <span>H</span>
          <input
            v-model.number="heightInput"
            type="number"
            min="1"
          >
        </label>
      </div>
    </section>

    <section>
      <h3>Layers</h3>
      <div
        v-for="(layer, index) in mapDoc.layers"
        :key="index"
        class="layer-row"
        :class="{ active: index === session.activeLayer }"
        @click="selectLayer(session, index)"
      >
        <button
          type="button"
          class="vis"
          :title="layer.visible ? 'Hide layer' : 'Show layer'"
          @click.stop="toggleLayerVisible(session, index)"
        >
          <Icon :name="layer.visible ? 'visibility' : 'visibility_off'" />
        </button>
        <input
          class="name"
          type="text"
          spellcheck="false"
          :value="layer.name"
          @click.stop
          @change="renameLayer(session, index, ($event.target as HTMLInputElement).value)"
        >
        <span class="kind">{{ layer.kind }}</span>
        <button
          type="button"
          class="move"
          title="Move layer up"
          :disabled="index === 0"
          @click.stop="reorderLayer(session, index, index - 1)"
        >
          <Icon name="arrow_upward" />
        </button>
        <button
          type="button"
          class="move"
          title="Move layer down"
          :disabled="index === mapDoc.layers.length - 1"
          @click.stop="reorderLayer(session, index, index + 1)"
        >
          <Icon name="arrow_downward" />
        </button>
        <button
          type="button"
          class="remove"
          title="Remove layer"
          :disabled="mapDoc.layers.length <= 1"
          @click.stop="removeLayer(session, index)"
        >
          <Icon name="close" />
        </button>
      </div>
      <div class="add-row">
        <button
          type="button"
          @click="addLayer(session)"
        >
          Add layer
        </button>
      </div>
    </section>

    <section>
      <h3>Tile flags</h3>
      <p class="hint">
        The eight gameplay bits per tile live on the tileset now, so every map
        drawn with it agrees. Open <code>{{ mapDoc.tileset || 'the tileset' }}</code>
        and use the flag squares there.
      </p>
    </section>

    <section>
      <h3>Export</h3>
      <template v-if="mapDoc.export">
        <label>
          <span>Table name</span>
          <input
            type="text"
            spellcheck="false"
            :value="mapDoc.export.name"
            @change="patchExport({ name: ($event.target as HTMLInputElement).value })"
          >
        </label>
        <label>
          <span>Output</span>
          <input
            type="text"
            spellcheck="false"
            :value="mapDoc.export.out"
            @change="patchExport({ out: ($event.target as HTMLInputElement).value })"
          >
        </label>
        <label>
          <span>Format</span>
          <select
            :value="mapDoc.export.format"
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
        <label class="inline">
          <input
            type="checkbox"
            :checked="mapDoc.export.compress === 'rlep'"
            @change="patchExport({ compress: ($event.target as HTMLInputElement).checked ? 'rlep' : undefined })"
          >
          <span title="Pack the layer tables with MSXgl's RLEp run-length format">
            Compress (RLEp) — {{ packing.raw }} → {{ packing.packed }} bytes
            <template v-if="packing.saved > 0">({{ packing.saved }}% smaller)</template>
          </span>
        </label>
        <label class="inline">
          <input
            type="checkbox"
            :checked="mapDoc.export.helpers === true"
            @change="patchExport({ helpers: ($event.target as HTMLInputElement).checked })"
          >
          <span title="Appends a _DrawLayer() that writes a layer into the name table. Needs msxgl.h included first.">
            Export ready-made C
          </span>
        </label>
        <p
          v-if="mapDoc.export.compress === 'rlep'"
          class="hint"
        >
          The game unpacks these at run time with MSXgl's <code>RLEp_UnpackToRAM</code>: tick
          <em>ready-made C</em> above for a <code>_DrawLayer()</code> that does it, add
          <strong>compress</strong> to the project's library modules, and leave
          <code>COMPRESS_USE_RLEP</code> / <code>_DEFAULT</code> TRUE in
          <code>msxgl_config.h</code> (they are, unless you changed them).
        </p>
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

select,
input[type='text'],
input[type='number'] {
  width: 100%;
  padding: 3px 5px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-tab-inactive);
  color: var(--color-text);
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

.size-row {
  display: flex;
  gap: 8px;
}

.size-row label {
  flex: 1;
}

.layer-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 2px;
  border-radius: 3px;
  cursor: pointer;
}

.layer-row.active {
  background: var(--color-bg-active-item);
}

.layer-row .vis,
.layer-row .move,
.layer-row .remove {
  flex: none;
  width: 18px;
  font-size: 11px;
  color: var(--color-text-muted);
}

.layer-row .move:disabled,
.layer-row .remove:disabled {
  opacity: 0.35;
  cursor: default;
}

.layer-row .name {
  flex: 1;
  min-width: 0;
}

.layer-row .kind {
  flex: none;
  font-size: 9px;
  color: var(--color-text-muted);
}

.add-row {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}

.add-row button {
  flex: 1;
  padding: 3px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-hover);
  font-size: 10px;
}

.flag-list {
  margin-bottom: 6px;
}

.flag-item {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 2px;
}

.flag-item span {
  flex: 1;
}

.flag-item .brush {
  flex: none;
  padding: 0 4px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-hover);
  font-size: 10px;
}

.flag-item .brush.active {
  border-color: var(--color-accent);
  background: var(--color-accent);
}

.new-flag {
  display: flex;
  gap: 4px;
}

.new-flag input {
  flex: 1;
}

.new-flag button {
  padding: 3px 8px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-hover);
  font-size: 10px;
}

.wide {
  width: 100%;
  padding: 4px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-hover);
  font-size: 11px;
}

.tileset-row {
  display: flex;
  gap: 4px;
}

.tileset-row select {
  flex: 1;
  min-width: 0;
}

.tileset-row button {
  flex: none;
  padding: 0 8px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-hover);
  color: var(--color-text);
  font-size: 13px;
  line-height: 1;
}

.tileset-row button:disabled {
  opacity: 0.4;
}

.hint {
  margin: 4px 0;
  font-size: 10px;
  color: var(--color-text-muted);
}

label.inline {
  display: flex;
  align-items: baseline;
  gap: 6px;
  color: var(--color-text-muted);
}

.hint.error {
  color: var(--color-error, #f14c4c);
}
</style>
