<script setup lang="ts">
/**
 * The paint canvas: draws the active frame's composite (VDP OR-color exact,
 * via `compositeFrame`) and decomposes pointer strokes onto the active layer.
 *
 * Drag tools (pencil/erase/line) render into a local `livePreview` doc for
 * immediate feedback and only `emit('commit', …)` once, on pointer-up — one
 * undo step per stroke, however many pointermove samples it took. Fill is a
 * single click, so it commits immediately.
 */
import { computed, ref, watchEffect } from 'vue'
import { paletteToRgb } from '../../../../shared/msx/palette'
import { compositeFrame } from '../../../../shared/msx/sprite'
import type { SpritesDoc } from '../../../../shared/msx/sprite'
import { addLayer, floodFill, layerAtCell, paintLine, updateLayer, type SpriteTarget, type SpriteTool } from '../../../../shared/sprite-editor'
import { drawGrid, drawIndices } from './draw'

const props = defineProps<{ doc: SpritesDoc; target: SpriteTarget; tool: SpriteTool; onionSkin: boolean }>()
const emit = defineEmits<{ commit: [doc: SpritesDoc]; selectLayer: [index: number] }>()

/** Zoom for a plain 16×16; a 2×2 metasprite would be 640 px at that scale, so it shrinks to fit. */
const PIXEL = 20
const MAX_CANVAS = 420
const canvasRef = ref<HTMLCanvasElement>()

const livePreview = ref<SpritesDoc | null>(null)
const displayDoc = computed(() => livePreview.value ?? props.doc)
const character = computed(() => props.doc.sprites[props.target.sprite])
/** Dots across the whole metasprite grid — `size` when the character is a plain 1×1. */
const dotsWide = computed(() => (character.value?.cols ?? 1) * props.doc.size)
const dotsHigh = computed(() => (character.value?.rows ?? 1) * props.doc.size)
/** Top-left dot of the active plane's cell: strokes are painted in plane-local space. */
const origin = computed(() => {
  const layer = character.value?.frames[props.target.frame]?.layers[props.target.layer]
  return { x: (layer?.cx ?? 0) * props.doc.size, y: (layer?.cy ?? 0) * props.doc.size }
})
const pixel = computed(() => Math.min(PIXEL, Math.floor(MAX_CANVAS / Math.max(dotsWide.value, dotsHigh.value))))

let dragging = false
let dragStart: { x: number; y: number } | null = null
let lastCell: { x: number; y: number } | null = null
// Left button draws the pixel, right button clears it, whatever tool is
// selected. The erase tool forces clearing on either button.
let drawing = true

/** Pointer → dot in character space (still character space, not plane-local). */
function cellAt(event: PointerEvent): { x: number; y: number } {
  const rect = (canvasRef.value as HTMLCanvasElement).getBoundingClientRect()
  const clamp = (v: number, max: number): number => Math.min(max - 1, Math.max(0, v))
  return {
    x: clamp(Math.floor(((event.clientX - rect.left) / rect.width) * dotsWide.value), dotsWide.value),
    y: clamp(Math.floor(((event.clientY - rect.top) / rect.height) * dotsHigh.value), dotsHigh.value)
  }
}

/** Character space → the active plane's own space. Dots outside its cell fall out of range and paint nothing. */
function local(cell: { x: number; y: number }): { x: number; y: number } {
  return { x: cell.x - origin.value.x, y: cell.y - origin.value.y }
}

function paintTo(cell: { x: number; y: number }): void {
  const to = local(cell)
  if (props.tool === 'line') {
    const from = local(dragStart as { x: number; y: number })
    livePreview.value = updateLayer(props.doc, props.target, (layer) =>
      paintLine(layer, from.x, from.y, to.x, to.y, props.doc.size, drawing)
    )
    return
  }
  const base = livePreview.value ?? props.doc
  const from = local(lastCell ?? cell)
  livePreview.value = updateLayer(base, props.target, (layer) => paintLine(layer, from.x, from.y, to.x, to.y, base.size, drawing))
}

/**
 * Clicking another cell of a metasprite switches to that cell's first plane
 * rather than painting nothing — the active plane is what says which hardware
 * sprite a stroke lands on.
 *
 * A cell whose planes were all removed gets one back on the click. Nothing else
 * can reach it: "+ Layer" aims at the *active* plane's cell, so an empty cell
 * you can't select is an empty cell you can never draw on again.
 */
function selectCellUnder(cell: { x: number; y: number }): boolean {
  const size = props.doc.size
  const cx = Math.floor(cell.x / size)
  const cy = Math.floor(cell.y / size)
  if (cx === origin.value.x / size && cy === origin.value.y / size) return false
  const frame = character.value?.frames[props.target.frame]
  if (!frame) return true
  const index = layerAtCell(frame, cx, cy)
  if (index >= 0) {
    emit('selectLayer', index)
  } else {
    emit('commit', addLayer(props.doc, props.target.sprite, cx, cy))
    emit('selectLayer', frame.layers.length)
  }
  // Either way the click is spent moving the selection, not painting.
  return true
}

function onPointerDown(event: PointerEvent): void {
  const cell = cellAt(event)
  if (selectCellUnder(cell)) return
  drawing = props.tool !== 'erase' && event.button !== 2
  if (props.tool === 'fill') {
    const point = local(cell)
    emit('commit', updateLayer(props.doc, props.target, (layer) => floodFill(layer, point.x, point.y, props.doc.size, drawing)))
    return
  }
  dragging = true
  dragStart = cell
  lastCell = null
  paintTo(cell)
  lastCell = cell
  canvasRef.value?.setPointerCapture(event.pointerId)
}

function onPointerMove(event: PointerEvent): void {
  if (!dragging) return
  const cell = cellAt(event)
  paintTo(cell)
  lastCell = cell
}

function onPointerUp(): void {
  if (!dragging) return
  dragging = false
  if (livePreview.value) emit('commit', livePreview.value)
  livePreview.value = null
  dragStart = null
  lastCell = null
}

function draw(): void {
  const canvas = canvasRef.value
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return
  const doc = displayDoc.value
  const size = doc.size
  const sprite = doc.sprites[props.target.sprite]
  const cols = sprite?.cols ?? 1
  const rows = sprite?.rows ?? 1
  const scale = canvas.width / (cols * size)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  const rgb = paletteToRgb(doc.palette)

  if (props.onionSkin && props.target.frame > 0) {
    const previous = sprite?.frames[props.target.frame - 1]
    if (previous) {
      ctx.globalAlpha = 0.35
      drawIndices(ctx, compositeFrame(previous.layers, doc.mode, size, cols, rows), cols * size, scale, rgb)
      ctx.globalAlpha = 1
    }
  }

  const frame = sprite?.frames[props.target.frame]
  if (frame) drawIndices(ctx, compositeFrame(frame.layers, doc.mode, size, cols, rows), cols * size, scale, rgb)
  drawGrid(ctx, cols * size, scale, rows * size, cols * rows > 1 ? size : 0)

  // The cell being painted, so it's obvious which hardware sprite a stroke lands on.
  if (cols * rows > 1) {
    ctx.strokeStyle = 'rgba(120, 170, 255, 1)'
    ctx.lineWidth = 2
    ctx.strokeRect(origin.value.x * scale + 1, origin.value.y * scale + 1, size * scale - 2, size * scale - 2)
  }
}

// flush: 'post' is required, not cosmetic — `draw()` reads `canvasRef.value` before any
// other reactive state, so a 'pre' run (before the canvas exists) would return early and
// never register `displayDoc`/`target`/`onionSkin` as dependencies for later reruns.
watchEffect(draw, { flush: 'post' })
</script>

<template>
  <div class="canvas-wrap">
    <canvas
      ref="canvasRef"
      class="sprite-canvas"
      :width="dotsWide * pixel"
      :height="dotsHigh * pixel"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @contextmenu.prevent
    />
  </div>
</template>

<style scoped>
.canvas-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  min-height: 0;
  padding: 12px;
  overflow: auto;
}

.sprite-canvas {
  image-rendering: pixelated;
  border: 1px solid var(--color-border);
  touch-action: none;
  cursor: crosshair;
  background-color: var(--color-bg-tab-inactive);
  background-image:
    linear-gradient(45deg, rgba(128, 128, 128, 0.25) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(128, 128, 128, 0.25) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(128, 128, 128, 0.25) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(128, 128, 128, 0.25) 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
}
</style>
