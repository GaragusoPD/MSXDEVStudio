/**
 * The map's mirror of the metas it places.
 *
 * `MetaRef` copies a meta's symbol, size, frames and flags into the map,
 * because the exporter renders one resource at a time and never opens another
 * file. Copied data goes stale, and the ways it did were both invisible until
 * link time — which is why they are covered here rather than left to the eye.
 */

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMetaTileDoc } from '../../../../shared/msx/meta-tile'
import { defaultExport, serializeResource } from '../../../../shared/msx/resource'
import { normalizeTiles } from '../../../../shared/msx/tile'
import { doc, mapSession, pickMeta, pruneMapSessions } from './session'
import { useResourcesStore } from '../../stores/resourcesStore'

const MAP = 'res/level.map.json'
const TILES = 'res/main.tiles.json'
const META = 'res/ground_rocks.meta-tiles.json'

let files: Record<string, string>
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** A meta file, optionally with an export block naming its table. */
function metaFile(exported: boolean, width = 2, height = 3): string {
  const base = createMetaTileDoc(TILES, width, height)
  return serializeResource({
    kind: 'metatiles',
    doc: { ...base, flags: 0x01, export: exported ? defaultExport(META) : null }
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  files = {
    [MAP]: JSON.stringify({ version: 1, tileset: TILES, width: 8, height: 8 }),
    [TILES]: serializeResource({ kind: 'tiles', doc: normalizeTiles({ mode: 'sc2', count: 4 }) }),
    [META]: metaFile(true)
  }
  ;(globalThis as { window?: unknown }).window = {
    api: {
      on: vi.fn(),
      invoke: vi.fn(async (channel: string, args: { path: string; content?: string }) => {
        if (channel === 'fs:read') return files[args.path] ?? ''
        if (channel === 'fs:write') {
          files[args.path] = args.content ?? ''
          return undefined
        }
        throw new Error(`unexpected channel ${channel}`)
      })
    }
  }
  useResourcesStore().entries = [{ path: META, kind: 'metatiles', out: null }]
  pruneMapSessions(new Set())
})

async function openMap(): Promise<ReturnType<typeof mapSession>> {
  const session = mapSession(MAP)
  for (let i = 0; i < 4; i++) await settled()
  return session
}

describe('the symbol a placed meta is externed under', () => {
  it("is the meta's own export name, not one guessed from the file", async () => {
    const session = await openMap()
    pickMeta(session, META)
    // The bug: a file-name rule produced g_GroundRocks while defaultExport
    // appends the kind, so the emitted extern named nothing that existed and
    // the project failed at link with no file and no line.
    expect(doc(session).metas[0].name).toBe('g_GroundRocksMetatiles')
  })

  it('falls back to the name the meta will take once its export is set up', async () => {
    files[META] = metaFile(false)
    const session = await openMap()
    pickMeta(session, META)
    expect(doc(session).metas[0].name).toBe(defaultExport(META).name)
  })

  it('mirrors the size and flags the meta actually has', async () => {
    const session = await openMap()
    pickMeta(session, META)
    expect(doc(session).metas[0]).toMatchObject({ width: 2, height: 3, frames: 1, flags: 0x01 })
  })
})

describe('the mirror is refreshed from the files', () => {
  it('corrects a meta resized since the map was last saved', async () => {
    // A map saved when the meta was 2x3, reopened after it grew to 4x4.
    files[MAP] = JSON.stringify({
      version: 1,
      tileset: TILES,
      width: 8,
      height: 8,
      metas: [{ path: META, name: 'g_Stale', width: 2, height: 3, frames: 1, flags: 0 }],
      layers: [{ name: 'background', placements: [{ slot: 0, x: 0, y: 0 }] }]
    })
    files[META] = metaFile(true, 4, 4)

    const session = await openMap()
    expect(doc(session).metas[0]).toMatchObject({ name: 'g_GroundRocksMetatiles', width: 4, height: 4 })
    // A correction, not an edit — it must not dirty the tab.
    expect(session.dirty).toBe(false)
    // ...and the placement it describes survives.
    expect(doc(session).layers[0].placements).toHaveLength(1)
  })

  it('leaves a mirror alone when its file is gone, rather than dropping the placements', async () => {
    files[MAP] = JSON.stringify({
      version: 1,
      tileset: TILES,
      width: 8,
      height: 8,
      metas: [{ path: 'res/deleted.meta-tiles.json', name: 'g_Gone', width: 2, height: 2, frames: 1, flags: 0 }],
      layers: [{ name: 'background', placements: [{ slot: 0, x: 1, y: 1 }] }]
    })
    const session = await openMap()
    expect(doc(session).metas[0].name).toBe('g_Gone')
    expect(doc(session).layers[0].placements).toHaveLength(1)
  })
})
