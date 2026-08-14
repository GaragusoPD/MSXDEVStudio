<script setup lang="ts">
withDefaults(defineProps<{ title: string; wide?: boolean }>(), { wide: false })
const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <div
    class="backdrop"
    @click.self="emit('close')"
  >
    <div
      class="dialog"
      :class="{ wide }"
    >
      <h2>{{ title }}</h2>
      <slot />
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
  z-index: 100;
}

.dialog {
  width: 520px;
  max-height: 85vh;
  overflow-y: auto;
  padding: 20px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-editor);
  color: var(--color-text);
}

.dialog.wide {
  width: 640px;
}

h2 {
  margin: 0 0 16px;
  font-size: 16px;
  font-weight: 600;
}
</style>
