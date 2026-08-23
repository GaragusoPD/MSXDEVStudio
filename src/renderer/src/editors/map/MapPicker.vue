<script setup lang="ts">
/**
 * Spec 10 A's left pane: the referenced tileset rendered with its real
 * palette. Click picks a single-tile stamp; shift+click (or drag) picks a
 * rectangular multi-tile stamp — same marquee gesture `TileGrid.vue` uses for
 * its own selection, built into a `Stamp` via `stampFromMarquee`.
 *
 * A bitmap map's atlas arrives here as the same `Sheet` a tileset does, so
 * nothing below knows which kind it is picking from.
 */
import { computed, onBeforeUnmount, ref, watch, watchEffect } from 'vue'
import { singleStamp, stampFromMarquee } from '../../../../shared/map-editor'
import { fitColumns } from '../../../../shared/tile-editor'
import { tilesetBlocks, pickBlock, pickTile, sheet, type MapSession } from './session'

const props = defineProps<{ session: MapSession }>()

const canvas = ref<HTMLCanvasElement | null>(null)
const scroller = ref<HTMLElement | null>(null)
const hover = ref<number | null>(null)
let dragAnchor: number | null = null

/**
 * The tileset's named blocks — a stamp bigger than one tile, picked the same
 * way. Either kind of tileset carries them; only a screen read as a grid has
 * none, because its cells are anonymous.
 */
const blocks = computed(() => tilesetBlocks(props.session))
/**
 * Whether the tileset can carry blocks at all. Both tileset kinds can; a screen
 * read as a grid cannot, because its cells are anonymous rectangles with
 * nothing to name.
 */
const hasTileset = computed(() => Boolean(props.session.tileset ?? props.session.bitmapTileset))

const cells = computed(() => sheet(props.session))
const cell = computed(() => props.session.pickerZoom)
const count = computed(() => cells.value?.count ?? 0)

/** Same as `TileGrid.vue`: the sheet wraps into the pane instead of scrolling off the side of it. */
const paneWidth = ref(0)
const COLUMNS = computed(() => fitColumns(paneWidth.value, cell.value, count.value))
const rows = computed(() => Math.max(1, Math.ceil(count.value / COLUMNS.value)))

// The scroller only exists once a tileset has loaded, so this follows the ref
// rather than grabbing it on mount.
const observer = new ResizeObserver(([entry]) => {
  paneWidth.value = entry.contentRect.width
})
watch(
  scroller,
  (element) => {
    observer.disconnect()
    if (element) observer.observe(element)
  },
  { flush: 'post' }
)
onBeforeUnmount(() => observer.disconnect())

const hex = (index: number): string => `0x${index.toString(16).toUpperCase().padStart(2, '0')}`

function indexAt(event: PointerEvent): number | null {
  const rect = (event.currentTarget as HTMLCanvasElement).getBoundingClientRect()
  const x = Math.floor((event.clientX - rect.left) / cell.value)
  const y = Math.floor((event.clientY - rect.top) / cell.value)
  if (x < 0 || x >= COLUMNS.value || y < 0) return null
  const index = y * COLUMNS.value + x
  return index < count.value ? index : null
}

function pick(anchor: number, focus: number): void {
  if (anchor === focus) {
    pickTile(props.session, focus, [focus], singleStamp(focus))
    return
  }
  const stamp = stampFromMarquee(anchor, focus, COLUMNS.value, count.value)
  const indices: number[] = []
  for (let y = 0; y < stamp.height; y++) {
    for (let x = 0; x < stamp.width; x++) indices.push(stamp.tiles[y * stamp.width + x])
  }
  pickTile(props.session, focus, indices, stamp)
}

function onDown(event: PointerEvent): void {
  const index = indexAt(event)
  if (index === null) return
  ;(event.currentTarget as HTMLCanvasElement).setPointerCapture(event.pointerId)
  dragAnchor = event.shiftKey ? props.session.pickerActive : index
  pick(dragAnchor, index)
}

function onMove(event: PointerEvent): void {
  hover.value = indexAt(event)
  if (dragAnchor === null || hover.value === null) return
  pick(dragAnchor, hover.value)
}

function onUp(): void {
  dragAnchor = null
}

watchEffect(() => {
  const element = canvas.value
  const source = cells.value
  if (!element || !source) return
  const size = cell.value
  element.width = COLUMNS.value * size
  element.height = rows.value * size
  const context = element.getContext('2d')
  if (!context) return
  context.clearRect(0, 0, element.width, element.height)
  context.imageSmoothingEnabled = false

  // The pane's column count is measured, not the sheet's own, so each cell is
  // placed rather than the sheet blitted in rows — the two grids differ.
  for (let index = 0; index < source.count; index++) {
    context.drawImage(
      source.canvas,
      (index % source.cols) * source.cellW,
      Math.floor(index / source.cols) * source.cellH,
      source.cellW,
      source.cellH,
      (index % COLUMNS.value) * size,
      Math.floor(index / COLUMNS.value) * size,
      size,
      size
    )
  }

  context.lineWidth = 2
  for (const index of props.session.pickerSelection) {
    context.strokeStyle = index === props.session.pickerActive ? '#ffffff' : 'rgba(255, 255, 255, 0.45)'
    context.strokeRect((index % COLUMNS.value) * size + 1, Math.floor(index / COLUMNS.value) * size + 1, size - 2, size - 2)
  }
})
</script>

<template>
  <div class="picker-pane">
    <header>
      <span class="title">Tileset</span>
      <span class="readout">{{ hover ?? session.pickerActive }} · {{ hex(hover ?? session.pickerActive) }}</span>
    </header>
    <p
      v-if="!cells"
      class="hint"
    >
      {{ session.tilesetError ?? 'No tileset.' }}
    </p>
    <div
      v-else
      ref="scroller"
      class="scroller"
    >
      <canvas
        ref="canvas"
        class="sheet"
        @pointerdown="onDown"
        @pointermove="onMove"
        @pointerup="onUp"
        @pointercancel="onUp"
        @pointerleave="hover = null"
      />
    </div>
    <p class="hint">
      Click to pick a tile · shift+click (or drag) for a multi-cell stamp.
    </p>

    <section
      v-if="hasTileset"
      class="blocks"
    >
      <h3>Blocks</h3>
      <p
        v-if="!blocks.length"
        class="hint"
      >
        A design bigger than one tile — a door, a tree — drawn on one canvas in
        the tileset's own editor. Name one there and it becomes a stamp here.
      </p>
      <div
        v-else
        class="block-list"
      >
        <button
          v-for="(block, index) in blocks"
          :key="index"
          type="button"
          class="block-row"
          :class="{ active: session.brushBlock === index }"
          :title="`Stamp ${block.name} (${block.width}×${block.height} tiles)`"
          @click="pickBlock(session, index)"
        >
          <span class="name">{{ block.name }}</span>
          <span class="dims">{{ block.width }}×{{ block.height }}</span>
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
/*
 * Width and the right-hand edge belong to the rail in `MapEditorTab`, which
 * stacks this over the meta-tile picker: two panes each declaring their own
 * width made the rail as wide as the widest and drew a border down its middle.
 */
.picker-pane {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  width: 100%;
}

header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--color-border);
  font-size: 11px;
}

.title {
  color: var(--color-text-muted);
}

.readout {
  margin-left: auto;
  font-family: var(--font-mono);
  color: var(--color-text-muted);
}

.scroller {
  flex: 1;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  /* Reserved so the scrollbar appearing can't narrow the box the columns were measured from. */
  scrollbar-gutter: stable;
  padding: 8px;
}

.sheet {
  display: block;
  image-rendering: pixelated;
  touch-action: none;
  background-color: var(--color-bg-tab-inactive);
  background-image:
    linear-gradient(45deg, rgba(128, 128, 128, 0.25) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(128, 128, 128, 0.25) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(128, 128, 128, 0.25) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(128, 128, 128, 0.25) 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
}

.hint {
  margin: 0;
  padding: 6px 8px;
  border-top: 1px solid var(--color-border);
  font-size: 10px;
  color: var(--color-text-muted);
}

/* Below the tiles: same pane, because a block is picked exactly like a tile is. */
.blocks {
  flex: none;
  max-height: 30%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-top: 1px solid var(--color-border);
  padding: 6px 8px;
}

.blocks h3 {
  margin: 0 0 4px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
}

.blocks .hint {
  padding: 0;
  border-top: none;
}

.block-list {
  overflow-y: auto;
  min-height: 0;
}

.block-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  margin-bottom: 3px;
  padding: 3px 6px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-tab-inactive);
  color: var(--color-text);
  font-size: 11px;
  text-align: left;
}

.block-row:hover {
  background: var(--color-bg-hover);
}

.block-row.active {
  border-color: var(--color-accent);
  background: var(--color-bg-active-item);
}

.block-row .name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.block-row .dims {
  color: var(--color-text-muted);
  font-family: var(--font-mono);
}
</style>
