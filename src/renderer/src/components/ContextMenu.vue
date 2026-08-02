<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'

export interface ContextMenuItem {
  label: string
  action: () => void
  danger?: boolean
}

const props = defineProps<{
  x: number
  y: number
  items: ContextMenuItem[]
}>()

const emit = defineEmits<{ close: [] }>()

function run(item: ContextMenuItem): void {
  item.action()
  emit('close')
}

function onWindowPointerDown(): void {
  emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => {
  // Deferred so the click that opened the menu doesn't immediately close it.
  window.addEventListener('pointerdown', onWindowPointerDown)
  window.addEventListener('keydown', onKeydown)
})
onUnmounted(() => {
  window.removeEventListener('pointerdown', onWindowPointerDown)
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <ul
    class="context-menu"
    :style="{ left: `${props.x}px`, top: `${props.y}px` }"
    @pointerdown.stop
  >
    <li
      v-for="item in items"
      :key="item.label"
      :class="{ danger: item.danger }"
      @click="run(item)"
    >
      {{ item.label }}
    </li>
  </ul>
</template>

<style scoped>
.context-menu {
  position: fixed;
  z-index: 1000;
  min-width: 160px;
  margin: 0;
  padding: 4px 0;
  list-style: none;
  background: var(--color-bg-sidebar);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.context-menu li {
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
}

.context-menu li:hover {
  background: var(--color-bg-hover);
}

.context-menu li.danger {
  color: #e06c75;
}
</style>
