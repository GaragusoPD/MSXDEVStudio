/**
 * The bitmap meta session's wiring, which no shared module can reach.
 *
 * `paintBitmapMeta` is covered thoroughly next door; what is covered here is
 * whether a stroke *arrives* at it. Bugs found in this file by hand were of
 * that shape — a guard returning early, indistinguishable from a dead canvas —
 * and none was visible to any other suite.
 *
 * (A pattern-mode meta-tile owns its pixels and is edited by the pose editor in
 * `editors/anim/`; this session is the `.meta-btiles.json` editor only.)
 *
 * No DOM: `sheet()` is the only thing here that touches `document`, and it is
 * never called.
 */

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_BITMAP_TILES, normalizeBitmapTiles, tileImage } from '../../../../shared/msx/bitmap-tile'
import { createMetaTileDoc, frameTileAt } from '../../../../shared/msx/meta-tile'
import { serializeResource } from '../../../../shared/msx/resource'
import { useTilesetStore } from '../../stores/tilesetStore'
import {
  beginStroke,
  doc,
  endStroke,
  metaSession,
  paint,
  pruneMetaSessions,
  reserveBitmapTile0,
  saveSession,
  setColor,
  undo
} from './session'

const META = 'res/rock.meta-btiles.json'
const TILES = 'res/main.btiles.json'

let files: Record<string, string>

/** Waits for the session's own `load()` chain, which is async and untracked. */
const settled = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function tilesFile(over: Record<string, unknown> = {}): string {
  return serializeResource({
    kind: 'btiles',
    doc: normalizeBitmapTiles({ mode: 'sc5', width: 8, height: 8, count: 4, reserveTile0: true, ...over })
  })
}

const count = (): number => useTilesetStore().bitmapDoc(TILES)!.count

beforeEach(() => {
  setActivePinia(createPinia())
  files = {
    [META]: serializeResource({ kind: 'metabtiles', doc: createMetaTileDoc(TILES, 2, 2) }),
    [TILES]: tilesFile()
  }
  ;(globalThis as { window?: unknown }).window = {
    // reserveBitmapTile0() asks before a migration; every test here says yes.
    confirm: vi.fn(() => true),
    api: {
      // The tileset store registers a file watcher on load, so `on` has to
      // exist even when a test never fires an event through it.
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
  pruneMetaSessions(new Set())
})

describe('a stroke reaches the paint engine', () => {
  it('creates a tile and repoints the cell', async () => {
    const session = metaSession(META)
    await settled()

    paint(session, [{ x: 0, y: 0 }])
    expect(frameTileAt(doc(session), 0, 0, 0)).not.toBe(0)
    expect(count()).toBe(5)
    expect(session.dirty).toBe(true)
  })

  it('says why when there is no tileset, rather than doing nothing', async () => {
    files[META] = serializeResource({ kind: 'metabtiles', doc: createMetaTileDoc('', 2, 2) })
    const session = metaSession(META)
    await settled()

    paint(session, [{ x: 0, y: 0 }])
    expect(session.status).toMatch(/Pick a tileset/)
  })

  it("tracks the cell the stroke landed in, in the tileset's own cell size", async () => {
    files[TILES] = tilesFile({ width: 16, height: 16 })
    const session = metaSession(META)
    await settled()

    // 9 is still cell 0 at 16 dots; an 8-dot grid would say 1.
    paint(session, [{ x: 9, y: 17 }])
    expect(session.activeCell).toEqual({ x: 0, y: 1 })
  })

  it('leaves the tileset alone when the same pixel is painted twice', async () => {
    const session = metaSession(META)
    await settled()

    paint(session, [{ x: 0, y: 0 }])
    const after = count()
    paint(session, [{ x: 0, y: 0 }])
    // The second stroke derives the same tile, so dedup finds it.
    expect(count()).toBe(after)
  })

  it('says so when the bank is full, and clears it once a stroke lands', async () => {
    files[TILES] = tilesFile({ count: MAX_BITMAP_TILES })
    const session = metaSession(META)
    await settled()

    paint(session, [{ x: 0, y: 0 }])
    expect(session.blocked).toBeTruthy()
    expect(frameTileAt(doc(session), 0, 0, 0)).toBe(0)

    // Painting colour 0 over a blank cell resolves to the reserved blank, which
    // needs no room.
    setColor(session, 0)
    paint(session, [{ x: 0, y: 0 }])
    expect(session.blocked).toBeNull()
  })
})

describe('a drag is one edit, not one per sample', () => {
  /** The reported failure: intermediate tiles piling up while drawing. */
  it('mints tiles for the final shape only, however many samples the drag has', async () => {
    const session = metaSession(META)
    await settled()
    const before = count()

    // Forty samples across one row, as a real pointer drag produces.
    beginStroke(session, 'fg')
    for (let x = 0; x < 8; x++) {
      for (let sample = 0; sample < 5; sample++) paint(session, [{ x, y: 0 }], 'fg')
    }
    // Nothing has reached the bank yet — the canvas is drawing a preview.
    expect(count()).toBe(before)
    endStroke(session)

    // One cell changed, so one tile. Not forty.
    expect(count()).toBe(before + 1)
  })

  it('is one undo step, so undo takes back the whole drag', async () => {
    const session = metaSession(META)
    await settled()

    beginStroke(session, 'fg')
    paint(session, [{ x: 0, y: 0 }], 'fg')
    paint(session, [{ x: 1, y: 0 }], 'fg')
    endStroke(session)
    expect(frameTileAt(doc(session), 0, 0, 0)).not.toBe(0)

    undo(session)
    expect(frameTileAt(doc(session), 0, 0, 0)).toBe(0)
  })

  it('saving reclaims the tiles the session created and stopped using', async () => {
    const session = metaSession(META)
    await settled()
    const before = count()

    // Draw, redraw, redraw — each stroke supersedes the last, so two of the
    // three tiles end up referenced by nothing.
    for (const colour of [15, 4, 6]) {
      setColor(session, colour)
      paint(session, [{ x: 0, y: 0 }], 'fg')
    }
    expect(count()).toBe(before + 3)

    await saveSession(session)
    expect(count()).toBe(before + 1)
    expect(session.status).toMatch(/reclaimed 2 unused tiles/i)
    // The surviving tile is still the one the meta points at, and holds the
    // last colour painted.
    const tile = frameTileAt(doc(session), 0, 0, 0)
    expect(tile).not.toBe(0)
    expect(tileImage(useTilesetStore().bitmapDoc(TILES)!, tile)[0]).toBe(6)
  })
})

describe('reserving tile 0 on a tileset that already holds art', () => {
  it('blanks the new tile 0, shifts the art up, and renumbers the meta', async () => {
    files[TILES] = tilesFile({ reserveTile0: false, count: 1 })
    const session = metaSession(META)
    await settled()
    paint(session, [{ x: 0, y: 0 }])
    const painted = frameTileAt(doc(session), 0, 0, 0)

    reserveBitmapTile0(session)
    const tiles = useTilesetStore().bitmapDoc(TILES)!
    expect(tiles.reserveTile0).toBe(true)
    expect([...tileImage(tiles, 0)].every((p) => p === 0)).toBe(true)
    expect(frameTileAt(doc(session), 0, 0, 0)).toBe(painted + 1)
    expect(tileImage(tiles, painted + 1)[0]).toBe(15)
  })

  it('refuses a full bank rather than dropping the last tile', async () => {
    files[TILES] = tilesFile({ reserveTile0: false, count: MAX_BITMAP_TILES })
    const session = metaSession(META)
    await settled()

    reserveBitmapTile0(session)
    expect(useTilesetStore().bitmapDoc(TILES)!.reserveTile0).toBe(false)
    expect(session.status).toMatch(/full/)
  })
})
