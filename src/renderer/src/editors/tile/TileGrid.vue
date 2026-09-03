<script setup lang="ts">
/**
 * Spec 08's left pane: the whole bank, wrapped to however many tiles fit across
 * the pane, zoomable, with marquee selection and drag-to-reorder.
 *
 * ponytail: the sheet is redrawn whole on every document change (256 tiles =
 * one ImageData of 16 384 pixels plus a `drawImage` per tile row). If that ever
 * shows up while painting, cache the sheet and repaint only the edited tile.
 */
import { computed, onBeforeUnmount, onMounted, ref, watchEffect } from 'vue'
import Icon from '../../components/Icon.vue'
import { paletteToRgb } from '../../../../shared/msx/palette'
import { bankTilePixels, BANK_COUNT, isBanked, MAX_TILES, tilePixels, TILE_SIZE } from '../../../../shared/msx/tile'
import { fitColumns, marqueeIndices } from '../../../../shared/tile-editor'
import {
  addTile,
  bankBudgetLabel,
  copySelection,
  deleteTiles,
  pasteClipboard,
  reorder,
  setBank,
  setGridZoom,
  select,
  setColumns,
  tileClipboard,
  type TileSession
} from './session'

const props = defineProps<{ session: TileSession }>()

/**
 * Once any bank has overrides, the grid stops showing the common sheet and
 * shows one hardware bank's own 256-tile view instead — `bankTileAt` is the
 * single place that rule lives (`session.ts` reads it too, for painting), so
 * this only asks whether it applies. An ordinary tileset's grid is untouched.
 */
const banked = computed(() => isBanked(props.session.doc))
/** A bank always covers all 256 hardware indices; the common sheet only as many as `count`. */
const slotCount = computed(() => (banked.value ? MAX_TILES : props.session.doc.count))
/** The first index of the shared (meta-tile) region — every index from here up is the same picture in every bank. */
const sharedStart = computed(() => MAX_TILES - props.session.doc.sharedTiles)

/**
 * Deleting renumbers every tile above it, which rewrites open maps through the
 * Spec 10 remap seam — worth one confirmation. One for the whole selection,
 * not one per tile: a marquee of twenty is a single decision.
 */
function confirmDelete(): void {
  const doomed = props.session.selection.length ? props.session.selection : [props.session.active]
  const what =
    doomed.length === 1
      ? `Delete tile ${doomed[0]}?`
      : `Delete ${doomed.length} tiles (${Math.min(...doomed)}–${Math.max(...doomed)})?`
  if (window.confirm(`${what} Maps and blocks using them fall back to tile 0, and every tile above is renumbered.`)) {
    deleteTiles(props.session, doomed)
  }
}

const canvas = ref<HTMLCanvasElement | null>(null)
const scroller = ref<HTMLElement | null>(null)
const dropTarget = ref<number | null>(null)
const hover = ref<number | null>(null)
/** Set only while Alt+dragging, which is the reorder gesture; a plain drag selects. */
let dragFrom: number | null = null
/** The tile a marquee drag started on; the rectangle grows from it. */
let anchor: number | null = null

const cell = computed(() => props.session.gridZoom)
const labelled = computed(() => cell.value >= 32)
const cellHeight = computed(() => cell.value + (labelled.value ? 11 : 0))

/**
 * The sheet wraps into the pane rather than scrolling sideways, so the column
 * count is measured. `.scroller` reserves its scrollbar gutter, which is what
 * keeps this from oscillating: fewer columns → more rows → a scrollbar → a
 * narrower box → fewer columns again.
 */
const paneWidth = ref(0)
const COLUMNS = computed(() => fitColumns(paneWidth.value, cell.value, slotCount.value))
const rows = computed(() => Math.ceil(slotCount.value / COLUMNS.value))

let observer: ResizeObserver | null = null
onMounted(() => {
  observer = new ResizeObserver(([entry]) => {
    paneWidth.value = entry.contentRect.width
  })
  if (scroller.value) observer.observe(scroller.value)
})
onBeforeUnmount(() => observer?.disconnect())

watchEffect(() => setColumns(props.session, COLUMNS.value))

const hex = (index: number): string => `0x${index.toString(16).toUpperCase().padStart(2, '0')}`

function indexAt(event: PointerEvent): number | null {
  const rect = (event.currentTarget as HTMLCanvasElement).getBoundingClientRect()
  const x = Math.floor((event.clientX - rect.left) / cell.value)
  const y = Math.floor((event.clientY - rect.top) / cellHeight.value)
  if (x < 0 || x >= COLUMNS.value || y < 0) return null
  const index = y * COLUMNS.value + x
  return index < slotCount.value ? index : null
}

/** Extends the marquee to `focus`; `active` stays on the anchor, so the row and flag controls don't jump. */
function marqueeTo(focus: number): void {
  const from = anchor as number
  select(props.session, from, marqueeIndices(from, focus, COLUMNS.value, slotCount.value))
}

function onDown(event: PointerEvent): void {
  const index = indexAt(event)
  if (index === null) return
  ;(event.currentTarget as HTMLCanvasElement).setPointerCapture(event.pointerId)
  // A bank view is always a single hardware tile at a time: a block's tiles
  // are references into the common set (see `activeBlock`), and reordering
  // renumbers the common set a bank's own art does not follow (see
  // `reorder`'s guard in session.ts) — so neither the marquee nor the
  // Alt-drag reorder gesture applies here.
  if (banked.value) {
    select(props.session, index)
    return
  }
  // Alt is the reorder gesture: it renumbers the bank, so it stays behind a
  // modifier and a confirmation, and a plain drag is free to select.
  if (event.altKey) {
    select(props.session, index)
    dragFrom = index
    return
  }
  anchor = event.shiftKey ? props.session.active : index
  marqueeTo(index)
}

function onMove(event: PointerEvent): void {
  hover.value = indexAt(event)
  if (dragFrom !== null) {
    dropTarget.value = hover.value
    return
  }
  if (anchor !== null && hover.value !== null) marqueeTo(hover.value)
}

function onUp(): void {
  const from = dragFrom
  const to = dropTarget.value
  dragFrom = null
  anchor = null
  dropTarget.value = null
  if (from === null || to === null || from === to) return
  // Renumbering breaks every map drawn with this set; Spec 10 replays the
  // mapping the editor publishes (see `shared/tile-editor.ts`).
  if (
    !window.confirm(
      `Move tile ${from} to ${to}?\n\nThis renumbers every tile in between. Maps that reference this ` +
        `tileset must be remapped — the map editor replays the change for maps it has open, and the ` +
        `renumbering is recorded in the file for the rest.`
    )
  ) {
    return
  }
  reorder(props.session, from, to)
}

watchEffect(() => {
  const element = canvas.value
  if (!element) return
  const { doc, selection, active } = props.session
  const size = cell.value
  const height = cellHeight.value
  element.width = COLUMNS.value * size
  element.height = Math.max(1, rows.value) * height
  const context = element.getContext('2d')
  if (!context) return
  context.clearRect(0, 0, element.width, element.height)

  // One 8-bit-per-pixel sheet, then one scaled blit per tile row.
  const rgb = paletteToRgb(doc.palette)
  const sheet = new ImageData(COLUMNS.value * TILE_SIZE, Math.max(1, rows.value) * TILE_SIZE)
  for (let index = 0; index < slotCount.value; index++) {
    // `bankTileAt` is the one place that decides what a hardware index shows
    // for a given bank — this has to agree with it exactly, or the sheet lies
    // about what a stroke here is about to edit.
    const pixels = banked.value ? bankTilePixels(doc, props.session.bank, index) : tilePixels(doc, index)
    const ox = (index % COLUMNS.value) * TILE_SIZE
    const oy = Math.floor(index / COLUMNS.value) * TILE_SIZE
    for (let y = 0; y < TILE_SIZE; y++) {
      for (let x = 0; x < TILE_SIZE; x++) {
        const value = pixels[y * TILE_SIZE + x]
        const at = ((oy + y) * sheet.width + ox + x) * 4
        const color = rgb[value] ?? { r: 0, g: 0, b: 0 }
        sheet.data[at] = color.r
        sheet.data[at + 1] = color.g
        sheet.data[at + 2] = color.b
        sheet.data[at + 3] = value === 0 ? 0 : 255
      }
    }
  }
  const source = document.createElement('canvas')
  source.width = sheet.width
  source.height = sheet.height
  source.getContext('2d')?.putImageData(sheet, 0, 0)
  context.imageSmoothingEnabled = false
  for (let row = 0; row < rows.value; row++) {
    context.drawImage(
      source,
      0,
      row * TILE_SIZE,
      sheet.width,
      TILE_SIZE,
      0,
      row * height,
      COLUMNS.value * size,
      size
    )
  }

  if (labelled.value) {
    context.font = '9px monospace'
    context.fillStyle = 'rgba(180, 180, 180, 0.9)'
    for (let index = 0; index < slotCount.value; index++) {
      const x = (index % COLUMNS.value) * size
      const y = Math.floor(index / COLUMNS.value) * height
      context.fillText(`${index} ${hex(index)}`, x + 2, y + size + 9, size - 4)
    }
  }

  // The shared (meta-tile) region: the same picture in every bank, so a
  // stroke here would rewrite all three at once while only one is on screen —
  // marked rather than editable, per `bankIndexEditable` in session.ts.
  if (banked.value && doc.sharedTiles > 0) {
    context.fillStyle = 'rgba(255, 210, 78, 0.16)'
    context.strokeStyle = 'rgba(255, 210, 78, 0.55)'
    context.lineWidth = 1
    for (let index = sharedStart.value; index < slotCount.value; index++) {
      const x = (index % COLUMNS.value) * size
      const y = Math.floor(index / COLUMNS.value) * height
      context.fillRect(x, y, size, size)
      context.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1)
    }
  }

  // The marquee: a tint on every selected cell, and one outline around the
  // rectangle they span — that rectangle is what the canvas is editing.
  const xs = selection.map((index) => index % COLUMNS.value)
  const ys = selection.map((index) => Math.floor(index / COLUMNS.value))
  if (selection.length > 1) {
    context.fillStyle = 'rgba(120, 170, 255, 0.25)'
    for (const index of selection) {
      context.fillRect((index % COLUMNS.value) * size, Math.floor(index / COLUMNS.value) * height, size, size)
    }
  }
  context.lineWidth = 2
  context.strokeStyle = '#ffffff'
  context.strokeRect(
    Math.min(...xs) * size + 1,
    Math.min(...ys) * height + 1,
    (Math.max(...xs) - Math.min(...xs)) * size + size - 2,
    (Math.max(...ys) - Math.min(...ys)) * height + size - 2
  )
  if (selection.length > 1) {
    // Which tile the row colours, flags and transforms act on.
    context.strokeStyle = 'rgba(255, 255, 255, 0.5)'
    context.lineWidth = 1
    context.strokeRect((active % COLUMNS.value) * size + 2, Math.floor(active / COLUMNS.value) * height + 2, size - 4, size - 4)
  }

  if (dropTarget.value !== null && dropTarget.value !== dragFrom) {
    context.strokeStyle = '#007acc'
    context.strokeRect(
      (dropTarget.value % COLUMNS.value) * size + 1,
      Math.floor(dropTarget.value / COLUMNS.value) * height + 1,
      size - 2,
      size - 2
    )
  }
})
</script>

<template>
  <div class="grid-pane">
    <header>
      <div
        v-if="banked"
        class="banks"
        role="group"
        aria-label="Pattern bank"
      >
        <button
          v-for="b in BANK_COUNT"
          :key="b"
          type="button"
          class="bank-tab"
          :class="{ active: session.bank === b - 1 }"
          :title="bankBudgetLabel(session.doc, b - 1)"
          @click="setBank(session, b - 1)"
        >
          Bank {{ b }}
        </button>
      </div>
      <span
        v-else
        class="title"
      >{{ session.doc.count }} tiles</span>
      <span class="readout">{{ hover ?? session.active }} · {{ hex(hover ?? session.active) }}</span>
      <label
        class="zoom"
        title="Zoom"
      >
        <Icon name="zoom_in" />
        <input
          :value="session.gridZoom"
          type="range"
          :min="8"
          :max="64"
          :step="4"
          @input="setGridZoom(session, Number(($event.target as HTMLInputElement).value))"
        >
      </label>
      <button
        type="button"
        :title="
          banked
            ? 'Copy/paste works on the common tileset — not available from a bank view'
            : 'Copy the selected tiles — pixels, colours and flags (Ctrl+C)'
        "
        :disabled="banked"
        @click="copySelection(session)"
      >
        copy
      </button>
      <button
        type="button"
        :title="
          banked
            ? 'Copy/paste works on the common tileset — not available from a bank view'
            : `Paste with the clipboard's top-left on the selected tile (Ctrl+V)`
        "
        :disabled="banked || !tileClipboard()"
        @click="pasteClipboard(session)"
      >
        paste
      </button>
      <button
        type="button"
        title="Append a blank tile to the common set — shows through any bank whose own overrides don't reach this far"
        @click="addTile(session)"
      >
        <Icon
          name="add"
          :size="14"
        />tile
      </button>
      <button
        type="button"
        :title="
          banked
            ? `Deleting renumbers the common tileset, and a bank's own art doesn't renumber with it — not available on a banked tileset`
            : session.selection.length > 1
              ? `Delete the ${session.selection.length} selected tiles — maps and blocks using them fall back to tile 0`
              : 'Delete the selected tile — maps and blocks using it fall back to tile 0'
        "
        :disabled="banked || session.doc.count <= 1"
        @click="confirmDelete"
      >
        <Icon
          name="remove"
          :size="14"
        />tile
      </button>
    </header>
    <div
      ref="scroller"
      class="scroller"
    >
      <canvas
        ref="canvas"
        class="sheet"
        @pointerdown="onDown"
        @pointermove="onMove"
        @pointerup="onUp"
        @pointercancel="onUp"
        @pointerleave="hover = null"
      />
    </div>
    <p
      v-if="banked"
      class="hint"
    >
      Showing Bank {{ session.bank + 1 }} — every hardware index it doesn't override of its own shows the common
      tileset. Amber cells are shared meta-tile art, the same picture in every bank; edit those from the meta-tile
      editor instead.
    </p>
    <p
      v-else
      class="hint"
    >
      Drag a rectangle to edit those tiles as one image · Shift+click extends it · Ctrl+C/Ctrl+V
      copies tiles · Alt+drag a tile onto another to reorder.
    </p>
  </div>
</template>

<style scoped>
.grid-pane {
  display: flex;
  flex: none;
  flex-direction: column;
  min-height: 0;
  /* A definite width, not one derived from the canvas: the canvas derives its
     column count from this pane, and content-sized would make that circular. */
  width: 34%;
  min-width: 140px;
  max-width: 45%;
  border-right: 1px solid var(--color-border);
}

header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--color-border);
  font-size: 11px;
}

/* The add/remove buttons pair an icon with a word, so they lay out their own
   contents rather than letting the icon sit on the label's baseline. */
header button {
  display: flex;
  align-items: center;
  gap: 1px;
}

.banks {
  display: flex;
  gap: 2px;
}

.bank-tab {
  padding: 1px 6px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-hover);
  font-size: 11px;
}

.bank-tab.active {
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: #ffffff;
}

.title {
  color: var(--color-text-muted);
}

.readout {
  margin-left: auto;
  font-family: var(--font-mono);
  color: var(--color-text-muted);
}

header button {
  padding: 1px 6px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-hover);
  font-size: 11px;
}

.scroller {
  flex: 1;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  /* Reserved so the scrollbar appearing can't narrow the box the columns were measured from. */
  scrollbar-gutter: stable;
  padding: 8px;
}

.sheet {
  display: block;
  image-rendering: pixelated;
  touch-action: none;
  background-color: var(--color-bg-tab-inactive);
  background-image:
    linear-gradient(45deg, rgba(128, 128, 128, 0.25) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(128, 128, 128, 0.25) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(128, 128, 128, 0.25) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(128, 128, 128, 0.25) 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
}

.hint {
  margin: 0;
  padding: 6px 8px;
  border-top: 1px solid var(--color-border);
  font-size: 10px;
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
</style>
