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
import {
  doc,
  mapSession,
  pickMeta,
  placeMetaAt,
  pruneMapSessions,
  selectPlacementAt,
  setBaked,
  undo
} from './session'
import { useResourcesStore } from '../../stores/resourcesStore'
import { resetExternalWatches } from '../external-changes'

const MAP = 'res/level.map.json'
const TILES = 'res/main.tiles.json'
const META = 'res/ground_rocks.meta-tiles.json'

let files: Record<string, string>
/** Push-event handlers the session registered, so tests can fire fs:changed. */
let pushed: Record<string, ((payload: unknown) => void)[]>
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** A meta file, optionally with an export block naming its table. */
function metaFile(exported: boolean, width = 2, height = 3): string {
  const base = createMetaTileDoc(TILES, width, height)
  return serializeResource({
    kind: 'metatiles',
    doc: {
      ...base,
      frames: [{ tiles: new Array(width * height).fill(1) }],
      flags: 0x01,
      export: exported ? defaultExport(META) : null
    }
  })
}

/** Like `metaFile`, but with the middle-left cell transparent. */
function holedMetaFile(): string {
  const base = createMetaTileDoc(TILES, 2, 3)
  return serializeResource({
    kind: 'metatiles',
    doc: {
      ...base,
      frames: [{ tiles: [1, 1, 0, 1, 1, 1] }],
      flags: 0x01,
      export: defaultExport(META)
    }
  })
}

beforeEach(() => {
  resetExternalWatches()
  setActivePinia(createPinia())
  files = {
    [MAP]: JSON.stringify({ version: 1, tileset: TILES, width: 8, height: 8 }),
    [TILES]: serializeResource({ kind: 'tiles', doc: normalizeTiles({ mode: 'sc2', count: 4 }) }),
    [META]: metaFile(true)
  }
  pushed = {}
  ;(globalThis as { window?: unknown }).window = {
    api: {
      on: vi.fn((channel: string, handler: (payload: unknown) => void) => {
        ;(pushed[channel] ??= []).push(handler)
      }),
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

describe('baking a placement into the layer', () => {
  /** Opens a map, places the meta, and selects that placement. */
  async function placed(): Promise<ReturnType<typeof mapSession>> {
    const session = await openMap()
    pickMeta(session, META)
    placeMetaAt(session, 2, 2)
    return session
  }

  const cell = (session: ReturnType<typeof mapSession>, x: number, y: number): number =>
    doc(session).layers[0].data[y * doc(session).width + x]

  it('writes frame 0 into the grid and marks the placement', async () => {
    const session = await placed()
    setBaked(session, true)

    expect(doc(session).layers[0].placements[0].baked).toBe(true)
    // The meta is 2x3 of tile 1 (see metaFile), stamped at 2,2.
    expect(cell(session, 2, 2)).toBe(1)
    expect(cell(session, 3, 4)).toBe(1)
    // Outside it, untouched.
    expect(cell(session, 1, 2)).toBe(0)
  })

  it('leaves transparent cells alone, so a hole stays a hole', async () => {
    // A meta whose middle-left cell is transparent.
    files[META] = holedMetaFile()
    const session = await placed()
    setBaked(session, true)

    expect(cell(session, 2, 2)).toBe(1)
    // The hole: tile 0 in the meta must not be written into the grid.
    expect(cell(session, 2, 3)).toBe(0)
  })

  it('unbaking clears exactly the cells it wrote', async () => {
    const session = await placed()
    setBaked(session, true)
    setBaked(session, false)

    expect(doc(session).layers[0].placements[0].baked).toBeUndefined()
    expect(cell(session, 2, 2)).toBe(0)
    expect(cell(session, 3, 4)).toBe(0)
  })

  it('is one undo step, so baking can be taken back whole', async () => {
    const session = await placed()
    setBaked(session, true)
    undo(session)
    expect(cell(session, 2, 2)).toBe(0)
    expect(doc(session).layers[0].placements[0].baked).toBeUndefined()
  })

  it('uses the meta\'s own geometry, not the mirror\'s, to read its tiles', async () => {
    // A map remembering the meta as 1x1 while it is really 2x3. The refresh
    // corrects the mirror; this pins that baking reads the array with the
    // stride that actually indexes it.
    files[MAP] = JSON.stringify({
      version: 1,
      tileset: TILES,
      width: 8,
      height: 8,
      metas: [{ path: META, name: 'g_Stale', width: 1, height: 1, frames: 1, flags: 0 }],
      layers: [{ name: 'background', placements: [{ slot: 0, x: 2, y: 2 }] }]
    })
    const session = await openMap()
    selectPlacementAt(session, 2, 2)
    setBaked(session, true)

    // All six cells of the real 2x3 meta, not one cell of the remembered 1x1.
    expect(cell(session, 3, 4)).toBe(1)
  })
})

describe('a map rewritten outside the app', () => {
  it('is picked up while the tab is open and clean', async () => {
    const session = await openMap()
    expect(doc(session).width).toBe(8)

    files[MAP] = JSON.stringify({ version: 1, tileset: TILES, width: 20, height: 12 })
    for (const handler of pushed['fs:changed'] ?? []) handler({ type: 'change', path: MAP })
    await new Promise((resolve) => setTimeout(resolve, 160))
    for (let i = 0; i < 4; i++) await settled()

    expect(doc(session).width).toBe(20)
  })

  it('is left alone while the tab has unsaved edits', async () => {
    const session = await openMap()
    pickMeta(session, META) // dirties it

    files[MAP] = JSON.stringify({ version: 1, tileset: TILES, width: 20, height: 12 })
    for (const handler of pushed['fs:changed'] ?? []) handler({ type: 'change', path: MAP })
    await new Promise((resolve) => setTimeout(resolve, 160))
    for (let i = 0; i < 4; i++) await settled()

    expect(doc(session).width).toBe(8)
    expect(session.dirty).toBe(true)
  })
})
