<script setup lang="ts">
// Drag handle for resizing an adjacent panel. Vertical splitters resize a
// width (dragged left/right); horizontal splitters resize a height (dragged
// up/down). No docking library — this is the whole thing.
const props = withDefaults(
  defineProps<{
    orientation: 'vertical' | 'horizontal'
    modelValue: number
    min?: number
    max?: number
    /** Horizontal splitters sit above the panel they resize, so dragging up
     *  should grow it — set true to invert the delta. */
    invert?: boolean
  }>(),
  { min: 100, max: 2000, invert: false }
)

const emit = defineEmits<{ 'update:modelValue': [value: number] }>()

let startPos = 0
let startSize = 0

function onPointerDown(event: PointerEvent): void {
  startPos = props.orientation === 'vertical' ? event.clientX : event.clientY
  startSize = props.modelValue
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
}

function onPointerMove(event: PointerEvent): void {
  const pos = props.orientation === 'vertical' ? event.clientX : event.clientY
  const delta = props.invert ? startPos - pos : pos - startPos
  const size = Math.min(props.max, Math.max(props.min, startSize + delta))
  emit('update:modelValue', size)
}

function onPointerUp(): void {
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
}
</script>

<template>
  <div
    class="splitter"
    :class="orientation"
    role="separator"
    :aria-orientation="orientation === 'vertical' ? 'vertical' : 'horizontal'"
    @pointerdown="onPointerDown"
  />
</template>

<style scoped>
.splitter {
  flex-shrink: 0;
  background: var(--color-border);
}
.splitter.vertical {
  width: 4px;
  cursor: col-resize;
}
.splitter.horizontal {
  height: 4px;
  cursor: row-resize;
}
.splitter:hover,
.splitter:active {
  background: var(--color-accent);
}
</style>
