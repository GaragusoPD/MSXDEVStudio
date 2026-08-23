<script setup lang="ts">
/**
 * The meta-tile editor's centre pane: one frame as a picture, at zoom, with the
 * drawing tools.
 *
 * Coordinates are the meta's own pixel space — `width*8 × height*8` — and every
 * stroke goes to `paint`, which resolves it to tile indices. Nothing here knows
 * that a meta is made of tiles at all, beyond drawing the seams.
 *
 * Cells holding tile 0 are drawn as the checkerboard rather than as tile 0's
 * pixels: a meta is see-through there, and showing the reserved blank as a
 * solid colour would make transparency invisible until the game ran.
 */
import { computed, ref, watchEffect } from 'vue'
import { paletteToRgb, toHex } from '../../../../shared/msx/palette'
import { tilePixels } from '../../../../shared/msx/tile'
import { tileImage } from '../../../../shared/msx/bitmap-tile'
import { frameTileAt } from '../../../../shared/msx/meta-tile'
import { sprayPoints } from '../../../../shared/msx/meta-paint'
import { fillPoints, linePoints, rectPoints, type Point } from '../../../../shared/tile-editor'
import { cellSize, doc, paint, tiles, type MetaSession } from './session'

const props = defineProps<{ session: MetaSession }>()

const canvas = ref<HTMLCanvasElement | null>(null)
const preview = ref<Point[]>([])
let origin: Point | null = null
let painting = false

const meta = computed(() => doc(props.session))
/** 8×8 in a pattern mode; whatever the bitmap tileset says otherwise. */
const cellPx = computed(() => cellSize(props.session))
const cols = computed(() => meta.value.width * cellPx.value.width)
const rows = computed(() => meta.value.height * cellPx.value.height)
const step = computed(() => Math.max(2, props.session.zoom))
const width = computed(() => cols.value * step.value)
const height = computed(() => rows.value * step.value)
const rgb = computed(() =>
  paletteToRgb(props.session.bitmapTileset?.palette ?? tiles(props.session)?.palette ?? null)
)

/**
 * One frame composed into palette indices, with transparent cells left at 0.
 *
 * Index 0 is ambiguous on its own — it is both "the transparent tile" and "the
 * transparent colour" — but they render the same way, so the canvas does not
 * need to tell them apart.
 */
function framePixels(frame: number): Uint8Array {
  const out = new Uint8Array(cols.value * rows.value)
  const pattern = tiles(props.session)
  const bitmap = props.session.bitmapTileset
  if (!pattern && !bitmap) return out
  const { width: cw, height: ch } = cellPx.value
  for (let cy = 0; cy < meta.value.height; cy++) {
    for (let cx = 0; cx < meta.value.width; cx++) {
      const tile = frameTileAt(meta.value, frame, cx, cy)
      // Tile 0 is the hole: left at index 0 so the checkerboard shows through.
      if (tile === 0) continue
      const pixels = bitmap ? tileImage(bitmap, tile) : tilePixels(pattern!, tile)
      for (let y = 0; y < ch; y++) {
        out.set(pixels.subarray(y * cw, y * cw + cw), (cy * ch + y) * cols.value + cx * cw)
      }
    }
  }
  return out
}

function pointAt(event: PointerEvent): Point {
  const rect = (event.currentTarget as HTMLCanvasElement).getBoundingClientRect()
  const x = Math.floor(((event.clientX - rect.left) / rect.width) * cols.value)
  const y = Math.floor(((event.clientY - rect.top) / rect.height) * rows.value)
  return { x: Math.min(cols.value - 1, Math.max(0, x)), y: Math.min(rows.value - 1, Math.max(0, y)) }
}

/**
 * The points a tool covers between its origin and the pointer.
 *
 * The primitives are called directly rather than through `toolPoints`, which
 * exists for the tile editor: its `fill` is hardcoded to one 8×8 cell and it
 * has no case for spray. Both of those are the two tools that differ here.
 */
function pointsFor(from: Point, to: Point): Point[] {
  const { tool, brushRadius, density } = props.session
  if (tool === 'spray') return sprayPoints(to, brushRadius, density)
  // A fill crosses tile seams: the user drew one shape, not four.
  if (tool === 'fill') return fillPoints(framePixels(props.session.frame), to, cols.value, rows.value)
  if (tool === 'rect') return rectPoints(from, to, props.session.filledRect)
  return linePoints(from, to)
}

function onDown(event: PointerEvent): void {
  ;(event.currentTarget as HTMLCanvasElement).setPointerCapture(event.pointerId)
  const point = pointAt(event)
  origin = point
  painting = true
  // Fill and spray commit as they go; line and rect show a preview and commit
  // on release, which is what makes them draggable.
  if (props.session.tool === 'fill' || props.session.tool === 'spray' || props.session.tool === 'pencil') {
    paint(props.session, pointsFor(point, point))
    return
  }
  preview.value = pointsFor(point, point)
}

function onMove(event: PointerEvent): void {
  if (!painting || !origin) return
  const point = pointAt(event)
  if (props.session.tool === 'pencil' || props.session.tool === 'spray') {
    paint(props.session, pointsFor(origin, point))
    origin = point
    return
  }
  if (props.session.tool === 'fill') return
  preview.value = pointsFor(origin, point)
}

function onUp(event: PointerEvent): void {
  if (!painting) return
  painting = false
  const point = pointAt(event)
  if (origin && (props.session.tool === 'line' || props.session.tool === 'rect')) {
    paint(props.session, pointsFor(origin, point))
  }
  preview.value = []
  origin = null
}

watchEffect(() => {
  const element = canvas.value
  if (!element) return
  const px = step.value
  element.width = width.value
  element.height = height.value
  const context = element.getContext('2d')
  if (!context) return

  // The checkerboard shows wherever nothing is drawn — both a transparent cell
  // and a transparent pixel inside an opaque one.
  context.fillStyle = '#3a3a3a'
  context.fillRect(0, 0, width.value, height.value)
  context.fillStyle = '#4a4a4a'
  for (let y = 0; y < rows.value; y++) {
    for (let x = 0; x < cols.value; x++) {
      if ((x + y) % 2 === 0) context.fillRect(x * px, y * px, px, px)
    }
  }

  const draw = (pixels: Uint8Array, alpha: number): void => {
    context.globalAlpha = alpha
    for (let y = 0; y < rows.value; y++) {
      for (let x = 0; x < cols.value; x++) {
        const index = pixels[y * cols.value + x]
        if (index === 0) continue
        context.fillStyle = toHex(rgb.value[index])
        context.fillRect(x * px, y * px, px, px)
      }
    }
    context.globalAlpha = 1
  }

  // The previous frame underneath, faint, so a walk cycle can be lined up
  // against the pose it follows.
  if (props.session.onionSkin && props.session.frame > 0) draw(framePixels(props.session.frame - 1), 0.3)
  draw(framePixels(props.session.frame), 1)

  if (preview.value.length) {
    context.globalAlpha = 0.6
    context.fillStyle = toHex(rgb.value[props.session.color])
    for (const point of preview.value) context.fillRect(point.x * px, point.y * px, px, px)
    context.globalAlpha = 1
  }

  if (!props.session.gridVisible) return
  context.lineWidth = 1
  for (let x = 1; x < cols.value; x++) {
    // Tile seams stand out: each is where one name-table entry ends and the
    // next begins, which is where the mode's colour rules reset.
    context.strokeStyle = x % cellPx.value.width === 0 ? 'rgba(120, 170, 255, 0.7)' : 'rgba(255, 255, 255, 0.14)'
    context.beginPath()
    context.moveTo(x * px + 0.5, 0)
    context.lineTo(x * px + 0.5, height.value)
    context.stroke()
  }
  for (let y = 1; y < rows.value; y++) {
    context.strokeStyle = y % cellPx.value.height === 0 ? 'rgba(120, 170, 255, 0.7)' : 'rgba(255, 255, 255, 0.14)'
    context.beginPath()
    context.moveTo(0, y * px + 0.5)
    context.lineTo(width.value, y * px + 0.5)
    context.stroke()
  }
})
</script>

<template>
  <div class="meta-canvas">
    <canvas
      ref="canvas"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
    />
  </div>
</template>

<style scoped>
.meta-canvas {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  overflow: auto;
  padding: 16px;
}

canvas {
  image-rendering: pixelated;
  cursor: crosshair;
  box-shadow: 0 0 0 1px var(--border, #444);
}
</style>
