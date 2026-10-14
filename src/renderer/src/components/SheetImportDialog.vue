<script setup lang="ts">
/**
 * Imports cells from an asset sheet — a PNG of tiles or animation frames on a
 * grid — into a tileset, a map, an animated tile, a meta-tile or a sprite
 * sheet (design: docs/superpowers/specs/2026-10-14-sheet-import-design.md).
 *
 * The component holds view state only. Cutting is `shared/msx/sheet.ts`,
 * what each destination makes of a cell is `shared/msx/sheet-convert.ts`, and
 * where it lands is `editors/sheet-import.ts`. It stays open after an import,
 * so the next row of the same sheet can go somewhere else.
 */
import { computed, onUnmounted, reactive, ref, shallowRef, watch } from 'vue'
import { TILE_MODES, MODES, type TileMode } from '../../../shared/msx/modes'
import type { DitherMode, QuantizeOptions, QuantizeResult } from '../../../shared/msx/quantize'
import {
  applyKey,
  cellsInRange,
  cellsInRect,
  contentBox,
  cropImage,
  cutCell,
  DEFAULT_GRID,
  detectKey,
  detectScale,
  gridSize,
  guessGrid,
  isEmpty,
  roundUp,
  rowsOf,
  scaleDown,
  snapBox,
  splitStrip,
  stripOf,
  type SheetGrid
} from '../../../shared/msx/sheet'
import { cellsToSprite, type SheetCell } from '../../../shared/msx/sheet-convert'
import { compositeFrame, type SpriteMode, type SpriteSize } from '../../../shared/msx/sprite'
import { TILE_SIZE } from '../../../shared/msx/tile'
import { decode } from '../composables/useImageImport'
import { useQuantizer } from '../composables/useQuantizer'
import {
  applySheetImport,
  DESTINATION_KIND,
  describeTarget,
  sheetName,
  type SheetDestination,
  type TargetInfo
} from '../editors/sheet-import'
import { useProjectStore } from '../stores/projectStore'
import { useResourcesStore } from '../stores/resourcesStore'
import Icon from './Icon.vue'

const props = withDefaults(defineProps<{ destination?: SheetDestination | null; target?: string | null }>(), {
  destination: null,
  target: null
})
const emit = defineEmits<{ close: [] }>()

const projectStore = useProjectStore()
const resourcesStore = useResourcesStore()
const quantizer = useQuantizer()

const DESTINATIONS: { id: SheetDestination; label: string }[] = [
  { id: 'tiles', label: 'Tileset' },
  { id: 'map', label: 'Map (place on it)' },
  { id: 'anim', label: 'Animated tile' },
  { id: 'meta', label: 'Meta-tile' },
  { id: 'sprites', label: 'Sprites' }
]
const ZOOMS = [1, 2, 3, 4, 6, 8]

// ── the sheet ───────────────────────────────────────────────────────────────

const raw = shallowRef<ImageData | null>(null)
const loadError = ref<string | null>(null)
const scale = ref(1)
const keyColor = ref<number | null>(null)
const tolerance = ref(0)
const picking = ref(false)
const grid = reactive<SheetGrid>({ ...DEFAULT_GRID })
const zoom = ref(2)
const selected = ref<number[]>([])
let anchor: number | null = null

const scaled = computed(() => (raw.value ? scaleDown(raw.value, scale.value) : null))
const prepared = computed(() => (scaled.value ? applyKey(scaled.value, keyColor.value, tolerance.value) : null))
const size = computed(() => (prepared.value ? gridSize(prepared.value, grid) : { cols: 0, rows: 0 }))
const keyHex = computed(() => (keyColor.value === null ? null : `#${keyColor.value.toString(16).padStart(6, '0')}`))

async function onPick(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    loadError.value = null
    raw.value = await decode(file)
    name.value = sheetName(file.name)
    guess()
    // Fit the sheet to the pane, at a whole zoom so every dot stays square.
    const width = Math.floor(raw.value.width / scale.value)
    zoom.value = ZOOMS.filter((z) => z * width <= 720).pop() ?? 1
  } catch (error) {
    loadError.value = `Couldn't read ${file.name}: ${String(error)}`
    raw.value = null
  }
}

/** Scale, transparent colour and grid, all read from the image. */
function guess(): void {
  if (!raw.value) return
  scale.value = detectScale(raw.value)
  const small = scaleDown(raw.value, scale.value)
  keyColor.value = detectKey(small)
  Object.assign(grid, guessGrid(applyKey(small, keyColor.value, tolerance.value)))
  selected.value = []
  anchor = null
}

// The grid changes what a cell index means.
watch([() => ({ ...grid }), scale], () => {
  selected.value = []
  anchor = null
})

// ── the destination ─────────────────────────────────────────────────────────

const destination = ref<SheetDestination>(props.destination ?? 'tiles')
/** An existing file to add to, or '' for a new one. */
const target = ref<string>(props.target ?? '')
const name = ref('sheet')
const newMode = ref<TileMode>('sc2')
const spriteMode = ref<SpriteMode>(2)
const spriteSize = ref<SpriteSize>(16)
const paletteChoice = ref<'msx1' | 'optimized'>('msx1')
const dither = ref<DitherMode>('none')
const blocks = ref(true)
const withMap = ref(false)
const onePerRow = ref(true)
const skipEmpty = ref(true)
const trim = ref(true)
const duration = ref(8)
const maxPlanes = ref(3)
const info = ref<TargetInfo | null>(null)

const targets = computed(() =>
  resourcesStore.entries.filter((entry) => entry.kind === DESTINATION_KIND[destination.value]).map((entry) => entry.path)
)
const animated = computed(() => destination.value === 'anim' || destination.value === 'meta' || destination.value === 'sprites')

watch(destination, () => {
  if (destination.value === 'map' && !target.value) target.value = targets.value[0] ?? ''
  else if (target.value && !targets.value.includes(target.value)) target.value = ''
})
watch(
  [destination, target],
  async () => {
    info.value = target.value ? await describeTarget(destination.value, target.value) : null
  },
  { immediate: true }
)
void resourcesStore.refresh()

const tileMode = computed<TileMode>(() => info.value?.mode ?? newMode.value)
const sprite = computed(() => info.value?.sprite ?? { mode: spriteMode.value, size: spriteSize.value })
/** Whether the palette is the user's to choose: a new sc4 tileset, a new MSX2 sprite sheet. */
const paletteChoosable = computed(() =>
  destination.value === 'sprites' ? !info.value && spriteMode.value === 2 : !info.value?.palette && tileMode.value === 'sc4'
)

const quantizeOptions = computed((): QuantizeOptions => {
  if (destination.value === 'sprites') {
    // Sprites take any colour per dot; the plane split comes after.
    const palette = info.value?.palette ?? (sprite.value.mode === 2 ? paletteChoice.value : 'msx1')
    return { mode: 'sc5', palette: Array.isArray(palette) ? [...palette] : palette, dither: dither.value }
  }
  const mode = tileMode.value
  const palette = mode === 'sc4' ? (info.value?.palette ?? paletteChoice.value) : 'msx1'
  return { mode, palette: Array.isArray(palette) ? [...palette] : palette, dither: dither.value }
})

// ── the cells picked, cut and converted ─────────────────────────────────────

interface Picked {
  cells: { width: number; height: number; data: Uint8ClampedArray | Uint8Array }[]
  at: { col: number; row: number }[]
  groups: number[][]
}

const picked = computed((): Picked | null => {
  const image = prepared.value
  if (!image || !selected.value.length) return null
  const cols = size.value.cols
  let indices = [...selected.value]
  let cells = indices.map((index) => cutCell(image, grid, index))
  if (skipEmpty.value) {
    const keep = cells.map((cell) => !isEmpty(cell))
    indices = indices.filter((_, i) => keep[i])
    cells = cells.filter((_, i) => keep[i])
  }
  if (!cells.length) return null
  if (trim.value && (destination.value === 'sprites' || destination.value === 'meta')) {
    const found = contentBox(cells)
    // A meta-tile's trim keeps whole tiles of the sheet's own grid; a sprite
    // can sit anywhere, so its trim is to the dot.
    const box = found && destination.value === 'meta' ? snapBox(found, TILE_SIZE, cells[0].width, cells[0].height) : found
    if (box) cells = cells.map((cell) => cropImage(cell, box.x, box.y, box.width, box.height))
  }
  if (destination.value !== 'sprites') {
    // Tiles are 8×8: pad with transparency to whole tiles.
    const width = roundUp(cells[0].width, TILE_SIZE)
    const height = roundUp(cells[0].height, TILE_SIZE)
    if (width !== cells[0].width || height !== cells[0].height) cells = cells.map((cell) => cropImage(cell, 0, 0, width, height))
  }
  const at = indices.map((index) => ({ col: index % cols, row: Math.floor(index / cols) }))
  const rows = rowsOf(indices, cols)
  const groups =
    onePerRow.value && animated.value && rows.length > 1 && !(target.value && destination.value !== 'sprites')
      ? rows.map((row) => row.map((index) => indices.indexOf(index)))
      : [indices.map((_, i) => i)]
  return { cells, at, groups }
})

const converted = shallowRef<{ cells: SheetCell[]; result: QuantizeResult } | null>(null)
const converting = ref(false)
const convertError = ref<string | null>(null)
let conversion = 0

watch(
  [picked, quantizeOptions],
  async () => {
    const pick = picked.value
    const id = ++conversion
    if (!pick) {
      converted.value = null
      return
    }
    converting.value = true
    try {
      const { width, height } = pick.cells[0]
      const result = await quantizer.run(stripOf(pick.cells), quantizeOptions.value)
      if (id !== conversion) return
      const cells = splitStrip(result.indices, width, height, pick.cells.length).map((indices) => ({ width, height, indices }))
      converted.value = { cells, result }
      convertError.value = null
    } catch (error) {
      if (id !== conversion) return
      converted.value = null
      convertError.value = String(error)
    } finally {
      if (id === conversion) converting.value = false
    }
  },
  { immediate: true }
)

/** For sprites, the frames as the VDP will show them — after the plane split. */
const spritePreview = computed(() => {
  const made = converted.value
  if (destination.value !== 'sprites' || !made) return null
  const result = cellsToSprite(made.cells, {
    mode: sprite.value.mode,
    size: sprite.value.size,
    maxPlanes: maxPlanes.value,
    palette: made.result.rgb,
    name: 'preview'
  })
  return result
})

// ── importing ───────────────────────────────────────────────────────────────

const busy = ref(false)
const outcome = ref<{ status: string; failed?: boolean } | null>(null)

const blocker = computed((): string | null => {
  if (!projectStore.open) return 'Open a project first.'
  if (!raw.value) return 'Pick a sheet.'
  if (!selected.value.length) return 'Click the cells to import.'
  if (!picked.value) return 'Every selected cell is empty.'
  if (info.value?.error) return info.value.error
  if (destination.value === 'map' && !target.value) return 'There is no map to place the cells on.'
  if (!target.value && !sheetName(name.value)) return 'Name the new file.'
  if (typeof spritePreview.value === 'string') return spritePreview.value
  return null
})

async function doImport(): Promise<void> {
  const made = converted.value
  const pick = picked.value
  if (!made || !pick || blocker.value) return
  busy.value = true
  outcome.value = await applySheetImport({
    destination: destination.value,
    target: target.value || null,
    name: name.value,
    mode: tileMode.value,
    sprite: sprite.value,
    cells: made.cells,
    at: pick.at,
    groups: pick.groups,
    palette: made.result.palette,
    rgb: made.result.rgb,
    blocks: blocks.value,
    withMap: withMap.value,
    duration: duration.value,
    maxPlanes: maxPlanes.value
  })
  busy.value = false
  // A new file now exists: the next import of the same name has to pick another.
  if (!outcome.value.failed) void resourcesStore.refresh()
}

// ── drawing the sheet ───────────────────────────────────────────────────────

const sheetCanvas = ref<HTMLCanvasElement | null>(null)

function cellAt(x: number, y: number): number | null {
  const { cols, rows } = size.value
  const pitchX = grid.cellWidth + grid.spacingX
  const pitchY = grid.cellHeight + grid.spacingY
  const col = Math.floor((x - grid.offsetX) / pitchX)
  const row = Math.floor((y - grid.offsetY) / pitchY)
  if (col < 0 || row < 0 || col >= cols || row >= rows) return null
  // In a gap between cells: nothing.
  if (x - grid.offsetX - col * pitchX >= grid.cellWidth || y - grid.offsetY - row * pitchY >= grid.cellHeight) return null
  return row * cols + col
}

function drawSheet(): void {
  const canvas = sheetCanvas.value
  const image = prepared.value
  if (!canvas || !image) return
  const z = zoom.value
  canvas.width = image.width * z
  canvas.height = image.height * z
  const context = canvas.getContext('2d')
  if (!context) return
  const source = new OffscreenCanvas(image.width, image.height)
  source.getContext('2d')?.putImageData(new ImageData(Uint8ClampedArray.from(image.data), image.width, image.height), 0, 0)
  context.imageSmoothingEnabled = false
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  const { cols, rows } = size.value
  const order = new Map(selected.value.map((cell, i) => [cell, i + 1]))
  context.lineWidth = 1
  context.font = `${Math.max(9, Math.min(14, grid.cellHeight * z * 0.35))}px sans-serif`
  context.textBaseline = 'top'
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = (grid.offsetX + col * (grid.cellWidth + grid.spacingX)) * z
      const y = (grid.offsetY + row * (grid.cellHeight + grid.spacingY)) * z
      const w = grid.cellWidth * z
      const h = grid.cellHeight * z
      const n = order.get(row * cols + col)
      if (n !== undefined) {
        context.fillStyle = 'rgba(0, 122, 204, 0.35)'
        context.fillRect(x, y, w, h)
        context.strokeStyle = 'rgba(0, 160, 255, 0.95)'
        context.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
        if (h >= 14) {
          context.fillStyle = '#ffffff'
          context.fillText(String(n), x + 2, y + 2)
        }
      } else {
        context.strokeStyle = 'rgba(255, 255, 255, 0.28)'
        context.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
      }
    }
  }
}

watch([prepared, () => ({ ...grid }), selected, zoom, size], drawSheet, { flush: 'post' })

let dragFrom: number | null = null
let dragBase: number[] = []

function dotAt(event: MouseEvent): { x: number; y: number } {
  const rect = (event.currentTarget as HTMLCanvasElement).getBoundingClientRect()
  return { x: Math.floor((event.clientX - rect.left) / zoom.value), y: Math.floor((event.clientY - rect.top) / zoom.value) }
}

function sorted(cells: Iterable<number>): number[] {
  return [...new Set(cells)].sort((a, b) => a - b)
}

function onDown(event: MouseEvent): void {
  const { x, y } = dotAt(event)
  if (picking.value) {
    const image = scaled.value
    if (image && x >= 0 && y >= 0 && x < image.width && y < image.height) {
      const p = (y * image.width + x) * 4
      if (image.data[p + 3] >= 128) keyColor.value = (image.data[p] << 16) | (image.data[p + 1] << 8) | image.data[p + 2]
    }
    picking.value = false
    return
  }
  const cell = cellAt(x, y)
  if (cell === null) return
  if (event.shiftKey && anchor !== null) {
    selected.value = sorted([...(event.ctrlKey || event.metaKey ? selected.value : []), ...cellsInRange(anchor, cell)])
    return
  }
  if (event.ctrlKey || event.metaKey) {
    selected.value = selected.value.includes(cell) ? selected.value.filter((c) => c !== cell) : sorted([...selected.value, cell])
    anchor = cell
    return
  }
  anchor = cell
  dragFrom = cell
  dragBase = []
  selected.value = [cell]
}

function onMove(event: MouseEvent): void {
  if (dragFrom === null || !(event.buttons & 1)) return
  const cell = cellAt(dotAt(event).x, dotAt(event).y)
  if (cell === null) return
  selected.value = sorted([...dragBase, ...cellsInRect(dragFrom, cell, size.value.cols)])
}

function onUp(): void {
  dragFrom = null
}

function selectAll(): void {
  selected.value = Array.from({ length: size.value.cols * size.value.rows }, (_, i) => i)
}

// ── drawing the result ──────────────────────────────────────────────────────

const resultCanvas = ref<HTMLCanvasElement | null>(null)
const playCanvas = ref<HTMLCanvasElement | null>(null)
const RESULT_ZOOM = 2

/** What each frame will look like: the converted cell, or for sprites the planes composited. */
const shownFrames = computed((): { width: number; height: number; indices: Uint8Array }[] => {
  const made = converted.value
  if (!made) return []
  const preview = spritePreview.value
  if (preview && typeof preview !== 'string') {
    const { size: s, mode } = sprite.value
    const { cols, rows } = preview.character
    return preview.character.frames.map((frame) => ({ width: cols * s, height: rows * s, indices: compositeFrame(frame.layers, mode, s, cols, rows) }))
  }
  return made.cells
})

function paintFrame(context: CanvasRenderingContext2D, frame: { width: number; height: number; indices: Uint8Array }, ox: number, oy: number, z: number): void {
  const rgb = converted.value?.result.rgb ?? []
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      const value = frame.indices[y * frame.width + x]
      if (!value) continue
      const color = rgb[value] ?? { r: 255, g: 0, b: 255 }
      context.fillStyle = `rgb(${color.r}, ${color.g}, ${color.b})`
      context.fillRect(ox + x * z, oy + y * z, z, z)
    }
  }
}

function drawResult(): void {
  const canvas = resultCanvas.value
  const frames = shownFrames.value
  if (!canvas) return
  const context = canvas.getContext('2d')
  if (!context) return
  if (!frames.length) {
    canvas.width = 1
    canvas.height = 1
    return
  }
  const z = RESULT_ZOOM
  const { width, height } = frames[0]
  const perRow = Math.max(1, Math.floor(520 / ((width + 2) * z)))
  canvas.width = Math.min(frames.length, perRow) * (width + 2) * z
  canvas.height = Math.ceil(frames.length / perRow) * (height + 2) * z
  context.clearRect(0, 0, canvas.width, canvas.height)
  frames.forEach((frame, n) => paintFrame(context, frame, (n % perRow) * (width + 2) * z, Math.floor(n / perRow) * (height + 2) * z, z))
}

watch(shownFrames, drawResult, { flush: 'post' })

// Animated destinations: play the frames at the pose duration (one VBlank = 20 ms).
const playFrame = ref(0)
let timer: ReturnType<typeof setInterval> | null = null
watch(
  [shownFrames, duration, animated],
  () => {
    if (timer) clearInterval(timer)
    timer = null
    playFrame.value = 0
    if (animated.value && shownFrames.value.length > 1) {
      timer = setInterval(() => (playFrame.value = (playFrame.value + 1) % shownFrames.value.length), Math.max(1, duration.value) * 20)
    }
  },
  { immediate: true }
)
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

watch(
  [playFrame, shownFrames],
  () => {
    const canvas = playCanvas.value
    const frame = shownFrames.value[playFrame.value]
    if (!canvas || !frame) return
    const z = 4
    canvas.width = frame.width * z
    canvas.height = frame.height * z
    const context = canvas.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, canvas.width, canvas.height)
    paintFrame(context, frame, 0, 0, z)
  },
  { flush: 'post' }
)

const summary = computed((): string[] => {
  const made = converted.value
  if (!made) return []
  const lines: string[] = []
  const { width, height } = made.cells[0]
  const frames = made.cells.length
  lines.push(`${frames} cell${frames === 1 ? '' : 's'} of ${width}×${height}`)
  const report = made.result.report
  lines.push(`${report.colorsUsed} colours used${report.colorsMerged ? `, ${report.colorsMerged} merged` : ''}`)
  if (report.rowsAltered) lines.push(`${report.rowsAltered} rows held to two colours (${report.pixelsChanged} dots moved)`)
  const preview = spritePreview.value
  if (preview && typeof preview !== 'string') {
    const planes = preview.character.frames[0]?.layers.length ?? 0
    const limit = sprite.value.mode === 1 ? 4 : 8
    lines.push(`${preview.character.cols}×${preview.character.rows} sprites, ${planes} plane${planes === 1 ? '' : 's'} a frame`)
    lines.push(`${preview.spritesPerLine} sprites on a line at worst (the VDP shows ${limit})${preview.merged ? `; ${preview.merged} dots took a nearby colour` : ''}`)
  }
  if (destination.value === 'anim' || destination.value === 'meta') {
    lines.push(`${width / TILE_SIZE}×${height / TILE_SIZE} tiles a pose`)
  }
  if (picked.value && picked.value.groups.length > 1) lines.push(`${picked.value.groups.length} ${destination.value === 'sprites' ? 'characters' : 'files'}, one per row`)
  return lines
})
</script>

<template>
  <div
    class="backdrop"
    @click.self="emit('close')"
  >
    <div class="dialog">
      <header>
        <h2>Import sheet</h2>
        <button
          type="button"
          class="close"
          title="Close"
          @click="emit('close')"
        >
          <Icon name="close" />
        </button>
      </header>

      <div class="body">
        <section class="sheet">
          <div class="row">
            <input
              type="file"
              accept="image/*"
              @change="onPick"
            >
            <label class="inline">
              <span>Zoom</span>
              <select v-model.number="zoom">
                <option
                  v-for="z in ZOOMS"
                  :key="z"
                  :value="z"
                >{{ z }}×</option>
              </select>
            </label>
          </div>
          <p
            v-if="loadError"
            class="error"
          >
            {{ loadError }}
          </p>
          <div
            class="scroller"
            :class="{ picking }"
          >
            <canvas
              v-if="raw"
              ref="sheetCanvas"
              @mousedown="onDown"
              @mousemove="onMove"
              @mouseup="onUp"
              @mouseleave="onUp"
            />
            <p
              v-else
              class="hint empty"
            >
              Pick a PNG of tiles or animation frames — the kind asset packs ship.
            </p>
          </div>
          <p class="hint">
            Click a cell, drag over several, Shift+click to extend, Ctrl+click to add or remove one. Frames go in
            reading order.
            <button
              type="button"
              class="link"
              :disabled="!raw"
              @click="selectAll"
            >
              Select all
            </button>
            ·
            <button
              type="button"
              class="link"
              :disabled="!selected.length"
              @click="selected = []"
            >
              Clear
            </button>
          </p>
        </section>

        <section class="side">
          <h3>Grid</h3>
          <div class="grid4">
            <label><span>Cell W</span><input
              v-model.number="grid.cellWidth"
              type="number"
              min="1"
              max="256"
            ></label>
            <label><span>Cell H</span><input
              v-model.number="grid.cellHeight"
              type="number"
              min="1"
              max="256"
            ></label>
            <label><span>Margin X</span><input
              v-model.number="grid.offsetX"
              type="number"
              min="0"
            ></label>
            <label><span>Margin Y</span><input
              v-model.number="grid.offsetY"
              type="number"
              min="0"
            ></label>
            <label><span>Gap X</span><input
              v-model.number="grid.spacingX"
              type="number"
              min="0"
            ></label>
            <label><span>Gap Y</span><input
              v-model.number="grid.spacingY"
              type="number"
              min="0"
            ></label>
            <label><span>Pixel scale</span><input
              v-model.number="scale"
              type="number"
              min="1"
              max="8"
            ></label>
            <label><span>&nbsp;</span><button
              type="button"
              :disabled="!raw"
              title="Read the scale, the transparent colour and the grid from the image"
              @click="guess"
            >Guess</button></label>
          </div>
          <p class="hint">
            {{ size.cols }} × {{ size.rows }} cells. Sizes are in MSX dots, after the pixel scale.
          </p>

          <h3>Transparent colour</h3>
          <div class="row">
            <span
              class="swatch"
              :style="{ background: keyHex ?? 'transparent' }"
              :class="{ none: !keyHex }"
            />
            <span class="hint">{{ keyHex ?? 'Alpha only' }}</span>
            <button
              type="button"
              :class="{ active: picking }"
              :disabled="!raw"
              title="Click a pixel of the sheet's background"
              @click="picking = !picking"
            >
              Pick
            </button>
            <button
              type="button"
              :disabled="keyColor === null"
              @click="keyColor = null"
            >
              None
            </button>
            <label
              class="inline"
              title="How far each channel may be from the colour"
            >
              <span>±</span>
              <input
                v-model.number="tolerance"
                type="number"
                min="0"
                max="64"
                class="narrow"
              >
            </label>
          </div>

          <h3>Destination</h3>
          <div class="grid2">
            <label><span>Import into</span>
              <select v-model="destination">
                <option
                  v-for="d in DESTINATIONS"
                  :key="d.id"
                  :value="d.id"
                >{{ d.label }}</option>
              </select>
            </label>
            <label><span>File</span>
              <select v-model="target">
                <option
                  v-if="destination !== 'map'"
                  value=""
                >New file…</option>
                <option
                  v-for="path in targets"
                  :key="path"
                  :value="path"
                >{{ path.split('/').pop() }}</option>
              </select>
            </label>
            <label v-if="!target"><span>Name</span><input
              v-model="name"
              type="text"
              spellcheck="false"
            ></label>
            <label v-if="!target && destination !== 'sprites'"><span>Mode</span>
              <select v-model="newMode">
                <option
                  v-for="m in TILE_MODES"
                  :key="m"
                  :value="m"
                >{{ MODES[m].label }}</option>
              </select>
            </label>
            <template v-if="!target && destination === 'sprites'">
              <label><span>Sprite mode</span>
                <select v-model.number="spriteMode">
                  <option :value="1">Mode 1 (MSX1)</option>
                  <option :value="2">Mode 2 (MSX2)</option>
                </select>
              </label>
              <label><span>Sprite size</span>
                <select v-model.number="spriteSize">
                  <option :value="16">16×16</option>
                  <option :value="8">8×8</option>
                </select>
              </label>
            </template>
            <label v-if="paletteChoosable"><span>Palette</span>
              <select v-model="paletteChoice">
                <option value="msx1">MSX1 colours</option>
                <option value="optimized">Optimized for the sheet</option>
              </select>
            </label>
            <label><span>Dither</span>
              <select v-model="dither">
                <option value="none">None</option>
                <option value="bayer4">Bayer 4×4</option>
                <option value="floyd">Floyd–Steinberg</option>
              </select>
            </label>
          </div>

          <div class="checks">
            <label
              v-if="destination === 'tiles'"
              class="inline"
            ><input
              v-model="blocks"
              type="checkbox"
            ><span>A block per cell (a stamp on maps)</span></label>
            <label
              v-if="destination === 'tiles' && !target"
              class="inline"
            ><input
              v-model="withMap"
              type="checkbox"
            ><span>And a map laying the cells out as on the sheet</span></label>
            <label
              v-if="animated"
              class="inline"
            ><input
              v-model="onePerRow"
              type="checkbox"
            ><span>{{ destination === 'sprites' ? 'A character per row' : 'A file per row' }}</span></label>
            <label
              v-if="destination === 'sprites' || destination === 'meta'"
              class="inline"
            ><input
              v-model="trim"
              type="checkbox"
            ><span>Trim to the content of all frames</span></label>
            <label class="inline"><input
              v-model="skipEmpty"
              type="checkbox"
            ><span>Skip empty cells</span></label>
            <label
              v-if="destination === 'anim' || destination === 'meta'"
              class="inline"
            ><span>Frames a pose</span><input
              v-model.number="duration"
              type="number"
              min="1"
              max="255"
              class="narrow"
            ></label>
            <label
              v-if="destination === 'sprites'"
              class="inline"
              title="Planes stacked on one sprite at most; colours past it take the nearest kept one"
            ><span>Max planes</span><input
              v-model.number="maxPlanes"
              type="number"
              min="1"
              max="4"
              class="narrow"
            ></label>
          </div>

          <h3>Result</h3>
          <div class="result">
            <canvas
              v-show="animated && shownFrames.length > 1"
              ref="playCanvas"
              class="play"
            />
            <canvas ref="resultCanvas" />
          </div>
          <p
            v-if="convertError"
            class="error"
          >
            {{ convertError }}
          </p>
          <p
            v-else-if="converting"
            class="hint"
          >
            Converting…
          </p>
          <ul
            v-else
            class="summary"
          >
            <li
              v-for="line in summary"
              :key="line"
            >
              {{ line }}
            </li>
          </ul>
        </section>
      </div>

      <footer>
        <span
          v-if="outcome"
          :class="outcome.failed ? 'error' : 'done'"
        >{{ outcome.status }}</span>
        <span
          v-else-if="blocker"
          class="hint"
        >{{ blocker }}</span>
        <button
          type="button"
          class="primary"
          :disabled="!!blocker || busy || converting || !converted"
          @click="doImport"
        >
          Import
        </button>
        <button
          type="button"
          @click="emit('close')"
        >
          Close
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 40;
}

.dialog {
  display: flex;
  flex-direction: column;
  width: min(1180px, 96vw);
  height: min(820px, 94vh);
  padding: 14px 18px 16px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 6px;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

h3 {
  margin: 12px 0 6px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
}

h3:first-child {
  margin-top: 0;
}

.close {
  display: flex;
  color: var(--color-text-muted);
}

.body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 360px;
  gap: 16px;
  min-height: 0;
  flex: 1;
}

.sheet {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.scroller {
  flex: 1;
  min-height: 0;
  overflow: auto;
  margin: 8px 0;
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

.scroller canvas {
  display: block;
  image-rendering: pixelated;
  cursor: pointer;
}

.scroller.picking canvas {
  cursor: crosshair;
}

.empty {
  padding: 24px;
}

.side {
  overflow-y: auto;
  min-height: 0;
  padding-right: 4px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.grid4 {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px 8px;
}

.grid2 {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 10px;
}

label {
  display: block;
  font-size: 12px;
}

label > span:first-child {
  display: block;
  margin-bottom: 3px;
  color: var(--color-text-muted);
}

label.inline {
  display: flex;
  align-items: center;
  gap: 6px;
}

label.inline > span:first-child {
  display: inline;
  margin: 0;
}

label.inline > input[type='checkbox'] + span {
  color: var(--color-text);
}

.checks {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 10px;
}

input[type='text'],
input[type='number'],
select {
  width: 100%;
  padding: 3px 5px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-tab-inactive);
  color: var(--color-text);
  font-size: 12px;
}

input.narrow {
  width: 56px;
}

button {
  padding: 3px 10px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-hover);
  font-size: 12px;
}

button.active {
  border-color: var(--color-accent);
}

button.link {
  padding: 0;
  border: none;
  background: none;
  color: var(--color-accent);
}

button:disabled {
  opacity: 0.5;
  cursor: default;
}

.swatch {
  width: 18px;
  height: 18px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
}

.swatch.none {
  background-image: linear-gradient(135deg, transparent 45%, var(--color-error, #f14c4c) 45%, var(--color-error, #f14c4c) 55%, transparent 55%);
}

.result {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  overflow-x: auto;
}

.result canvas {
  image-rendering: pixelated;
  background-color: var(--color-bg-tab-inactive);
}

.summary {
  margin: 6px 0 0;
  padding-left: 16px;
  font-size: 11px;
  color: var(--color-text-muted);
}

footer {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}

footer > span {
  flex: 1;
  font-size: 12px;
}

footer .primary {
  padding: 5px 16px;
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: #ffffff;
}

.hint {
  font-size: 11px;
  color: var(--color-text-muted);
}

.done {
  color: var(--color-text);
}

.error {
  font-size: 12px;
  color: var(--color-error, #f14c4c);
}
</style>
