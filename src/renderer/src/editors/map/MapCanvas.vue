<script setup lang="ts">
/**
 * Spec 10 A's center pane: the map grid — stamp/fill/rect/erase, flags-mode
 * painting, rectangular select (shift+drag) and the zoom/grid/screen-outline
 * overlays. All the logic is in `shared/map-editor.ts` and `./session.ts`;
 * this file only turns pointer events into cells and draws the result.
 *
 * Rect/erase-drag mirrors `TileCanvas.vue`: 'stamp'/'erase' paint
 * incrementally as the pointer moves (each move's `linePoints` segment is
 * folded into the running preview), while 'rect' only shows a ghost outline
 * during the drag and applies the full shape once, on pointer-up — recomputing
 * a rect from a stale mid-drag preview would double-paint the overlap.
 */
import { computed, ref, watchEffect } from 'vue'
import { SCREEN_COLS, SCREEN_ROWS } from '../../../../shared/msx/map'
import { paletteToRgb } from '../../../../shared/msx/palette'
import { tilePixels, TILE_SIZE, type TilesDoc } from '../../../../shared/msx/tile'
import { flagBit, hasFlag, type Point } from '../../../../shared/map-editor'
import { rectPoints } from '../../../../shared/tile-editor'
import {
  clearSelection,
  copySelection,
  deleteSelection,
  dragPoints,
  doc,
  fillAt,
  finishDrag,
  paintDrag,
  pasteClipboard,
  setSelection,
  type MapSession
} from './session'

const props = defineProps<{ session: MapSession }>()

const SHEET_COLUMNS = 16
const canvas = ref<HTMLCanvasElement | null>(null)
const rectPreview = ref<Point[]>([])

let sheetSource: TilesDoc | null = null
const sheetCanvas = document.createElement('canvas')

let origin: Point | null = null
let last: Point | null = null
let selecting = false
let selectAnchor: Point | null = null

function ensureSheet(tileset: TilesDoc): HTMLCanvasElement {
  if (sheetSource === tileset) return sheetCanvas
  sheetSource = tileset
  const rows = Math.max(1, Math.ceil(tileset.count / SHEET_COLUMNS))
  sheetCanvas.width = SHEET_COLUMNS * TILE_SIZE
  sheetCanvas.height = rows * TILE_SIZE
  const ctx = sheetCanvas.getContext('2d')
  if (!ctx) return sheetCanvas
  const rgb = paletteToRgb(tileset.palette)
  const image = new ImageData(sheetCanvas.width, sheetCanvas.height)
  for (let index = 0; index < tileset.count; index++) {
    const pixels = tilePixels(tileset, index)
    const ox = (index % SHEET_COLUMNS) * TILE_SIZE
    const oy = Math.floor(index / SHEET_COLUMNS) * TILE_SIZE
    for (let y = 0; y < TILE_SIZE; y++) {
      for (let x = 0; x < TILE_SIZE; x++) {
        const value = pixels[y * TILE_SIZE + x]
        const at = ((oy + y) * image.width + ox + x) * 4
        const color = rgb[value] ?? { r: 0, g: 0, b: 0 }
        image.data[at] = color.r
        image.data[at + 1] = color.g
        image.data[at + 2] = color.b
        image.data[at + 3] = 255
      }
    }
  }
  ctx.putImageData(image, 0, 0)
  return sheetCanvas
}

function cellAt(event: PointerEvent): Point {
  const rect = (event.currentTarget as HTMLCanvasElement).getBoundingClientRect()
  const current = doc(props.session)
  const x = Math.floor(((event.clientX - rect.left) / rect.width) * current.width)
  const y = Math.floor(((event.clientY - rect.top) / rect.height) * current.height)
  return { x: Math.min(current.width - 1, Math.max(0, x)), y: Math.min(current.height - 1, Math.max(0, y)) }
}

function onDown(event: PointerEvent): void {
  const cell = cellAt(event)
  ;(event.currentTarget as HTMLCanvasElement).setPointerCapture(event.pointerId)
  if (event.shiftKey) {
    selecting = true
    selectAnchor = cell
    setSelection(props.session, cell, cell)
    return
  }
  if (props.session.tool === 'fill') {
    fillAt(props.session, cell)
    return
  }
  origin = cell
  last = cell
  if (props.session.tool === 'rect') {
    rectPreview.value = [cell]
  } else {
    paintDrag(props.session, [cell])
  }
}

function onMove(event: PointerEvent): void {
  const cell = cellAt(event)
  if (selecting && selectAnchor) {
    setSelection(props.session, selectAnchor, cell)
    return
  }
  if (!origin || !last) return
  if (props.session.tool === 'rect') {
    rectPreview.value = rectPoints(origin, cell, props.session.filledRect)
  } else if (cell.x !== last.x || cell.y !== last.y) {
    paintDrag(props.session, dragPoints(props.session.tool === 'erase' ? 'erase' : 'stamp', last, cell, false))
  }
  last = cell
}

function onUp(): void {
  if (selecting) {
    selecting = false
    selectAnchor = null
    return
  }
  if (!origin || !last) return
  if (props.session.tool === 'rect') {
    paintDrag(props.session, rectPoints(origin, last, props.session.filledRect))
  }
  finishDrag(props.session)
  rectPreview.value = []
  origin = null
  last = null
}

function onKeydown(event: KeyboardEvent): void {
  if (!event.ctrlKey) {
    if (event.key === 'Delete' || event.key === 'Backspace') deleteSelection(props.session)
    else if (event.key === 'Escape') clearSelection(props.session)
    return
  }
  const key = event.key.toLowerCase()
  if (key === 'c') copySelection(props.session)
  else if (key === 'v') pasteClipboard(props.session)
}

const stage = computed(() => {
  const current = doc(props.session)
  return { width: current.width * props.session.zoom, height: current.height * props.session.zoom }
})

watchEffect(() => {
  const element = canvas.value
  if (!element) return
  const current = doc(props.session)
  const zoom = props.session.zoom
  element.width = current.width * zoom
  element.height = current.height * zoom
  const ctx = element.getContext('2d')
  if (!ctx) return
  ctx.imageSmoothingEnabled = false
  ctx.fillStyle = '#2a2a2a'
  ctx.fillRect(0, 0, element.width, element.height)

  const tileset = props.session.tileset
  if (tileset) {
    const sheet = ensureSheet(tileset)
    for (const layer of current.layers) {
      if (layer.kind !== 'tiles' || !layer.visible) continue
      for (let y = 0; y < current.height; y++) {
        for (let x = 0; x < current.width; x++) {
          const index = layer.data[y * current.width + x]
          if (!index) continue
          const sx = (index % SHEET_COLUMNS) * TILE_SIZE
          const sy = Math.floor(index / SHEET_COLUMNS) * TILE_SIZE
          ctx.drawImage(sheet, sx, sy, TILE_SIZE, TILE_SIZE, x * zoom, y * zoom, zoom, zoom)
        }
      }
    }
  }

  const activeLayer = current.layers[props.session.activeLayer]
  if (props.session.flagsMode && activeLayer?.kind === 'flags') {
    const bit = props.session.flagBrush ? flagBit(current, props.session.flagBrush) : -1
    ctx.fillStyle = 'rgba(255, 64, 64, 0.45)'
    for (let y = 0; y < current.height; y++) {
      for (let x = 0; x < current.width; x++) {
        const value = activeLayer.data[y * current.width + x]
        const show = bit >= 0 ? hasFlag(value, bit) : value !== 0
        if (show) ctx.fillRect(x * zoom, y * zoom, zoom, zoom)
      }
    }
  }

  if (rectPreview.value.length) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)'
    for (const p of rectPreview.value) ctx.fillRect(p.x * zoom, p.y * zoom, zoom, zoom)
  }

  if (props.session.gridVisible) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)'
    ctx.lineWidth = 1
    for (let x = 0; x <= current.width; x++) {
      ctx.beginPath()
      ctx.moveTo(x * zoom + 0.5, 0)
      ctx.lineTo(x * zoom + 0.5, element.height)
      ctx.stroke()
    }
    for (let y = 0; y <= current.height; y++) {
      ctx.beginPath()
      ctx.moveTo(0, y * zoom + 0.5)
      ctx.lineTo(element.width, y * zoom + 0.5)
      ctx.stroke()
    }
  }

  if (props.session.screenOutline) {
    ctx.strokeStyle = 'rgba(0, 200, 255, 0.6)'
    ctx.lineWidth = 2
    for (let x = 0; x <= current.width; x += SCREEN_COLS) {
      ctx.beginPath()
      ctx.moveTo(x * zoom, 0)
      ctx.lineTo(x * zoom, element.height)
      ctx.stroke()
    }
    for (let y = 0; y <= current.height; y += SCREEN_ROWS) {
      ctx.beginPath()
      ctx.moveTo(0, y * zoom)
      ctx.lineTo(element.width, y * zoom)
      ctx.stroke()
    }
  }

  if (props.session.selection) {
    const s = props.session.selection
    ctx.setLineDash([4, 4])
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 2
    ctx.strokeRect(s.x * zoom + 1, s.y * zoom + 1, s.width * zoom - 2, s.height * zoom - 2)
    ctx.setLineDash([])
  }
})
</script>

<template>
  <div
    class="canvas-pane"
    tabindex="0"
    @keydown="onKeydown"
  >
    <div
      class="stage"
      :style="{ width: `${stage.width}px`, height: `${stage.height}px` }"
    >
      <canvas
        ref="canvas"
        class="map-canvas"
        @pointerdown="onDown"
        @pointermove="onMove"
        @pointerup="onUp"
        @pointercancel="onUp"
      />
    </div>
  </div>
</template>

<style scoped>
.canvas-pane {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding: 12px;
  outline: none;
}

.stage {
  position: relative;
}

.map-canvas {
  display: block;
  image-rendering: pixelated;
  border: 1px solid var(--color-border);
  touch-action: none;
  cursor: crosshair;
}
</style>
