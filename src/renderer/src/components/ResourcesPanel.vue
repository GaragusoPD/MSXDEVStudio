<script setup lang="ts">
/**
 * Side panel for Spec 07: the project's editor resources — create/open them in
 * their editors (Specs 08–11), the manual export command, and the standalone
 * entry point for the Import-image dialog.
 */
import { computed, onMounted, ref, watch } from 'vue'
import {
  RESOURCE_DIR,
  RESOURCE_SUFFIXES,
  defaultExport,
  parseResource,
  serializeResource,
  type ResourceKind
} from '../../../shared/msx/resource'
import { BITMAP_MODES, MODES, TILE_MODES, type ScreenMode } from '../../../shared/msx/modes'
import { blankConverted } from '../../../shared/msx/screen'
import { SW_MODES } from '../../../shared/msx/swsprite'
import { useProjectStore } from '../stores/projectStore'
import { useResourcesStore } from '../stores/resourcesStore'
import Icon from './Icon.vue'
import { useTabsStore } from '../stores/tabsStore'
import ImportImageDialog from './ImportImageDialog.vue'
import Modal from './Modal.vue'

const projectStore = useProjectStore()
const resourcesStore = useResourcesStore()
const tabsStore = useTabsStore()

/** The creation form is a modal: the sidebar's job is the list, not a form with three controls. */
const creating = ref(false)
const newKind = ref<ResourceKind>('tiles')
const newName = ref('')
const newMode = ref<ScreenMode>('sc2')

/**
 * The bare kind names are the file suffixes, and half of them say nothing out
 * loud — `btiles` in particular is where SCREEN 3 tiles and chunky software
 * sprites live, which nobody guesses.
 */
const KIND_LABELS: Record<ResourceKind, string> = {
  tiles: 'tiles — SCREEN 1/2/4 patterns',
  btiles: 'tiles — SCREEN 3 blocks / MSX2 bitmap',
  metatiles: 'meta-tiles',
  metabtiles: 'meta-tiles (bitmap)',
  sprites: 'sprites — hardware',
  swsprites: 'sprites — software, any size',
  map: 'map',
  screen: 'screen / playfield',
  sfx: 'sound effects'
}

const label = (kind: string): string => KIND_LABELS[kind as ResourceKind] ?? kind

/** One line each, because the suffix names are not self-explanatory and the modal has room. */
const KIND_HELP: Record<ResourceKind, string> = {
  tiles: '8×8 patterns with colour attributes, for SCREEN 1, 2 and 4. Two colours per row.',
  btiles: 'A bank of small images addressed by number — SCREEN 3 blocks, or MSX2 bitmap tiles. One size for the whole bank.',
  metatiles: 'One design bigger than a tile — a tree, a door, a coin — with its own frames and flags, that a map places.',
  metabtiles: 'The same, over a bitmap tileset.',
  sprites: 'Hardware sprites: 8×8 or 16×16, one colour per plane, four or eight per scanline.',
  swsprites:
    'Software sprites: drawn into the picture, so any size, any colours, no per-line limit. Each character has its own size and its own animation frames.',
  map: 'A grid of tile indices — one screen, or a world to scroll around.',
  screen: 'A picture: import one and convert it, or draw it here. SCREEN 3 and the MSX2 bitmap modes.',
  sfx: 'An ayFX sound-effect bank.'
}

/**
 * The modes a new resource of this kind can target — and the reason this picker
 * exists at all: a `.btiles.json` used to be born SCREEN 5 with no way to say
 * otherwise at creation, so "make me a SCREEN 3 tileset" meant creating the
 * wrong thing and changing it afterwards.
 *
 * Kinds with no mode (maps, meta-tiles, sprites, sfx) take it from what they
 * reference, so they get no picker.
 */
const modeOptions = computed<readonly ScreenMode[]>(() => {
  if (newKind.value === 'tiles') return TILE_MODES
  if (newKind.value === 'btiles' || newKind.value === 'screen') return BITMAP_MODES
  // Software sprites work in every mode that has pixels, which is a wider set
  // than either of the others: they are drawn *into* the picture, whatever it is.
  if (newKind.value === 'swsprites') return SW_MODES
  return []
})

watch(modeOptions, (modes) => {
  if (modes.length && !modes.includes(newMode.value)) newMode.value = modes[0]
})

function openResource(path: string): void {
  tabsStore.openFile(path, path.split('/').pop() ?? path)
}

/** Writes a fresh default doc (or just opens an existing file of that name) and its editor tab. */
async function createResource(): Promise<void> {
  const base = newName.value.replace(/[^A-Za-z0-9_-]/g, '')
  if (!base) return
  const path = `${RESOURCE_DIR}/${base}${RESOURCE_SUFFIXES[newKind.value]}`
  if (!(await window.api.invoke('fs:stat', { path }))) {
    // Seeded with the chosen mode rather than patched afterwards: `normalize*`
    // is what applies a mode's constraints (SCREEN 3 forces an even tile width
    // and drops the palette), and it only runs on the way in.
    const seed = modeOptions.value.length ? JSON.stringify({ mode: newMode.value }) : '{}'
    const resource = parseResource(path, seed)
    // A screen is born with a canvas. Without one the editor has nothing to draw
    // on and the only way forward is importing an image, which is exactly the
    // case this resource is *not* for half the time.
    if (resource.kind === 'screen') resource.doc.converted = blankConverted(resource.doc.mode)
    resource.doc.export = defaultExport(path)
    // `fs:write` doesn't create parent folders, and a project made before this
    // (or one whose res/ was deleted) hasn't got one. mkdir is idempotent.
    await window.api.invoke('fs:create', { path: RESOURCE_DIR, kind: 'directory' })
    await window.api.invoke('fs:write', { path, content: serializeResource(resource) })
    await resourcesStore.refresh()
  }
  newName.value = ''
  creating.value = false
  openResource(path)
}

const grouped = computed<[string, typeof resourcesStore.entries][]>(() => {
  const map = new Map<string, typeof resourcesStore.entries>()
  for (const entry of resourcesStore.entries) {
    const list = map.get(entry.kind) ?? []
    list.push(entry)
    map.set(entry.kind, list)
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
})

const imgRuleCount = computed(() => projectStore.project?.resources.imgRules.length ?? 0)

onMounted(() => void resourcesStore.refresh())
watch(() => projectStore.open?.root, () => void resourcesStore.refresh())
</script>

<template>
  <div class="resources-panel">
    <h2 class="header">
      Resources
    </h2>

    <p
      v-if="!projectStore.open"
      class="hint"
    >
      Open a project to see its graphics resources.
    </p>

    <p
      v-if="resourcesStore.error"
      class="hint error"
    >
      Couldn't list resources: {{ resourcesStore.error }}
    </p>

    <template v-else-if="projectStore.open">
      <div class="actions">
        <button
          type="button"
          class="primary"
          title="Create a resource and open its editor"
          @click="creating = true"
        >
          <Icon name="add" />
          New resource…
        </button>
      </div>

      <div class="actions">
        <button
          type="button"
          :disabled="resourcesStore.busy"
          @click="resourcesStore.exportAll()"
        >
          Export all
        </button>
        <button
          type="button"
          :disabled="resourcesStore.busy"
          title="Ignore the mtime check and re-convert everything"
          @click="resourcesStore.exportAll(true)"
        >
          Force
        </button>
        <button
          type="button"
          @click="resourcesStore.importVisible = true"
        >
          Import image…
        </button>
      </div>

      <p class="hint">
        Exports also run automatically before every build, skipping anything already up to date.
      </p>

      <p
        v-if="!resourcesStore.entries.length"
        class="hint empty"
      >
        No <code>.tiles.json</code>, <code>.sprites.json</code>, <code>.map.json</code> or
        <code>.screen.json</code> files yet.
      </p>

      <section
        v-for="[kind, entries] in grouped"
        :key="kind"
      >
        <h3>{{ label(kind) }}</h3>
        <div
          v-for="entry in entries"
          :key="entry.path"
          class="row"
        >
          <button
            type="button"
            class="path"
            :title="`Open ${entry.path} in its editor`"
            @click="openResource(entry.path)"
          >
            {{ entry.path }}
          </button>
          <span
            class="out"
            :title="entry.out ?? 'No export target set'"
          >{{ entry.out ?? '—' }}</span>
          <button
            type="button"
            title="Export this resource now"
            @click="resourcesStore.exportOne(entry.path)"
          >
            <Icon name="refresh" />
          </button>
        </div>
      </section>

      <section>
        <h3>Image rules</h3>
        <p class="hint">
          {{ imgRuleCount }} MSXimg rule{{ imgRuleCount === 1 ? '' : 's' }} — edit them in Project Settings.
        </p>
      </section>
    </template>

    <Modal
      v-if="creating"
      title="New resource"
      @close="creating = false"
    >
      <form
        class="new-resource"
        @submit.prevent="createResource"
      >
        <label class="field">
          <span>Kind</span>
          <select v-model="newKind">
            <option
              v-for="(suffix, kind) in RESOURCE_SUFFIXES"
              :key="kind"
              :value="kind"
            >
              {{ label(kind) }}
            </option>
          </select>
        </label>
        <p class="hint">
          {{ KIND_HELP[newKind] }}
        </p>
        <label
          v-if="modeOptions.length"
          class="field"
        >
          <span>Screen mode</span>
          <select v-model="newMode">
            <option
              v-for="id in modeOptions"
              :key="id"
              :value="id"
            >
              {{ MODES[id].label }}
            </option>
          </select>
        </label>
        <label class="field">
          <span>Name</span>
          <input
            v-model="newName"
            type="text"
            placeholder="hero"
            spellcheck="false"
          >
        </label>
        <p class="hint">
          Creates <code>{{ RESOURCE_DIR }}/{{ newName.replace(/[^A-Za-z0-9_-]/g, '') || 'name' }}{{ RESOURCE_SUFFIXES[newKind] }}</code>
          and opens its editor.
        </p>
        <div class="modal-actions">
          <button
            type="button"
            @click="creating = false"
          >
            Cancel
          </button>
          <button
            type="submit"
            class="primary"
            :disabled="!newName.trim()"
          >
            Create
          </button>
        </div>
      </form>
    </Modal>

    <ImportImageDialog
      v-if="resourcesStore.importVisible"
      @close="resourcesStore.importVisible = false"
    />
  </div>
</template>

<style scoped>
.new-resource {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.new-resource .field {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.new-resource .field > span {
  flex: 0 0 6.5rem;
}

.new-resource .field > select,
.new-resource .field > input {
  flex: 1;
  min-width: 0;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.4rem;
}

.resources-panel {
  padding: 8px 10px 20px;
}

.header {
  margin: 0 0 8px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-text);
}

h3 {
  margin: 14px 0 4px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
}

.actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.actions button {
  padding: 3px 10px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-hover);
  font-size: 11px;
}

.actions button:disabled {
  opacity: 0.5;
  cursor: default;
}

.actions select,
.actions input {
  padding: 3px 6px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-hover);
  color: var(--color-text);
  font-size: 11px;
}

.actions input {
  flex: 1;
  min-width: 60px;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  font-size: 12px;
}

.row .path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0;
  border: none;
  background: none;
  text-align: left;
  font-size: 12px;
  color: var(--color-text);
  cursor: pointer;
}

.row .path:hover {
  color: var(--color-accent);
  text-decoration: underline;
}

.out {
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--color-text-muted);
}

.row button {
  padding: 0 5px;
  color: var(--color-text-muted);
}

.row button:hover {
  color: var(--color-text);
}

.hint.error {
  color: var(--color-error, #f14c4c);
}

.hint {
  margin: 0 0 4px;
  font-size: 11px;
  color: var(--color-text-muted);
  line-height: 1.5;
}

.empty {
  margin-top: 12px;
}
</style>
