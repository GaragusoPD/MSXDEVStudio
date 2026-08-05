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
import { doc, type BitmapTileSession } from './session'

const props = defineProps<{ session: BitmapTileSession }>()
const emit = defineEmits<{ select: [index: number] }>()

const canvas = ref<HTMLCanvasElement | null>(null)
const tileset = computed(() => doc(props.session))
const cols = computed(() => sheetCols(tileset.value))
/** Enough to recognise a tile, capped so a big bank still fits the pane. */
const step = computed(() => Math.max(1, Math.min(3, Math.floor(192 / cols.value / Math.max(1, tileset.value.width) * 4))))
const scale = computed(() => Math.max(1, step.value))

const sheet = computed(() => sheetPixels(tileset.value))
const width = computed(() => sheet.value.width * scale.value)
const height = computed(() => sheet.value.height * scale.value)

function click(event: MouseEvent): void {
  const box = (event.currentTarget as HTMLCanvasElement).getBoundingClientRect()
  const x = Math.floor((event.clientX - box.left) / (tileset.value.width * scale.value))
  const y = Math.floor((event.clientY - box.top) / (tileset.value.height * scale.value))
  const index = y * cols.value + x
  if (index >= 0 && index < tileset.value.count) emit('select', index)
}

watchEffect(() => {
  const element = canvas.value
  const ctx = element?.getContext('2d')
  if (!element || !ctx) return
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
  const cw = tiles.width * scale.value
  const ch = tiles.height * scale.value
  const slots = cols.value * Math.ceil(pixels.height / tiles.height)
  ctx.fillStyle = 'rgba(0,0,0,0.55)'
  for (let index = tiles.count; index < slots; index++) {
    ctx.fillRect((index % cols.value) * cw, Math.floor(index / cols.value) * ch, cw, ch)
  }

  const selected = props.session.selected
  ctx.strokeStyle = '#4ea1ff'
  ctx.lineWidth = 2
  ctx.strokeRect((selected % cols.value) * cw + 1, Math.floor(selected / cols.value) * ch + 1, cw - 2, ch - 2)
})
</script>

<template>
  <div class="grid-wrap">
    <canvas
      ref="canvas"
      class="grid"
      :width="width"
      :height="height"
      :style="{ width: `${width}px`, height: `${height}px` }"
      @click="click"
    />
  </div>
</template>

<style scoped>
.grid-wrap {
  overflow: auto;
  padding: 4px;
}
.grid {
  image-rendering: pixelated;
  background: #000;
  border: 1px solid var(--border, #333);
  cursor: pointer;
}
</style>
