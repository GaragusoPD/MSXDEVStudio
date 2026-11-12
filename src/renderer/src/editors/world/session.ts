/**
 * Per-tab state for the world editor (`*.world.json`): the room grid, the
 * doors, the entity types and the export block. A project can hold any number
 * of worlds — an overworld, each dungeon — and each tab has its own session.
 *
 * Same shape as the other resource editors: a module-level map keyed by the
 * project-relative path, one `History<WorldDoc>`, and every mutation through
 * the pure functions in `shared/msx/world.ts` — nothing here knows a table
 * layout.
 *
 * The rooms are other files. The session reads each one it places (`rooms`),
 * for thumbnails, for the problems list — the same `validateWorld` the build
 * runs, so the panel and the build never disagree — and to offer the entity
 * types the rooms already use. It re-reads them when one of them, or a tileset
 * one of them draws with, changes on disk: painting a room in its own tab and
 * saving shows up here without a reload.
 */

import { shallowReactive } from 'vue'
import { createMapDoc, SCREEN_COLS, SCREEN_ROWS, stampFresh, type MapDoc } from '../../../../shared/msx/map'
import { defaultExport, parseResource, RESOURCE_DIR, resourceKindOf, serializeResource, type ExportBlock } from '../../../../shared/msx/resource'
import {
  addDoor as addDoorPure,
  addEntityType,
  colRowOf,
  createWorldDoc,
  moveRoom as moveRoomPure,
  removeDoor as removeDoorPure,
  removeEntityType,
  resizeWorld,
  setRoom,
  loadedTileset,
  undeclaredEntityTypes,
  updateDoor as updateDoorPure,
  validateWorld,
  worldNotices,
  type LoadedTileset,
  type LoadedRoom,
  type WorldDoc,
  type WorldDoor
} from '../../../../shared/msx/world'
import { cleanEntityTypeName } from '../../../../shared/msx/map-entity'
import { createHistory, pushHistory, redo as redoHistory, undo as undoHistory, canRedo, canUndo, type History } from '../../../../shared/history'
import type { FsChangeEvent } from '../../../../shared/ipc'
import { thumbnailUrl } from '../../components/resource-thumbnails'
import { useResourcesStore } from '../../stores/resourcesStore'
import { useTabsStore } from '../../stores/tabsStore'
import { watchResourceFile } from '../external-changes'

export { canRedo, canUndo }

export interface WorldSession {
  path: string
  stopWatching: (() => void) | null
  /** Drops the `fs:changed` subscription that keeps `rooms` current. */
  stopWatchingRooms: (() => void) | null
  history: History<WorldDoc>
  loading: boolean
  error: string | null
  dirty: boolean
  /** Every room the grid places, as read — keyed by path. A room that could not be read is absent. */
  rooms: Map<string, LoadedRoom>
  /** A picture per map path — the rooms and the map library alike — or null while there is none. */
  thumbnails: Map<string, string | null>
  /** The grid cell the side panel is about. */
  selected: number | null
  status: string
}

const sessions = new Map<string, WorldSession>()

export function worldSession(path: string): WorldSession {
  const existing = sessions.get(path)
  if (existing) return existing
  const session = shallowReactive<WorldSession>({
    path,
    stopWatching: null,
    stopWatchingRooms: null,
    history: createHistory(createWorldDoc()),
    loading: true,
    error: null,
    dirty: false,
    rooms: new Map(),
    thumbnails: new Map(),
    selected: null,
    status: ''
  })
  sessions.set(path, session)
  session.stopWatching = watchResourceFile(path, {
    serialize: () => serializeResource({ kind: 'world', doc: doc(session) }),
    reload: () => void load(session),
    isDirty: () => session.dirty
  })
  let pending: ReturnType<typeof setTimeout> | null = null
  // Sticky across a burst: a library map changing must not cancel a room reload already due.
  let roomsDue = false
  session.stopWatchingRooms =
    window.api.on?.('fs:changed', (event: FsChangeEvent) => {
      // A room or its tileset: read the rooms again. Any other map: only the
      // library's picture of it changed.
      const room = watched(session).has(event.path)
      if (!room && !event.path.toLowerCase().endsWith('.map.json')) return
      roomsDue ||= room
      if (pending) clearTimeout(pending)
      pending = setTimeout(() => {
        pending = null
        const rooms = roomsDue
        roomsDue = false
        void (rooms ? reloadRooms(session) : refreshThumbnails(session))
      }, 150)
    }) ?? null
  void load(session)
  return session
}

/** The files whose change means the rooms must be read again: the rooms, and the tilesets they draw with. */
function watched(session: WorldSession): Set<string> {
  const paths = new Set<string>()
  for (const path of doc(session).cells) if (path) paths.add(path)
  for (const room of session.rooms.values()) if (room.doc.tileset) paths.add(room.doc.tileset)
  return paths
}

export function pruneWorldSessions(openPaths: Set<string>): void {
  for (const path of [...sessions.keys()]) {
    if (openPaths.has(path)) continue
    const session = sessions.get(path)
    session?.stopWatching?.()
    session?.stopWatchingRooms?.()
    sessions.delete(path)
  }
}

async function load(session: WorldSession): Promise<void> {
  try {
    const text = await window.api.invoke('fs:read', { path: session.path })
    const parsed = parseResource(session.path, text)
    if (parsed.kind !== 'world') throw new Error('not a world')
    session.history = createHistory(parsed.doc)
    session.error = null
    await reloadRooms(session)
  } catch (error) {
    session.error = `Couldn't open ${session.path}: ${String(error)}`
  } finally {
    session.loading = false
  }
}

/**
 * Reads every room the grid places, and whether its tileset is banked — what
 * `validateWorld` needs to judge it the way the build will. A room that cannot
 * be read is simply absent, which is how validation reports it.
 */
export async function reloadRooms(session: WorldSession): Promise<void> {
  const rooms = new Map<string, LoadedRoom>()
  const tilesets = new Map<string, LoadedTileset | undefined>()
  for (const path of new Set(doc(session).cells)) {
    if (!path) continue
    try {
      const parsed = parseResource(path, await window.api.invoke('fs:read', { path }))
      if (parsed.kind !== 'map') continue
      const tilesetPath = parsed.doc.tileset
      if (tilesetPath && !tilesets.has(tilesetPath)) {
        let value: LoadedTileset | undefined
        try {
          const tiles = parseResource(tilesetPath, await window.api.invoke('fs:read', { path: tilesetPath }))
          if (tiles.kind === 'tiles') value = loadedTileset(tilesetPath, tiles.doc)
        } catch {
          // A missing tileset is the room's problem, and its own editor says so.
        }
        tilesets.set(tilesetPath, value)
      }
      const tileset = tilesetPath ? tilesets.get(tilesetPath) : undefined
      rooms.set(path, { doc: parsed.doc, banked: tileset?.banked === true, ...(tileset ? { tileset } : {}) })
    } catch {
      // Unreadable: absent, and reported as such.
    }
  }
  session.rooms = rooms
  await refreshThumbnails(session)
}

/**
 * Pictures for every map in the project — the rooms and the library. Cheap to
 * repeat: `thumbnailUrl` caches by content.
 */
export async function refreshThumbnails(session: WorldSession): Promise<void> {
  const paths = new Set<string>([...session.rooms.keys(), ...libraryMaps()])
  const thumbnails = new Map<string, string | null>()
  for (const path of paths) thumbnails.set(path, await thumbnailUrl(path))
  session.thumbnails = thumbnails
}

/** Every map in the project, for the library: what can be dropped into a cell. */
export function libraryMaps(): string[] {
  return useResourcesStore()
    .entries.filter((entry) => entry.kind === 'map')
    .map((entry) => entry.path)
    .sort()
}

export function doc(session: WorldSession): WorldDoc {
  return session.history.present
}

/** What the build would refuse, right now — the same check, over the same rooms. */
export function problems(session: WorldSession): string[] {
  return validateWorld(doc(session), session.rooms)
}

/** What the ready-made C leaves to the game, and why — shown beside the problems, never blocking. */
export function notices(session: WorldSession): string[] {
  return worldNotices(doc(session), session.rooms)
}

/** Entity types the rooms use that the world does not declare yet. */
export function undeclaredTypes(session: WorldSession): string[] {
  return undeclaredEntityTypes(doc(session), session.rooms)
}

export async function saveSession(session: WorldSession): Promise<void> {
  await window.api.invoke('fs:write', { path: session.path, content: serializeResource({ kind: 'world', doc: doc(session) }) })
  session.dirty = false
  useTabsStore().setDirty(session.path, false)
  session.status = 'Saved'
}

function markDirty(session: WorldSession): void {
  session.dirty = true
  useTabsStore().setDirty(session.path, true)
}

/** Every mutation goes through here: one undo step, and the tab marked dirty. A no-op pushes nothing. */
export function commit(session: WorldSession, next: WorldDoc): void {
  const history = pushHistory(session.history, next)
  if (history === session.history) return
  const before = new Set(doc(session).cells)
  session.history = history
  if (session.selected !== null && session.selected >= next.cells.length) session.selected = null
  markDirty(session)
  // A newly placed map has to be read before it can be drawn or validated.
  if (next.cells.some((path) => path && !before.has(path))) void reloadRooms(session)
}

export function undo(session: WorldSession): void {
  const next = undoHistory(session.history)
  if (next === session.history) return
  session.history = next
  markDirty(session)
  void reloadRooms(session)
}

export function redo(session: WorldSession): void {
  const next = redoHistory(session.history)
  if (next === session.history) return
  session.history = next
  markDirty(session)
  void reloadRooms(session)
}

// ── the grid ───────────────────────────────────────────────────────────────

export function select(session: WorldSession, cell: number | null): void {
  session.selected = cell
}

export function placeRoom(session: WorldSession, cell: number, path: string | null): void {
  const current = doc(session)
  const doorsLost = !path && current.doors.some((door) => door.room === cell || door.to === cell)
  commit(session, setRoom(current, cell, path))
  if (doorsLost) session.status = 'The doors from and to that cell went with it.'
}

export function moveRoom(session: WorldSession, from: number, to: number): void {
  commit(session, moveRoomPure(doc(session), from, to))
  if (session.selected === from) session.selected = to
}

export function resize(session: WorldSession, cols: number, rows: number): void {
  commit(session, resizeWorld(doc(session), cols, rows))
}

/** The tileset a new room should start with: a neighbour's, else the first room's. */
function tilesetFor(session: WorldSession, cell: number): string {
  const current = doc(session)
  const { col, row } = colRowOf(current, cell)
  const around = [
    [col - 1, row],
    [col + 1, row],
    [col, row - 1],
    [col, row + 1]
  ]
  for (const [c, r] of around) {
    if (c < 0 || r < 0 || c >= current.cols || r >= current.rows) continue
    const path = current.cells[r * current.cols + c]
    const tileset = path ? session.rooms.get(path)?.doc.tileset : undefined
    if (tileset) return tileset
  }
  for (const room of session.rooms.values()) if (room.doc.tileset) return room.doc.tileset
  return useResourcesStore().entries.find((entry) => entry.kind === 'tiles')?.path ?? ''
}

/** The export a room gets: its own C, with the ready-made helpers `_DrawRoom` calls. */
export function roomExport(path: string): ExportBlock {
  return { ...defaultExport(path), helpers: true }
}

/**
 * A blank one-screen room for an empty cell, over the tileset its neighbours
 * use, named after the world and the cell, exporting its own C — and opened, so
 * the next thing is painting it. Resize it in the map editor; rooms need not
 * share a size.
 */
export async function newRoom(session: WorldSession, cell: number): Promise<string | null> {
  const current = doc(session)
  const { col, row } = colRowOf(current, cell)
  const stem = (session.path.split('/').pop() ?? 'world').replace(/\.world\.json$/i, '')
  const dir = session.path.includes('/') ? session.path.slice(0, session.path.lastIndexOf('/')) : RESOURCE_DIR
  const pathFor = (n: number): string => `${dir}/${stem}_r${row}_c${col}${n ? `_${n}` : ''}.map.json`
  let n = 0
  while (await window.api.invoke('fs:stat', { path: pathFor(n) })) n++
  const path = pathFor(n)
  const map: MapDoc = stampFresh({ ...createMapDoc(tilesetFor(session, cell), SCREEN_COLS, SCREEN_ROWS), export: roomExport(path) })
  try {
    await window.api.invoke('fs:create', { path: dir, kind: 'directory' })
    await window.api.invoke('fs:write', { path, content: serializeResource({ kind: 'map', doc: map }) })
  } catch (error) {
    session.status = `Couldn't write ${path}: ${String(error)}`
    return null
  }
  await useResourcesStore().refresh()
  placeRoom(session, cell, path)
  session.selected = cell
  session.status = `Made ${path.split('/').pop()}${map.tileset ? ` over ${map.tileset.split('/').pop()}` : ' — pick its tileset in the map editor'}.`
  useTabsStore().openFile(path, path.split('/').pop() ?? path)
  return path
}

/**
 * Copies map files from outside the project into its `res/` folder and, when a
 * cell is selected and empty, places the first one there. A name already taken
 * gets a number rather than overwriting anything. A map whose tileset is not in
 * this project still imports; the map editor is where it gets a new one.
 */
export async function importMaps(session: WorldSession, files: readonly { name: string; text: string }[]): Promise<string[]> {
  const written: string[] = []
  const problems: string[] = []
  await window.api.invoke('fs:create', { path: RESOURCE_DIR, kind: 'directory' })
  for (const file of files) {
    const stem = file.name.replace(/\.map\.json$/i, '').replace(/\.json$/i, '').replace(/[^A-Za-z0-9_-]/g, '_') || 'room'
    let path = `${RESOURCE_DIR}/${stem}.map.json`
    for (let n = 2; await window.api.invoke('fs:stat', { path }); n++) path = `${RESOURCE_DIR}/${stem}_${n}.map.json`
    let parsed: MapDoc
    try {
      const resource = parseResource(path, file.text)
      if (resource.kind !== 'map') throw new Error('not a map')
      parsed = resource.doc
    } catch (error) {
      problems.push(`${file.name}: ${String(error)}`)
      continue
    }
    // Named after where it lands, so two imports never export to one header.
    const map = { ...parsed, export: roomExport(path) }
    await window.api.invoke('fs:write', { path, content: serializeResource({ kind: 'map', doc: map }) })
    written.push(path)
    if (map.tileset && !(await window.api.invoke('fs:stat', { path: map.tileset }))) {
      problems.push(`${path.split('/').pop()} names ${map.tileset}, which this project does not have — pick its tileset in the map editor`)
    }
  }
  await useResourcesStore().refresh()
  const cell = session.selected
  if (written.length && cell !== null && !doc(session).cells[cell]) placeRoom(session, cell, written[0])
  else await refreshThumbnails(session)
  session.status = [
    written.length ? `Imported ${written.map((path) => path.split('/').pop()).join(', ')}.` : 'Nothing imported.',
    ...problems
  ].join(' ')
  return written
}

export function openRoom(session: WorldSession, cell: number): void {
  const path = doc(session).cells[cell]
  if (path && resourceKindOf(path) === 'map') useTabsStore().openFile(path, path.split('/').pop() ?? path)
}

// ── entity types ───────────────────────────────────────────────────────────

export function addType(session: WorldSession, name: string): void {
  const type = cleanEntityTypeName(name)
  if (doc(session).entityTypes.includes(type)) {
    session.status = `"${type}" is already declared.`
    return
  }
  commit(session, addEntityType(doc(session), type))
}

/** Declares every type the rooms use and the world does not, in name order. */
export function addUsedTypes(session: WorldSession): void {
  let next = doc(session)
  for (const type of undeclaredTypes(session)) next = addEntityType(next, type)
  commit(session, next)
}

export function removeType(session: WorldSession, type: string): void {
  commit(session, removeEntityType(doc(session), type))
}

// ── doors ──────────────────────────────────────────────────────────────────

/** A door in the selected room, leading to itself until the user says where. */
export function addDoor(session: WorldSession): void {
  const cell = session.selected
  if (cell === null || !doc(session).cells[cell]) return
  commit(session, addDoorPure(doc(session), { room: cell, x: 0, y: 0, to: cell, toX: 0, toY: 0 }))
}

export function updateDoor(session: WorldSession, index: number, patch: Partial<WorldDoor>): void {
  commit(session, updateDoorPure(doc(session), index, patch))
}

export function removeDoor(session: WorldSession, index: number): void {
  commit(session, removeDoorPure(doc(session), index))
}

// ── export ─────────────────────────────────────────────────────────────────

export function setupExport(session: WorldSession): void {
  commit(session, { ...doc(session), export: { ...defaultExport(session.path), helpers: true } })
}

export function patchExport(session: WorldSession, patch: Partial<ExportBlock>): void {
  const current = doc(session)
  if (!current.export) return
  commit(session, { ...current, export: { ...current.export, ...patch } })
}
