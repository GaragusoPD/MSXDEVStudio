<script setup lang="ts">
/**
 * Spec 10 A's center pane: the map grid — stamp/fill/rect/erase, rectangular
 * select (shift+drag) and the zoom/grid/screen-outline overlays. All the logic is in `shared/map-editor.ts` and `./session.ts`;
 * this file only turns pointer events into cells and draws the result.
 *
 * Rect/erase-drag mirrors `TileCanvas.vue`: 'stamp'/'erase' paint
 * incrementally as the pointer moves (each move's `linePoints` segment is
 * folded into the running preview), while 'rect' only shows a ghost outline
 * during the drag and applies the full shape once, on pointer-up — recomputing
 * a rect from a stale mid-drag preview would double-paint the overlap.
 *
 * Paint mode is a second input path with its own component, `MapPaintLayer`,
 * mounted over the canvas only while it is live. The cell handlers below step
 * aside whenever the mode is not `'tiles'`, so the two can never both fire.
 *
 * A float is the exception to both: it is handled here first, in either mode,
 * and the paint layer stands down while one exists — an imported picture
 * floats in paint mode, and a click there has to place it, not paint under it.
 * The keyboard shortcuts live in `MapEditorTab.vue`, on the window, once.
 */
import { computed, ref, watch, watchEffect } from 'vue'
import { SCREEN_COLS, SCREEN_ROWS } from '../../../../shared/msx/map'
import { TILE_SIZE } from '../../../../shared/msx/tile'
import { MODES } from '../../../../shared/msx/modes'
import { type Point } from '../../../../shared/map-editor'
import { rectPoints } from '../../../../shared/tile-editor'
import { metaThumbnail } from './sheet'
import MapPaintLayer from './MapPaintLayer.vue'
import { rectContains } from '../../../../shared/floating'
import type { Picture } from '../../../../shared/msx/tile-compact'
import {
  bankSheetOffset,
  clearSelection,
  displayDoc,
  dragPoints,
  doc,
  dropFloat,
  fillAt,
  finishDrag,
  liftSelection,
  mapFloatRect,
  metaRowOffsets,
  moveFloatTo,
  movePlacementTo,
  painting,
  paintDrag,
  placeMetaAt,
  selectPlacementAt,
  setSelection,
  setViewOrigin,
  sheet,
  type MapSession
} from './session'

const props = defineProps<{ session: MapSession }>()

const canvas = ref<HTMLCanvasElement | null>(null)
/** Set while a placed meta-tile is being dragged, with the grab offset inside it. */
let draggingPlacement = false
let grab: Point | null = null
const rectPreview = ref<Point[]>([])

let origin: Point | null = null
let last: Point | null = null
let selecting = false
let selectAnchor: Point | null = null
/** Set while a float is being dragged: where in it the pointer took hold. */
let floatGrab: Point | null = null
/** Whether the pointer is over something the select tool would drag — the cursor says so. */
const overSelection = ref(false)

/**
 * One screenful, in map cells — what the outline overlay steps by. A name-table
 * map is always 32×24 characters, but a bitmap map's cell is a size in dots, so
 * how many fit on a screen depends on the mode the atlas was converted for.
 */
const screenSpan = computed(() => {
  const current = doc(props.session)
  const cell = current.cell
  // Whichever kind of tileset is loaded knows the mode; a `.screen.json` atlas
  // was the only one that did before bitmap tilesets existed, which is why a map
  // over a `.btiles.json` used to fall back to 32x24 and draw an outline twice
  // the width of the screen it claims to mark. It matters most in SCREEN 3,
  // where the screen is 64x48 blocks and a 4x4-block cell fits 16 across.
  const mode = props.session.atlas?.mode ?? props.session.bitmapTileset?.mode ?? null
  const info = cell && mode ? MODES[mode] : null
  const tiles = info
    ? { cols: Math.floor(info.width / cell!.width), rows: Math.floor(info.height / cell!.height) }
    : { cols: SCREEN_COLS, rows: SCREEN_ROWS }
  return { cols: tiles.cols, rows: tiles.rows }
})

/** The cell under the pointer, unclamped: a captured drag can leave the canvas, and a float may follow it off the edge. */
function rawCellAt(event: PointerEvent): Point {
  const rect = (event.currentTarget as HTMLCanvasElement).getBoundingClientRect()
  const current = doc(props.session)
  return {
    x: Math.floor(((event.clientX - rect.left) / rect.width) * current.width),
    y: Math.floor(((event.clientY - rect.top) / rect.height) * current.height)
  }
}

function cellAt(event: PointerEvent): Point {
  const current = doc(props.session)
  const { x, y } = rawCellAt(event)
  return { x: Math.min(current.width - 1, Math.max(0, x)), y: Math.min(current.height - 1, Math.max(0, y)) }
}

function onDown(event: PointerEvent): void {
  const cell = cellAt(event)
  const float = props.session.float
  // A float takes the press in either mode: inside it, a grab; outside, it
  // lands — and that is all the click does, so it never paints under it.
  if (float) {
    ;(event.currentTarget as HTMLCanvasElement).setPointerCapture(event.pointerId)
    if (rectContains(mapFloatRect(float), cell)) {
      floatGrab = { x: cell.x - float.x, y: cell.y - float.y }
      return
    }
    void dropFloat(props.session)
    if (props.session.mode !== 'tiles' || props.session.tool !== 'select') return
  }
  if (props.session.mode !== 'tiles') return
  ;(event.currentTarget as HTMLCanvasElement).setPointerCapture(event.pointerId)
  if (event.shiftKey) {
    selecting = true
    selectAnchor = cell
    setSelection(props.session, cell, cell)
    return
  }
  // The select tool: inside the selection, lift it (a copy with Ctrl or Alt)
  // and drag; anywhere else, start a new one.
  if (props.session.tool === 'select') {
    const selection = props.session.selection
    if (!props.session.float && selection && rectContains(selection, cell) && liftSelection(props.session, event.ctrlKey || event.altKey)) {
      floatGrab = { x: cell.x - selection.x, y: cell.y - selection.y }
      return
    }
    selecting = true
    selectAnchor = cell
    setSelection(props.session, cell, cell)
    return
  }
  // A meta brush places; otherwise a click on a placed meta selects it and
  // starts a drag, and only a click on bare grid falls through to the tools.
  if (props.session.brushMeta) {
    placeMetaAt(props.session, cell.x, cell.y)
    return
  }
  if (selectPlacementAt(props.session, cell.x, cell.y) !== null) {
    draggingPlacement = true
    // Remember the grab point so the meta keeps its offset under the pointer
    // rather than snapping its corner there.
    const placement = doc(props.session).layers[props.session.activeLayer].placements[props.session.selectedPlacement!]
    grab = { x: cell.x - placement.x, y: cell.y - placement.y }
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
  if (floatGrab) {
    const at = rawCellAt(event)
    moveFloatTo(props.session, { x: at.x - floatGrab.x, y: at.y - floatGrab.y })
    return
  }
  const float = props.session.float
  if (float || props.session.tool === 'select') {
    const rect = float ? mapFloatRect(float) : props.session.selection
    overSelection.value = rect !== null && rectContains(rect, cellAt(event))
  }
  if (props.session.mode !== 'tiles') return
  const cell = cellAt(event)
  if (selecting && selectAnchor) {
    setSelection(props.session, selectAnchor, cell)
    return
  }
  if (draggingPlacement && grab) {
    movePlacementTo(props.session, cell.x - grab.x, cell.y - grab.y)
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

function onUp(event: PointerEvent): void {
  if (floatGrab) {
    floatGrab = null
    return
  }
  if (props.session.mode !== 'tiles') return
  if (draggingPlacement) {
    draggingPlacement = false
    grab = null
    return
  }
  if (selecting) {
    // With the select tool, a click is "select nothing"; Shift+click keeps
    // its old meaning, the one cell.
    const cell = cellAt(event)
    if (props.session.tool === 'select' && !event.shiftKey && selectAnchor && cell.x === selectAnchor.x && cell.y === selectAnchor.y) {
      clearSelection(props.session)
    }
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

// A mode flip mid-drag: `setMode` has already ended the drag in the session,
// but the pointer bookkeeping above — and the rect ghost drawn from it — would
// outlive that and be picked up by a pointerup arriving in the other mode, or
// by the next drag back in this one. Lifecycle, not logic: nothing here decides.
watch(
  () => props.session.mode,
  () => {
    origin = null
    last = null
    rectPreview.value = []
    draggingPlacement = false
    grab = null
    selecting = false
    selectAnchor = null
    floatGrab = null
  }
)

/**
 * Keeps the session's idea of what is in view current, so a paste or an
 * import appears where the user is looking rather than at a corner they may
 * have scrolled far away from. The pane's padding is the 12px before cell 0.
 */
function onScroll(event: Event): void {
  const pane = event.currentTarget as HTMLElement
  const zoom = props.session.zoom
  // The first cell wholly in view, so a paste starts where it can be seen whole.
  setViewOrigin(props.session, {
    x: Math.max(0, Math.ceil((pane.scrollLeft - 12) / zoom)),
    y: Math.max(0, Math.ceil((pane.scrollTop - 12) / zoom))
  })
}

/**
 * A floating picture, drawn once into a canvas of its own and then scaled onto
 * the map at wherever the float stands — rebuilt only when the picture itself
 * changes, not on every step of a drag. Index 0 is see-through, as it will be
 * when the picture lands.
 */
let pictureCache: { picture: Picture; canvas: HTMLCanvasElement } | null = null
function pictureCanvas(picture: Picture, rgb: readonly { r: number; g: number; b: number }[]): HTMLCanvasElement | null {
  if (pictureCache?.picture === picture) return pictureCache.canvas
  const element = document.createElement('canvas')
  element.width = picture.width
  element.height = picture.height
  const ctx = element.getContext('2d')
  if (!ctx) return null
  const image = ctx.createImageData(picture.width, picture.height)
  for (let i = 0; i < picture.width * picture.height; i++) {
    const index = picture.indices[i] ?? 0
    const color = rgb[index] ?? { r: 255, g: 0, b: 255 }
    image.data[i * 4] = color.r
    image.data[i * 4 + 1] = color.g
    image.data[i * 4 + 2] = color.b
    image.data[i * 4 + 3] = index === 0 ? 0 : 255
  }
  ctx.putImageData(image, 0, 0)
  pictureCache = { picture, canvas: element }
  return element
}

const stage = computed(() => {
  const current = doc(props.session)
  return { width: current.width * props.session.zoom, height: current.height * props.session.zoom }
})

watchEffect(() => {
  const element = canvas.value
  if (!element) return
  // The map with any floating block of cells already dropped in, so a move
  // looks exactly as it will once it lands.
  const current = displayDoc(props.session)
  const zoom = props.session.zoom
  element.width = current.width * zoom
  element.height = current.height * zoom
  const ctx = element.getContext('2d')
  if (!ctx) return
  ctx.imageSmoothingEnabled = false
  ctx.fillStyle = '#2a2a2a'
  ctx.fillRect(0, 0, element.width, element.height)

  const cells = sheet(props.session)
  if (cells) {
    // The first tiles layer is the base: hardware draws every cell, so tile 0
    // renders like any other. On overlay layers 0 stays transparent — it's
    // what erase writes and what a fresh layer is filled with.
    let base = true
    for (const layer of current.layers) {
      if (layer.kind !== 'tiles') continue
      const skipZero = !base
      base = false
      if (!layer.visible) continue
      for (let y = 0; y < current.height; y++) {
        // A name-table byte means different art depending which third of the
        // screen it sits in (see `bankSheetOffset`) — computed once per row,
        // not per cell, since it only depends on `y`.
        const offset = bankSheetOffset(props.session, y)
        for (let x = 0; x < current.width; x++) {
          const index = layer.data[y * current.width + x]
          if (!index && skipZero) continue
          const cell = index + offset
          const sx = (cell % cells.cols) * cells.cellW
          const sy = Math.floor(cell / cells.cols) * cells.cellH
          ctx.drawImage(cells.canvas, sx, sy, cells.cellW, cells.cellH, x * zoom, y * zoom, zoom, zoom)
        }
      }
    }
  }

  // Placed meta-tiles, over the layer that holds them. A baked one is already
  // in the grid the loop above drew, so drawing it again is a no-op visually —
  // it is drawn anyway so the outline and the hit test agree with what is seen.
  if (cells) {
    current.layers.forEach((layer, layerIndex) => {
      if (!layer.visible) return
      for (const [index, placement] of layer.placements.entries()) {
        const ref = current.metas[placement.slot]
        const meta = ref && props.session.metaDocs.get(ref.path)
        if (!meta) continue
        ctx.drawImage(
          metaThumbnail(cells, meta, 0, metaRowOffsets(props.session, placement.y, meta.height)),
          placement.x * zoom,
          placement.y * zoom,
          ref.width * zoom,
          ref.height * zoom
        )
        if (layerIndex !== props.session.activeLayer || index !== props.session.selectedPlacement) continue
        ctx.strokeStyle = '#ffd24e'
        ctx.lineWidth = 2
        ctx.strokeRect(placement.x * zoom + 1, placement.y * zoom + 1, ref.width * zoom - 2, ref.height * zoom - 2)
      }
    })
  }

  const floating = props.session.float
  if (floating?.kind === 'picture') {
    const art = pictureCanvas(floating.picture, floating.rgb)
    if (art) {
      ctx.drawImage(
        art,
        floating.x * zoom,
        floating.y * zoom,
        (floating.picture.width * zoom) / TILE_SIZE,
        (floating.picture.height * zoom) / TILE_SIZE
      )
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
    for (let x = 0; x <= current.width; x += screenSpan.value.cols) {
      ctx.beginPath()
      ctx.moveTo(x * zoom, 0)
      ctx.lineTo(x * zoom, element.height)
      ctx.stroke()
    }
    for (let y = 0; y <= current.height; y += screenSpan.value.rows) {
      ctx.beginPath()
      ctx.moveTo(0, y * zoom)
      ctx.lineTo(element.width, y * zoom)
      ctx.stroke()
    }
  }

  // A float is outlined where it stands — off the edge too, where the canvas clips it.
  const outline = floating ? mapFloatRect(floating) : props.session.selection
  if (outline) {
    const s = outline
    ctx.setLineDash([4, 4])
    ctx.strokeStyle = floating ? '#ffd24e' : '#ffffff'
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
    @scroll="onScroll"
  >
    <div
      class="stage"
      :style="{ width: `${stage.width}px`, height: `${stage.height}px` }"
    >
      <canvas
        ref="canvas"
        class="map-canvas"
        :class="{ movable: overSelection && (session.float !== null || session.tool === 'select') }"
        @pointerdown="onDown"
        @pointermove="onMove"
        @pointerup="onUp"
        @pointercancel="onUp"
      />
      <!--
        Only while there is a pattern tileset to paint into: on a bitmap map a
        stroke would resolve into nothing (see `canPaint`). `painting` is the
        one predicate this, the paint panel and the mode toggle all ask, so
        they agree about which maps offer it and when.
      -->
      <MapPaintLayer
        v-if="painting(session) && !session.float"
        :session="session"
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

.map-canvas.movable {
  cursor: move;
}
</style>
