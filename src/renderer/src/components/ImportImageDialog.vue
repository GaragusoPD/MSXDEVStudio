<script setup lang="ts">
/**
 * The shared "Import image" dialog (Spec 07 D). Specs 08–10 will mount it from
 * their editors and consume `@imported`; until then the Resources panel opens
 * it standalone and it writes a `.tiles.json` straight into the project.
 */
import { computed, ref, watch } from 'vue'
import { BITMAP_MODES, MODES, TILE_MODES, isTileMode, type ScreenMode } from '../../../shared/msx/modes'
import { countTiles } from '../../../shared/msx/tile-reduce'
import { mapFromLayout, stampFresh } from '../../../shared/msx/map'
import { bankedPackBlocker, MAX_TILES, packChosen, TILE_SIZE, type BankChoice } from '../../../shared/msx/tile'
import { RESOURCE_DIR, defaultExport, serializeResource } from '../../../shared/msx/resource'
import { useImageImport, type CropRect, type ImportResult } from '../composables/useImageImport'
import { useProjectStore } from '../stores/projectStore'
import { useResourcesStore } from '../stores/resourcesStore'
import Icon from './Icon.vue'

/**
 * `lockMode`: the target already has a mode (a map's tileset), so converting for another one could only be refused.
 * `currentPalette`: the target's own GRB333 palette, offered as a palette choice — a picture pasted onto a screen
 * that already has art is converted to the colours that screen already shows. `freeEntries` are the entries of it
 * nothing uses yet: with them, the picture may also take those entries for colours of its own ("share"), which is
 * how several pictures fit on one screen without recolouring each other. `preferCurrent` starts on the target's
 * palette — shared when there is room, as it is otherwise.
 */
const props = withDefaults(
  defineProps<{
    mode?: ScreenMode
    standalone?: boolean
    fitWidth?: number
    fitHeight?: number
    lockMode?: boolean
    currentPalette?: number[] | null
    freeEntries?: number[] | null
    /** What the target's palette is called in the choice: "This screen's palette", "This tileset's palette". */
    currentPaletteLabel?: string
    preferCurrent?: boolean
    /** The label of the button that hands the result over; the target decides what accepting it does. */
    useLabel?: string
    /**
     * Whether to offer SCREEN 2/4's bank choice, and what has to fit it: `picture` — the picture itself is
     * split into the three banks (a tileset import), `screen` — the screen it lands on is (a map import).
     * Null hides it. The standalone import is always `picture`.
     */
    banking?: 'picture' | 'screen' | null
    /**
     * How many distinct tiles the target can take from this picture: 256 for a
     * new or replaced set (the default), what is left in a tileset for a merge
     * or a map. `budgetLabel` says which, after the number ("free in this
     * tileset"). With `budgetBlocks` the hand-over is refused until the picture
     * fits — crop it or reduce it here first; without, it is only a warning
     * (a map import reuses tiles the tileset already has, so it may need fewer).
     */
    tileBudget?: number | null
    budgetLabel?: string
    budgetBlocks?: boolean
    /** False when the target stores every cell as a tile of its own (the tile editor's Dedup off): then cells, not different tiles, are what counts. */
    dedup?: boolean
    /** Show the tile count with no limit: a target that checks its own budget per bank (a map on a banked tileset). */
    countOnly?: boolean
  }>(),
  {
    mode: 'sc2',
    standalone: true,
    lockMode: false,
    currentPalette: null,
    freeEntries: null,
    currentPaletteLabel: "This screen's palette",
    preferCurrent: false,
    useLabel: 'Use this image',
    banking: null,
    tileBudget: null,
    budgetLabel: 'tiles a pattern set holds',
    budgetBlocks: true,
    dedup: true,
    countOnly: false
  }
)
/** `file`/`mode` are extra (Spec 10): the picked file itself, for a target that wants to keep the
 *  original's bytes, and which mode the dialog actually converted to, since the dropdown lets the
 *  user change it away from the `mode` prop. Existing single-arg `@imported` handlers (Specs
 *  08/09) keep working — the params are simply ignored. */
const emit = defineEmits<{ close: []; imported: [result: ImportResult, file: File | null, mode: ScreenMode, banks: BankChoice] }>()

const projectStore = useProjectStore()
const resourcesStore = useResourcesStore()
const importer = useImageImport({
  mode: props.mode,
  fitWidth: props.fitWidth,
  fitHeight: props.fitHeight,
  ...(props.preferCurrent && props.currentPalette ? { palette: props.currentPalette, freeEntries: props.freeEntries ?? [] } : {})
})
const beforeCanvas = ref<HTMLCanvasElement | null>(null)
const afterCanvas = ref<HTMLCanvasElement | null>(null)
const targetName = ref('imported')
const saving = ref(false)
const saved = ref<string | null>(null)
const pickedFile = ref<File | null>(null)

const MODE_IDS = [...TILE_MODES, ...BITMAP_MODES] as ScreenMode[]
const banks = ref<BankChoice>('auto')
/** SCREEN 2/4 only: the other modes have one pattern table. */
const bankable = computed(() => (props.standalone || props.banking !== null) && (importer.options.mode === 'sc2' || importer.options.mode === 'sc4'))
/** Why the picture cannot be banked, said before the user presses anything — a map import's screen is checked on drop. */
const bankHint = computed(() => {
  const result = importer.result.value
  if (!bankable.value || banks.value !== 'banked' || !result || (!props.standalone && props.banking !== 'picture')) return null
  return bankedPackBlocker(importer.options.mode as 'sc2' | 'sc4', result.height)
})
const info = computed(() => MODES[importer.options.mode])
/** Only MSX2 bitmap modes have a programmable palette to choose. */
const paletteChoosable = computed(() => info.value.palette === 'grb333')

/**
 * The select's view of `options.palette`: a locked array is only ever the
 * target's own palette — `share` when it may also refill the free entries,
 * `current` when it is kept whole.
 */
const paletteChoice = computed({
  get: (): string =>
    Array.isArray(importer.options.palette) ? (importer.options.freeEntries?.length ? 'share' : 'current') : importer.options.palette,
  set: (value: string) => {
    const locked = (value === 'share' || value === 'current') && props.currentPalette
    importer.options.freeEntries = value === 'share' && props.freeEntries ? [...props.freeEntries] : []
    importer.options.palette = locked ? [...props.currentPalette!] : (value as 'msx1' | 'optimized')
  }
})

function paint(canvas: HTMLCanvasElement | null, image: ImageData | null): void {
  if (!canvas || !image) return
  canvas.width = image.width
  canvas.height = image.height
  canvas.getContext('2d')?.putImageData(image, 0, 0)
}

watch(importer.source, (image) => paint(beforeCanvas.value, image), { flush: 'post' })
watch(
  importer.result,
  (result) => paint(afterCanvas.value, result ? importer.toImageData(result) : null),
  { flush: 'post' }
)

// ── tiles: how many the picture needs, against what the target can take ──

const tileMode = computed(() => isTileMode(importer.options.mode))
const budget = computed(() => props.tileBudget ?? MAX_TILES)
/** What the conversion needs, before any reduction. */
const needed = computed(() => {
  const conversion = importer.converted.value
  return tileMode.value && conversion ? countTiles(conversion.indices, conversion.width, conversion.height) : null
})
/** What is handed over: after "Reduce to fit", when it is on. */
const handed = computed(() => {
  const conversion = importer.result.value
  return tileMode.value && conversion ? countTiles(conversion.indices, conversion.width, conversion.height) : null
})
/** Tiles one set needs: different tiles, or every cell when the target does not dedup. */
const setTiles = (count: { distinct: number; cells: number }): number => (props.dedup ? count.distinct : count.cells)
/**
 * Banked, each screen third has its own 256 tiles. The same rule `packChosen`
 * packs by: Banked always, Auto only when one set of 256 cannot hold the
 * picture and it can be banked — not when it merely exceeds this target's own
 * budget, which banking would not help.
 */
const banksPicture = computed(() => {
  const conversion = importer.converted.value
  if (!bankable.value || !conversion || !needed.value || !(props.standalone || props.banking === 'picture')) return false
  if (banks.value === 'banked') return true
  return banks.value === 'auto' && setTiles(needed.value) > MAX_TILES && bankedPackBlocker(importer.options.mode as 'sc2' | 'sc4', conversion.height) === null
})
const need = computed(() => {
  const count = handed.value
  if (!count || props.countOnly) return null
  // A banked pack always dedups within each third.
  return banksPicture.value
    ? { tiles: Math.max(0, ...count.bands), limit: MAX_TILES, label: 'tiles a screen third holds' }
    : { tiles: setTiles(count), limit: budget.value, label: props.budgetLabel }
})
const over = computed(() => (need.value ? Math.max(0, need.value.tiles - need.value.limit) : 0))
/** Over the limit and refused, rather than imported and cut off or refused later. */
const blocked = computed(() => props.budgetBlocks && over.value > 0)

const reduce = ref(false)
watch(
  [reduce, budget, banksPicture],
  () => {
    // Per third, a screen-wide band never has more cells than its bank has tiles.
    importer.reduceTo.value = reduce.value && !banksPicture.value ? budget.value : null
  },
  { immediate: true }
)

// ── crop: the part of the picture to convert ──

const stage = ref<HTMLElement | null>(null)
/** The rectangle shown, in source pixels: live while dragging, then committed to the importer. */
const crop = ref<CropRect | null>(null)
watch(
  () => importer.options.crop,
  (committed) => (crop.value = committed ? { ...committed } : null)
)
type Grip = 'move' | 'new' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
const GRIPS: Grip[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
let drag: { grip: Grip; from: { x: number; y: number }; start: CropRect } | null = null

/** Crops snap to the 8-dot tile grid, so the part you pick is whole tiles. */
const SNAP = 8
const snap = (value: number): number => Math.round(value / SNAP) * SNAP

function sourcePoint(event: PointerEvent): { x: number; y: number } | null {
  const image = importer.source.value
  const element = stage.value
  if (!image || !element) return null
  const rect = element.getBoundingClientRect()
  return {
    x: Math.max(0, Math.min(image.width, ((event.clientX - rect.left) / rect.width) * image.width)),
    y: Math.max(0, Math.min(image.height, ((event.clientY - rect.top) / rect.height) * image.height))
  }
}

function startCrop(event: PointerEvent, grip: Grip): void {
  const image = importer.source.value
  const point = sourcePoint(event)
  if (!image || !point || event.button !== 0) return
  event.preventDefault()
  event.stopPropagation()
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  const start = grip === 'new' ? { x: snap(point.x), y: snap(point.y), width: 0, height: 0 } : (crop.value ?? { x: 0, y: 0, width: image.width, height: image.height })
  drag = { grip: grip === 'new' ? 'se' : grip, from: point, start }
  crop.value = { ...start }
}

function moveCrop(event: PointerEvent): void {
  const image = importer.source.value
  const point = sourcePoint(event)
  if (!drag || !image || !point) return
  const { grip, from, start } = drag
  const dx = point.x - from.x
  const dy = point.y - from.y
  if (grip === 'move') {
    const x = Math.max(0, Math.min(image.width - start.width, snap(start.x + dx)))
    const y = Math.max(0, Math.min(image.height - start.height, snap(start.y + dy)))
    crop.value = { ...start, x, y }
    return
  }
  let left = start.x
  let top = start.y
  let right = start.x + start.width
  let bottom = start.y + start.height
  if (grip.includes('w')) left = Math.min(right - SNAP, snap(start.x + dx))
  if (grip.includes('e')) right = Math.max(left + SNAP, snap(start.x + start.width + dx))
  if (grip.includes('n')) top = Math.min(bottom - SNAP, snap(start.y + dy))
  if (grip.includes('s')) bottom = Math.max(top + SNAP, snap(start.y + start.height + dy))
  left = Math.max(0, left)
  top = Math.max(0, top)
  right = Math.min(image.width, right)
  bottom = Math.min(image.height, bottom)
  crop.value = { x: left, y: top, width: right - left, height: bottom - top }
}

function endCrop(): void {
  const image = importer.source.value
  if (!drag || !image) return
  drag = null
  const picked = crop.value
  const whole = !picked || picked.width < SNAP || picked.height < SNAP || (picked.x === 0 && picked.y === 0 && picked.width === image.width && picked.height === image.height)
  importer.options.crop = whole ? null : { ...picked }
  if (whole) crop.value = null
}

function clearCrop(): void {
  importer.options.crop = null
  crop.value = null
}

/** The crop rectangle as CSS over the "Original" canvas, which is drawn at the source's own size, scaled. */
const cropStyle = computed(() => {
  const image = importer.source.value
  const picked = crop.value
  if (!image || !picked) return null
  return {
    left: `${(picked.x / image.width) * 100}%`,
    top: `${(picked.y / image.height) * 100}%`,
    width: `${(picked.width / image.width) * 100}%`,
    height: `${(picked.height / image.height) * 100}%`
  }
})

function onPick(event: Event): void {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (file) {
    pickedFile.value = file
    void importer.loadFile(file)
  }
}

/** Standalone mode: turn the conversion into a real `.tiles.json` in the project. */
async function saveTileset(): Promise<void> {
  const result = importer.result.value
  if (!result || !isTileMode(importer.options.mode)) return
  saving.value = true
  try {
    const stem = targetName.value.replace(/[^A-Za-z0-9_-]/g, '') || 'imported'
    // Into `res/`, where every other resource lives and where the exporter and
    // the Resources panel look. Writing these to the project root left them
    // invisible to the panel and gave the map a `tileset` field naming a path
    // no other resource uses.
    const path = `${RESOURCE_DIR}/${stem}.tiles.json`
    const mapPath = `${RESOURCE_DIR}/${stem}.map.json`
    // `targetName` is free text, so nothing stops it from naming a resource
    // that already exists. Unlike the tile editor's own import — where the
    // map write is an implicit side effect of editing an already-open file —
    // this is an explicit "save as" the user just typed a name and pressed a
    // button for, and the normal way to iterate on a conversion is exactly
    // "import, look at it, adjust an option, import again under the same
    // name." Refusing that would block the ordinary workflow, so this asks
    // instead of silently refusing or silently overwriting.
    const [tilesetExists, mapExists] = await Promise.all([
      window.api.invoke('fs:stat', { path }),
      window.api.invoke('fs:stat', { path: mapPath })
    ])
    if (tilesetExists || mapExists) {
      const collisions = [tilesetExists ? path : null, mapExists ? mapPath : null].filter(Boolean) as string[]
      const verb = collisions.length > 1 ? 'exist' : 'exists'
      const blocking = collisions.join(' and ')
      if (!window.confirm(`${blocking} already ${verb}. Overwrite?`)) {
        saved.value = `Not saved — ${blocking} already ${verb}.`
        return
      }
    }

    // SCREEN 2/4 has three pattern banks of 256 tiles, not one — a full
    // 256×192 screen can use up to 768 distinct tiles across them. A shorter
    // picture banks by the same thirds, its map padded to 24 rows; sc1 has
    // one pattern table and always goes down `packTiles`'s single-bank path.
    const packed = packChosen(result.indices, result.width, result.height, importer.options.mode, bankable.value ? banks.value : 'repeat', { dedup: true })
    if (typeof packed === 'string') {
      saved.value = `Not saved — ${packed}`
      return
    }
    const useBanks = packed.banked
    const { doc, layout, lossyTiles } = packed
    const unplaced = packed.banked ? packed.unplaced : []
    doc.export = defaultExport(path)
    // `fs:write` doesn't create parent folders, and a project whose res/ was
    // never made (or was deleted) hasn't got one. mkdir is idempotent.
    await window.api.invoke('fs:create', { path: RESOURCE_DIR, kind: 'directory' })
    await window.api.invoke('fs:write', { path, content: serializeResource({ kind: 'tiles', doc }) })

    // The tiles alone cannot rebuild the picture. `layout` is the arrangement
    // the conversion already worked out, and without this it was discarded.
    const cols = Math.floor(result.width / TILE_SIZE)
    // Banked pads a shorter picture to the 24 rows a banked map must have.
    const rows = packed.banked ? layout.length / cols : Math.floor(result.height / TILE_SIZE)
    const map = mapFromLayout(path, layout, cols, rows)
    map.export = defaultExport(mapPath)
    await window.api.invoke('fs:write', { path: mapPath, content: serializeResource({ kind: 'map', doc: stampFresh(map) }) })

    if (useBanks) {
      // Per bank, not one combined count: the budget is per bank, so "bank 1
      // is full" is the honest message, not a single number that hides which
      // third overflowed.
      const bankReport = unplaced
        .map((count, bank) => (count > 0 ? `bank ${bank}: ${count} cells unplaced (that third's ${MAX_TILES} tiles are full)` : null))
        .filter((line): line is string => line !== null)
        .join('; ')
      const bankCounts = doc.bankTiles.map((bank) => bank.length).join('/')
      saved.value =
        `${path} — banks ${bankCounts} tiles${lossyTiles.length ? `, ${lossyTiles.length} lossy` : ''}; ` +
        `${mapPath} — ${cols}×${rows}` +
        (bankReport ? `; ${bankReport}` : '')
    } else {
      const short = cols * rows - layout.length
      saved.value =
        `${path} — ${doc.count} tiles${lossyTiles.length ? `, ${lossyTiles.length} lossy` : ''}; ` +
        `${mapPath} — ${cols}×${rows}` +
        (short > 0 ? `, ${short} cells unplaced (the bank filled at 256 tiles)` : '')
    }
    await resourcesStore.refresh()
  } catch (error) {
    saved.value = `Failed: ${String(error)}`
  } finally {
    saving.value = false
  }
}

function use(): void {
  if (importer.result.value) emit('imported', importer.result.value, pickedFile.value, importer.options.mode, bankable.value ? banks.value : 'repeat')
  emit('close')
}
</script>

<template>
  <div
    class="backdrop"
    @click.self="emit('close')"
  >
    <div class="dialog">
      <header>
        <h2>Import image</h2>
        <button
          type="button"
          class="close"
          title="Close"
          @click="emit('close')"
        >
          <Icon name="close" />
        </button>
      </header>

      <div class="controls">
        <label>
          <span>Image</span>
          <input
            type="file"
            accept="image/*"
            @change="onPick"
          >
        </label>
        <label>
          <span>Target mode</span>
          <select
            v-model="importer.options.mode"
            :disabled="lockMode"
          >
            <option
              v-for="id in MODE_IDS"
              :key="id"
              :value="id"
            >{{ MODES[id].label }}</option>
          </select>
        </label>
        <label>
          <span>Palette</span>
          <select
            v-model="paletteChoice"
            :disabled="!paletteChoosable"
          >
            <option
              v-if="currentPalette && freeEntries?.length"
              value="share"
            >{{ currentPaletteLabel }} + {{ freeEntries.length }} unused for this picture</option>
            <option
              v-if="currentPalette"
              value="current"
            >{{ currentPaletteLabel }} only</option>
            <option value="optimized">Optimized (median cut → 512 colors)</option>
            <option value="msx1">Fixed MSX1 palette</option>
          </select>
        </label>
        <label
          v-if="bankable"
          title="SCREEN 2/4 has three pattern tables, one per third of the screen"
        >
          <span>Banks</span>
          <select v-model="banks">
            <option value="auto">Auto — banked only if it needs more than {{ MAX_TILES }} tiles</option>
            <option value="repeat">Repeat — one set of {{ MAX_TILES }} in all three thirds</option>
            <option value="banked">Banked — a set per third, up to {{ 3 * MAX_TILES }} tiles</option>
          </select>
        </label>
        <label>
          <span>Dither</span>
          <select v-model="importer.options.dither">
            <option value="none">None</option>
            <option value="bayer4">Bayer 4×4</option>
            <option value="floyd">Floyd–Steinberg</option>
          </select>
        </label>
      </div>

      <p
        v-if="bankHint"
        class="error"
      >
        {{ bankHint }}
      </p>
      <p
        v-if="!paletteChoosable && importer.source.value"
        class="hint"
      >
        {{ info.label }} has a fixed hardware palette — the palette choice is ignored.
      </p>

      <div class="previews">
        <figure>
          <figcaption>
            Original
            <template v-if="importer.source.value">
              — {{ crop ? `${crop.width} × ${crop.height} of ${importer.source.value.width} × ${importer.source.value.height}` : 'drag on it to pick a part' }}
              <button
                v-if="crop"
                type="button"
                class="link"
                title="Convert the whole image again"
                @click="clearCrop"
              >
                Whole image
              </button>
            </template>
          </figcaption>
          <div
            ref="stage"
            class="crop-stage"
            :class="{ active: !!importer.source.value }"
            @pointerdown="startCrop($event, 'new')"
            @pointermove="moveCrop"
            @pointerup="endCrop"
            @pointercancel="endCrop"
          >
            <canvas ref="beforeCanvas" />
            <!-- The shade outside the box, clipped to the picture: the box itself is not, so its grips can sit on the edge. -->
            <div
              v-if="cropStyle"
              class="crop-clip"
            >
              <div
                class="crop-shade"
                :style="cropStyle"
              />
            </div>
            <div
              v-if="cropStyle"
              class="crop-box"
              :style="cropStyle"
              title="Drag to move; drag a handle to resize. Snaps to the 8-dot tile grid."
              @pointerdown="startCrop($event, 'move')"
            >
              <span
                v-for="grip in GRIPS"
                :key="grip"
                class="grip"
                :class="grip"
                @pointerdown="startCrop($event, grip)"
              />
            </div>
          </div>
        </figure>
        <figure>
          <figcaption>{{ info.label }}</figcaption>
          <canvas ref="afterCanvas" />
        </figure>
      </div>

      <p
        v-if="importer.error.value"
        class="error"
      >
        {{ importer.error.value }}
      </p>
      <p
        v-else-if="importer.busy.value"
        class="hint"
      >
        Converting…
      </p>
      <table
        v-else-if="importer.result.value"
        class="report"
      >
        <tbody>
          <tr>
            <th>Size</th>
            <td>{{ importer.result.value.width }} × {{ importer.result.value.height }}</td>
          </tr>
          <tr>
            <th>Colors used</th>
            <td>{{ importer.result.value.report.colorsUsed }} of {{ info.colors }}</td>
          </tr>
          <tr>
            <th>Source colors merged</th>
            <td>{{ importer.result.value.report.colorsMerged }}</td>
          </tr>
          <tr v-if="info.colorModel === 'row2' || info.colorModel === 'group2'">
            <th>Rows constrained</th>
            <td>
              {{ importer.result.value.report.rowsAltered }}
              ({{ importer.result.value.report.pixelsChanged }} pixels moved)
            </td>
          </tr>
          <tr v-if="needed">
            <th>Tiles</th>
            <td>
              {{ needed.distinct }} different, in {{ needed.cells }} cells
              <template v-if="needed.bands.length > 1 && bankable">
                · per screen third {{ needed.bands.join(' / ') }}
              </template>
            </td>
          </tr>
          <tr v-if="handed && importer.merged.value">
            <th>Reduced to</th>
            <td>{{ handed.distinct }} — {{ importer.merged.value }} merged into the tile they look most like</td>
          </tr>
        </tbody>
      </table>

      <template v-if="need && (over > 0 || reduce)">
        <p
          v-if="over > 0"
          :class="blocked ? 'error' : 'warning'"
        >
          {{ need.tiles }} tiles: {{ over }} more than the {{ need.limit }} {{ need.label }}.
          Pick the part you need on the original, or reduce the tiles.
          {{ blocked ? 'Nothing is imported until it fits.' : 'Tiles the tileset already has are reused, so it may still fit.' }}
        </p>
        <p
          v-if="!dedup && !banksPicture"
          class="hint"
        >
          Dedup is off, so every cell is a tile of its own: tick it to share the repeated ones.
        </p>
        <label
          v-if="!banksPicture && dedup"
          class="inline reduce"
          title="Merges the tiles that look most alike, the rarest first, until the picture needs no more than the limit. Whole tiles are swapped; nothing is blended."
        >
          <input
            v-model="reduce"
            type="checkbox"
          >
          <span>Reduce to fit — {{ budget }} tiles, merging the most alike</span>
        </label>
      </template>

      <footer>
        <template v-if="standalone">
          <label class="inline">
            <span>Save as</span>
            <input
              v-model="targetName"
              type="text"
              spellcheck="false"
            >
            <span class="suffix">.tiles.json</span>
          </label>
          <span
            v-if="saved"
            class="saved"
          >{{ saved }}</span>
          <button
            type="button"
            class="primary"
            :disabled="!importer.result.value || saving || !isTileMode(importer.options.mode) || !projectStore.open || !!bankHint || blocked"
            @click="saveTileset"
          >
            Create tileset
          </button>
        </template>
        <button
          v-else
          type="button"
          class="primary"
          :disabled="!importer.result.value || !!bankHint || blocked"
          @click="use"
        >
          {{ useLabel }}
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
  width: min(760px, 92vw);
  max-height: 90vh;
  overflow-y: auto;
  padding: 16px 20px 20px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 6px;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.close {
  /* Icon-only: the icon carries its own size, so the button just has to stop
     baseline-aligning it against the header's <h2>. */
  display: flex;
  color: var(--color-text-muted);
}

.controls {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 16px;
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

input[type='text'],
select {
  width: 100%;
  padding: 4px 6px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-tab-inactive);
  color: var(--color-text);
  font-size: 12px;
}

label.inline input[type='text'] {
  width: 140px;
}

.previews {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin: 14px 0;
}

figure {
  margin: 0;
  min-width: 0;
}

figcaption {
  margin-bottom: 4px;
  font-size: 11px;
  color: var(--color-text-muted);
}

canvas {
  width: 100%;
  height: auto;
  /* MSX art is chunky on purpose — never smooth it. */
  image-rendering: pixelated;
  border: 1px solid var(--color-border);
  /* Checkerboard so transparent (index 0) pixels read as transparent. */
  background-color: var(--color-bg-tab-inactive);
  background-image:
    linear-gradient(45deg, rgba(128, 128, 128, 0.25) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(128, 128, 128, 0.25) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(128, 128, 128, 0.25) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(128, 128, 128, 0.25) 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
}

.report {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.report th {
  text-align: left;
  font-weight: normal;
  color: var(--color-text-muted);
  padding: 2px 12px 2px 0;
  white-space: nowrap;
}

footer {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
  flex-wrap: wrap;
}

footer button {
  padding: 5px 14px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-bg-hover);
  font-size: 12px;
}

footer .primary {
  margin-left: auto;
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: #ffffff;
}

footer .primary:disabled {
  opacity: 0.5;
  cursor: default;
}

.suffix,
.saved,
.hint {
  font-size: 11px;
  color: var(--color-text-muted);
}

.error {
  font-size: 12px;
  color: var(--color-error, #f14c4c);
}

.warning {
  font-size: 12px;
  color: var(--color-warning, #cca700);
}

.reduce {
  margin-top: 4px;
}

.link {
  padding: 0 4px;
  color: var(--color-accent);
  font-size: 11px;
  text-decoration: underline;
}

.crop-stage {
  position: relative;
  /* The canvas below sets the size; the box is in percent of it. */
  line-height: 0;
  touch-action: none;
}

.crop-stage.active {
  cursor: crosshair;
}

.crop-clip {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}

.crop-shade {
  position: absolute;
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.45);
}

.crop-box {
  position: absolute;
  box-sizing: border-box;
  border: 1px dashed #ffffff;
  outline: 1px dashed #000000;
  cursor: move;
}

.grip {
  position: absolute;
  width: 9px;
  height: 9px;
  margin: -5px 0 0 -5px;
  background: #ffffff;
  border: 1px solid #000000;
}

.grip.nw { left: 0; top: 0; cursor: nwse-resize; }
.grip.n { left: 50%; top: 0; cursor: ns-resize; }
.grip.ne { left: 100%; top: 0; cursor: nesw-resize; }
.grip.e { left: 100%; top: 50%; cursor: ew-resize; }
.grip.se { left: 100%; top: 100%; cursor: nwse-resize; }
.grip.s { left: 50%; top: 100%; cursor: ns-resize; }
.grip.sw { left: 0; top: 100%; cursor: nesw-resize; }
.grip.w { left: 0; top: 50%; cursor: ew-resize; }
</style>
