<script setup lang="ts">
/**
 * Spec 10 A's right pane: the layer list (visibility, add/remove/rename), the
 * the layer list (gameplay flags live on the tileset, edited in the tile
 * tile, choose the paint brush for flags mode), the tileset reference, map
 * size, and the export block Spec 07's converter reads.
 */
import { computed } from 'vue'
import { mapExport } from '../../../../shared/msx/map'
import { defaultExport, type ExportBlock } from '../../../../shared/msx/resource'
import { addLayer, commit, doc, removeLayer, renameLayer, resize, selectLayer, setTileset, toggleLayerVisible, type MapSession } from './session'
import { useResourcesStore } from '../../stores/resourcesStore'

const props = defineProps<{ session: MapSession }>()
const resourcesStore = useResourcesStore()

const mapDoc = computed(() => doc(props.session))
const widthInput = computed({ get: () => mapDoc.value.width, set: (v) => resize(props.session, v, mapDoc.value.height) })
const heightInput = computed({ get: () => mapDoc.value.height, set: (v) => resize(props.session, mapDoc.value.width, v) })

const tilesetOptions = computed(() => resourcesStore.entries.filter((entry) => entry.kind === 'tiles').map((entry) => entry.path))

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
      <select
        :value="mapDoc.tileset"
        @change="setTileset(session, ($event.target as HTMLSelectElement).value)"
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
      <p
        v-if="session.tilesetError"
        class="hint error"
      >
        {{ session.tilesetError }}
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
          {{ layer.visible ? '👁' : '—' }}
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
          class="remove"
          title="Remove layer"
          :disabled="mapDoc.layers.length <= 1"
          @click.stop="removeLayer(session, index)"
        >
          ✕
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
.layer-row .remove {
  flex: none;
  width: 18px;
  font-size: 11px;
  color: var(--color-text-muted);
}

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
