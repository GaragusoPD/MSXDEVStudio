<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useAppStore } from '../stores/appStore'
import { useProjectStore } from '../stores/projectStore'
import { useTabsStore } from '../stores/tabsStore'
import { useToolchainStore } from '../stores/toolchainStore'

const appStore = useAppStore()
const projectStore = useProjectStore()
const tabsStore = useTabsStore()
const toolchainStore = useToolchainStore()
const router = useRouter()

function baseName(path: string): string {
  return path.split(/[/\\]/).pop() ?? path
}

/** The `.msxproj` is registered as an editor type, so opening the file *is* the settings UI. */
function openProjectSettings(): void {
  const file = projectStore.open?.projectFile
  if (file) tabsStore.openFile(file, file)
}

function openToolchainSetup(): void {
  if (!appStore.panelLayout.sideVisible) appStore.toggleSidePanel()
  void router.push('/settings')
}
</script>

<template>
  <div class="welcome">
    <h1>MSXDEVStudio</h1>
    <p class="subtitle">
      A desktop IDE for MSX game development.
    </p>

    <div
      v-if="toolchainStore.needsSetup"
      class="setup-cta"
    >
      <span>MSXgl and/or openMSX aren't set up yet — building and running projects will be blocked.</span>
      <button
        type="button"
        @click="openToolchainSetup"
      >
        Set up toolchain
      </button>
    </div>

    <div class="actions">
      <button
        type="button"
        class="primary"
        @click="projectStore.newProject()"
      >
        New Project
      </button>
      <button
        type="button"
        @click="projectStore.openProject()"
      >
        Open Project…
      </button>
      <button
        v-if="projectStore.open"
        type="button"
        @click="openProjectSettings"
      >
        Project Settings
      </button>
      <button
        type="button"
        title="Copy the two demo games into a folder of your choice"
        @click="projectStore.installDemos()"
      >
        Install Demos…
      </button>
    </div>

    <div class="recent">
      <h2>Recent Projects</h2>
      <ul v-if="appStore.recentProjects.length">
        <li
          v-for="path in appStore.recentProjects"
          :key="path"
        >
          <button
            type="button"
            class="recent-item"
            @click="projectStore.openProject(path)"
          >
            <span class="recent-name">{{ baseName(path) }}</span>
            <span class="recent-path">{{ path }}</span>
          </button>
        </li>
      </ul>
      <p
        v-else
        class="empty"
      >
        No recent projects yet.
      </p>
    </div>
  </div>
</template>

<style scoped>
.welcome {
  height: 100%;
  overflow-y: auto;
  padding: 48px;
  max-width: 640px;
}

h1 {
  margin: 0;
  font-size: 28px;
  font-weight: 600;
}

.subtitle {
  color: var(--color-text-muted);
  margin: 4px 0 32px;
}

.setup-cta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  margin-bottom: 24px;
  border: 1px solid var(--color-accent);
  border-radius: 4px;
  background: var(--color-bg-hover);
  font-size: 12px;
}

.setup-cta button {
  padding: 6px 12px;
  border-radius: 4px;
  border: 1px solid var(--color-accent);
  background: var(--color-accent);
  color: #ffffff;
  white-space: nowrap;
}

.actions {
  display: flex;
  gap: 12px;
  margin-bottom: 40px;
}

button.primary,
.actions button {
  padding: 8px 16px;
  border-radius: 4px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-hover);
}

button.primary {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: #ffffff;
}

.recent h2 {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-text-muted);
  margin: 0 0 12px;
}

.recent ul {
  list-style: none;
  margin: 0;
  padding: 0;
}

.recent-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
  padding: 6px 8px;
  border-radius: 4px;
  text-align: left;
}

.recent-item:hover {
  background: var(--color-bg-hover);
}

.recent-name {
  color: var(--color-accent);
}

.recent-path {
  font-size: 11px;
  color: var(--color-text-muted);
}

.empty {
  color: var(--color-text-muted);
  font-size: 12px;
}
</style>
