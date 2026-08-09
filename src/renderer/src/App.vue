<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch, watchEffect } from 'vue'
import { runMenuCommand } from './commands'
import { useAppStore } from './stores/appStore'
import { useBuildStore } from './stores/buildStore'
import { useExamplesStore } from './stores/examplesStore'
import { useGitStore } from './stores/gitStore'
import { useProjectStore } from './stores/projectStore'
import { useToolchainStore } from './stores/toolchainStore'
import ActivityBar from './components/ActivityBar.vue'
import SidePanel from './components/SidePanel.vue'
import EditorArea from './components/EditorArea.vue'
import BottomPanel from './components/BottomPanel.vue'
import GitBranchPicker from './components/GitBranchPicker.vue'
import LicenseGate from './components/LicenseGate.vue'
import NewProjectDialog from './components/NewProjectDialog.vue'
import StatusBar from './components/StatusBar.vue'
import Splitter from './components/Splitter.vue'

const appStore = useAppStore()
const buildStore = useBuildStore()
const examplesStore = useExamplesStore()
const gitStore = useGitStore()
const projectStore = useProjectStore()
const toolchainStore = useToolchainStore()

const workbenchColumns = computed(() =>
  appStore.panelLayout.sideVisible
    ? `48px ${appStore.panelLayout.sideWidth}px 4px 1fr`
    : '48px 1fr'
)

let unsubscribeState: (() => void) | undefined

let unsubscribeProgress: (() => void) | undefined

let unsubscribeMenu: (() => void) | undefined

// theme.css keys the light palette off `:root[data-theme='light']`, so the
// attribute has to land on <html> — on any element below it the selector never
// matches and only Monaco and the terminal, which watch the store directly,
// ever changed. watchEffect covers all three ways the theme moves: initial
// load, the status-bar toggle, and state pushed from main.
watchEffect(() => {
  document.documentElement.dataset.theme = appStore.theme
})

// Everything that makes the IDE live, held back until the licence is accepted.
// The menu is the reason this is a function rather than a straight line through
// `onMounted`: its accelerators fire the moment the window exists, so leaving
// `menu:command` subscribed would let Ctrl+N open a project behind the gate.
let started = false

function startWorkbench(): void {
  if (started) return
  started = true
  unsubscribeMenu = window.api.on('menu:command', (command) => runMenuCommand(command))
  projectStore.init()
  buildStore.init()
  gitStore.init()
  void toolchainStore.loadStatus()
  // Reopen the last project silently: a moved/deleted folder shouldn't nag on startup.
  if (appStore.lastProject) {
    void window.api
      .invoke('project:open', { path: appStore.lastProject })
      .then((opened) => projectStore.afterOpen(opened))
      .catch(() => undefined)
  }
}

onMounted(async () => {
  unsubscribeState = window.api.on('app:stateChanged', (state) => appStore.applyRemoteState(state))
  unsubscribeProgress = window.api.on('toolchain:progress', (progress) =>
    toolchainStore.applyProgress(progress)
  )
  await appStore.load()
  if (appStore.licenseAgreed) startWorkbench()
})

// Accepting the gate is the other way in — the same start, one interaction later.
watch(
  () => appStore.licenseAgreed,
  (agreed) => {
    if (agreed) startWorkbench()
  }
)

onUnmounted(() => {
  unsubscribeState?.()
  unsubscribeProgress?.()
  unsubscribeMenu?.()
})
</script>

<template>
  <div class="shell">
    <!-- Nothing renders until the persisted state has arrived, so an accepted
         user never sees the gate flash past on the way to the workbench. -->
    <LicenseGate v-if="appStore.stateLoaded && !appStore.licenseAgreed" />
    <template v-else-if="appStore.stateLoaded">
      <div
        class="workbench"
        :style="{ gridTemplateColumns: workbenchColumns }"
      >
        <ActivityBar />
        <template v-if="appStore.panelLayout.sideVisible">
          <SidePanel />
          <Splitter
            orientation="vertical"
            :model-value="appStore.panelLayout.sideWidth"
            :min="180"
            :max="600"
            @update:model-value="appStore.setSideWidth($event)"
          />
        </template>
        <div class="main-column">
          <EditorArea class="editor-slot" />
          <template v-if="appStore.panelLayout.bottomVisible">
            <Splitter
              orientation="horizontal"
              invert
              :model-value="appStore.panelLayout.bottomHeight"
              :min="120"
              :max="600"
              @update:model-value="appStore.setBottomHeight($event)"
            />
            <BottomPanel :style="{ height: `${appStore.panelLayout.bottomHeight}px` }" />
          </template>
        </div>
      </div>
      <StatusBar />
      <NewProjectDialog v-if="projectStore.wizardVisible || examplesStore.forkSource" />
      <GitBranchPicker v-if="gitStore.branchPickerOpen" />
    </template>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100vw;
}

.workbench {
  display: grid;
  flex: 1;
  min-height: 0;
}

.main-column {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.editor-slot {
  flex: 1;
  min-height: 0;
}
</style>
