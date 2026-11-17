<script setup lang="ts">
/**
 * The bitmap meta-tile editor's centre pane: one frame as a picture, at zoom,
 * with the drawing tools.
 *
 * Coordinates are the meta's own pixel space — its size times the tileset's
 * tile size — and every
 * stroke goes to `paint`, which resolves it to tile indices. Nothing here knows
 * that a meta is made of tiles at all, beyond drawing the seams.
 *
 * Cells holding tile 0 are drawn as the checkerboard rather than as tile 0's
 * pixels: a meta is see-through there, and showing the reserved blank as a
 * solid colour would make transparency invisible until the game ran.
 */
import { computed, ref, watchEffect } from 'vue'
import { toHex } from '../../../../shared/msx/palette'
import { sprayPoints } from '../../../../shared/msx/meta-paint'
import { fillPoints, linePoints, rectPoints, type Point } from '../../../../shared/tile-editor'
import { beginStroke, cellSize, doc, endStroke, framePalette, framePixels as composeFrame, paint, setZoom, type MetaSession } from './session'
import { useWheelZoom } from '../../composables/useWheelZoom'

const props = defineProps<{ session: MetaSession }>()

const canvas = ref<HTMLCanvasElement | null>(null)
const pane = ref<HTMLElement | null>(null)
useWheelZoom(pane, { get: () => props.session.zoom, set: (zoom) => setZoom(props.session, zoom), min: 2, max: 48, quantum: 2 })
const preview = ref<Point[]>([])
let origin: Point | null = null
let painting = false
// Which half of the row's colour pair the stroke owns, fixed by whichever
// button started it — the tile editor's convention. Without it, sc2/sc4's
// two-colours-per-row rule silently swallows every colour after the first.
let role: 'fg' | 'bg' = 'fg'

const meta = computed(() => doc(props.session))
/** Whatever the bitmap tileset says a tile is. */
const cellPx = computed(() => cellSize(props.session))
const cols = computed(() => meta.value.width * cellPx.value.width)
const rows = computed(() => meta.value.height * cellPx.value.height)
const step = computed(() => Math.max(2, props.session.zoom))
const width = computed(() => cols.value * step.value)
const height = computed(() => rows.value * step.value)
const rgb = computed(() => framePalette(props.session))

/**
 * One frame composed into palette indices, see-through dots at 0 — the same
 * composition the animation bar previews, from `./session`.
 */
function framePixels(frame: number): Uint8Array {
  return composeFrame(props.session, frame).indices
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
  // The middle button pans the pane (`useWheelZoom`); it never draws.
  if (event.button === 1) return
  ;(event.currentTarget as HTMLCanvasElement).setPointerCapture(event.pointerId)
  const point = pointAt(event)
  role = event.button === 2 ? 'bg' : 'fg'
  origin = point
  painting = true
  // One stroke, one resolution against the bank. Without this a drag mints a
  // tile per pointer sample — every intermediate shape of one line.
  beginStroke(props.session, role)
  if (props.session.tool === 'fill' || props.session.tool === 'spray' || props.session.tool === 'pencil') {
    paint(props.session, pointsFor(point, point), role)
    return
  }
  preview.value = pointsFor(point, point)
}

function onMove(event: PointerEvent): void {
  if (!painting || !origin) return
  const point = pointAt(event)
  if (props.session.tool === 'pencil' || props.session.tool === 'spray') {
    paint(props.session, pointsFor(origin, point), role)
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
    paint(props.session, pointsFor(origin, point), role)
  }
  // Resolves the whole drag into the tiles its final shape actually needs, and
  // into one undo step.
  endStroke(props.session)
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
  <div
    ref="pane"
    class="meta-canvas"
  >
    <canvas
      ref="canvas"
      @contextmenu.prevent
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
