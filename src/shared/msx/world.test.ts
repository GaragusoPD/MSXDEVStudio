import { describe, expect, it } from 'vitest'
import { normalizeMap, withEntities, type MapDoc } from './map'
import { unpackRlep } from './compress'
import { parseResource, renderResourceFiles, serializeResource, validateResource } from './resource'
import {
  addDoor,
  createWorldDoc,
  isEmptyRoom,
  moveRoom,
  neighbours,
  NO_ROOM,
  normalizeWorld,
  resizeWorld,
  roomIds,
  setRoom,
  slicedRoomPath,
  sliceMap,
  undeclaredEntityTypes,
  validateWorld,
  worldExport,
  worldFromSlices,
  type LoadedRoom,
  type WorldDoc
} from './world'

/** A one-screen room filled with `tile`, a few sky rows on top so it packs. */
function room(tile: number, tileset = 'res/over.tiles.json', extra: Partial<MapDoc> = {}): MapDoc {
  const data = new Array<number>(32 * 24).fill(tile)
  for (let i = 0; i < 32 * 8; i++) data[i] = 0
  return normalizeMap({ tileset, width: 32, height: 24, layers: [{ name: 'background', data }], ...extra })
}

function loaded(entries: Record<string, MapDoc>): Map<string, LoadedRoom> {
  return new Map(Object.entries(entries).map(([path, doc]) => [path, { doc }]))
}

/** 3×2: A B . / . C A — A twice, one empty cell between B and nothing. */
function sample(): { world: WorldDoc; rooms: Map<string, LoadedRoom> } {
  const world = normalizeWorld({
    cols: 3,
    rows: 2,
    cells: ['res/a.map.json', 'res/b.map.json', null, null, 'res/c.map.json', 'res/a.map.json']
  })
  const rooms = loaded({ 'res/a.map.json': room(1), 'res/b.map.json': room(2), 'res/c.map.json': room(3, 'res/cave.tiles.json') })
  return { world, rooms }
}

describe('world grid', () => {
  it('normalizes a bare file to a 4×4 grid of empty one-screen rooms', () => {
    const world = createWorldDoc()
    expect(world.cells).toHaveLength(16)
    expect(world.cells.every((cell) => cell === null)).toBe(true)
    expect([world.roomWidth, world.roomHeight, world.top]).toEqual([32, 24, 0])
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

  it('stores a map used in two cells once', () => {
    const { world, rooms } = sample()
    const { tables } = worldExport(world, rooms, undefined)
    const table = (suffix: string): number[] => [...tables.find((t) => t.suffix === suffix)!.bytes]
    expect(table('_Rooms')).toHaveLength(3 * 768)
    // a, b, c, a — the second a points back at the first.
    expect(table('_RoomOffsets')).toEqual([0, 0, 0x00, 0x03, 0x00, 0x06, 0, 0])
    expect(table('_RoomTileset')).toEqual([0, 0, 1, 0])
  })

  it('packs every room with RLEp, and each one unpacks to its name table', () => {
    const { world, rooms } = sample()
    const exported = worldExport(world, rooms, 'rlep')
    expect(exported.compressed).toBe(true)
    const data = exported.tables.find((t) => t.suffix === '_Rooms')!.bytes
    const offsets = exported.tables.find((t) => t.suffix === '_RoomOffsets')!.bytes
    const start = offsets[4] | (offsets[5] << 8) // room 2 = c
    expect([...unpackRlep(data.subarray(start))]).toEqual(rooms.get('res/c.map.json')!.doc.layers[0].data)
  })

  it('declines compression when a room would not shrink, for all rooms at once', () => {
    const noisy = normalizeMap({
      tileset: 't',
      layers: [{ name: 'background', data: Array.from({ length: 768 }, (_, i) => (i * 7) & 0xff) }]
    })
    const world = normalizeWorld({ cols: 2, rows: 1, cells: ['res/a.map.json', 'res/n.map.json'] })
    const exported = worldExport(world, loaded({ 'res/a.map.json': room(1), 'res/n.map.json': noisy }), 'rlep')
    expect(exported.compressed).toBe(false)
  })

  it('numbers entities by the world’s list, the same in every room', () => {
    const world = normalizeWorld({ cols: 2, rows: 1, cells: ['res/a.map.json', 'res/b.map.json'], entityTypes: ['bat', 'chest'] })
    const rooms = loaded({
      'res/a.map.json': withEntities(room(1), [{ type: 'chest', x: 4, y: 9, param: 3 }]),
      'res/b.map.json': withEntities(room(2), [
        { type: 'bat', x: 1, y: 10, param: 0 },
        { type: 'chest', x: 2, y: 11, param: 1 }
      ])
    })
    const { tables } = worldExport(world, rooms, undefined)
    expect([...tables.find((t) => t.suffix === '_Entities')!.bytes]).toEqual([1, 2, 4, 9, 3, 2, 1, 1, 10, 0, 2, 2, 11, 1])
    expect([...tables.find((t) => t.suffix === '_EntityOffsets')!.bytes]).toEqual([0, 0, 5, 0])
  })

  it('says which entity types the rooms use but the world does not declare', () => {
    const world = normalizeWorld({ cols: 1, rows: 1, cells: ['res/a.map.json'], entityTypes: ['bat'] })
    const rooms = loaded({ 'res/a.map.json': withEntities(room(1), [{ type: 'key', x: 0, y: 0, param: 0 }]) })
    expect(undeclaredEntityTypes(world, rooms)).toEqual(['key'])
    expect(validateWorld(world, rooms).join()).toContain('"key" used in rooms but not declared')
  })

  it('refuses rooms of the wrong size, a missing layer, live meta-tiles and a banked tileset under a HUD', () => {
    const world = normalizeWorld({ cols: 4, rows: 1, roomHeight: 22, top: 2, cells: ['res/a.map.json', 'res/b.map.json', 'res/c.map.json', 'res/d.map.json'] })
    const short = (extra: Partial<MapDoc> = {}): MapDoc =>
      normalizeMap({ tileset: 't', width: 32, height: 22, ...extra })
    const rooms = new Map<string, LoadedRoom>([
      ['res/a.map.json', { doc: room(1) }],
      [
        'res/b.map.json',
        {
          doc: short({
            metas: [{ path: 'res/tree.meta-tiles.json', name: 'g_Tree', width: 2, height: 2, cells: [1, 2, 3, 4] }],
            layers: [{ name: 'background', placements: [{ slot: 0, x: 0, y: 0 }] }]
          } as Partial<MapDoc>)
        }
      ],
      ['res/c.map.json', { doc: short(), banked: true }]
    ])
    const problems = validateWorld(world, rooms).join('\n')
    expect(problems).toContain('Room 0,0 (res/a.map.json) is 32×24, but this world\'s rooms are 32×22')
    expect(problems).toContain('live meta-tile')
    expect(problems).toContain('banked tileset')
    expect(problems).toContain('Room 3,0 (res/d.map.json) could not be read')
  })

  it('validates doors and exports them by room id', () => {
    let { world } = sample()
    const { rooms } = sample()
    world = addDoor(world, { room: 0, x: 5, y: 10, to: 4, toX: 16, toY: 20 })
    expect(validateWorld(world, rooms)).toEqual([])
    const doors = worldExport(world, rooms, undefined).tables.find((t) => t.suffix === '_Doors')!
    expect([...doors.bytes]).toEqual([0, 5, 10, 2, 16, 20])
    const broken = addDoor(world, { room: 2, x: 40, y: 0, to: 0, toX: 0, toY: 0 })
    const problems = validateWorld(broken, rooms).join('\n')
    expect(problems).toContain('Door 2 is in an empty cell')
    expect(problems).toContain('outside its 32×24 room')
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

  it('exports from the file alone, with rooms handed in, and names each room', () => {
    const { world, rooms } = sample()
    world.entityTypes = ['chest']
    world.export = { name: 'g_Over', format: 'c', out: 'content/over.h', helpers: true, compress: 'rlep' }
    const parsed = parseResource('res/over.world.json', serializeResource({ kind: 'world', doc: world }))
    expect(parsed.kind).toBe('world')
    if (parsed.kind !== 'world') return
    parsed.rooms = rooms
    expect(validateResource(parsed)).toEqual([])
    const files = renderResourceFiles(parsed, 'res/over.world.json', world.export)
    expect(files.header).toContain('#define G_OVER_ROOMS 4')
    expect(files.header).toContain('#define G_OVER_ROOM_A 0')
    expect(files.header).toContain('#define G_OVER_ROOM_C 2')
    expect(files.header).toContain('#define G_OVER_TILESET_CAVE 1')
    expect(files.header).toContain('#define G_OVER_ENT_CHEST 1')
    expect(files.header).toContain('#define G_OVER_COMPRESSED 1')
    expect(files.header).toContain('void g_Over_DrawRoom(u8 room, u8* buffer);')
    expect(files.source).toContain('RLEp_UnpackToRAM(g_Over_RoomData(room), buffer);')
    // No doors: the table is absent, and the helper does not name it.
    expect(files.header).not.toContain('g_Over_Doors[]')
    expect(files.source).toContain('#if G_OVER_DOORS > 0')
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
    expect(rooms.every((r) => r!.export === null && r!.width === 32 && r!.height === 24)).toBe(true)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('crosses into the next room')
  })

  it('pads the edge rooms when the map is not a whole number of rooms, and can skip empty ones', () => {
    const map = normalizeMap({ tileset: 't', width: 40, height: 24, layers: [{ name: 'background', data: new Array(40 * 24).fill(0).map((_, i) => (i % 40 < 32 ? 1 : 0)) }] })
    const all = sliceMap(map, 32, 24)
    expect(all.cols).toBe(2)
    expect(all.rooms[1]!.layers[0].data.every((v) => v === 0)).toBe(true)
    expect(isEmptyRoom(all.rooms[1]!)).toBe(true)
    expect(sliceMap(map, 32, 24, true).rooms[1]).toBeNull()
  })

  it('names the rooms after the map, and the world it makes exports them', () => {
    expect(slicedRoomPath('res/over.map.json', 1, 0)).toBe('res/over_r0_c1.map.json')
    const { cols, rows, rooms } = sliceMap(overworld(), 32, 24)
    const paths = rooms.map((_, i) => slicedRoomPath('res/over.map.json', i % cols, Math.floor(i / cols)))
    const world = worldFromSlices(cols, rows, paths, 32, 24, ['chest'])
    const map = new Map(paths.map((path, i) => [path, { doc: rooms[i]! }]))
    expect(validateWorld(world, map)).toEqual([])
  })
})
