import { describe, expect, it } from 'vitest'
import { normalizeMap, withEntities, type MapDoc } from './map'
import { parseResource, renderResourceFiles, serializeResource, validateResource } from './resource'
import { normalizeTiles } from './tile'
import {
  addDoor,
  createWorldDoc,
  includePath,
  isEmptyRoom,
  loadedTileset,
  moveRoom,
  neighbours,
  NO_ROOM,
  normalizeWorld,
  resizeWorld,
  roomDraw,
  roomIds,
  setRoom,
  slicedRoomPath,
  sliceMap,
  tilesetLoad,
  undeclaredEntityTypes,
  validateWorld,
  worldFromSlices,
  worldHelperC,
  worldNotices,
  worldTables,
  type LoadedRoom,
  type WorldDoc
} from './world'

/** A room over `tileset`, exporting its own C with ready-made helpers — as sliced and new rooms do. */
function room(name: string, extra: Partial<MapDoc> = {}, tileset = 'res/over.tiles.json'): MapDoc {
  return normalizeMap({
    tileset,
    export: { name, format: 'c', out: `content/${name.slice(2).toLowerCase()}.h`, helpers: true },
    ...extra
  })
}

const OVER = loadedTileset(
  'res/over.tiles.json',
  normalizeTiles({ mode: 'sc2', count: 4, export: { name: 'g_Over', format: 'c', out: 'content/over.h', helpers: true } })
)

function loaded(entries: Record<string, MapDoc>): Map<string, LoadedRoom> {
  return new Map(Object.entries(entries).map(([path, doc]) => [path, { doc, ...(doc.tileset === OVER.path ? { tileset: OVER } : {}) }]))
}

/** 3×2: A B . / . C A — A twice, and C a tall room over another tileset. */
function sample(): { world: WorldDoc; rooms: Map<string, LoadedRoom> } {
  const world = normalizeWorld({
    cols: 3,
    rows: 2,
    cells: ['res/a.map.json', 'res/b.map.json', null, null, 'res/c.map.json', 'res/a.map.json']
  })
  const rooms = loaded({
    'res/a.map.json': room('g_A'),
    'res/b.map.json': room('g_B', { height: 22 }),
    'res/c.map.json': room('g_C', { height: 48 }, 'res/cave.tiles.json')
  })
  return { world, rooms }
}

const table = (tables: ReturnType<typeof worldTables>, suffix: string): number[] => [...tables.find((t) => t.suffix === suffix)!.bytes]

describe('world grid', () => {
  it('normalizes a bare file to a 4×4 grid of empty cells — rooms carry their own size', () => {
    const world = createWorldDoc()
    expect(world.cells).toHaveLength(16)
    expect(world.cells.every((cell) => cell === null)).toBe(true)
    expect(Object.keys(world).sort()).toEqual(['cells', 'cols', 'doors', 'entityTypes', 'export', 'rows', 'version'])
  })

  it('numbers rooms in reading order, and an empty cell is a wall', () => {
    const { world } = sample()
    expect(roomIds(world)).toEqual([0, 1, NO_ROOM, NO_ROOM, 2, 3])
    // N, E, S, W per room
    expect(neighbours(world)).toEqual([
      [NO_ROOM, 1, NO_ROOM, NO_ROOM], // a(0,0): east is b, south is empty
      [NO_ROOM, NO_ROOM, 2, 0], // b(1,0): south is c, west is a
      [1, 3, NO_ROOM, NO_ROOM], // c(1,1)
      [NO_ROOM, NO_ROOM, NO_ROOM, 2] // a again at (2,1): north is the empty cell
    ])
  })

  it('exports navigation, never tile data: each room\'s size and tileset, no name tables', () => {
    const { world, rooms } = sample()
    const tables = worldTables(world, rooms)
    expect(tables.map((t) => t.suffix)).toEqual(['_Grid', '_Neighbours', '_RoomSize', '_RoomTileset', '_EntityOffsets', '_Entities'])
    expect(table(tables, '_RoomSize')).toEqual([32, 24, 32, 22, 32, 48, 32, 24])
    expect(table(tables, '_RoomTileset')).toEqual([0, 0, 1, 0])
  })

  it('accepts rooms of any size, any content — each validates as its own map', () => {
    const { world, rooms } = sample()
    rooms.set(
      'res/b.map.json',
      {
        doc: room('g_B', {
          metas: [{ path: 'res/tree.meta-tiles.json', name: 'g_Tree', width: 2, height: 2, frames: 2, flags: 0, cells: [1, 2, 3, 4] }],
          layers: [{ name: 'background', placements: [{ slot: 0, x: 0, y: 0 }] }]
        } as Partial<MapDoc>),
        banked: true
      }
    )
    expect(validateWorld(world, rooms)).toEqual([])
  })

  it('numbers entities by the world’s list, the same in every room', () => {
    const world = normalizeWorld({ cols: 2, rows: 1, cells: ['res/a.map.json', 'res/b.map.json'], entityTypes: ['bat', 'chest'] })
    const rooms = loaded({
      'res/a.map.json': withEntities(room('g_A'), [{ type: 'chest', x: 4, y: 9, param: 3 }]),
      'res/b.map.json': withEntities(room('g_B'), [
        { type: 'bat', x: 1, y: 10, param: 0 },
        { type: 'chest', x: 2, y: 11, param: 1 }
      ])
    })
    const tables = worldTables(world, rooms)
    expect(table(tables, '_Entities')).toEqual([1, 2, 4, 9, 3, 2, 1, 1, 10, 0, 2, 2, 11, 1])
    expect(table(tables, '_EntityOffsets')).toEqual([0, 0, 5, 0])
  })

  it('says which entity types the rooms use but the world does not declare', () => {
    const world = normalizeWorld({ cols: 1, rows: 1, cells: ['res/a.map.json'], entityTypes: ['bat'] })
    const rooms = loaded({ 'res/a.map.json': withEntities(room('g_A'), [{ type: 'key', x: 0, y: 0, param: 0 }]) })
    expect(undeclaredEntityTypes(world, rooms)).toEqual(['key'])
    expect(validateWorld(world, rooms).join()).toContain('"key" used in rooms but not declared')
  })

  it('checks each door against its own room, and its arrival against the room it leads to', () => {
    let { world } = sample()
    const { rooms } = sample()
    // Into c, which is 48 tall: row 40 is inside it.
    world = addDoor(world, { room: 0, x: 5, y: 10, to: 4, toX: 16, toY: 40 })
    expect(validateWorld(world, rooms)).toEqual([])
    expect(table(worldTables(world, rooms), '_Doors')).toEqual([0, 5, 10, 2, 16, 40])
    // From b, which is 22 tall: row 23 is not.
    const broken = addDoor(addDoor(world, { room: 1, x: 0, y: 23, to: 0, toX: 0, toY: 0 }), { room: 2, x: 0, y: 0, to: 0, toX: 0, toY: 0 })
    const problems = validateWorld(broken, rooms).join('\n')
    expect(problems).toContain('Door 2 at 0,23 is outside its 32×22 room')
    expect(problems).toContain('Door 3 is in an empty cell')
  })

  it('refuses a room that cannot be read', () => {
    const { world } = sample()
    expect(validateWorld(world, new Map()).join()).toContain('Room 0,0 (res/a.map.json) could not be read')
  })

  it('emptying a cell takes its doors with it; moving a room moves them', () => {
    let { world } = sample()
    world = addDoor(world, { room: 0, x: 1, y: 1, to: 4, toX: 1, toY: 1 })
    expect(moveRoom(world, 0, 2).doors[0].room).toBe(2)
    expect(setRoom(world, 4, null).doors).toEqual([])
  })

  it('a resize keeps rooms at their column and row, and drops what falls off', () => {
    let { world } = sample()
    world = addDoor(world, { room: 1, x: 1, y: 1, to: 5, toX: 1, toY: 1 })
    const grown = resizeWorld(world, 4, 2)
    expect(grown.cells).toEqual(['res/a.map.json', 'res/b.map.json', null, null, null, 'res/c.map.json', 'res/a.map.json', null])
    expect(grown.doors[0]).toMatchObject({ room: 1, to: 6 })
    const shrunk = resizeWorld(world, 2, 2)
    expect(shrunk.cells).toEqual(['res/a.map.json', 'res/b.map.json', null, 'res/c.map.json'])
    expect(shrunk.doors).toEqual([])
  })
})

describe('the world dispatches to the rooms’ own exports', () => {
  it('draws a room with its own _DrawLayer and its live meta-tiles with its own _DrawPlacements', () => {
    const placed = room('g_A', {
      metas: [{ path: 'res/tree.meta-tiles.json', name: 'g_Tree', width: 2, height: 2, frames: 2, flags: 0, cells: [1, 2, 3, 4] }],
      layers: [{ name: 'ground', placements: [{ slot: 0, x: 3, y: 3 }] }]
    } as Partial<MapDoc>)
    expect(roomDraw('res/a.map.json', placed)).toMatchObject({ kind: 'draw', name: 'g_A', layer: 'g_A_Ground', placements: true, compressed: false })
  })

  it('leaves to the game what it cannot draw in one call, and says why', () => {
    const reason = (doc: MapDoc): string => {
      const draw = roomDraw('res/x.map.json', doc)
      return draw.kind === 'manual' ? draw.reason : 'draws'
    }
    expect(reason(room('g_X', { width: 64 }))).toContain('bigger than one screen')
    expect(reason({ ...room('g_X'), export: null })).toContain('no C export')
    expect(reason({ ...room('g_X'), export: { name: 'g_X', format: 'c', out: 'content/x.h' } })).toContain('no ready-made C')
    expect(reason(room('g_X', { layers: [{ name: 'objects', indexed: true }] } as Partial<MapDoc>))).toContain('indexed')
    const { world, rooms } = sample()
    expect(worldNotices(world, rooms)).toEqual([
      'Room 1,1 (res/c.map.json): _DrawRoom leaves it to you — it is 32×48, bigger than one screen — scroll it yourself.',
      'res/cave.tiles.json: _LoadTileset leaves it to you — it could not be read.'
    ])
  })

  it('loads a banked tileset through its own _Load(), and an animated one resets and plays', () => {
    const banked = { ...OVER, banked: true }
    expect(tilesetLoad(banked)).toMatchObject({ kind: 'load', banked: true })
    expect(tilesetLoad({ ...banked, helpers: false })).toMatchObject({ kind: 'manual' })
    const { world } = sample()
    const rooms = loaded({ 'res/a.map.json': room('g_A'), 'res/b.map.json': room('g_B'), 'res/c.map.json': room('g_C') })
    for (const entry of rooms.values()) entry.tileset = { ...OVER, banked: true, animated: true }
    const c = worldHelperC(world, rooms, 'g_World', 'content/world.h')
    const source = c.source.join('\n')
    expect(source).toContain('\t\tg_Over_Load();\n\t\tg_Over_AnimReset();')
    expect(source).toContain('g_Over_Animate();')
    expect(c.header.join('\n')).toContain('void g_World_Animate(u8 tileset);')
  })

  it('emits one case per map, with a label per room it fills, and includes the rooms’ headers', () => {
    const { world, rooms } = sample()
    const source = worldHelperC(world, rooms, 'g_World', 'content/world/world.h').source.join('\n')
    expect(source).toContain('#include "../a.h"')
    expect(source).toContain('\tcase 0:\n\tcase 3:\n\t\tg_World_Draw_g_A(buffer);')
    expect(source).toContain('static void g_World_Draw_g_A(u8* buffer)\n{\n\tbuffer;\n\tg_A_DrawLayer(g_A_Background, 0, 0);\n}')
    expect(source).toContain('g_B_DrawLayer(g_B_Background, 0, 0);')
    // c is too tall to draw in one write: no case, so _DrawRoom returns FALSE for it.
    expect(source).not.toContain('g_C_DrawLayer')
    expect(source).toContain('VDP_LoadPattern_GM2(g_Over_Patterns, 4, 0);')
  })

  it('a packed room unpacks into the caller’s buffer, sized by the define', () => {
    const data = new Array<number>(768).fill(0).map((_, i) => (i >= 512 ? 1 : 0))
    const packed = room('g_A', { layers: [{ name: 'background', data }] } as Partial<MapDoc>)
    packed.export = { ...packed.export!, compress: 'rlep' }
    const world = normalizeWorld({ cols: 1, rows: 1, cells: ['res/a.map.json'] })
    const rooms = loaded({ 'res/a.map.json': packed })
    expect(worldHelperC(world, rooms, 'g_W', 'content/w.h').source.join('\n')).toContain('g_A_DrawLayer(g_A_Background, buffer, 0, 0);')
    world.export = { name: 'g_W', format: 'c', out: 'content/w.h', helpers: true }
    const files = renderResourceFiles({ kind: 'world', doc: world, rooms }, 'res/w.world.json', world.export)
    expect(files.header).toContain('#define G_W_BUFFER_BYTES 768')
  })

  it('resolves include paths between project-relative files', () => {
    expect(includePath('content/world.h', 'content/a.h')).toBe('a.h')
    expect(includePath('content/world.h', 'content/rooms/a.h')).toBe('rooms/a.h')
    expect(includePath('content/w/world.h', 'other/a.h')).toBe('../../other/a.h')
  })

  it('exports from the file alone, with rooms handed in, and names each room', () => {
    const { world, rooms } = sample()
    world.entityTypes = ['chest']
    world.export = { name: 'g_World', format: 'c', out: 'content/world.h', helpers: true }
    const parsed = parseResource('res/world.world.json', serializeResource({ kind: 'world', doc: world }))
    expect(parsed.kind).toBe('world')
    if (parsed.kind !== 'world') return
    parsed.rooms = rooms
    expect(validateResource(parsed)).toEqual([])
    const files = renderResourceFiles(parsed, 'res/world.world.json', world.export)
    expect(files.header).toContain('#define G_WORLD_ROOMS 4')
    expect(files.header).toContain('#define G_WORLD_ROOM_A 0')
    expect(files.header).toContain('#define G_WORLD_ROOM_C 2')
    expect(files.header).toContain('#define G_WORLD_TILESET_CAVE 1')
    expect(files.header).toContain('#define G_WORLD_ENT_CHEST 1')
    expect(files.header).toContain('bool g_World_DrawRoom(u8 room, u8* buffer);')
    expect(files.header).not.toContain('g_World_Rooms[]')
    // No doors: the table is absent, and the helper does not name it.
    expect(files.header).not.toContain('g_World_Doors[]')
    expect(files.source).toContain('#if G_WORLD_DOORS > 0')
  })

  it('never writes its loaded rooms into the file', () => {
    const { world, rooms } = sample()
    expect(serializeResource({ kind: 'world', doc: world, rooms })).not.toContain('layers')
  })
})

describe('slicing a map into rooms', () => {
  /** 64×48 — four rooms — with each quadrant filled with its own tile. */
  function overworld(): MapDoc {
    const data = new Array<number>(64 * 48).fill(0)
    for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) data[y * 64 + x] = 1 + (x >= 32 ? 1 : 0) + (y >= 24 ? 2 : 0)
    return withEntities(
      normalizeMap({
        tileset: 'res/over.tiles.json',
        width: 64,
        height: 48,
        metas: [{ path: 'res/tree.meta-tiles.json', name: 'g_Tree', width: 2, height: 2, cells: [5, 6, 7, 8] }],
        layers: [
          {
            name: 'background',
            data,
            placements: [
              { slot: 0, x: 40, y: 2, baked: true },
              { slot: 0, x: 31, y: 5 } // crosses from room 0 into room 1
            ]
          }
        ]
      }),
      [{ type: 'chest', x: 35, y: 30, param: 9 }]
    )
  }

  it('cuts the map into rooms, each with its own quadrant, placements and entities rebased', () => {
    const { cols, rows, rooms, warnings } = sliceMap(overworld(), 32, 24)
    expect([cols, rows]).toEqual([2, 2])
    expect(rooms.map((r) => r!.layers[0].data[0])).toEqual([1, 2, 3, 4])
    expect(rooms[1]!.layers[0].placements).toEqual([{ slot: 0, x: 8, y: 2, baked: true }])
    expect(rooms[3]!.entities).toEqual([{ type: 'chest', x: 3, y: 6, param: 9 }])
    expect(rooms.every((r) => r!.width === 32 && r!.height === 24)).toBe(true)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('crosses into the next room')
  })

  it('makes the edge rooms smaller when the map is not a whole number of rooms, and can skip empty ones', () => {
    const map = normalizeMap({ tileset: 't', width: 40, height: 24, layers: [{ name: 'background', data: new Array(40 * 24).fill(0).map((_, i) => (i % 40 < 32 ? 1 : 0)) }] })
    const all = sliceMap(map, 32, 24)
    expect(all.cols).toBe(2)
    expect([all.rooms[1]!.width, all.rooms[1]!.height]).toEqual([8, 24])
    expect(isEmptyRoom(all.rooms[1]!)).toBe(true)
    expect(sliceMap(map, 32, 24, true).rooms[1]).toBeNull()
  })

  it('names the rooms after the map, and the world it makes exports them', () => {
    expect(slicedRoomPath('res/over.map.json', 1, 0)).toBe('res/over_r0_c1.map.json')
    const { cols, rows, rooms } = sliceMap(overworld(), 32, 24)
    const paths = rooms.map((_, i) => slicedRoomPath('res/over.map.json', i % cols, Math.floor(i / cols)))
    const world = worldFromSlices(cols, rows, paths, ['chest'])
    const map = new Map(paths.map((path, i) => [path, { doc: rooms[i]! }]))
    expect(validateWorld(world, map)).toEqual([])
  })
})
