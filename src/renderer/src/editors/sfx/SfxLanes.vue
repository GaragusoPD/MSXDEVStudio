<script setup lang="ts">
/**
 * The frame grid: three stacked lanes (pitch, noise, volume) over one shared
 * frame axis. Left-drag paints, right-drag erases, and the frame under the
 * pointer is announced so the tab can scrub-play it.
 *
 * Drawing only — every value it computes comes from `shared/sfx-editor.ts`, so
 * the geometry is unit-tested even though the canvas isn't.
 */
import { computed, ref, watchEffect } from 'vue'
import type { SfxFrame } from '../../../../shared/msx/sfx'
import {
  heightFromValue,
  laneActive,
  laneValue,
  LANE_LABEL,
  valueFromHeight,
  type LaneStroke,
  type SfxLane
} from '../../../../shared/sfx-editor'

const props = defineProps<{
  frames: readonly SfxFrame[]
  /** Frame the playhead sits on, or -1. */
  playhead: number
}>()

const emit = defineEmits<{
  paint: [lane: SfxLane, from: LaneStroke, to: LaneStroke, erase: boolean]
  scrub: [frame: number]
}>()

const LANES: SfxLane[] = ['tone', 'noise', 'volume']
const FRAME_W = 12
const LANE_H = 92
const LANE_GAP = 8
const RULER_H = 16

const canvas = ref<HTMLCanvasElement | null>(null)
const width = computed(() => Math.max(1, props.frames.length) * FRAME_W)
const height = RULER_H + LANES.length * (LANE_H + LANE_GAP)

const laneTop = (lane: SfxLane): number => RULER_H + LANES.indexOf(lane) * (LANE_H + LANE_GAP)

/** Which lane a y falls in, and null in the ruler or the gaps between lanes. */
function laneAt(y: number): SfxLane | null {
  for (const lane of LANES) {
    const top = laneTop(lane)
    if (y >= top && y <= top + LANE_H) return lane
  }
  return null
}

/**
 * The frame and lane value under the pointer. `forced` keeps a drag painting
 * the lane it started in — the pointer is free to wander into the gaps or an
 * adjacent lane without the stroke stalling or jumping.
 */
function strokeAt(event: PointerEvent, forced?: SfxLane): { lane: SfxLane; stroke: LaneStroke } | null {
  const element = canvas.value
  if (!element) return null
  const box = element.getBoundingClientRect()
  const x = event.clientX - box.left
  const y = event.clientY - box.top
  const lane = forced ?? laneAt(y)
  if (!lane) return null
  const index = Math.max(0, Math.min(props.frames.length - 1, Math.floor(x / FRAME_W)))
  return { lane, stroke: { index, value: valueFromHeight(lane, 1 - (y - laneTop(lane)) / LANE_H) } }
}

let last: { lane: SfxLane; stroke: LaneStroke } | null = null
let erasing = false

function onPointerDown(event: PointerEvent): void {
  const hit = strokeAt(event)
  if (!hit) return
  erasing = event.button === 2
  last = hit
  canvas.value?.setPointerCapture(event.pointerId)
  emit('paint', hit.lane, hit.stroke, hit.stroke, erasing)
  emit('scrub', hit.stroke.index)
}

function onPointerMove(event: PointerEvent): void {
  if (!last) return
  const hit = strokeAt(event, last.lane)
  if (!hit) return
  emit('paint', last.lane, last.stroke, hit.stroke, erasing)
  if (hit.stroke.index !== last.stroke.index) emit('scrub', hit.stroke.index)
  last = hit
}

function onPointerUp(event: PointerEvent): void {
  last = null
  canvas.value?.releasePointerCapture(event.pointerId)
}

watchEffect(() => {
  const element = canvas.value
  if (!element) return
  const frames = props.frames
  const playhead = props.playhead
  element.width = width.value
  element.height = height
  const ctx = element.getContext('2d')
  if (!ctx) return

  const style = getComputedStyle(element)
  const read = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback
  const accent = read('--color-accent', '#007acc')
  const text = read('--color-text', '#cccccc')
  const muted = read('--color-text-muted', '#8a8a8a')
  const border = read('--color-border', '#3c3c3c')
  const laneBg = read('--color-bg-sidebar', '#252526')

  ctx.clearRect(0, 0, element.width, element.height)
  // Canvas can't resolve CSS custom properties, so the font stack is spelled out.
  ctx.font = '10px system-ui, sans-serif'
  ctx.textBaseline = 'top'

  // Ruler: a tick every 5 frames, numbered every 10.
  ctx.fillStyle = muted
  for (let i = 0; i < frames.length; i += 5) {
    const x = i * FRAME_W
    ctx.fillRect(x, RULER_H - 4, 1, 4)
    if (i % 10 === 0) ctx.fillText(String(i), x + 2, 1)
  }

  for (const lane of LANES) {
    const top = laneTop(lane)
    ctx.fillStyle = laneBg
    ctx.fillRect(0, top, element.width, LANE_H)
    ctx.strokeStyle = border
    ctx.strokeRect(0.5, top + 0.5, element.width - 1, LANE_H - 1)

    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i]
      const x = i * FRAME_W
      const on = laneActive(frame, lane)
      const y = top + (1 - heightFromValue(lane, laneValue(frame, lane))) * LANE_H
      if (!on) {
        // An "off" frame still shows a faint stub so the lane never looks empty by accident.
        ctx.fillStyle = muted
        ctx.globalAlpha = 0.25
        ctx.fillRect(x + 1, top + LANE_H - 3, FRAME_W - 2, 2)
        ctx.globalAlpha = 1
        continue
      }
      ctx.fillStyle = accent
      if (lane === 'tone') {
        // A curve: a marker at the period's height rather than a bar to the floor.
        ctx.fillRect(x + 1, Math.min(top + LANE_H - 3, Math.max(top, y - 1)), FRAME_W - 2, 3)
      } else {
        const barTop = Math.max(top, Math.min(y, top + LANE_H - 2))
        ctx.fillRect(x + 1, barTop, FRAME_W - 2, top + LANE_H - barTop)
      }
    }

    ctx.fillStyle = text
    ctx.globalAlpha = 0.7
    ctx.fillText(LANE_LABEL[lane], 4, top + 3)
    ctx.globalAlpha = 1
  }

  if (playhead >= 0 && playhead < frames.length) {
    ctx.fillStyle = accent
    ctx.globalAlpha = 0.35
    ctx.fillRect(playhead * FRAME_W, RULER_H, FRAME_W, element.height - RULER_H)
    ctx.globalAlpha = 1
  }
})
</script>

<template>
  <div class="lanes">
    <canvas
      ref="canvas"
      :style="{ width: `${width}px`, height: `${height}px` }"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @contextmenu.prevent
    />
  </div>
</template>

<style scoped>
.lanes {
  overflow-x: auto;
  overflow-y: hidden;
  padding: 8px;
  flex: 1;
  min-width: 0;
}

canvas {
  display: block;
  touch-action: none;
  cursor: crosshair;
}
</style>
