<script setup lang="ts">
/**
 * The map sidebar's lower half: the meta-tiles this map can place.
 *
 * On a pattern map, every meta-tile in a mode the map's tileset can show is
 * offered — attached there already, or attached by picking it. On a bitmap map,
 * only the bitmap metas made of *its* tileset's tiles: their cells are tile
 * indices, which would name other art anywhere else.
 *
 * Picking one arms the brush; the next click on the canvas places it.
 */
import { computed } from 'vue'
import { metaThumbnail } from './sheet'
import { doc, metaRowOffsets, pickMeta, sheet, unattachedMetas, type MapSession } from './session'

const props = defineProps<{ session: MapSession }>()

const metas = computed(() => [...props.session.metaDocs.entries()])
const attachable = computed(() => unattachedMetas(props.session))

/**
 * Frame 0 as a data URL, composed from the tileset's own sheet. No placement
 * to anchor to here — `baseRow: null` keeps this showing whichever bank the
 * picker currently has selected (`metaRowOffsets`), the same bank
 * `MapPicker`'s own tile grid shows.
 */
function thumbnail(path: string): string {
  const base = sheet(props.session)
  const meta = props.session.metaDocs.get(path)
  if (!base || !meta) return ''
  return metaThumbnail(base, meta, 0, metaRowOffsets(props.session, null, meta.height)).toDataURL()
}

function label(path: string): string {
  return (path.split(/[\\/]/).pop() ?? path).replace(/\.meta-b?tiles\.json$/i, '')
}
</script>

<template>
  <section class="meta-picker">
    <header>
      <span class="title">Meta-tiles</span>
      <span class="readout">{{ metas.length + attachable.length }}</span>
    </header>

    <p
      v-if="!doc(session).tileset"
      class="hint"
    >
      Pick a tileset first.
    </p>
    <p
      v-else-if="!metas.length && !attachable.length"
      class="hint"
    >
      <template v-if="doc(session).cell">
        No meta-tiles over <code>{{ doc(session).tileset }}</code> yet. Create a
        <code>.meta-btiles.json</code> and point it at this tileset.
      </template>
      <template v-else>
        No meta-tiles yet. Create a <code>.meta-tiles.json</code> — any one in this tileset's mode can be
        placed here.
      </template>
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
      <button
        v-for="path in attachable"
        :key="path"
        type="button"
        class="entry unattached"
        :title="`${path} — not attached to ${doc(session).tileset} yet: picking it attaches it`"
        @click="pickMeta(session, path)"
      >
        <span class="name">{{ label(path) }}</span>
        <span class="frames">+</span>
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
  flex: 0 1 auto;
  flex-direction: column;
  min-height: 0;
  width: 100%;
  border-top: 1px solid var(--color-border);
}

/* Deliberately identical to MapPicker's header: they are two halves of one rail. */
header {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--color-border);
  font-size: 11px;
}

.title {
  color: var(--color-text-muted);
}

.readout {
  margin-left: auto;
  font-family: var(--font-mono);
  color: var(--color-text-muted);
}

.grid {
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: 6px;
  min-height: 0;
  padding: 8px;
  overflow-x: hidden;
  overflow-y: auto;
  scrollbar-gutter: stable;
}

.entry {
  position: relative;
  display: grid;
  place-items: center;
  gap: 2px;
  min-width: 56px;
  padding: 4px;
  background: var(--color-bg-tab-inactive);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 3px;
  font-size: 11px;
  cursor: pointer;
}

.entry:hover {
  background: var(--color-bg-hover);
}

.entry.unattached {
  border-style: dashed;
  opacity: 0.8;
}

.entry.active {
  border-color: var(--color-accent);
}

.entry img {
  image-rendering: pixelated;
  max-width: 48px;
  max-height: 48px;
}

.entry .name {
  max-width: 56px;
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Frame count, in the corner: it is metadata, not part of the picture. */
.entry .frames {
  position: absolute;
  top: 2px;
  right: 3px;
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: 9px;
}

/* Fixed, so shrinking the pane scrolls the grid rather than crushing the text. */
.hint {
  flex: none;
  margin: 0;
  padding: 6px 8px;
  font-size: 11px;
  color: var(--color-text-muted);
}
</style>
