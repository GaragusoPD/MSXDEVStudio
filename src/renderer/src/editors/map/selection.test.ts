/**
 * The map editor's selection: move, cut/copy/paste, delete, and an imported
 * picture that floats until it is dropped where it goes.
 *
 * A float lives on the session, above the document, so what can go wrong is
 * lifecycle — a float left out of a save, an undo reaching past it, a drop
 * that lands as no step or two, a refused import that throws the user's
 * placement away. `shared/floating.ts` and `dropMapFloat` cannot see any of it.
 */

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { serializeResource } from '../../../../shared/msx/resource'
import { MAX_TILES, normalizeTiles, TILE_SIZE, tilePixels, type TileEntry } from '../../../../shared/msx/tile'
import { normalizeMap } from '../../../../shared/msx/map'
import {
  canUndo,
  copySelection,
  cutSelection,
  deleteSelection,
  displayDoc,
  doc,
  dropFloat,
  floatPicture,
  liftSelection,
  mapSession,
  moveFloatTo,
  nudgeSelection,
  pasteClipboard,
  pruneMapSessions,
  redo,
  saveSession,
  selectLayer,
  setIndexed,
  setSelection,
  setTool,
  undo,
  type MapSession
} from './session'
import { useResourcesStore } from '../../stores/resourcesStore'
import { resetExternalWatches } from '../external-changes'

const MAP = 'res/level.map.json'
const TILES = 'res/main.tiles.json'

/** Tile `i`'s art says which one it is: every row is the byte `i`, ink 15 on paper 1. */
const art = (i: number): TileEntry => ({ pattern: new Array(8).fill(i), color: new Array(8).fill(0xf1) })

let files: Record<string, string>
let confirm: ReturnType<typeof vi.fn>
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** An 8×8 map whose top-left 2×2 block is tiles 1 2 / 3 4, everything else 0. */
function mapFile(data?: number[], width = 8, height = 8): string {
  const cells = data ?? new Array(64).fill(0)
  if (!data) [cells[0], cells[1], cells[8], cells[9]] = [1, 2, 3, 4]
  return JSON.stringify({ version: 1, tileset: TILES, width, height, layers: [{ name: 'background', data: cells }] })
}

beforeEach(() => {
  resetExternalWatches()
  setActivePinia(createPinia())
  files = {
    [TILES]: serializeResource({ kind: 'tiles', doc: normalizeTiles({ mode: 'sc2', count: 8, tiles: Array.from({ length: 8 }, (_, i) => art(i)) }) }),
    [MAP]: mapFile()
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

async function openMap(): Promise<MapSession> {
  const session = mapSession(MAP)
  for (let i = 0; i < 4; i++) await settled()
  return session
}

function cells(session: MapSession): number[] {
  return doc(session).layers[0].data
}

describe('moving a selection', () => {
  it('floats above the layer while dragged, and lands as one undo step', async () => {
    const session = await openMap()
    setTool(session, 'select')
    setSelection(session, { x: 0, y: 0 }, { x: 1, y: 1 })
    expect(liftSelection(session)).toBe(true)
    moveFloatTo(session, { x: 3, y: 2 })
    moveFloatTo(session, { x: 4, y: 3 })

    // The canvas draws it moved; the document has not been touched.
    expect(displayDoc(session).layers[0].data[3 * 8 + 4]).toBe(1)
    expect(displayDoc(session).layers[0].data[0]).toBe(0)
    expect(cells(session)[0]).toBe(1)
    expect(canUndo(session.history)).toBe(false)

    await dropFloat(session)
    expect(session.float).toBeNull()
    expect(cells(session).slice(3 * 8 + 4, 3 * 8 + 6)).toEqual([1, 2])
    expect(cells(session).slice(4 * 8 + 4, 4 * 8 + 6)).toEqual([3, 4])
    expect(cells(session)[0]).toBe(0)
    expect(session.selection).toEqual({ x: 4, y: 3, width: 2, height: 2 })
    expect(session.history.past).toHaveLength(1)

    undo(session)
    expect(cells(session)[0]).toBe(1)
    redo(session)
    expect(cells(session)[3 * 8 + 4]).toBe(1)
  })

  it('takes the float back on undo, and goes no further', async () => {
    const session = await openMap()
    setSelection(session, { x: 0, y: 0 }, { x: 0, y: 0 })
    nudgeSelection(session, 2, 0)
    expect(session.float).not.toBeNull()
    undo(session)
    expect(session.float).toBeNull()
    expect(session.selection).toEqual({ x: 0, y: 0, width: 1, height: 1 })
    expect(cells(session)[0]).toBe(1)
  })

  it('is put down by switching tools, switching layers and saving', async () => {
    const session = await openMap()
    setTool(session, 'select')
    setSelection(session, { x: 0, y: 0 }, { x: 0, y: 0 })
    nudgeSelection(session, 1, 0)
    setTool(session, 'stamp')
    expect(session.float).toBeNull()
    expect(cells(session).slice(0, 3)).toEqual([0, 1, 0])

    nudgeSelection(session, 0, 1)
    selectLayer(session, 0)
    expect(session.float).toBeNull()
    expect(cells(session)[8 + 1]).toBe(1)

    nudgeSelection(session, 1, 0)
    await saveSession(session)
    expect(session.float).toBeNull()
    expect(normalizeMap(JSON.parse(files[MAP])).layers[0].data[8 + 2]).toBe(1)
  })

  it('refuses an indexed layer, whose grid is not its content', async () => {
    files[MAP] = mapFile(new Array(64).fill(0))
    const session = await openMap()
    setIndexed(session, 0, true)
    setSelection(session, { x: 0, y: 0 }, { x: 1, y: 1 })
    expect(liftSelection(session)).toBe(false)
    expect(session.status).toMatch(/indexed/)
  })
})

describe('cut, copy, paste and delete', () => {
  it('pastes as a float where the user is looking, to drag into place', async () => {
    const session = await openMap()
    setSelection(session, { x: 0, y: 0 }, { x: 1, y: 0 })
    copySelection(session)
    session.selection = null
    session.viewOrigin = { x: 5, y: 6 }
    pasteClipboard(session)
    expect(session.tool).toBe('select')
    expect(session.float).toMatchObject({ kind: 'cells', x: 5, y: 6, from: null })
    nudgeSelection(session, 1, 0)
    await dropFloat(session)
    expect(cells(session).slice(6 * 8 + 6, 6 * 8 + 8)).toEqual([1, 2])
    // A paste leaves the original where it was.
    expect(cells(session)[0]).toBe(1)
  })

  it('cuts to the clipboard and clears to tile 0', async () => {
    const session = await openMap()
    setSelection(session, { x: 0, y: 0 }, { x: 1, y: 1 })
    cutSelection(session)
    expect(session.clipboard).toEqual({ width: 2, height: 2, tiles: [1, 2, 3, 4] })
    expect(cells(session).every((tile) => tile === 0)).toBe(true)
  })

  it('deleting a lifted float keeps the hole it left', async () => {
    const session = await openMap()
    setSelection(session, { x: 0, y: 0 }, { x: 1, y: 1 })
    nudgeSelection(session, 3, 3)
    deleteSelection(session)
    expect(session.float).toBeNull()
    expect(cells(session).every((tile) => tile === 0)).toBe(true)
    expect(session.history.past).toHaveLength(1)
  })
})

describe('importing a picture', () => {
  /** A `cols × rows`-cell picture, each cell solid in `colorOf(cx, cy)`. */
  function picture(cols: number, rows: number, colorOf: (cx: number, cy: number) => number) {
    const width = cols * TILE_SIZE
    const height = rows * TILE_SIZE
    const indices = new Uint8Array(width * height)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) indices[y * width + x] = colorOf(Math.floor(x / TILE_SIZE), Math.floor(y / TILE_SIZE))
    }
    return { width, height, indices, rgb: [] }
  }

  it('floats where the user is looking and becomes tiles only where it is dropped', async () => {
    const session = await openMap()
    session.viewOrigin = { x: 1, y: 1 }
    floatPicture(session, picture(2, 1, (cx) => (cx === 0 ? 4 : 6)), 'sc2')
    expect(session.float).toMatchObject({ kind: 'picture', x: 1, y: 1 })
    expect(canUndo(session.history)).toBe(false)

    moveFloatTo(session, { x: 3, y: 2 })
    await dropFloat(session)
    expect(session.float).toBeNull()
    const [a, b] = cells(session).slice(2 * 8 + 3, 2 * 8 + 5)
    expect(tilePixels(session.tileset!, a).every((v) => v === 4)).toBe(true)
    expect(tilePixels(session.tileset!, b).every((v) => v === 6)).toBe(true)
    // Nowhere else: the top-left it used to land on is as it was.
    expect(cells(session).slice(0, 2)).toEqual([1, 2])
    expect(session.history.past).toHaveLength(1)
  })

  it("leaves the cells under the picture's see-through pixels alone", async () => {
    const session = await openMap()
    floatPicture(session, picture(2, 1, (cx) => (cx === 0 ? 4 : 0)), 'sc2')
    moveFloatTo(session, { x: 0, y: 0 })
    await dropFloat(session)
    expect(tilePixels(session.tileset!, cells(session)[0]).every((v) => v === 4)).toBe(true)
    expect(cells(session)[1]).toBe(2)
  })

  it('stays afloat when the drop is declined, to be moved or taken back', async () => {
    const full = normalizeTiles({ mode: 'sc2', count: MAX_TILES, tiles: Array.from({ length: MAX_TILES }, (_, i) => art(i)) })
    files[TILES] = serializeResource({ kind: 'tiles', doc: full })
    files[MAP] = mapFile(Array.from({ length: 16 * 16 }, (_, i) => i), 16, 16)
    confirm.mockReturnValue(false)
    const session = await openMap()
    const before = doc(session)

    floatPicture(session, picture(2, 1, (cx) => (cx === 0 ? 4 : 6)), 'sc2')
    moveFloatTo(session, { x: 5, y: 5 })
    await dropFloat(session)
    expect(confirm).toHaveBeenCalled()
    expect(doc(session)).toBe(before)
    expect(session.float).toMatchObject({ kind: 'picture', x: 5, y: 5 })

    undo(session)
    expect(session.float).toBeNull()
  })

  it('refuses a picture converted for another mode before it floats', async () => {
    const session = await openMap()
    floatPicture(session, picture(1, 1, () => 4), 'sc4')
    expect(session.float).toBeNull()
    expect(session.status).toMatch(/SC4/)
  })
})
