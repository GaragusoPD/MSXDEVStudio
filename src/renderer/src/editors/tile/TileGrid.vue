<script setup lang="ts">
/**
 * Spec 08's left pane: the whole bank, 16 tiles per row, zoomable, with single
 * and marquee selection and drag-to-reorder.
 *
 * ponytail: the sheet is redrawn whole on every document change (256 tiles =
 * one ImageData of 16 384 pixels plus a `drawImage` per tile row). If that ever
 * shows up while painting, cache the sheet and repaint only the edited tile.
 */
import { computed, ref, watchEffect } from 'vue'
import { paletteToRgb } from '../../../../shared/msx/palette'
import { tilePixels, TILE_SIZE } from '../../../../shared/msx/tile'
import { marqueeIndices } from '../../../../shared/tile-editor'
import { addTile, reorder, select, zoom, type TileSession } from './session'

const props = defineProps<{ session: TileSession }>()

const COLUMNS = 16

const canvas = ref<HTMLCanvasElement | null>(null)
const dropTarget = ref<number | null>(null)
const hover = ref<number | null>(null)
let dragFrom: number | null = null

const cell = computed(() => props.session.gridZoom)
const labelled = computed(() => cell.value >= 32)
const cellHeight = computed(() => cell.value + (labelled.value ? 11 : 0))
const rows = computed(() => Math.ceil(props.session.doc.count / COLUMNS))

const hex = (index: number): string => `0x${index.toString(16).toUpperCase().padStart(2, '0')}`

function indexAt(event: PointerEvent): number | null {
  const rect = (event.currentTarget as HTMLCanvasElement).getBoundingClientRect()
  const x = Math.floor((event.clientX - rect.left) / cell.value)
  const y = Math.floor((event.clientY - rect.top) / cellHeight.value)
  if (x < 0 || x >= COLUMNS || y < 0) return null
  const index = y * COLUMNS + x
  return index < props.session.doc.count ? index : null
}

function onDown(event: PointerEvent): void {
  const index = indexAt(event)
  if (index === null) return
  ;(event.currentTarget as HTMLCanvasElement).setPointerCapture(event.pointerId)
  if (event.shiftKey) {
    select(props.session, index, marqueeIndices(props.session.active, index, COLUMNS, props.session.doc.count))
    return
  }
  select(props.session, index)
  dragFrom = index
}

function onMove(event: PointerEvent): void {
  hover.value = indexAt(event)
  if (dragFrom === null) return
  dropTarget.value = hover.value
}

function onUp(): void {
  const from = dragFrom
  const to = dropTarget.value
  dragFrom = null
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
  element.width = COLUMNS * size
  element.height = Math.max(1, rows.value) * height
  const context = element.getContext('2d')
  if (!context) return
  context.clearRect(0, 0, element.width, element.height)

  // One 8-bit-per-pixel sheet, then one scaled blit per tile row.
  const rgb = paletteToRgb(doc.palette)
  const sheet = new ImageData(COLUMNS * TILE_SIZE, Math.max(1, rows.value) * TILE_SIZE)
  for (let index = 0; index < doc.count; index++) {
    const pixels = tilePixels(doc, index)
    const ox = (index % COLUMNS) * TILE_SIZE
    const oy = Math.floor(index / COLUMNS) * TILE_SIZE
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
      COLUMNS * size,
      size
    )
  }

  if (labelled.value) {
    context.font = '9px monospace'
    context.fillStyle = 'rgba(180, 180, 180, 0.9)'
    for (let index = 0; index < doc.count; index++) {
      const x = (index % COLUMNS) * size
      const y = Math.floor(index / COLUMNS) * height
      context.fillText(`${index} ${hex(index)}`, x + 2, y + size + 9, size - 4)
    }
  }

  context.lineWidth = 2
  for (const index of selection) {
    context.strokeStyle = index === active ? '#ffffff' : 'rgba(255, 255, 255, 0.45)'
    context.strokeRect(
      (index % COLUMNS) * size + 1,
      Math.floor(index / COLUMNS) * height + 1,
      size - 2,
      size - 2
    )
  }

  if (dropTarget.value !== null && dropTarget.value !== dragFrom) {
    context.strokeStyle = '#007acc'
    context.strokeRect(
      (dropTarget.value % COLUMNS) * size + 1,
      Math.floor(dropTarget.value / COLUMNS) * height + 1,
      size - 2,
      size - 2
    )
  }
})
</script>

<template>
  <div class="grid-pane">
    <header>
      <span class="title">{{ session.doc.count }} tiles</span>
      <span class="readout">{{ hover ?? session.active }} · {{ hex(hover ?? session.active) }}</span>
      <button
        type="button"
        title="Zoom out"
        @click="zoom(session, 'gridZoom', -8)"
      >
        −
      </button>
      <button
        type="button"
        title="Zoom in"
        @click="zoom(session, 'gridZoom', 8)"
      >
        +
      </button>
      <button
        type="button"
        title="Append a blank tile"
        @click="addTile(session)"
      >
        +tile
      </button>
    </header>
    <div class="scroller">
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
    <p class="hint">
      Click to select · Shift+click for a rectangle · drag a tile onto another to reorder.
    </p>
  </div>
</template>

<style scoped>
.grid-pane {
  display: flex;
  flex: none;
  flex-direction: column;
  min-height: 0;
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
  overflow: auto;
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
</style>
