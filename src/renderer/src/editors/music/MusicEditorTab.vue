<script setup lang="ts">
/**
 * Spec 15 — the `.music.json` editor tab: the bank's songs and instruments, a
 * piano roll over the three PSG channels, ready-made beats, and playback that
 * mixes in the project's sound effects the way the game's helper does.
 *
 * Registered for the `music.json` compound extension in `editors/bootstrap.ts`.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  applyVoices,
  BEAT_PRESETS,
  CHANNEL_NAMES,
  exportSong,
  INSTRUMENT_PRESETS,
  instrumentPreset,
  loopFrame,
  MAX_BARS,
  MAX_SPEED,
  noteName,
  noteVoice,
  renderSong,
  ROWS_PER_BAR,
  silentRegisters,
  tempoBpm,
  validateMusic,
  type PsgRegisters
} from '../../../../shared/msx/music'
import { parseResource } from '../../../../shared/msx/resource'
import { effectPriority, sfxChannel, type SfxDoc } from '../../../../shared/msx/sfx'
import {
  addInstrument,
  addSong,
  applyBeat,
  copyBar,
  deleteInstrument,
  deleteSong,
  duplicateSong,
  hitAnyChannel,
  instrumentInUse,
  MAX_ROW_W,
  MIN_ROW_W,
  removeNote,
  renameInstrument,
  renameSong,
  replaceNote,
  setBars,
  setLoopBar,
  setSpeed
} from '../../../../shared/music-editor'
import { musicSetup, musicSetupDone, patchConfigDefines, type MusicSetup } from '../../../../shared/msxgl-config'
import { isTypingTarget } from '../../commands'
import Icon from '../../components/Icon.vue'
import { useProjectStore } from '../../stores/projectStore'
import { useResourcesStore } from '../../stores/resourcesStore'
import { useTabsStore } from '../../stores/tabsStore'
import PianoRoll from './PianoRoll.vue'
import { fireEffect, fireJingle, isMusicPlaying, playMusic, previewFrames, stopMusic, updateMusic } from './audio'
import { CHANNEL_COLORS, type RollPointer } from './roll'
import {
  beginDrag,
  canRedo,
  canUndo,
  commit,
  commitSong,
  currentSong,
  doc,
  endDrag,
  moveDrag,
  musicSession,
  pruneMusicSessions,
  redo,
  saveSession,
  undo
} from './session'

const tabsStore = useTabsStore()
const resourcesStore = useResourcesStore()
const projectStore = useProjectStore()

const path = computed(() => tabsStore.activeTab?.filePath ?? '')
const session = computed(() => musicSession(path.value))
const bank = computed(() => doc(session.value))
const song = computed(() => currentSong(session.value))
const problems = computed(() => validateMusic(bank.value))

/** Exported size and length of the song on screen — what it costs in the ROM. */
const size = computed(() => {
  try {
    const one = exportSong(bank.value, bank.value.songs[session.value.song])
    return { bytes: one.bytes.length, seconds: one.frames / bank.value.rate }
  } catch {
    return null
  }
})
const totalBytes = computed(() => {
  try {
    return bank.value.songs.reduce((sum, one) => sum + exportSong(bank.value, one).bytes.length, 0)
  } catch {
    return 0
  }
})

const LENGTHS = [
  { rows: 1, label: '1/16' },
  { rows: 2, label: '1/8' },
  { rows: 4, label: '1/4' },
  { rows: 8, label: '1/2' },
  { rows: 16, label: '1 bar' }
]

// ── playback ────────────────────────────────────────────────────────────────

function rendered(): PsgRegisters[] {
  return renderSong(bank.value, bank.value.songs[session.value.song], session.value.muted)
}

function play(): void {
  void loadEffects()
  const active = session.value
  const one = bank.value.songs[active.song]
  active.playing = true
  playMusic(rendered(), {
    rate: bank.value.rate,
    loopFrame: loopFrame(one),
    loop: active.loop,
    start: active.startRow * one.speed,
    effectChannel: active.effectChannel,
    onFrame: (frame) => {
      if (frame < 0 && !isMusicPlaying()) {
        active.playing = false
        active.playhead = -1
        return
      }
      active.playhead = frame
    }
  })
}

function stop(): void {
  stopMusic()
  session.value.playing = false
  session.value.playhead = -1
}

function toggle(): void {
  if (session.value.playing) stop()
  else play()
}

// Edits made while it plays are heard on the next chunk.
watch(
  () => [bank.value, session.value.song, session.value.muted, session.value.loop, session.value.effectChannel] as const,
  () => {
    const active = session.value
    if (!active.playing) return
    const one = bank.value.songs[active.song]
    updateMusic(rendered(), loopFrame(one), active.loop, active.effectChannel)
  }
)

/**
 * A song of the bank once over the one playing, as `g_Music_PlayJingle` plays
 * it: the song stops where it is and carries on afterwards. Rendered unmuted —
 * the mute buttons are for the song being edited.
 */
function jingle(index: number): void {
  const one = bank.value.songs[index]
  if (!one) return
  fireJingle(renderSong(bank.value, one), { rate: bank.value.rate, effectChannel: session.value.effectChannel })
}

/** About half a second of one note on its own — what drawing or clicking a key sounds like. */
function previewNote(pitch: number, instrumentIndex: number): void {
  const instrument = bank.value.instruments[instrumentIndex]
  if (!instrument) return
  const note = { row: 0, length: 1, pitch, instrument: instrumentIndex, volume: 15 }
  const frames: PsgRegisters[] = []
  let regs = silentRegisters()
  const count = Math.round(bank.value.rate * 0.45)
  for (let frame = 0; frame < count + 2; frame++) {
    regs = applyVoices(regs, [frame < count ? noteVoice(instrument, note, frame) : null])
    frames.push(regs)
  }
  previewFrames(frames, bank.value.rate)
}

// ── the piano roll ──────────────────────────────────────────────────────────

let lastPitch = -1

function onPress(at: RollPointer, button: number): void {
  const active = session.value
  const one = song.value
  if (button === 2) {
    beginDrag(active, { kind: 'erase', channel: active.channel }, at.row, at.pitch)
    return
  }
  const hit = hitAnyChannel(one, active.channel, at.x, at.y, active.zoom)
  if (hit && hit.channel !== active.channel) {
    // A dimmed note: switch to its channel rather than drawing over it.
    active.channel = hit.channel
    active.selected = hit.index
    active.instrument = one.channels[hit.channel][hit.index].instrument
    previewNote(one.channels[hit.channel][hit.index].pitch, active.instrument)
    return
  }
  if (hit) {
    const note = one.channels[hit.channel][hit.index]
    active.selected = hit.index
    active.instrument = note.instrument
    if (hit.part === 'end') beginDrag(active, { kind: 'resize', channel: hit.channel, index: hit.index, original: note }, at.row, at.pitch)
    else beginDrag(active, { kind: 'move', channel: hit.channel, index: hit.index, original: note, grabRow: at.row, grabPitch: at.pitch }, at.row, at.pitch)
    previewNote(note.pitch, note.instrument)
    lastPitch = at.pitch
    return
  }
  const origin = { row: at.row, length: active.noteLength, pitch: at.pitch, instrument: active.instrument, volume: 15 }
  beginDrag(active, { kind: 'draw', channel: active.channel, origin }, at.row, at.pitch)
  previewNote(at.pitch, active.instrument)
  lastPitch = at.pitch
}

function onDrag(at: RollPointer): void {
  const active = session.value
  moveDrag(active, at.row, at.pitch)
  // Moving a note to another pitch plays it there, so you hear where it lands.
  if (active.drag?.kind === 'move' && at.pitch !== lastPitch) {
    const pitch = active.drag.original.pitch + at.pitch - active.drag.grabPitch
    previewNote(pitch, active.drag.original.instrument)
    lastPitch = at.pitch
  }
}

function onRelease(): void {
  endDrag(session.value)
}

function onRuler(row: number, button: number): void {
  const active = session.value
  if (button === 2) {
    const bar = Math.floor(row / ROWS_PER_BAR)
    if (bar + 1 >= song.value.bars) {
      active.status = 'That is the last bar — add one first (Bars)'
      return
    }
    commitSong(active, (one) => copyBar(one, bar, bar + 1))
    active.status = `Copied bar ${bar + 1} into bar ${bar + 2}`
    return
  }
  active.startRow = row
  if (active.playing) play()
}

function onZoom(delta: number): void {
  const active = session.value
  active.zoom = Math.max(MIN_ROW_W, Math.min(MAX_ROW_W, active.zoom + delta))
}

// ── the selected note ───────────────────────────────────────────────────────

const selectedNote = computed(() => song.value.channels[session.value.channel][session.value.selected] ?? null)

function editSelected(fields: Partial<{ pitch: number; row: number; instrument: number; volume: number }>): void {
  const active = session.value
  const note = selectedNote.value
  if (!note) return
  const next = { ...note, ...fields }
  commitSong(active, (one) => replaceNote(one, active.channel, active.selected, next))
  const notes = currentSong(active).channels[active.channel]
  active.selected = notes.findIndex((one) => one.row === Math.max(0, next.row) && one.pitch === next.pitch)
}

function deleteSelected(): void {
  const active = session.value
  if (active.selected < 0) return
  commitSong(active, (one) => removeNote(one, active.channel, active.selected))
  active.selected = -1
}

/** Picking an instrument sets what new notes get — and re-voices the selected note. */
function pickInstrument(index: number): void {
  const active = session.value
  active.instrument = index
  if (selectedNote.value && selectedNote.value.instrument !== index) editSelected({ instrument: index })
  previewNote(selectedNote.value?.pitch ?? 60, index)
}

// ── the bank ────────────────────────────────────────────────────────────────

function selectSong(index: number): void {
  const active = session.value
  if (active.playing) stop()
  active.song = index
  active.selected = -1
  active.startRow = 0
}

function addPresetInstrument(event: Event): void {
  const select = event.target as HTMLSelectElement
  const name = select.value
  select.value = ''
  if (!name) return
  const active = session.value
  const added = addInstrument(bank.value, instrumentPreset(name))
  commit(active, added.doc)
  active.instrument = added.index
  previewNote(60, added.index)
}

function applyBeatPreset(event: Event): void {
  const select = event.target as HTMLSelectElement
  const name = select.value
  select.value = ''
  if (!name) return
  const active = session.value
  commit(active, applyBeat(bank.value, active.song, active.channel, name))
  active.selected = -1
  active.status = `Channel ${CHANNEL_NAMES[active.channel]} now plays the "${name}" beat — Ctrl+Z to undo`
}

// ── sound effects ───────────────────────────────────────────────────────────

const sfxBanks = computed(() => resourcesStore.entries.filter((entry) => entry.kind === 'sfx').map((entry) => entry.path))

/**
 * Reads the attached effects bank. It is read again before each Play, so a
 * change made in the SFX editor — an effect, its priority, the bank's channel —
 * is heard without reopening anything.
 */
async function loadEffects(): Promise<void> {
  const active = session.value
  const path = bank.value.effects ?? ''
  active.effectsPath = path
  if (!path) {
    active.effects = []
    return
  }
  try {
    const parsed = parseResource(path, await window.api.invoke('fs:read', { path })) as { kind: 'sfx'; doc: SfxDoc }
    active.effects = parsed.doc.effects
    active.effectChannel = sfxChannel(parsed.doc)
  } catch (error) {
    active.effects = []
    active.status = `Couldn't read ${path}: ${String(error)}`
  }
}

/** Attaching a bank is part of the song bank: it decides whether the exported `_Update()` runs ayFX. */
function attachEffects(path: string): void {
  commit(session.value, { ...bank.value, effects: path || null })
  void loadEffects()
}

function fire(index: number): void {
  const active = session.value
  const effect = active.effects[index]
  if (!effect) return
  const refused = fireEffect(effect.frames, { rate: bank.value.rate, channel: active.effectChannel, priority: effectPriority(effect) })
  if (refused) active.status = `"${effect.name}" didn't play: a more important effect is sounding`
}

// ── project setup ───────────────────────────────────────────────────────────

const setup = ref<MusicSetup | null>(null)

async function refreshSetup(): Promise<void> {
  try {
    const config = await window.api.invoke('fs:read', { path: 'msxgl_config.h' })
    setup.value = musicSetup(config, projectStore.project?.libModules ?? [])
  } catch {
    setup.value = null
  }
}

const setupTitle = computed(() => {
  const pending = setup.value
  if (!pending) return ''
  const lines = [
    ...pending.modules.map((module) => `LibModules += "${module}"`),
    ...Object.entries(pending.defines).map(([name, value]) => `msxgl_config.h: ${name} ${value}`)
  ]
  return lines.length ? `Music with sound effects needs:\n${lines.join('\n')}` : 'This project is set up for music and sound effects'
})

async function applySetup(): Promise<void> {
  const active = session.value
  try {
    const config = await window.api.invoke('fs:read', { path: 'msxgl_config.h' })
    const pending = musicSetup(config, projectStore.project?.libModules ?? [])
    if (Object.keys(pending.defines).length) {
      await window.api.invoke('fs:write', { path: 'msxgl_config.h', content: patchConfigDefines(config, pending.defines) })
    }
    if (pending.modules.length) {
      projectStore.patch((project) => {
        project.libModules = [...project.libModules, ...pending.modules]
      })
      await projectStore.save()
    }
    const custom = projectStore.project?.customConfig
    active.status = custom
      ? `msxgl_config.h updated. This project writes its own project_config.js — add ${pending.modules.join(', ')} to LibModules there`
      : 'Project set up for music and sound effects'
    if (pending.missing.length) active.status += ` · msxgl_config.h has no ${pending.missing.join(', ')}`
  } catch (error) {
    active.status = `Set up failed: ${String(error)}`
  }
  await refreshSetup()
}

// ── file ────────────────────────────────────────────────────────────────────

async function save(): Promise<void> {
  try {
    await saveSession(session.value)
  } catch (error) {
    session.value.status = `Save failed: ${String(error)}`
  }
}

async function exportNow(): Promise<void> {
  await save()
  await resourcesStore.exportOne(session.value.path)
}

function setHelpers(helpers: boolean): void {
  const active = session.value
  const block = bank.value.export
  if (!block) return
  commit(active, { ...bank.value, export: { ...block, helpers } })
}

// ── keys ────────────────────────────────────────────────────────────────────

function onKeydown(event: KeyboardEvent): void {
  if (tabsStore.activeTab?.filePath !== session.value.path || isTypingTarget(event)) return
  const active = session.value
  if (event.ctrlKey || event.metaKey) {
    const key = event.key.toLowerCase()
    // Ctrl+S is EditorArea's, for every tab kind — see `commands.ts`.
    if (key === 'z' && !event.shiftKey) {
      event.preventDefault()
      undo(active)
    } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
      event.preventDefault()
      redo(active)
    }
    return
  }
  if (event.key === ' ') {
    event.preventDefault()
    toggle()
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault()
    deleteSelected()
  } else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && selectedNote.value) {
    event.preventDefault()
    const step = (event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 12 : 1)
    editSelected({ pitch: selectedNote.value.pitch + step })
    previewNote(selectedNote.value?.pitch ?? 60, active.instrument)
  } else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && selectedNote.value) {
    event.preventDefault()
    editSelected({ row: Math.max(0, selectedNote.value.row + (event.key === 'ArrowRight' ? 1 : -1)) })
  } else if (/^[1-9]$/.test(event.key)) {
    fire(Number(event.key) - 1)
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  void refreshSetup()
})

// The attached effects bank, once the bank has loaded and whenever another bank's tab comes up.
watch(
  () => [session.value, session.value.loading, bank.value.effects] as const,
  () => {
    if (!session.value.loading) void loadEffects()
  },
  { immediate: true }
)
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  stopMusic()
})

// Switching to another bank stops the music: a tab that isn't visible has no Stop button.
watch(session, (_, before) => {
  if (!before?.playing) return
  stopMusic()
  before.playing = false
  before.playhead = -1
})

watch(
  () => tabsStore.tabs.length,
  () => pruneMusicSessions(new Set(tabsStore.tabs.map((tab) => tab.filePath ?? ''))),
  { immediate: true }
)
</script>

<template>
  <div class="music-editor">
    <p
      v-if="session.error"
      class="error"
    >
      {{ session.error }}
    </p>
    <template v-else-if="!session.loading">
      <div class="toolbar">
        <button
          :title="session.playing ? 'Stop (Space)' : 'Play (Space) — from the ▼ on the ruler'"
          @click="toggle"
        >
          <Icon :name="session.playing ? 'stop' : 'play_arrow'" />
        </button>
        <button
          :class="{ active: session.loop }"
          title="Loop — go round from the loop bar, as the game does with g_Music_Play(song, TRUE)"
          @click="session.loop = !session.loop"
        >
          <Icon name="repeat" />
        </button>

        <span class="sep" />

        <span class="group">
          <button
            v-for="(name, index) in CHANNEL_NAMES"
            :key="name"
            class="channel"
            :class="{ active: session.channel === index }"
            :style="{ '--channel': CHANNEL_COLORS[index] }"
            :title="`Draw on channel ${name}`"
            @click="session.channel = index; session.selected = -1"
          >
            {{ name }}
          </button>
        </span>
        <span class="group">
          <button
            v-for="(name, index) in CHANNEL_NAMES"
            :key="name"
            class="mute"
            :class="{ active: session.muted[index] }"
            :title="`${session.muted[index] ? 'Unmute' : 'Mute'} channel ${name} (only while listening)`"
            @click="session.muted = session.muted.map((one, i) => (i === index ? !one : one)) as [boolean, boolean, boolean]"
          >
            <Icon
              :name="session.muted[index] ? 'volume_off' : 'volume_up'"
              :size="14"
            />
          </button>
        </span>

        <select
          :value="session.instrument"
          title="Instrument for new notes — also re-voices the selected note"
          @change="pickInstrument(Number(($event.target as HTMLSelectElement).value))"
        >
          <option
            v-for="(instrument, index) in bank.instruments"
            :key="index"
            :value="index"
          >
            {{ instrument.name }}
          </option>
        </select>
        <select
          :value="session.noteLength"
          title="Length a click draws — drag along the row for any other"
          @change="session.noteLength = Number(($event.target as HTMLSelectElement).value)"
        >
          <option
            v-for="length in LENGTHS"
            :key="length.rows"
            :value="length.rows"
          >
            {{ length.label }}
          </option>
        </select>
        <select
          value=""
          title="Fill the current channel with a ready-made drum beat"
          @change="applyBeatPreset"
        >
          <option value="">
            Beat…
          </option>
          <option
            v-for="beat in BEAT_PRESETS"
            :key="beat.name"
            :value="beat.name"
          >
            {{ beat.name }}
          </option>
        </select>

        <span class="sep" />

        <button
          :disabled="!canUndo(session)"
          title="Undo (Ctrl+Z)"
          @click="undo(session)"
        >
          <Icon name="undo" />
        </button>
        <button
          :disabled="!canRedo(session)"
          title="Redo (Ctrl+Y)"
          @click="redo(session)"
        >
          <Icon name="redo" />
        </button>

        <span
          class="status message"
          :title="session.status"
        >{{ session.status }}</span>
        <span
          v-if="size"
          class="status"
          :title="`The whole bank exports to ${totalBytes} bytes`"
        >{{ size.bytes }} B · {{ size.seconds.toFixed(1) }} s</span>
        <button
          v-if="setup"
          :class="{ done: musicSetupDone(setup) }"
          :disabled="musicSetupDone(setup)"
          :title="setupTitle"
          @click="applySetup"
        >
          {{ musicSetupDone(setup) ? 'Project set up' : 'Set up project' }}
        </button>
        <button
          :disabled="!session.dirty"
          title="Save (Ctrl+S)"
          @click="save"
        >
          Save
        </button>
        <button
          title="Write the songs to the project's content folder"
          @click="exportNow"
        >
          Export
        </button>
      </div>

      <div class="body">
        <aside class="side">
          <h3>Songs</h3>
          <ul>
            <li
              v-for="(one, index) in bank.songs"
              :key="index"
              class="row"
              :class="{ active: index === session.song }"
              @click="selectSong(index)"
            >
              <input
                class="name"
                :value="one.name"
                @change="commit(session, renameSong(bank, index, ($event.target as HTMLInputElement).value))"
              >
              <button
                class="small"
                :title="`Play ${one.name} once as a jingle: the song playing stops where it is and carries on after it, as g_Music_PlayJingle() does`"
                @click.stop="jingle(index)"
              >
                <Icon
                  name="celebration"
                  :size="12"
                />
              </button>
            </li>
          </ul>
          <div class="list-actions">
            <button
              title="New empty song"
              @click="commit(session, addSong(bank)); selectSong(bank.songs.length - 1)"
            >
              +
            </button>
            <button
              title="Duplicate"
              @click="commit(session, duplicateSong(bank, session.song)); selectSong(session.song + 1)"
            >
              <Icon
                name="content_copy"
                :size="14"
              />
            </button>
            <button
              title="Delete"
              :disabled="bank.songs.length <= 1"
              @click="commit(session, deleteSong(bank, session.song)); selectSong(Math.max(0, session.song - 1))"
            >
              <Icon
                name="delete"
                :size="14"
              />
            </button>
          </div>

          <div class="fields">
            <label>
              Bars
              <input
                type="number"
                min="1"
                :max="MAX_BARS"
                :value="song.bars"
                @change="commitSong(session, (one) => setBars(one, Number(($event.target as HTMLInputElement).value)))"
              >
            </label>
            <label :title="`${tempoBpm(bank.rate, song.speed).toFixed(0)} BPM — frames per 16th note`">
              Speed
              <input
                type="number"
                min="1"
                :max="MAX_SPEED"
                :value="song.speed"
                @change="commitSong(session, (one) => setSpeed(one, Number(($event.target as HTMLInputElement).value)))"
              >
              <span class="unit">{{ tempoBpm(bank.rate, song.speed).toFixed(0) }} bpm</span>
            </label>
            <label title="The bar a looping song goes back to: bars before it are an intro">
              Loop bar
              <input
                type="number"
                min="1"
                :max="song.bars"
                :value="song.loopBar + 1"
                @change="commitSong(session, (one) => setLoopBar(one, Number(($event.target as HTMLInputElement).value) - 1))"
              >
            </label>
            <label title="How often the game calls g_Music_Decode(): 50 Hz Europe, 60 Hz Japan">
              Rate
              <select
                :value="bank.rate"
                @change="commit(session, { ...bank, rate: Number(($event.target as HTMLSelectElement).value) === 60 ? 60 : 50 })"
              >
                <option :value="50">50 Hz</option>
                <option :value="60">60 Hz</option>
              </select>
            </label>
          </div>

          <template v-if="selectedNote">
            <h3>Note</h3>
            <div class="fields">
              <span class="note-name">{{ noteName(selectedNote.pitch) }} · {{ bank.instruments[selectedNote.instrument]?.name }}</span>
              <label title="Quieter notes for echoes and accents">
                Volume
                <input
                  type="number"
                  min="0"
                  max="15"
                  :value="selectedNote.volume"
                  @change="editSelected({ volume: Number(($event.target as HTMLInputElement).value) })"
                >
              </label>
            </div>
          </template>

          <h3>Instruments</h3>
          <ul>
            <li
              v-for="(instrument, index) in bank.instruments"
              :key="index"
              class="row"
              :class="{ active: index === session.instrument }"
              @click="pickInstrument(index)"
            >
              <input
                class="name"
                :value="instrument.name"
                @change="commit(session, renameInstrument(bank, index, ($event.target as HTMLInputElement).value))"
              >
              <button
                class="small"
                :disabled="instrumentInUse(bank, index) || bank.instruments.length <= 1"
                :title="instrumentInUse(bank, index) ? 'In use — notes play it' : 'Delete'"
                @click.stop="commit(session, deleteInstrument(bank, index))"
              >
                <Icon
                  name="close"
                  :size="12"
                />
              </button>
            </li>
          </ul>
          <select
            class="wide"
            value=""
            title="Add another copy of a ready-made instrument"
            @change="addPresetInstrument"
          >
            <option value="">
              Add instrument…
            </option>
            <option
              v-for="preset in INSTRUMENT_PRESETS"
              :key="preset.name"
              :value="preset.name"
            >
              {{ preset.name }}
            </option>
          </select>

          <h3>Sound effects</h3>
          <select
            class="wide"
            :value="bank.effects ?? ''"
            title="The effects the game plays over this music: keys 1–9 fire them here, and the exported _Update() runs them"
            @change="attachEffects(($event.target as HTMLSelectElement).value)"
          >
            <option value="">
              (none)
            </option>
            <option
              v-for="one in sfxBanks"
              :key="one"
              :value="one"
            >
              {{ one }}
            </option>
          </select>
          <template v-if="session.effects.length">
            <p class="hint">
              On channel {{ CHANNEL_NAMES[session.effectChannel] }} — set in the effects bank, with each effect's
              priority.
            </p>
            <div class="chips">
              <button
                v-for="(effect, index) in session.effects.slice(0, 9)"
                :key="index"
                :title="`Key ${index + 1} · priority ${effectPriority(effect)}`"
                @click="fire(index)"
              >
                {{ index + 1 }} {{ effect.name }}
              </button>
            </div>
          </template>

          <h3>Export</h3>
          <label
            v-if="bank.export"
            class="inline"
          >
            <input
              type="checkbox"
              :checked="bank.export.helpers === true"
              @change="setHelpers(($event.target as HTMLInputElement).checked)"
            >
            <span>Export ready-made C</span>
          </label>
          <p
            v-for="problem in problems"
            :key="problem"
            class="problem"
          >
            {{ problem }}
          </p>
        </aside>

        <PianoRoll
          :song="song"
          :instruments="bank.instruments"
          :channel="session.channel"
          :selected="session.selected"
          :muted="session.muted"
          :zoom="session.zoom"
          :playhead="session.playhead"
          :start-row="session.startRow"
          @press="onPress"
          @drag="onDrag"
          @release="onRelease"
          @ruler="onRuler"
          @key="(pitch) => previewNote(pitch, session.instrument)"
          @zoom="onZoom"
        />
      </div>

      <p class="legend">
        Click or drag to draw on channel {{ CHANNEL_NAMES[session.channel] }} · drag a note to move it, its end to
        resize · right-click or right-drag to delete · ↑↓ transpose (Shift: octave) · Ctrl+wheel zoom. Each channel
        plays one note at a time.
      </p>
    </template>
  </div>
</template>

<style scoped>
.music-editor {
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
.side select,
.side input[type='number'],
.side button,
.chips button {
  background: var(--color-bg-tab-inactive);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  padding: 3px 8px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

button:disabled {
  opacity: 0.4;
  cursor: default;
}

.toolbar button:not(:disabled):hover,
.side button:not(:disabled):hover {
  background: var(--color-bg-hover);
}

.toolbar button.active {
  border-color: var(--color-accent);
  background: var(--color-bg-active-item);
}

.toolbar button.done {
  opacity: 0.6;
}

.group {
  display: inline-flex;
  gap: 2px;
}

.channel {
  min-width: 28px;
  font-weight: 600;
  border-bottom: 3px solid var(--channel) !important;
}

.channel.active {
  background: var(--channel) !important;
  color: #1e1e1e !important;
}

.mute {
  display: flex;
  align-items: center;
  padding: 3px 5px !important;
}

.sep {
  width: 1px;
  height: 18px;
  background: var(--color-border);
}

.status {
  font-size: 11px;
  color: var(--color-text-muted);
}

/* The message takes the space that is left and truncates, so a long one
   never wraps the toolbar onto a second line. */
.message {
  flex: 1;
  min-width: 0;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.body {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.side {
  display: flex;
  flex-direction: column;
  width: 220px;
  flex-shrink: 0;
  border-right: 1px solid var(--color-border);
  padding: 8px;
  overflow-y: auto;
  gap: 4px;
}

h3 {
  margin: 10px 0 2px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
}

h3:first-child {
  margin-top: 0;
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
  gap: 4px;
  padding: 1px 4px;
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

.small {
  display: flex;
  padding: 1px !important;
  border: none !important;
  background: transparent !important;
}

.list-actions {
  display: flex;
  gap: 4px;
}

.list-actions button {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  padding: 2px !important;
}

.fields {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 6px;
}

.fields label,
.inline {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--color-text-muted);
}

.fields input {
  width: 52px;
  cursor: text;
  margin-left: auto;
}

.fields select {
  margin-left: auto;
}

.unit {
  font-size: 11px;
  min-width: 52px;
}

.note-name {
  font-size: 12px;
}

.wide {
  width: 100%;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.chips button {
  padding: 2px 6px;
  font-size: 11px;
}

.hint {
  margin: 2px 0;
  font-size: 11px;
  line-height: 1.4;
  color: var(--color-text-muted);
}

.problem {
  margin: 4px 0 0;
  font-size: 11px;
  color: #f48771;
}

.legend {
  margin: 0;
  padding: 6px 10px;
  border-top: 1px solid var(--color-border);
  font-size: 11px;
  line-height: 1.4;
  color: var(--color-text-muted);
}
</style>
