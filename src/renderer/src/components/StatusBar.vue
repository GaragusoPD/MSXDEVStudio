<script setup lang="ts">
import Icon from './Icon.vue'
import { computed } from 'vue'
import { useAppStore } from '../stores/appStore'
import { useBuildStore } from '../stores/buildStore'
import { useGitStore } from '../stores/gitStore'
import { useProblemsStore } from '../stores/problemsStore'
import { useProjectStore } from '../stores/projectStore'
import { useTabsStore } from '../stores/tabsStore'
import { MSX_MACHINES } from '../../../shared/msxgl-consts'

const appStore = useAppStore()
const buildStore = useBuildStore()
const gitStore = useGitStore()
const problemsStore = useProblemsStore()
const projectStore = useProjectStore()
const tabsStore = useTabsStore()

const projectLabel = computed(() =>
  projectStore.currentProjectPath ? projectStore.currentProjectPath : 'No Project Opened'
)

/** `<machine> · <target>`, the two settings that decide what the binary is. */
const targetLabel = computed(() => {
  const project = projectStore.project
  if (!project) return null
  const machine = MSX_MACHINES.find((m) => m.value === project.machine)?.label ?? project.machine
  return `${machine} · ${project.target}`
})

const errorCount = computed(() => problemsStore.problems.filter((p) => p.severity === 'error').length)
const warningCount = computed(() => problemsStore.problems.filter((p) => p.severity === 'warning').length)

/** The `.msxproj` is registered as an editor type, so opening the file *is* the settings UI. */
function openProjectSettings(): void {
  const file = projectStore.open?.projectFile
  if (file) tabsStore.openFile(file, file)
}

function toggleTheme(): void {
  appStore.setTheme(appStore.theme === 'dark' ? 'light' : 'dark')
}
</script>

<template>
  <footer class="status-bar">
    <div class="side left">
      <span class="item">{{ projectLabel }}</span>
      <template v-if="gitStore.status.isRepo">
        <button
          type="button"
          class="item button"
          title="Switch or create a branch"
          @click="gitStore.branchPickerOpen = true"
        >
          ⎇ {{ gitStore.branchLabel }}
        </button>
        <button
          v-if="!gitStore.status.upstream"
          type="button"
          class="item button"
          title="Publish this branch"
          @click="gitStore.push()"
        >
          Publish
        </button>
        <template v-else>
          <button
            type="button"
            class="item button"
            title="Pull"
            @click="gitStore.pull()"
          >
            <Icon
              name="arrow_downward"
              :size="13"
            />{{ gitStore.status.behind }}
          </button>
          <button
            type="button"
            class="item button"
            title="Push"
            @click="gitStore.push()"
          >
            <Icon
              name="arrow_upward"
              :size="13"
            />{{ gitStore.status.ahead }}
          </button>
        </template>
      </template>
    </div>
    <div class="side right">
      <button
        v-if="targetLabel"
        type="button"
        class="item button"
        title="Open Project Settings"
        @click="openProjectSettings"
      >
        {{ targetLabel }}
      </button>
      <span
        v-if="buildStore.running"
        class="item"
      >
        <span class="spinner" /> Building…
      </span>
      <button
        type="button"
        class="item button"
        title="Show Problems"
        @click="appStore.showBottomPanel('problems')"
      >
        <Icon
          name="error"
          :size="13"
        />{{ errorCount }}
        <Icon
          name="warning"
          :size="13"
        />{{ warningCount }}
      </button>
      <button
        type="button"
        class="item button"
        @click="appStore.showBottomPanel('output')"
      >
        Output
      </button>
      <button
        type="button"
        class="item button"
        @click="toggleTheme"
      >
        {{ appStore.theme === 'dark' ? 'Light Theme' : 'Dark Theme' }}
      </button>
    </div>
  </footer>
</template>

<style scoped>
.status-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 24px;
  padding: 0 10px;
  background: var(--color-bg-statusbar);
  color: var(--color-fg-statusbar);
  font-size: 11px;
  grid-column: 1 / -1;
}

.side {
  display: flex;
  align-items: center;
  gap: 14px;
  height: 100%;
}

.item {
  display: flex;
  align-items: center;
  gap: 6px;
}

.button:hover {
  background: rgba(255, 255, 255, 0.15);
}

.spinner {
  width: 10px;
  height: 10px;
  border: 1.5px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
