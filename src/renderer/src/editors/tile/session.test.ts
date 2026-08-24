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
import { serializeResource } from '../../../../shared/msx/resource'
import { colorByteAt, normalizeTiles, splitColorByte, type TileEntry } from '../../../../shared/msx/tile'
import { onTilesReordered, type TilesReorderEvent } from '../../../../shared/tile-editor'
import {
  beginStroke,
  deleteTile,
  deleteTiles,
  endStroke,
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

beforeEach(() => {
  setActivePinia(createPinia())
  files = { [PATH]: bank() }
  ;(globalThis as { window?: unknown }).window = {
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
