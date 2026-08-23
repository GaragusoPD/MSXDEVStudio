/**
 * The meta session's wiring, which no shared module can reach.
 *
 * `paintMeta` is covered thoroughly next door; what is covered here is whether
 * a stroke *arrives* at it. Both bugs found in this file by hand were of that
 * shape — a guard returning early, indistinguishable from a dead canvas — and
 * neither was visible to any other suite.
 *
 * No DOM: `sheet()` is the only thing here that touches `document`, and it is
 * never called.
 */

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMetaTileDoc, frameTileAt } from '../../../../shared/msx/meta-tile'
import { serializeResource } from '../../../../shared/msx/resource'
import { colorByteAt, normalizeTiles, splitColorByte } from '../../../../shared/msx/tile'
import { useTilesetStore } from '../../stores/tilesetStore'
import { doc, metaSession, paint, pruneMetaSessions, setColor, tiles } from './session'

const META = 'res/tree.meta-tiles.json'
const TILES = 'res/main.tiles.json'

let files: Record<string, string>

/** Waits for the session's own `load()` chain, which is async and untracked. */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function tilesFile(reserve: boolean): string {
  return serializeResource({ kind: 'tiles', doc: normalizeTiles({ mode: 'sc2', count: 4, reserveTile0: reserve }) })
}

beforeEach(() => {
  setActivePinia(createPinia())
  files = {
    [META]: serializeResource({ kind: 'metatiles', doc: createMetaTileDoc(TILES, 2, 2) }),
    [TILES]: tilesFile(true)
  }
  ;(globalThis as { window?: unknown }).window = {
    api: {
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
    await settled()
    expect(tiles(session)).not.toBeNull()

    paint(session, [{ x: 0, y: 0 }])
    expect(frameTileAt(doc(session), 0, 0, 0)).not.toBe(0)
    expect(useTilesetStore().patternDoc(TILES)!.count).toBe(5)
    expect(session.dirty).toBe(true)
  })

  it('draws even when the tileset has not reserved tile 0', async () => {
    // Reserving buys transparency, not the right to draw. Refusing the stroke
    // made every pre-existing tileset look like a broken editor.
    files[TILES] = tilesFile(false)
    const session = metaSession(META)
    await settled()
    await settled()

    paint(session, [{ x: 0, y: 0 }])
    expect(frameTileAt(doc(session), 0, 0, 0)).not.toBe(0)
  })

  it('says why when there is no tileset, rather than doing nothing', async () => {
    files[META] = serializeResource({ kind: 'metatiles', doc: createMetaTileDoc('', 2, 2) })
    const session = metaSession(META)
    await settled()
    await settled()

    paint(session, [{ x: 0, y: 0 }])
    expect(session.status).toMatch(/Pick a tileset/)
  })

  it('tracks the cell the stroke landed in, which SCREEN 1 keys its palette to', async () => {
    const session = metaSession(META)
    await settled()
    await settled()

    paint(session, [{ x: 9, y: 9 }])
    expect(session.activeCell).toEqual({ x: 1, y: 1 })
  })

  it('leaves the tileset alone when the same pixel is painted twice', async () => {
    const session = metaSession(META)
    await settled()
    await settled()

    paint(session, [{ x: 0, y: 0 }])
    const after = useTilesetStore().patternDoc(TILES)!.count
    paint(session, [{ x: 0, y: 0 }])
    // The second stroke derives the same tile, so dedup finds it.
    expect(useTilesetStore().patternDoc(TILES)!.count).toBe(after)
  })
})

describe('changing colour mid-drawing', () => {
  /** The reported failure: draw, pick another colour, draw again, nothing happens. */
  it('keeps painting after the colour changes', async () => {
    const session = metaSession(META)
    await settled()
    await settled()

    setColor(session, 15)
    paint(session, [{ x: 0, y: 0 }])
    const first = frameTileAt(doc(session), 0, 0, 0)
    expect(first).not.toBe(0)

    // Same 8×1 row, a different colour. sc2 holds two colours per row and the
    // blank tile pinned background to 0, so without a role this row is full and
    // the stroke was dropped — which looked like an editor that had died.
    setColor(session, 4)
    paint(session, [{ x: 1, y: 0 }])
    expect(session.status).not.toMatch(/dropped/)
    expect(frameTileAt(doc(session), 0, 0, 0)).not.toBe(first)

    const tileset = useTilesetStore().patternDoc(TILES)!
    const painted = frameTileAt(doc(session), 0, 0, 0)
    // The row's foreground is the new colour, and both pixels wear it: that is
    // what two-per-row means, not a refusal.
    expect(splitColorByte(colorByteAt(tileset, painted, 0)).fg).toBe(4)
  })

  it('the right button paints the row background, so a pair can be set deliberately', async () => {
    const session = metaSession(META)
    await settled()
    await settled()

    setColor(session, 15)
    paint(session, [{ x: 0, y: 0 }], 'fg')
    setColor(session, 6)
    paint(session, [{ x: 1, y: 0 }], 'bg')

    const tileset = useTilesetStore().patternDoc(TILES)!
    const { fg, bg } = splitColorByte(colorByteAt(tileset, frameTileAt(doc(session), 0, 0, 0), 0))
    expect(fg).toBe(15)
    expect(bg).toBe(6)
  })
})
