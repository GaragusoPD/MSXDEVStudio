<script setup lang="ts">
import TerminalView from '../../components/TerminalView.vue'
import { useTabsStore } from '../../stores/tabsStore'

/**
 * A terminal opened in the editor area. The tab id *is* the session id; the
 * `key` is what makes switching between two terminal tabs remount the view,
 * since Vue would otherwise reuse this same component instance and leave the
 * first terminal on screen.
 */
const tabsStore = useTabsStore()
</script>

<template>
  <TerminalView
    :id="tabsStore.activeTabId"
    :key="tabsStore.activeTabId"
  />
</template>
