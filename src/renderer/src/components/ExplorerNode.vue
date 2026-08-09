<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { FsEntry } from '../../../shared/ipc'
import { extensionFor } from '../../../shared/file-kind'
import { useExplorerStore } from '../stores/explorerStore'
import { useTabsStore } from '../stores/tabsStore'
import { disposeModel } from '../editors/monaco-models'
import ContextMenu, { type ContextMenuItem } from './ContextMenu.vue'
import Icon from './Icon.vue'

const props = defineProps<{ entry: FsEntry; depth: number }>()

/** Left inset of a depth-0 row. Matches ExplorerPanel's `.header` padding, so
 *  the root folder starts on the same line as the "Explorer" title above it. */
const INDENT_BASE = 12

const explorerStore = useExplorerStore()
const tabsStore = useTabsStore()

const isRoot = computed(() => props.entry.path === '')
const isExpanded = computed(() => !!explorerStore.expanded[props.entry.path])
const children = computed(() => explorerStore.children[props.entry.path] ?? [])

const BADGES: Record<string, { label: string; color: string }> = {
  c: { label: 'C', color: '#3d7cc9' },
  h: { label: 'H', color: '#8a5ac9' },
  json: { label: '{}', color: '#c9a63d' },
  md: { label: 'M', color: '#3dc98f' },
  markdown: { label: 'M', color: '#3dc98f' },
  s: { label: 'A', color: '#c9673d' },
  asm: { label: 'A', color: '#c9673d' },
  'tiles.json': { label: 'T', color: '#c9457a' },
  'sprites.json': { label: 'S', color: '#c9457a' },
  'map.json': { label: 'M', color: '#c9457a' },
  'screen.json': { label: 'X', color: '#c9457a' },
  'sfx.json': { label: 'F', color: '#c9457a' }
}

const badge = computed(() => {
  const ext = extensionFor(props.entry.name)
  return BADGES[ext] ?? { label: ext ? ext[0].toUpperCase() : '•', color: '#5a5a5a' }
})

function onClick(): void {
  if (props.entry.isDirectory) void explorerStore.toggle(props.entry.path)
  else tabsStore.openFile(props.entry.path, props.entry.name)
}

// --- inline rename ---
const isRenaming = computed(
  () => explorerStore.editing?.mode === 'rename' && explorerStore.editing.target?.path === props.entry.path
)
const renameValue = ref('')
const renameInput = ref<HTMLInputElement>()
watch(isRenaming, (renaming) => {
  if (!renaming) return
  renameValue.value = explorerStore.editing?.initialName ?? ''
  void nextTick(() => renameInput.value?.select())
})
function commitRename(): void {
  void explorerStore.commitEdit(renameValue.value)
}

// --- inline create (as a synthetic first child while this node is the creation target) ---
const isCreatingHere = computed(
  () => explorerStore.editing?.mode !== 'rename' && explorerStore.editing?.parent === props.entry.path
)
const createValue = ref('')
const createInput = ref<HTMLInputElement>()
watch(isCreatingHere, (creating) => {
  if (!creating) return
  createValue.value = ''
  void nextTick(() => createInput.value?.focus())
})
function commitCreate(): void {
  void explorerStore.commitEdit(createValue.value)
}

// --- context menu ---
const menu = ref<{ x: number; y: number } | null>(null)
function onContextMenu(event: MouseEvent): void {
  menu.value = { x: event.clientX, y: event.clientY }
}

function parentOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
}

async function onDelete(): Promise<void> {
  if (!window.confirm(`Delete "${props.entry.name}"? This moves it to the OS trash.`)) return
  if (!props.entry.isDirectory) {
    const openTab = tabsStore.tabs.find((tab) => tab.filePath === props.entry.path)
    if (openTab) {
      disposeModel(openTab.id)
      tabsStore.close(openTab.id)
    }
  }
  await explorerStore.remove(props.entry)
}

const menuItems = computed<ContextMenuItem[]>(() => {
  const items: ContextMenuItem[] = []
  if (props.entry.isDirectory) {
    items.push({ label: 'New File', action: () => explorerStore.startCreate(props.entry.path, 'create-file') })
    items.push({ label: 'New Folder', action: () => explorerStore.startCreate(props.entry.path, 'create-folder') })
  }
  if (!isRoot.value) {
    items.push({ label: 'Rename', action: () => explorerStore.startRename(parentOf(props.entry.path), props.entry) })
  }
  items.push({ label: 'Reveal in File Manager', action: () => void window.api.invoke('fs:reveal', { path: props.entry.path }) })
  items.push({ label: 'Copy Path', action: () => void navigator.clipboard.writeText(props.entry.absolutePath) })
  if (!isRoot.value) {
    items.push({ label: 'Delete', danger: true, action: () => void onDelete() })
  }
  return items
})
</script>

<template>
  <li class="node">
    <div
      class="row"
      :style="{ paddingLeft: `${depth * 14 + INDENT_BASE}px` }"
      @click="onClick"
      @contextmenu.prevent.stop="onContextMenu"
    >
      <input
        v-if="isRenaming"
        ref="renameInput"
        v-model="renameValue"
        class="inline-input"
        @click.stop
        @keydown.enter="commitRename"
        @keydown.escape="explorerStore.cancelEdit()"
        @blur="commitRename"
      >
      <template v-else>
        <!-- Folders take the slot the file badge occupies, so names line up
             whatever the row holds; the glyph opens with the folder so the
             caret is not the only thing saying so. -->
        <Icon
          v-if="entry.isDirectory"
          class="folder-icon"
          :name="isExpanded ? 'folder_open' : 'folder'"
          :size="16"
        />
        <span
          v-else
          class="badge"
          :style="{ background: badge.color }"
        >{{ badge.label }}</span>
        <span class="name">{{ entry.name }}</span>
      </template>
    </div>

    <ul
      v-if="entry.isDirectory && isExpanded"
      class="children"
    >
      <li
        v-if="isCreatingHere"
        class="row"
        :style="{ paddingLeft: `${(depth + 1) * 14 + INDENT_BASE}px` }"
      >
        <input
          ref="createInput"
          v-model="createValue"
          class="inline-input"
          :placeholder="explorerStore.editing?.mode === 'create-folder' ? 'folder name' : 'file name'"
          @keydown.enter="commitCreate"
          @keydown.escape="explorerStore.cancelEdit()"
          @blur="commitCreate"
        >
      </li>
      <ExplorerNode
        v-for="child in children"
        :key="child.path"
        :entry="child"
        :depth="depth + 1"
      />
    </ul>

    <ContextMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :items="menuItems"
      @close="menu = null"
    />
  </li>
</template>

<style scoped>
.node {
  list-style: none;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding-right: 6px;
  white-space: nowrap;
  cursor: pointer;
}

.row:hover {
  background: var(--color-bg-hover);
}

/* Same 16px footprint as .badge, so folder and file rows share one text column. */
.folder-icon {
  width: 16px;
  color: var(--color-text-muted);
}

.badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 14px;
  padding: 0 2px;
  border-radius: 3px;
  font-size: 9px;
  font-weight: 600;
  color: #fff;
  flex-shrink: 0;
}

.name {
  overflow: hidden;
  text-overflow: ellipsis;
}

.children {
  margin: 0;
  padding: 0;
}

.inline-input {
  flex: 1;
  font: inherit;
  color: inherit;
  background: var(--color-bg-editor);
  border: 1px solid var(--color-accent);
  border-radius: 2px;
  padding: 1px 4px;
  min-width: 0;
}
</style>
