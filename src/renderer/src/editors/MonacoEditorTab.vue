<script setup lang="ts">
import * as monaco from './monaco-full'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAppStore } from '../stores/appStore'
import { useTabsStore } from '../stores/tabsStore'
import { getOrCreateModel, restoreViewState, saveViewState } from './monaco-models'

const tabsStore = useTabsStore()
const appStore = useAppStore()
const container = ref<HTMLDivElement>()

let editor: monaco.editor.IStandaloneCodeEditor | undefined
let attachedTabId: string | undefined

async function attachActiveTab(): Promise<void> {
  const previousTabId = attachedTabId
  const tab = tabsStore.activeTab
  if (!editor || !tab?.filePath) return

  if (editor && previousTabId) saveViewState(editor, previousTabId)

  const requestedId = tab.id
  const model = await getOrCreateModel(tab)
  if (tabsStore.activeTabId !== requestedId) return // user switched again while the file loaded

  editor.setModel(model)
  attachedTabId = requestedId
  restoreViewState(editor, requestedId)

  const reveal = tabsStore.pendingReveal
  if (reveal?.path === tab.filePath && reveal.line) {
    editor.revealLineInCenter(reveal.line)
    editor.setPosition({ lineNumber: reveal.line, column: reveal.column ?? 1 })
    editor.focus()
    tabsStore.clearPendingReveal()
  }
}

onMounted(() => {
  if (!container.value) return
  editor = monaco.editor.create(container.value, {
    automaticLayout: true,
    tabSize: 4,
    insertSpaces: true,
    minimap: { enabled: true },
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
  if (editor && attachedTabId) saveViewState(editor, attachedTabId)
  editor?.dispose() // disposes the widget only; models outlive it (see monaco-models.ts)
})
</script>

<template>
  <div
    ref="container"
    class="monaco-host"
  />
</template>

<style scoped>
.monaco-host {
  height: 100%;
  width: 100%;
}
</style>
