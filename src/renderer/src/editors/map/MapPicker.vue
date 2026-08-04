<script setup lang="ts">
/**
 * Spec 10 A's left pane: the referenced tileset rendered with its real
 * palette. Click picks a single-tile stamp; shift+click (or drag) picks a
 * rectangular multi-tile stamp — same marquee gesture `TileGrid.vue` uses for
 * its own selection, built into a `Stamp` via `stampFromMarquee`.
 */
import { computed, onBeforeUnmount, ref, watch, watchEffect } from 'vue'
import { paletteToRgb } from '../../../../shared/msx/palette'
import { tilePixels, TILE_SIZE } from '../../../../shared/msx/tile'
import { singleStamp, stampFromMarquee } from '../../../../shared/map-editor'
import { fitColumns } from '../../../../shared/tile-editor'
import { pickTile, type MapSession } from './session'

const props = defineProps<{ session: MapSession }>()

const canvas = ref<HTMLCanvasElement | null>(null)
const scroller = ref<HTMLElement | null>(null)
const hover = ref<number | null>(null)
let dragAnchor: number | null = null

const cell = computed(() => props.session.pickerZoom)
const count = computed(() => props.session.tileset?.count ?? 0)

/** Same as `TileGrid.vue`: the sheet wraps into the pane instead of scrolling off the side of it. */
const paneWidth = ref(0)
const COLUMNS = computed(() => fitColumns(paneWidth.value, cell.value, count.value))
const rows = computed(() => Math.max(1, Math.ceil(count.value / COLUMNS.value)))

// The scroller only exists once a tileset has loaded, so this follows the ref
// rather than grabbing it on mount.
const observer = new ResizeObserver(([entry]) => {
  paneWidth.value = entry.contentRect.width
})
watch(
  scroller,
  (element) => {
    observer.disconnect()
    if (element) observer.observe(element)
  },
  { flush: 'post' }
)
onBeforeUnmount(() => observer.disconnect())

const hex = (index: number): string => `0x${index.toString(16).toUpperCase().padStart(2, '0')}`

function indexAt(event: PointerEvent): number | null {
  const rect = (event.currentTarget as HTMLCanvasElement).getBoundingClientRect()
  const x = Math.floor((event.clientX - rect.left) / cell.value)
  const y = Math.floor((event.clientY - rect.top) / cell.value)
  if (x < 0 || x >= COLUMNS.value || y < 0) return null
  const index = y * COLUMNS.value + x
  return index < count.value ? index : null
}

function pick(anchor: number, focus: number): void {
  if (anchor === focus) {
    pickTile(props.session, focus, [focus], singleStamp(focus))
    return
  }
  const stamp = stampFromMarquee(anchor, focus, COLUMNS.value, count.value)
  const indices: number[] = []
  for (let y = 0; y < stamp.height; y++) {
    for (let x = 0; x < stamp.width; x++) indices.push(stamp.tiles[y * stamp.width + x])
  }
  pickTile(props.session, focus, indices, stamp)
}

function onDown(event: PointerEvent): void {
  const index = indexAt(event)
  if (index === null) return
  ;(event.currentTarget as HTMLCanvasElement).setPointerCapture(event.pointerId)
  dragAnchor = event.shiftKey ? props.session.pickerActive : index
  pick(dragAnchor, index)
}

function onMove(event: PointerEvent): void {
  hover.value = indexAt(event)
  if (dragAnchor === null || hover.value === null) return
  pick(dragAnchor, hover.value)
}

function onUp(): void {
  dragAnchor = null
}

watchEffect(() => {
  const element = canvas.value
  const tileset = props.session.tileset
  if (!element || !tileset) return
  const size = cell.value
  element.width = COLUMNS.value * size
  element.height = rows.value * size
  const context = element.getContext('2d')
  if (!context) return
  context.clearRect(0, 0, element.width, element.height)

  const rgb = paletteToRgb(tileset.palette)
  const sheet = new ImageData(COLUMNS.value * TILE_SIZE, rows.value * TILE_SIZE)
  for (let index = 0; index < tileset.count; index++) {
    const pixels = tilePixels(tileset, index)
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
        sheet.data[at + 3] = 255
      }
    }
  }
  const source = document.createElement('canvas')
  source.width = sheet.width
  source.height = sheet.height
  source.getContext('2d')?.putImageData(sheet, 0, 0)
  context.imageSmoothingEnabled = false
  for (let row = 0; row < rows.value; row++) {
    context.drawImage(source, 0, row * TILE_SIZE, sheet.width, TILE_SIZE, 0, row * size, COLUMNS.value * size, size)
  }

  context.lineWidth = 2
  for (const index of props.session.pickerSelection) {
    context.strokeStyle = index === props.session.pickerActive ? '#ffffff' : 'rgba(255, 255, 255, 0.45)'
    context.strokeRect((index % COLUMNS.value) * size + 1, Math.floor(index / COLUMNS.value) * size + 1, size - 2, size - 2)
  }
})
</script>

<template>
  <div class="picker-pane">
    <header>
      <span class="title">Tileset</span>
      <span class="readout">{{ hover ?? session.pickerActive }} · {{ hex(hover ?? session.pickerActive) }}</span>
    </header>
    <p
      v-if="!session.tileset"
      class="hint"
    >
      {{ session.tilesetError ?? 'No tileset.' }}
    </p>
    <div
      v-else
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
    <p class="hint">
      Click to pick a tile · shift+click (or drag) for a multi-tile stamp.
    </p>
  </div>
</template>

<style scoped>
.picker-pane {
  display: flex;
  flex: none;
  flex-direction: column;
  min-height: 0;
  width: 260px;
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
</style>
