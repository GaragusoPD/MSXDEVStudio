<script setup lang="ts">
/**
 * The pose strip: a thumbnail per pose with how long it is held, and the
 * add / duplicate / delete / move controls. Every change is a session call.
 */
import { computed, ref, watchEffect } from 'vue'
import { paletteToRgb } from '../../../../shared/msx/palette'
import Icon from '../../components/Icon.vue'
import { addFrame, doc, moveFrame, posePixels, removeFrame, setDuration, setFrame, type AnimSession } from './session'

const props = defineProps<{ session: AnimSession }>()

const anim = computed(() => doc(props.session))
const rgb = computed(() => paletteToRgb(null))
const thumbs = ref<HTMLCanvasElement[]>([])

watchEffect(() => {
  anim.value.frames.forEach((_, frame) => {
    const element = thumbs.value[frame]
    if (!element) return
    const { width, height, indices } = posePixels(props.session, frame)
    element.width = width
    element.height = height
    const context = element.getContext('2d')
    if (!context) return
    const image = context.createImageData(width, height)
    indices.forEach((index, i) => {
      const { r, g, b } = index === 0 ? { r: 64, g: 64, b: 64 } : rgb.value[index]
      image.data.set([r, g, b, 255], i * 4)
    })
    context.putImageData(image, 0, 0)
  })
})
</script>

<template>
  <div class="frame-bar">
    <div
      v-for="(frame, index) in anim.frames"
      :key="index"
      class="frame"
      :class="{ current: session.frame === index }"
      @click="setFrame(session, index)"
    >
      <canvas
        :ref="(element) => (thumbs[index] = element as HTMLCanvasElement)"
        class="thumb"
      />
      <label
        class="duration"
        title="Frames (VBlanks) this pose is held — 50 a second on a European MSX, 60 on a Japanese one"
        @click.stop
      >
        <input
          type="number"
          min="1"
          max="255"
          :value="frame.duration"
          @change="setDuration(session, index, Number(($event.target as HTMLInputElement).value))"
        >
      </label>
    </div>
    <div class="actions">
      <button
        type="button"
        title="Duplicate this pose after it"
        @click="addFrame(session, session.frame)"
      >
        <Icon name="content_copy" />
      </button>
      <button
        type="button"
        title="Add a blank pose at the end"
        @click="addFrame(session, null)"
      >
        <Icon name="add" />
      </button>
      <button
        type="button"
        title="Move this pose earlier"
        :disabled="session.frame === 0"
        @click="moveFrame(session, session.frame, session.frame - 1)"
      >
        <Icon name="arrow_back" />
      </button>
      <button
        type="button"
        title="Move this pose later"
        :disabled="session.frame >= anim.frames.length - 1"
        @click="moveFrame(session, session.frame, session.frame + 1)"
      >
        <Icon name="arrow_forward" />
      </button>
      <button
        type="button"
        title="Delete this pose"
        :disabled="anim.frames.length <= 1"
        @click="removeFrame(session, session.frame)"
      >
        <Icon name="delete" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.frame-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  overflow-x: auto;
  border-top: 1px solid var(--border, #333);
}

.frame {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border: 1px solid transparent;
  border-radius: 3px;
  cursor: pointer;
}

.frame.current {
  border-color: #ffd24e;
}

.thumb {
  width: 48px;
  height: 48px;
  object-fit: contain;
  image-rendering: pixelated;
  background: #2a2a2a;
}

.duration input {
  width: 44px;
  font-size: 11px;
}

.actions {
  display: flex;
  gap: 4px;
  margin-left: 8px;
}
</style>
