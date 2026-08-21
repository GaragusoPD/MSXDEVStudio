<script setup lang="ts">
/**
 * The `*.meta-tiles.json` / `*.meta-btiles.json` editor: build same-sized groups
 * of tiles that a map can index instead of indexing tiles.
 *
 * Three panes, and all three are thin. The left one draws the referenced
 * tileset through the map editor's own `sheet.ts`, which already collapses a
 * pattern tileset, a bitmap tileset and an atlas into one grid of images. The
 * centre one is that same drawing at `width × height` cells. The right one is a
 * list, a size and the standard export block. Everything it changes goes through
 * `shared/msx/meta-tile.ts`.
 *
 * One pane fewer than the map editor because there are no tools: a meta is small
 * enough that clicking a cell is the whole interaction.
 */
import { computed, onMounted, onUnmounted, ref, watch, watchEffect } from 'vue'
import { defaultExport, type ExportBlock, type ResourceKind } from '../../../../shared/msx/resource'
import { MAX_META_SIZE } from '../../../../shared/msx/meta-tile'
import { MODES } from '../../../../shared/msx/modes'
import { fitColumns } from '../../../../shared/tile-editor'
import { useResourcesStore } from '../../stores/resourcesStore'
import { useTabsStore } from '../../stores/tabsStore'
import Icon from '../../components/Icon.vue'
import { isTypingTarget } from '../../commands'
import {
  addMeta,
  addMetaFromTiles,
  canRedo,
  canUndo,
  commit,
  doc,
  metaSession,
  metaStride,
  paintCell,
  pickTile,
  pruneMetaSessions,
  redo,
  reloadTileset,
  removeMeta,
  renameMeta,
  reorderMetas,
  resizeMetas,
  saveSession,
  selectMeta,
  setTileset,
  sheet,
  undo
} from './session'

const tabsStore = useTabsStore()
const resourcesStore = useResourcesStore()

const path = computed(() => tabsStore.activeTab?.filePath ?? '')
const session = computed(() => metaSession(path.value))
const metaDoc = computed(() => doc(session.value))
const cells = computed(() => sheet(session.value))
const active = computed(() => metaDoc.value.metas[session.value.active] ?? null)

/** A meta-tile set groups tiles, so only the kinds that *have* tiles qualify. */
const TILESET_KINDS: ResourceKind[] = ['tiles', 'btiles', 'screen']

/** Read from whichever tileset loaded; a meta set has no mode of its own. */
const targetMode = computed(
  () => session.value.bitmapTileset?.mode ?? session.value.atlas?.mode ?? session.value.tileset?.mode ?? null
)
const targetLabel = computed(() => (targetMode.value ? MODES[targetMode.value].label : null))
const sc3Tileset = computed(() => targetMode.value === 'sc3')
const tilesetOptions = computed(() =>
  resourcesStore.entries.filter((entry) => TILESET_KINDS.includes(entry.kind)).map((entry) => entry.path)
)

// ── the tileset pane ──────────────────────────────────────────────────────

const pickerCanvas = ref<HTMLCanvasElement | null>(null)
const pickerPane = ref<HTMLElement | null>(null)
const pickerWidth = ref(240)
const pickerHover = ref<number | null>(null)
const PICKER_CELL = 24

const pickerColumns = computed(() => fitColumns(pickerWidth.value, PICKER_CELL, cells.value?.count ?? 0))
const pickerRows = computed(() => Math.max(1, Math.ceil((cells.value?.count ?? 0) / pickerColumns.value)))

let observer: ResizeObserver | null = null
onMounted(() => {
  observer = new ResizeObserver((entries) => (pickerWidth.value = entries[0].contentRect.width))
  if (pickerPane.value) observer.observe(pickerPane.value)
})
onUnmounted(() => observer?.disconnect())

function pickerIndexAt(event: PointerEvent): number | null {
  const rect = (event.currentTarget as HTMLCanvasElement).getBoundingClientRect()
  const x = Math.floor((event.clientX - rect.left) / PICKER_CELL)
  const y = Math.floor((event.clientY - rect.top) / PICKER_CELL)
  if (x < 0 || x >= pickerColumns.value || y < 0) return null
  const index = y * pickerColumns.value + x
  return index < (cells.value?.count ?? 0) ? index : null
}

watchEffect(() => {
  const element = pickerCanvas.value
  const source = cells.value
  if (!element || !source) return
  element.width = pickerColumns.value * PICKER_CELL
  element.height = pickerRows.value * PICKER_CELL
  const ctx = element.getContext('2d')
  if (!ctx) return
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, element.width, element.height)
  // Placed cell by cell rather than blitted in rows: the pane's column count is
  // measured, and the sheet's own is whatever it was built with.
  for (let index = 0; index < source.count; index++) {
    ctx.drawImage(
      source.canvas,
      (index % source.cols) * source.cellW,
      Math.floor(index / source.cols) * source.cellH,
      source.cellW,
      source.cellH,
      (index % pickerColumns.value) * PICKER_CELL,
      Math.floor(index / pickerColumns.value) * PICKER_CELL,
      PICKER_CELL,
      PICKER_CELL
    )
  }
  const brush = session.value.brush
  if (brush < source.count) {
    ctx.strokeStyle = '#4ea1ff'
    ctx.lineWidth = 2
    ctx.strokeRect(
      (brush % pickerColumns.value) * PICKER_CELL + 1,
      Math.floor(brush / pickerColumns.value) * PICKER_CELL + 1,
      PICKER_CELL - 2,
      PICKER_CELL - 2
    )
  }
})

// ── the meta being edited ─────────────────────────────────────────────────

const editorCanvas = ref<HTMLCanvasElement | null>(null)

function editorCellAt(event: PointerEvent): { x: number; y: number } | null {
  const element = event.currentTarget as HTMLCanvasElement
  const rect = element.getBoundingClientRect()
  const current = metaDoc.value
  const x = Math.floor(((event.clientX - rect.left) / rect.width) * current.width)
  const y = Math.floor(((event.clientY - rect.top) / rect.height) * current.height)
  if (x < 0 || y < 0 || x >= current.width || y >= current.height) return null
  return { x, y }
}

let painting = false

function onEditorDown(event: PointerEvent): void {
  const cell = editorCellAt(event)
  if (!cell) return
  ;(event.currentTarget as HTMLCanvasElement).setPointerCapture(event.pointerId)
  painting = true
  paintCell(session.value, cell.x, cell.y)
}

function onEditorMove(event: PointerEvent): void {
  if (!painting) return
  const cell = editorCellAt(event)
  if (cell) paintCell(session.value, cell.x, cell.y)
}

function onEditorUp(): void {
  painting = false
}

watchEffect(() => {
  const element = editorCanvas.value
  const source = cells.value
  const meta = active.value
  const current = metaDoc.value
  if (!element || !source || !meta) return
  const size = session.value.zoom
  element.width = current.width * size
  element.height = current.height * size
  const ctx = element.getContext('2d')
  if (!ctx) return
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, element.width, element.height)
  for (let y = 0; y < current.height; y++) {
    for (let x = 0; x < current.width; x++) {
      const tile = meta.tiles[y * current.width + x] ?? 0
      ctx.drawImage(
        source.canvas,
        (tile % source.cols) * source.cellW,
        Math.floor(tile / source.cols) * source.cellH,
        source.cellW,
        source.cellH,
        x * size,
        y * size,
        size,
        size
      )
    }
  }
  if (!session.value.gridVisible) return
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)'
  ctx.lineWidth = 1
  for (let x = 1; x < current.width; x++) {
    ctx.beginPath()
    ctx.moveTo(x * size + 0.5, 0)
    ctx.lineTo(x * size + 0.5, element.height)
    ctx.stroke()
  }
  for (let y = 1; y < current.height; y++) {
    ctx.beginPath()
    ctx.moveTo(0, y * size + 0.5)
    ctx.lineTo(element.width, y * size + 0.5)
    ctx.stroke()
  }
})

// ── the thumbnail list ────────────────────────────────────────────────────

/** One meta as a data URL, for the list. Cheap: the sheet is already a canvas. */
function thumbnail(index: number): string {
  const source = cells.value
  const current = metaDoc.value
  const meta = current.metas[index]
  if (!source || !meta) return ''
  const canvas = document.createElement('canvas')
  canvas.width = current.width * source.cellW
  canvas.height = current.height * source.cellH
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  ctx.imageSmoothingEnabled = false
  for (let y = 0; y < current.height; y++) {
    for (let x = 0; x < current.width; x++) {
      const tile = meta.tiles[y * current.width + x] ?? 0
      ctx.drawImage(
        source.canvas,
        (tile % source.cols) * source.cellW,
        Math.floor(tile / source.cols) * source.cellH,
        source.cellW,
        source.cellH,
        x * source.cellW,
        y * source.cellH,
        source.cellW,
        source.cellH
      )
    }
  }
  return canvas.toDataURL()
}

// ── the side panel ────────────────────────────────────────────────────────

const widthInput = computed({
  get: () => metaDoc.value.width,
  set: (v: number) => resizeMetas(session.value, v, metaDoc.value.height)
})
const heightInput = computed({
  get: () => metaDoc.value.height,
  set: (v: number) => resizeMetas(session.value, metaDoc.value.width, v)
})

function setupExport(): void {
  commit(session.value, { ...metaDoc.value, export: defaultExport(session.value.path) })
}

function patchExport(patch: Partial<ExportBlock>): void {
  const current = metaDoc.value
  if (!current.export) return
  commit(session.value, { ...current, export: { ...current.export, ...patch } })
}

/** What a map saves by indexing this set instead of the tiles under it. */
const saving = computed(() => {
  const stride = metaStride(metaDoc.value)
  return { stride, percent: stride > 1 ? Math.round((1 - 1 / stride) * 100) : 0 }
})

async function save(): Promise<void> {
  try {
    await saveSession(session.value)
  } catch (error) {
    session.value.status = `Save failed: ${String(error)}`
  }
}

async function exportNow(): Promise<void> {
  await save()
  await resourcesStore.exportOne(session.value.path)
}

function onKeydown(event: KeyboardEvent): void {
  if (isTypingTarget(event)) return
  if (!event.ctrlKey) return
  const key = event.key.toLowerCase()
  if (key === 'z' && !event.shiftKey) {
    event.preventDefault()
    undo(session.value)
  } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
    event.preventDefault()
    redo(session.value)
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

watch(
  () => tabsStore.tabs.length,
  () => pruneMetaSessions(new Set(tabsStore.tabs.map((tab) => tab.filePath ?? ''))),
  { immediate: true }
)

onMounted(() => void resourcesStore.refresh())
</script>

<template>
  <div class="meta-editor">
    <p
      v-if="session.error"
      class="error"
    >
      {{ session.error }}
    </p>
    <template v-else-if="!session.loading">
      <div class="toolbar">
        <button
          type="button"
          title="Add a blank meta-tile"
          @click="addMeta(session)"
        >
          + Meta
        </button>
        <button
          type="button"
          :title="`Add a meta-tile from the ${metaDoc.width}×${metaDoc.height} tiles at the picked one`"
          :disabled="!cells"
          @click="addMetaFromTiles(session, session.brush, pickerColumns)"
        >
          + From tiles
        </button>

        <span class="sep" />
        <button
          type="button"
          title="Undo (Ctrl+Z)"
          :disabled="!canUndo(session.history)"
          @click="undo(session)"
        >
          <Icon name="undo" />
        </button>
        <button
          type="button"
          title="Redo (Ctrl+Y)"
          :disabled="!canRedo(session.history)"
          @click="redo(session)"
        >
          <Icon name="redo" />
        </button>

        <span class="sep" />
        <label
          class="zoom"
          title="Zoom"
        >
          <Icon name="zoom_in" />
          <input
            v-model.number="session.zoom"
            type="range"
            :min="8"
            :max="64"
            :step="4"
          >
        </label>
        <label class="inline">
          <input
            v-model="session.gridVisible"
            type="checkbox"
          >
          <span>grid</span>
        </label>

        <span class="spacer" />
        <button
          type="button"
          :disabled="!session.dirty"
          @click="save"
        >
          {{ session.dirty ? 'Save' : 'Saved' }}
        </button>
        <button
          type="button"
          title="Write the meta-tile table this set exports"
          @click="exportNow"
        >
          Export
        </button>
      </div>

      <div class="panes">
        <div
          ref="pickerPane"
          class="pane picker"
        >
          <header>
            <span class="title">Tiles</span>
            <span class="readout">{{ pickerHover ?? session.brush }}</span>
          </header>
          <p
            v-if="!cells"
            class="hint"
          >
            {{ session.tilesetError ?? 'No tileset.' }}
          </p>
          <div
            v-else
            class="scroller"
          >
            <canvas
              ref="pickerCanvas"
              class="sheet"
              @pointerdown="(e) => { const i = pickerIndexAt(e); if (i !== null) pickTile(session, i) }"
              @pointermove="pickerHover = pickerIndexAt($event)"
              @pointerleave="pickerHover = null"
            />
          </div>
          <p class="hint">
            Click a tile, then click cells of the meta-tile to place it.
          </p>
        </div>

        <div class="pane stage">
          <p
            v-if="!active"
            class="hint"
          >
            No meta-tiles yet — press <strong>+ Meta</strong> for a blank one, or pick a tile and press
            <strong>+ From tiles</strong> to take the {{ metaDoc.width }}×{{ metaDoc.height }} block starting there.
          </p>
          <canvas
            v-else
            ref="editorCanvas"
            class="meta-canvas"
            @pointerdown="onEditorDown"
            @pointermove="onEditorMove"
            @pointerup="onEditorUp"
            @pointercancel="onEditorUp"
          />
        </div>

        <div class="pane side">
          <section>
            <h3>Tileset</h3>
            <div class="row">
              <select
                :value="metaDoc.tileset"
                @change="setTileset(session, ($event.target as HTMLSelectElement).value)"
              >
                <option value="">
                  — choose —
                </option>
                <option
                  v-for="option in tilesetOptions"
                  :key="option"
                  :value="option"
                >
                  {{ option }}
                </option>
              </select>
              <button
                type="button"
                title="Re-read the tileset from disk"
                :disabled="!metaDoc.tileset"
                @click="reloadTileset(session)"
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
              v-if="sc3Tileset"
              class="hint error"
            >
              This is a <strong>SCREEN 3</strong> tileset, and meta-tiles over one are not
              supported yet — a meta map's helper is built on the V9938 command engine, which
              an MSX1 has not got, so the export is refused rather than emitting code the
              machine cannot run. Point the map at the tileset directly. If the tiles are
              2×2 blocks the map draws through the name table anyway, which is already the
              cheap path meta-tiles exist to buy.
            </p>
            <p
              v-else-if="targetLabel"
              class="hint"
            >
              Target: <strong>{{ targetLabel }}</strong> — the mode comes from the tileset.
            </p>
          </section>

          <section>
            <h3>Meta size</h3>
            <div class="row">
              <label>
                <span>W</span>
                <input
                  v-model.number="widthInput"
                  type="number"
                  :min="1"
                  :max="MAX_META_SIZE"
                >
              </label>
              <label>
                <span>H</span>
                <input
                  v-model.number="heightInput"
                  type="number"
                  :min="1"
                  :max="MAX_META_SIZE"
                >
              </label>
            </div>
            <p class="hint">
              Every meta-tile in the set is this size — the exported table is read at one stride.
              A map drawn with this set costs {{ saving.percent }}% less than the same picture in
              tiles ({{ saving.stride }} tiles per cell).
            </p>
          </section>

          <section>
            <h3>Meta-tiles ({{ metaDoc.metas.length }})</h3>
            <ul class="metas">
              <li
                v-for="(meta, index) in metaDoc.metas"
                :key="index"
                :class="{ active: session.active === index }"
              >
                <button
                  type="button"
                  class="thumb"
                  :title="`Edit ${meta.name}`"
                  @click="selectMeta(session, index)"
                >
                  <img
                    v-if="cells"
                    :src="thumbnail(index)"
                    :alt="meta.name"
                  >
                </button>
                <span class="index">{{ index }}</span>
                <input
                  class="name"
                  :value="meta.name"
                  @change="renameMeta(session, index, ($event.target as HTMLInputElement).value)"
                >
                <button
                  type="button"
                  title="Move up — renumbers every map drawn with this set"
                  :disabled="index === 0"
                  @click="reorderMetas(session, index, index - 1)"
                >
                  ↑
                </button>
                <button
                  type="button"
                  title="Delete — cells pointing at it fall back to meta 0"
                  @click="removeMeta(session, index)"
                >
                  ×
                </button>
              </li>
            </ul>
            <p
              v-if="!metaDoc.metas.length"
              class="hint"
            >
              A meta-tile is a clump of tiles a map can name with one byte — a brick wall, a pine
              tree, a platform end.
            </p>
          </section>

          <section>
            <h3>Export</h3>
            <button
              v-if="!metaDoc.export"
              type="button"
              @click="setupExport"
            >
              Set up export
            </button>
            <template v-else>
              <label class="field">
                <span>Table name</span>
                <input
                  :value="metaDoc.export.name"
                  @change="patchExport({ name: ($event.target as HTMLInputElement).value })"
                >
              </label>
              <label class="field">
                <span>Output</span>
                <input
                  :value="metaDoc.export.out"
                  @change="patchExport({ out: ($event.target as HTMLInputElement).value })"
                >
              </label>
              <label class="inline">
                <input
                  type="checkbox"
                  :checked="metaDoc.export.helpers === true"
                  @change="patchExport({ helpers: ($event.target as HTMLInputElement).checked })"
                >
                <span>Export ready-made C</span>
              </label>
              <p class="hint">
                Adds <code>_DrawMeta()</code>, which stamps one meta-tile at a position. The helpers
                that expand a whole <em>map</em> are on the map's own export — they need its
                dimensions.
              </p>
            </template>
          </section>
        </div>
      </div>

      <p
        v-if="session.status"
        class="status"
      >
        {{ session.status }}
      </p>
    </template>
  </div>
</template>

<style scoped>
.meta-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--color-border);
  flex-wrap: wrap;
}

.toolbar button {
  min-width: 24px;
  padding: 2px 6px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-hover);
  font-size: 12px;
}

.toolbar button:disabled {
  opacity: 0.4;
  cursor: default;
}

.sep {
  width: 1px;
  align-self: stretch;
  margin: 0 4px;
  background: var(--color-border);
}

.spacer {
  flex: 1;
}

.inline {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  color: var(--color-text-muted);
}

.zoom {
  display: flex;
  align-items: center;
  gap: 4px;
}
.zoom input {
  width: 84px;
}

.panes {
  flex: 1;
  min-height: 0;
  display: flex;
}

.pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: auto;
}

.picker {
  width: 220px;
  flex: none;
  border-right: 1px solid var(--color-border);
}

.picker header,
.side h3 {
  display: flex;
  justify-content: space-between;
  padding: 5px 8px;
  margin: 0;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
}

.scroller {
  overflow: auto;
  padding: 4px 8px;
}

.sheet {
  display: block;
  image-rendering: pixelated;
  cursor: crosshair;
}

.stage {
  flex: 1;
  align-items: center;
  justify-content: center;
  padding: 16px;
}

.meta-canvas {
  image-rendering: pixelated;
  cursor: crosshair;
  border: 1px solid var(--color-border);
}

.side {
  width: 280px;
  flex: none;
  border-left: 1px solid var(--color-border);
  padding-bottom: 12px;
}

.side section {
  border-bottom: 1px solid var(--color-border);
  padding-bottom: 8px;
}

.row {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 0 8px;
}

.row select {
  flex: 1;
  min-width: 0;
}

.row label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
}

.row input[type='number'] {
  width: 56px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 8px;
  font-size: 11px;
}

.metas {
  list-style: none;
  margin: 0;
  padding: 0 8px;
}

.metas li {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 0;
}

.metas li.active {
  outline: 1px solid var(--color-accent);
  border-radius: 3px;
}

.thumb {
  padding: 0;
  border: 1px solid var(--color-border);
  background: none;
  line-height: 0;
}

.thumb img {
  display: block;
  width: 32px;
  height: 32px;
  object-fit: contain;
  image-rendering: pixelated;
}

.metas .index {
  width: 20px;
  font-size: 11px;
  color: var(--color-text-muted);
  text-align: right;
}

.metas .name {
  flex: 1;
  min-width: 0;
  font-size: 11px;
}

.metas button:not(.thumb) {
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-hover);
  font-size: 11px;
  padding: 0 5px;
}

.hint {
  margin: 4px 0 0;
  padding: 0 8px;
  font-size: 11px;
  color: var(--color-text-muted);
}

.status,
.error {
  margin: 0;
  padding: 5px 10px;
  border-top: 1px solid var(--color-border);
  font-size: 11px;
  color: var(--color-text-muted);
}

.error {
  color: var(--color-error, #f14c4c);
}
</style>
