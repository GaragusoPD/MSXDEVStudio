<script setup lang="ts">
/**
 * The `.world.json` editor: a grid of rooms, each one a map that draws itself.
 * Click a cell to select it, double-click to open its room (or make a new one
 * in an empty cell), drag a room onto another cell to move it, drag a map from
 * the library onto a cell to place it. The side panel holds the map library
 * (every map in the project, with a preview, plus import), the selected room
 * and its doors, the grid size, the entity types, what the build would refuse,
 * what the ready-made C leaves to the game, and the export block.
 *
 * Registered for the `world.json` compound extension in `editors/bootstrap.ts`.
 * All the logic is in `./session.ts` and `shared/msx/world.ts`.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { colRowOf, neighbours, roomIds, NO_ROOM } from '../../../../shared/msx/world'
import { mapEntities, SCREEN_COLS, SCREEN_ROWS } from '../../../../shared/msx/map'
import { useResourcesStore } from '../../stores/resourcesStore'
import { useTabsStore } from '../../stores/tabsStore'
import Icon from '../../components/Icon.vue'
import { isTypingTarget } from '../../commands'
import {
  addDoor,
  addType,
  addUsedTypes,
  canRedo,
  canUndo,
  doc,
  importMaps,
  libraryMaps,
  moveRoom,
  newRoom,
  notices,
  openRoom,
  patchExport,
  placeRoom,
  problems,
  refreshThumbnails,
  pruneWorldSessions,
  redo,
  reloadRooms,
  removeDoor,
  removeType,
  resize,
  saveSession,
  select,
  setupExport,
  undeclaredTypes,
  undo,
  updateDoor,
  worldSession
} from './session'

const tabsStore = useTabsStore()
const resourcesStore = useResourcesStore()

const path = computed(() => tabsStore.activeTab?.filePath ?? '')
const session = computed(() => worldSession(path.value))
const world = computed(() => doc(session.value))

/** Pixels per grid cell: one screen's aspect, at a size that shows its art. A room of another size is fitted into it. */
const zoom = ref(4)
const cellSize = computed(() => ({
  width: SCREEN_COLS * zoom.value,
  height: SCREEN_ROWS * zoom.value
}))

const ids = computed(() => roomIds(world.value))
const links = computed(() => neighbours(world.value))
const maps = computed(() => {
  void resourcesStore.entries
  return libraryMaps()
})
const issues = computed(() => problems(session.value))
const leftToGame = computed(() => notices(session.value))
/** Which cells each map fills — the library marks maps already in the world. */
const placedIn = computed(() => {
  const counts = new Map<string, number>()
  for (const roomPath of world.value.cells) if (roomPath) counts.set(roomPath, (counts.get(roomPath) ?? 0) + 1)
  return counts
})
/** A cell's room size, for the door fields' limits — rooms are not all one size. */
const roomSizeAt = (cell: number): { width: number; height: number } => {
  const roomPath = world.value.cells[cell]
  const room = roomPath ? session.value.rooms.get(roomPath)?.doc : undefined
  return { width: room?.width ?? 256, height: room?.height ?? 256 }
}
const sizeOf = (roomPath: string): string => {
  const room = session.value.rooms.get(roomPath)?.doc
  return room ? `${room.width}×${room.height}` : ''
}

// New maps in the project show up in the library with a picture.
watch(
  () => resourcesStore.entries.length,
  () => void refreshThumbnails(session.value)
)
const undeclared = computed(() => undeclaredTypes(session.value))

const fileOf = (p: string): string => (p.split('/').pop() ?? p).replace(/\.map\.json$/i, '')

const selected = computed(() => {
  const cell = session.value.selected
  if (cell === null) return null
  const roomPath = world.value.cells[cell] ?? null
  const room = roomPath ? session.value.rooms.get(roomPath) : undefined
  return { cell, ...colRowOf(world.value, cell), path: roomPath, room: room?.doc ?? null, id: ids.value[cell] }
})

/** The doors in the selected room, with their index into the world's list (what the session edits by). */
const selectedDoors = computed(() => {
  const cell = session.value.selected
  return world.value.doors.map((door, index) => ({ door, index })).filter(({ door }) => door.room === cell)
})

/** Every cell holding a room, for a door's destination picker. */
const destinations = computed(() =>
  world.value.cells.flatMap((roomPath, cell) => {
    if (!roomPath) return []
    const { col, row } = colRowOf(world.value, cell)
    return [{ cell, label: `${col},${row} — ${fileOf(roomPath)}` }]
  })
)

/** Doors leading somewhere, per cell — shown as a badge, since adjacency is already the grid itself. */
const doorCount = computed(() => {
  const counts = new Map<number, number>()
  for (const door of world.value.doors) counts.set(door.room, (counts.get(door.room) ?? 0) + 1)
  return counts
})

/** The edges between two rooms that touch — drawn as a gap-bridge so connected regions read at a glance. */
function connected(cell: number, direction: 1 | 2): boolean {
  const id = ids.value[cell]
  return id !== NO_ROOM && links.value[id]?.[direction] !== NO_ROOM
}

function onCellClick(cell: number): void {
  select(session.value, cell)
}

async function onCellOpen(cell: number): Promise<void> {
  if (world.value.cells[cell]) openRoom(session.value, cell)
  else await newRoom(session.value, cell)
}

// Dragging a room onto another cell swaps the two; dragging a map from the
// library onto a cell puts it there.
let dragFrom: number | null = null
let dragMap: string | null = null
function onDragStart(cell: number, event: DragEvent): void {
  if (!world.value.cells[cell]) return
  dragFrom = cell
  dragMap = null
  event.dataTransfer?.setData('text/plain', String(cell))
}
function onLibraryDragStart(mapPath: string, event: DragEvent): void {
  dragMap = mapPath
  dragFrom = null
  event.dataTransfer?.setData('text/plain', mapPath)
}
function onDrop(cell: number): void {
  if (dragMap) {
    placeRoom(session.value, cell, dragMap)
    select(session.value, cell)
  } else if (dragFrom !== null && dragFrom !== cell) {
    moveRoom(session.value, dragFrom, cell)
  }
  dragFrom = null
  dragMap = null
}

/** A library map clicked: into the selected cell, when there is one. */
function placeFromLibrary(mapPath: string): void {
  const cell = session.value.selected
  if (cell === null) {
    session.value.status = 'Select a cell first — or drag the map onto one.'
    return
  }
  placeRoom(session.value, cell, mapPath)
}

const importInput = ref<HTMLInputElement | null>(null)
async function onImport(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  if (!files.length) return
  await importMaps(session.value, await Promise.all(files.map(async (file) => ({ name: file.name, text: await file.text() }))))
}

const newType = ref('')
function submitType(): void {
  if (!newType.value.trim()) return
  addType(session.value, newType.value)
  newType.value = ''
}

function confirmRemoveType(type: string): void {
  const index = world.value.entityTypes.indexOf(type)
  const after = world.value.entityTypes.length - index - 1
  if (
    after > 0 &&
    !window.confirm(`Removing "${type}" renumbers the ${after} type${after === 1 ? '' : 's'} after it — code that uses the numbers rather than the _ENT_ defines will break. Continue?`)
  ) {
    return
  }
  removeType(session.value, type)
}

const num = (event: Event): number => Number((event.target as HTMLInputElement).value)
const text = (event: Event): string => (event.target as HTMLInputElement | HTMLSelectElement).value

async function save(): Promise<void> {
  try {
    await saveSession(session.value)
  } catch (error) {
    session.value.status = `Save failed: ${String(error)}`
  }
}

async function exportNow(): Promise<void> {
  await save()
  await resourcesStore.exportOne(session.value.path)
}

function onKeydown(event: KeyboardEvent): void {
  if (isTypingTarget(event)) return
  if (!event.ctrlKey) {
    if ((event.key === 'Delete' || event.key === 'Backspace') && session.value.selected !== null) {
      placeRoom(session.value, session.value.selected, null)
    }
    return
  }
  const key = event.key.toLowerCase()
  if (key === 'z' && !event.shiftKey) {
    event.preventDefault()
    undo(session.value)
  } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
    event.preventDefault()
    redo(session.value)
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  void resourcesStore.refresh()
})
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

watch(
  () => tabsStore.tabs.length,
  () => pruneWorldSessions(new Set(tabsStore.tabs.map((tab) => tab.filePath ?? ''))),
  { immediate: true }
)
</script>

<template>
  <div class="world-editor">
    <p
      v-if="session.error"
      class="error"
    >
      {{ session.error }}
    </p>
    <template v-else-if="!session.loading">
      <div class="toolbar">
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
        <span class="sep" />
        <label
          class="zoom"
          title="Zoom"
        >
          <Icon name="zoom_in" />
          <input
            v-model.number="zoom"
            type="range"
            min="2"
            max="12"
          >
        </label>
        <button
          type="button"
          title="Read the rooms again"
          @click="reloadRooms(session)"
        >
          <Icon name="refresh" />
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
          title="Write the header that carries every room, its neighbours, doors and entities"
          @click="exportNow"
        >
          Export
        </button>
      </div>

      <div class="panes">
        <div class="grid-pane">
          <div
            class="grid"
            :style="{ gridTemplateColumns: `repeat(${world.cols}, ${cellSize.width}px)` }"
          >
            <div
              v-for="(roomPath, cell) in world.cells"
              :key="cell"
              class="cell"
              :class="{
                empty: !roomPath,
                selected: session.selected === cell,
                linkEast: roomPath && connected(cell, 1),
                linkSouth: roomPath && connected(cell, 2)
              }"
              :style="{ width: `${cellSize.width}px`, height: `${cellSize.height}px` }"
              :title="roomPath ? `${roomPath} — room ${ids[cell]}. Double-click to open; drag to move.` : 'Empty — double-click to make a room here'"
              :draggable="!!roomPath"
              @click="onCellClick(cell)"
              @dblclick="onCellOpen(cell)"
              @dragstart="onDragStart(cell, $event)"
              @dragover.prevent
              @drop.prevent="onDrop(cell)"
            >
              <template v-if="roomPath">
                <img
                  v-if="session.thumbnails.get(roomPath)"
                  :src="session.thumbnails.get(roomPath) ?? undefined"
                  alt=""
                >
                <span
                  v-else
                  class="missing"
                >{{ session.rooms.has(roomPath) ? '' : 'missing' }}</span>
                <span class="label">{{ ids[cell] }} · {{ fileOf(roomPath) }} <span class="size">{{ sizeOf(roomPath) }}</span></span>
                <span
                  v-if="doorCount.get(cell)"
                  class="doors"
                  :title="`${doorCount.get(cell)} door(s)`"
                >
                  <Icon name="door_open" />{{ doorCount.get(cell) }}
                </span>
              </template>
              <Icon
                v-else
                name="add"
              />
            </div>
          </div>
        </div>

        <div class="side">
          <section v-if="selected">
            <h3>Room {{ selected.col }},{{ selected.row }}</h3>
            <label>
              <span>Map</span>
              <select
                :value="selected.path ?? ''"
                @change="placeRoom(session, selected.cell, text($event) || null)"
              >
                <option value="">
                  (empty — a wall)
                </option>
                <option
                  v-for="mapPath in maps"
                  :key="mapPath"
                  :value="mapPath"
                >
                  {{ mapPath }}
                </option>
              </select>
            </label>
            <div class="buttons">
              <button
                v-if="!selected.path"
                type="button"
                title="Make an empty one-screen map for this cell, over its neighbours' tileset, and open it"
                @click="newRoom(session, selected.cell)"
              >
                New empty room
              </button>
              <template v-else>
                <button
                  type="button"
                  @click="openRoom(session, selected.cell)"
                >
                  Open to edit
                </button>
                <button
                  type="button"
                  title="Take the room out of this cell — the map file stays"
                  @click="placeRoom(session, selected.cell, null)"
                >
                  Remove from world
                </button>
              </template>
            </div>
            <p
              v-if="selected.room"
              class="hint"
            >
              Room id {{ selected.id }} · {{ selected.room.width }}×{{ selected.room.height }} over
              <code>{{ selected.room.tileset || 'no tileset' }}</code> ·
              {{ mapEntities(selected.room).length }} entit{{ mapEntities(selected.room).length === 1 ? 'y' : 'ies' }}
            </p>

            <template v-if="selected.path">
              <h3 class="sub">
                Doors
              </h3>
              <p class="hint">
                Neighbouring rooms already connect at their edges. A door is for anything else — a
                cave mouth, stairs, a warp. <code>_DoorAt(room, x, y)</code> finds it.
              </p>
              <div
                v-for="{ door, index } in selectedDoors"
                :key="index"
                class="door"
              >
                <div class="row">
                  <label>
                    <span>At X</span>
                    <input
                      type="number"
                      min="0"
                      :max="roomSizeAt(door.room).width - 1"
                      :value="door.x"
                      @change="updateDoor(session, index, { x: num($event) })"
                    >
                  </label>
                  <label>
                    <span>Y</span>
                    <input
                      type="number"
                      min="0"
                      :max="roomSizeAt(door.room).height - 1"
                      :value="door.y"
                      @change="updateDoor(session, index, { y: num($event) })"
                    >
                  </label>
                </div>
                <label>
                  <span>Leads to</span>
                  <select
                    :value="door.to"
                    @change="updateDoor(session, index, { to: num($event) })"
                  >
                    <option
                      v-for="destination in destinations"
                      :key="destination.cell"
                      :value="destination.cell"
                    >
                      {{ destination.label }}
                    </option>
                  </select>
                </label>
                <div class="row">
                  <label>
                    <span>Arrive X</span>
                    <input
                      type="number"
                      min="0"
                      :max="roomSizeAt(door.to).width - 1"
                      :value="door.toX"
                      @change="updateDoor(session, index, { toX: num($event) })"
                    >
                  </label>
                  <label>
                    <span>Y</span>
                    <input
                      type="number"
                      min="0"
                      :max="roomSizeAt(door.to).height - 1"
                      :value="door.toY"
                      @change="updateDoor(session, index, { toY: num($event) })"
                    >
                  </label>
                  <button
                    type="button"
                    class="icon"
                    title="Remove this door"
                    @click="removeDoor(session, index)"
                  >
                    <Icon name="delete" />
                  </button>
                </div>
              </div>
              <button
                type="button"
                class="wide"
                @click="addDoor(session)"
              >
                Add door
              </button>
            </template>
          </section>
          <section v-else>
            <h3>Rooms</h3>
            <p class="hint">
              Click a cell to select it, double-click to open its room — or to make one in an empty
              cell. Drag a room onto another cell to move it, or a map from the library below onto a
              cell to place it. Rooms side by side connect; an empty cell is a wall.
            </p>
          </section>

          <section>
            <h3>Maps</h3>
            <p class="hint">
              Every map in the project. Drag one onto a cell, or click it to put it in the selected
              cell.
            </p>
            <ul class="library">
              <li
                v-for="mapPath in maps"
                :key="mapPath"
                draggable="true"
                :class="{ placed: placedIn.has(mapPath) }"
                :title="`${mapPath}${placedIn.has(mapPath) ? ` — in ${placedIn.get(mapPath)} cell(s)` : ''}`"
                @dragstart="onLibraryDragStart(mapPath, $event)"
                @click="placeFromLibrary(mapPath)"
                @dblclick="tabsStore.openFile(mapPath, mapPath.split('/').pop() ?? mapPath)"
              >
                <img
                  v-if="session.thumbnails.get(mapPath)"
                  :src="session.thumbnails.get(mapPath) ?? undefined"
                  alt=""
                >
                <span
                  v-else
                  class="blank"
                />
                <span class="name">{{ fileOf(mapPath) }}</span>
              </li>
            </ul>
            <p
              v-if="!maps.length"
              class="hint"
            >
              No maps yet.
            </p>
            <input
              ref="importInput"
              type="file"
              accept=".json"
              multiple
              hidden
              @change="onImport"
            >
            <button
              type="button"
              class="wide"
              title="Copy .map.json files from elsewhere into this project's res/ folder — into the selected cell, if it is empty"
              @click="importInput?.click()"
            >
              Import map files…
            </button>
          </section>

          <section>
            <h3>Grid</h3>
            <div class="row">
              <label>
                <span>Columns</span>
                <input
                  type="number"
                  min="1"
                  max="64"
                  :value="world.cols"
                  @change="resize(session, num($event), world.rows)"
                >
              </label>
              <label>
                <span>Rows</span>
                <input
                  type="number"
                  min="1"
                  max="64"
                  :value="world.rows"
                  @change="resize(session, world.cols, num($event))"
                >
              </label>
            </div>
            <p class="hint">
              Each room is a map of its own size — one screen, a short one under a HUD, a tall one you
              scroll. Resize it in the map editor.
            </p>
          </section>

          <section>
            <h3>Entity types</h3>
            <p class="hint">
              Every room numbers its entities by this list, from 1 — <code>_ENT_CHEST</code> is the
              same in every room.
            </p>
            <ul class="types">
              <li
                v-for="(type, index) in world.entityTypes"
                :key="type"
              >
                <span><span class="id">{{ index + 1 }}</span><code>{{ type }}</code></span>
                <button
                  type="button"
                  class="icon"
                  :title="`Remove ${type}`"
                  @click="confirmRemoveType(type)"
                >
                  <Icon name="close" />
                </button>
              </li>
            </ul>
            <form
              class="row"
              @submit.prevent="submitType"
            >
              <input
                v-model="newType"
                type="text"
                spellcheck="false"
                placeholder="chest"
              >
              <button
                type="submit"
                :disabled="!newType.trim()"
              >
                Add
              </button>
            </form>
            <button
              v-if="undeclared.length"
              type="button"
              class="wide"
              :title="undeclared.join(', ')"
              @click="addUsedTypes(session)"
            >
              Add the {{ undeclared.length }} type{{ undeclared.length === 1 ? '' : 's' }} the rooms use
            </button>
          </section>

          <section v-if="leftToGame.length">
            <h3>Left to your code</h3>
            <p class="hint">
              The ready-made C calls each room's and tileset's own helpers. These it cannot, so
              <code>_DrawRoom</code> / <code>_LoadTileset</code> return FALSE for them:
            </p>
            <ul class="notices">
              <li
                v-for="(notice, index) in leftToGame"
                :key="index"
              >
                {{ notice }}
              </li>
            </ul>
          </section>

          <section v-if="issues.length">
            <h3>Problems</h3>
            <ul class="problems">
              <li
                v-for="(issue, index) in issues"
                :key="index"
              >
                {{ issue }}
              </li>
            </ul>
          </section>

          <section>
            <h3>Export</h3>
            <template v-if="world.export">
              <label>
                <span>Table name</span>
                <input
                  type="text"
                  spellcheck="false"
                  :value="world.export.name"
                  @change="patchExport(session, { name: text($event) })"
                >
              </label>
              <label>
                <span>Output</span>
                <input
                  type="text"
                  spellcheck="false"
                  :value="world.export.out"
                  @change="patchExport(session, { out: text($event) })"
                >
              </label>
              <label class="inline">
                <input
                  type="checkbox"
                  :checked="world.export.helpers === true"
                  @change="patchExport(session, { helpers: ($event.target as HTMLInputElement).checked })"
                >
                <span title="_RoomAt, _Neighbour, _RoomEntities, _DoorAt, and _LoadTileset/_DrawRoom calling the rooms' own helpers. Needs msxgl.h included first.">Export ready-made C</span>
              </label>
              <p class="hint">
                The world exports navigation only — the grid, neighbours, doors, entities. Each room
                exports its own tiles and meta-tiles; compress a room in its own map editor.
              </p>
            </template>
            <button
              v-else
              type="button"
              class="wide"
              @click="setupExport(session)"
            >
              Set up export
            </button>
          </section>
        </div>
      </div>

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
.world-editor {
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
}

.toolbar button,
.side button {
  min-width: 24px;
  padding: 2px 6px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-hover);
  font-size: 12px;
}

button:disabled {
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

.zoom {
  display: flex;
  align-items: center;
  gap: 4px;
}

.zoom input {
  width: 84px;
}

.panes {
  flex: 1;
  min-height: 0;
  display: flex;
}

.grid-pane {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 16px;
}

.grid {
  display: grid;
  gap: 6px;
  width: max-content;
}

.cell {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--color-border);
  border-radius: 2px;
  background: #1e1e1e;
  cursor: pointer;
  user-select: none;
}

.cell.empty {
  border-style: dashed;
  background: transparent;
  color: var(--color-text-muted);
}

.cell.selected {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

/* A room that touches its neighbour: a bar across the gap, so connected regions read as one. */
.cell.linkEast::after,
.cell.linkSouth::before {
  content: '';
  position: absolute;
  background: var(--color-accent);
  opacity: 0.7;
}

.cell.linkEast::after {
  right: -7px;
  top: calc(50% - 6px);
  width: 6px;
  height: 12px;
}

.cell.linkSouth::before {
  bottom: -7px;
  left: calc(50% - 6px);
  width: 12px;
  height: 6px;
}

.cell img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  image-rendering: pixelated;
  pointer-events: none;
}

.cell .label .size {
  opacity: 0.7;
}

.library {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  margin: 0 0 6px;
  padding: 0;
  list-style: none;
}

.library li {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  cursor: grab;
}

.library li.placed {
  border-color: var(--color-accent);
}

.library img,
.library .blank {
  width: 100%;
  aspect-ratio: 4 / 3;
  object-fit: contain;
  image-rendering: pixelated;
  background: #1e1e1e;
  pointer-events: none;
}

.library .name {
  overflow: hidden;
  font-size: 10px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.notices {
  margin: 0;
  padding-left: 16px;
  font-size: 11px;
  color: var(--color-text-muted);
}

.cell .label {
  position: absolute;
  left: 3px;
  bottom: 2px;
  max-width: calc(100% - 6px);
  overflow: hidden;
  padding: 0 3px;
  border-radius: 2px;
  background: rgba(0, 0, 0, 0.65);
  color: #ffffff;
  font-size: 10px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.cell .doors {
  position: absolute;
  top: 2px;
  right: 2px;
  display: flex;
  align-items: center;
  padding: 0 3px;
  border-radius: 2px;
  background: rgba(0, 0, 0, 0.65);
  color: #ffd24e;
  font-size: 10px;
}

.cell .missing {
  color: var(--color-error, #f14c4c);
  font-size: 11px;
}

.side {
  width: 260px;
  flex: none;
  padding: 8px 10px 20px;
  overflow-y: auto;
  border-left: 1px solid var(--color-border);
}

h3 {
  margin: 0 0 4px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-text-muted);
}

h3.sub {
  margin-top: 10px;
}

section {
  margin-bottom: 16px;
}

label {
  display: block;
  margin-bottom: 6px;
  font-size: 11px;
}

label > span:first-child {
  display: block;
  margin-bottom: 2px;
  color: var(--color-text-muted);
}

label.inline {
  display: flex;
  align-items: center;
  gap: 5px;
}

label.inline > span:first-child {
  display: inline;
  margin: 0;
  color: var(--color-text);
}

select,
input[type='text'],
input[type='number'] {
  width: 100%;
  padding: 3px 5px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-tab-inactive);
  color: var(--color-text);
  font-size: 11px;
}

.row {
  display: flex;
  align-items: flex-end;
  gap: 6px;
}

.row label {
  flex: 1;
  min-width: 0;
}

.row button {
  margin-bottom: 6px;
}

.buttons {
  display: flex;
  gap: 6px;
  margin-bottom: 6px;
}

.wide {
  width: 100%;
  margin-top: 4px;
}

.door {
  margin-bottom: 8px;
  padding: 6px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
}

.types {
  margin: 0 0 6px;
  padding: 0;
  list-style: none;
  font-size: 11px;
}

.types .id {
  display: inline-block;
  width: 22px;
  color: var(--color-text-muted);
}

.types li {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

button.icon {
  min-width: 0;
  padding: 0 3px;
  border: none;
  background: none;
}

.problems {
  margin: 0;
  padding-left: 16px;
  font-size: 11px;
  color: var(--color-error, #f14c4c);
}

.hint {
  margin: 0 0 6px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--color-text-muted);
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
