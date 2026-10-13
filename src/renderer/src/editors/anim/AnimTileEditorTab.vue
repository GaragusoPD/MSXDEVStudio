<script setup lang="ts">
/**
 * The `*.anim-tiles.json` editor — an animated tile's poses, their timing, and
 * where the animation is attached — and, with three more controls, the editor
 * of a `*.meta-tiles.json` that owns its pixels: the same poses plus which
 * cells are see-through and the meta's eight flags (`session.kind`).
 *
 * A shell: the canvas, the pose strip and the side panel are their own
 * components, and every mutation is a call into `./session`.
 */
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { movingCells } from '../../../../shared/msx/meta-owned'
import type { MaterialSymbol } from '@material-symbols/font-400'
import { isTypingTarget } from '../../commands'
import type { TileTool } from '../../../../shared/tile-editor'
import Icon from '../../components/Icon.vue'
import { useResourcesStore } from '../../stores/resourcesStore'
import { useTabsStore } from '../../stores/tabsStore'
import AnimCanvas from './AnimCanvas.vue'
import AnimFrameBar from './AnimFrameBar.vue'
import AnimSidePanel from './AnimSidePanel.vue'
import {
  animSession,
  canRedo,
  canUndo,
  doc,
  ownedMeta,
  pruneAnimSessions,
  redo,
  saveSession,
  setHoleMode,
  setTool,
  setZoom,
  undo,
  type AnimSession
} from './session'

// `EditorArea` mounts `<component :is>` with no props — every editor reads the
// active tab for itself.
const tabsStore = useTabsStore()
const resourcesStore = useResourcesStore()

const path = computed(() => tabsStore.activeTab?.filePath ?? '')
const session = computed<AnimSession>(() => animSession(path.value))
const anim = computed(() => doc(session.value))
const meta = computed(() => ownedMeta(session.value))

function pickTool(tool: TileTool): void {
  setHoleMode(session.value, false)
  setTool(session.value, tool)
}

const TOOLS: { id: TileTool; icon: MaterialSymbol; title: string }[] = [
  { id: 'pencil', icon: 'edit', title: 'Pencil' },
  { id: 'line', icon: 'pen_size_1', title: 'Line' },
  { id: 'rect', icon: 'rectangle', title: 'Rectangle' },
  { id: 'fill', icon: 'format_color_fill', title: 'Fill' }
]

async function save(): Promise<void> {
  await saveSession(session.value)
}

async function exportNow(): Promise<void> {
  await save()
  await resourcesStore.exportOne(session.value.path)
}

function onKeydown(event: KeyboardEvent): void {
  if (isTypingTarget(event)) return
  if (!event.ctrlKey) return
  const key = event.key.toLowerCase()
  if (key === 'z' && !event.shiftKey) {
    event.preventDefault()
    undo(session.value)
  } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
    event.preventDefault()
    redo(session.value)
  } else if (key === 's') {
    event.preventDefault()
    void save()
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

watch(
  () => tabsStore.tabs.length,
  () => pruneAnimSessions(new Set(tabsStore.tabs.map((tab) => tab.filePath ?? ''))),
  { immediate: true }
)
</script>

<template>
  <div class="anim-editor">
    <p
      v-if="session.error"
      class="banner error"
    >
      {{ session.error }}
    </p>

    <header class="toolbar">
      <div class="group">
        <button
          v-for="tool in TOOLS"
          :key="tool.id"
          type="button"
          :class="{ active: !session.holeMode && session.tool === tool.id }"
          :title="tool.title"
          @click="pickTool(tool.id)"
        >
          <Icon :name="tool.icon" />
        </button>
        <button
          v-if="session.kind === 'metatiles'"
          type="button"
          :class="{ active: session.holeMode }"
          title="See-through cells: click a cell to let what is under the meta show there, in every pose"
          @click="setHoleMode(session, !session.holeMode)"
        >
          <Icon name="texture" />
        </button>
      </div>

      <div class="group">
        <button
          type="button"
          title="Undo (Ctrl+Z)"
          :disabled="!canUndo(session.history)"
          @click="undo(session)"
        >
          <Icon name="undo" />
        </button>
        <button
          type="button"
          title="Redo (Ctrl+Y)"
          :disabled="!canRedo(session.history)"
          @click="redo(session)"
        >
          <Icon name="redo" />
        </button>
        <button
          type="button"
          title="Zoom out"
          @click="setZoom(session, session.zoom - 4)"
        >
          <Icon name="zoom_out" />
        </button>
        <button
          type="button"
          title="Zoom in"
          @click="setZoom(session, session.zoom + 4)"
        >
          <Icon name="zoom_in" />
        </button>
      </div>

      <div class="group right">
        <span class="status">{{ session.status }}</span>
        <button
          type="button"
          @click="save"
        >
          Save
        </button>
        <button
          type="button"
          :disabled="!anim.export"
          title="Save, then write the C header"
          @click="exportNow"
        >
          Export
        </button>
      </div>
    </header>

    <div class="body">
      <div class="centre">
        <AnimCanvas :session="session" />
        <AnimFrameBar :session="session" />
      </div>
      <AnimSidePanel :session="session" />
    </div>

    <footer class="statusbar">
      {{ anim.mode.toUpperCase() }} · {{ anim.width }}×{{ anim.height }} tiles ·
      <template v-if="meta">
        {{ meta.holes.filter(Boolean).length }} see-through, {{ movingCells(meta).length }} moving ·
      </template>
      pose {{ session.frame + 1 }} of {{ anim.frames.length }}, held {{ anim.frames[session.frame]?.duration }} frames
    </footer>
  </div>
</template>

<style scoped>
.anim-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border, #333);
}

.group {
  display: flex;
  align-items: center;
  gap: 4px;
}

.group.right {
  margin-left: auto;
}

.toolbar button.active {
  outline: 2px solid #ffd24e;
}

.status {
  font-size: 11px;
  opacity: 0.8;
  max-width: 42ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.centre {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.banner {
  margin: 0;
  padding: 6px 10px;
  font-size: 12px;
}

.banner.error {
  background: #3a2020;
  color: #ffb0b0;
}

.statusbar {
  padding: 4px 10px;
  font-size: 11px;
  opacity: 0.7;
  border-top: 1px solid var(--border, #333);
}
</style>
