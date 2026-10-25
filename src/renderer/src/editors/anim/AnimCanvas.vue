<script setup lang="ts">
/**
 * The pose editor's centre pane: one pose at zoom, with the drawing tools.
 *
 * Coordinates are the pose's own dot space — `width*8 × height*8` — and every
 * stroke goes to `paint` in `./session`, which runs the tile editor's own role
 * strokes against the pose. Nothing here knows a colour rule.
 *
 * For a meta-tile, see-through cells are drawn hatched, and in the see-through
 * mode a click toggles the cell under it instead of painting.
 */
import { computed, ref, watchEffect } from 'vue'
import { paletteToRgb, toHex } from '../../../../shared/msx/palette'
import { fillPoints, linePoints, rectPoints, type Point } from '../../../../shared/tile-editor'
import { beginStroke, doc, endStroke, moveFloat, ownedMeta, paint, posePixels, toggleHole, type AnimSession } from './session'

const props = defineProps<{ session: AnimSession }>()

const canvas = ref<HTMLCanvasElement | null>(null)
const preview = ref<Point[]>([])
let origin: Point | null = null
let painting = false
let role: 'fg' | 'bg' = 'fg'
/** Where a drag of the floating picture took hold of it, in dots from its corner. */
let grab: Point | null = null

const anim = computed(() => doc(props.session))
const cols = computed(() => anim.value.width * 8)
const rows = computed(() => anim.value.height * 8)
const step = computed(() => Math.max(2, props.session.zoom))
const rgb = computed(() => paletteToRgb(null))

function pointAt(event: PointerEvent): Point {
  const rect = (event.currentTarget as HTMLCanvasElement).getBoundingClientRect()
  const x = Math.floor(((event.clientX - rect.left) / rect.width) * cols.value)
  const y = Math.floor(((event.clientY - rect.top) / rect.height) * rows.value)
  return { x: Math.min(cols.value - 1, Math.max(0, x)), y: Math.min(rows.value - 1, Math.max(0, y)) }
}

function pointsFor(from: Point, to: Point): Point[] {
  const { tool, frame } = props.session
  // A fill crosses tile seams: the pose is one picture, not separate cells.
  if (tool === 'fill') return fillPoints(posePixels(props.session, frame).indices, to, cols.value, rows.value)
  if (tool === 'rect') return rectPoints(from, to, props.session.filledRect)
  return linePoints(from, to)
}

function onDown(event: PointerEvent): void {
  const point = pointAt(event)
  const float = props.session.float
  if (float) {
    // While a picture floats, the canvas moves it and paints nothing.
    ;(event.currentTarget as HTMLCanvasElement).setPointerCapture(event.pointerId)
    grab = { x: point.x - float.x, y: point.y - float.y }
    return
  }
  if (props.session.holeMode) {
    toggleHole(props.session, Math.floor(point.y / 8) * anim.value.width + Math.floor(point.x / 8))
    return
  }
  ;(event.currentTarget as HTMLCanvasElement).setPointerCapture(event.pointerId)
  role = event.button === 2 ? 'bg' : 'fg'
  origin = point
  painting = true
  beginStroke(props.session)
  if (props.session.tool === 'pencil' || props.session.tool === 'fill') {
    paint(props.session, pointsFor(point, point), role)
    return
  }
  preview.value = pointsFor(point, point)
}

function onMove(event: PointerEvent): void {
  if (grab) {
    const point = pointAt(event)
    moveFloat(props.session, point.x - grab.x, point.y - grab.y)
    return
  }
  if (!painting || !origin) return
  const point = pointAt(event)
  if (props.session.tool === 'pencil') {
    paint(props.session, pointsFor(origin, point), role)
    origin = point
    return
  }
  if (props.session.tool === 'fill') return
  preview.value = pointsFor(origin, point)
}

function onUp(event: PointerEvent): void {
  grab = null
  if (!painting) return
  painting = false
  const point = pointAt(event)
  if (origin && (props.session.tool === 'line' || props.session.tool === 'rect')) {
    paint(props.session, pointsFor(origin, point), role)
  }
  endStroke(props.session)
  preview.value = []
  origin = null
}

watchEffect(() => {
  const element = canvas.value
  if (!element) return
  const px = step.value
  element.width = cols.value * px
  element.height = rows.value * px
  const context = element.getContext('2d')
  if (!context) return
  const { indices } = posePixels(props.session, props.session.frame)
  for (let y = 0; y < rows.value; y++) {
    for (let x = 0; x < cols.value; x++) {
      const index = indices[y * cols.value + x]
      // Colour 0 is the MSX's transparent entry: drawn as a checkerboard so it
      // reads as "the backdrop shows here", not as black.
      context.fillStyle = index === 0 ? ((x + y) % 2 ? '#3a3a3a' : '#4a4a4a') : toHex(rgb.value[index])
      context.fillRect(x * px, y * px, px, px)
    }
  }
  const holes = ownedMeta(props.session)?.holes ?? []
  holes.forEach((hole, cell) => {
    if (!hole) return
    // Hatched over the art it keeps: the art is still in the file, it is just
    // never drawn — what is under the meta shows here.
    const x0 = (cell % anim.value.width) * 8 * px
    const y0 = Math.floor(cell / anim.value.width) * 8 * px
    const size = 8 * px
    context.fillStyle = 'rgba(20, 20, 20, 0.55)'
    context.fillRect(x0, y0, size, size)
    context.save()
    context.beginPath()
    context.rect(x0, y0, size, size)
    context.clip()
    context.strokeStyle = 'rgba(255, 210, 78, 0.6)'
    context.lineWidth = 1
    context.beginPath()
    for (let d = -size; d < size; d += Math.max(4, px * 2)) {
      context.moveTo(x0 + d, y0 + size)
      context.lineTo(x0 + d + size, y0)
    }
    context.stroke()
    context.restore()
  })
  const float = props.session.float
  if (float) {
    for (let y = 0; y < float.picture.height; y++) {
      for (let x = 0; x < float.picture.width; x++) {
        const index = float.picture.indices[y * float.picture.width + x]
        if (index) {
          context.fillStyle = toHex(rgb.value[index])
          context.fillRect((float.x + x) * px, (float.y + y) * px, px, px)
        }
      }
    }
    context.strokeStyle = '#ffd24e'
    context.setLineDash([4, 3])
    context.strokeRect(float.x * px + 0.5, float.y * px + 0.5, float.picture.width * px - 1, float.picture.height * px - 1)
    context.setLineDash([])
  }
  if (preview.value.length) {
    context.globalAlpha = 0.6
    context.fillStyle = toHex(rgb.value[props.session.color])
    for (const point of preview.value) context.fillRect(point.x * px, point.y * px, px, px)
    context.globalAlpha = 1
  }
  context.lineWidth = 1
  for (let x = 1; x < cols.value; x++) {
    // Tile seams stand out: each is a slot of the window, and where a row's
    // two-colour rule starts over.
    context.strokeStyle = x % 8 === 0 ? 'rgba(120, 170, 255, 0.7)' : 'rgba(255, 255, 255, 0.12)'
    context.beginPath()
    context.moveTo(x * px + 0.5, 0)
    context.lineTo(x * px + 0.5, rows.value * px)
    context.stroke()
  }
  for (let y = 1; y < rows.value; y++) {
    context.strokeStyle = y % 8 === 0 ? 'rgba(120, 170, 255, 0.7)' : 'rgba(255, 255, 255, 0.12)'
    context.beginPath()
    context.moveTo(0, y * px + 0.5)
    context.lineTo(cols.value * px, y * px + 0.5)
    context.stroke()
  }
})
</script>

<template>
  <div class="anim-canvas">
    <canvas
      ref="canvas"
      :class="{ holes: session.holeMode, floating: session.float }"
      @contextmenu.prevent
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
    />
  </div>
</template>

<style scoped>
.anim-canvas {
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

canvas.holes {
  cursor: cell;
}

canvas.floating {
  cursor: move;
}
</style>
