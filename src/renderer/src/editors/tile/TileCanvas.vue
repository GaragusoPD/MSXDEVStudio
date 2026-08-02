<script setup lang="ts">
/**
 * Spec 08's centre pane: the selected tile at large zoom, the drawing tools,
 * and the constraint-resolution popover anchored on the row that refused a
 * color. All the logic is in `shared/tile-editor.ts`; this file only turns
 * pointer events into points and paints the result.
 */
import { computed, ref, watchEffect } from 'vue'
import { paletteToRgb, toHex } from '../../../../shared/msx/palette'
import { colorByteAt, splitColorByte, TILE_SIZE } from '../../../../shared/msx/tile'
import { toolPoints, type Point } from '../../../../shared/tile-editor'
import {
  activePixels,
  beginStroke,
  cancelConflict,
  endStroke,
  paint,
  resolveConflict,
  type TileSession
} from './session'

const props = defineProps<{ session: TileSession }>()

const canvas = ref<HTMLCanvasElement | null>(null)
const preview = ref<Point[]>([])
let origin: Point | null = null
let last: Point | null = null
// Left button paints the row's foreground, right button its background, and the
// role is fixed for the whole stroke by whichever button started it.
let role: 'fg' | 'bg' = 'fg'

/** The colour a role currently resolves to on `y`, for the drag preview. */
function roleColor(y: number): number {
  const { fg, bg } = splitColorByte(colorByteAt(props.session.doc, props.session.active, y))
  return role === 'fg' ? fg : bg
}

const zoom = computed(() => props.session.zoom)
const size = computed(() => TILE_SIZE * zoom.value)
const rgb = computed(() => paletteToRgb(props.session.doc.palette))

/** Where the popover sits: on the offending row for sc2/sc4, at the top for an sc1 group. */
const popoverTop = computed(() => {
  const open = props.session.conflict
  if (!open) return 0
  return open.conflict.scope === 'row' ? open.conflict.index * zoom.value : 0
})

function pixelAt(event: PointerEvent): Point {
  const rect = (event.currentTarget as HTMLCanvasElement).getBoundingClientRect()
  return {
    x: Math.floor(((event.clientX - rect.left) / rect.width) * TILE_SIZE),
    y: Math.floor(((event.clientY - rect.top) / rect.height) * TILE_SIZE)
  }
}

function onDown(event: PointerEvent): void {
  if (props.session.conflict) return
  role = event.button === 2 ? 'bg' : 'fg'
  const point = pixelAt(event)
  origin = point
  last = point
  ;(event.currentTarget as HTMLCanvasElement).setPointerCapture(event.pointerId)
  beginStroke(props.session)
  const tool = props.session.tool
  if (tool === 'pencil' || tool === 'fill') {
    paint(props.session, toolPoints(tool, point, point, activePixels(props.session), props.session.filledRect), role)
    if (tool === 'fill') endStroke(props.session, 'fill')
  }
}

function onMove(event: PointerEvent): void {
  if (!origin || !last) return
  const point = pixelAt(event)
  if (point.x === last.x && point.y === last.y && props.session.tool !== 'rect') return
  if (props.session.tool === 'pencil') {
    paint(props.session, toolPoints('pencil', last, point, activePixels(props.session)), role)
  } else if (props.session.tool !== 'fill') {
    preview.value = toolPoints(props.session.tool, origin, point, activePixels(props.session), props.session.filledRect)
  }
  last = point
}

function onUp(): void {
  if (!origin || !last) return
  const tool = props.session.tool
  if (tool === 'line' || tool === 'rect') {
    paint(props.session, toolPoints(tool, origin, last, activePixels(props.session), props.session.filledRect), role)
  }
  preview.value = []
  origin = null
  last = null
  if (tool !== 'fill') endStroke(props.session, tool)
}

watchEffect(() => {
  const element = canvas.value
  if (!element) return
  const step = zoom.value
  element.width = size.value
  element.height = size.value
  const context = element.getContext('2d')
  if (!context) return

  // Checkerboard first: palette index 0 is the MSX's transparent entry, so it
  // has to read as a hole rather than as black.
  context.fillStyle = '#3a3a3a'
  context.fillRect(0, 0, size.value, size.value)
  context.fillStyle = '#4a4a4a'
  for (let y = 0; y < TILE_SIZE; y++) {
    for (let x = 0; x < TILE_SIZE; x++) {
      if ((x + y) % 2 === 0) context.fillRect(x * step, y * step, step, step)
    }
  }

  const pixels = activePixels(props.session)
  for (let y = 0; y < TILE_SIZE; y++) {
    for (let x = 0; x < TILE_SIZE; x++) {
      const index = pixels[y * TILE_SIZE + x]
      if (index === 0) continue
      context.fillStyle = toHex(rgb.value[index])
      context.fillRect(x * step, y * step, step, step)
    }
  }

  if (preview.value.length) {
    context.globalAlpha = 0.6
    for (const point of preview.value) {
      context.fillStyle = toHex(rgb.value[roleColor(point.y)])
      context.fillRect(point.x * step, point.y * step, step, step)
    }
    context.globalAlpha = 1
  }

  context.strokeStyle = 'rgba(255, 255, 255, 0.18)'
  context.lineWidth = 1
  for (let i = 1; i < TILE_SIZE; i++) {
    context.beginPath()
    context.moveTo(i * step + 0.5, 0)
    context.lineTo(i * step + 0.5, size.value)
    context.moveTo(0, i * step + 0.5)
    context.lineTo(size.value, i * step + 0.5)
    context.stroke()
  }
})
</script>

<template>
  <div class="canvas-pane">
    <div
      class="stage"
      :style="{ width: `${size}px` }"
    >
      <canvas
        ref="canvas"
        class="tile-canvas"
        @pointerdown="onDown"
        @pointermove="onMove"
        @pointerup="onUp"
        @pointercancel="onUp"
        @contextmenu.prevent
      />

      <div
        v-if="session.conflict"
        class="conflict"
        :style="{ top: `${popoverTop}px` }"
      >
        <p class="title">
          {{ session.conflict.conflict.scope === 'row' ? `Row ${session.conflict.conflict.index}` : `Tiles ${session.conflict.conflict.index * 8}–${session.conflict.conflict.index * 8 + 7}` }}
          already uses two colors.
        </p>
        <p class="detail">
          FG <span
            class="chip"
            :style="{ background: toHex(rgb[session.conflict.conflict.fg]) }"
          />{{ session.conflict.conflict.fg }} ·
          BG <span
            class="chip"
            :style="{ background: toHex(rgb[session.conflict.conflict.bg]) }"
          />{{ session.conflict.conflict.bg }} ·
          painting <span
            class="chip"
            :style="{ background: toHex(rgb[session.conflict.conflict.wanted]) }"
          />{{ session.conflict.conflict.wanted }}
        </p>
        <div class="choices">
          <button
            type="button"
            @click="resolveConflict(session, 'fg')"
          >
            Replace FG
          </button>
          <button
            type="button"
            @click="resolveConflict(session, 'bg')"
          >
            Replace BG
          </button>
          <button
            type="button"
            @click="cancelConflict(session)"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>

    <p class="hint">
      Left click paints the foreground, right click the background.
    </p>
  </div>
</template>

<style scoped>
.canvas-pane {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 12px;
  overflow: auto;
}

.stage {
  position: relative;
}

.tile-canvas {
  display: block;
  image-rendering: pixelated;
  border: 1px solid var(--color-border);
  touch-action: none;
  cursor: crosshair;
}

.hint {
  margin: 0;
  font-size: 11px;
  color: var(--color-text-muted);
}

.conflict {
  position: absolute;
  left: calc(100% + 10px);
  width: 260px;
  padding: 8px 10px;
  background: var(--color-bg-sidebar);
  border: 1px solid var(--color-accent);
  border-radius: 4px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
  z-index: 5;
}

.conflict .title {
  margin: 0 0 4px;
  font-size: 12px;
}

.conflict .detail {
  margin: 0 0 8px;
  font-size: 11px;
  color: var(--color-text-muted);
}

.choices {
  display: flex;
  gap: 6px;
}

.choices button {
  flex: 1;
  padding: 4px 6px;
  font-size: 11px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-hover);
}

.chip {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin: 0 2px -1px 0;
  border: 1px solid var(--color-border);
}

</style>
