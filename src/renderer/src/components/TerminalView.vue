<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { applyTheme, attach, focus, refit } from '../editors/terminal/session'
import { useAppStore } from '../stores/appStore'

/** Renders one terminal session. The session itself outlives this component — see `terminal/session.ts`. */
const props = defineProps<{ id: string }>()

const appStore = useAppStore()
const host = ref<HTMLElement | null>(null)
let observer: ResizeObserver | null = null

onMounted(() => {
  if (!host.value) return
  attach(props.id, host.value)
  // Covers all three ways the size changes: the splitter being dragged, the
  // window being resized, and the pane mounting at 0×0 and being laid out a
  // frame later.
  observer = new ResizeObserver(() => refit(props.id))
  observer.observe(host.value)
  focus(props.id)
})

watch(() => appStore.theme, applyTheme)

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})
</script>

<template>
  <div
    ref="host"
    class="terminal-view"
  />
</template>

<style scoped>
.terminal-view {
  height: 100%;
  padding: 4px 0 0 8px;
  background: var(--color-bg-editor);
  overflow: hidden;
}
</style>
