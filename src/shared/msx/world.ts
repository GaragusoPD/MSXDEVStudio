/**
 * `*.world.json`: a grid of rooms — the flip-screen world of a Zelda-like or a
 * metroidvania, one screen per cell.
 *
 * Every room is an ordinary `*.map.json`, painted in the map editor like any
 * other. The world owns only what ties them together:
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
 * Why a world rather than one big map: a game with 16 KB of RAM cannot unpack
 * an 8×8-screen map (49 KB of name table) to draw a piece of it, and a banked
 * SCREEN 2 tileset only works one screen tall. A room unpacks into 768 bytes,
 * gets all three banks to itself, and packs into ROM on its own.
 *
 * The export embeds the rooms: one header carries every room's name table
 * (RLEp-packed on request), its entities, the neighbour table and the doors,
 * so the room maps themselves need no export of their own. A map used in two
 * cells is stored once.
 *
 * `shared/` cannot open files, so everything here takes the rooms already read
 * (`LoadedRoom`); `main/services/resources.ts` reads them for the build and the
 * world editor reads them for the screen.
 */

import { packRlep } from './compress'
import { defineName, type HelperC } from './emitC'
import { isSc3NameTable, mapEntities, SCREEN_COLS, SCREEN_ROWS, withEntities, type MapDoc, type MapLayer } from './map'
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
  /** Every room's size, in tiles. One screen is 32×24; a HUD takes rows off the height. */
  roomWidth: number
  roomHeight: number
  /** The name-table row a room is drawn at — the HUD's height, when it sits on top. */
  top: number
  /** Which layer of each room is its name table, by name; empty means each room's first layer. */
  layer: string
  /** `cols * rows` project-relative `*.map.json` paths, row-major; null is no room. */
  cells: (string | null)[]
  /** The entity types, in id order from 1. Append-only in the editor, so ids never shift under a game. */
  entityTypes: string[]
  doors: WorldDoor[]
  export: ExportBlock | null
}

/** A room as read from its file, plus what only the tileset file could say. */
export interface LoadedRoom {
  doc: MapDoc
  /** Its tileset gives the three banks art of their own — which only works at screen row 0, 24 rows tall. */
  banked?: boolean
}

/** 0xFF is "no room" in every table, so 255 rooms fit. */
export const NO_ROOM = 0xff
export const MAX_WORLD_ROOMS = 255
/** Bytes per door: room, x, y, to, toX, toY. */
export const DOOR_BYTES = 6
/** The neighbour table's order, and the `_NORTH`/… defines. */
export const DIRECTIONS = ['north', 'east', 'south', 'west'] as const
export type Direction = (typeof DIRECTIONS)[number]

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
  return {
    version: 1,
    cols,
    rows,
    roomWidth: at(input.roomWidth, SCREEN_COLS, 1, SCREEN_COLS),
    roomHeight: at(input.roomHeight, SCREEN_ROWS, 1, SCREEN_ROWS),
    top: at(input.top, 0, 0, SCREEN_ROWS - 1),
    layer: typeof input.layer === 'string' ? input.layer : '',
    cells,
    entityTypes: types,
    doors,
    export: input.export ?? null
  }
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

/** The layer of a room that is its name table: the world's `layer` by name, or its first. */
export function roomLayer(doc: WorldDoc, room: MapDoc): MapLayer | undefined {
  return doc.layer ? room.layers.find((layer) => layer.name === doc.layer) : room.layers[0]
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

/**
 * Everything that stops the world from exporting — or would export a world
 * that draws wrong. Each message names the room by its grid position and file.
 */
export function validateWorld(doc: WorldDoc, rooms: ReadonlyMap<string, LoadedRoom>): string[] {
  const problems: string[] = []
  if (doc.version !== 1) problems.push(`Unsupported version ${doc.version}`)
  const count = roomCount(doc)
  if (!count) problems.push('The world has no rooms — put a map in at least one cell')
  if (count > MAX_WORLD_ROOMS) problems.push(`${count} rooms — at most ${MAX_WORLD_ROOMS} fit (room ids are one byte, 0xFF is "none")`)
  if (doc.top + doc.roomHeight > SCREEN_ROWS) {
    problems.push(`Rooms drawn from row ${doc.top} and ${doc.roomHeight} tall run past the screen's ${SCREEN_ROWS} rows`)
  }
  if (doc.entityTypes.length > MAX_ENTITY_TYPES) problems.push(`${doc.entityTypes.length} entity types — at most ${MAX_ENTITY_TYPES} fit`)

  const declared = new Set(doc.entityTypes)
  const missingTypes = new Set<string>()
  const where = (cell: number, path: string): string => {
    const { col, row } = colRowOf(doc, cell)
    return `Room ${col},${row} (${path})`
  }
  const checked = new Set<string>()
  doc.cells.forEach((path, cell) => {
    if (!path || checked.has(path)) return
    checked.add(path)
    const room = rooms.get(path)
    const name = where(cell, path)
    if (!room) {
      problems.push(`${name} could not be read`)
      return
    }
    const map = room.doc
    if (map.width !== doc.roomWidth || map.height !== doc.roomHeight) {
      problems.push(`${name} is ${map.width}×${map.height}, but this world's rooms are ${doc.roomWidth}×${doc.roomHeight}`)
    }
    // A room is drawn with one name-table write; a bitmap map has no name table.
    if (map.cell && !isSc3NameTable(map)) {
      problems.push(`${name} is a bitmap-mode map — world rooms are name-table maps (SCREEN 1, 2, 4, or SCREEN 3 with 2×2 tiles)`)
    }
    const layer = roomLayer(doc, map)
    if (!layer) {
      problems.push(`${name} has no layer called "${doc.layer}"`)
    } else {
      if (layer.indexed) {
        problems.push(`${name}: layer "${layer.name}" is indexed — a world room is drawn from a tile layer`)
      }
      // A live placement is drawn at runtime by the map's own helper, which the
      // world does not carry. Baked ones are already in the grid.
      const live = layer.placements.filter((placement) => !placement.baked).length
      if (live) {
        problems.push(
          `${name} places ${live} live meta-tile${live === 1 ? '' : 's'} on "${layer.name}" — bake ${live === 1 ? 'it' : 'them'} ` +
            '(select, then Bake) so the room\'s name table holds the art'
        )
      }
    }
    if (room.banked && (doc.top !== 0 || doc.roomHeight !== SCREEN_ROWS)) {
      problems.push(
        `${name} uses a banked tileset, which only draws right ${SCREEN_ROWS} rows tall from row 0 — ` +
          'set the world\'s rooms to 24 rows and top 0, or use an unbanked tileset'
      )
    }
    problems.push(...entityProblems(mapEntities(map), name))
    for (const entity of mapEntities(map)) if (!declared.has(entity.type)) missingTypes.add(entity.type)
  })
  if (missingTypes.size) {
    problems.push(
      `Entity type${missingTypes.size === 1 ? '' : 's'} ${[...missingTypes].sort().map((type) => `"${type}"`).join(', ')} ` +
        'used in rooms but not declared in the world — add them to its entity types'
    )
  }

  doc.doors.forEach((door, index) => {
    const label = `Door ${index + 1}`
    const from = doc.cells[door.room]
    const to = doc.cells[door.to]
    if (!from) problems.push(`${label} is in an empty cell`)
    if (!to) problems.push(`${label} leads to an empty cell`)
    if (door.x >= doc.roomWidth || door.y >= doc.roomHeight || door.x < 0 || door.y < 0) {
      problems.push(`${label} at ${door.x},${door.y} is outside its ${doc.roomWidth}×${doc.roomHeight} room`)
    }
    if (door.toX >= doc.roomWidth || door.toY >= doc.roomHeight || door.toX < 0 || door.toY < 0) {
      problems.push(`${label} arrives at ${door.toX},${door.toY}, outside the ${doc.roomWidth}×${doc.roomHeight} room`)
    }
  })
  if (doc.doors.length > 255) problems.push(`${doc.doors.length} doors — at most 255 fit`)
  return problems
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

/** One table a world exports; `resource.ts` turns these into `EmitTable`s. */
export interface WorldTable {
  suffix: string
  bytes: Uint8Array
  perLine: number
  comment: string
}

export interface WorldExport {
  /** RLEp actually applied — asked for *and* every room shrank. */
  compressed: boolean
  tables: WorldTable[]
  /** Unpacked bytes of one room: what a buffer for `_DrawRoom` holds. */
  roomBytes: number
}

/**
 * The world as tables. The single decision point for compression, the way
 * `mapExport` is for a map: all rooms pack or none do, because one
 * `_DrawRoom()` serves them all and cannot unpack some of them.
 *
 * A map that sits in several cells is stored once — its offsets repeat.
 */
export function worldExport(
  doc: WorldDoc,
  rooms: ReadonlyMap<string, LoadedRoom>,
  compress: ExportBlock['compress']
): WorldExport {
  const roomBytes = doc.roomWidth * doc.roomHeight
  const cells = roomCells(doc)
  const paths = [...new Set(cells.map((cell) => doc.cells[cell]!))]
  const raw = new Map<string, Uint8Array>()
  for (const path of paths) {
    const map = rooms.get(path)?.doc
    const layer = map ? roomLayer(doc, map) : undefined
    const bytes = new Uint8Array(roomBytes)
    if (map && layer) {
      for (let y = 0; y < Math.min(doc.roomHeight, map.height); y++) {
        for (let x = 0; x < Math.min(doc.roomWidth, map.width); x++) {
          bytes[y * doc.roomWidth + x] = (layer.data[y * map.width + x] ?? 0) & 0xff
        }
      }
    }
    raw.set(path, bytes)
  }
  let stored = raw
  let compressed = false
  if (compress === 'rlep' && paths.length) {
    const packed = new Map(paths.map((path) => [path, packRlep(raw.get(path)!)]))
    if (paths.every((path) => packed.get(path)!.length < raw.get(path)!.length)) {
      stored = packed
      compressed = true
    }
  }

  // Room data and entity lists, each map once, in first-use order.
  const roomOffset = new Map<string, number>()
  const entityOffset = new Map<string, number>()
  const roomData: number[] = []
  const entityData: number[] = []
  const ids = entityIds(doc.entityTypes)
  for (const path of paths) {
    roomOffset.set(path, roomData.length)
    roomData.push(...stored.get(path)!)
    const entities = mapEntities(rooms.get(path)?.doc ?? ({} as MapDoc))
    entityOffset.set(path, entityData.length)
    entityData.push(entities.length, ...entityBytes(entities, ids))
  }

  // The offset tables are 16-bit, and one Z80 page could not hold more anyway.
  if (roomData.length > 0xffff) {
    throw new Error(
      `The rooms come to ${roomData.length} bytes — more than a 16-bit offset can reach. ` +
        (compressed ? 'Split the world in two.' : 'Turn on RLEp compression, or split the world in two.')
    )
  }
  const tilesets = worldTilesets(doc, rooms)
  const idOf = roomIds(doc)
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
      suffix: '_RoomTileset',
      bytes: Uint8Array.from(cells.map((cell) => Math.max(0, tilesets.indexOf(rooms.get(doc.cells[cell]!)?.doc.tileset ?? '')))),
      perLine: 16,
      comment: 'Per room: which tileset it draws with — the _TILESET_ defines'
    },
    {
      suffix: '_RoomOffsets',
      bytes: offsetBytes(cells.map((cell) => roomOffset.get(doc.cells[cell]!)!)),
      perLine: 16,
      comment: 'Per room: where its name table starts in _Rooms — two bytes, low first'
    },
    {
      suffix: '_Rooms',
      bytes: Uint8Array.from(roomData),
      perLine: compressed ? 16 : Math.min(32, doc.roomWidth),
      comment: compressed
        ? `Every room's name table, ${doc.roomWidth}×${doc.roomHeight}, RLEp-packed — ${paths.length} × ${roomBytes} → ${roomData.length} bytes. ` +
          'Unpack with RLEp_UnpackToRAM.'
        : `Every room's name table, ${doc.roomWidth}×${doc.roomHeight}, ${roomBytes} bytes each`
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
      comment: 'Per room: a count, then type, x, y, param per entity — ids from the _ENT_ defines'
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
  return { compressed, tables, roomBytes }
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

export function worldConstants(doc: WorldDoc, rooms: ReadonlyMap<string, LoadedRoom>, name: string): string[] {
  const prefix = defineName(name)
  const ids = roomIds(doc)
  // A map in several cells gets one define, for the first: a name has to mean one room.
  const named = new Set<string>()
  const roomDefines: string[] = []
  const usedNames = new Set<string>()
  doc.cells.forEach((path, cell) => {
    if (!path || named.has(path)) return
    named.add(path)
    // A map called `w` or `bytes` would collide with the geometry defines.
    const stem = roomDefine(path)
    const define = `${prefix}_ROOM_${['W', 'H', 'BYTES'].includes(stem) ? `${stem}_MAP` : stem}`
    if (usedNames.has(define)) return
    usedNames.add(define)
    roomDefines.push(`#define ${define} ${ids[cell]}`)
  })
  const tilesets = worldTilesets(doc, rooms)
  return [
    `#define ${prefix}_COLS ${doc.cols}`,
    `#define ${prefix}_ROWS ${doc.rows}`,
    `#define ${prefix}_ROOMS ${roomCount(doc)}`,
    `#define ${prefix}_ROOM_W ${doc.roomWidth}`,
    `#define ${prefix}_ROOM_H ${doc.roomHeight}`,
    `#define ${prefix}_ROOM_BYTES ${doc.roomWidth * doc.roomHeight}`,
    `#define ${prefix}_TOP ${doc.top}`,
    `#define ${prefix}_NONE 0xFF`,
    ...DIRECTIONS.map((direction, index) => `#define ${prefix}_${direction.toUpperCase()} ${index}`),
    `#define ${prefix}_TILESETS ${tilesets.length}`,
    ...tilesets.map((path, index) => `#define ${prefix}_TILESET_${tilesetDefine(path)} ${index}`),
    `#define ${prefix}_DOORS ${doc.doors.length}`,
    `#define ${prefix}_DOOR_BYTES ${DOOR_BYTES}`,
    `#define ${prefix}_ENTITY_BYTES ${ENTITY_BYTES}`,
    `#define ${prefix}_ENTITY_TYPES ${doc.entityTypes.length}`,
    ...doc.entityTypes.map((type, index) => `#define ${prefix}_ENT_${defineName(type)} ${index + 1}`),
    ...roomDefines
  ]
}

export function worldNotes(doc: WorldDoc, rooms: ReadonlyMap<string, LoadedRoom>): string[] {
  const unique = new Set(doc.cells.filter(Boolean)).size
  return [
    `Grid: ${doc.cols}×${doc.rows} cells, ${roomCount(doc)} rooms (${unique} distinct maps)`,
    `Room: ${doc.roomWidth}×${doc.roomHeight} tiles, drawn from row ${doc.top}`,
    `Layer: ${doc.layer || 'each room\'s first'}`,
    `Tilesets: ${worldTilesets(doc, rooms).join(', ') || 'none'}`,
    `Entity types: ${doc.entityTypes.join(', ') || 'none'}`,
    `Doors: ${doc.doors.length}`
  ]
}

/**
 * The opt-in ready-made C. Lookups plus one draw call; the game keeps the rules.
 *
 * It does not load tilesets: which tileset a room draws with is in
 * `_RoomTileset`, and loading one is the tileset's own header's business (its
 * patterns and colours, or its banked `_Load()`), so the game switches when the
 * id changes.
 */
export function worldHelperC(name: string, compressed: boolean): HelperC {
  const prefix = defineName(name)
  const draw = compressed
    ? `void ${name}_DrawRoom(u8 room, u8* buffer)`
    : `void ${name}_DrawRoom(u8 room)`
  return {
    header: [
      '',
      `// Ready-made C for the world ${name}. Needs MSXgl's VDP module`,
      '// (#include "msxgl.h" before this header) built with VDP_USE_MODE_G2.',
      ...(compressed
        ? [
            '// The rooms are RLEp-packed, so this also needs the "compress" library module',
            '// and COMPRESS_USE_RLEP TRUE / COMPRESS_USE_RLEP_DEFAULT TRUE in msxgl_config.h.',
            `// \`buffer\` holds ${prefix}_ROOM_BYTES bytes, and keeps the room's tiles after`,
            '// the draw — read it for collision (buffer[y * ROOM_W + x], then the tileset\'s',
            '// _Flags). Make it a global: a local that size does not fit on the stack.'
          ]
        : ['// The rooms are raw, so _RoomData() is the room\'s tiles in ROM — read it for collision.']),
      '//',
      '// Example:',
      ...(compressed
        ? [`//   u8 g_RoomBuffer[${prefix}_ROOM_BYTES];`, `//   ${name}_DrawRoom(room, g_RoomBuffer);`]
        : [`//   ${name}_DrawRoom(room);`]),
      `//   u8 next = ${name}_Neighbour(room, ${prefix}_EAST);   // ${prefix}_NONE at a wall`,
      `//   const u8* e = ${name}_RoomEntities(room);          // e[0] = count, then 4 bytes each`,
      '',
      `// The room id at a grid column and row, or ${prefix}_NONE.`,
      `u8 ${name}_RoomAt(u8 col, u8 row);`,
      `// The room beyond an edge (${prefix}_NORTH/_EAST/_SOUTH/_WEST), or ${prefix}_NONE.`,
      `u8 ${name}_Neighbour(u8 room, u8 dir);`,
      '// Which _TILESET_ the room draws with.',
      `u8 ${name}_TilesetOf(u8 room);`,
      `// The room's bytes in _Rooms${compressed ? ' (packed — unpack before reading)' : ''}.`,
      `const u8* ${name}_RoomData(u8 room);`,
      '// The room\'s entity list: a count, then type, x, y, param per entity.',
      `const u8* ${name}_RoomEntities(u8 room);`,
      `// The door at (x, y) in a room, as an index into _Doors, or ${prefix}_NONE.`,
      `u8 ${name}_DoorAt(u8 room, u8 x, u8 y);`,
      `// Draws a room into the name table at column 0, row ${prefix}_TOP.`,
      `${draw};`
    ],
    source: [
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
      `u8 ${name}_TilesetOf(u8 room)`,
      '{',
      `\treturn ${name}_RoomTileset[room];`,
      '}',
      '',
      `const u8* ${name}_RoomData(u8 room)`,
      '{',
      `\tconst u8* at = ${name}_RoomOffsets + (u16)room * 2;`,
      `\treturn ${name}_Rooms + (at[0] | ((u16)at[1] << 8));`,
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
      draw,
      '{',
      ...(compressed
        ? [
            `\tRLEp_UnpackToRAM(${name}_RoomData(room), buffer);`,
            `\tVDP_WriteLayout_GM2(buffer, 0, ${prefix}_TOP, ${prefix}_ROOM_W, ${prefix}_ROOM_H);`
          ]
        : [`\tVDP_WriteLayout_GM2(${name}_RoomData(room), 0, ${prefix}_TOP, ${prefix}_ROOM_W, ${prefix}_ROOM_H);`]),
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
 * canvas, ship it as rooms. The edge rooms are padded with tile 0 when the map
 * is not a whole number of rooms.
 *
 * Each room keeps the map's tileset, cell geometry and meta table. A placement
 * goes to the room its top-left corner is in; one that would hang over that
 * room's edge is dropped with a warning rather than cropped, the same choice
 * `validateMap` makes. Entities go to the room they stand in. No room gets an
 * export block: the world carries them.
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
      const layers: MapLayer[] = source.layers.map((layer) => {
        const data = new Array<number>(roomWidth * roomHeight).fill(0)
        for (let y = 0; y < roomHeight; y++) {
          for (let x = 0; x < roomWidth; x++) {
            const sx = ox + x
            const sy = oy + y
            if (sx < source.width && sy < source.height) data[y * roomWidth + x] = layer.data[sy * source.width + sx] ?? 0
          }
        }
        const placements = layer.placements.flatMap((placement) => {
          if (placement.x < ox || placement.y < oy || placement.x >= ox + roomWidth || placement.y >= oy + roomHeight) return []
          const ref = source.metas[placement.slot]
          const x = placement.x - ox
          const y = placement.y - oy
          if (ref && (x + ref.width > roomWidth || y + ref.height > roomHeight)) {
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
        .filter((entity) => entity.x >= ox && entity.y >= oy && entity.x < ox + roomWidth && entity.y < oy + roomHeight)
        .map((entity) => ({ ...entity, x: entity.x - ox, y: entity.y - oy }))
      const room = withEntities(
        {
          ...source,
          width: roomWidth,
          height: roomHeight,
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
  roomWidth: number,
  roomHeight: number,
  entityTypes: readonly string[] = []
): WorldDoc {
  return normalizeWorld({ cols, rows, roomWidth, roomHeight, cells: [...paths], entityTypes: [...entityTypes] })
}
