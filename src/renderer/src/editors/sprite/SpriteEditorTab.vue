<script setup lang="ts">
import type { MaterialSymbol } from '@material-symbols/font-400'
/**
 * Spec 09 — the `.sprites.json` editor tab: sprite list, paint canvas with an
 * active-layer picker, per-layer color controls, and the animation filmstrip.
 *
 * Registered for the `sprites.json` compound extension in
 * `editors/bootstrap.ts`, so the explorer opens sprite sheets here instead of
 * in Monaco.
 */
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { mirrorLayer, scanlineBudget, shiftLayer, updateLayer, type SpriteTool } from '../../../../shared/sprite-editor'
import { useResourcesStore } from '../../stores/resourcesStore'
import { useTabsStore } from '../../stores/tabsStore'
import SpriteAnimationBar from './SpriteAnimationBar.vue'
import SpriteCanvas from './SpriteCanvas.vue'
import SpriteLayerPanel from './SpriteLayerPanel.vue'
import SpriteList from './SpriteList.vue'
import Icon from '../../components/Icon.vue'
import { isTypingTarget } from '../../commands'
import {
  canRedo,
  canUndo,
  commit,
  doc,
  pruneSpriteSessions,
  redo,
  saveSession,
  selectFrame,
  selectLayer,
  selectSprite,
  spriteSession,
  swapHiddenLayers,
  toggleLayerHidden,
  undo
} from './session'

const tabsStore = useTabsStore()
const resourcesStore = useResourcesStore()

const path = computed(() => tabsStore.activeTab?.filePath ?? '')
const session = computed(() => spriteSession(path.value))
const budget = computed(() => scanlineBudget(doc(session.value)))

const TOOLS: { id: SpriteTool; icon: MaterialSymbol; title: string }[] = [
  { id: 'pencil', icon: 'edit', title: 'Pencil' },
  { id: 'erase', icon: 'ink_eraser', title: 'Erase' },
  { id: 'line', icon: 'pen_size_1', title: 'Line' },
  { id: 'fill', icon: 'format_color_fill', title: 'Fill' }
]

async function save(): Promise<void> {
  try {
    await saveSession(session.value)
  } catch (error) {
    session.value.status = `Save failed: ${String(error)}`
  }
}

/** Export goes through Spec 07's converter, so the file on disk has to be current first. */
async function exportNow(): Promise<void> {
  await save()
  await resourcesStore.exportOne(session.value.path)
}

function mirror(axis: 'x' | 'y'): void {
  const active = session.value
  commit(active, updateLayer(doc(active), active.selection, (layer) => mirrorLayer(layer, doc(active).size, axis)))
}

function shift(dx: number, dy: number): void {
  const active = session.value
  commit(active, updateLayer(doc(active), active.selection, (layer) => shiftLayer(layer, doc(active).size, dx, dy)))
}

function onKeydown(event: KeyboardEvent): void {
  // Typing a filename in a side panel is not an editor shortcut.
  if (isTypingTarget(event)) return
  if (!event.ctrlKey) return
  const key = event.key.toLowerCase()
  // Ctrl+S is EditorArea's, for every tab kind — see `commands.ts`.
  if (key === 'z' && !event.shiftKey) {
    event.preventDefault()
    undo(session.value)
  } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
    event.preventDefault()
    redo(session.value)
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

// Sessions outlive tab switches (like Monaco models do); drop the ones whose tab is gone.
watch(
  () => tabsStore.tabs.length,
  () => pruneSpriteSessions(new Set(tabsStore.tabs.map((tab) => tab.filePath ?? ''))),
  { immediate: true }
)
</script>

<template>
  <div class="sprite-editor">
    <p
      v-if="session.error"
      class="error"
    >
      {{ session.error }}
    </p>
    <template v-else-if="!session.loading">
      <div class="toolbar">
        <button
          v-for="tool in TOOLS"
          :key="tool.id"
          type="button"
          :class="{ active: session.tool === tool.id }"
          :title="tool.title"
          @click="session.tool = tool.id"
        >
          <Icon :name="tool.icon" />
        </button>

        <span class="sep" />
        <button
          type="button"
          title="Mirror horizontally"
          @click="mirror('x')"
        >
          <Icon name="swap_horiz" />
        </button>
        <button
          type="button"
          title="Mirror vertically"
          @click="mirror('y')"
        >
          <Icon name="swap_vert" />
        </button>
        <button
          type="button"
          title="Shift left (wraps)"
          @click="shift(-1, 0)"
        >
          <Icon name="arrow_back" />
        </button>
        <button
          type="button"
          title="Shift right (wraps)"
          @click="shift(1, 0)"
        >
          <Icon name="arrow_forward" />
        </button>
        <button
          type="button"
          title="Shift up (wraps)"
          @click="shift(0, -1)"
        >
          <Icon name="arrow_upward" />
        </button>
        <button
          type="button"
          title="Shift down (wraps)"
          @click="shift(0, 1)"
        >
          <Icon name="arrow_downward" />
        </button>

        <span class="sep" />
        <button
          type="button"
          title="Undo (Ctrl+Z)"
          :disabled="!canUndo(session)"
          @click="undo(session)"
        >
          <Icon name="undo" />
        </button>
        <button
          type="button"
          title="Redo (Ctrl+Y)"
          :disabled="!canRedo(session)"
          @click="redo(session)"
        >
          <Icon name="redo" />
        </button>

        <span class="spacer" />
        <button
          type="button"
          :disabled="!session.dirty"
          @click="save"
        >
          {{ session.dirty ? 'Save' : 'Saved' }}
        </button>
        <button
          type="button"
          title="Write the pattern/color tables this sprite sheet exports"
          @click="exportNow"
        >
          Export
        </button>
      </div>

      <p
        v-if="budget.exceeded"
        class="scanline-hint"
      >
        <Icon
          name="warning"
          :size="14"
        />
        {{ budget.total }} hardware sprite planes across all characters (frame 0) — more than
        {{ budget.limit }} on the same scanline will be dropped by the VDP. Informational only.
      </p>

      <p class="draw-hint">
        Left click draws, right click erases.
      </p>

      <div class="panes">
        <SpriteList
          :doc="doc(session)"
          :active="session.selection.sprite"
          @select="selectSprite(session, $event)"
          @mutate="commit(session, $event)"
        />
        <SpriteCanvas
          :doc="doc(session)"
          :target="session.selection"
          :tool="session.tool"
          :onion-skin="session.onionSkin"
          :hidden-layers="session.hiddenLayers"
          @commit="commit(session, $event)"
          @select-layer="selectLayer(session, $event)"
        />
        <SpriteLayerPanel
          :doc="doc(session)"
          :target="session.selection"
          :hidden-layers="session.hiddenLayers"
          @select-layer="selectLayer(session, $event)"
          @mutate="commit(session, $event)"
          @toggle-layer="toggleLayerHidden(session, $event)"
          @move-layer="swapHiddenLayers(session, $event.from, $event.to)"
        />
      </div>

      <SpriteAnimationBar
        v-model:fps="session.fps"
        v-model:playing="session.playing"
        v-model:background="session.background"
        v-model:onion-skin="session.onionSkin"
        :doc="doc(session)"
        :target="session.selection"
        @select-frame="selectFrame(session, $event)"
        @mutate="commit(session, $event)"
      />

      <p
        v-if="session.status"
        class="status"
      >
        {{ session.status }}
      </p>
    </template>
  </div>
</template>

<style scoped>
.sprite-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--color-border);
  flex-wrap: wrap;
}

.toolbar button {
  min-width: 24px;
  padding: 2px 6px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-hover);
  font-size: 12px;
}

.toolbar button.active {
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: #ffffff;
}

.toolbar button:disabled {
  opacity: 0.4;
  cursor: default;
}

.sep {
  width: 1px;
  align-self: stretch;
  margin: 0 4px;
  background: var(--color-border);
}

.spacer {
  flex: 1;
}

.draw-hint {
  margin: 0 0 4px;
  padding: 0 10px;
  font-size: 11px;
  color: var(--color-text-muted);
}

/* Flex rather than an inline glyph: the icon aligns to the sentence instead of
   sitting on its baseline, which reads low against 11px text. */
.scanline-hint {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 0;
  padding: 4px 10px;
  border-bottom: 1px solid var(--color-border);
  background: rgba(230, 160, 30, 0.12);
  color: var(--color-text);
  font-size: 11px;
}

.panes {
  flex: 1;
  min-height: 0;
  display: flex;
}

.status,
.error {
  margin: 0;
  padding: 5px 10px;
  border-top: 1px solid var(--color-border);
  font-size: 11px;
  color: var(--color-text-muted);
}

.error {
  color: var(--color-error, #f14c4c);
}
</style>
