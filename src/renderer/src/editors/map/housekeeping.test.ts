/**
 * The paint mode's tileset housekeeping: removing the tiles nothing uses,
 * merging duplicates, rebuilding a banked screen, and importing a picture.
 *
 * What these protect is the project around the map: a tile is only "unused"
 * if no other map or meta-tile — open, closed, or closed and still in an old
 * numbering — draws with it, and every renumbering has to reach those files.
 */

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { serializeResource } from '../../../../shared/msx/resource'
import { isBanked, MAX_TILES, normalizeTiles, TILE_SIZE, tilePixels, type TileEntry } from '../../../../shared/msx/tile'
import { SCREEN_ROWS } from '../../../../shared/msx/map'
import {
  canUndo,
  doc,
  importPicture,
  mapSession,
  pruneMapSessions,
  removeUnusedTiles,
  renderMapPixels,
  resize,
  switchToBanked,
  switchToRepeat,
  undo,
  type MapSession
} from './session'
import { useResourcesStore } from '../../stores/resourcesStore'
import { useTilesetStore } from '../../stores/tilesetStore'
import { resetExternalWatches } from '../external-changes'

const MAP = 'res/level.map.json'
const OTHER = 'res/other.map.json'
const TILES = 'res/main.tiles.json'

/** Tile `i`'s art says which one it is: every row is the byte `i`, ink 15 on paper 1. */
const art = (i: number): TileEntry => ({ pattern: new Array(8).fill(i), color: new Array(8).fill(0xf1) })

let files: Record<string, string>
let confirm: ReturnType<typeof vi.fn>
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function mapFile(data: number[], width = 8, height = 8, tileset = TILES, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, tileset, width, height, layers: [{ name: 'background', data }], ...extra })
}

/** An 8×8 map whose first cells hold `cells`, the rest tile 0. */
function cellsFile(cells: number[]): string {
  const data = new Array(64).fill(0)
  cells.forEach((tile, i) => (data[i] = tile))
  return mapFile(data)
}

beforeEach(() => {
  resetExternalWatches()
  setActivePinia(createPinia())
  files = {
    // Tiles 0..7, distinct. This map uses 1 and 3.
    [TILES]: serializeResource({ kind: 'tiles', doc: normalizeTiles({ mode: 'sc2', count: 8, tiles: Array.from({ length: 8 }, (_, i) => art(i)) }) }),
    [MAP]: cellsFile([1, 3])
  }
  confirm = vi.fn(() => true)
  ;(globalThis as { window?: unknown }).window = {
    confirm,
    api: {
      on: vi.fn(),
      invoke: vi.fn(async (channel: string, args: { path: string; content?: string }) => {
        if (channel === 'fs:read') {
          if (args.path in files) return files[args.path]
          throw new Error(`ENOENT ${args.path}`)
        }
        if (channel === 'fs:write') {
          files[args.path] = args.content ?? ''
          return undefined
        }
        throw new Error(`unexpected channel ${channel}`)
      })
    }
  }
  useResourcesStore().entries = []
  pruneMapSessions(new Set())
})

async function openMap(path = MAP): Promise<MapSession> {
  const session = mapSession(path)
  for (let i = 0; i < 4; i++) await settled()
  return session
}

/** Which art (`art(i)`'s row byte) each of the first `n` cells of the active layer draws — independent of numbering. */
function drawn(session: MapSession, n: number): number[] {
  return doc(session).layers[0].data.slice(0, n).map((tile) => session.tileset!.tiles[tile].pattern[0])
}

describe('removeUnusedTiles', () => {
  it("drops what nothing uses, keeps this map's art, and starts the history over", async () => {
    const session = await openMap()
    await removeUnusedTiles(session)

    expect(confirm).toHaveBeenCalledOnce()
    // Tile 0 (the empty cells), 1 and 3 survive.
    expect(session.tileset!.count).toBe(3)
    expect(drawn(session, 2)).toEqual([1, 3])
    expect(canUndo(session.history)).toBe(false)
    expect(session.status).toMatch(/Removed 5 unused tiles/)
    // Logged, so maps that are closed renumber when they open.
    expect(useTilesetStore().reorderLog(TILES)).toHaveLength(1)
  })

  it('keeps the tiles a closed map on the same tileset draws, and leaves it drawing them', async () => {
    files[OTHER] = cellsFile([5, 6])
    useResourcesStore().entries = [{ path: OTHER, kind: 'map', out: null }]
    const session = await openMap()
    await removeUnusedTiles(session)

    expect(session.tileset!.count).toBe(5) // 0, 1, 3, 5, 6
    const other = await openMap(OTHER) // replays the logged renumbering
    expect(drawn(other, 2)).toEqual([5, 6])
  })

  it('reads a closed map in the numbering it was saved in, replaying reorders it has not seen', async () => {
    // A reorder the closed map missed: its saved cell 4 means today's tile 6.
    const store = useTilesetStore()
    await store.load(TILES)
    const swap = [0, 1, 2, 3, 6, 5, 4, 7]
    const live = store.patternDoc(TILES)!
    const tiles = live.tiles.slice()
    ;[tiles[4], tiles[6]] = [tiles[6], tiles[4]]
    store.set(TILES, { ...live, tiles }, TILES)
    store.appendReorder(TILES, { path: TILES, mapping: swap, at: 1 })
    files[OTHER] = cellsFile([4])
    useResourcesStore().entries = [{ path: OTHER, kind: 'map', out: null }]

    const session = await openMap()
    await removeUnusedTiles(session)

    // Tile 6 (art 4) is kept; read raw, the old "4" would have kept art 6 instead.
    const survivors = session.tileset!.tiles.slice(0, session.tileset!.count).map((t) => t.pattern[0])
    expect(survivors).toContain(4)
    expect(survivors).not.toContain(6)
  })

  it('does nothing when a file over the tileset cannot be read', async () => {
    useResourcesStore().entries = [{ path: 'res/missing.map.json', kind: 'map', out: null }]
    const session = await openMap()
    const before = session.tileset
    await removeUnusedTiles(session)
    expect(session.tileset).toBe(before)
    expect(session.status).toMatch(/Couldn't read res\/missing.map.json/)
  })

  it('declining the confirm changes nothing', async () => {
    confirm.mockReturnValue(false)
    const session = await openMap()
    const before = session.tileset
    await removeUnusedTiles(session)
    expect(session.tileset).toBe(before)
    expect(useTilesetStore().reorderLog(TILES)).toHaveLength(0)
  })

  it('with merge, folds tiles that draw alike into one', async () => {
    files[TILES] = serializeResource({ kind: 'tiles', doc: normalizeTiles({ mode: 'sc2', count: 3, tiles: [art(0), art(9), art(9)] }) })
    files[MAP] = cellsFile([1, 2])
    const session = await openMap()
    await removeUnusedTiles(session, true)

    expect(session.tileset!.count).toBe(2)
    const [a, b] = doc(session).layers[0].data
    expect(a).toBe(b)
    expect(session.status).toMatch(/Merged 1 duplicate/)
  })

  it('will not rebuild banks while an animation is attached by tile number', async () => {
    const bank = Array.from({ length: 10 }, (_, i) => art(i))
    files[TILES] = serializeResource({
      kind: 'tiles',
      doc: normalizeTiles({
        mode: 'sc2',
        count: 1,
        bankTiles: [bank, bank, bank],
        animations: [{ path: 'res/coin.anim-tiles.json', slot: 4, bank: 0, name: 'g_Coin', width: 1, height: 1, frames: 4, colorsVary: false, loop: 'loop' }]
      })
    })
    files[MAP] = mapFile(new Array(32 * SCREEN_ROWS).fill(0), 32, SCREEN_ROWS)
    const session = await openMap()
    const before = session.tileset

    await removeUnusedTiles(session)

    expect(session.tileset).toBe(before)
    expect(confirm).not.toHaveBeenCalled()
    expect(session.status).toMatch(/coin\.anim-tiles\.json\)\. Detach them first/)
  })

  it('on a banked screen, rebuilds the banks from the screen', async () => {
    const bank = Array.from({ length: 10 }, (_, i) => art(i))
    files[TILES] = serializeResource({ kind: 'tiles', doc: normalizeTiles({ mode: 'sc2', count: 1, bankTiles: [bank, bank, bank] }) })
    const data = new Array(32 * SCREEN_ROWS).fill(0)
    data[0] = 4
    files[MAP] = mapFile(data, 32, SCREEN_ROWS)
    const session = await openMap()
    const before = renderMapPixels(doc(session), session.tileset!, 0).indices

    await removeUnusedTiles(session)

    expect(isBanked(session.tileset!)).toBe(true)
    // Bank 0 keeps the two tiles the screen shows; banks 1-2 one each.
    expect(session.tileset!.bankTiles.map((b) => b.length)).toEqual([2, 1, 1])
    expect(renderMapPixels(doc(session), session.tileset!, 0).indices).toEqual(before)
  })
})

describe('importPicture', () => {
  /** A `cols × rows`-cell picture, each cell solid in `colorOf(cx, cy)`. */
  function picture(cols: number, rows: number, colorOf: (cx: number, cy: number) => number) {
    const width = cols * TILE_SIZE
    const height = rows * TILE_SIZE
    const indices = new Uint8Array(width * height)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) indices[y * width + x] = colorOf(Math.floor(x / TILE_SIZE), Math.floor(y / TILE_SIZE))
    }
    return { width, height, indices }
  }

  it('places the picture from the top-left as one undoable step', async () => {
    const session = await openMap()
    const before = doc(session)
    await importPicture(session, picture(2, 1, (cx) => (cx === 0 ? 4 : 6)), 'sc2')

    const [a, b, c] = doc(session).layers[0].data
    expect(tilePixels(session.tileset!, a).every((v) => v === 4)).toBe(true)
    expect(tilePixels(session.tileset!, b).every((v) => v === 6)).toBe(true)
    expect(c).toBe(0) // outside the picture: untouched
    expect(confirm).not.toHaveBeenCalled()

    undo(session)
    expect(doc(session)).toBe(before)
  })

  it('refuses a picture converted for another mode', async () => {
    const session = await openMap()
    const before = doc(session)
    await importPicture(session, picture(1, 1, () => 4), 'sc4')
    expect(doc(session)).toBe(before)
    expect(session.status).toMatch(/SC4/)
  })

  it('makes room by dropping the tiles only the replaced cells used', async () => {
    // A full tileset; the map draws 255 distinct tiles in its first cells.
    const full = normalizeTiles({
      mode: 'sc2',
      count: MAX_TILES,
      tiles: Array.from({ length: MAX_TILES }, (_, i) => art(i))
    })
    files[TILES] = serializeResource({ kind: 'tiles', doc: full })
    const data = Array.from({ length: 16 * 16 }, (_, i) => i)
    files[MAP] = mapFile(data, 16, 16)
    const session = await openMap()

    // Two new colours over the first two cells: no slot left until tiles 0 and 1 go.
    await importPicture(session, picture(2, 1, (cx) => (cx === 0 ? 4 : 6)), 'sc2')

    expect(confirm).toHaveBeenCalledOnce()
    const [a, b, c] = doc(session).layers[0].data
    expect(tilePixels(session.tileset!, a).every((v) => v === 4)).toBe(true)
    expect(tilePixels(session.tileset!, b).every((v) => v === 6)).toBe(true)
    expect(session.tileset!.tiles[c].pattern[0]).toBe(2)
    // The import itself is still a step of its own.
    expect(canUndo(session.history)).toBe(true)
  })

  it('offers banks when even that is not enough, and imports into them', async () => {
    files[TILES] = serializeResource({ kind: 'tiles', doc: normalizeTiles({ mode: 'sc2', count: 1 }) })
    files[MAP] = mapFile(new Array(32 * SCREEN_ROWS).fill(0), 32, SCREEN_ROWS)
    const session = await openMap()
    resize(session, 32, SCREEN_ROWS)

    // 300 distinct cells: more than one bank of 256 holds.
    const pic = picture(32, SCREEN_ROWS, () => 0)
    const width = pic.width
    for (let cell = 0; cell < 300; cell++) {
      const ox = (cell % 32) * TILE_SIZE
      const oy = Math.floor(cell / 32) * TILE_SIZE
      // A unique pattern per cell: its number in binary across the first two rows.
      for (let bit = 0; bit < 9; bit++) if (cell & (1 << bit)) pic.indices[(oy + (bit >> 3)) * width + ox + (bit & 7)] = 15
    }
    await importPicture(session, pic, 'sc2')

    expect(confirm).toHaveBeenCalled()
    expect(isBanked(session.tileset!)).toBe(true)
    // Every dot of the screen is the picture's.
    expect(renderMapPixels(doc(session), session.tileset!, 0).indices).toEqual(pic.indices)
  })

  /** A 32×24 screen on an empty tileset, and a picture of it with `distinct` different cells. */
  async function screenWith(distinct: number): Promise<{ session: MapSession; pic: ReturnType<typeof picture> }> {
    files[TILES] = serializeResource({ kind: 'tiles', doc: normalizeTiles({ mode: 'sc2', count: 1 }) })
    files[MAP] = mapFile(new Array(32 * SCREEN_ROWS).fill(0), 32, SCREEN_ROWS)
    const session = await openMap()
    const pic = picture(32, SCREEN_ROWS, () => 0)
    for (let cell = 0; cell < distinct; cell++) {
      const ox = (cell % 32) * TILE_SIZE
      const oy = Math.floor(cell / 32) * TILE_SIZE
      for (let bit = 0; bit < 9; bit++) if (cell & (1 << bit)) pic.indices[(oy + (bit >> 3)) * pic.width + ox + (bit & 7)] = 15
    }
    return { session, pic }
  }

  it('Banks: Repeat never banks the screen — it says how to, and leaves it alone', async () => {
    const { session, pic } = await screenWith(300)
    const before = doc(session)
    await importPicture(session, pic, 'sc2', { x: 0, y: 0 }, null, 'repeat')
    expect(confirm).not.toHaveBeenCalled()
    expect(isBanked(session.tileset!)).toBe(false)
    expect(doc(session)).toBe(before)
    expect(session.status).toMatch(/choose Banks: Auto or Banked/)
  })

  it('Banks: Banked switches the screen to banked even when one set would do', async () => {
    const { session, pic } = await screenWith(10)
    await importPicture(session, pic, 'sc2', { x: 0, y: 0 }, null, 'banked')
    expect(confirm).toHaveBeenCalledOnce()
    expect(isBanked(session.tileset!)).toBe(true)
    expect(renderMapPixels(doc(session), session.tileset!, 0).indices).toEqual(pic.indices)
  })
})

describe('the Repeat/Banked switch', () => {
  /** A 32×24 screen on `tiles`, whose first `distinct` cells draw different art (tile i is art(i)). */
  async function screen(distinct: number, reserveTile0 = false): Promise<MapSession> {
    const count = Math.min(distinct + 1, MAX_TILES)
    files[TILES] = serializeResource({
      kind: 'tiles',
      doc: normalizeTiles({ mode: 'sc2', count, reserveTile0, tiles: Array.from({ length: count }, (_, i) => art(i)) })
    })
    const data = new Array(32 * SCREEN_ROWS).fill(0)
    for (let i = 0; i < distinct; i++) data[i] = (i % (count - 1)) + 1
    files[MAP] = mapFile(data, 32, SCREEN_ROWS)
    return openMap()
  }

  it('goes to banked and back, and the screen shows the same dots all the way', async () => {
    const session = await screen(40, true)
    const before = renderMapPixels(doc(session), session.tileset!, 0).indices

    switchToBanked(session)
    expect(isBanked(session.tileset!)).toBe(true)
    expect(renderMapPixels(doc(session), session.tileset!, 0).indices).toEqual(before)

    switchToRepeat(session)
    expect(isBanked(session.tileset!)).toBe(false)
    expect(session.tileset!.reserveTile0).toBe(true)
    expect(renderMapPixels(doc(session), session.tileset!, 0).indices).toEqual(before)
    expect(doc(session).layers[0].data[32 * 23]).toBe(0) // an empty cell is still the see-through tile 0
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('stays banked when the screen draws more than one set holds', async () => {
    files[TILES] = serializeResource({ kind: 'tiles', doc: normalizeTiles({ mode: 'sc2', count: 1 }) })
    files[MAP] = mapFile(new Array(32 * SCREEN_ROWS).fill(0), 32, SCREEN_ROWS)
    const session = await openMap()
    const pic = { width: 256, height: 192, indices: new Uint8Array(256 * 192) }
    for (let cell = 0; cell < 300; cell++) {
      const ox = (cell % 32) * TILE_SIZE
      const oy = Math.floor(cell / 32) * TILE_SIZE
      for (let bit = 0; bit < 9; bit++) if (cell & (1 << bit)) pic.indices[(oy + (bit >> 3)) * 256 + ox + (bit & 7)] = 15
    }
    await importPicture(session, pic, 'sc2', { x: 0, y: 0 }, null, 'banked')
    expect(isBanked(session.tileset!)).toBe(true)
    confirm.mockClear()

    switchToRepeat(session)
    expect(isBanked(session.tileset!)).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(session.status).toMatch(/has to stay banked/)
  })

  it('a declined switch changes nothing', async () => {
    const session = await screen(10)
    confirm.mockReturnValue(false)
    const before = session.tileset
    switchToBanked(session)
    expect(session.tileset).toBe(before)
  })
})
