<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  GAME_KITS,
  availableScreens,
  defaultDisplayMode,
  defaultScreens,
  displayModesFor,
  kitLibModules,
  suggestTarget,
  type DisplayMode,
  type GameAudio,
  type GameKitId,
  type ScreenId
} from '../../../shared/game-kit'
import { CURATED_TARGETS, MSX_MACHINES, MSX_TARGETS, type Machine } from '../../../shared/msxgl-consts'
import { useProjectStore } from '../stores/projectStore'
import { useToolchainStore } from '../stores/toolchainStore'
import Modal from './Modal.vue'

const STEPS = ['Name', 'Machine', 'Kit', 'Screen', 'Screens', 'Audio', 'Review'] as const

const MODE_LABEL: Record<DisplayMode, string> = {
  sc0w40: 'SCREEN 0 / 40 columns',
  sc0w80: 'SCREEN 0 / 80 columns',
  sc1: 'SCREEN 1',
  sc2: 'SCREEN 2',
  sc3: 'SCREEN 3',
  sc4: 'SCREEN 4',
  sc5: 'SCREEN 5',
  sc6: 'SCREEN 6',
  sc7: 'SCREEN 7',
  sc8: 'SCREEN 8'
}

const SCREEN_LABEL: Record<ScreenId, string> = {
  title: 'Title',
  menu: 'Main menu',
  options: 'Options',
  intro: 'Intro / cutscene',
  play: 'Play',
  pause: 'Pause',
  hud: 'HUD layer',
  gameover: 'Game over',
  victory: 'Victory',
  credits: 'Credits',
  attract: 'Attract / demo',
  password: 'Password',
  'stage-select': 'Stage select'
}

const projectStore = useProjectStore()
const toolchainStore = useToolchainStore()

const step = ref(0)
const name = ref('mygame')
const location = ref('')
const machine = ref<Machine>('1')
const kit = ref<GameKitId>('platformer')
const displayMode = ref<DisplayMode>(defaultDisplayMode('platformer', '1'))
const screens = ref<ScreenId[]>([...defaultScreens('platformer')])
const audio = ref<GameAudio>('none')
const showAllTargets = ref(false)
const target = ref('ROM_32K')
const romSize = ref<number | null>(null)
const busy = ref(false)

const nameValid = computed(() => /^[A-Za-z0-9_-]+$/.test(name.value))
const modes = computed(() => displayModesFor(kit.value, machine.value))
const screenChoices = computed(() => availableScreens(kit.value))
const suggestion = computed(() =>
  suggestTarget({ kit: kit.value, displayMode: displayMode.value, screens: screens.value })
)
const targets = computed(() =>
  showAllTargets.value
    ? MSX_TARGETS
    : MSX_TARGETS.filter((entry) => (CURATED_TARGETS as string[]).includes(entry.value))
)
const modules = computed(() =>
  kitLibModules({
    kit: kit.value,
    screens: screens.value,
    audio: audio.value,
    displayMode: displayMode.value
  })
)
const canCreate = computed(() => nameValid.value && location.value.trim().length > 0 && !busy.value)
const canNext = computed(() => {
  if (step.value === 0) return nameValid.value && location.value.trim().length > 0
  return true
})

watch([kit, machine], () => {
  const legal = displayModesFor(kit.value, machine.value)
  if (!legal.includes(displayMode.value)) displayMode.value = defaultDisplayMode(kit.value, machine.value)
  const allowed = availableScreens(kit.value)
  const next = defaultScreens(kit.value).filter((id) => allowed.includes(id))
  for (const id of screens.value) {
    if (allowed.includes(id) && !next.includes(id)) next.push(id)
  }
  screens.value = next
})

watch(
  suggestion,
  (value) => {
    target.value = value.target
    romSize.value = value.romSize
  },
  { immediate: true }
)

function toggleScreen(id: ScreenId): void {
  if (id === 'play') return
  const index = screens.value.indexOf(id)
  if (index === -1) screens.value.push(id)
  else screens.value.splice(index, 1)
}

async function browse(): Promise<void> {
  const picked = await toolchainStore.pickFolder()
  if (picked) location.value = picked
}

function close(): void {
  projectStore.gameWizardVisible = false
}

async function create(): Promise<void> {
  busy.value = true
  try {
    await projectStore.createGameProject({
      name: name.value.trim(),
      location: location.value.trim(),
      machine: machine.value,
      kit: kit.value,
      displayMode: displayMode.value,
      screens: [...screens.value],
      audio: audio.value,
      target: target.value,
      romSize: romSize.value
    })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal
    title="New Game"
    wide
    @close="close"
  >
    <ol class="steps">
      <li
        v-for="(label, index) in STEPS"
        :key="label"
        :class="{ current: index === step, done: index < step }"
      >
        {{ label }}
      </li>
    </ol>

    <div
      v-if="step === 0"
      class="step"
    >
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
    </div>

    <div
      v-else-if="step === 1"
      class="step"
    >
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
    </div>

    <div
      v-else-if="step === 2"
      class="step kits"
    >
      <button
        v-for="entry in GAME_KITS"
        :key="entry.id"
        type="button"
        class="kit"
        :class="{ selected: kit === entry.id }"
        @click="kit = entry.id"
      >
        <strong>{{ entry.title }}</strong>
        <span>{{ entry.description }}</span>
      </button>
    </div>

    <div
      v-else-if="step === 3"
      class="step"
    >
      <label>
        <span>Display mode</span>
        <select v-model="displayMode">
          <option
            v-for="mode in modes"
            :key="mode"
            :value="mode"
          >{{ MODE_LABEL[mode] }}</option>
        </select>
      </label>
    </div>

    <div
      v-else-if="step === 4"
      class="step"
    >
      <span class="field-label">Screens</span>
      <label
        v-for="id in screenChoices"
        :key="id"
        class="inline"
      >
        <input
          type="checkbox"
          :checked="screens.includes(id)"
          :disabled="id === 'play'"
          @change="toggleScreen(id)"
        >
        <span>{{ SCREEN_LABEL[id] }}</span>
      </label>
    </div>

    <div
      v-else-if="step === 5"
      class="step"
    >
      <label class="inline">
        <input
          v-model="audio"
          type="radio"
          value="none"
        >
        <span>No sound</span>
      </label>
      <label class="inline">
        <input
          v-model="audio"
          type="radio"
          value="ayfx"
        >
        <span>ayFX sound effects</span>
      </label>
    </div>

    <div
      v-else
      class="step"
    >
      <p class="hint">
        {{ suggestion.reason }}
      </p>
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
        Modules: <code>{{ modules.join(', ') }}</code>
      </p>
      <p class="hint">
        {{ MODE_LABEL[displayMode] }} · {{ screens.join(', ') }}
      </p>
    </div>

    <div class="actions">
      <button
        type="button"
        @click="close"
      >
        Cancel
      </button>
      <button
        v-if="step > 0"
        type="button"
        @click="step--"
      >
        Back
      </button>
      <button
        v-if="step < STEPS.length - 1"
        type="button"
        class="primary"
        :disabled="!canNext"
        @click="step++"
      >
        Next
      </button>
      <button
        v-else
        type="button"
        class="primary"
        :disabled="!canCreate"
        @click="create"
      >
        Create
      </button>
    </div>
  </Modal>
</template>

<style scoped>
.steps {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  margin: 0 0 16px;
  padding: 0;
  list-style: none;
  font-size: 11px;
  color: var(--color-text-muted);
}

.steps .current {
  color: var(--color-text);
  font-weight: 600;
}

.steps .done {
  color: var(--color-text);
}

.step {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.kits {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.kit {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-bg-tab-inactive);
  text-align: left;
  font-size: 12px;
}

.kit.selected {
  border-color: var(--color-accent);
}

.kit span {
  color: var(--color-text-muted);
  font-size: 11px;
}

label {
  display: block;
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

.field-label {
  font-size: 12px;
  color: var(--color-text-muted);
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
  margin: 0;
  font-size: 11px;
  color: var(--color-text-muted);
}

.hint.bad {
  color: #e06c75;
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
