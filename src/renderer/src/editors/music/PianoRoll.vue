<script setup lang="ts">
/**
 * The piano roll (Spec 15): pitch down the side, rows of 16th notes across,
 * the three channels' notes on one sheet — the one being edited in full colour,
 * the others dimmed. The ruler (top) and the keyboard (left) are sticky, so
 * they stay put while the sheet scrolls under them.
 *
 * Drawing and pointer plumbing only: the tab decides what a press means using
 * `shared/music-editor.ts`, where the geometry is unit-tested.
 */
import { computed, onMounted, ref, watch, watchEffect } from 'vue'
import { isBlackKey, MAX_PITCH, MIN_PITCH, noteName, ROWS_PER_BAR, ROWS_PER_BEAT, type Instrument, type Song } from '../../../../shared/msx/music'
import { hitNote, KEY_H, pitchAtY, rowAtX, yOfPitch } from '../../../../shared/music-editor'
import { CHANNEL_COLORS, type RollPointer } from './roll'

const props = defineProps<{
  song: Song
  instruments: readonly Instrument[]
  channel: number
  selected: number
  muted: readonly boolean[]
  zoom: number
  /** Song frame under the playhead, or -1. */
  playhead: number
  startRow: number
}>()

const emit = defineEmits<{
  press: [at: RollPointer, button: number]
  drag: [at: RollPointer]
  release: []
  /** A click on the ruler: left moves the start point, right copies that bar to the next. */
  ruler: [row: number, button: number]
  key: [pitch: number]
  zoom: [delta: number]
}>()

const KEYS_W = 46
const RULER_H = 18
const PITCHES = MAX_PITCH - MIN_PITCH + 1

const scroller = ref<HTMLDivElement | null>(null)
const grid = ref<HTMLCanvasElement | null>(null)
const ruler = ref<HTMLCanvasElement | null>(null)
const keys = ref<HTMLCanvasElement | null>(null)

const rows = computed(() => props.song.bars * ROWS_PER_BAR)
const gridW = computed(() => rows.value * props.zoom)
const gridH = PITCHES * KEY_H

function theme(element: HTMLElement): Record<'accent' | 'text' | 'muted' | 'border' | 'bg' | 'dark', string> {
  const style = getComputedStyle(element)
  const read = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback
  return {
    accent: read('--color-accent', '#007acc'),
    text: read('--color-text', '#cccccc'),
    muted: read('--color-text-muted', '#8a8a8a'),
    border: read('--color-border', '#3c3c3c'),
    bg: read('--color-bg-editor', '#1e1e1e'),
    dark: read('--color-bg-sidebar', '#252526')
  }
}

function pointer(event: PointerEvent): RollPointer {
  const box = grid.value!.getBoundingClientRect()
  const x = event.clientX - box.left
  const y = event.clientY - box.top
  return { x, y, row: rowAtX(x, props.zoom, rows.value), pitch: pitchAtY(y) }
}

let pressing = false
const cursor = ref('crosshair')

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0 && event.button !== 2) return
  pressing = true
  grid.value?.setPointerCapture(event.pointerId)
  emit('press', pointer(event), event.button)
}

function onPointerMove(event: PointerEvent): void {
  const at = pointer(event)
  if (pressing) {
    emit('drag', at)
    return
  }
  const hit = hitNote(props.song, props.channel, at.x, at.y, props.zoom)
  cursor.value = !hit ? 'crosshair' : hit.part === 'end' ? 'ew-resize' : 'grab'
}

function onPointerUp(event: PointerEvent): void {
  if (!pressing) return
  pressing = false
  grid.value?.releasePointerCapture(event.pointerId)
  emit('release')
}

function onRuler(event: MouseEvent): void {
  const box = ruler.value!.getBoundingClientRect()
  emit('ruler', rowAtX(event.clientX - box.left, props.zoom, rows.value), event.button)
}

function onKey(event: MouseEvent): void {
  const box = keys.value!.getBoundingClientRect()
  emit('key', pitchAtY(event.clientY - box.top))
}

function onWheel(event: WheelEvent): void {
  if (!event.ctrlKey) return
  event.preventDefault()
  emit('zoom', event.deltaY < 0 ? 2 : -2)
}

onMounted(() => {
  // Open on the middle of the range: C6 at the top shows the octaves tunes live in.
  if (scroller.value) scroller.value.scrollTop = yOfPitch(84)
})

// Keep the playhead on screen while it plays.
watch(
  () => props.playhead,
  (frame) => {
    const element = scroller.value
    if (!element || frame < 0) return
    const x = (frame / props.song.speed) * props.zoom
    const visible = element.clientWidth - KEYS_W
    if (x < element.scrollLeft || x > element.scrollLeft + visible - 40) element.scrollLeft = Math.max(0, x - 40)
  }
)

// ── the sheet ───────────────────────────────────────────────────────────────
watchEffect(() => {
  const element = grid.value
  if (!element) return
  const { song, zoom, channel, selected, muted, playhead, instruments } = props
  element.width = gridW.value
  element.height = gridH
  const ctx = element.getContext('2d')
  if (!ctx) return
  const colors = theme(element)

  ctx.fillStyle = colors.bg
  ctx.fillRect(0, 0, element.width, element.height)
  // Black-key rows a shade darker, and a line under every C.
  for (let pitch = MIN_PITCH; pitch <= MAX_PITCH; pitch++) {
    const y = yOfPitch(pitch)
    if (isBlackKey(pitch)) {
      ctx.fillStyle = colors.dark
      ctx.fillRect(0, y, element.width, KEY_H)
    }
    if (pitch % 12 === 0) {
      ctx.fillStyle = colors.border
      ctx.fillRect(0, y + KEY_H - 1, element.width, 1)
    }
  }
  // Rows, beats, bars — fainter to stronger.
  for (let row = 0; row <= rows.value; row++) {
    const bar = row % ROWS_PER_BAR === 0
    const beat = row % ROWS_PER_BEAT === 0
    if (!bar && !beat && zoom < 8) continue
    ctx.fillStyle = bar ? colors.muted : colors.border
    ctx.globalAlpha = bar ? 0.7 : beat ? 0.9 : 0.35
    ctx.fillRect(row * zoom, 0, 1, element.height)
  }
  ctx.globalAlpha = 1
  // The loop point.
  ctx.fillStyle = colors.accent
  ctx.fillRect(song.loopBar * ROWS_PER_BAR * zoom, 0, 2, element.height)

  ctx.font = '9px system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  const order = [0, 1, 2].filter((one) => one !== channel).concat(channel)
  for (const ch of order) {
    const active = ch === channel
    ctx.globalAlpha = muted[ch] ? 0.12 : active ? 1 : 0.3
    song.channels[ch].forEach((note, index) => {
      const x = note.row * zoom
      const y = yOfPitch(note.pitch)
      const w = note.length * zoom
      ctx.fillStyle = CHANNEL_COLORS[ch]
      ctx.fillRect(x + 1, y + 1, w - 2, KEY_H - 2)
      if (active && index === selected) {
        ctx.strokeStyle = colors.text
        ctx.lineWidth = 2
        ctx.strokeRect(x + 1, y + 1, w - 2, KEY_H - 2)
      }
      if (active && w > 34) {
        ctx.fillStyle = '#1e1e1e'
        ctx.fillText((instruments[note.instrument]?.name ?? '?').slice(0, Math.floor(w / 6)), x + 4, y + KEY_H / 2)
      }
    })
  }
  ctx.globalAlpha = 1

  if (playhead >= 0) {
    ctx.fillStyle = colors.text
    ctx.fillRect(Math.round((playhead / song.speed) * zoom), 0, 2, element.height)
  }
})

// ── the ruler ───────────────────────────────────────────────────────────────
watchEffect(() => {
  const element = ruler.value
  if (!element) return
  const { song, zoom, startRow } = props
  element.width = gridW.value
  element.height = RULER_H
  const ctx = element.getContext('2d')
  if (!ctx) return
  const colors = theme(element)
  ctx.fillStyle = colors.dark
  ctx.fillRect(0, 0, element.width, element.height)
  ctx.font = '10px system-ui, sans-serif'
  ctx.textBaseline = 'top'
  for (let row = 0; row < rows.value; row += ROWS_PER_BEAT) {
    const bar = row % ROWS_PER_BAR === 0
    ctx.fillStyle = colors.muted
    ctx.fillRect(row * zoom, bar ? 0 : RULER_H - 5, 1, bar ? RULER_H : 5)
    if (bar) {
      ctx.fillStyle = colors.text
      ctx.fillText(String(row / ROWS_PER_BAR + 1), row * zoom + 3, 2)
    }
  }
  // Loop point and start point.
  ctx.fillStyle = colors.accent
  const loopX = song.loopBar * ROWS_PER_BAR * zoom
  ctx.fillRect(loopX, 0, 2, RULER_H)
  ctx.fillText('⟲', loopX + 14, 2)
  const startX = startRow * zoom
  ctx.beginPath()
  ctx.moveTo(startX, RULER_H)
  ctx.lineTo(startX + 6, RULER_H - 7)
  ctx.lineTo(startX - 6, RULER_H - 7)
  ctx.closePath()
  ctx.fill()
  ctx.fillStyle = colors.border
  ctx.fillRect(0, RULER_H - 1, element.width, 1)
})

// ── the keyboard ────────────────────────────────────────────────────────────
watchEffect(() => {
  const element = keys.value
  if (!element) return
  element.width = KEYS_W
  element.height = gridH
  const ctx = element.getContext('2d')
  if (!ctx) return
  const colors = theme(element)
  ctx.font = '9px system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  for (let pitch = MIN_PITCH; pitch <= MAX_PITCH; pitch++) {
    const y = yOfPitch(pitch)
    const black = isBlackKey(pitch)
    ctx.fillStyle = black ? '#2b2b2b' : '#d8d8d8'
    ctx.fillRect(0, y, black ? KEYS_W * 0.62 : KEYS_W, KEY_H)
    if (black) {
      ctx.fillStyle = '#d8d8d8'
      ctx.fillRect(KEYS_W * 0.62, y, KEYS_W * 0.38, KEY_H)
    }
    ctx.fillStyle = '#888888'
    ctx.fillRect(0, y + KEY_H - 1, KEYS_W, 1)
    if (pitch % 12 === 0) {
      ctx.fillStyle = '#333333'
      ctx.fillText(noteName(pitch), KEYS_W - 24, y + KEY_H / 2)
    }
  }
  ctx.fillStyle = colors.border
  ctx.fillRect(KEYS_W - 1, 0, 1, element.height)
})
</script>

<template>
  <div
    ref="scroller"
    class="roll"
    @wheel="onWheel"
  >
    <div
      class="sheet"
      :style="{ gridTemplateColumns: `${KEYS_W}px ${gridW}px`, gridTemplateRows: `${RULER_H}px ${gridH}px` }"
    >
      <div class="corner" />
      <canvas
        ref="ruler"
        class="ruler"
        title="Click: play from here · Right-click: copy this bar into the next one"
        :style="{ width: `${gridW}px`, height: `${RULER_H}px` }"
        @mousedown="onRuler"
        @contextmenu.prevent
      />
      <canvas
        ref="keys"
        class="keys"
        title="Click a key to hear it with the current instrument"
        :style="{ width: `${KEYS_W}px`, height: `${gridH}px` }"
        @mousedown="onKey"
      />
      <canvas
        ref="grid"
        class="grid"
        :style="{ width: `${gridW}px`, height: `${gridH}px`, cursor }"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @contextmenu.prevent
      />
    </div>
  </div>
</template>

<style scoped>
.roll {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  background: var(--color-bg-editor);
}

.sheet {
  display: grid;
  width: max-content;
}

.corner {
  position: sticky;
  top: 0;
  left: 0;
  z-index: 3;
  background: var(--color-bg-sidebar);
  border-bottom: 1px solid var(--color-border);
}

.ruler {
  position: sticky;
  top: 0;
  z-index: 2;
  cursor: pointer;
}

.keys {
  position: sticky;
  left: 0;
  z-index: 2;
  cursor: pointer;
}

canvas {
  display: block;
  touch-action: none;
}
</style>
