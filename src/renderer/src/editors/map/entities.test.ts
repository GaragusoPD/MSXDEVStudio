/**
 * The map editor's entity tool and its "Slice into rooms" command — the
 * session halves, which is where a guard that silently returns would hide.
 */

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mapEntities, normalizeMap } from '../../../../shared/msx/map'
import { parseResource, serializeResource } from '../../../../shared/msx/resource'
import { normalizeTiles } from '../../../../shared/msx/tile'
import { resetExternalWatches } from '../external-changes'
import {
  deleteSelectedEntity,
  doc,
  mapSession,
  placeEntityAt,
  pruneMapSessions,
  redo,
  selectEntityAt,
  setEntityBrush,
  setTool,
  sliceIntoRooms,
  undo,
  updateSelectedEntity
} from './session'

const MAP = 'res/over.map.json'
const TILES = 'res/over.tiles.json'
let files: Record<string, string>
const settled = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  resetExternalWatches()
  setActivePinia(createPinia())
  pruneMapSessions(new Set())
  // 64×24: two rooms side by side, the left one ground, the right one blank.
  const data = Array.from({ length: 64 * 24 }, (_, i) => (i % 64 < 32 ? 1 : 0))
  files = {
    [MAP]: serializeResource({ kind: 'map', doc: { ...normalizeMap({ tileset: TILES, width: 64, height: 24, layers: [{ name: 'background', data }] }), tilesetReorderSeen: 0 } as never }),
    [TILES]: serializeResource({ kind: 'tiles', doc: normalizeTiles({ mode: 'sc2', count: 2 }) })
  }
  ;(globalThis as { window?: unknown }).window = {
    confirm: vi.fn(() => true),
    api: {
      on: vi.fn(() => () => {}),
      invoke: vi.fn(async (channel: string, args: { path: string; content?: string }) => {
        if (channel === 'fs:read') return files[args.path] ?? ''
        if (channel === 'fs:write') {
          files[args.path] = args.content ?? ''
          return undefined
        }
        if (channel === 'fs:stat') return args.path in files ? { isDirectory: false } : null
        if (channel === 'fs:create' || channel === 'resources:list') return channel === 'resources:list' ? [] : undefined
        if (channel === 'resources:msximgHelp') return null
        throw new Error(`unexpected channel ${channel}`)
      })
    }
  }
})

async function open(): Promise<ReturnType<typeof mapSession>> {
  const session = mapSession(MAP)
  await settled()
  return session
}

describe('the entity tool', () => {
  it('drops, selects, moves, edits and deletes entities, each an undo step', async () => {
    const session = await open()
    setTool(session, 'entity')
    setEntityBrush(session, 'big key', 300)
    placeEntityAt(session, 3, 4)
    expect(mapEntities(doc(session))).toEqual([{ type: 'big_key', x: 3, y: 4, param: 300 & 0xff }])
    expect(session.selectedEntity).toBe(0)
    expect(session.dirty).toBe(true)

    updateSelectedEntity(session, { x: 5 })
    updateSelectedEntity(session, { x: 500 }) // off the map: ignored
    updateSelectedEntity(session, { param: 7 })
    expect(mapEntities(doc(session))[0]).toEqual({ type: 'big_key', x: 5, y: 4, param: 7 })

    expect(selectEntityAt(session, 0, 0)).toBeNull()
    expect(selectEntityAt(session, 5, 4)).toBe(0)
    deleteSelectedEntity(session)
    expect(mapEntities(doc(session))).toEqual([])
    undo(session)
    expect(mapEntities(doc(session))).toHaveLength(1)
    redo(session)
    expect(mapEntities(doc(session))).toHaveLength(0)
  })

  it('leaving the tool drops the entity selection; picking it drops a meta brush', async () => {
    const session = await open()
    session.brushMeta = 'res/tree.meta-tiles.json'
    setTool(session, 'entity')
    expect(session.brushMeta).toBeNull()
    placeEntityAt(session, 1, 1)
    setTool(session, 'stamp')
    expect(session.selectedEntity).toBeNull()
  })
})

describe('slicing into rooms', () => {
  it('writes each room and a world beside the map, and opens the world', async () => {
    const session = await open()
    setTool(session, 'entity')
    setEntityBrush(session, 'chest', 1)
    placeEntityAt(session, 40, 10)
    const world = await sliceIntoRooms(session, { roomWidth: 32, roomHeight: 24, skipEmpty: false })
    expect(world).toBe('res/over.world.json')
    const left = parseResource('res/over_r0_c0.map.json', files['res/over_r0_c0.map.json'])
    const right = parseResource('res/over_r0_c1.map.json', files['res/over_r0_c1.map.json'])
    expect(left.kind === 'map' && left.doc.layers[0].data.every((v) => v === 1)).toBe(true)
    expect(right.kind === 'map' && mapEntities(right.doc)).toEqual([{ type: 'chest', x: 8, y: 10, param: 1 }])
    // Each room draws itself: its own export, with the helpers the world calls.
    expect(left.kind === 'map' && left.doc.export).toMatchObject({ out: 'content/over_r0_c0_map.h', helpers: true })
    // The rooms keep the map's place in its tileset's renumbering.
    expect(JSON.parse(files['res/over_r0_c0.map.json']).tilesetReorderSeen).toBe(0)
    const parsed = parseResource(world!, files[world!])
    expect(parsed.kind === 'world' && parsed.doc.cells).toEqual(['res/over_r0_c0.map.json', 'res/over_r0_c1.map.json'])
    expect(parsed.kind === 'world' && parsed.doc.entityTypes).toEqual(['chest'])
  })

  it('leaves empty rooms out when asked, and refuses to overwrite earlier rooms', async () => {
    const session = await open()
    expect(await sliceIntoRooms(session, { roomWidth: 32, roomHeight: 24, skipEmpty: true })).toBe('res/over.world.json')
    expect('res/over_r0_c1.map.json' in files).toBe(false)
    const again = await sliceIntoRooms(session, { roomWidth: 32, roomHeight: 24, skipEmpty: true })
    expect(again).toBeNull()
    expect(session.status).toContain('already exists')
  })
})
