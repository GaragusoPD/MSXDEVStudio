<script setup lang="ts">
/**
 * Spec 10 B's main pane: the original source image next to the converted
 * image at real MSX resolution, with pencil/fill retouch on the converted
 * side. All the logic is in `shared/screen-editor.ts` and `./session.ts`;
 * this file only turns pointer events into pixels and draws both canvases.
 *
 * The converted side draws `displayPixels` — the picture with any floating
 * selection on it — so a move, a paste or an import shows where it will land
 * without the document knowing about it until it is dropped.
 */
import { computed, ref, watchEffect } from 'vue'
import { MODES, SC3_BLOCK_DOTS } from '../../../../shared/msx/modes'
import { isScreenWorld } from '../../../../shared/msx/screen'
import { clipRect, floatRect, rectContains } from '../../../../shared/floating'
import { linePoints, type Point } from '../../../../shared/tile-editor'
import {
  addFragment,
  clearSelection,
  displayPixels,
  displayRgb,
  doc,
  dropFloat,
  fillAt,
  finishDrag,
  liftSelection,
  moveFloatTo,
  paintDrag,
  pickAt,
  setSelection,
  toolDrag,
  type ScreenSession
} from './session'

const props = defineProps<{ session: ScreenSession }>()

const originalCanvas = ref<HTMLCanvasElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
let last: Point | null = null
/** Drag rectangle of the cut tool, in image pixels. */
const cutFrom = ref<Point | null>(null)
const cutTo = ref<Point | null>(null)

const modeInfo = computed(() => MODES[doc(props.session).mode])
const convertedPixels = computed(() => displayPixels(props.session))

/**
 * Screen dots per document pixel. One everywhere except SCREEN 3, whose "pixel"
 * is a 4×4 block — so its 64×48 document is drawn at the 256×192 the machine
 * actually shows, and a zoom step means the same thing in every mode.
 */
/**
 * Whether there is a "before" to show at all. A document with no source was
 * drawn here rather than converted, so the original pane would be a placeholder
 * taking half the width — which is most of the working area at SCREEN 3's size.
 */
const hasSource = computed(() => Boolean(doc(props.session).source))

const dotScale = computed(() => (doc(props.session).mode === 'sc3' ? SC3_BLOCK_DOTS : 1))
const scale = computed(() => props.session.zoom * dotScale.value)

const originalDims = computed(() => {
  const image = props.session.sourceImage
  return image ? `${image.width}×${image.height}` : '—'
})
const convertedDims = computed(() => {
  const pixels = convertedPixels.value
  return pixels ? `${pixels.width}×${pixels.height}` : '—'
})

const originalStyle = computed(() => {
  const image = props.session.sourceImage
  if (!image) return {}
  return { width: `${image.width * props.session.zoom}px`, height: `${image.height * props.session.zoom}px` }
})
const convertedStyle = computed(() => {
  const pixels = convertedPixels.value
  if (!pixels) return {}
  return { width: `${pixels.width * scale.value}px`, height: `${pixels.height * scale.value}px` }
})

/**
 * Where one screenful falls inside the picture — only interesting once the
 * picture is bigger than one, which is exactly when it stops being a screen and
 * starts being a world to scroll around.
 */
const screenBoxes = computed(() => {
  const current = doc(props.session)
  const pixels = convertedPixels.value
  if (!props.session.screenOutline || !pixels || !isScreenWorld(current)) return []
  const info = MODES[current.mode]
  const step = scale.value
  const boxes: { key: string; style: Record<string, string> }[] = []
  for (let y = 0; y < pixels.height; y += info.height) {
    for (let x = 0; x < pixels.width; x += info.width) {
      boxes.push({
        key: `${x}:${y}`,
        style: {
          left: `${x * step}px`,
          top: `${y * step}px`,
          width: `${Math.min(info.width, pixels.width - x) * step}px`,
          height: `${Math.min(info.height, pixels.height - y) * step}px`
        }
      })
    }
  }
  return boxes
})

/**
 * The grid overlays, as a CSS background rather than a second canvas: one line
 * per block, and one per 8-dot cell.
 *
 * The cell guide is the useful one in SCREEN 3 — 8 dots is 2×2 blocks, which is
 * exactly one name-table entry, so it is where the art has to line up if this
 * picture is ever cut into tiles.
 */
const gridStyle = computed(() => {
  const step = scale.value
  const cell = step * (8 / dotScale.value)
  const layers: string[] = []
  const sizes: string[] = []
  if (props.session.cellGuide) {
    layers.push(
      'linear-gradient(to right, rgba(255,255,255,0.45) 1px, transparent 1px)',
      'linear-gradient(to bottom, rgba(255,255,255,0.45) 1px, transparent 1px)'
    )
    sizes.push(`${cell}px ${cell}px`, `${cell}px ${cell}px`)
  }
  if (props.session.grid && step >= 4) {
    layers.push(
      'linear-gradient(to right, rgba(255,255,255,0.18) 1px, transparent 1px)',
      'linear-gradient(to bottom, rgba(255,255,255,0.18) 1px, transparent 1px)'
    )
    sizes.push(`${step}px ${step}px`, `${step}px ${step}px`)
  }
  if (!layers.length) return { display: 'none' }
  return { backgroundImage: layers.join(', '), backgroundSize: sizes.join(', ') }
})

/** The pixel under the pointer, unclamped: a captured drag can leave the canvas, and a float may follow it off the edge. */
function rawPixelAt(event: PointerEvent): Point {
  const rect = (event.currentTarget as HTMLCanvasElement).getBoundingClientRect()
  const pixels = convertedPixels.value
  const width = pixels?.width ?? 1
  const height = pixels?.height ?? 1
  return {
    x: Math.floor(((event.clientX - rect.left) / rect.width) * width),
    y: Math.floor(((event.clientY - rect.top) / rect.height) * height)
  }
}

function pixelAt(event: PointerEvent): Point {
  const pixels = convertedPixels.value
  const width = pixels?.width ?? 1
  const height = pixels?.height ?? 1
  const { x, y } = rawPixelAt(event)
  return { x: Math.min(width - 1, Math.max(0, x)), y: Math.min(height - 1, Math.max(0, y)) }
}

/** Where a rubber-band drag started; `last` is where a pencil drag has walked to. */
let anchor: Point | null = null

/** Select tool: the grab point inside a float being dragged, or the corner a new selection is dragged from. */
let grab: Point | null = null
let selectFrom: Point | null = null
/**
 * Whether a new selection's drag ever reached another pixel. Tracked rather
 * than read off the release point: placing an import can hide the source pane
 * and move the canvas between press and release, so the two points are not
 * comparable.
 */
let selectDragged = false
/** Whether the pointer is over something the select tool would drag — the cursor says so. */
const overSelection = ref(false)

/**
 * The select tool's press. Inside a float: grab it. Inside a selection: lift
 * it (a copy with Ctrl or Alt) and grab that. Anywhere else: put down what
 * floats and start a new selection — which a plain click turns into none.
 */
function selectDown(event: PointerEvent): void {
  const session = props.session
  const cell = pixelAt(event)
  const floating = session.float
  if (floating && rectContains(floatRect(floating), cell)) {
    grab = { x: cell.x - floating.x, y: cell.y - floating.y }
    return
  }
  if (!floating && session.selection && rectContains(session.selection, cell) && liftSelection(session, event.ctrlKey || event.altKey)) {
    grab = { x: cell.x - session.selection.x, y: cell.y - session.selection.y }
    return
  }
  dropFloat(session)
  selectFrom = cell
  selectDragged = false
  setSelection(session, cell, cell)
}

function selectMove(event: PointerEvent): void {
  const session = props.session
  if (grab) {
    const at = rawPixelAt(event)
    moveFloatTo(session, { x: at.x - grab.x, y: at.y - grab.y })
    return
  }
  if (selectFrom) {
    const cell = pixelAt(event)
    if (cell.x !== selectFrom.x || cell.y !== selectFrom.y) selectDragged = true
    if (selectDragged) setSelection(session, selectFrom, cell)
    return
  }
  const cell = pixelAt(event)
  const rect = session.float ? floatRect(session.float) : session.selection
  overSelection.value = rect !== null && rectContains(rect, cell)
}

function selectUp(): void {
  // A click is not a 1×1 selection; it is "select nothing".
  if (selectFrom && !selectDragged) clearSelection(props.session)
  grab = null
  selectFrom = null
}

function onDown(event: PointerEvent): void {
  if (!convertedPixels.value) return
  const cell = pixelAt(event)
  ;(event.currentTarget as HTMLCanvasElement).setPointerCapture(event.pointerId)
  if (props.session.tool === 'select') {
    selectDown(event)
    return
  }
  if (props.session.tool === 'fragment') {
    cutFrom.value = cell
    cutTo.value = cell
    return
  }
  if (props.session.tool === 'pick') {
    pickAt(props.session, cell)
    return
  }
  if (props.session.tool === 'fill') {
    fillAt(props.session, cell)
    return
  }
  last = cell
  anchor = cell
  toolDrag(props.session, cell, cell)
}

function onMove(event: PointerEvent): void {
  if (props.session.tool === 'select') {
    selectMove(event)
    return
  }
  if (cutFrom.value) {
    cutTo.value = pixelAt(event)
    return
  }
  if (!last || !anchor) return
  const cell = pixelAt(event)
  if (cell.x === last.x && cell.y === last.y) return
  // A pencil walks — each step draws from where the last one ended, so a fast
  // drag leaves no gaps. Line and rectangle rubber-band from the anchor instead.
  if (props.session.tool === 'pencil') {
    paintDrag(props.session, linePoints(last, cell))
  } else {
    toolDrag(props.session, anchor, cell)
  }
  last = cell
}

function onUp(): void {
  if (props.session.tool === 'select') {
    selectUp()
    return
  }
  if (cutFrom.value && cutTo.value) {
    const rect = cutRect.value
    // A click without a drag is a mis-click, not a 1×1 fragment.
    if (rect && rect.width > 1 && rect.height > 1) addFragment(props.session, rect)
    cutFrom.value = null
    cutTo.value = null
    return
  }
  if (!last) return
  finishDrag(props.session)
  last = null
  anchor = null
}

/** The drag rectangle, normalised so it can be dragged in any direction. */
const cutRect = computed(() => {
  const from = cutFrom.value
  const to = cutTo.value
  if (!from || !to) return null
  const x = Math.min(from.x, to.x)
  const y = Math.min(from.y, to.y)
  return { x, y, width: Math.abs(to.x - from.x) + 1, height: Math.abs(to.y - from.y) + 1 }
})

/**
 * The selection's marching box, clipped to the picture — a float can hang off
 * the edge, and its outline should stop where the picture does.
 */
const selectionBox = computed(() => {
  const session = props.session
  const pixels = convertedPixels.value
  const rect = session.float ? floatRect(session.float) : session.selection
  const shown = rect && pixels ? clipRect(rect, pixels.width, pixels.height) : null
  if (!rect || !shown) return null
  const zoom = scale.value
  return {
    floating: session.float !== null,
    label: `${rect.width}×${rect.height}${session.float ? ` at ${rect.x},${rect.y}` : ''}`,
    style: {
      left: `${shown.x * zoom}px`,
      top: `${shown.y * zoom}px`,
      width: `${shown.width * zoom}px`,
      height: `${shown.height * zoom}px`
    }
  }
})

/** Overlay boxes: the live drag, then every fragment already cut. */
const overlays = computed(() => {
  const zoom = scale.value
  const boxes = doc(props.session).fragments.map((fragment, index) => ({
    key: `f${index}`,
    live: false,
    label: fragment.name,
    style: {
      left: `${fragment.x * zoom}px`,
      top: `${fragment.y * zoom}px`,
      width: `${fragment.width * zoom}px`,
      height: `${fragment.height * zoom}px`
    }
  }))
  const rect = cutRect.value
  if (rect) {
    boxes.push({
      key: 'live',
      live: true,
      label: `${rect.width}×${rect.height}`,
      style: {
        left: `${rect.x * zoom}px`,
        top: `${rect.y * zoom}px`,
        width: `${rect.width * zoom}px`,
        height: `${rect.height * zoom}px`
      }
    })
  }
  return boxes
})

watchEffect(() => {
  const element = originalCanvas.value
  const image = props.session.sourceImage
  if (!element || !image) return
  element.width = image.width
  element.height = image.height
  element.getContext('2d')?.putImageData(image, 0, 0)
})

watchEffect(() => {
  const element = canvas.value
  const pixels = convertedPixels.value
  if (!element || !pixels) return
  element.width = pixels.width
  element.height = pixels.height
  const ctx = element.getContext('2d')
  if (!ctx) return
  const rgb = displayRgb(props.session)
  const image = new ImageData(pixels.width, pixels.height)
  for (let i = 0; i < pixels.indices.length; i++) {
    const color = rgb[pixels.indices[i]] ?? { r: 255, g: 0, b: 255 }
    image.data[i * 4] = color.r
    image.data[i * 4 + 1] = color.g
    image.data[i * 4 + 2] = color.b
    image.data[i * 4 + 3] = 255
  }
  ctx.putImageData(image, 0, 0)
})
</script>

<template>
  <div class="canvas-pane">
    <figure v-if="hasSource && session.showOriginal">
      <figcaption>Original — {{ originalDims }}</figcaption>
      <div class="scroller">
        <p
          v-if="!session.sourceImage"
          class="hint"
        >
          {{ session.sourceError ?? 'No source image yet — import one below.' }}
        </p>
        <canvas
          v-else
          ref="originalCanvas"
          class="preview"
          :style="originalStyle"
        />
      </div>
    </figure>
    <figure>
      <figcaption>{{ modeInfo.label }} — {{ convertedDims }} {{ modeInfo.colorModel === 'block' ? 'blocks (draw here)' : '(retouch here)' }}</figcaption>
      <div class="scroller">
        <p
          v-if="!convertedPixels"
          class="hint"
        >
          Not converted yet.
        </p>
        <div
          v-else
          class="stage"
          :style="convertedStyle"
        >
          <canvas
            ref="canvas"
            class="preview interactive"
            :class="{ movable: session.tool === 'select' && overSelection }"
            :style="convertedStyle"
            @pointerdown="onDown"
            @pointermove="onMove"
            @pointerup="onUp"
            @pointercancel="onUp"
          />
          <span
            class="grid"
            :style="gridStyle"
          />
          <span
            v-for="box in screenBoxes"
            :key="box.key"
            class="screen-box"
            :style="box.style"
          />
          <span
            v-for="box in overlays"
            :key="box.key"
            class="cut-box"
            :class="{ live: box.live }"
            :style="box.style"
          ><i>{{ box.label }}</i></span>
          <span
            v-if="selectionBox"
            class="select-box"
            :class="{ floating: selectionBox.floating }"
            :style="selectionBox.style"
          ><i>{{ selectionBox.label }}</i></span>
        </div>
      </div>
    </figure>
  </div>
</template>

<style scoped>
.stage {
  position: relative;
  flex-shrink: 0;
}

.grid {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

/* One screenful of the world, so you can see where a camera would sit. */
.screen-box {
  position: absolute;
  box-sizing: border-box;
  border: 2px solid rgba(0, 200, 255, 0.55);
  pointer-events: none;
}

.cut-box {
  position: absolute;
  box-sizing: border-box;
  border: 1px dashed rgba(120, 170, 255, 0.9);
  pointer-events: none;
}

/* The selection: black-and-white dashes, readable over any picture. */
.select-box {
  position: absolute;
  box-sizing: border-box;
  border: 1px dashed #fff;
  outline: 1px dashed #000;
  outline-offset: -2px;
  pointer-events: none;
}

.select-box.floating {
  border-color: #ffd24e;
}

.select-box i {
  position: absolute;
  bottom: -14px;
  left: 0;
  padding: 0 2px;
  border-radius: 2px;
  background: rgba(0, 0, 0, 0.7);
  color: #fff;
  font-size: 9px;
  font-style: normal;
  white-space: nowrap;
}

.cut-box.live {
  border-style: solid;
  background: rgba(120, 170, 255, 0.18);
}

.cut-box i {
  position: absolute;
  top: -13px;
  left: 0;
  padding: 0 2px;
  border-radius: 2px;
  background: rgba(120, 170, 255, 0.9);
  color: #08121f;
  font-size: 9px;
  font-style: normal;
  white-space: nowrap;
}

.canvas-pane {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  gap: 1px;
  background: var(--color-border);
  overflow: auto;
}

figure {
  flex: 1;
  min-width: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-editor);
}

figcaption {
  padding: 4px 8px;
  font-size: 11px;
  color: var(--color-text-muted);
  border-bottom: 1px solid var(--color-border);
}

.scroller {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px;
}

.preview {
  display: block;
  image-rendering: pixelated;
  border: 1px solid var(--color-border);
  background-color: var(--color-bg-tab-inactive);
  background-image:
    linear-gradient(45deg, rgba(128, 128, 128, 0.25) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(128, 128, 128, 0.25) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(128, 128, 128, 0.25) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(128, 128, 128, 0.25) 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
}

.preview.interactive {
  touch-action: none;
  cursor: crosshair;
}

.preview.interactive.movable {
  cursor: move;
}

.hint {
  margin: 0;
  font-size: 11px;
  color: var(--color-text-muted);
}
</style>
