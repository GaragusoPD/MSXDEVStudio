<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { CURATED_TARGETS, MSX_MACHINES, MSX_TARGETS, type Machine } from '../../../shared/msxgl-consts'
import { defaultProject } from '../../../shared/msxproj'
import { useExamplesStore } from '../stores/examplesStore'
import { useProjectStore } from '../stores/projectStore'
import { useToolchainStore } from '../stores/toolchainStore'

const projectStore = useProjectStore()
const examplesStore = useExamplesStore()
const toolchainStore = useToolchainStore()

const name = ref('mygame')
const location = ref('')
const machine = ref<Machine>('1')
const target = ref<string>('ROM_32K')
const showAllTargets = ref(false)
const libModules = ref<string[]>([...defaultProject('').libModules])
const copyEntireContent = ref(false)
const busy = ref(false)

// Set only while forking an example (Spec 12) — machine/target/LibModules come from the
// sample's own evaluated config at fork time, not from these (informational-only) fields.
const forking = computed(() => examplesStore.forkSource !== null)

const targets = computed(() =>
  showAllTargets.value
    ? MSX_TARGETS
    : MSX_TARGETS.filter((entry) => (CURATED_TARGETS as string[]).includes(entry.value))
)

// Only two templates exist in MSXgl; the machine picks between them.
const template = computed(() => (machine.value === '1' ? 'projects/template' : 'projects/template_msx2'))

const nameValid = computed(() => /^[A-Za-z0-9_-]+$/.test(name.value))
const canCreate = computed(() => nameValid.value && location.value.trim().length > 0 && !busy.value)

onMounted(() => void projectStore.loadLibModules())

watch(
  () => examplesStore.forkSource,
  (source) => {
    if (!source) return
    name.value = source.id.replace(/^s_/, '')
    machine.value = source.machine
    target.value = source.target
    copyEntireContent.value = false
  },
  { immediate: true }
)

function toggleModule(module: string): void {
  const index = libModules.value.indexOf(module)
  if (index === -1) libModules.value.push(module)
  else libModules.value.splice(index, 1)
}

async function browse(): Promise<void> {
  const picked = await toolchainStore.pickFolder()
  if (picked) location.value = picked
}

function close(): void {
  projectStore.wizardVisible = false
  examplesStore.cancelFork()
}

async function create(): Promise<void> {
  busy.value = true
  try {
    const request = {
      name: name.value.trim(),
      location: location.value.trim(),
      machine: machine.value,
      target: target.value,
      libModules: [...libModules.value]
    }
    if (forking.value && examplesStore.forkSource) {
      await examplesStore.submitFork(examplesStore.forkSource.id, request, copyEntireContent.value)
    } else {
      await projectStore.createProject(request)
    }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div
    class="backdrop"
    @click.self="close"
  >
    <div class="dialog">
      <h2>{{ forking ? 'New Project from Example' : 'New Project' }}</h2>
      <p
        v-if="forking && examplesStore.forkSource"
        class="hint"
      >
        From <strong>{{ examplesStore.forkSource.title }}</strong> —
        {{ MSX_MACHINES.find((m) => m.value === machine)?.label ?? machine }} · {{ target }}
      </p>

      <label>
        <span>Name</span>
        <input
          v-model="name"
          type="text"
          spellcheck="false"
        >
      </label>
      <p
        v-if="!nameValid"
        class="hint bad"
      >
        Letters, digits, dash and underscore only.
      </p>

      <label>
        <span>Location</span>
        <span class="path-row">
          <input
            v-model="location"
            type="text"
            placeholder="Parent folder"
          >
          <button
            type="button"
            @click="browse"
          >Browse…</button>
        </span>
      </label>
      <p class="hint">
        Creates <code>{{ location || '<location>' }}/{{ name }}</code>
      </p>

      <template v-if="!forking">
        <label>
          <span>Machine</span>
          <select v-model="machine">
            <option
              v-for="entry in MSX_MACHINES"
              :key="entry.value"
              :value="entry.value"
            >{{ entry.label }}</option>
          </select>
        </label>

        <label>
          <span>Target</span>
          <select v-model="target">
            <option
              v-for="entry in targets"
              :key="entry.value"
              :value="entry.value"
            >{{ entry.value }} — {{ entry.label }}</option>
          </select>
        </label>
        <label class="inline">
          <input
            v-model="showAllTargets"
            type="checkbox"
          >
          <span>Show all targets</span>
        </label>

        <p class="hint">
          Template: <code>{{ template }}</code>
        </p>

        <div class="modules">
          <span class="modules-title">Library modules</span>
          <div class="module-list">
            <label
              v-for="module in projectStore.libModules"
              :key="module"
              class="inline"
            >
              <input
                type="checkbox"
                :checked="libModules.includes(module)"
                @change="toggleModule(module)"
              >
              <span>{{ module }}</span>
            </label>
            <p
              v-if="!projectStore.libModules.length"
              class="hint"
            >
              Set up MSXgl in Settings to list its modules.
            </p>
          </div>
        </div>
      </template>

      <label
        v-else
        class="inline"
      >
        <input
          v-model="copyEntireContent"
          type="checkbox"
        >
        <span>Copy the entire samples <code>content/</code> folder (instead of only what the sample includes)</span>
      </label>

      <div class="actions">
        <button
          type="button"
          @click="close"
        >
          Cancel
        </button>
        <button
          type="button"
          class="primary"
          :disabled="!canCreate"
          @click="create"
        >
          Create
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
  z-index: 100;
}

.dialog {
  width: 520px;
  max-height: 85vh;
  overflow-y: auto;
  padding: 20px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-editor);
  color: var(--color-text);
}

h2 {
  margin: 0 0 16px;
  font-size: 16px;
  font-weight: 600;
}

label {
  display: block;
  margin-bottom: 10px;
  font-size: 12px;
}

label > span:first-child {
  display: block;
  margin-bottom: 4px;
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
  color: var(--color-text);
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

.path-row {
  display: flex;
  gap: 6px;
}

.path-row button {
  padding: 4px 8px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-hover);
  font-size: 12px;
  white-space: nowrap;
}

.hint {
  margin: -4px 0 10px;
  font-size: 11px;
  color: var(--color-text-muted);
}

.hint.bad {
  color: #e06c75;
}

.modules {
  margin: 12px 0;
}

.modules-title {
  display: block;
  margin-bottom: 4px;
  font-size: 12px;
  color: var(--color-text-muted);
}

.module-list {
  max-height: 160px;
  overflow-y: auto;
  padding: 6px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 2px 8px;
  font-size: 11px;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

.actions button {
  padding: 6px 14px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-bg-hover);
  font-size: 12px;
}

.actions button.primary {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: #ffffff;
}

.actions button:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
