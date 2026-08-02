<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '../stores/appStore'

interface ActivityItem {
  key: string
  label: string
  route: string
  icon: string
}

// Small hand-rolled placeholder icons (24x24, stroke-based) — no icon library.
const ICONS: Record<string, string> = {
  explorer:
    '<path d="M3 6.5C3 5.67 3.67 5 4.5 5h4.379a1.5 1.5 0 0 1 1.06.44L11.5 7H19.5c.83 0 1.5.67 1.5 1.5v9c0 .83-.67 1.5-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-11Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
  search:
    '<circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="15.2" y1="15.2" x2="20.5" y2="20.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  git: '<line x1="6" y1="3" x2="6" y2="15" stroke="currentColor" stroke-width="1.5"/><circle cx="18" cy="6" r="2.5" stroke="currentColor" stroke-width="1.5" fill="none"/><circle cx="6" cy="18" r="2.5" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M18 8.5a6 6 0 0 1-6 6H9" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>',
  resources:
    '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8.5" cy="9.5" r="1.5" fill="currentColor"/><path d="M4 16.5l4.5-4.5 3 3 4-5L20.5 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>',
  run: '<path d="M7 4.5v15l13-7.5-13-7.5Z" fill="currentColor"/>',
  examples:
    '<rect x="3.5" y="3.5" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  settings:
    '<circle cx="12" cy="12" r="2.75" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12 4.2v2.1M12 17.7v2.1M19.8 12h-2.1M6.3 12H4.2M17.4 6.6l-1.5 1.5M8.1 15.9l-1.5 1.5M17.4 17.4l-1.5-1.5M8.1 8.1 6.6 6.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'
}

const items: ActivityItem[] = [
  { key: 'explorer', label: 'Explorer', route: '/explorer', icon: ICONS.explorer },
  { key: 'search', label: 'Search', route: '/search', icon: ICONS.search },
  { key: 'git', label: 'Git', route: '/git', icon: ICONS.git },
  { key: 'resources', label: 'Resources', route: '/resources', icon: ICONS.resources },
  { key: 'run', label: 'Run', route: '/run', icon: ICONS.run },
  { key: 'examples', label: 'Examples', route: '/examples', icon: ICONS.examples }
]

const settingsItem: ActivityItem = { key: 'settings', label: 'Toolchain Settings', route: '/settings', icon: ICONS.settings }

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
      <!-- eslint-disable vue/no-v-html -- item.icon is a hard-coded constant above, not user input -->
      <svg
        viewBox="0 0 24 24"
        width="22"
        height="22"
        v-html="item.icon"
      />
      <!-- eslint-enable vue/no-v-html -->
    </button>

    <button
      class="activity-item settings-item"
      :class="{ active: isActive(settingsItem) }"
      :title="settingsItem.label"
      type="button"
      @click="onClick(settingsItem)"
    >
      <!-- eslint-disable vue/no-v-html -- settingsItem.icon is a hard-coded constant above, not user input -->
      <svg
        viewBox="0 0 24 24"
        width="22"
        height="22"
        v-html="settingsItem.icon"
      />
      <!-- eslint-enable vue/no-v-html -->
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
