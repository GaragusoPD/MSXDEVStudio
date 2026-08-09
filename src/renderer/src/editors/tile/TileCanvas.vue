<script setup lang="ts">
/**
 * Spec 08's centre pane: the selected tile — or a whole multi-tile block — at
 * large zoom, the drawing tools, and the constraint-resolution popover
 * anchored on the row that refused a color. All the logic is in
 * `shared/tile-editor.ts`; this file only turns pointer events into points and
 * paints the result. Coordinates are in *canvas* space, which is the tile's
 * own 8×8 for a single tile and the whole `w*8 × h*8` design for a block.
 */
import { computed, ref, watchEffect } from 'vue'
import { paletteToRgb, toHex } from '../../../../shared/msx/palette'
import { blockTileAt, colorByteAt, splitColorByte, TILE_SIZE } from '../../../../shared/msx/tile'
import { toolPoints, type Point } from '../../../../shared/tile-editor'
import {
  activeBlock,
  activeExtent,
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

/**
 * The colour a role currently resolves to under `point`, for the drag preview.
 * In a block the pair belongs to the tile the pixel lands in, at that tile's own
 * row — canvas row 11 of a two-tall block is row 3 of the tile below the seam,
 * and every cell may answer differently.
 */
function roleColor(point: Point): number {
  const block = activeBlock(props.session)
  const hit = block && blockTileAt(block, point.x, point.y)
  const { fg, bg } = splitColorByte(
    colorByteAt(props.session.doc, hit ? hit.tile : props.session.active, hit ? hit.ty : point.y)
  )
  return role === 'fg' ? fg : bg
}

const zoom = computed(() => props.session.zoom)
const extent = computed(() => activeExtent(props.session))
// One 8-pixel tile keeps the chosen zoom; a block shrinks to stay on screen.
const step = computed(() => Math.max(2, Math.min(zoom.value, Math.floor((TILE_SIZE * zoom.value) / Math.max(extent.value.width, extent.value.height) * 4))))
const width = computed(() => extent.value.width * step.value)
const height = computed(() => extent.value.height * step.value)
const rgb = computed(() => paletteToRgb(props.session.doc.palette))

/**
 * Where the popover sits: on the offending row for sc2/sc4, at the top for an
 * sc1 group — and at the top in a block too, where the row index is local to
 * one of several tiles and would point at the wrong line.
 */
const popoverTop = computed(() => {
  const open = props.session.conflict
  if (!open || activeBlock(props.session)) return 0
  return open.conflict.scope === 'row' ? open.conflict.index * step.value : 0
})

function pixelAt(event: PointerEvent): Point {
  const rect = (event.currentTarget as HTMLCanvasElement).getBoundingClientRect()
  return {
    x: Math.floor(((event.clientX - rect.left) / rect.width) * extent.value.width),
    y: Math.floor(((event.clientY - rect.top) / rect.height) * extent.value.height)
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
  const px = step.value
  const { width: cols, height: rows } = extent.value
  element.width = width.value
  element.height = height.value
  const context = element.getContext('2d')
  if (!context) return

  // Checkerboard first: palette index 0 is the MSX's transparent entry, so it
  // has to read as a hole rather than as black.
  context.fillStyle = '#3a3a3a'
  context.fillRect(0, 0, width.value, height.value)
  context.fillStyle = '#4a4a4a'
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if ((x + y) % 2 === 0) context.fillRect(x * px, y * px, px, px)
    }
  }

  const pixels = activePixels(props.session)
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const index = pixels[y * cols + x]
      if (index === 0) continue
      context.fillStyle = toHex(rgb.value[index])
      context.fillRect(x * px, y * px, px, px)
    }
  }

  if (preview.value.length) {
    context.globalAlpha = 0.6
    for (const point of preview.value) {
      context.fillStyle = toHex(rgb.value[roleColor(point)])
      context.fillRect(point.x * px, point.y * px, px, px)
    }
    context.globalAlpha = 1
  }

  context.lineWidth = 1
  for (let x = 1; x < cols; x++) {
    // Tile seams stand out: in a block each one is where one name-table entry
    // ends and the next begins, which is where the mode's colour rules reset.
    context.strokeStyle = x % TILE_SIZE === 0 ? 'rgba(120, 170, 255, 0.7)' : 'rgba(255, 255, 255, 0.18)'
    context.beginPath()
    context.moveTo(x * px + 0.5, 0)
    context.lineTo(x * px + 0.5, height.value)
    context.stroke()
  }
  for (let y = 1; y < rows; y++) {
    context.strokeStyle = y % TILE_SIZE === 0 ? 'rgba(120, 170, 255, 0.7)' : 'rgba(255, 255, 255, 0.18)'
    context.beginPath()
    context.moveTo(0, y * px + 0.5)
    context.lineTo(width.value, y * px + 0.5)
    context.stroke()
  }

  // The cell the sidebar's colour, flag and transform controls are aimed at, in
  // the same amber the sidebar's cell picker marks it with rather than the
  // seams' blue, so the two lines don't read as the same thing. Every cell that
  // holds that tile is outlined: a block may list one tile twice, and both
  // places really are the target.
  const block = activeBlock(props.session)
  if (block) {
    context.strokeStyle = '#ffd24e'
    context.lineWidth = 2
    for (let cy = 0; cy < block.height; cy++) {
      for (let cx = 0; cx < block.width; cx++) {
        if (block.tiles[cy * block.width + cx] !== props.session.active) continue
        // Cell corners are in canvas pixels, so a cell is TILE_SIZE of them across.
        context.strokeRect(cx * TILE_SIZE * px + 1, cy * TILE_SIZE * px + 1, TILE_SIZE * px - 2, TILE_SIZE * px - 2)
      }
    }
  }
})
</script>

<template>
  <div class="canvas-pane">
    <div
      class="stage"
      :style="{ width: `${width}px` }"
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
