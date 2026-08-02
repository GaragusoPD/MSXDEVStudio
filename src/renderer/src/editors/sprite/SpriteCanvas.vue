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
import { floodFill, paintLine, updateLayer, type SpriteTarget, type SpriteTool } from '../../../../shared/sprite-editor'
import { drawGrid, drawIndices } from './draw'

const props = defineProps<{ doc: SpritesDoc; target: SpriteTarget; tool: SpriteTool; onionSkin: boolean }>()
const emit = defineEmits<{ commit: [doc: SpritesDoc] }>()

const PIXEL = 20
const canvasRef = ref<HTMLCanvasElement>()

const livePreview = ref<SpritesDoc | null>(null)
const displayDoc = computed(() => livePreview.value ?? props.doc)
const canvasSize = computed(() => props.doc.size * PIXEL)

let dragging = false
let dragStart: { x: number; y: number } | null = null
let lastCell: { x: number; y: number } | null = null
// Left button draws the pixel, right button clears it, whatever tool is
// selected. The erase tool forces clearing on either button.
let drawing = true

function cellAt(event: PointerEvent): { x: number; y: number } {
  const rect = (canvasRef.value as HTMLCanvasElement).getBoundingClientRect()
  const size = props.doc.size
  const clamp = (v: number): number => Math.min(size - 1, Math.max(0, v))
  return {
    x: clamp(Math.floor(((event.clientX - rect.left) / rect.width) * size)),
    y: clamp(Math.floor(((event.clientY - rect.top) / rect.height) * size))
  }
}

function paintTo(cell: { x: number; y: number }): void {
  if (props.tool === 'line') {
    livePreview.value = updateLayer(props.doc, props.target, (layer) =>
      paintLine(layer, dragStart!.x, dragStart!.y, cell.x, cell.y, props.doc.size, drawing)
    )
    return
  }
  const base = livePreview.value ?? props.doc
  const from = lastCell ?? cell
  livePreview.value = updateLayer(base, props.target, (layer) => paintLine(layer, from.x, from.y, cell.x, cell.y, base.size, drawing))
}

function onPointerDown(event: PointerEvent): void {
  const cell = cellAt(event)
  drawing = props.tool !== 'erase' && event.button !== 2
  if (props.tool === 'fill') {
    emit('commit', updateLayer(props.doc, props.target, (layer) => floodFill(layer, cell.x, cell.y, props.doc.size, drawing)))
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
  const size = displayDoc.value.size
  const scale = canvas.width / size
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  const rgb = paletteToRgb(displayDoc.value.palette)

  if (props.onionSkin && props.target.frame > 0) {
    const previous = displayDoc.value.sprites[props.target.sprite]?.frames[props.target.frame - 1]
    if (previous) {
      ctx.globalAlpha = 0.35
      drawIndices(ctx, compositeFrame(previous.layers, displayDoc.value.mode, size), size, scale, rgb)
      ctx.globalAlpha = 1
    }
  }

  const frame = displayDoc.value.sprites[props.target.sprite]?.frames[props.target.frame]
  if (frame) drawIndices(ctx, compositeFrame(frame.layers, displayDoc.value.mode, size), size, scale, rgb)
  drawGrid(ctx, size, scale)
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
      :width="canvasSize"
      :height="canvasSize"
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
