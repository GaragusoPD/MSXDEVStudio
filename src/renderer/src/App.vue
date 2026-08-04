<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
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

onMounted(async () => {
  await appStore.load()
  unsubscribeMenu = window.api.on('menu:command', (command) => runMenuCommand(command))
  unsubscribeState = window.api.on('app:stateChanged', (state) => appStore.applyRemoteState(state))
  unsubscribeProgress = window.api.on('toolchain:progress', (progress) =>
    toolchainStore.applyProgress(progress)
  )
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
})

onUnmounted(() => {
  unsubscribeState?.()
  unsubscribeProgress?.()
  unsubscribeMenu?.()
})
</script>

<template>
  <div
    class="shell"
    :data-theme="appStore.theme"
  >
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
