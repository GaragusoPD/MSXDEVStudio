<script setup lang="ts">
/**
 * The selected tile at large zoom, and the pointer handling that paints it.
 *
 * Simpler than `tile/TileCanvas.vue` because a bitmap tile has no colour
 * constraint to violate: every pixel is an independent palette index, so there
 * is no conflict popover and no foreground/background role — a stroke is just
 * points and a colour. All the logic lives in `shared/bitmap-tile-editor.ts`;
 * this only turns pointer events into tile coordinates and paints the result.
 */
import { computed, ref, watchEffect } from 'vue'
import { paletteToRgb } from '../../../../shared/msx/palette'
import { tileImage } from '../../../../shared/msx/bitmap-tile'
import { bitmapToolPoints, type Point } from '../../../../shared/bitmap-tile-editor'
import { doc, strokeEnd, strokeMove, strokeStart, type BitmapTileSession } from './session'

const props = defineProps<{ session: BitmapTileSession }>()

const canvas = ref<HTMLCanvasElement | null>(null)
const preview = ref<Point[]>([])
let origin: Point | null = null

const tileset = computed(() => doc(props.session))
/**
 * The zoom slider drives this directly, capped so even a 64×64 tile stays on
 * screen. The old formula scaled the zoom *down* by the tile size, so a 16×16
 * tile at maximum zoom came out 192 pixels across — smaller than the bank
 * beside it.
 */
const MAX_CANVAS = 640
const step = computed(() =>
  Math.max(2, Math.min(props.session.zoom, Math.floor(MAX_CANVAS / Math.max(tileset.value.width, tileset.value.height))))
)
const width = computed(() => tileset.value.width * step.value)
const height = computed(() => tileset.value.height * step.value)
const rgb = computed(() => paletteToRgb(tileset.value.palette))

function pointAt(event: PointerEvent): Point {
  const box = (event.currentTarget as HTMLCanvasElement).getBoundingClientRect()
  return {
    x: Math.floor((event.clientX - box.left) / step.value),
    y: Math.floor((event.clientY - box.top) / step.value)
  }
}

function down(event: PointerEvent): void {
  if (event.button !== 0) return
  ;(event.currentTarget as HTMLCanvasElement).setPointerCapture(event.pointerId)
  origin = pointAt(event)
  strokeStart(props.session, origin)
  preview.value = []
}

function move(event: PointerEvent): void {
  const point = pointAt(event)
  if (!origin) return
  // A rubber-band tool shows where it *would* land; the pencil has already
  // painted, so it has nothing to preview.
  if (props.session.tool === 'pencil' || props.session.tool === 'fill') {
    strokeMove(props.session, point)
    return
  }
  const pixels = tileImage(tileset.value, props.session.selected)
  preview.value = bitmapToolPoints(
    props.session.tool, origin, point, pixels, tileset.value.width, tileset.value.height, props.session.filled
  )
}

function up(event: PointerEvent): void {
  if (!origin) return
  const point = pointAt(event)
  if (props.session.tool !== 'pencil' && props.session.tool !== 'fill') strokeMove(props.session, point)
  strokeEnd(props.session)
  origin = null
  preview.value = []
}

watchEffect(() => {
  const element = canvas.value
  if (!element) return
  // Sized here rather than bound in the template: assigning width/height clears
  // the canvas, and Vue patches attributes *after* this effect runs — so a
  // template binding wipes everything just drawn. Changing the zoom did exactly
  // that, and left the tile blank.
  element.width = width.value
  element.height = height.value
  const ctx = element.getContext('2d')
  if (!ctx) return
  const tiles = tileset.value
  const pixels = tileImage(tiles, props.session.selected)
  const cell = step.value
  ctx.clearRect(0, 0, element.width, element.height)
  for (let y = 0; y < tiles.height; y++) {
    for (let x = 0; x < tiles.width; x++) {
      const color = rgb.value[pixels[y * tiles.width + x]] ?? { r: 0, g: 0, b: 0 }
      ctx.fillStyle = `rgb(${color.r},${color.g},${color.b})`
      ctx.fillRect(x * cell, y * cell, cell, cell)
    }
  }
  // The rubber band, drawn over the art rather than into it.
  if (preview.value.length) {
    const color = rgb.value[props.session.color] ?? { r: 255, g: 255, b: 255 }
    ctx.fillStyle = `rgba(${color.r},${color.g},${color.b},0.7)`
    for (const point of preview.value) ctx.fillRect(point.x * cell, point.y * cell, cell, cell)
  }
  // A pixel grid, but only once the pixels are big enough for it to help.
  if (cell >= 6) {
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'
    ctx.lineWidth = 1
    for (let x = 1; x < tiles.width; x++) {
      ctx.beginPath(); ctx.moveTo(x * cell + 0.5, 0); ctx.lineTo(x * cell + 0.5, tiles.height * cell); ctx.stroke()
    }
    for (let y = 1; y < tiles.height; y++) {
      ctx.beginPath(); ctx.moveTo(0, y * cell + 0.5); ctx.lineTo(tiles.width * cell, y * cell + 0.5); ctx.stroke()
    }
  }
})
</script>

<template>
  <canvas
    ref="canvas"
    class="tile-canvas"
    :style="{ width: `${width}px`, height: `${height}px` }"
    @pointerdown="down"
    @pointermove="move"
    @pointerup="up"
    @pointercancel="up"
    @contextmenu.prevent
  />
</template>

<style scoped>
.tile-canvas {
  image-rendering: pixelated;
  background: #000;
  border: 1px solid var(--border, #333);
  cursor: crosshair;
  touch-action: none;
}
</style>
