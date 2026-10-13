<script setup lang="ts">
/**
 * The `*.meta-tiles.json` tab: the pose editor for a meta that owns its
 * pixels, the meta editor for a version-2 one that references a tileset —
 * whichever the file is (`./format`). Mounted only once that is known, so
 * neither editor ever opens the other's file.
 */
import { computed, watch } from 'vue'
import { useTabsStore } from '../../stores/tabsStore'
import AnimTileEditorTab from '../anim/AnimTileEditorTab.vue'
import MetaTileEditorTab from './MetaTileEditorTab.vue'
import { metaFormat, sniffMetaFormat } from './format'

const tabsStore = useTabsStore()
const path = computed(() => tabsStore.activeTab?.filePath ?? '')
const format = computed(() => metaFormat(path.value))

watch(
  path,
  (current) => {
    if (current) void sniffMetaFormat(current)
  },
  { immediate: true }
)
</script>

<template>
  <AnimTileEditorTab
    v-if="format === 'owned'"
    :key="`owned:${path}`"
  />
  <MetaTileEditorTab
    v-else-if="format === 'refs'"
    :key="`refs:${path}`"
  />
  <p
    v-else
    class="opening"
  >
    Opening…
  </p>
</template>

<style scoped>
.opening {
  padding: 16px;
  opacity: 0.7;
}
</style>
