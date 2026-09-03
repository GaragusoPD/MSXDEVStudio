/**
 * Scaffolding a tiled screen: a tileset and a map written as a pair.
 *
 * Creation used to live only in `ResourcesPanel.vue`, which no test reaches.
 * The things that go wrong here are all silent — a map whose `tileset` names
 * the wrong file loads with an error the user reads as "no tileset yet"; a doc
 * born without an export block is listed, opens, paints, and is never emitted
 * for the build; a write into a `res/` that does not exist yet fails only on a
 * fresh project. So the fake filesystem below refuses a write into a folder
 * nobody created, and every assertion reads the file back rather than the
 * return value.
 */

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeMap } from '../../../shared/msx/map'
import { defaultExport, serializeResource } from '../../../shared/msx/resource'
import { normalizeTiles } from '../../../shared/msx/tile'
import { useResourcesStore } from './resourcesStore'

let files: Record<string, string>
/** Folders `fs:create` was asked for — `fs:write` into any other parent fails, as the real one does. */
let dirs: Set<string>
let writes: string[]

function stubApi(): void {
  dirs = new Set()
  writes = []
  const invoke = vi.fn(async (channel: string, args: { path?: string; content?: string; kind?: string }) => {
    const path = args?.path ?? ''
    if (channel === 'fs:stat') return path in files ? { isDirectory: false, size: files[path].length, mtimeMs: 0 } : null
    if (channel === 'fs:create') {
      if (args.kind === 'directory') dirs.add(path)
      else files[path] = ''
      return undefined
    }
    if (channel === 'fs:write') {
      const parent = path.slice(0, path.lastIndexOf('/'))
      if (parent && !dirs.has(parent)) throw new Error(`ENOENT: no such file or directory, open '${path}'`)
      files[path] = args.content ?? ''
      writes.push(path)
      return undefined
    }
    if (channel === 'resources:list') {
      return Object.keys(files).map((p) => ({ path: p, kind: p.endsWith('.map.json') ? 'map' : 'tiles', out: null }))
    }
    if (channel === 'resources:msximgHelp') return null
    throw new Error(`unexpected channel ${channel}`)
  })
  ;(globalThis as { window?: unknown }).window = { api: { invoke, on: vi.fn() } }
}

beforeEach(() => {
  setActivePinia(createPinia())
  files = {}
  stubApi()
})

describe('newTiledScreen', () => {
  it('writes a tileset and a 32x24 map that references it', async () => {
    const created = await useResourcesStore().newTiledScreen('res/title')

    expect(created).toEqual({ tileset: 'res/title.tiles.json', map: 'res/title.map.json' })

    const map = normalizeMap(JSON.parse(files['res/title.map.json']))
    expect(map.width).toBe(32)
    expect(map.height).toBe(24)
    expect(map.tileset).toBe('res/title.tiles.json')

    const tiles = normalizeTiles(JSON.parse(files['res/title.tiles.json']))
    expect(tiles.mode).toBe('sc2')
    expect(tiles.reserveTile0).toBe(true)
  })

  it('gives both files an export block, so the build emits them', async () => {
    await useResourcesStore().newTiledScreen('res/title')
    const tiles = normalizeTiles(JSON.parse(files['res/title.tiles.json']))
    const map = normalizeMap(JSON.parse(files['res/title.map.json']))
    expect(tiles.export).toEqual(defaultExport('res/title.tiles.json'))
    expect(map.export).toEqual(defaultExport('res/title.map.json'))
  })

  it('creates the resource folder first — a fresh project has none', async () => {
    // The fake `fs:write` throws into a folder nobody made, as the real one does.
    await expect(useResourcesStore().newTiledScreen('res/title')).resolves.toBeDefined()
    expect([...dirs]).toEqual(['res'])
  })

  it('lists the pair in the panel once written', async () => {
    const store = useResourcesStore()
    await store.newTiledScreen('res/title')
    expect(store.entries.map((entry) => entry.path).sort()).toEqual(['res/title.map.json', 'res/title.tiles.json'])
    expect(store.error).toBeNull()
  })

  it('refuses a name either file already carries, and writes nothing', async () => {
    dirs.add('res')
    files['res/title.tiles.json'] = serializeResource({ kind: 'tiles', doc: normalizeTiles({ mode: 'sc2', count: 4 }) })
    const before = files['res/title.tiles.json']

    await expect(useResourcesStore().newTiledScreen('res/title')).rejects.toThrow('res/title.tiles.json')

    expect(writes).toEqual([])
    expect(files['res/title.tiles.json']).toBe(before)
    expect(files['res/title.map.json']).toBeUndefined()
  })

  it('refuses on the map alone too — the tileset is not the only half that can collide', async () => {
    dirs.add('res')
    files['res/title.map.json'] = '{}'
    await expect(useResourcesStore().newTiledScreen('res/title')).rejects.toThrow('res/title.map.json')
    expect(writes).toEqual([])
  })
})
