<script setup lang="ts">
/**
 * Spec 10 B's main pane: the original source image next to the converted
 * image at real MSX resolution, with pencil/fill retouch on the converted
 * side. All the logic is in `shared/screen-editor.ts` and `./session.ts`;
 * this file only turns pointer events into pixels and draws both canvases.
 */
import { computed, ref, watchEffect } from 'vue'
import { MODES, SC3_BLOCK_DOTS } from '../../../../shared/msx/modes'
import { screenPixels, screenRgb } from '../../../../shared/msx/screen'
import { linePoints, type Point } from '../../../../shared/tile-editor'
import { addFragment, doc, fillAt, finishDrag, paintDrag, pickAt, toolDrag, type ScreenSession } from './session'

const props = defineProps<{ session: ScreenSession }>()

const originalCanvas = ref<HTMLCanvasElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
let last: Point | null = null
/** Drag rectangle of the cut tool, in image pixels. */
const cutFrom = ref<Point | null>(null)
const cutTo = ref<Point | null>(null)

const modeInfo = computed(() => MODES[doc(props.session).mode])
const convertedPixels = computed(() => screenPixels(doc(props.session)))

/**
 * Screen dots per document pixel. One everywhere except SCREEN 3, whose "pixel"
 * is a 4×4 block — so its 64×48 document is drawn at the 256×192 the machine
 * actually shows, and a zoom step means the same thing in every mode.
 */
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

function pixelAt(event: PointerEvent): Point {
  const rect = (event.currentTarget as HTMLCanvasElement).getBoundingClientRect()
  const pixels = convertedPixels.value
  const width = pixels?.width ?? 1
  const height = pixels?.height ?? 1
  const x = Math.floor(((event.clientX - rect.left) / rect.width) * width)
  const y = Math.floor(((event.clientY - rect.top) / rect.height) * height)
  return { x: Math.min(width - 1, Math.max(0, x)), y: Math.min(height - 1, Math.max(0, y)) }
}

/** Where a rubber-band drag started; `last` is where a pencil drag has walked to. */
let anchor: Point | null = null

function onDown(event: PointerEvent): void {
  if (!convertedPixels.value) return
  const cell = pixelAt(event)
  ;(event.currentTarget as HTMLCanvasElement).setPointerCapture(event.pointerId)
  if (props.session.tool === 'cut') {
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
  const current = doc(props.session)
  const pixels = convertedPixels.value
  if (!element || !pixels) return
  element.width = pixels.width
  element.height = pixels.height
  const ctx = element.getContext('2d')
  if (!ctx) return
  const rgb = screenRgb(current)
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
    <figure>
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
            v-for="box in overlays"
            :key="box.key"
            class="cut-box"
            :class="{ live: box.live }"
            :style="box.style"
          ><i>{{ box.label }}</i></span>
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

.cut-box {
  position: absolute;
  box-sizing: border-box;
  border: 1px dashed rgba(120, 170, 255, 0.9);
  pointer-events: none;
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

.hint {
  margin: 0;
  font-size: 11px;
  color: var(--color-text-muted);
}
</style>
