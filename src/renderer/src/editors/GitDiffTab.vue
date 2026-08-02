<script setup lang="ts">
import * as monaco from './monaco-full'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { extensionFor, languageFor } from '../../../shared/file-kind'
import { useAppStore } from '../stores/appStore'
import { useGitStore } from '../stores/gitStore'
import { useTabsStore } from '../stores/tabsStore'

const tabsStore = useTabsStore()
const gitStore = useGitStore()
const appStore = useAppStore()
const container = ref<HTMLDivElement>()

let editor: monaco.editor.IStandaloneDiffEditor | undefined

/** Read-only original (index/HEAD) vs modified (working tree/index) — see `git:diff` in Spec 06. */
async function attachActiveTab(): Promise<void> {
  const tab = tabsStore.activeTab
  if (!editor || !tab || tab.extension !== 'git-diff') return
  const request = gitStore.diffRequests[tab.id]
  if (!request) return

  const requestedId = tab.id
  const result = await window.api.invoke('git:diff', request)
  if (tabsStore.activeTabId !== requestedId) return // user switched again while it loaded

  const language = languageFor(extensionFor(request.path))
  const previous = editor.getModel()
  editor.setModel({
    original: monaco.editor.createModel(result.old, language),
    modified: monaco.editor.createModel(result.new, language)
  })
  if (previous) {
    previous.original.dispose()
    previous.modified.dispose()
  }
}

onMounted(() => {
  if (!container.value) return
  editor = monaco.editor.createDiffEditor(container.value, {
    automaticLayout: true,
    readOnly: true,
    renderSideBySide: true,
    theme: appStore.theme === 'light' ? 'vs' : 'vs-dark'
  })
  void attachActiveTab()
})

watch(() => tabsStore.activeTabId, () => void attachActiveTab())
watch(
  () => appStore.theme,
  (theme) => monaco.editor.setTheme(theme === 'light' ? 'vs' : 'vs-dark')
)

onBeforeUnmount(() => {
  const model = editor?.getModel()
  model?.original.dispose()
  model?.modified.dispose()
  editor?.dispose()
})
</script>

<template>
  <div
    ref="container"
    class="diff-host"
  />
</template>

<style scoped>
.diff-host {
  height: 100%;
  width: 100%;
}
</style>
