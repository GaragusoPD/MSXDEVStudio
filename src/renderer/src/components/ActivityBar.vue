<script setup lang="ts">
import type { MaterialSymbol } from '@material-symbols/font-400'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '../stores/appStore'
import Icon from './Icon.vue'

interface ActivityItem {
  key: string
  label: string
  route: string
  icon: MaterialSymbol
}

const items: ActivityItem[] = [
  { key: 'explorer', label: 'Explorer', route: '/explorer', icon: 'folder' },
  { key: 'search', label: 'Search', route: '/search', icon: 'search' },
  { key: 'git', label: 'Git', route: '/git', icon: 'account_tree' },
  { key: 'resources', label: 'Resources', route: '/resources', icon: 'imagesmode' },
  { key: 'run', label: 'Run', route: '/run', icon: 'play_arrow' },
  { key: 'examples', label: 'Examples', route: '/examples', icon: 'grid_view' }
]

const settingsItem: ActivityItem = { key: 'settings', label: 'Toolchain Settings', route: '/settings', icon: 'settings' }

const route = useRoute()
const router = useRouter()
const appStore = useAppStore()

function isActive(item: ActivityItem): boolean {
  return route.path === item.route && appStore.panelLayout.sideVisible
}

// Clicking the already-active icon collapses the side panel (VS Code
// behavior); clicking any other icon navigates and ensures it's visible.
function onClick(item: ActivityItem): void {
  if (route.path === item.route && appStore.panelLayout.sideVisible) {
    appStore.toggleSidePanel()
    return
  }
  if (!appStore.panelLayout.sideVisible) appStore.toggleSidePanel()
  void router.push(item.route)
}
</script>

<template>
  <nav class="activity-bar">
    <button
      v-for="item in items"
      :key="item.key"
      class="activity-item"
      :class="{ active: isActive(item) }"
      :title="item.label"
      type="button"
      @click="onClick(item)"
    >
      <Icon
        :name="item.icon"
        :size="22"
      />
    </button>

    <button
      class="activity-item settings-item"
      :class="{ active: isActive(settingsItem) }"
      :title="settingsItem.label"
      type="button"
      @click="onClick(settingsItem)"
    >
      <Icon
        :name="settingsItem.icon"
        :size="22"
      />
    </button>
  </nav>
</template>

<style scoped>
.activity-bar {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 48px;
  background: var(--color-bg-activitybar);
  padding-top: 8px;
  gap: 4px;
}

.activity-item {
  width: 48px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-muted);
  position: relative;
}

.activity-item:hover {
  color: var(--color-text);
}

.activity-item.active {
  color: var(--color-text);
}

.activity-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 2px;
  background: var(--color-text);
}

.settings-item {
  margin-top: auto;
  margin-bottom: 8px;
}
</style>
