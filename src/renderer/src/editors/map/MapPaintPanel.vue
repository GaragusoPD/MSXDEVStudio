<script setup lang="ts">
/**
 * The map editor's paint-mode sidebar: the colour to paint with, the write
 * mode, and the tile budget. Three readouts of session state and three
 * setters. Every decision — what a stroke resolves to, whether a colour is
 * legal on a row, what the budget says — lives in `session.ts`, which is
 * tested; this file is not, so it holds none.
 */
import { computed } from 'vue'
import { paletteToRgb, toHex } from '../../../../shared/msx/palette'
import {
  declinePromotion,
  paintBudgetLabel,
  PROMOTION_PROMPT,
  promoteToBanked,
  setPaintColor,
  setPaintWrite,
  type MapSession
} from './session'

const props = defineProps<{ session: MapSession }>()

/** The tileset's own palette — programmable on V9938, the fixed MSX1 set otherwise — read as the tile editor reads it. */
const rgb = computed(() => paletteToRgb(props.session.tileset?.palette ?? null))
const budget = computed(() => paintBudgetLabel(props.session))
</script>

<template>
  <div class="paint">
    <section>
      <h3>Colour</h3>
      <div class="swatches">
        <button
          v-for="(color, index) in rgb"
          :key="index"
          type="button"
          class="swatch"
          :class="{ current: session.paintColor === index, transparent: index === 0 }"
          :style="{ background: toHex(color) }"
          :title="index === 0 ? '0 — transparent' : `Colour ${index}`"
          @click="setPaintColor(session, index)"
        >
          <span>{{ index }}</span>
        </button>
      </div>
      <p class="hint">
        <strong>Left</strong> button paints the ink of the row it touches, <strong>right</strong> its
        paper — the mode's two-colours-per-row rule, so a third colour replaces one of them rather than
        being refused.
      </p>
    </section>

    <section>
      <h3>Write</h3>
      <div
        class="write"
        role="group"
        aria-label="Write"
      >
        <button
          type="button"
          :class="{ active: session.paintWrite === 'fork' }"
          title="Paints a copy of the tile the stroke lands on, so every other cell showing that tile keeps its art. Costs a tile per changed cell."
          @click="setPaintWrite(session, 'fork')"
        >
          Fork tile
        </button>
        <button
          type="button"
          :class="{ active: session.paintWrite === 'edit' }"
          title="Rewrites this tile everywhere it is used, in this map and any other map on this tileset."
          @click="setPaintWrite(session, 'edit')"
        >
          Edit tile
        </button>
      </div>
      <p class="hint">
        {{
          session.paintWrite === 'fork'
            ? 'Fork: the stroke gets its own tiles, and cells sharing the old ones are untouched.'
            : 'Edit: the stroke changes the tile itself, and every cell showing it changes with it.'
        }}
      </p>
    </section>

    <section>
      <h3>Budget</h3>
      <p class="budget">
        {{ budget }}
      </p>
    </section>

    <!-- Raised once by a refused stroke (`offerPromotion`); either button clears it. -->
    <section
      v-if="session.promptPromote"
      class="promote"
    >
      <h3>Out of tiles</h3>
      <p class="hint">
        {{ PROMOTION_PROMPT }}
      </p>
      <div class="write">
        <button
          type="button"
          class="accept"
          @click="promoteToBanked(session)"
        >
          Switch to banked
        </button>
        <button
          type="button"
          @click="declinePromotion(session)"
        >
          Not now
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
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
  position: relative;
  height: 22px;
  border: 1px solid var(--color-border);
  border-radius: 2px;
  cursor: pointer;
}

.swatch span {
  position: absolute;
  right: 1px;
  bottom: 0;
  font-size: 8px;
  color: rgba(255, 255, 255, 0.75);
  text-shadow: 0 0 2px #000000;
}

.swatch.current {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

.swatch.transparent {
  background-image: linear-gradient(45deg, transparent 45%, #ff6666 45%, #ff6666 55%, transparent 55%);
}

.write {
  display: flex;
  gap: 4px;
}

.write button {
  flex: 1;
  padding: 3px 6px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-hover);
  color: var(--color-text);
  font-size: 11px;
}

.write button.active {
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: #ffffff;
}

.hint {
  margin: 4px 0;
  font-size: 10px;
  color: var(--color-text-muted);
}

.budget {
  margin: 0;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  white-space: pre-wrap;
}

.promote {
  padding: 6px;
  border: 1px solid var(--color-accent);
  border-radius: 3px;
}

.promote .hint {
  color: var(--color-text);
}

.write button.accept {
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: #ffffff;
}
</style>
