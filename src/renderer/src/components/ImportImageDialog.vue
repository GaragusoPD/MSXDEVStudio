<script setup lang="ts">
/**
 * The shared "Import image" dialog (Spec 07 D). Specs 08–10 will mount it from
 * their editors and consume `@imported`; until then the Resources panel opens
 * it standalone and it writes a `.tiles.json` straight into the project.
 */
import { computed, ref, watch } from 'vue'
import { BITMAP_MODES, MODES, TILE_MODES, isTileMode, type ScreenMode } from '../../../shared/msx/modes'
import { mapFromLayout } from '../../../shared/msx/map'
import { packTiles, TILE_SIZE } from '../../../shared/msx/tile'
import { defaultExport, serializeResource } from '../../../shared/msx/resource'
import { useImageImport, type ImportResult } from '../composables/useImageImport'
import { useProjectStore } from '../stores/projectStore'
import { useResourcesStore } from '../stores/resourcesStore'
import Icon from './Icon.vue'

const props = withDefaults(defineProps<{ mode?: ScreenMode; standalone?: boolean; fitWidth?: number; fitHeight?: number }>(), {
  mode: 'sc2',
  standalone: true
})
/** `file`/`mode` are extra (Spec 10): the screen editor needs the picked file's own bytes (to
 *  copy into the project as `source`) and which mode the dialog actually converted to, since
 *  the dropdown lets the user change it away from the `mode` prop. Existing single-arg
 *  `@imported` handlers (Specs 08/09) keep working — the params are simply ignored. */
const emit = defineEmits<{ close: []; imported: [result: ImportResult, file: File | null, mode: ScreenMode] }>()

const projectStore = useProjectStore()
const resourcesStore = useResourcesStore()
const importer = useImageImport({ mode: props.mode, fitWidth: props.fitWidth, fitHeight: props.fitHeight })
const beforeCanvas = ref<HTMLCanvasElement | null>(null)
const afterCanvas = ref<HTMLCanvasElement | null>(null)
const targetName = ref('imported')
const saving = ref(false)
const saved = ref<string | null>(null)
const pickedFile = ref<File | null>(null)

const MODE_IDS = [...TILE_MODES, ...BITMAP_MODES] as ScreenMode[]
const info = computed(() => MODES[importer.options.mode])
/** Only MSX2 bitmap modes have a programmable palette to choose. */
const paletteChoosable = computed(() => info.value.palette === 'grb333')

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
    const path = `${stem}.tiles.json`
    const mapPath = `${stem}.map.json`
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

    const { doc, layout, lossyTiles } = packTiles(
      result.indices,
      result.width,
      result.height,
      importer.options.mode,
      { dedup: true }
    )
    doc.export = defaultExport(path)
    await window.api.invoke('fs:write', { path, content: serializeResource({ kind: 'tiles', doc }) })

    // The tiles alone cannot rebuild the picture. `layout` is the arrangement
    // the conversion already worked out, and without this it was discarded.
    const cols = Math.floor(result.width / TILE_SIZE)
    const rows = Math.floor(result.height / TILE_SIZE)
    const map = mapFromLayout(path, layout, cols, rows)
    map.export = defaultExport(mapPath)
    await window.api.invoke('fs:write', { path: mapPath, content: serializeResource({ kind: 'map', doc: map }) })

    const short = cols * rows - layout.length
    saved.value =
      `${path} — ${doc.count} tiles${lossyTiles.length ? `, ${lossyTiles.length} lossy` : ''}; ` +
      `${mapPath} — ${cols}×${rows}` +
      (short > 0 ? `, ${short} cells unplaced (the bank filled at 256 tiles)` : '')
    await resourcesStore.refresh()
  } catch (error) {
    saved.value = `Failed: ${String(error)}`
  } finally {
    saving.value = false
  }
}

function use(): void {
  if (importer.result.value) emit('imported', importer.result.value, pickedFile.value, importer.options.mode)
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
          <select v-model="importer.options.mode">
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
            v-model="importer.options.palette"
            :disabled="!paletteChoosable"
          >
            <option value="optimized">Optimized (median cut → 512 colors)</option>
            <option value="msx1">Fixed MSX1 palette</option>
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
        v-if="!paletteChoosable && importer.source.value"
        class="hint"
      >
        {{ info.label }} has a fixed hardware palette — the palette choice is ignored.
      </p>

      <div class="previews">
        <figure>
          <figcaption>Original</figcaption>
          <canvas ref="beforeCanvas" />
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
        </tbody>
      </table>

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
            :disabled="!importer.result.value || saving || !isTileMode(importer.options.mode) || !projectStore.open"
            @click="saveTileset"
          >
            Create tileset
          </button>
        </template>
        <button
          v-else
          type="button"
          class="primary"
          :disabled="!importer.result.value"
          @click="use"
        >
          Use this image
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
</style>
