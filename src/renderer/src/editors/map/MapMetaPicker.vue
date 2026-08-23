<script setup lang="ts">
/**
 * The map sidebar's lower half: the meta-tiles this map can place.
 *
 * Only metas drawn over *this map's* tileset are offered. A meta's cells are
 * tile indices, so one built over a different bank names tiles that either do
 * not exist here or are different art — placing it would paint garbage, and the
 * user would have no way to see why.
 *
 * Picking one arms the brush; the next click on the canvas places it.
 */
import { computed } from 'vue'
import { metaThumbnail } from './sheet'
import { doc, pickMeta, sheet, type MapSession } from './session'

const props = defineProps<{ session: MapSession }>()

const metas = computed(() => [...props.session.metaDocs.entries()])

/** Frame 0 as a data URL, composed from the tileset's own sheet. */
function thumbnail(path: string): string {
  const base = sheet(props.session)
  const meta = props.session.metaDocs.get(path)
  if (!base || !meta) return ''
  return metaThumbnail(base, meta).toDataURL()
}

function label(path: string): string {
  return (path.split(/[\\/]/).pop() ?? path).replace(/\.meta-b?tiles\.json$/i, '')
}
</script>

<template>
  <section class="meta-picker">
    <header>
      <span class="title">Meta-tiles</span>
      <span class="readout">{{ metas.length }}</span>
    </header>

    <p
      v-if="!doc(session).tileset"
      class="hint"
    >
      Pick a tileset first.
    </p>
    <p
      v-else-if="!metas.length"
      class="hint"
    >
      No meta-tiles over <code>{{ doc(session).tileset }}</code> yet. Create a
      <code>{{ doc(session).cell ? '.meta-btiles.json' : '.meta-tiles.json' }}</code> and point it
      at this tileset.
    </p>

    <div
      v-else
      class="grid"
    >
      <button
        v-for="[path, meta] in metas"
        :key="path"
        type="button"
        class="entry"
        :class="{ active: session.brushMeta === path }"
        :title="`${path} — ${meta.width}×${meta.height} tiles, ${meta.frames.length} frame${meta.frames.length === 1 ? '' : 's'}`"
        @click="pickMeta(session, path)"
      >
        <img
          v-if="thumbnail(path)"
          :src="thumbnail(path)"
          alt=""
        >
        <span class="name">{{ label(path) }}</span>
        <span
          v-if="meta.frames.length > 1"
          class="frames"
        >{{ meta.frames.length }}f</span>
      </button>
    </div>

    <p
      v-if="session.brushMeta"
      class="hint"
    >
      Click the map to place it. Click a placed meta-tile to select it, drag to move, Delete to
      remove.
    </p>
  </section>
</template>

<style scoped>
.meta-picker {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 8px;
  border-top: 1px solid var(--border, #333);
}

header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 6px;
  font-size: 12px;
}

.title {
  text-transform: uppercase;
  opacity: 0.7;
}

.readout {
  opacity: 0.6;
}

.grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  overflow-y: auto;
}

.entry {
  position: relative;
  display: grid;
  place-items: center;
  gap: 2px;
  min-width: 56px;
  padding: 4px;
  background: #2a2a2a;
  border: 1px solid var(--border, #444);
  border-radius: 3px;
  cursor: pointer;
}

.entry.active {
  border-color: #ffd24e;
}

.entry img {
  image-rendering: pixelated;
  max-width: 48px;
  max-height: 48px;
}

.entry .name {
  max-width: 56px;
  overflow: hidden;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.entry .frames {
  position: absolute;
  top: 2px;
  right: 3px;
  font-size: 9px;
  opacity: 0.7;
}

.hint {
  margin: 6px 0 0;
  font-size: 11px;
  opacity: 0.75;
}
</style>
