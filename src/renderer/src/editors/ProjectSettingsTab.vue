<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  COMPILE_COMPLEXITY,
  CURATED_TARGETS,
  CUSTOM_ISR,
  INSTALL_RAM_ISR,
  isMappedRomTarget,
  JOYSTICK_DEVICES,
  MSX_MACHINES,
  MSX_TARGETS,
  OPTIM_LEVELS
} from '../../../shared/msxgl-consts'
import type { RawFileEntry } from '../../../shared/msxproj'
import { useProjectStore } from '../stores/projectStore'
import { useResourcesStore } from '../stores/resourcesStore'
import { useTabsStore } from '../stores/tabsStore'

const projectStore = useProjectStore()
const resourcesStore = useResourcesStore()
const tabsStore = useTabsStore()

const project = computed(() => projectStore.project)
const showAllTargets = ref(false)
const saving = ref(false)

const targets = computed(() =>
  showAllTargets.value
    ? MSX_TARGETS
    : MSX_TARGETS.filter((entry) => (CURATED_TARGETS as string[]).includes(entry.value))
)

const mapped = computed(() => (project.value ? isMappedRomTarget(project.value.target) : false))
const readOnly = computed(() => project.value?.customConfig === true)

/** ProjModules is a plain array in the model; edited here as a comma-separated list. */
const projModulesText = computed({
  get: () => project.value?.projModules.join(', ') ?? '',
  set: (value: string) =>
    projectStore.patch((p) => {
      p.projModules = value.split(',').map((s) => s.trim()).filter(Boolean)
    })
})

const defines = computed(() => Object.entries(project.value?.build.defines ?? {}))

onMounted(() => {
  void projectStore.loadLibModules()
  void resourcesStore.refresh()
})

/** imgRule args are stored as an array; edited here as one raw command-line string. */
function setRuleArgs(index: number, value: string): void {
  projectStore.patch((p) => {
    p.resources.imgRules[index].args = value.split(/\s+/).filter(Boolean)
  })
}

function openMsximgHelp(): void {
  if (resourcesStore.msximgHelp) void window.api.invoke('shell:open', { target: resourcesStore.msximgHelp })
}
// One listener on the form: input/change both bubble, so every field dirties the project.
function markDirty(): void {
  if (!readOnly.value) projectStore.dirty = true
}

// Mirror the dirty flag onto this editor's tab so the strip shows the usual dot.
watch(
  () => projectStore.dirty,
  (dirty) => {
    const file = projectStore.open?.projectFile
    if (file) tabsStore.setDirty(file, dirty)
  }
)

/** Handing generation back to the IDE overwrites a hand-written config — confirm first. */
function setCustomConfig(input: HTMLInputElement): void {
  if (
    !input.checked &&
    !window.confirm('MSXStudio will overwrite project_config.js from these settings on the next save. Continue?')
  ) {
    input.checked = true // the reactive value never changed, so Vue won't re-render this back
    return
  }
  projectStore.patch((p) => (p.customConfig = input.checked))
}

function toggleModule(module: string): void {
  projectStore.patch((p) => {
    const index = p.libModules.indexOf(module)
    if (index === -1) p.libModules.push(module)
    else p.libModules.splice(index, 1)
  })
}

function rawPlacement(entry: RawFileEntry): 'offset' | 'page' | 'segment' {
  if (entry.page !== undefined) return 'page'
  if (entry.segment !== undefined) return 'segment'
  return 'offset'
}

function setRawPlacement(entry: RawFileEntry, kind: 'offset' | 'page' | 'segment'): void {
  projectStore.patch(() => {
    const value = entry.offset ?? entry.page ?? entry.segment ?? 0
    delete entry.offset
    delete entry.page
    delete entry.segment
    entry[kind] = value
  })
}

function setRawValue(entry: RawFileEntry, value: string): void {
  projectStore.patch(() => {
    entry[rawPlacement(entry)] = Number(value) || 0
  })
}

async function save(): Promise<void> {
  saving.value = true
  try {
    await projectStore.save()
  } catch (error) {
    window.alert(`Couldn't save the project: ${String(error)}`)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div
    v-if="project"
    class="settings"
    @input="markDirty"
    @change="markDirty"
  >
    <header>
      <h2>Project Settings</h2>
      <button
        type="button"
        class="primary"
        :disabled="!projectStore.dirty || saving"
        @click="save"
      >
        {{ projectStore.dirty ? 'Save' : 'Saved' }}
      </button>
    </header>

    <p
      v-if="readOnly"
      class="banner"
    >
      This project sets <code>customConfig: true</code> — MSXStudio never writes its
      <code>project_config.js</code>. Settings below are read-only.
      <button
        type="button"
        class="link"
        @click="tabsStore.openFile('project_config.js', 'project_config.js')"
      >
        Open project_config.js
      </button>
    </p>

    <fieldset :disabled="readOnly">
      <section>
        <h3>Project</h3>
        <label>
          <span>Name</span>
          <input
            v-model="project.name"
            type="text"
            spellcheck="false"
          >
        </label>
        <label>
          <span>Source modules (comma-separated, without <code>.c</code>)</span>
          <input
            v-model="projModulesText"
            type="text"
            spellcheck="false"
          >
        </label>
      </section>

      <section>
        <h3>Target</h3>
        <label>
          <span>Machine</span>
          <select v-model="project.machine">
            <option
              v-for="entry in MSX_MACHINES"
              :key="entry.value"
              :value="entry.value"
            >{{ entry.label }}</option>
          </select>
        </label>
        <label>
          <span>Target</span>
          <select v-model="project.target">
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
            @change.stop
          >
          <span>Show all targets</span>
        </label>
        <label v-if="mapped">
          <span>ROM size (KB)</span>
          <input
            v-model.number="project.romSize"
            type="number"
            min="64"
            step="8"
          >
        </label>
      </section>

      <section>
        <h3>ROM / startup</h3>
        <label class="inline"><input
          v-model="project.rom.checkVersion"
          type="checkbox"
        ><span>Check MSX version at startup</span></label>
        <label class="inline"><input
          v-model="project.rom.delayBoot"
          type="checkbox"
        ><span>Delay ROM boot (let disk/network ROMs init)</span></label>
        <label class="inline"><input
          v-model="project.rom.signature"
          type="checkbox"
        ><span>Add ROM signature</span></label>
        <label class="inline"><input
          v-model="project.rom.bankedCall"
          type="checkbox"
        ><span>Automatic banked calls (mapped ROM)</span></label>
        <label>
          <span>ISR in RAM</span>
          <select v-model="project.rom.installRamIsr">
            <option
              v-for="value in INSTALL_RAM_ISR"
              :key="value"
              :value="value"
            >{{ value }}</option>
          </select>
        </label>
        <label>
          <span>Custom ISR</span>
          <select v-model="project.rom.customIsr">
            <option
              v-for="value in CUSTOM_ISR"
              :key="value"
              :value="value"
            >{{ value }}</option>
          </select>
        </label>
      </section>

      <section>
        <h3>Build</h3>
        <label>
          <span>Optimization</span>
          <select v-model="project.build.optim">
            <option
              v-for="value in OPTIM_LEVELS"
              :key="value"
              :value="value"
            >{{ value }}</option>
          </select>
        </label>
        <label>
          <span>Compile complexity</span>
          <select v-model="project.build.compileComplexity">
            <option
              v-for="value in COMPILE_COMPLEXITY"
              :key="value"
              :value="value"
            >{{ value }}</option>
          </select>
        </label>
        <label class="inline"><input
          v-model="project.build.debug"
          type="checkbox"
        ><span>Debug build</span></label>
        <label class="inline"><input
          v-model="project.build.allowUndocumented"
          type="checkbox"
        ><span>Allow undocumented Z80 instructions</span></label>

        <span class="rows-title">Preprocessor defines (passed as <code>define=</code> build args)</span>
        <div
          v-for="([key, value], index) in defines"
          :key="index"
          class="row"
        >
          <input
            type="text"
            :value="key"
            placeholder="NAME"
            @change="projectStore.patch((p) => { const v = p.build.defines[key]; delete p.build.defines[key]; p.build.defines[($event.target as HTMLInputElement).value] = v })"
          >
          <input
            type="text"
            :value="value"
            placeholder="value (optional)"
            @input="projectStore.patch((p) => { p.build.defines[key] = ($event.target as HTMLInputElement).value })"
          >
          <button
            type="button"
            @click="projectStore.patch((p) => delete p.build.defines[key])"
          >
            ×
          </button>
        </div>
        <button
          type="button"
          class="add"
          @click="projectStore.patch((p) => { p.build.defines[`DEFINE_${defines.length + 1}`] = '' })"
        >
          Add define
        </button>
      </section>

      <section>
        <h3>Library modules</h3>
        <div class="module-list">
          <label
            v-for="module in projectStore.libModules"
            :key="module"
            class="inline"
          >
            <input
              type="checkbox"
              :checked="project.libModules.includes(module)"
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
      </section>

      <section>
        <h3>Files</h3>
        <span class="rows-title">Raw files injected into the binary</span>
        <div
          v-for="(entry, index) in project.files.rawFiles"
          :key="index"
          class="row"
        >
          <select
            :value="rawPlacement(entry)"
            @change="setRawPlacement(entry, ($event.target as HTMLSelectElement).value as 'offset' | 'page' | 'segment')"
          >
            <option value="offset">
              offset
            </option>
            <option value="page">
              page
            </option>
            <option value="segment">
              segment
            </option>
          </select>
          <input
            type="number"
            :value="entry.offset ?? entry.page ?? entry.segment ?? 0"
            @input="setRawValue(entry, ($event.target as HTMLInputElement).value)"
          >
          <input
            v-model="entry.file"
            type="text"
            placeholder="data/tiles.bin"
          >
          <button
            type="button"
            @click="projectStore.patch((p) => p.files.rawFiles.splice(index, 1))"
          >
            ×
          </button>
        </div>
        <button
          type="button"
          class="add"
          @click="projectStore.patch((p) => p.files.rawFiles.push({ offset: 0, file: '' }))"
        >
          Add raw file
        </button>

        <span class="rows-title">Files copied to the disk image</span>
        <div
          v-for="(_, index) in project.files.diskFiles"
          :key="index"
          class="row"
        >
          <input
            v-model="project.files.diskFiles[index]"
            type="text"
            placeholder="data/level1.dat"
          >
          <button
            type="button"
            @click="projectStore.patch((p) => p.files.diskFiles.splice(index, 1))"
          >
            ×
          </button>
        </div>
        <button
          type="button"
          class="add"
          @click="projectStore.patch((p) => p.files.diskFiles.push(''))"
        >
          Add disk file
        </button>

        <label>
          <span>Disk size</span>
          <select v-model="project.files.diskSize">
            <option value="360K">360K</option>
            <option value="720K">720K</option>
          </select>
        </label>
      </section>

      <section>
        <h3>Image rules (MSXimg)</h3>
        <p class="hint">
          Converted with MSXgl's bundled MSXimg before every build, skipping outputs that are
          already newer than their input.
          <button
            v-if="resourcesStore.msximgHelp"
            type="button"
            class="link"
            @click="openMsximgHelp"
          >
            MSXimg CLI help
          </button>
        </p>
        <div
          v-for="(rule, index) in project.resources.imgRules"
          :key="index"
          class="row"
        >
          <input
            v-model="rule.input"
            type="text"
            placeholder="assets/title.png"
            spellcheck="false"
          >
          <input
            v-model="rule.out"
            type="text"
            placeholder="content/title.h"
            spellcheck="false"
          >
          <input
            type="text"
            :value="rule.args.join(' ')"
            placeholder="-mode bmp -bpc 4 -pal custom -name g_Title"
            spellcheck="false"
            @change="setRuleArgs(index, ($event.target as HTMLInputElement).value)"
          >
          <button
            type="button"
            @click="projectStore.patch((p) => p.resources.imgRules.splice(index, 1))"
          >
            ×
          </button>
        </div>
        <button
          type="button"
          class="add"
          @click="projectStore.patch((p) => p.resources.imgRules.push({ input: '', out: '', args: [] }))"
        >
          Add image rule
        </button>
      </section>

      <section>
        <h3>Emulator</h3>
        <label>
          <span>Preferred</span>
          <select v-model="project.emulator.preferred">
            <option value="openmsx">openMSX</option>
            <option value="webmsx">WebMSX</option>
          </select>
        </label>
        <label>
          <span>openMSX machine override (empty = C-BIOS default)</span>
          <input
            :value="project.emulator.openmsxMachine ?? ''"
            type="text"
            placeholder="e.g. Philips_NMS_8250"
            spellcheck="false"
            @input="projectStore.patch((p) => { p.emulator.openmsxMachine = ($event.target as HTMLInputElement).value.trim() || null })"
          >
        </label>
        <label class="inline"><input
          v-model="project.emulator.hz60"
          type="checkbox"
        ><span>60 Hz (NTSC)</span></label>
        <label class="inline"><input
          v-model="project.emulator.fullscreen"
          type="checkbox"
        ><span>Fullscreen</span></label>
        <label class="inline"><input
          v-model="project.emulator.mute"
          type="checkbox"
        ><span>Mute</span></label>

        <span class="rows-title">Extensions</span>
        <div class="module-list">
          <label class="inline"><input
            v-model="project.emulator.ext.scc"
            type="checkbox"
          ><span>SCC</span></label>
          <label class="inline"><input
            v-model="project.emulator.ext.msxMusic"
            type="checkbox"
          ><span>MSX-Music</span></label>
          <label class="inline"><input
            v-model="project.emulator.ext.msxAudio"
            type="checkbox"
          ><span>MSX-Audio</span></label>
          <label class="inline"><input
            v-model="project.emulator.ext.opl4"
            type="checkbox"
          ><span>OPL4</span></label>
          <label class="inline"><input
            v-model="project.emulator.ext.psg2"
            type="checkbox"
          ><span>2nd PSG</span></label>
          <label class="inline"><input
            v-model="project.emulator.ext.v9990"
            type="checkbox"
          ><span>V9990</span></label>
          <label class="inline"><input
            v-model="project.emulator.ext.ram"
            type="checkbox"
          ><span>RAM mapper</span></label>
          <label class="inline"><input
            v-model="project.emulator.ext.pac"
            type="checkbox"
          ><span>PAC</span></label>
        </div>

        <label>
          <span>Joystick port A</span>
          <select v-model="project.emulator.portA">
            <option
              v-for="value in JOYSTICK_DEVICES"
              :key="value"
              :value="value"
            >{{ value || '(none)' }}</option>
          </select>
        </label>
        <label>
          <span>Joystick port B</span>
          <select v-model="project.emulator.portB">
            <option
              v-for="value in JOYSTICK_DEVICES"
              :key="value"
              :value="value"
            >{{ value || '(none)' }}</option>
          </select>
        </label>
      </section>
    </fieldset>

    <section>
      <h3>Advanced</h3>
      <label class="inline">
        <input
          type="checkbox"
          :checked="project.customConfig"
          @change.stop="setCustomConfig($event.target as HTMLInputElement)"
        >
        <span>Hand-edit <code>project_config.js</code> (MSXStudio stops generating it)</span>
      </label>
    </section>
  </div>
  <div
    v-else
    class="empty"
  >
    No project is open.
  </div>
</template>

<style scoped>
.settings {
  padding: 20px 24px 40px;
  max-width: 720px;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

h3 {
  margin: 0 0 8px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-text-muted);
}

fieldset {
  border: none;
  padding: 0;
  margin: 0;
  min-width: 0;
}

fieldset:disabled {
  opacity: 0.6;
}

section {
  margin-bottom: 24px;
}

label {
  display: block;
  margin-bottom: 8px;
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
  color: var(--color-text);
}

input[type='text'],
input[type='number'],
select {
  padding: 4px 6px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-tab-inactive);
  color: var(--color-text);
  font-size: 12px;
  width: 100%;
  max-width: 360px;
}

.row {
  display: flex;
  gap: 6px;
  margin-bottom: 4px;
  align-items: center;
}

.row input[type='text'] {
  flex: 1;
}

.row input[type='number'],
.row select {
  width: 110px;
  flex: none;
}

.row button {
  padding: 2px 8px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-hover);
}

.rows-title {
  display: block;
  margin: 12px 0 4px;
  font-size: 12px;
  color: var(--color-text-muted);
}

.add {
  margin-bottom: 8px;
  padding: 3px 10px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-hover);
  font-size: 11px;
}

.module-list {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 2px 8px;
  max-height: 220px;
  overflow-y: auto;
  padding: 6px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  font-size: 11px;
}

.banner {
  padding: 8px 12px;
  margin-bottom: 16px;
  border: 1px solid var(--color-accent);
  border-radius: 4px;
  background: var(--color-bg-hover);
  font-size: 12px;
  line-height: 1.6;
}

.link {
  color: var(--color-accent);
  text-decoration: underline;
}

.primary {
  padding: 5px 14px;
  border: 1px solid var(--color-accent);
  border-radius: 4px;
  background: var(--color-accent);
  color: #ffffff;
  font-size: 12px;
}

.primary:disabled {
  opacity: 0.5;
  cursor: default;
}

.hint,
.empty {
  color: var(--color-text-muted);
  font-size: 12px;
}

.empty {
  padding: 24px;
}
</style>
