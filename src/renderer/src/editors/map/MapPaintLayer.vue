<script setup lang="ts">
/**
 * The map canvas's second input path: pixels, not cells.
 *
 * A transparent overlay that sits exactly over `MapCanvas.vue`'s canvas and
 * turns pointer events into `beginPaint`/`extendPaint`/`endPaint` calls on the
 * session. Nothing here knows a coordinate: `paintPointAt` turns an offset into
 * a dot and is tested; the tool, the origin of a line and the flood of a fill
 * all live in `session.ts`, which is the layer vitest covers. This file is not.
 *
 * One feeding rule for every tool: each segment runs from the previous sample
 * to the current one. A pencil or spray wants exactly that; a line, a rect or a
 * fill ignores `from` past the first sample and draws from the origin the
 * session recorded — so the component does not need to know which tool is
 * live, and cannot get the two backwards.
 */
import { onUnmounted } from 'vue'
import type { Point } from '../../../../shared/map-editor'
import { beginPaint, endPaint, extendPaint, paintPointAt, type MapSession } from './session'

const props = defineProps<{ session: MapSession }>()

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
</script>

<template>
  <div
    class="paint-layer"
    @pointerdown="onDown"
    @pointermove="onMove"
    @pointerup="onUp"
    @pointercancel="onUp"
    @contextmenu.prevent
  />
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
</style>
