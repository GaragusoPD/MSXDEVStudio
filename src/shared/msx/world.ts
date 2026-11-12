/**
 * `*.world.json`: a grid of rooms — the flip-screen world of a Zelda-like or a
 * metroidvania.
 *
 * **Every room is an ordinary map that draws itself.** Each `*.map.json` keeps
 * its own export — its layers, its live meta-tiles (animating through its
 * tileset's `_Animate()`), its tileset banked or not — and may be any size: a
 * one-screen room, a shorter one under a HUD, a tall dungeon you scroll. The
 * world only says how they connect:
 *
 * - **where each room sits** (`cells`, one map path or null per grid cell),
 *   from which the neighbours follow — two rooms side by side are connected,
 *   an empty cell is a wall. Disconnected regions of one grid (an overworld,
 *   and its dungeons off to the side) are just rooms nobody walks between;
 * - **doors**, the connections adjacency cannot express: a cave mouth to a
 *   dungeon's first room, a staircase, a warp;
 * - **the entity vocabulary** — the type ids every room's entities are
 *   numbered by, so `chest` is the same number in every room.
 *
 * Its export is navigation, never tile data: the grid, the neighbours, each
 * room's size and tileset, the doors, each room's entities in the world's ids.
 * With ready-made C on it also *dispatches* to the rooms' own exports —
 * `_LoadTileset` calls a tileset's own loader, `_DrawRoom` a room's own
 * `_DrawLayer`/`_DrawPlacements` — so it never draws anything itself and never
 * restricts what a room may contain. A room the dispatcher cannot draw for you
 * (one bigger than a screen, say) is the game's to draw; `_DrawRoom` says so by
 * returning FALSE, and the editor lists which and why (`worldNotices`).
 *
 * `shared/` cannot open files, so everything here takes the rooms already read
 * (`LoadedRoom`); `main/services/resources.ts` reads them for the build and the
 * world editor reads them for the screen.
 */

import { defineName, type HelperC } from './emitC'
import { mapEntities, mapExport, placementCount, withEntities, type MapDoc, type MapLayer } from './map'
import {
  ENTITY_BYTES,
  entityBytes,
  entityIds,
  entityProblems,
  isEntityTypeName,
  MAX_ENTITY_TYPES,
  type MapEntity
} from './map-entity'
import type { ExportBlock } from './resource'
import { isBanked, type TilesDoc } from './tile'

/** A connection between two rooms that are not neighbours — or are, through a spot other than the edge. */
export interface WorldDoor {
  /** Grid cell (`row * cols + col`) of the room the door is in. */
  room: number
  /** Where in that room, in tiles. */
  x: number
  y: number
  /** Grid cell of the room it leads to. */
  to: number
  /** Where the player arrives, in tiles. */
  toX: number
  toY: number
}

export interface WorldDoc {
  version: 1
  cols: number
  rows: number
  /** `cols * rows` project-relative `*.map.json` paths, row-major; null is no room. */
  cells: (string | null)[]
  /** The entity types, in id order from 1. Append-only in the editor, so ids never shift under a game. */
  entityTypes: string[]
  doors: WorldDoor[]
  export: ExportBlock | null
}

/** What the world's ready-made C needs to know about the tileset a room draws with. */
export interface LoadedTileset {
  path: string
  /** Its C symbol prefix, as its own export names it. */
  name: string
  /** Its header, project-relative; null when it exports no C header. */
  header: string | null
  /** Its own ready-made C is on — what `_Load()`/`_AnimReset()`/`_Animate()` need. */
  helpers: boolean
  mode: string
  count: number
  banked: boolean
  /** It has animations (or animated meta-tiles) attached: it has an `_Animate()`. */
  animated: boolean
}

/** What a world needs to know about a tileset to call its own loaders. */
export function loadedTileset(path: string, doc: TilesDoc): LoadedTileset {
  const block = doc.export
  return {
    path,
    name: exportName(path, block),
    header: block?.out && block.format === 'c' ? block.out : null,
    helpers: block?.helpers === true,
    mode: doc.mode,
    count: doc.count,
    banked: isBanked(doc),
    animated: doc.animations.length > 0
  }
}

/** A room as read from its file, plus what only other files could say. */
export interface LoadedRoom {
  doc: MapDoc
  /** Its tileset gives the three banks art of their own. */
  banked?: boolean
  /** Its tileset, when it is a pattern tileset that could be read. */
  tileset?: LoadedTileset
}

/** 0xFF is "no room" in every table, so 255 rooms fit. */
export const NO_ROOM = 0xff
export const MAX_WORLD_ROOMS = 255
/** Bytes per door: room, x, y, to, toX, toY. */
export const DOOR_BYTES = 6
/** The neighbour table's order, and the `_NORTH`/… defines. */
export const DIRECTIONS = ['north', 'east', 'south', 'west'] as const
export type Direction = (typeof DIRECTIONS)[number]
/** One name-table screen — what `_DrawRoom` can draw in one write. */
const SCREEN_W = 32
const SCREEN_H = 24

const at = (value: unknown, fallback: number, min = 1, max = 255): number => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n | 0)) : fallback
}

export function createWorldDoc(cols = 4, rows = 4): WorldDoc {
  return normalizeWorld({ cols, rows })
}

export function normalizeWorld(raw: unknown): WorldDoc {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<WorldDoc>
  const cols = at(input.cols, 4, 1, 64)
  const rows = at(input.rows, 4, 1, 64)
  const cells: (string | null)[] = new Array<string | null>(cols * rows).fill(null)
  if (Array.isArray(input.cells)) {
    for (let i = 0; i < cells.length; i++) {
      const value = input.cells[i]
      cells[i] = typeof value === 'string' && value ? value : null
    }
  }
  const types: string[] = []
  if (Array.isArray(input.entityTypes)) {
    for (const value of input.entityTypes) {
      const name = String(value ?? '')
      if (isEntityTypeName(name) && !types.includes(name)) types.push(name)
    }
  }
  const doors: WorldDoor[] = []
  if (Array.isArray(input.doors)) {
    for (const entry of input.doors) {
      if (typeof entry !== 'object' || entry === null) continue
      const d = entry as Partial<WorldDoor>
      const door = {
        room: Number(d.room) | 0,
        x: Number(d.x) | 0,
        y: Number(d.y) | 0,
        to: Number(d.to) | 0,
        toX: Number(d.toX) | 0,
        toY: Number(d.toY) | 0
      }
      // A door out of a cell the grid no longer has has nowhere to be.
      if (door.room < 0 || door.room >= cells.length || door.to < 0 || door.to >= cells.length) continue
      doors.push(door)
    }
  }
  return { version: 1, cols, rows, cells, entityTypes: types, doors, export: input.export ?? null }
}

/** Grid cell index of a column and row. */
export function cellOf(doc: WorldDoc, col: number, row: number): number {
  return row * doc.cols + col
}

export function colRowOf(doc: WorldDoc, cell: number): { col: number; row: number } {
  return { col: cell % doc.cols, row: Math.floor(cell / doc.cols) }
}

/**
 * Room ids, by grid cell: every cell that holds a room gets the next id in
 * reading order, an empty one gets `NO_ROOM`. What every table indexes by.
 */
export function roomIds(doc: WorldDoc): number[] {
  let next = 0
  return doc.cells.map((path) => (path ? next++ : NO_ROOM))
}

/** The grid cell of each room id — `roomIds` the other way round. */
export function roomCells(doc: WorldDoc): number[] {
  return doc.cells.flatMap((path, cell) => (path ? [cell] : []))
}

export function roomCount(doc: WorldDoc): number {
  return doc.cells.filter(Boolean).length
}

/** Each room's neighbours, N/E/S/W: the room id in the adjacent cell, or `NO_ROOM` past the edge or an empty cell. */
export function neighbours(doc: WorldDoc): number[][] {
  const ids = roomIds(doc)
  const idAt = (col: number, row: number): number =>
    col < 0 || row < 0 || col >= doc.cols || row >= doc.rows ? NO_ROOM : ids[cellOf(doc, col, row)]
  return roomCells(doc).map((cell) => {
    const { col, row } = colRowOf(doc, cell)
    return [idAt(col, row - 1), idAt(col + 1, row), idAt(col, row + 1), idAt(col - 1, row)]
  })
}

/** The distinct tilesets the rooms draw with, in first-use order — what `_RoomTileset` indexes. */
export function worldTilesets(doc: WorldDoc, rooms: ReadonlyMap<string, LoadedRoom>): string[] {
  const out: string[] = []
  for (const path of doc.cells) {
    const tileset = path ? rooms.get(path)?.doc.tileset : undefined
    if (tileset && !out.includes(tileset)) out.push(tileset)
  }
  return out
}

/** Every entity type the rooms use that the world does not declare yet — what the editor offers to add. */
export function undeclaredEntityTypes(doc: WorldDoc, rooms: ReadonlyMap<string, LoadedRoom>): string[] {
  const used = new Set<string>()
  for (const path of new Set(doc.cells)) {
    if (!path) continue
    for (const entity of mapEntities(rooms.get(path)?.doc ?? ({} as MapDoc))) used.add(entity.type)
  }
  return [...used].filter((type) => !doc.entityTypes.includes(type)).sort()
}

/** `Room 2,0 (res/cave.map.json)` — how every message names a room. */
function roomLabel(doc: WorldDoc, cell: number, path: string): string {
  const { col, row } = colRowOf(doc, cell)
  return `Room ${col},${row} (${path})`
}

/**
 * Everything that stops the world from exporting. Nothing here is about what a
 * room may *contain* — each room is its own map, validated by its own export.
 */
export function validateWorld(doc: WorldDoc, rooms: ReadonlyMap<string, LoadedRoom>): string[] {
  const problems: string[] = []
  if (doc.version !== 1) problems.push(`Unsupported version ${doc.version}`)
  const count = roomCount(doc)
  if (!count) problems.push('The world has no rooms — put a map in at least one cell')
  if (count > MAX_WORLD_ROOMS) problems.push(`${count} rooms — at most ${MAX_WORLD_ROOMS} fit (room ids are one byte, 0xFF is "none")`)
  if (doc.entityTypes.length > MAX_ENTITY_TYPES) problems.push(`${doc.entityTypes.length} entity types — at most ${MAX_ENTITY_TYPES} fit`)

  const declared = new Set(doc.entityTypes)
  const missingTypes = new Set<string>()
  const checked = new Set<string>()
  doc.cells.forEach((path, cell) => {
    if (!path || checked.has(path)) return
    checked.add(path)
    const room = rooms.get(path)
    const name = roomLabel(doc, cell, path)
    if (!room) {
      problems.push(`${name} could not be read`)
      return
    }
    // `_RoomSize` is a byte per side.
    if (room.doc.width > 255 || room.doc.height > 255) {
      problems.push(`${name} is ${room.doc.width}×${room.doc.height} — a world room is at most 255 tiles a side`)
    }
    problems.push(...entityProblems(mapEntities(room.doc), name))
    for (const entity of mapEntities(room.doc)) if (!declared.has(entity.type)) missingTypes.add(entity.type)
  })
  if (missingTypes.size) {
    problems.push(
      `Entity type${missingTypes.size === 1 ? '' : 's'} ${[...missingTypes].sort().map((type) => `"${type}"`).join(', ')} ` +
        'used in rooms but not declared in the world — add them to its entity types'
    )
  }

  // Each door is checked against its own room's size, and its arrival against
  // the room it leads to: rooms are not all one size.
  const sizeOf = (cell: number): { width: number; height: number } | null => {
    const path = doc.cells[cell]
    const room = path ? rooms.get(path) : undefined
    return room ? { width: room.doc.width, height: room.doc.height } : null
  }
  doc.doors.forEach((door, index) => {
    const label = `Door ${index + 1}`
    if (!doc.cells[door.room]) problems.push(`${label} is in an empty cell`)
    if (!doc.cells[door.to]) problems.push(`${label} leads to an empty cell`)
    const from = sizeOf(door.room)
    if (from && (door.x < 0 || door.y < 0 || door.x >= from.width || door.y >= from.height)) {
      problems.push(`${label} at ${door.x},${door.y} is outside its ${from.width}×${from.height} room`)
    }
    const to = sizeOf(door.to)
    if (to && (door.toX < 0 || door.toY < 0 || door.toX >= to.width || door.toY >= to.height)) {
      problems.push(`${label} arrives at ${door.toX},${door.toY}, outside the ${to.width}×${to.height} room it leads to`)
    }
    if ([door.x, door.y, door.toX, door.toY].some((value) => value > 255)) {
      problems.push(`${label}: coordinates are one byte, so at most 255`)
    }
  })
  if (doc.doors.length > 255) problems.push(`${doc.doors.length} doors — at most 255 fit`)
  return problems
}

/** A layer's table suffix, as `resource.ts` names it — `background` → `Background`. */
function layerTable(layer: MapLayer): string {
  return (
    layer.name
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('') || 'Layer'
  )
}

/** A file's export symbol, as `renderResourceFiles` would name it. */
function exportName(path: string, block: ExportBlock | null): string {
  if (block?.name) return block.name
  const file = (path.split(/[\\/]/).pop() ?? path).replace(/\.[a-z-]+\.json$/i, '')
  const pascal = file
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
  return `g_${pascal || 'Resource'}`
}

/**
 * How `_DrawRoom` draws a room: by its own `_DrawLayer` (and `_DrawPlacements`
 * when it has live meta-tiles) — or why it cannot, in which case the game
 * draws it, and `_DrawRoom` returns FALSE for it.
 */
export type RoomDraw =
  | { kind: 'draw'; name: string; header: string; layer: string; compressed: boolean; placements: boolean; unpacked: number }
  | { kind: 'manual'; reason: string }

export function roomDraw(path: string, room: MapDoc): RoomDraw {
  const block = room.export
  if (!block?.out || block.format !== 'c') return { kind: 'manual', reason: 'it has no C export of its own' }
  if (!block.helpers) return { kind: 'manual', reason: 'its export has no ready-made C (tick it in the map editor)' }
  if (room.cell) return { kind: 'manual', reason: 'it is a bitmap-mode map' }
  if (room.width > SCREEN_W || room.height > SCREEN_H) {
    return { kind: 'manual', reason: `it is ${room.width}×${room.height}, bigger than one screen — scroll it yourself` }
  }
  const layer = room.layers.find((candidate) => !candidate.indexed)
  if (!layer) return { kind: 'manual', reason: 'it has no tile layer — expand its indexed layer yourself' }
  if (room.layers.some((candidate) => candidate.indexed)) {
    return { kind: 'manual', reason: 'it has an indexed layer, which is expanded in RAM rather than drawn' }
  }
  const name = exportName(path, block)
  return {
    kind: 'draw',
    name,
    header: block.out,
    layer: `${name}_${layerTable(layer)}`,
    compressed: mapExport(room, block.compress).compressed,
    placements: placementCount(room) > 0,
    unpacked: room.width * room.height
  }
}

/** How `_LoadTileset` loads a tileset — or why it cannot. */
export type TilesetLoad =
  | { kind: 'load'; name: string; header: string; banked: boolean; count: number; animated: boolean }
  | { kind: 'manual'; reason: string }

export function tilesetLoad(tileset: LoadedTileset | undefined): TilesetLoad {
  if (!tileset) return { kind: 'manual', reason: 'it could not be read' }
  if (!tileset.header) return { kind: 'manual', reason: 'it has no C export' }
  if (tileset.mode !== 'sc2' && tileset.mode !== 'sc4') return { kind: 'manual', reason: `it is ${tileset.mode}, not SCREEN 2/4` }
  if (tileset.banked && !tileset.helpers) {
    return { kind: 'manual', reason: 'it is banked and its export has no ready-made C, so it has no _Load()' }
  }
  return {
    kind: 'load',
    name: tileset.name,
    header: tileset.header,
    banked: tileset.banked,
    count: tileset.count,
    // `_Animate()` exists only with its ready-made C on.
    animated: tileset.animated && tileset.helpers
  }
}

/**
 * What the editor shows beside the problems: the rooms `_DrawRoom` leaves to
 * the game, and the tilesets `_LoadTileset` cannot load, each with why. None
 * of it stops the export — a world is navigation first.
 */
export function worldNotices(doc: WorldDoc, rooms: ReadonlyMap<string, LoadedRoom>): string[] {
  const notices: string[] = []
  const seen = new Set<string>()
  doc.cells.forEach((path, cell) => {
    if (!path || seen.has(path)) return
    seen.add(path)
    const room = rooms.get(path)
    if (!room) return
    const draw = roomDraw(path, room.doc)
    if (draw.kind === 'manual') notices.push(`${roomLabel(doc, cell, path)}: _DrawRoom leaves it to you — ${draw.reason}.`)
  })
  const tilesets = new Map<string, LoadedTileset | undefined>()
  for (const path of new Set(doc.cells)) {
    const room = path ? rooms.get(path) : undefined
    if (room?.doc.tileset && !tilesets.has(room.doc.tileset)) tilesets.set(room.doc.tileset, room.tileset)
  }
  for (const [path, tileset] of tilesets) {
    const load = tilesetLoad(tileset)
    if (load.kind === 'manual') notices.push(`${path}: _LoadTileset leaves it to you — ${load.reason}.`)
  }
  return notices
}

/** One table a world exports; `resource.ts` turns these into `EmitTable`s. */
export interface WorldTable {
  suffix: string
  bytes: Uint8Array
  perLine: number
  comment: string
}

/** Little-endian 16-bit offsets, the way the generated C reads them. */
function offsetBytes(offsets: readonly number[]): Uint8Array {
  const out = new Uint8Array(offsets.length * 2)
  offsets.forEach((offset, index) => {
    out[index * 2] = offset & 0xff
    out[index * 2 + 1] = (offset >> 8) & 0xff
  })
  return out
}

/**
 * The world as tables: navigation and entities, never tile data. A map that
 * sits in several cells has its entity list stored once.
 */
export function worldTables(doc: WorldDoc, rooms: ReadonlyMap<string, LoadedRoom>): WorldTable[] {
  const cells = roomCells(doc)
  const paths = [...new Set(cells.map((cell) => doc.cells[cell]!))]
  const ids = entityIds(doc.entityTypes)
  const entityOffset = new Map<string, number>()
  const entityData: number[] = []
  for (const path of paths) {
    const entities = mapEntities(rooms.get(path)?.doc ?? ({} as MapDoc))
    entityOffset.set(path, entityData.length)
    entityData.push(entities.length, ...entityBytes(entities, ids))
  }
  const tilesets = worldTilesets(doc, rooms)
  const idOf = roomIds(doc)
  const room = (cell: number): MapDoc | undefined => rooms.get(doc.cells[cell]!)?.doc
  const tables: WorldTable[] = [
    {
      suffix: '_Grid',
      bytes: Uint8Array.from(idOf),
      perLine: Math.min(16, doc.cols),
      comment: `Room id per grid cell, ${doc.cols}×${doc.rows}, row-major — 0xFF is no room`
    },
    {
      suffix: '_Neighbours',
      bytes: Uint8Array.from(neighbours(doc).flat()),
      perLine: 4,
      comment: 'Per room: the room to the north, east, south, west — 0xFF where the edge is a wall'
    },
    {
      suffix: '_RoomSize',
      bytes: Uint8Array.from(cells.flatMap((cell) => [(room(cell)?.width ?? 0) & 0xff, (room(cell)?.height ?? 0) & 0xff])),
      perLine: 16,
      comment: 'Per room: its width and height in tiles — rooms are not all one size'
    },
    {
      suffix: '_RoomTileset',
      bytes: Uint8Array.from(cells.map((cell) => Math.max(0, tilesets.indexOf(room(cell)?.tileset ?? '')))),
      perLine: 16,
      comment: 'Per room: which tileset it draws with — the _TILESET_ defines'
    },
    {
      suffix: '_EntityOffsets',
      bytes: offsetBytes(cells.map((cell) => entityOffset.get(doc.cells[cell]!)!)),
      perLine: 16,
      comment: 'Per room: where its entity list starts in _Entities — two bytes, low first'
    },
    {
      suffix: '_Entities',
      bytes: Uint8Array.from(entityData),
      perLine: 16,
      comment: 'Per room: a count, then type, x, y, param per entity — ids from the _ENT_ defines, the same in every room'
    }
  ]
  if (doc.doors.length) {
    tables.push({
      suffix: '_Doors',
      bytes: Uint8Array.from(
        doc.doors.flatMap((door) => [idOf[door.room] ?? NO_ROOM, door.x, door.y, idOf[door.to] ?? NO_ROOM, door.toX, door.toY])
      ),
      perLine: DOOR_BYTES,
      comment: 'Doors: room, x, y, then the room it leads to and where the player arrives — six bytes each'
    })
  }
  return tables
}

/** What a room's file name says, as a define: `res/forest_r0_c1.map.json` → `FOREST_R0_C1`. */
function roomDefine(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? path
  return defineName(file.replace(/\.map\.json$/i, ''))
}

function tilesetDefine(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? path
  return defineName(file.replace(/\.(b?tiles)\.json$/i, ''))
}

/** The biggest buffer any packed room's `_DrawLayer` unpacks into — 0 when no room is packed. */
export function drawBufferBytes(doc: WorldDoc, rooms: ReadonlyMap<string, LoadedRoom>): number {
  let bytes = 0
  for (const path of new Set(doc.cells)) {
    const room = path ? rooms.get(path) : undefined
    if (!path || !room) continue
    const draw = roomDraw(path, room.doc)
    if (draw.kind === 'draw' && draw.compressed) bytes = Math.max(bytes, draw.unpacked)
  }
  return bytes
}

export function worldConstants(doc: WorldDoc, rooms: ReadonlyMap<string, LoadedRoom>, name: string): string[] {
  const prefix = defineName(name)
  const ids = roomIds(doc)
  // A map in several cells gets one define, for the first: a name has to mean one room.
  const roomDefines: string[] = []
  const used = new Set<string>()
  doc.cells.forEach((path, cell) => {
    if (!path) return
    const define = `${prefix}_ROOM_${roomDefine(path)}`
    if (used.has(define)) return
    used.add(define)
    roomDefines.push(`#define ${define} ${ids[cell]}`)
  })
  const tilesets = worldTilesets(doc, rooms)
  return [
    `#define ${prefix}_COLS ${doc.cols}`,
    `#define ${prefix}_ROWS ${doc.rows}`,
    `#define ${prefix}_ROOMS ${roomCount(doc)}`,
    `#define ${prefix}_NONE 0xFF`,
    ...DIRECTIONS.map((direction, index) => `#define ${prefix}_${direction.toUpperCase()} ${index}`),
    `#define ${prefix}_TILESETS ${tilesets.length}`,
    ...tilesets.map((path, index) => `#define ${prefix}_TILESET_${tilesetDefine(path)} ${index}`),
    `#define ${prefix}_DOORS ${doc.doors.length}`,
    `#define ${prefix}_DOOR_BYTES ${DOOR_BYTES}`,
    `#define ${prefix}_ENTITY_BYTES ${ENTITY_BYTES}`,
    `#define ${prefix}_ENTITY_TYPES ${doc.entityTypes.length}`,
    ...doc.entityTypes.map((type, index) => `#define ${prefix}_ENT_${defineName(type)} ${index + 1}`),
    // What `_DrawRoom`'s buffer has to hold; 0 when no room is packed.
    `#define ${prefix}_BUFFER_BYTES ${drawBufferBytes(doc, rooms)}`,
    ...roomDefines
  ]
}

export function worldNotes(doc: WorldDoc, rooms: ReadonlyMap<string, LoadedRoom>): string[] {
  const unique = new Set(doc.cells.filter(Boolean)).size
  return [
    `Grid: ${doc.cols}×${doc.rows} cells, ${roomCount(doc)} rooms (${unique} distinct maps)`,
    `Tilesets: ${worldTilesets(doc, rooms).join(', ') || 'none'}`,
    `Entity types: ${doc.entityTypes.join(', ') || 'none'}`,
    `Doors: ${doc.doors.length}`
  ]
}

/** `from` → `to`, as a relative `#include` path between two project-relative files. */
export function includePath(from: string, to: string): string {
  const fromDir = from.split('/').slice(0, -1)
  const target = to.split('/')
  let common = 0
  while (common < fromDir.length && common < target.length - 1 && fromDir[common] === target[common]) common++
  return [...new Array<string>(fromDir.length - common).fill('..'), ...target.slice(common)].join('/')
}

/**
 * The opt-in ready-made C: lookups, plus two dispatchers that call the rooms'
 * and tilesets' **own** exported helpers — so a room draws exactly as it would
 * on its own, live meta-tiles included, and a banked tileset loads through its
 * own `_Load()`. `out` is the world's header path, which the includes are
 * relative to.
 */
export function worldHelperC(doc: WorldDoc, rooms: ReadonlyMap<string, LoadedRoom>, name: string, out: string): HelperC {
  const prefix = defineName(name)
  const ids = roomIds(doc)

  // Room ids per drawable map, so a map in two cells is one case with two labels.
  const draws = new Map<string, { draw: RoomDraw & { kind: 'draw' }; ids: number[] }>()
  doc.cells.forEach((path, cell) => {
    const room = path ? rooms.get(path) : undefined
    if (!path || !room) return
    const draw = roomDraw(path, room.doc)
    if (draw.kind !== 'draw') return
    const entry = draws.get(path) ?? { draw, ids: [] }
    entry.ids.push(ids[cell])
    draws.set(path, entry)
  })
  const tilesetPaths = worldTilesets(doc, rooms)
  const loads = tilesetPaths.map((path) => {
    const room = [...rooms.values()].find((candidate) => candidate.doc.tileset === path)
    return tilesetLoad(room?.tileset)
  })
  const headers = [
    ...new Set([
      ...[...draws.values()].map(({ draw }) => draw.header),
      ...loads.flatMap((load) => (load.kind === 'load' ? [load.header] : []))
    ])
  ].sort()
  const packed = [...draws.values()].some(({ draw }) => draw.compressed)
  const animated = loads.some((load) => load.kind === 'load' && load.animated)

  // One static function per map, called from the switch. Not inlined into the
  // cases on purpose: SDCC 4.x, knowing `room` (in A) is 0 inside `case 0:`,
  // folds the constant 0, 0 arguments into an `ld hl, a` that does not exist,
  // and the build stops at the assembler.
  const drawFunctions = [...draws.values()].flatMap(({ draw }) => [
    '',
    `static void ${name}_Draw_${draw.name}(u8* buffer)`,
    '{',
    ...(draw.compressed ? [] : ['\tbuffer;']),
    draw.compressed ? `\t${draw.name}_DrawLayer(${draw.layer}, buffer, 0, 0);` : `\t${draw.name}_DrawLayer(${draw.layer}, 0, 0);`,
    ...(draw.placements ? [`\t${draw.name}_DrawPlacements();`] : []),
    '}'
  ])
  const drawCases = [...draws.values()].flatMap(({ draw, ids: labels }) => [
    ...labels.map((id) => `\tcase ${id}:`),
    `\t\t${name}_Draw_${draw.name}(buffer);`,
    '\t\treturn TRUE;'
  ])
  const loadCases = loads.flatMap((load, index) => {
    if (load.kind !== 'load') return []
    const count = load.count >= 256 ? 0 : load.count
    return [
      `\tcase ${index}:`,
      ...(load.banked
        ? [`\t\t${load.name}_Load();`]
        : [`\t\tVDP_LoadPattern_GM2(${load.name}_Patterns, ${count}, 0);`, `\t\tVDP_LoadColor_GM2(${load.name}_Colors, ${count}, 0);`]),
      ...(load.animated ? [`\t\t${load.name}_AnimReset();`] : []),
      '\t\treturn TRUE;'
    ]
  })
  const animateCases = loads.flatMap((load, index) =>
    load.kind === 'load' && load.animated ? [`\tcase ${index}:`, `\t\t${load.name}_Animate();`, '\t\tbreak;'] : []
  )

  return {
    header: [
      '',
      `// Ready-made C for the world ${name}. Every room draws itself through its own`,
      '// export — this only finds rooms and calls their helpers. Needs MSXgl\'s VDP',
      '// module (#include "msxgl.h" before this header), and each room\'s and',
      '// tileset\'s own ready-made C, which _DrawRoom and _LoadTileset call.',
      ...(packed
        ? [
            `// Some rooms are RLEp-packed: _DrawRoom unpacks them into \`buffer\` (${prefix}_BUFFER_BYTES`,
            '// bytes — make it a global) with MSXgl\'s RLEp_UnpackToRAM: add the "compress"',
            '// library module. The buffer keeps the room\'s tiles: read it for collision.'
          ]
        : ['// No room is packed, so _DrawRoom\'s `buffer` may be NULL.']),
      '//',
      '// Example:',
      `//   u8 tileset = ${prefix}_NONE;`,
      `//   void Enter(u8 room)`,
      '//   {',
      `//       if (${name}_TilesetOf(room) != tileset)`,
      `//           ${name}_LoadTileset(tileset = ${name}_TilesetOf(room));`,
      `//       if (!${name}_DrawRoom(room, g_Buffer))`,
      '//           DrawItMyself(room);   // a room bigger than a screen, say',
      '//   }',
      `//   ...  u8 next = ${name}_Neighbour(room, ${prefix}_EAST);   // ${prefix}_NONE at a wall`,
      '',
      `// The room id at a grid column and row, or ${prefix}_NONE.`,
      `u8 ${name}_RoomAt(u8 col, u8 row);`,
      `// The room beyond an edge (${prefix}_NORTH/_EAST/_SOUTH/_WEST), or ${prefix}_NONE.`,
      `u8 ${name}_Neighbour(u8 room, u8 dir);`,
      '// A room\'s size in tiles — rooms are not all one size.',
      `u8 ${name}_RoomW(u8 room);`,
      `u8 ${name}_RoomH(u8 room);`,
      '// Which _TILESET_ the room draws with.',
      `u8 ${name}_TilesetOf(u8 room);`,
      '// The room\'s entity list: a count, then type, x, y, param per entity.',
      `const u8* ${name}_RoomEntities(u8 room);`,
      `// The door at (x, y) in a room, as an index into _Doors, or ${prefix}_NONE.`,
      `u8 ${name}_DoorAt(u8 room, u8 x, u8 y);`,
      '// Loads a tileset through its own export (a banked one through its _Load()),',
      '// and resets its animations. FALSE for one it cannot load — see the editor.',
      `bool ${name}_LoadTileset(u8 tileset);`,
      ...(animated ? ['// Plays the animations of a tileset loaded by _LoadTileset — once per frame.', `void ${name}_Animate(u8 tileset);`] : []),
      '// Draws a room at the top-left of the name table with its own _DrawLayer, then',
      '// its live meta-tiles with its own _DrawPlacements. FALSE for a room it',
      '// leaves to you (bigger than a screen, no ready-made C…) — see the editor.',
      `bool ${name}_DrawRoom(u8 room, u8* buffer);`
    ],
    source: [
      ...headers.map((header) => `#include "${includePath(out, header)}"`),
      '',
      `u8 ${name}_RoomAt(u8 col, u8 row)`,
      '{',
      `\tif (col >= ${prefix}_COLS || row >= ${prefix}_ROWS)`,
      `\t\treturn ${prefix}_NONE;`,
      `\treturn ${name}_Grid[(u16)row * ${prefix}_COLS + col];`,
      '}',
      '',
      `u8 ${name}_Neighbour(u8 room, u8 dir)`,
      '{',
      `\treturn ${name}_Neighbours[(u16)room * 4 + (dir & 3)];`,
      '}',
      '',
      `u8 ${name}_RoomW(u8 room)`,
      '{',
      `\treturn ${name}_RoomSize[(u16)room * 2];`,
      '}',
      '',
      `u8 ${name}_RoomH(u8 room)`,
      '{',
      `\treturn ${name}_RoomSize[(u16)room * 2 + 1];`,
      '}',
      '',
      `u8 ${name}_TilesetOf(u8 room)`,
      '{',
      `\treturn ${name}_RoomTileset[room];`,
      '}',
      '',
      `const u8* ${name}_RoomEntities(u8 room)`,
      '{',
      `\tconst u8* at = ${name}_EntityOffsets + (u16)room * 2;`,
      `\treturn ${name}_Entities + (at[0] | ((u16)at[1] << 8));`,
      '}',
      '',
      `u8 ${name}_DoorAt(u8 room, u8 x, u8 y)`,
      '{',
      // `_Doors` only exists when there are doors; the define keeps the loop honest.
      `#if ${prefix}_DOORS > 0`,
      '\tu8 i;',
      `\tconst u8* door = ${name}_Doors;`,
      `\tfor (i = 0; i < ${prefix}_DOORS; i++, door += ${prefix}_DOOR_BYTES)`,
      '\t\tif (door[0] == room && door[1] == x && door[2] == y)',
      '\t\t\treturn i;',
      '#else',
      '\troom; x; y;',
      '#endif',
      `\treturn ${prefix}_NONE;`,
      '}',
      '',
      `bool ${name}_LoadTileset(u8 tileset)`,
      '{',
      ...(loadCases.length ? ['\tswitch (tileset)', '\t{', ...loadCases, '\t}'] : ['\ttileset;']),
      '\treturn FALSE;',
      '}',
      ...(animated
        ? ['', `void ${name}_Animate(u8 tileset)`, '{', '\tswitch (tileset)', '\t{', ...animateCases, '\t}', '}']
        : []),
      ...drawFunctions,
      '',
      `bool ${name}_DrawRoom(u8 room, u8* buffer)`,
      '{',
      ...(drawCases.length ? [] : ['\tbuffer;']),
      ...(drawCases.length ? ['\tswitch (room)', '\t{', ...drawCases, '\t}'] : ['\troom;']),
      '\treturn FALSE;',
      '}'
    ]
  }
}

// ── Editing ─────────────────────────────────────────────────────────────────

/** Puts a room (or nothing) in a cell. Doors from or to an emptied cell go with it. */
export function setRoom(doc: WorldDoc, cell: number, path: string | null): WorldDoc {
  if (cell < 0 || cell >= doc.cells.length) return doc
  const cells = [...doc.cells]
  cells[cell] = path || null
  const doors = path ? doc.doors : doc.doors.filter((door) => door.room !== cell && door.to !== cell)
  return { ...doc, cells, doors }
}

/** Swaps two cells' rooms — a drag in the editor. Doors follow their rooms. */
export function moveRoom(doc: WorldDoc, from: number, to: number): WorldDoc {
  if (from === to || from < 0 || to < 0 || from >= doc.cells.length || to >= doc.cells.length) return doc
  const cells = [...doc.cells]
  ;[cells[from], cells[to]] = [cells[to], cells[from]]
  const swap = (cell: number): number => (cell === from ? to : cell === to ? from : cell)
  return { ...doc, cells, doors: doc.doors.map((door) => ({ ...door, room: swap(door.room), to: swap(door.to) })) }
}

/**
 * Resizes the grid, keeping every room at its column and row (top-left
 * anchored). Rooms — and doors — that fall off the new edge are dropped.
 */
export function resizeWorld(doc: WorldDoc, cols: number, rows: number): WorldDoc {
  cols = Math.min(64, Math.max(1, cols | 0))
  rows = Math.min(64, Math.max(1, rows | 0))
  const remap = (cell: number): number => {
    const { col, row } = colRowOf(doc, cell)
    return col < cols && row < rows ? row * cols + col : -1
  }
  const cells: (string | null)[] = new Array<string | null>(cols * rows).fill(null)
  doc.cells.forEach((path, cell) => {
    const next = remap(cell)
    if (next >= 0) cells[next] = path
  })
  const doors = doc.doors
    .map((door) => ({ ...door, room: remap(door.room), to: remap(door.to) }))
    .filter((door) => door.room >= 0 && door.to >= 0)
  return { ...doc, cols, rows, cells, doors }
}

export function addEntityType(doc: WorldDoc, type: string): WorldDoc {
  if (!isEntityTypeName(type) || doc.entityTypes.includes(type) || doc.entityTypes.length >= MAX_ENTITY_TYPES) return doc
  return { ...doc, entityTypes: [...doc.entityTypes, type] }
}

/** Removing a type renumbers every type after it — the editor says so before calling this. */
export function removeEntityType(doc: WorldDoc, type: string): WorldDoc {
  return { ...doc, entityTypes: doc.entityTypes.filter((name) => name !== type) }
}

export function addDoor(doc: WorldDoc, door: WorldDoor): WorldDoc {
  return { ...doc, doors: [...doc.doors, { ...door }] }
}

export function updateDoor(doc: WorldDoc, index: number, patch: Partial<WorldDoor>): WorldDoc {
  return { ...doc, doors: doc.doors.map((door, i) => (i === index ? { ...door, ...patch } : door)) }
}

export function removeDoor(doc: WorldDoc, index: number): WorldDoc {
  return { ...doc, doors: doc.doors.filter((_, i) => i !== index) }
}

// ── Slicing a big map into rooms ────────────────────────────────────────────

export interface SliceResult {
  cols: number
  rows: number
  /** Row-major, `cols * rows`; null where `skipEmpty` dropped a room with nothing in it. */
  rooms: (MapDoc | null)[]
  /** What could not be carried over cleanly, one line each — shown to the user. */
  warnings: string[]
}

/** True when nothing in a room is worth a file: every layer all tile 0, no placements, no entities. */
export function isEmptyRoom(doc: MapDoc): boolean {
  return (
    doc.layers.every((layer) => layer.data.every((value) => value === 0) && !layer.placements.length) &&
    !mapEntities(doc).length
  )
}

/**
 * Cuts a map into `roomWidth × roomHeight` rooms — design the overworld as one
 * canvas, ship it as rooms. When the map is not a whole number of rooms, the
 * last column and row are simply smaller: rooms need not share a size.
 *
 * Each room keeps the map's tileset, cell geometry, layers and meta table, so
 * it is a complete map that exports and draws itself. A placement goes to the
 * room its top-left corner is in; one that would hang over that room's edge is
 * dropped with a warning rather than cropped, the same choice `validateMap`
 * makes. Entities go to the room they stand in. The export block is the
 * caller's — it is named after the room's own file (`sliceIntoRooms`).
 */
export function sliceMap(source: MapDoc, roomWidth: number, roomHeight: number, skipEmpty = false): SliceResult {
  roomWidth = Math.max(1, roomWidth | 0)
  roomHeight = Math.max(1, roomHeight | 0)
  const cols = Math.ceil(source.width / roomWidth)
  const rows = Math.ceil(source.height / roomHeight)
  const warnings: string[] = []
  const rooms: (MapDoc | null)[] = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const ox = col * roomWidth
      const oy = row * roomHeight
      const width = Math.min(roomWidth, source.width - ox)
      const height = Math.min(roomHeight, source.height - oy)
      const layers: MapLayer[] = source.layers.map((layer) => {
        const data = new Array<number>(width * height).fill(0)
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) data[y * width + x] = layer.data[(oy + y) * source.width + ox + x] ?? 0
        }
        const placements = layer.placements.flatMap((placement) => {
          if (placement.x < ox || placement.y < oy || placement.x >= ox + width || placement.y >= oy + height) return []
          const ref = source.metas[placement.slot]
          const x = placement.x - ox
          const y = placement.y - oy
          if (ref && (x + ref.width > width || y + ref.height > height)) {
            warnings.push(
              `"${ref.name}" at ${placement.x},${placement.y} on "${layer.name}" crosses into the next room and was left out of room ${col},${row}`
            )
            return []
          }
          return [{ ...placement, x, y }]
        })
        const out: MapLayer = { ...layer, data, placements }
        return out
      })
      const entities: MapEntity[] = mapEntities(source)
        .filter((entity) => entity.x >= ox && entity.y >= oy && entity.x < ox + width && entity.y < oy + height)
        .map((entity) => ({ ...entity, x: entity.x - ox, y: entity.y - oy }))
      const room = withEntities(
        {
          ...source,
          width,
          height,
          layers,
          metas: source.metas.map((ref) => ({ ...ref })),
          export: null
        },
        entities
      )
      rooms.push(skipEmpty && isEmptyRoom(room) ? null : room)
    }
  }
  return { cols, rows, rooms, warnings }
}

/** The file a sliced room is written to: `res/overworld.map.json` → `res/overworld_r0_c1.map.json`. */
export function slicedRoomPath(sourcePath: string, col: number, row: number): string {
  return sourcePath.replace(/\.map\.json$/i, '') + `_r${row}_c${col}.map.json`
}

/** A world over sliced rooms, sized to them. `paths` is row-major, null for a skipped room. */
export function worldFromSlices(
  cols: number,
  rows: number,
  paths: readonly (string | null)[],
  entityTypes: readonly string[] = []
): WorldDoc {
  return normalizeWorld({ cols, rows, cells: [...paths], entityTypes: [...entityTypes] })
}
