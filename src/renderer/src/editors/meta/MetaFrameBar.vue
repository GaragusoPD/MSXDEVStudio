<script setup lang="ts">
/**
 * The frame filmstrip: thumbnails, add / duplicate / delete / reorder, playback
 * and the onion-skin toggle.
 *
 * Modelled on `sprite/SpriteAnimationBar.vue`, which solves the same problem for
 * hardware sprites. Playback runs off a plain interval rather than
 * requestAnimationFrame: the rate is a preview convenience, and a meta carries
 * no per-frame duration — timing is the game's decision, as it is for sprites.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { metaThumbnail } from '../map/sheet'
import {
  addFrame,
  doc,
  removeFrame,
  reorderFrames,
  setFrame,
  setGridVisible,
  setOnionSkin,
  sheet,
  togglePlaying,
  type MetaSession
} from './session'

const props = defineProps<{ session: MetaSession }>()

const meta = computed(() => doc(props.session))
const fps = ref(6)
let timer: ReturnType<typeof setInterval> | null = null
let dragFrom: number | null = null


/** Frame `n` as a data URL, drawn from the tileset's own sheet. */
function thumbnail(frame: number): string {
  const base = sheet(props.session)
  if (!base) return ''
  return metaThumbnail(base, meta.value, frame).toDataURL()
}

function stop(): void {
  if (timer) clearInterval(timer)
  timer = null
}

watch(
  () => [props.session.playing, fps.value, meta.value.frames.length],
  () => {
    stop()
    if (!props.session.playing || meta.value.frames.length < 2) return
    timer = setInterval(() => {
      setFrame(props.session, (props.session.frame + 1) % meta.value.frames.length)
    }, Math.max(40, Math.round(1000 / fps.value)))
  },
  { immediate: true }
)

onBeforeUnmount(stop)

function onDragStart(from: number): void {
  dragFrom = from
}

function onDrop(to: number): void {
  if (dragFrom !== null && dragFrom !== to) reorderFrames(props.session, dragFrom, to)
  dragFrom = null
}
</script>

<template>
  <div class="frame-bar">
    <div class="strip">
      <button
        v-for="(frame, index) in meta.frames"
        :key="index"
        class="frame"
        :class="{ active: index === session.frame }"
        draggable="true"
        :title="`Frame ${index}`"
        @click="setFrame(session, index)"
        @dragstart="onDragStart(index)"
        @dragover.prevent
        @drop.prevent="onDrop(index)"
      >
        <img
          v-if="thumbnail(index)"
          :src="thumbnail(index)"
          alt=""
        >
        <span class="n">{{ index }}</span>
      </button>
    </div>

    <div class="controls">
      <button
        title="Duplicate the current frame — animation starts from a pose"
        @click="addFrame(session, session.frame)"
      >
        Duplicate
      </button>
      <button
        title="Add a blank frame"
        @click="addFrame(session)"
      >
        Add
      </button>
      <button
        :disabled="meta.frames.length < 2"
        title="Delete the current frame"
        @click="removeFrame(session, session.frame)"
      >
        Delete
      </button>
      <button
        :disabled="meta.frames.length < 2"
        @click="togglePlaying(session)"
      >
        {{ session.playing ? 'Stop' : 'Play' }}
      </button>
      <label class="fps">
        <span>fps</span>
        <input
          v-model.number="fps"
          type="number"
          min="1"
          max="30"
        >
      </label>
      <label class="check">
        <input
          :checked="session.onionSkin"
          type="checkbox"
          @change="setOnionSkin(session, ($event.target as HTMLInputElement).checked)"
        >
        <span>Onion skin</span>
      </label>
      <label class="check">
        <input
          :checked="session.gridVisible"
          type="checkbox"
          @change="setGridVisible(session, ($event.target as HTMLInputElement).checked)"
        >
        <span>Grid</span>
      </label>
    </div>
  </div>
</template>

<style scoped>
.frame-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 8px 12px;
  border-top: 1px solid var(--border, #333);
  overflow-x: auto;
}

.strip {
  display: flex;
  gap: 6px;
}

.frame {
  position: relative;
  display: grid;
  place-items: center;
  min-width: 48px;
  min-height: 48px;
  padding: 4px;
  background: #2a2a2a;
  border: 1px solid var(--border, #444);
  border-radius: 3px;
  cursor: pointer;
}

.frame.active {
  border-color: #ffd24e;
}

.frame img {
  image-rendering: pixelated;
  max-width: 40px;
  max-height: 40px;
}

.frame .n {
  position: absolute;
  right: 2px;
  bottom: 0;
  font-size: 10px;
  opacity: 0.6;
}

.controls {
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}

.fps input {
  width: 48px;
}

.check {
  display: flex;
  align-items: center;
  gap: 4px;
}
</style>
