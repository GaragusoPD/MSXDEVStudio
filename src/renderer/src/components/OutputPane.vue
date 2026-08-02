<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useOutputStore } from '../stores/outputStore'

const outputStore = useOutputStore()
const pane = ref<HTMLElement | null>(null)

// Follow new output, but don't yank the view away from a user reading scrollback.
watch(
  () => outputStore.lines.length,
  async () => {
    const el = pane.value
    if (!el) return
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24
    await nextTick()
    if (atBottom) el.scrollTop = el.scrollHeight
  }
)
</script>

<template>
  <div
    ref="pane"
    class="output-pane"
  >
    <p
      v-if="!outputStore.lines.length"
      class="empty"
    >
      No output yet.
    </p>
    <pre
      v-for="(entry, i) in outputStore.lines"
      :key="i"
    ><span class="channel">[{{ entry.channel }}]</span> {{ entry.line }}</pre>
  </div>
</template>

<style scoped>
.output-pane {
  height: 100%;
  overflow-y: auto;
  padding: 8px 12px;
  font-family: var(--font-mono);
  font-size: 12px;
}

.output-pane pre {
  margin: 0 0 2px;
  white-space: pre-wrap;
  word-break: break-word;
}

.channel {
  color: var(--color-accent);
}

.empty {
  color: var(--color-text-muted);
  font-family: var(--font-ui);
}
</style>
