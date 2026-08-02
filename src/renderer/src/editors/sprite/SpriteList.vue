<script setup lang="ts">
/**
 * Left panel: logical sprite characters (composed thumbnails via
 * `compositeFrame`), add/duplicate/delete/rename, and the PNG-strip import
 * entry point.
 */
import { ref, watchEffect } from 'vue'
import { paletteToRgb } from '../../../../shared/msx/palette'
import { compositeFrame, type SpriteFrame, type SpritesDoc } from '../../../../shared/msx/sprite'
import { addSprite, duplicateSprite, removeSprite, renameSprite } from '../../../../shared/sprite-editor'
import { drawIndices } from './draw'
import SpriteImportDialog from './SpriteImportDialog.vue'

const props = defineProps<{ doc: SpritesDoc; active: number }>()
const emit = defineEmits<{ select: [index: number]; mutate: [doc: SpritesDoc] }>()

const THUMB = 48
const thumbRefs = ref<(HTMLCanvasElement | null)[]>([])
const importVisible = ref(false)

function redrawThumbs(): void {
  const rgb = paletteToRgb(props.doc.palette)
  props.doc.sprites.forEach((sprite, i) => {
    const canvas = thumbRefs.value[i]
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    ctx.clearRect(0, 0, THUMB, THUMB)
    const size = props.doc.size
    const scale = THUMB / size
    const indices = compositeFrame(sprite.frames[0].layers, props.doc.mode, size)
    drawIndices(ctx, indices, size, scale, rgb)
  })
}

// flush: 'post' so the v-for's canvas refs exist by the time this reads them, on every run
// including the first (a 'pre' first run would read nothing and never track `doc` as a dependency).
watchEffect(redrawThumbs, { flush: 'post' })

function rename(index: number, event: Event): void {
  const name = (event.target as HTMLInputElement).value.trim()
  if (name) emit('mutate', renameSprite(props.doc, index, name))
}

function onImported(frames: SpriteFrame[], palette: number[] | null): void {
  let next = addSprite(props.doc)
  const index = next.sprites.length - 1
  next = { ...next, sprites: next.sprites.map((s, i) => (i === index ? { ...s, frames } : s)) }
  if (palette && !next.palette) next = { ...next, palette }
  emit('mutate', next)
  emit('select', index)
  importVisible.value = false
}
</script>

<template>
  <div class="sprite-list">
    <h3>Sprites</h3>
    <ul>
      <li
        v-for="(sprite, index) in doc.sprites"
        :key="index"
        class="row"
        :class="{ active: index === active }"
        @click="emit('select', index)"
      >
        <canvas
          :ref="(el) => (thumbRefs[index] = el as HTMLCanvasElement)"
          class="thumb"
          :width="THUMB"
          :height="THUMB"
        />
        <input
          class="name"
          type="text"
          :value="sprite.name"
          spellcheck="false"
          @click.stop
          @change="rename(index, $event)"
        >
        <button
          type="button"
          title="Duplicate"
          @click.stop="emit('mutate', duplicateSprite(doc, index))"
        >
          ⧉
        </button>
        <button
          type="button"
          title="Delete"
          :disabled="doc.sprites.length <= 1"
          @click.stop="emit('mutate', removeSprite(doc, index))"
        >
          ×
        </button>
      </li>
    </ul>
    <div class="actions">
      <button
        type="button"
        @click="emit('mutate', addSprite(doc))"
      >
        + Sprite
      </button>
      <button
        type="button"
        @click="importVisible = true"
      >
        Import PNG…
      </button>
    </div>

    <SpriteImportDialog
      v-if="importVisible"
      :mode="doc.mode"
      :size="doc.size"
      @close="importVisible = false"
      @imported="onImported"
    />
  </div>
</template>

<style scoped>
.sprite-list {
  display: flex;
  flex-direction: column;
  min-height: 0;
  width: 190px;
  flex-shrink: 0;
  border-right: 1px solid var(--color-border);
  padding: 8px;
  overflow-y: auto;
}

h3 {
  margin: 0 0 6px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
}

ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
}

.row:hover {
  background: var(--color-bg-hover);
}

.row.active {
  border-color: var(--color-accent);
  background: var(--color-bg-active-item);
}

.thumb {
  image-rendering: pixelated;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  background-color: var(--color-bg-tab-inactive);
  border: 1px solid var(--color-border);
}

.name {
  flex: 1;
  min-width: 0;
  padding: 2px 4px;
  border: 1px solid transparent;
  border-radius: 3px;
  background: transparent;
  color: var(--color-text);
  font-size: 11px;
}

.name:focus {
  border-color: var(--color-accent);
  background: var(--color-bg-tab-inactive);
}

.row button {
  padding: 0 4px;
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.row button:hover {
  color: var(--color-text);
}

.row button:disabled {
  opacity: 0.3;
  cursor: default;
}

.actions {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 8px;
}

.actions button {
  padding: 4px 8px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-hover);
  font-size: 11px;
}
</style>
