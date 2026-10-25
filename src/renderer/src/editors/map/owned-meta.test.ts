/**
 * Meta-tiles that own their pixels, in the tile and map editors: attaching one
 * to a tileset, placing it on a map (which attaches it to the map's tileset),
 * and both editors following the meta when it is saved.
 *
 * The export path is tested from files alone in `resources.test.ts`; these
 * are the editors' halves — the canvas has to show what the build will draw.
 */

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { expandIndexedLayer, normalizeMap } from '../../../../shared/msx/map'
import { normalizeOwnedMeta, type OwnedMetaDoc } from '../../../../shared/msx/meta-owned'
import { defaultExport, serializeResource } from '../../../../shared/msx/resource'
import { isBanked, MAX_TILES, normalizeTiles, type TileEntry } from '../../../../shared/msx/tile'
import { emitAnimSaved } from '../anim/events'
import { useResourcesStore } from '../../stores/resourcesStore'
import { useTilesetStore } from '../../stores/tilesetStore'
import { resetExternalWatches } from '../external-changes'
import { attachableMetas, attachMetaFile, pruneTileSessions, removeMetaFile, tileSession } from '../tile/session'
import { animSession, findAttachments, pruneAnimSessions, removeFromTileset } from '../anim/session'
import {
  doc,
  indexedSummary,
  mapSession,
  movePlacementTo,
  paintDrag,
  pickMeta,
  placeMetaAt,
  pruneMapSessions,
  selectPlacementAt,
  setBaked,
  saveSession as saveMap,
  setIndexed,
  switchToBanked,
  undo,
  unattachedMetas
} from './session'

const MAP = 'res/level.map.json'
const TILES = 'res/main.tiles.json'
const ROCK = 'res/rock.meta-tiles.json'
let files: Record<string, string>
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const tile = (mark: number, paper = 1): TileEntry => ({ pattern: new Array(8).fill(mark), color: new Array(8).fill(0xf0 | paper) })

/** A 2×1 rock: a left half, and a see-through right half. */
function rock(mark = 0x81, poses = 1): OwnedMetaDoc {
  return normalizeOwnedMeta({
    version: 3,
    mode: 'sc2',
    width: 2,
    height: 1,
    holes: [false, true],
    frames: Array.from({ length: poses }, (_, pose) => ({ tiles: [tile(mark + pose), tile(0)], duration: 4 })),
    flags: 1,
    export: defaultExport(ROCK)
  })
}

beforeEach(() => {
  resetExternalWatches()
  setActivePinia(createPinia())
  files = {
    [MAP]: JSON.stringify({ version: 1, tileset: TILES, width: 8, height: 8 }),
    [TILES]: serializeResource({
      kind: 'tiles',
      doc: normalizeTiles({ mode: 'sc2', count: 4, reserveTile0: true, tiles: [tile(0), tile(1), tile(2), tile(3)] })
    }),
    [ROCK]: serializeResource({ kind: 'metatiles', doc: rock() })
  }
  ;(globalThis as { window?: unknown }).window = {
    confirm: vi.fn(() => true),
    api: {
      on: vi.fn(),
      invoke: vi.fn(async (channel: string, args: { path: string; content?: string }) => {
        if (channel === 'fs:read') return files[args.path] ?? ''
        if (channel === 'fs:write') {
          files[args.path] = args.content ?? ''
          return undefined
        }
        if (channel === 'resources:list') {
          return Object.keys(files).map((path) => ({ path, kind: path.endsWith('.meta-tiles.json') ? 'metatiles' : path.endsWith('.map.json') ? 'map' : 'tiles', out: null }))
        }
        throw new Error(`unexpected channel ${channel}`)
      })
    }
  }
  useResourcesStore().entries = [{ path: ROCK, kind: 'metatiles', out: null }]
  pruneMapSessions(new Set())
  pruneTileSessions(new Set())
  pruneAnimSessions(new Set())
})

async function open<T>(make: () => T): Promise<T> {
  const session = make()
  for (let i = 0; i < 6; i++) await settled()
  return session
}

describe('attaching from the tile editor', () => {
  it('gives the meta tiles for its art and lists it', async () => {
    const session = await open(() => tileSession(TILES))
    expect(attachableMetas(session)).toEqual([ROCK])
    await attachMetaFile(session, ROCK)
    expect(session.doc.metas.map((binding) => [binding.path, binding.cells])).toEqual([[ROCK, [4, 0]]])
    expect(session.status).toMatch(/_DrawMeta/)
    expect(attachableMetas(session)).toEqual([])
  })

  it('an animated meta’s moving cells get a window, and the status says how to play it', async () => {
    files[ROCK] = serializeResource({ kind: 'metatiles', doc: rock(0x81, 3) })
    const session = await open(() => tileSession(TILES))
    await attachMetaFile(session, ROCK)
    expect(session.doc.animations.map((binding) => [binding.path, binding.slot])).toEqual([[ROCK, 4]])
    expect(session.status).toMatch(/_Animate\(\) every frame/)
  })

  it('removing it takes its tiles too, and asks nothing when no map places it', async () => {
    const session = await open(() => tileSession(TILES))
    await attachMetaFile(session, ROCK)
    await removeMetaFile(session, ROCK)
    expect(window.confirm).not.toHaveBeenCalled()
    expect(session.doc.metas).toEqual([])
    expect(session.doc.count).toBe(4)
    expect(session.status).toMatch(/Removed rock\.meta-tiles\.json from main\.tiles\.json\. 1 tile went with it/)
  })

  it('removing it keeps a tile another meta shares or a map shows, and renumbers the closed maps', async () => {
    const STONE = 'res/stone.meta-tiles.json'
    const PEBBLE = 'res/pebble.meta-tiles.json'
    const CLOSED = 'res/closed.map.json'
    // Stone's left half is the rock's art, so the two share tile 4; its right half is tile 5, the pebble 6.
    files[STONE] = serializeResource({
      kind: 'metatiles',
      doc: normalizeOwnedMeta({ ...rock(), holes: [false, false], frames: [{ tiles: [tile(0x81), tile(0x42)], duration: 4 }] })
    })
    files[PEBBLE] = serializeResource({ kind: 'metatiles', doc: rock(0x99) })
    const session = await open(() => tileSession(TILES))
    for (const path of [ROCK, STONE, PEBBLE]) await attachMetaFile(session, path)
    expect(session.doc.metas.map((binding) => binding.cells)).toEqual([[4, 0], [4, 5], [6, 0]])
    files[CLOSED] = JSON.stringify({ version: 1, tileset: TILES, width: 2, height: 1, layers: [{ name: 'bg', data: [3, 6] }] })

    await removeMetaFile(session, STONE)
    expect(session.doc.count).toBe(6)
    expect(session.doc.tiles[4].pattern[0]).toBe(0x81)
    expect(session.doc.tiles[5].pattern[0]).toBe(0x99)
    expect(session.doc.metas.map((binding) => binding.cells)).toEqual([[4, 0], [5, 0]])
    // The tileset is unsaved, so the closed map is left to replay the log on open.
    expect(JSON.parse(files[CLOSED]).layers[0].data).toEqual([3, 6])
    expect(useTilesetStore().reorderLog(TILES).at(-1)!.mapping.slice(4, 7)).toEqual([4, 0, 5])

    // A map that shows a meta's tile keeps it.
    files[CLOSED] = JSON.stringify({ version: 1, tileset: TILES, width: 2, height: 1, layers: [{ name: 'bg', data: [3, 5] }] })
    await removeMetaFile(session, PEBBLE)
    expect(session.doc.count).toBe(6)
    expect(session.status).toMatch(/Its tiles stay — something else still shows them/)
  })

  it('opening a tileset whose meta changed on disk gives it its new tiles', async () => {
    const session = await open(() => tileSession(TILES))
    await attachMetaFile(session, ROCK)
    files[TILES] = serializeResource({ kind: 'tiles', doc: session.doc })
    files[ROCK] = serializeResource({ kind: 'metatiles', doc: rock(0x99) })
    pruneTileSessions(new Set())
    setActivePinia(createPinia())
    const reopened = await open(() => tileSession(TILES))
    const cell = reopened.doc.metas[0].cells[0]
    expect(reopened.doc.tiles[cell].pattern[0]).toBe(0x99)
    expect(reopened.status).toMatch(/rock\.meta-tiles\.json changed/)
  })

  it('saving the meta updates an open tileset straight away', async () => {
    const session = await open(() => tileSession(TILES))
    await attachMetaFile(session, ROCK)
    emitAnimSaved({ path: ROCK, doc: rock(0x7e) })
    expect(session.doc.tiles[session.doc.metas[0].cells[0]].pattern[0]).toBe(0x7e)
  })
})

describe('placing one on a map', () => {
  it('is offered whatever tileset it was made over, and picking it attaches it to the map’s', async () => {
    const session = await open(() => mapSession(MAP))
    expect(unattachedMetas(session)).toEqual([ROCK])
    pickMeta(session, ROCK)
    expect(useTilesetStore().patternDoc(TILES)!.metas.map((binding) => binding.path)).toEqual([ROCK])
    expect(useTilesetStore().isDirty(TILES)).toBe(true)
    expect(unattachedMetas(session)).toEqual([])
    expect(doc(session).metas[0]).toMatchObject({ path: ROCK, frames: 1, flags: 1, cells: [4, 0] })
    expect(session.status).toMatch(/Attached rock\.meta-tiles\.json/)
  })

  it('places it, and baking writes the tiles its attachment gave it — never the see-through cell', async () => {
    const session = await open(() => mapSession(MAP))
    pickMeta(session, ROCK)
    placeMetaAt(session, 2, 3)
    selectPlacementAt(session, 2, 3)
    setBaked(session, true)
    const data = doc(session).layers[0].data
    expect(data[3 * 8 + 2]).toBe(4)
    expect(data[3 * 8 + 3]).toBe(0)
  })

  it('follows the meta when it is saved, through the tileset', async () => {
    const session = await open(() => mapSession(MAP))
    pickMeta(session, ROCK)
    emitAnimSaved({ path: ROCK, doc: rock(0x55) })
    const tileset = useTilesetStore().patternDoc(TILES)!
    const cell = tileset.metas[0].cells[0]
    expect(tileset.tiles[cell].pattern[0]).toBe(0x55)
    // The map's mirror and its view of the meta both moved with it.
    expect(doc(session).metas[0].cells).toEqual([cell, 0])
    expect(session.metaDocs.get(ROCK)!.frames[0].tiles).toEqual([cell, 0])
  })

  it('survives the screen switching to banked: its art moves to the tiles every bank shares', async () => {
    files[MAP] = JSON.stringify({ version: 1, tileset: TILES, width: 32, height: 24 })
    const session = await open(() => mapSession(MAP))
    pickMeta(session, ROCK)
    placeMetaAt(session, 2, 3)
    switchToBanked(session)
    const tileset = useTilesetStore().patternDoc(TILES)!
    expect(isBanked(tileset)).toBe(true)
    const cell = tileset.metas[0].cells[0]
    expect(cell).toBe(MAX_TILES - 1)
    expect(tileset.sharedTiles).toBe(1)
    expect(tileset.tiles[cell].pattern[0]).toBe(0x81)
    expect(doc(session).metas[0].cells).toEqual([cell, 0])
    expect(doc(session).layers[0].placements).toEqual([{ slot: 0, x: 2, y: 3 }])
  })

  it('is not offered to a tileset that cannot show its mode', async () => {
    files[ROCK] = serializeResource({ kind: 'metatiles', doc: normalizeOwnedMeta({ ...rock(), mode: 'sc1' }) })
    const session = await open(() => mapSession(MAP))
    expect(unattachedMetas(session)).toEqual([])
  })
})

describe('an indexed layer', () => {
  it('is meta-tiles only: painting tiles on it is refused, and says why', async () => {
    const session = await open(() => mapSession(MAP))
    setIndexed(session, 0, true)
    const before = doc(session)
    paintDrag(session, [{ x: 1, y: 1 }])
    expect(doc(session)).toBe(before)
    expect(session.status).toMatch(/indexed layer: it holds meta-tiles only/)
  })

  it('asks before clearing a layer that has painted cells', async () => {
    files[MAP] = JSON.stringify({ version: 1, tileset: TILES, width: 8, height: 8, layers: [{ name: 'bg', data: new Array(64).fill(2) }] })
    const session = await open(() => mapSession(MAP))
    ;(window.confirm as ReturnType<typeof vi.fn>).mockReturnValueOnce(false)
    setIndexed(session, 0, true)
    expect(doc(session).layers[0].indexed).toBeUndefined()
    setIndexed(session, 0, true)
    expect(doc(session).layers[0].indexed).toBe(true)
    expect(doc(session).layers[0].data.every((tile) => tile === 0)).toBe(true)
  })

  it('places meta-tiles over each other, the later one on top', async () => {
    const session = await open(() => mapSession(MAP))
    setIndexed(session, 0, true)
    pickMeta(session, ROCK)
    placeMetaAt(session, 0, 0)
    placeMetaAt(session, 1, 0)
    expect(doc(session).layers[0].placements.map((p) => [p.x, p.y])).toEqual([
      [0, 0],
      [1, 0]
    ])
    // A click picks the one on top, and moving it over another is allowed.
    expect(selectPlacementAt(session, 1, 0)).toBe(1)
    movePlacementTo(session, 0, 0)
    expect(doc(session).layers[0].placements[1].x).toBe(0)
    movePlacementTo(session, 1, 0)
    // The second rock's left half lands on the first one's see-through half;
    // its own see-through half leaves x=2 empty.
    const { tiles } = expandIndexedLayer(doc(session), doc(session).layers[0])
    expect([...tiles.slice(0, 3)]).toEqual([4, 4, 0])
    expect(indexedSummary(session, 0)).toMatch(/^2 meta-tiles in \d+ bytes — a tile layer is 64/)
  })

  it('has nothing to bake into', async () => {
    const session = await open(() => mapSession(MAP))
    setIndexed(session, 0, true)
    pickMeta(session, ROCK)
    placeMetaAt(session, 0, 0)
    setBaked(session, true)
    expect(doc(session).layers[0].placements[0].baked).toBeUndefined()
    expect(session.status).toMatch(/no grid to bake into/)
  })
})

describe('removing one from a tileset', () => {
  const OTHER = 'res/other.map.json'

  /** The tileset with the rock attached, saved; `level` places it twice, `other` (closed) once. */
  async function setUp(): Promise<{ map: ReturnType<typeof mapSession>; tiles: ReturnType<typeof tileSession> }> {
    const tiles = await open(() => tileSession(TILES))
    await attachMetaFile(tiles, ROCK)
    files[TILES] = serializeResource({ kind: 'tiles', doc: tiles.doc })
    const map = await open(() => mapSession(MAP))
    pickMeta(map, ROCK)
    placeMetaAt(map, 0, 0)
    placeMetaAt(map, 4, 4)
    const ref = doc(map).metas[0]
    files[OTHER] = JSON.stringify({
      version: 1,
      tileset: TILES,
      width: 8,
      height: 8,
      metas: [ref],
      layers: [{ name: 'bg', placements: [{ slot: 0, x: 1, y: 1 }] }],
      tilesetReorderSeen: 1234
    })
    return { map, tiles }
  }

  it('asks, naming the maps, then takes it out of every map drawn with the tileset', async () => {
    const { map, tiles } = await setUp()
    await removeMetaFile(tiles, ROCK)

    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/level\.map\.json, other\.map\.json use it, and its 3 placements go with it/))
    expect(tiles.doc.metas).toEqual([])
    // The open map: one undoable edit.
    expect(doc(map).metas).toEqual([])
    expect(doc(map).layers[0].placements).toEqual([])
    expect(map.dirty).toBe(true)
    expect(map.status).toMatch(/removed from main\.tiles\.json, and from this map with it/)
    // The closed map: rewritten on disk.
    const other = JSON.parse(files[OTHER])
    expect(normalizeMap(other).metas).toEqual([])
    expect(normalizeMap(other).layers[0].placements).toEqual([])
    // The tileset is unsaved: the renumbering waits in its log for the map to open.
    expect(other.tilesetReorderSeen).toBe(1234)
    expect(tiles.status).toMatch(/Removed rock\.meta-tiles\.json from main\.tiles\.json and 3 placements from level\.map\.json, other\.map\.json/)

    undo(map)
    expect(doc(map).layers[0].placements).toHaveLength(2)
  })

  it('changes nothing when the confirm is declined', async () => {
    const { map, tiles } = await setUp()
    const before = files[OTHER]
    ;(window.confirm as ReturnType<typeof vi.fn>).mockReturnValueOnce(false)
    await removeMetaFile(tiles, ROCK)
    expect(tiles.doc.metas).toHaveLength(1)
    expect(doc(map).layers[0].placements).toHaveLength(2)
    expect(files[OTHER]).toBe(before)
  })

  it('from the meta-tile’s own editor: saves the tileset and the clean open map, and lists it no more', async () => {
    const { map } = await setUp()
    // Saved, so the tileset and the map are clean; the map tab stays open.
    await saveMap(map)
    expect(useTilesetStore().isDirty(TILES)).toBe(false)
    pruneTileSessions(new Set())
    const meta = await open(() => animSession(ROCK))
    await findAttachments(meta)
    expect(meta.attachedTo.map((attachment) => attachment.tileset)).toEqual([TILES])

    await removeFromTileset(meta, TILES)
    expect(JSON.parse(files[TILES]).metas ?? []).toEqual([])
    expect(useTilesetStore().isDirty(TILES)).toBe(false)
    expect(doc(map).metas).toEqual([])
    // Saved with it, or its file would place a meta the tileset's no longer has.
    await settled()
    expect(map.dirty).toBe(false)
    expect(normalizeMap(JSON.parse(files[MAP])).metas).toEqual([])
    expect(map.status).toMatch(/— saved\.$/)
    expect(normalizeMap(JSON.parse(files[OTHER])).metas).toEqual([])
    // Saved with the tileset, so the closed map took the renumbering on disk.
    expect(JSON.parse(files[OTHER]).tilesetReorderSeen).toBe(JSON.parse(files[TILES]).reorderLog.at(-1).at)
    expect(meta.attachedTo).toEqual([])
    expect(meta.status).toMatch(/^Removed rock\.meta-tiles\.json from main\.tiles\.json/)
  })

  it('from the meta-tile’s own editor: leaves a tileset with other unsaved edits unsaved, and says so', async () => {
    const { map } = await setUp()
    const mapFile = files[MAP]
    const meta = await open(() => animSession(ROCK))
    await removeFromTileset(meta, TILES)
    expect(useTilesetStore().patternDoc(TILES)!.metas).toEqual([])
    expect(useTilesetStore().isDirty(TILES)).toBe(true)
    expect(meta.status).toMatch(/main\.tiles\.json has other unsaved edits — save it to keep this\./)
    // Nothing saved behind the user's back: the map had edits of its own too.
    expect(map.dirty).toBe(true)
    expect(files[MAP]).toBe(mapFile)
  })

  it('from the meta-tile’s own editor: leaves an open map with other unsaved edits unsaved, and says to save it', async () => {
    const { map } = await setUp()
    await useTilesetStore().save(TILES)
    const meta = await open(() => animSession(ROCK))
    await removeFromTileset(meta, TILES)
    await settled()
    expect(useTilesetStore().isDirty(TILES)).toBe(false)
    expect(map.dirty).toBe(true)
    expect(map.status).toMatch(/save the map to keep it buildable/)
  })
})
