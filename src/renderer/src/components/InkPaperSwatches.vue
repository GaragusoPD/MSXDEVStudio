<script setup lang="ts">
/**
 * The palette of the pattern-mode painters (tile, pose and map paint), with two
 * selected colours instead of one: a **front** colour the left button paints
 * with (a row's ink) and a **background** colour the right button paints with
 * (a row's paper). Left-click a swatch to pick the front colour, right-click to
 * pick the background; the chip above shows both and swaps them. Before, one
 * colour served both buttons, so drawing red on black meant picking red, then
 * black, then red again for every switch between ink and paper.
 */
import { toHex, type Rgb } from '../../../shared/msx/palette'
import Icon from './Icon.vue'

const props = withDefaults(
  defineProps<{
    rgb: readonly Rgb[]
    ink: number
    paper: number
    /** Draw index 0 struck through, where it means transparent. */
    transparentZero?: boolean
    /** A swatch's name in its tooltip; its number by default. */
    label?: (index: number) => string
  }>(),
  { transparentZero: false, label: (index: number) => `Colour ${index}` }
)
const emit = defineEmits<{ ink: [index: number]; paper: [index: number]; swap: [] }>()

function hex(index: number): string {
  const color = props.rgb[index]
  return color ? toHex(color) : 'transparent'
}
</script>

<template>
  <div class="ink-paper">
    <div class="pair">
      <span
        class="chips"
        :title="`Front ${ink} (left button) on background ${paper} (right button)`"
      >
        <span
          class="chip paper"
          :style="{ background: hex(paper) }"
        />
        <span
          class="chip ink"
          :style="{ background: hex(ink) }"
        />
      </span>
      <button
        type="button"
        class="swap"
        title="Swap the front and background colours"
        @click="emit('swap')"
      >
        <Icon
          name="swap_horiz"
          :size="16"
        />
      </button>
      <span class="legend">Front <b>{{ ink }}</b> · back <b>{{ paper }}</b></span>
    </div>
    <div class="swatches">
      <button
        v-for="(color, index) in rgb"
        :key="index"
        type="button"
        class="swatch"
        :class="{ ink: ink === index, paper: paper === index, transparent: transparentZero && index === 0 }"
        :style="{ background: toHex(color) }"
        :title="`${label(index)} — click: front colour, right-click: background colour`"
        @click="emit('ink', index)"
        @contextmenu.prevent="emit('paper', index)"
      >
        <span class="number">{{ index }}</span>
        <span
          v-if="ink === index"
          class="badge"
        >F</span>
        <span
          v-else-if="paper === index"
          class="badge"
        >B</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.pair {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 11px;
  color: var(--color-text-muted);
}

.chips {
  position: relative;
  width: 30px;
  height: 26px;
  flex: none;
}

.chip {
  position: absolute;
  width: 18px;
  height: 18px;
  border: 1px solid var(--color-border);
  border-radius: 2px;
}

.chip.ink {
  left: 0;
  top: 0;
  outline: 1px solid var(--color-bg);
}

.chip.paper {
  right: 0;
  bottom: 0;
}

.swap {
  display: flex;
  padding: 1px;
  color: var(--color-text-muted);
}

.legend b {
  color: var(--color-text);
  font-weight: 600;
}

.swatches {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 2px;
}

.swatch {
  position: relative;
  height: 22px;
  border: 1px solid var(--color-border);
  border-radius: 2px;
}

.swatch .number {
  position: absolute;
  right: 1px;
  bottom: 0;
  font-size: 8px;
  color: rgba(255, 255, 255, 0.75);
  text-shadow: 0 0 2px #000000;
}

.swatch .badge {
  position: absolute;
  left: 2px;
  top: 0;
  font-size: 9px;
  font-weight: 700;
  color: #ffffff;
  text-shadow: 0 0 2px #000000, 0 0 2px #000000;
}

.swatch.ink {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

.swatch.paper {
  outline: 2px dashed var(--color-text-muted);
  outline-offset: 1px;
}

.swatch.transparent {
  background-image: linear-gradient(45deg, transparent 45%, #ff6666 45%, #ff6666 55%, transparent 55%);
}
</style>
