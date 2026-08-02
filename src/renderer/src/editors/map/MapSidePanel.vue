<script setup lang="ts">
/**
 * Spec 10 A's right pane: the layer list (visibility, add/remove/rename), the
 * `tileMeta` flags editor (define flags, assign them to the picker's active
 * tile, choose the paint brush for flags mode), the tileset reference, map
 * size, and the export block Spec 07's converter reads.
 */
import { computed, ref } from 'vue'
import { defaultExport, type ExportBlock } from '../../../../shared/msx/resource'
import { availableFlags, addFlag, addLayer, commit, doc, removeLayer, renameLayer, resize, selectLayer, setFlagBrush, setTileset, toggleLayerVisible, toggleTileFlagOn, type MapSession } from './session'
import { useResourcesStore } from '../../stores/resourcesStore'

const props = defineProps<{ session: MapSession }>()
const resourcesStore = useResourcesStore()

const mapDoc = computed(() => doc(props.session))
const newFlagName = ref('')
const widthInput = computed({ get: () => mapDoc.value.width, set: (v) => resize(props.session, v, mapDoc.value.height) })
const heightInput = computed({ get: () => mapDoc.value.height, set: (v) => resize(props.session, mapDoc.value.width, v) })

const tilesetOptions = computed(() => resourcesStore.entries.filter((entry) => entry.kind === 'tiles').map((entry) => entry.path))
const activeTileFlags = computed(() => mapDoc.value.tileMeta[String(props.session.pickerActive)]?.flags ?? [])

function setupExport(): void {
  commit(props.session, { ...mapDoc.value, export: defaultExport(props.session.path) })
}

function patchExport(patch: Partial<ExportBlock>): void {
  const current = mapDoc.value
  if (!current.export) return
  commit(props.session, { ...current, export: { ...current.export, ...patch } })
}

function submitNewFlag(): void {
  addFlag(props.session, props.session.pickerActive, newFlagName.value)
  newFlagName.value = ''
}
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
          @click="addLayer(session, 'tiles')"
        >
          +tiles
        </button>
        <button
          type="button"
          @click="addLayer(session, 'flags')"
        >
          +flags
        </button>
      </div>
    </section>

    <section>
      <h3>Flags</h3>
      <p class="hint">
        Tile {{ session.pickerActive }}'s flags (from <code>tileMeta</code>):
      </p>
      <div class="flag-list">
        <label
          v-for="name in availableFlags(session)"
          :key="name"
          class="flag-item"
        >
          <input
            type="checkbox"
            :checked="activeTileFlags.includes(name)"
            @change="toggleTileFlagOn(session, session.pickerActive, name)"
          >
          <span>{{ name }}</span>
          <button
            type="button"
            class="brush"
            :class="{ active: session.flagBrush === name }"
            title="Use as the flags-mode paint brush"
            @click="setFlagBrush(session, name)"
          >
            🖌
          </button>
        </label>
        <p
          v-if="!availableFlags(session).length"
          class="hint"
        >
          No flags defined yet.
        </p>
      </div>
      <form
        class="new-flag"
        @submit.prevent="submitNewFlag"
      >
        <input
          v-model="newFlagName"
          type="text"
          placeholder="new flag name"
          spellcheck="false"
        >
        <button type="submit">
          Add
        </button>
      </form>
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

.hint.error {
  color: var(--color-error, #f14c4c);
}
</style>
