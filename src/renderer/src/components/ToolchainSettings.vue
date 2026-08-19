<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useToolchainStore } from '../stores/toolchainStore'

const store = useToolchainStore()

const msxglPathInput = ref('')
const openmsxPathInput = ref('')
const nodePathInput = ref('')

watch(
  () => store.status,
  (status) => {
    if (!status) return
    msxglPathInput.value = status.msxgl.path ?? ''
    openmsxPathInput.value = status.openmsx.path ?? ''
  },
  { immediate: true }
)

onMounted(() => {
  if (!store.status) void store.loadStatus()
})

const canUpdate = computed(() => store.status?.msxgl.valid === true && store.status.msxgl.isGitRepo)

const guidanceText = computed(() => {
  const platform = store.status?.platform
  if (platform === 'win32') return 'Download an installer from openmsx.org.'
  if (platform === 'linux') {
    return "Install via your distro's package manager, e.g. `apt install openmsx` (Debian/Ubuntu), `dnf install openMSX` (Fedora), or `pacman -S openmsx` (Arch)."
  }
  return 'See openmsx.org for installation instructions.'
})

function onMsxglPathChange(): void {
  void store.setPaths({ msxglPath: msxglPathInput.value.trim() || null })
}

function onOpenmsxPathChange(): void {
  void store.setPaths({ openmsxPath: openmsxPathInput.value.trim() || null })
}

function onNodePathChange(): void {
  void store.setPaths({ nodePath: nodePathInput.value.trim() || null })
}

async function browseMsxglFolder(): Promise<void> {
  const path = await store.pickFolder()
  if (path) await store.setPaths({ msxglPath: path })
}

async function browseOpenmsxFile(): Promise<void> {
  const path = await store.pickFile()
  if (path) await store.setPaths({ openmsxPath: path })
}

async function browseNodeFile(): Promise<void> {
  const path = await store.pickFile()
  if (path) await store.setPaths({ nodePath: path })
}

function download(): void {
  void store.downloadMsxgl()
}

async function downloadTo(): Promise<void> {
  const dir = await store.pickFolder()
  if (dir) await store.downloadMsxgl(dir)
}

function update(): void {
  void store.updateMsxgl()
}
</script>

<template>
  <div class="toolchain-settings">
    <h2>Toolchain</h2>

    <section>
      <h3>MSXgl</h3>
      <div class="path-row">
        <input
          v-model="msxglPathInput"
          type="text"
          placeholder="Path to an MSXgl checkout"
          @change="onMsxglPathChange"
        >
        <button
          type="button"
          @click="browseMsxglFolder"
        >
          Browse…
        </button>
      </div>

      <p
        v-if="store.status"
        class="status"
        :class="store.status.msxgl.valid ? 'ok' : 'bad'"
      >
        <template v-if="store.status.msxgl.valid">
          ✓ {{ store.status.msxgl.isGitRepo ? 'git checkout' : 'zip install' }} ·
          {{ store.status.msxgl.version ?? 'unknown version' }}
        </template>
        <template v-else-if="store.status.msxgl.path">
          ✗ Missing: {{ store.status.msxgl.missing.join(', ') }}
        </template>
        <template v-else>
          ✗ Not configured
        </template>
      </p>
      <p
        v-else
        class="status"
      >
        Checking…
      </p>

      <div class="actions">
        <button
          type="button"
          :disabled="store.busy"
          @click="download"
        >
          Download MSXgl
        </button>
        <button
          type="button"
          class="link"
          :disabled="store.busy"
          @click="downloadTo"
        >
          Choose location…
        </button>
        <button
          type="button"
          :disabled="store.busy || !canUpdate"
          @click="update"
        >
          Update MSXgl
        </button>
      </div>
    </section>

    <section
      v-if="store.busy"
      class="progress"
    >
      <p>{{ store.progress?.message ?? 'Working…' }}</p>
      <div class="bar">
        <div
          class="fill"
          :class="{ indeterminate: store.progress?.percent == null }"
          :style="store.progress?.percent != null ? { width: `${store.progress.percent}%` } : {}"
        />
      </div>
    </section>

    <section>
      <h3>openMSX</h3>
      <div class="path-row">
        <input
          v-model="openmsxPathInput"
          type="text"
          placeholder="Path to the openmsx executable"
          @change="onOpenmsxPathChange"
        >
        <button
          type="button"
          @click="browseOpenmsxFile"
        >
          Browse…
        </button>
      </div>

      <p
        v-if="store.status"
        class="status"
        :class="store.status.openmsx.valid ? 'ok' : 'bad'"
      >
        <template v-if="store.status.openmsx.valid">
          ✓ openMSX{{ store.status.openmsx.version ? ` ${store.status.openmsx.version}` : '' }}
        </template>
        <template v-else>
          ✗ Not found
        </template>
      </p>
      <p
        v-else
        class="status"
      >
        Checking…
      </p>

      <p
        v-if="store.status && !store.status.openmsx.valid"
        class="guidance"
      >
        {{ guidanceText }} WebMSX (browser-based, zero-install) is offered as an alternative when you run a
        project.
      </p>
    </section>

    <section>
      <h3>Advanced</h3>
      <div class="path-row">
        <input
          v-model="nodePathInput"
          type="text"
          placeholder="Node override (optional — defaults to MSXgl's bundled Node)"
          @change="onNodePathChange"
        >
        <button
          type="button"
          @click="browseNodeFile"
        >
          Browse…
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.toolchain-settings {
  padding: 12px;
}

h2 {
  margin: 0 0 16px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-text-muted);
}

section {
  margin-bottom: 20px;
}

h3 {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
}

.path-row {
  display: flex;
  gap: 6px;
  margin-bottom: 6px;
}

.path-row input {
  flex: 1;
  min-width: 0;
  padding: 4px 6px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-editor);
  color: var(--color-text);
  font-size: 12px;
}

.path-row button {
  padding: 4px 8px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-hover);
  font-size: 12px;
  white-space: nowrap;
}

.status {
  margin: 0 0 8px;
  font-size: 12px;
}

.status.ok {
  color: #4caf50;
}

.status.bad {
  color: #e06c75;
}

.guidance {
  margin: 0;
  font-size: 11px;
  color: var(--color-text-muted);
  line-height: 1.5;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.actions button {
  padding: 4px 8px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-hover);
  font-size: 12px;
}

.actions button:disabled {
  opacity: 0.5;
  cursor: default;
}

.actions button.link {
  border-color: transparent;
  background: transparent;
  color: var(--color-accent);
}

.progress p {
  margin: 0 0 6px;
  font-size: 11px;
  color: var(--color-text-muted);
}

.bar {
  height: 6px;
  border-radius: 3px;
  background: var(--color-bg-hover);
  overflow: hidden;
}

.fill {
  height: 100%;
  background: var(--color-accent);
  transition: width 0.2s ease;
}

.fill.indeterminate {
  width: 40%;
  animation: indeterminate 1.2s ease-in-out infinite;
}

@keyframes indeterminate {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(250%);
  }
}
</style>
