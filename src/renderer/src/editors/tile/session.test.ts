/**
 * The tile session's multi-tile operations.
 *
 * Deleting a selection is not "delete one" repeated: every removal renumbers
 * the tiles above it, so the caller's second index stops meaning what the user
 * picked. That is invisible from any shared module — `removeTile` is correct on
 * its own — so it is covered here.
 */

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportResult } from '../../composables/useImageImport'
import { parseResource, serializeResource } from '../../../../shared/msx/resource'
import type { MapDoc } from '../../../../shared/msx/map'
import { colorByteAt, normalizeTiles, splitColorByte, type TileEntry } from '../../../../shared/msx/tile'
import { onTilesReordered, type TilesReorderEvent } from '../../../../shared/tile-editor'
import {
  beginStroke,
  deleteTile,
  deleteTiles,
  endStroke,
  importImage,
  paint,
  pruneTileSessions,
  setColor,
  tileSession,
  undo
} from './session'
import { useTilesetStore } from '../../stores/tilesetStore'

const PATH = 'res/main.tiles.json'
let files: Record<string, string>

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Eight tiles whose first pattern byte is its own index, so each is identifiable. */
function bank(): string {
  const tiles: Partial<TileEntry>[] = Array.from({ length: 8 }, (_, i) => ({
    pattern: [i, 0, 0, 0, 0, 0, 0, 0],
    color: new Array(8).fill(0xf1)
  }))
  return serializeResource({ kind: 'tiles', doc: normalizeTiles({ mode: 'sc2', count: 8, tiles }) })
}

const marks = (session: ReturnType<typeof tileSession>): number[] =>
  session.doc.tiles.map((tile) => tile.pattern[0])

/** A picture as wide as `cols` tiles, one tile tall, each tile a flat, distinct palette index. */
/**
 * A picture `cols` tiles wide, one tile tall, where every 8×8 tile has the
 * same left-half/right-half two-color split — so every tile, whatever its
 * column, ends up with identical row-color bytes. That is what an sc1 test
 * needs (every tile in the fresh pack wants the same group pair); an sc2 test
 * that only cares about tile *count* is unaffected by the repetition, since
 * it packs with `dedup: false`.
 */
function picture(cols: number, colors: readonly [number, number] = [1, 2]): ImportResult {
  const width = cols * 8
  const height = 8
  const indices = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) indices[y * width + x] = x % 8 < 4 ? colors[0] : colors[1]
  }
  return { width, height, indices, palette: null, rgb: [], report: { colorsUsed: 0, colorsMerged: 0, rowsAltered: 0, pixelsChanged: 0 } }
}

/** Paths whose `fs:write` should reject, so a save-failure branch can be exercised without a real backend. */
let failWrites: Set<string>

beforeEach(() => {
  setActivePinia(createPinia())
  files = { [PATH]: bank() }
  failWrites = new Set()
  ;(globalThis as { window?: unknown }).window = {
    api: {
      // The tileset store registers a file watcher on load, so `on` has to
      // exist even when a test never fires an event through it.
      on: vi.fn(),
      invoke: vi.fn(async (channel: string, args: { path: string; content?: string }) => {
        if (channel === 'fs:read') return files[args.path] ?? ''
        if (channel === 'fs:stat') return args.path in files ? { isDirectory: false, size: 0, mtimeMs: 0 } : null
        if (channel === 'fs:write') {
          if (failWrites.has(args.path)) throw new Error(`write refused: ${args.path}`)
          files[args.path] = args.content ?? ''
          return undefined
        }
        throw new Error(`unexpected channel ${channel}`)
      })
    }
  }
  pruneTileSessions(new Set())
})

describe('deleting a selection', () => {
  it('removes every tile asked for, not just the first', async () => {
    const session = tileSession(PATH)
    await settled()
    expect(session.doc.count).toBe(8)

    deleteTiles(session, [1, 3, 5])
    expect(session.doc.count).toBe(5)
    // Exactly 1, 3 and 5 are gone — the survivors keep their identity.
    expect(marks(session)).toEqual([0, 2, 4, 6, 7])
  })

  it('is order-independent, because each removal renumbers the rest', async () => {
    const session = tileSession(PATH)
    await settled()
    // Ascending would delete 1, then what *became* 3 (originally 4), and so on.
    deleteTiles(session, [5, 1, 3])
    expect(marks(session)).toEqual([0, 2, 4, 6, 7])
  })

  it('publishes one composed mapping, so maps renumber in a single replay', async () => {
    const events: TilesReorderEvent[] = []
    const stop = onTilesReordered((event) => events.push(event))
    const session = tileSession(PATH)
    await settled()

    deleteTiles(session, [1, 3, 5])
    stop()
    expect(events).toHaveLength(1)
    // Survivors slide down; the deleted ones fall back to tile 0.
    expect(events[0].mapping).toEqual([0, 0, 1, 0, 2, 0, 3, 4])
  })

  it('is one undo step for the whole selection', async () => {
    const session = tileSession(PATH)
    await settled()

    deleteTiles(session, [1, 3, 5])
    undo(session)
    expect(session.doc.count).toBe(8)
    expect(marks(session)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('refuses to empty the bank', async () => {
    const session = tileSession(PATH)
    await settled()

    deleteTiles(session, [0, 1, 2, 3, 4, 5, 6, 7])
    expect(session.doc.count).toBe(8)
    expect(session.status).toMatch(/at least one tile/)
  })

  it('ignores duplicates and out-of-range indices', async () => {
    const session = tileSession(PATH)
    await settled()

    deleteTiles(session, [2, 2, 99, -1])
    expect(session.doc.count).toBe(7)
    expect(marks(session)).toEqual([0, 1, 3, 4, 5, 6, 7])
  })

  it('deleteTile still works, as one index', async () => {
    const session = tileSession(PATH)
    await settled()

    deleteTile(session, 0)
    expect(marks(session)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })
})

describe('drawing', () => {
  it('a left-button stroke sets the row foreground and commits once', async () => {
    const session = tileSession(PATH)
    await settled()
    setColor(session, 9)

    beginStroke(session)
    paint(session, [{ x: 0, y: 0 }], 'fg')
    paint(session, [{ x: 1, y: 0 }], 'fg')
    endStroke(session, 'paint')

    expect(splitColorByte(colorByteAt(session.doc, session.active, 0)).fg).toBe(9)
    // The whole drag is one undo step.
    undo(session)
    expect(splitColorByte(colorByteAt(session.doc, session.active, 0)).fg).not.toBe(9)
  })

  it('a right-button stroke sets the row background', async () => {
    const session = tileSession(PATH)
    await settled()
    setColor(session, 6)

    beginStroke(session)
    paint(session, [{ x: 0, y: 0 }], 'bg')
    endStroke(session, 'paint')

    expect(splitColorByte(colorByteAt(session.doc, session.active, 0)).bg).toBe(6)
  })

  it('changing colour mid-drawing keeps working, as in the meta editor', async () => {
    const session = tileSession(PATH)
    await settled()

    setColor(session, 15)
    beginStroke(session)
    paint(session, [{ x: 0, y: 0 }], 'fg')
    endStroke(session, 'paint')

    setColor(session, 4)
    beginStroke(session)
    paint(session, [{ x: 1, y: 0 }], 'fg')
    endStroke(session, 'paint')

    expect(session.conflict).toBeNull()
    expect(splitColorByte(colorByteAt(session.doc, session.active, 0)).fg).toBe(4)
  })

  it('publishes the edit to the shared store, so a meta editor sees it', async () => {
    const session = tileSession(PATH)
    await settled()
    setColor(session, 9)

    beginStroke(session)
    paint(session, [{ x: 0, y: 0 }], 'fg')
    endStroke(session, 'paint')

    expect(useTilesetStore().patternDoc(PATH)).toBe(session.doc)
    expect(session.dirty).toBe(true)
  })
})

const MAP_PATH = 'res/main.map.json'

describe('importImage', () => {
  it('offsets the map by the tiles that existed before the merge, not after', async () => {
    // Regression test for the likeliest silent defect in this path: reading
    // the pre-existing tile count *after* `commit` would read the post-merge
    // total, and every layout index would be shifted by the wrong amount.
    // `bank()` is 8 tiles, so a merge import's own two tiles must land at 8
    // and 9 — not 10 and 11, which is what a post-commit read would give.
    const session = tileSession(PATH)
    await settled()

    await importImage(session, picture(2), 'merge', false)

    const written = parseResource(MAP_PATH, files[MAP_PATH]).doc as MapDoc
    expect(written.layers[0].data).toEqual([8, 9])
  })

  it('does not overwrite an existing map, and says so', async () => {
    // `demo_msx1/res/intro.tiles.json` ships beside a hand-authored
    // `intro.map.json` — exactly the pairing a merge-mode top-up must not
    // silently destroy.
    files[MAP_PATH] = 'hand-authored, not touched by this import'
    const session = tileSession(PATH)
    await settled()

    await importImage(session, picture(2), 'merge', false)

    expect(files[MAP_PATH]).toBe('hand-authored, not touched by this import')
    expect(session.status).toContain(`${MAP_PATH} already exists`)
    // The tileset itself is the file the user actually opened; that import
    // still has to go through even though the map's import was declined.
    expect(session.dirty).toBe(false)
    expect(useTilesetStore().patternDoc(PATH)?.count).toBe(10)
  })

  it('never writes the map if saving the tileset itself fails', async () => {
    // The pair must land together or not at all — a map written against a
    // tileset that is still the *old* one on disk describes the wrong bank.
    failWrites.add(PATH)
    const session = tileSession(PATH)
    await settled()

    await importImage(session, picture(2), 'merge', false)

    expect(files[MAP_PATH]).toBeUndefined()
    expect(session.status).toMatch(/failed to save the tileset/)
  })

  it('reports how many tiles were dropped, not a false "over the limit"', async () => {
    // 255 existing tiles plus 4 new, distinct ones overflows the 256-tile
    // ceiling by 3 once the merged array is clamped back down. Nothing is
    // "over the limit" to reduce — those 3 tiles were simply never added.
    const tiles: Partial<TileEntry>[] = Array.from({ length: 255 }, (_, i) => ({ pattern: [i % 256, 0, 0, 0, 0, 0, 0, 0] }))
    files[PATH] = serializeResource({ kind: 'tiles', doc: normalizeTiles({ mode: 'sc2', count: 255, tiles }) })
    const session = tileSession(PATH)
    await settled()

    await importImage(session, picture(4), 'merge', false)

    expect(session.status).toMatch(/3 tiles could not be added — the bank is full/)
    expect(session.status).not.toMatch(/over the 256-tile limit/)
  })

  it('extends group colors from the pre-shift array, not from what normalizeTiles already padded', async () => {
    // A fresh sc1 pack of 16 tiles (two full groups) plus the prepended blank
    // needs a *third* group. `normalizeTiles` would pad that new entry with
    // its own white-on-black default — the wrong "old" pair to compare
    // against, and it would wrongly flag the tile there as lossy even though
    // every real group already agrees on one pair.
    files[PATH] = serializeResource({ kind: 'tiles', doc: normalizeTiles({ mode: 'sc1', count: 1, reserveTile0: true }) })
    const session = tileSession(PATH)
    await settled()

    await importImage(session, picture(16, [2, 5]), 'replace', false)

    const written = useTilesetStore().patternDoc(PATH)!
    expect(written.count).toBe(17)
    expect(written.groupColors).toHaveLength(3)
    // The third group repeats the other two's shared pair, so it has nothing
    // to lose — the point of the test.
    expect(written.groupColors[2]).toBe(written.groupColors[1])
    expect(session.status).not.toMatch(/lost the color pair/)
  })
})
