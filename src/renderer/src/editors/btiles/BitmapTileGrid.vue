<script setup lang="ts">
/**
 * The bank, as the grid it will be in VRAM.
 *
 * It is drawn at the sheet's own column count rather than a fixed 16, because
 * that *is* the layout the exported `_Draw` indexes into — so a tile's place
 * here is its place on the machine, and a block cut out of this grid is a block
 * of adjacent tiles in the sheet too.
 */
import { computed, ref, watchEffect } from 'vue'
import { paletteToRgb } from '../../../../shared/msx/palette'
import { sheetCols, sheetPixels } from '../../../../shared/msx/bitmap-tile'
import { doc, selectTile, setSelection, type BitmapTileSession } from './session'

const props = defineProps<{ session: BitmapTileSession }>()
const emit = defineEmits<{ select: [index: number] }>()

/**
 * One screen pixel per tile pixel, always.
 *
 * `sheetCols` is how many tiles fit across VRAM, so the sheet is never wider
 * than 256 dots whatever the tile size — which makes 1:1 both the honest view
 * and a column the editing area can afford. It was drawing at 3×, which put a
 * 768-pixel bank next to a 192-pixel canvas.
 */
const scale = 1

/** Grid coordinates under the pointer, clamped to the bank. */
function cellAt(event: PointerEvent): { col: number; row: number; index: number } | null {
  const box = (event.currentTarget as HTMLCanvasElement).getBoundingClientRect()
  const col = Math.floor((event.clientX - box.left) / (tileset.value.width * scale))
  const row = Math.floor((event.clientY - box.top) / (tileset.value.height * scale))
  if (col < 0 || row < 0 || col >= cols.value) return null
  const index = row * cols.value + col
  return index < tileset.value.count ? { col, row, index } : null
}

let anchor: { col: number; row: number } | null = null

function down(event: PointerEvent): void {
  const cell = cellAt(event)
  if (!cell) return
  ;(event.currentTarget as HTMLCanvasElement).setPointerCapture(event.pointerId)
  anchor = { col: cell.col, row: cell.row }
  setSelection(props.session, null)
  selectTile(props.session, cell.index)
  emit('select', cell.index)
}

/**
 * Dragging marks a rectangle of the bank. It is the same idea as the pattern
 * tile editor's marquee: a block is almost always a group of tiles that are
 * already next to each other, so selecting them is the whole authoring step.
 */
function move(event: PointerEvent): void {
  if (!anchor) return
  const cell = cellAt(event)
  if (!cell) return
  const col0 = Math.min(anchor.col, cell.col)
  const row0 = Math.min(anchor.row, cell.row)
  const width = Math.abs(cell.col - anchor.col) + 1
  const height = Math.abs(cell.row - anchor.row) + 1
  setSelection(props.session, width === 1 && height === 1 ? null : { start: row0 * cols.value + col0, width, height })
}

function up(): void {
  anchor = null
}

const canvas = ref<HTMLCanvasElement | null>(null)
const tileset = computed(() => doc(props.session))
const cols = computed(() => sheetCols(tileset.value))


const sheet = computed(() => sheetPixels(tileset.value))
const width = computed(() => sheet.value.width * scale)
const height = computed(() => sheet.value.height * scale)

watchEffect(() => {
  const element = canvas.value
  if (!element) return
  // Same as the tile canvas: assigning the size clears it, so it happens here
  // and not through a template binding Vue applies afterwards.
  element.width = width.value
  element.height = height.value
  const ctx = element.getContext('2d')
  if (!ctx) return
  const tiles = tileset.value
  const pixels = sheet.value
  const rgb = paletteToRgb(tiles.palette)
  const image = new ImageData(pixels.width, pixels.height)
  for (let i = 0; i < pixels.indices.length; i++) {
    const color = rgb[pixels.indices[i]] ?? { r: 0, g: 0, b: 0 }
    image.data[i * 4] = color.r
    image.data[i * 4 + 1] = color.g
    image.data[i * 4 + 2] = color.b
    image.data[i * 4 + 3] = 255
  }
  const buffer = document.createElement('canvas')
  buffer.width = pixels.width
  buffer.height = pixels.height
  buffer.getContext('2d')?.putImageData(image, 0, 0)

  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, element.width, element.height)
  ctx.drawImage(buffer, 0, 0, element.width, element.height)

  // Slots past `count` are padding in the sheet, not tiles: dim them so the end
  // of the bank is visible rather than implied.
  const cw = tiles.width * scale
  const ch = tiles.height * scale
  const slots = cols.value * Math.ceil(pixels.height / tiles.height)
  ctx.fillStyle = 'rgba(0,0,0,0.55)'
  for (let index = tiles.count; index < slots; index++) {
    ctx.fillRect((index % cols.value) * cw, Math.floor(index / cols.value) * ch, cw, ch)
  }

  const selected = props.session.selected
  ctx.strokeStyle = '#4ea1ff'
  ctx.lineWidth = 2
  ctx.strokeRect((selected % cols.value) * cw + 1, Math.floor(selected / cols.value) * ch + 1, cw - 2, ch - 2)

  const marquee = props.session.selection
  if (marquee) {
    ctx.strokeStyle = '#ffd24e'
    ctx.lineWidth = 2
    ctx.strokeRect(
      (marquee.start % cols.value) * cw + 1,
      Math.floor(marquee.start / cols.value) * ch + 1,
      marquee.width * cw - 2,
      marquee.height * ch - 2
    )
  }
})
</script>

<template>
  <div class="grid-wrap">
    <canvas
      ref="canvas"
      class="grid"
      :style="{ width: `${width}px`, height: `${height}px` }"
      @pointerdown="down"
      @pointermove="move"
      @pointerup="up"
      @pointercancel="up"
    />
  </div>
</template>

<style scoped>
.grid-wrap {
  overflow: auto;
  padding: 4px;
  /* The bank is a fixed column: it never grows, and the canvas gets the rest. */
  flex: 0 0 auto;
  max-width: 272px;
  border-right: 1px solid var(--border, #333);
}
.grid {
  image-rendering: pixelated;
  touch-action: none;
  background: #000;
  border: 1px solid var(--border, #333);
  cursor: pointer;
}
</style>
