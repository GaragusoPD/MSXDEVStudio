<script setup lang="ts">
/**
 * The pose editor's sidebar: colour, size, timing and loop, a playing preview,
 * what a step costs, and where the file is attached — plus, for a meta-tile,
 * its eight gameplay flags.
 * Readouts of session state and calls into it — every decision is in
 * `./session`, which is tested; this file is not.
 */
import { computed, onUnmounted, ref, watch, watchEffect } from 'vue'
import { paletteToRgb, toHex } from '../../../../shared/msx/palette'
import { ANIM_LOOPS, type AnimLoop } from '../../../../shared/msx/tile'
import { MAX_ANIM_CELLS } from '../../../../shared/msx/tile-anim'
import { MAX_META_SIZE } from '../../../../shared/msx/meta-tile'
import { movingCells } from '../../../../shared/msx/meta-owned'
import { useTabsStore } from '../../stores/tabsStore'
import Icon from '../../components/Icon.vue'
import {
  doc,
  findAttachments,
  ownedMeta,
  removeFromTileset,
  poseAtTick,
  posePixels,
  resize,
  setColor,
  setDuration,
  setLoop,
  setFlag,
  setPair,
  stepBytes,
  togglePlaying,
  type AnimSession
} from './session'

const props = defineProps<{ session: AnimSession }>()
const tabsStore = useTabsStore()

const anim = computed(() => doc(props.session))
const meta = computed(() => ownedMeta(props.session))
const moving = computed(() => (meta.value ? movingCells(meta.value).length : 0))
const maxSide = computed(() => (meta.value ? MAX_META_SIZE : MAX_ANIM_CELLS))
const rgb = computed(() => paletteToRgb(null))
const LOOP_LABELS: Record<AnimLoop, string> = { loop: 'Loop', pingpong: 'Ping-pong', once: 'Play once' }

// The preview steps a tick every 20 ms — one PAL VBlank, the clock `_Animate()`
// is called on — and asks the session which pose that tick shows.
const tick = ref(0)
let timer: ReturnType<typeof setInterval> | null = null
watch(
  () => props.session.playing,
  (playing) => {
    if (timer) clearInterval(timer)
    timer = null
    tick.value = 0
    if (playing) timer = setInterval(() => tick.value++, 20)
  },
  { immediate: true }
)
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

const previewCanvas = ref<HTMLCanvasElement | null>(null)
watchEffect(() => {
  const element = previewCanvas.value
  if (!element) return
  const pose = props.session.playing ? poseAtTick(anim.value, tick.value) : props.session.frame
  const { width, height, indices } = posePixels(props.session, pose)
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

const allDurations = computed(() => {
  const first = anim.value.frames[0]?.duration ?? 8
  return anim.value.frames.every((frame) => frame.duration === first) ? first : null
})

function openTileset(path: string): void {
  tabsStore.openFile(path, path.split('/').pop() ?? path)
}
</script>

<template>
  <aside class="side">
    <section>
      <h3>Colour</h3>
      <div class="swatches">
        <button
          v-for="(color, index) in rgb"
          :key="index"
          type="button"
          class="swatch"
          :class="{ current: session.color === index }"
          :style="{ background: toHex(color) }"
          :title="`Colour ${index}`"
          @click="setColor(session, index)"
        />
      </div>
      <p class="hint">
        <strong>Left</strong> button paints a row's ink, <strong>right</strong> its paper.
        <template v-if="anim.mode === 'sc4'">
          Shown in the MSX1 palette; the tileset's own palette applies once attached.
        </template>
      </p>
      <div
        v-if="anim.mode === 'sc1'"
        class="row"
      >
        <span>Pair</span>
        <select
          :value="anim.pair >> 4"
          title="Ink"
          @change="setPair(session, Number(($event.target as HTMLSelectElement).value), anim.pair & 15)"
        >
          <option
            v-for="(_, index) in rgb"
            :key="index"
            :value="index"
          >
            {{ index }}
          </option>
        </select>
        <select
          :value="anim.pair & 15"
          title="Paper"
          @change="setPair(session, anim.pair >> 4, Number(($event.target as HTMLSelectElement).value))"
        >
          <option
            v-for="(_, index) in rgb"
            :key="index"
            :value="index"
          >
            {{ index }}
          </option>
        </select>
      </div>
    </section>

    <section>
      <h3>{{ meta ? 'Size' : 'Window' }}</h3>
      <div class="row">
        <label>W <input
          type="number"
          min="1"
          :max="maxSide"
          :value="anim.width"
          @change="resize(session, Number(($event.target as HTMLInputElement).value), anim.height)"
        ></label>
        <label>H <input
          type="number"
          min="1"
          :max="maxSide"
          :value="anim.height"
          @change="resize(session, anim.width, Number(($event.target as HTMLInputElement).value))"
        ></label>
        <span class="unit">tiles</span>
      </div>
      <p
        v-if="meta && !moving"
        class="hint"
      >
        Still: every pose looks the same, so it costs nothing per frame. Add a pose that differs to animate it.
      </p>
      <p
        v-else-if="meta"
        class="hint"
      >
        {{ moving }} tile{{ moving === 1 ? '' : 's' }} change between poses — the window each tileset gives it.
        A step writes {{ stepBytes(anim) }} bytes of VRAM, only on the frames a pose changes, and moves every copy at once.
      </p>
      <p
        v-else
        class="hint"
      >
        A step writes {{ stepBytes(anim) }} bytes of VRAM, only on the frames a pose changes.
      </p>
    </section>

    <section v-if="meta">
      <h3>Flags</h3>
      <div class="flags">
        <label
          v-for="bit in 8"
          :key="bit"
          :title="`Flag ${bit} — what the meta means to the game is the game's to decide`"
        >
          <input
            type="checkbox"
            :checked="(meta.flags & (1 << (bit - 1))) !== 0"
            @change="setFlag(session, bit - 1, ($event.target as HTMLInputElement).checked)"
          >{{ bit }}
        </label>
      </div>
      <p class="hint">
        Exported in each tileset's <code>_MetaInfo</code> and in a map's meta table, for collision against
        the object rather than its tiles.
      </p>
    </section>

    <section>
      <h3>Timing</h3>
      <div class="row">
        <select
          :value="anim.loop"
          @change="setLoop(session, ($event.target as HTMLSelectElement).value as AnimLoop)"
        >
          <option
            v-for="loop in ANIM_LOOPS"
            :key="loop"
            :value="loop"
          >
            {{ LOOP_LABELS[loop] }}
          </option>
        </select>
        <label title="Set every pose's duration at once">All <input
          type="number"
          min="1"
          max="255"
          :value="allDurations ?? ''"
          :placeholder="allDurations === null ? 'mixed' : ''"
          @change="setDuration(session, null, Number(($event.target as HTMLInputElement).value))"
        ></label>
      </div>
      <p class="hint">
        Durations are in frames (VBlanks): 50 a second on a European MSX, 60 on a Japanese one.
      </p>
    </section>

    <section>
      <h3>Preview</h3>
      <canvas
        ref="previewCanvas"
        class="preview"
      />
      <button
        type="button"
        @click="togglePlaying(session)"
      >
        {{ session.playing ? 'Stop' : 'Play' }}
      </button>
    </section>

    <section>
      <h3>Attached to</h3>
      <ul
        v-if="session.attachedTo.length"
        class="attached"
      >
        <li
          v-for="attachment in session.attachedTo"
          :key="`${attachment.tileset}:${attachment.slot}`"
        >
          <button
            type="button"
            class="link"
            @click="openTileset(attachment.tileset)"
          >
            {{ attachment.tileset.split('/').pop() }}
          </button>
          <span v-if="attachment.slot === null">still</span>
          <span v-else-if="attachment.cells > 1">tiles {{ attachment.slot }}-{{ attachment.slot + attachment.cells - 1 }}{{ attachment.bank !== null ? `, bank ${attachment.bank + 1}` : '' }}</span>
          <span v-else>tile {{ attachment.slot }}{{ attachment.bank !== null ? `, bank ${attachment.bank + 1}` : '' }}</span>
          <button
            v-if="meta"
            type="button"
            class="remove"
            :title="`Remove from ${attachment.tileset.split('/').pop()}, and from the maps drawn with it that place it — its tiles go too, unless a map still shows them`"
            @click="removeFromTileset(session, attachment.tileset)"
          >
            <Icon
              name="link_off"
              :size="14"
            />
          </button>
        </li>
      </ul>
      <p
        v-else-if="meta"
        class="hint"
      >
        Not attached yet. Attach it from a tileset's <strong>Meta-tiles</strong> panel, or place it on a
        map — that attaches it to the map's tileset.
      </p>
      <p
        v-else
        class="hint"
      >
        Not attached yet. Open a tileset, select the tile the map cells use, and attach this
        animation from its <strong>Animations</strong> panel.
      </p>
      <button
        type="button"
        @click="findAttachments(session)"
      >
        Refresh
      </button>
    </section>
  </aside>
</template>

<style scoped>
.side {
  width: 220px;
  padding: 10px;
  overflow-y: auto;
  border-left: 1px solid var(--border, #333);
}

h3 {
  margin: 0 0 4px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-text-muted);
}

section {
  margin-bottom: 16px;
}

.swatches {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 2px;
}

.swatch {
  height: 20px;
  border: 1px solid var(--color-border);
  border-radius: 2px;
  cursor: pointer;
}

.swatch.current {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.row input {
  width: 48px;
}

.unit {
  opacity: 0.7;
}

.flags {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 2px 6px;
  font-size: 12px;
}

.hint {
  margin: 4px 0;
  font-size: 10px;
  color: var(--color-text-muted);
}

.preview {
  display: block;
  width: 96px;
  height: 96px;
  margin-bottom: 6px;
  object-fit: contain;
  image-rendering: pixelated;
  background: #2a2a2a;
}

.attached {
  margin: 0 0 6px;
  padding: 0;
  list-style: none;
  font-size: 12px;
}

.attached li {
  display: flex;
  gap: 6px;
  align-items: baseline;
}

.attached .remove {
  margin-left: auto;
  padding: 0 2px;
  line-height: 1;
}

.link {
  padding: 0;
  border: none;
  background: none;
  color: var(--color-accent);
  cursor: pointer;
}
</style>
