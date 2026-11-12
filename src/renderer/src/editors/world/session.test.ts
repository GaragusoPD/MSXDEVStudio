/**
 * The world editor's session: what it reads, what it writes, and that its
 * problems list is the build's own check over the same rooms.
 */

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeMap, withEntities } from '../../../../shared/msx/map'
import { parseResource, serializeResource } from '../../../../shared/msx/resource'
import { normalizeTiles } from '../../../../shared/msx/tile'
import { normalizeWorld } from '../../../../shared/msx/world'
import { resetExternalWatches } from '../external-changes'
import { useTabsStore } from '../../stores/tabsStore'
import {
  addDoor,
  addUsedTypes,
  doc,
  importMaps,
  moveRoom,
  newRoom,
  notices,
  placeRoom,
  problems,
  pruneWorldSessions,
  saveSession,
  select,
  undo,
  worldSession
} from './session'

vi.mock('../../components/resource-thumbnails', () => ({ thumbnailUrl: async () => null }))

const WORLD = 'res/over.world.json'
let files: Record<string, string>
let pushed: Record<string, ((payload: unknown) => void)[]>
const settled = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function room(tileset = 'res/over.tiles.json', entities: { type: string; x: number; y: number; param: number }[] = []): string {
  return serializeResource({ kind: 'map', doc: withEntities(normalizeMap({ tileset }), entities) })
}

beforeEach(() => {
  resetExternalWatches()
  setActivePinia(createPinia())
  pruneWorldSessions(new Set())
  files = {
    [WORLD]: serializeResource({
      kind: 'world',
      doc: normalizeWorld({ cols: 2, rows: 1, cells: ['res/a.map.json', null], entityTypes: [] })
    }),
    'res/a.map.json': room('res/over.tiles.json', [{ type: 'chest', x: 1, y: 1, param: 0 }]),
    'res/over.tiles.json': serializeResource({ kind: 'tiles', doc: normalizeTiles({ mode: 'sc2', count: 2 }) })
  }
  pushed = {}
  ;(globalThis as { window?: unknown }).window = {
    confirm: vi.fn(() => true),
    api: {
      on: vi.fn((channel: string, handler: (payload: unknown) => void) => {
        ;(pushed[channel] ??= []).push(handler)
        return () => {}
      }),
      invoke: vi.fn(async (channel: string, args: { path: string; content?: string }) => {
        if (channel === 'fs:read') {
          if (!(args.path in files)) throw new Error(`ENOENT ${args.path}`)
          return files[args.path]
        }
        if (channel === 'fs:write') {
          files[args.path] = args.content ?? ''
          return undefined
        }
        if (channel === 'fs:stat') return args.path in files ? { isDirectory: false } : null
        if (channel === 'fs:create') return undefined
        if (channel === 'resources:list') return []
        if (channel === 'resources:msximgHelp') return null
        throw new Error(`unexpected channel ${channel}`)
      })
    }
  }
})

async function open(): Promise<ReturnType<typeof worldSession>> {
  const session = worldSession(WORLD)
  await settled()
  return session
}

describe('the world session', () => {
  it('reads the rooms it places, and reports what the build would refuse', async () => {
    const session = await open()
    expect(session.rooms.has('res/a.map.json')).toBe(true)
    expect(problems(session).join()).toContain('"chest" used in rooms but not declared')
    addUsedTypes(session)
    expect(doc(session).entityTypes).toEqual(['chest'])
    expect(problems(session)).toEqual([])
  })

  it('makes a new room in an empty cell, over its neighbour’s tileset, and places it', async () => {
    const session = await open()
    const path = await newRoom(session, 1)
    await settled()
    expect(path).toBe('res/over_r0_c1.map.json')
    const written = parseResource(path!, files[path!])
    expect(written.kind).toBe('map')
    if (written.kind !== 'map') return
    expect(written.doc.tileset).toBe('res/over.tiles.json')
    expect([written.doc.width, written.doc.height]).toEqual([32, 24])
    // It draws itself: its own export, with the helpers _DrawRoom calls.
    expect(written.doc.export).toMatchObject({ out: 'content/over_r0_c1_map.h', helpers: true })
    expect(doc(session).cells[1]).toBe(path)
    // And it is open, ready to paint.
    expect(useTabsStore().tabs.some((tab) => tab.filePath === path)).toBe(true)
    expect(session.rooms.has(path!)).toBe(true)
    undo(session)
    expect(doc(session).cells[1]).toBeNull()
  })

  it('moving a room takes its doors and the selection along; emptying a cell drops its doors', async () => {
    const session = await open()
    select(session, 0)
    addDoor(session)
    moveRoom(session, 0, 1)
    expect(doc(session).cells).toEqual([null, 'res/a.map.json'])
    expect(doc(session).doors[0]).toMatchObject({ room: 1, to: 1 })
    expect(session.selected).toBe(1)
    placeRoom(session, 1, null)
    expect(doc(session).doors).toEqual([])
    expect(session.status).toContain('doors')
  })

  it('re-reads the rooms when one of them changes on disk', async () => {
    const session = await open()
    files['res/a.map.json'] = room('res/over.tiles.json', [])
    vi.useFakeTimers()
    try {
      for (const handler of pushed['fs:changed'] ?? []) handler({ type: 'change', path: 'res/a.map.json' })
      await vi.advanceTimersByTimeAsync(200)
    } finally {
      vi.useRealTimers()
    }
    await settled()
    expect(problems(session)).toEqual([])
  })

  it('imports map files into res/, renamed past what exists, into the selected empty cell', async () => {
    const session = await open()
    select(session, 1)
    const written = await importMaps(session, [{ name: 'a.map.json', text: room('res/elsewhere.tiles.json') }])
    await settled()
    expect(written).toEqual(['res/a_2.map.json'])
    expect(doc(session).cells[1]).toBe('res/a_2.map.json')
    const imported = parseResource('res/a_2.map.json', files['res/a_2.map.json'])
    expect(imported.kind === 'map' && imported.doc.export?.out).toBe('content/a_2_map.h')
    expect(session.status).toContain('res/elsewhere.tiles.json, which this project does not have')
    expect(await importMaps(session, [{ name: 'junk.json', text: '{' }])).toEqual([])
  })

  it('lists what the ready-made C leaves to the game', async () => {
    const session = await open()
    expect(notices(session).join()).toContain('no C export of its own')
  })

  it('saves what it shows', async () => {
    const session = await open()
    addUsedTypes(session)
    await saveSession(session)
    const saved = parseResource(WORLD, files[WORLD])
    expect(saved.kind === 'world' && saved.doc.entityTypes).toEqual(['chest'])
    expect(session.dirty).toBe(false)
  })
})
