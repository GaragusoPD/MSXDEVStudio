<script setup lang="ts">
/**
 * Spec 11 — the `.sfx.json` editor tab: the bank's effect list, the three-lane
 * frame grid, and in-app audition through the PSG model in `shared/psg.ts`.
 *
 * Registered for the `sfx.json` compound extension in `editors/bootstrap.ts`,
 * so the explorer opens effect banks here instead of in Monaco.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { importAyfx, presetEffect, SFX_PRESETS, type SfxEffect } from '../../../../shared/msx/sfx'
import {
  addEffect,
  deleteEffect,
  duplicateEffect,
  moveEffect,
  paintLane,
  renameEffect,
  setFrameCount,
  type LaneStroke,
  type SfxLane
} from '../../../../shared/sfx-editor'
import { useResourcesStore } from '../../stores/resourcesStore'
import { useTabsStore } from '../../stores/tabsStore'
import SfxLanes from './SfxLanes.vue'
import { playSfx, scrubFrame, stopSfx } from './audio'
import {
  canRedo,
  canUndo,
  commit,
  commitSelected,
  doc,
  pruneSfxSessions,
  redo,
  saveSession,
  selectedEffect,
  sfxSession,
  undo
} from './session'

const tabsStore = useTabsStore()
const resourcesStore = useResourcesStore()

const path = computed(() => tabsStore.activeTab?.filePath ?? '')
const session = computed(() => sfxSession(path.value))
const bank = computed(() => doc(session.value))
const effect = computed(() => selectedEffect(session.value))
const fileInput = ref<HTMLInputElement | null>(null)

function play(from = 0): void {
  const active = session.value
  const frames = effect.value.frames.slice(from)
  if (!frames.length) return
  active.playing = true
  playSfx(frames, {
    rate: bank.value.rate,
    loop: active.loop,
    onFrame: (index) => {
      active.playhead = index < 0 ? -1 : index + from
      if (index < 0) active.playing = false
    }
  })
}

function stop(): void {
  stopSfx()
  session.value.playing = false
  session.value.playhead = -1
}

function toggle(): void {
  if (session.value.playing) stop()
  else play(0)
}

function onPaint(lane: SfxLane, from: LaneStroke, to: LaneStroke, erase: boolean): void {
  commitSelected(session.value, (target) => {
    const frames = paintLane(target.frames, lane, from, to, erase)
    return frames === target.frames ? target : { ...target, frames }
  })
}

/** Scrubbing auditions the frame under the pointer — but not while the effect is playing. */
function onScrub(index: number): void {
  const active = session.value
  if (active.playing) return
  active.playhead = index
  const frame = effect.value.frames[index]
  if (frame) scrubFrame(frame, bank.value.rate)
}

function setFrames(count: number): void {
  commitSelected(session.value, (target) => {
    const frames = setFrameCount(target.frames, count)
    return frames === target.frames ? target : { ...target, frames }
  })
}

function applyPreset(event: Event): void {
  const select = event.target as HTMLSelectElement
  const name = select.value
  // Snap back to the "Preset…" placeholder so the same preset can be picked twice.
  select.value = ''
  if (!name) return
  const active = session.value
  commit(active, addEffect(bank.value, presetEffect(name)))
  active.selected = bank.value.effects.length - 1
  active.status = `Added preset "${name}"`
}

function addBlank(): void {
  const active = session.value
  commit(active, addEffect(bank.value, { name: 'fx', frames: [] }))
  active.selected = bank.value.effects.length - 1
}

async function onImportFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const active = session.value
  try {
    const imported = importAyfx(new Uint8Array(await file.arrayBuffer()), file.name)
    let next = bank.value
    for (const one of imported) next = addEffect(next, one as SfxEffect)
    commit(active, next)
    active.selected = next.effects.length - 1
    active.status = `Imported ${imported.length} effect(s) from ${file.name}`
  } catch (error) {
    active.status = `Import failed: ${String(error)}`
  }
}

async function save(): Promise<void> {
  try {
    await saveSession(session.value)
  } catch (error) {
    session.value.status = `Save failed: ${String(error)}`
  }
}

/** Export goes through Spec 07's converter, so the file on disk has to be current first. */
async function exportNow(): Promise<void> {
  await save()
  await resourcesStore.exportOne(session.value.path)
}

function onKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return
  if (event.ctrlKey) {
    const key = event.key.toLowerCase()
    // Ctrl+S is EditorArea's, for every tab kind — see `commands.ts`.
    if (key === 'z' && !event.shiftKey) {
      event.preventDefault()
      undo(session.value)
    } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
      event.preventDefault()
      redo(session.value)
    }
    return
  }
  if (event.key === ' ') {
    event.preventDefault()
    toggle()
  } else if (event.key.toLowerCase() === 'p') {
    event.preventDefault()
    play(0)
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  stopSfx()
})

// Sessions outlive tab switches (like Monaco models do); drop the ones whose tab is gone.
watch(
  () => tabsStore.tabs.length,
  () => pruneSfxSessions(new Set(tabsStore.tabs.map((tab) => tab.filePath ?? ''))),
  { immediate: true }
)
</script>

<template>
  <div class="sfx-editor">
    <p
      v-if="session.error"
      class="error"
    >
      {{ session.error }}
    </p>
    <template v-else-if="!session.loading">
      <div class="toolbar">
        <button
          :title="session.playing ? 'Stop (Space)' : 'Play (Space) — P restarts from frame 0'"
          @click="toggle"
        >
          {{ session.playing ? '■' : '▶' }}
        </button>
        <button
          :class="{ active: session.loop }"
          title="Loop"
          @click="session.loop = !session.loop"
        >
          ↻
        </button>
        <select
          :value="bank.rate"
          title="Replay rate — how often the game calls ayFX_Update()"
          @change="commit(session, { ...bank, rate: Number(($event.target as HTMLSelectElement).value) === 60 ? 60 : 50 })"
        >
          <option :value="50">
            50 Hz
          </option>
          <option :value="60">
            60 Hz
          </option>
        </select>

        <span class="sep" />

        <label class="frames">
          Frames
          <input
            type="number"
            min="1"
            max="255"
            :value="effect.frames.length"
            @change="setFrames(Number(($event.target as HTMLInputElement).value))"
          >
        </label>

        <select
          value=""
          title="Append a preset effect"
          @change="applyPreset"
        >
          <option value="">
            Preset…
          </option>
          <option
            v-for="preset in SFX_PRESETS"
            :key="preset.name"
            :value="preset.name"
          >
            {{ preset.name }}
          </option>
        </select>

        <button
          title="Import an AYFX Editor .afx effect or .afb bank"
          @click="fileInput?.click()"
        >
          Import…
        </button>
        <input
          ref="fileInput"
          type="file"
          accept=".afx,.afb"
          hidden
          @change="onImportFile"
        >

        <span class="sep" />

        <button
          :disabled="!canUndo(session)"
          title="Undo (Ctrl+Z)"
          @click="undo(session)"
        >
          ↶
        </button>
        <button
          :disabled="!canRedo(session)"
          title="Redo (Ctrl+Y)"
          @click="redo(session)"
        >
          ↷
        </button>

        <span class="spacer" />
        <span class="status">{{ session.status }}</span>
        <button
          :disabled="!session.dirty"
          title="Save (Ctrl+S)"
          @click="save"
        >
          Save
        </button>
        <button
          title="Write the ayFX bank to the project's content folder"
          @click="exportNow"
        >
          Export
        </button>
      </div>

      <div class="body">
        <div class="effects">
          <h3>Bank</h3>
          <ul>
            <li
              v-for="(one, index) in bank.effects"
              :key="index"
              class="row"
              :class="{ active: index === session.selected }"
              @click="session.selected = index"
            >
              <span class="id">{{ index }}</span>
              <input
                class="name"
                :value="one.name"
                @change="commit(session, renameEffect(bank, index, ($event.target as HTMLInputElement).value))"
              >
            </li>
          </ul>
          <div class="list-actions">
            <button
              title="New empty effect"
              @click="addBlank"
            >
              +
            </button>
            <button
              title="Duplicate"
              @click="commit(session, duplicateEffect(bank, session.selected))"
            >
              ⧉
            </button>
            <button
              title="Delete"
              :disabled="bank.effects.length <= 1"
              @click="commit(session, deleteEffect(bank, session.selected))"
            >
              🗑
            </button>
            <button
              title="Move up — renumbers the ayFX_PlayBank() ids"
              :disabled="session.selected === 0"
              @click="commit(session, moveEffect(bank, session.selected, session.selected - 1)); session.selected--"
            >
              ▲
            </button>
            <button
              title="Move down — renumbers the ayFX_PlayBank() ids"
              :disabled="session.selected >= bank.effects.length - 1"
              @click="commit(session, moveEffect(bank, session.selected, session.selected + 1)); session.selected++"
            >
              ▼
            </button>
          </div>
          <p class="hint">
            The list position is the id you pass to <code>ayFX_PlayBank()</code>, so reordering
            renumbers sounds in your game code.
          </p>
        </div>

        <SfxLanes
          :frames="effect.frames"
          :playhead="session.playhead"
          @paint="onPaint"
          @scrub="onScrub"
        />
      </div>

      <p class="legend">
        Drag to draw · right-drag to switch a lane off · pitch and noise lanes are
        <em>periods</em>, so up is higher. A frame at volume 0 tells the ayFX player to skip the
        frame entirely — it holds the previous sound rather than going silent.
      </p>
    </template>
  </div>
</template>

<style scoped>
.sfx-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--color-bg-editor);
  color: var(--color-text);
  font-family: var(--font-ui);
}

.error {
  padding: 12px;
  color: #f48771;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--color-border);
  flex-wrap: wrap;
}

.toolbar button,
.toolbar select,
.frames input {
  background: var(--color-bg-tab-inactive);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  padding: 3px 8px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.toolbar button:disabled {
  opacity: 0.4;
  cursor: default;
}

.toolbar button:not(:disabled):hover {
  background: var(--color-bg-hover);
}

.toolbar button.active {
  border-color: var(--color-accent);
  background: var(--color-bg-active-item);
}

.frames {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--color-text-muted);
}

.frames input {
  width: 58px;
  cursor: text;
}

.sep {
  width: 1px;
  height: 18px;
  background: var(--color-border);
}

.spacer {
  flex: 1;
}

.status {
  font-size: 11px;
  color: var(--color-text-muted);
}

.body {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.effects {
  display: flex;
  flex-direction: column;
  width: 200px;
  flex-shrink: 0;
  border-right: 1px solid var(--color-border);
  padding: 8px;
  overflow-y: auto;
}

h3 {
  margin: 0 0 6px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
}

ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 4px;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
}

.row:hover {
  background: var(--color-bg-hover);
}

.row.active {
  border-color: var(--color-accent);
  background: var(--color-bg-active-item);
}

.id {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--color-text-muted);
  min-width: 18px;
  text-align: right;
}

.name {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  color: inherit;
  font: inherit;
  font-size: 12px;
  padding: 2px;
}

.name:focus {
  background: var(--color-bg-tab-inactive);
  outline: 1px solid var(--color-accent);
  border-radius: 3px;
}

.list-actions {
  display: flex;
  gap: 4px;
  margin-top: 6px;
}

.list-actions button {
  flex: 1;
  background: var(--color-bg-tab-inactive);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  padding: 2px;
  font-size: 11px;
  cursor: pointer;
}

.list-actions button:disabled {
  opacity: 0.4;
  cursor: default;
}

.hint,
.legend {
  margin: 8px 0 0;
  font-size: 11px;
  line-height: 1.4;
  color: var(--color-text-muted);
}

.legend {
  margin: 0;
  padding: 6px 10px;
  border-top: 1px solid var(--color-border);
}

code {
  font-family: var(--font-mono);
}
</style>
