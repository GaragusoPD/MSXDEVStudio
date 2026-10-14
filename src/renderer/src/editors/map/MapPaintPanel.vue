<script setup lang="ts">
/**
 * The map editor's paint-mode sidebar: the colour to paint with, the write
 * mode, the tile budget, and the tileset housekeeping (import a picture,
 * remove unused tiles, recalculate). Readouts of session state and calls into
 * it. Every decision — what a stroke resolves to, whether a colour is
 * legal on a row, what the budget says — lives in `session.ts`, which is
 * tested; this file is not, so it holds none.
 */
import { computed, ref } from 'vue'
import { paletteToRgb, toHex } from '../../../../shared/msx/palette'
import { isBanked, TILE_SIZE } from '../../../../shared/msx/tile'
import type { ScreenMode } from '../../../../shared/msx/modes'
import ImportImageDialog from '../../components/ImportImageDialog.vue'
import type { ImportResult } from '../../composables/useImageImport'
import { useResourcesStore } from '../../stores/resourcesStore'
import {
  declinePromotion,
  doc,
  floatPicture,
  paintBudgetLabel,
  PROMOTION_PROMPT,
  promoteToBanked,
  rebuildBanks,
  removeUnusedTiles,
  setPaintColor,
  setPaintWrite,
  type MapSession
} from './session'

const props = defineProps<{ session: MapSession }>()
const resourcesStore = useResourcesStore()

const banked = computed(() => (props.session.tileset ? isBanked(props.session.tileset) : false))
const importing = ref(false)
/** One housekeeping action at a time: each reads the project before it asks. */
const busy = ref(false)

async function run(action: () => Promise<void> | void): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    await action()
  } finally {
    busy.value = false
  }
}

/** The picture floats over the map; dropping it is what turns it into tiles (`dropFloat`). */
function onImported(result: ImportResult, _file: File | null, mode: ScreenMode): void {
  floatPicture(props.session, result, mode)
}

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

    <section>
      <h3>Tiles</h3>
      <div class="actions">
        <button
          type="button"
          :disabled="busy"
          title="Convert a picture to this tileset's mode and drag it into place on the active layer — it becomes tiles when you drop it (Enter, or click outside it)."
          @click="importing = true"
        >
          Import image…
        </button>
        <button
          type="button"
          :disabled="busy"
          title="Pick cells from a sheet of tiles and drag them into place on the active layer"
          @click="resourcesStore.sheetImport = { destination: 'map', target: session.path }"
        >
          Import sheet…
        </button>
        <template v-if="!banked">
          <button
            type="button"
            :disabled="busy"
            title="Delete the tiles no map or meta-tile in the project uses. Every file drawn with this tileset is renumbered to match."
            @click="run(() => removeUnusedTiles(session))"
          >
            Remove unused tiles
          </button>
          <button
            type="button"
            :disabled="busy"
            title="Remove unused tiles and merge tiles that draw the same pixels into one."
            @click="run(() => removeUnusedTiles(session, true))"
          >
            Recalculate tiles
          </button>
        </template>
        <button
          v-else
          type="button"
          :disabled="busy"
          title="Repack the three banks from what this screen shows: unused tiles go, identical ones merge."
          @click="run(() => rebuildBanks(session))"
        >
          Rebuild banks
        </button>
      </div>
      <p class="hint">
        Painting adds tiles as it goes and never gives one back. These tidy up:
        nothing on screen changes, only how many tiles it costs.
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

    <ImportImageDialog
      v-if="importing && session.tileset"
      :mode="session.tileset.mode"
      :fit-width="doc(session).width * TILE_SIZE"
      :fit-height="doc(session).height * TILE_SIZE"
      :standalone="false"
      lock-mode
      :current-palette="session.tileset.palette"
      current-palette-label="This tileset's palette"
      :prefer-current="session.tileset.palette !== null"
      use-label="Place this image"
      @close="importing = false"
      @imported="onImported"
    />
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

.actions {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.actions button {
  padding: 3px 6px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-hover);
  color: var(--color-text);
  font-size: 11px;
  text-align: left;
}

.actions button:disabled {
  opacity: 0.5;
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
