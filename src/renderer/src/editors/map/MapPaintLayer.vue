<script setup lang="ts">
/**
 * The map canvas's second input path: pixels, not cells.
 *
 * A transparent overlay that sits exactly over `MapCanvas.vue`'s canvas and
 * turns pointer events into `beginPaint`/`extendPaint`/`endPaint` calls on the
 * session. Nothing here decides a coordinate: `paintPointAt` turns an offset
 * into a dot and `paintDotSize` turns a dot back into pixels, and both are
 * tested against each other; the tool, the origin of a line and the flood of a
 * fill all live in `session.ts`, which is the layer vitest covers. This file
 * is not.
 *
 * One feeding rule for every tool: each segment runs from the previous sample
 * to the current one. A pencil or spray wants exactly that; a line, a rect or a
 * fill ignores `from` past the first sample and draws from the origin the
 * session recorded — so the component does not need to know which tool is
 * live, and cannot get the two backwards.
 *
 * It also shows the stroke while it is being drawn. Painting resolves once,
 * on release, so mid-drag there is nothing in the tileset to draw from; the
 * preview canvas below draws the points the drag has accumulated instead, and
 * never touches the tileset.
 */
import { computed, onUnmounted, ref, watchEffect } from 'vue'
import type { Point } from '../../../../shared/map-editor'
import { paletteToRgb, toHex } from '../../../../shared/msx/palette'
import {
  beginPaint,
  doc,
  endPaint,
  extendPaint,
  paintDotSize,
  paintPointAt,
  paintPreviewPoints,
  type MapSession
} from './session'

const props = defineProps<{ session: MapSession }>()

const preview = ref<HTMLCanvasElement | null>(null)

/** The previous pointer sample while a button is down; null between strokes. */
let from: Point | null = null

function onDown(event: PointerEvent): void {
  // Captured, so a drag that leaves the canvas keeps painting — `paintPointAt`
  // is unclamped for exactly this, and `paintGrid` drops what falls outside.
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  const point = paintPointAt(props.session, event.offsetX, event.offsetY)
  // The button that starts the stroke fixes its role for the whole drag — the
  // tile and meta editors' convention.
  beginPaint(props.session, event.button === 2 ? 'bg' : 'fg')
  // A click must paint: a zero-length segment is the pencil's dot, the spray's
  // first burst and the only point a fill can flood from. For a line or a rect
  // it is a one-dot shape the first move replaces.
  extendPaint(props.session, point, point)
  from = point
}

function onMove(event: PointerEvent): void {
  if (!from) return
  const to = paintPointAt(props.session, event.offsetX, event.offsetY)
  extendPaint(props.session, from, to)
  from = to
}

function onUp(): void {
  if (!from) return
  from = null
  endPaint(props.session)
}

// A mode flip or a tileset swap mid-drag unmounts this layer before any
// pointerup can reach it. Resolve what was drawn rather than drop it — a
// no-op when no stroke is open.
onUnmounted(() => {
  from = null
  endPaint(props.session)
})

const rgb = computed(() => (props.session.tileset ? paletteToRgb(props.session.tileset.palette) : null))

/**
 * The stroke in progress, drawn from `paintPreviewPoints` — so it redraws on
 * every `extendPaint`, and empties in the same flush that `endPaint` hands
 * the real canvas its new tiles, refused or not; a preview left up past that
 * would double-draw, or show art that was never committed.
 *
 * The colour is the flat palette colour. What the hardware's two-colours-per-
 * row rule makes of it is `paintPixel`'s decision at resolve time, made in one
 * place and not re-made here: a dot it later refuses is reported by the status
 * line, and the preview was honest about what was asked for.
 */
watchEffect(() => {
  const element = preview.value
  if (!element) return
  const current = doc(props.session)
  const width = current.width * props.session.zoom
  const height = current.height * props.session.zoom
  // Sized like `.map-canvas`, so one bitmap pixel is one CSS pixel over it.
  // Assigning a size clears the bitmap, so only do it when the size moved.
  if (element.width !== width || element.height !== height) {
    element.width = width
    element.height = height
  }
  const ctx = element.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, width, height)
  const points = paintPreviewPoints(props.session)
  const color = rgb.value?.[props.session.paintColor]
  if (!points.length || !color) return
  const size = paintDotSize(props.session)
  ctx.globalAlpha = 0.6
  ctx.fillStyle = toHex(color)
  // One path, one fill: a pencil's segments share their endpoints, so every
  // pointer sample is in `points` twice, and filling rect by rect would stamp
  // it twice — a brighter bead at each sample along an otherwise even stroke.
  ctx.beginPath()
  for (const point of points) ctx.rect(point.x * size, point.y * size, size, size)
  ctx.fill()
  ctx.globalAlpha = 1
})
</script>

<template>
  <div
    class="paint-layer"
    @pointerdown="onDown"
    @pointermove="onMove"
    @pointerup="onUp"
    @pointercancel="onUp"
    @contextmenu.prevent
  >
    <canvas
      ref="preview"
      class="paint-preview"
    />
  </div>
</template>

<style scoped>
/*
 * Exactly the canvas's box. `offsetX`/`offsetY` are measured from the padding
 * edge, so this must carry the same 1px border `.map-canvas` does (transparent
 * here) or every offset is one pixel off. `content-box` against the global
 * `border-box` reset, because the canvas has no CSS width: its intrinsic size
 * is its content box and the border rides outside, which is what `100%` plus a
 * border reproduces. If `.map-canvas`'s border width ever changes, so must this.
 */
.paint-layer {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  box-sizing: content-box;
  border: 1px solid transparent;
  touch-action: none;
  cursor: crosshair;
}

/*
 * The preview bitmap, over the map canvas's pixels: the layer is positioned,
 * so `top: 0; left: 0` is its padding edge — inside the border above, which
 * is where `.map-canvas`'s content starts. No CSS size, so the bitmap's own
 * size governs and one bitmap pixel is one CSS pixel, as on the canvas below.
 *
 * `pointer-events: none` is load-bearing, not tidiness. Without it this canvas
 * is what the pointer hits, and `event.target` — the element `offsetX` is
 * measured from, and the one a hit test names — stops being the layer.
 */
.paint-preview {
  position: absolute;
  top: 0;
  left: 0;
  display: block;
  image-rendering: pixelated;
  pointer-events: none;
}
</style>
