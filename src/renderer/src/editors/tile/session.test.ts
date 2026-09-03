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
import { colorByteAt, MAX_TILES, normalizeTiles, splitColorByte, type TileEntry } from '../../../../shared/msx/tile'
import { onTilesReordered, type TilesReorderEvent } from '../../../../shared/tile-editor'
import {
  addTile,
  bankBudgetLabel,
  beginStroke,
  deleteTile,
  deleteTiles,
  endStroke,
  importImage,
  paint,
  pruneTileSessions,
  reorder,
  resolveConflict,
  select,
  setBank,
  setColor,
  tileSession,
  canUndo,
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

describe('addTile', () => {
  it('refuses to grow count into the shared reservation, even with MAX_TILES room to spare', async () => {
    files[PATH] = serializeResource({
      kind: 'tiles',
      // 250 common tiles, 6 reserved for meta-tiles: 256 total, none free —
      // but well under MAX_TILES on its own, which is what the old
      // `count >= MAX_TILES` check alone would have missed. A bank override,
      // so `sharedTiles` is genuinely banked rather than clamped away as
      // incoherent state (see `normalizeTiles`).
      doc: normalizeTiles({
        mode: 'sc2',
        count: 250,
        bankTiles: [[{ pattern: new Array(8).fill(1), color: new Array(8).fill(0xf1) }], [], []],
        sharedTiles: 6
      })
    })
    const session = tileSession(PATH)
    await settled()

    addTile(session)

    expect(session.doc.count).toBe(250)
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

  it('reports how many tiles were dropped, not a false "over the limit" — and that the map will not export', async () => {
    // 255 existing tiles plus 4 new, distinct ones overflows the 256-tile
    // ceiling by 3 once the merged array is clamped back down. Nothing is
    // "over the limit" to reduce — those 3 tiles were simply never added.
    // The map that gets written still references them, so the user needs to
    // learn now, not at the next export attempt, that it will fail.
    const tiles: Partial<TileEntry>[] = Array.from({ length: 255 }, (_, i) => ({ pattern: [i % 256, 0, 0, 0, 0, 0, 0, 0] }))
    files[PATH] = serializeResource({ kind: 'tiles', doc: normalizeTiles({ mode: 'sc2', count: 255, tiles }) })
    const session = tileSession(PATH)
    await settled()

    await importImage(session, picture(4), 'merge', false)

    expect(session.status).toMatch(/3 tiles could not be added — the bank is full/)
    expect(session.status).toMatch(/will not export/)
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

  it('preserves a live shared tile through a merge, and appends within the reservation', async () => {
    // The shared region sits far above `count` in this same sparse `tiles`
    // array a merge appends into. Before this fix, `offset` read
    // `session.doc.tiles.length` — 256 once any shared tile has ever
    // existed, regardless of `count` — so a merge on a banked doc silently
    // discarded everything it imported; and even with the right offset, the
    // merged array normalizeTiles's shared-region rebuild reads from needed
    // the shared tile's bytes reattached, or that rebuild finds nothing there
    // and blanks a meta's live art while `sharedTiles` still claims it.
    const live: TileEntry = { pattern: new Array(8).fill(0x99), color: new Array(8).fill(0xf1) }
    const rawTiles: unknown[] = Array.from({ length: 8 }, (_, i) => ({
      pattern: [i, 0, 0, 0, 0, 0, 0, 0],
      color: new Array(8).fill(0xf1)
    }))
    rawTiles[255] = live
    files[PATH] = serializeResource({
      kind: 'tiles',
      // A bank override, so `sharedTiles` is genuinely banked rather than
      // clamped away as incoherent state (see `normalizeTiles`).
      doc: normalizeTiles({
        mode: 'sc2',
        count: 8,
        tiles: rawTiles,
        bankTiles: [[{ pattern: new Array(8).fill(9), color: new Array(8).fill(0xf1) }], [], []],
        sharedTiles: 1
      })
    })
    const session = tileSession(PATH)
    await settled()

    await importImage(session, picture(2), 'merge', false)

    const written = useTilesetStore().patternDoc(PATH)!
    expect(written.count).toBe(10) // the 8 existing common tiles plus 2 imported
    expect(written.sharedTiles).toBe(1) // a merge never touches the reservation
    expect(written.tiles[255]).toEqual(live)
    // The pre-existing common tiles rode along unchanged, at their own indices.
    expect(written.tiles.slice(0, 8).map((tile) => tile.pattern[0])).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('preserves a live shared tile through a replace, too', async () => {
    const live: TileEntry = { pattern: new Array(8).fill(0x99), color: new Array(8).fill(0xf1) }
    const rawTiles: unknown[] = Array.from({ length: 8 }, (_, i) => ({
      pattern: [i, 0, 0, 0, 0, 0, 0, 0],
      color: new Array(8).fill(0xf1)
    }))
    rawTiles[255] = live
    files[PATH] = serializeResource({
      kind: 'tiles',
      // A bank override, so `sharedTiles` is genuinely banked rather than
      // clamped away as incoherent state (see `normalizeTiles`).
      doc: normalizeTiles({
        mode: 'sc2',
        count: 8,
        tiles: rawTiles,
        bankTiles: [[{ pattern: new Array(8).fill(9), color: new Array(8).fill(0xf1) }], [], []],
        sharedTiles: 1
      })
    })
    const session = tileSession(PATH)
    await settled()

    await importImage(session, picture(2), 'replace', false)

    const written = useTilesetStore().patternDoc(PATH)!
    expect(written.count).toBe(2) // replace throws away the old common tiles...
    expect(written.sharedTiles).toBe(1) // ...but not a meta's shared art
    expect(written.tiles[255]).toEqual(live)
  })
})

// ── banking (Task 7) ─────────────────────────────────────────────────────────

/** One identifiable tile entry, its own first pattern byte its mark. */
function mark(value: number): TileEntry {
  return { pattern: [value, 0, 0, 0, 0, 0, 0, 0], color: new Array(8).fill(0xf1) }
}

describe('bank editing', () => {
  it('painting a banked tileset edits that bank, not the common set', async () => {
    // Bank 2 alone carries an override, so `isBanked` is true while bank 0
    // (the "Bank 1" this test paints) starts genuinely empty — the sparse
    // case the fixture-density warning on this branch asks for, not a
    // uniform `count: 256` doc that would hide a wrong-array write.
    files[PATH] = serializeResource({
      kind: 'tiles',
      doc: normalizeTiles({ mode: 'sc2', count: 1, bankTiles: [[], [], [mark(9)]] })
    })
    const session = tileSession(PATH)
    await settled()

    setBank(session, 0)
    select(session, 0)
    setColor(session, 5)
    beginStroke(session)
    paint(session, [{ x: 0, y: 0 }], 'fg')
    endStroke(session, 'paint')

    expect(session.doc.bankTiles[0]).not.toEqual([])
    expect(session.doc.bankTiles[0][0]).not.toEqual(session.doc.tiles[0])
    // Painting bank 0 must not touch a bank it wasn't asked to.
    expect(session.doc.bankTiles[1]).toEqual([])
  })

  it('growing into an unoverridden index seeds the gap from the common tile it was already showing', async () => {
    const commonTiles = [mark(10), mark(11), mark(12), mark(13)]
    files[PATH] = serializeResource({
      kind: 'tiles',
      doc: normalizeTiles({ mode: 'sc2', count: 4, tiles: commonTiles, bankTiles: [[mark(99)], [], []] })
    })
    const session = tileSession(PATH)
    await settled()

    setBank(session, 0)
    select(session, 3)
    setColor(session, 5)
    beginStroke(session)
    paint(session, [{ x: 0, y: 0 }], 'fg')
    endStroke(session, 'paint')

    expect(session.doc.bankTiles[0]).toHaveLength(4)
    // The slots between the pre-existing override and the one just painted
    // were never touched — they show, and now store, exactly the common
    // tile the bank was already falling back to there.
    expect(session.doc.bankTiles[0][1]).toEqual(commonTiles[1])
    expect(session.doc.bankTiles[0][2]).toEqual(commonTiles[2])
    // The pre-existing override at index 0 is untouched by painting index 3.
    expect(session.doc.bankTiles[0][0].pattern[0]).toBe(99)
  })

  it('painting an already-overridden index edits it in place, without growing the array', async () => {
    files[PATH] = serializeResource({
      kind: 'tiles',
      doc: normalizeTiles({ mode: 'sc2', count: 1, bankTiles: [[mark(1), mark(2)], [], []] })
    })
    const session = tileSession(PATH)
    await settled()

    setBank(session, 0)
    select(session, 1)
    setColor(session, 9)
    beginStroke(session)
    paint(session, [{ x: 0, y: 0 }], 'fg')
    endStroke(session, 'paint')

    expect(session.doc.bankTiles[0]).toHaveLength(2)
    expect(splitColorByte(session.doc.bankTiles[0][1].color[0]).fg).toBe(9)
  })

  it('refuses to paint a shared tile from a bank view', async () => {
    files[PATH] = serializeResource({
      kind: 'tiles',
      doc: normalizeTiles({ mode: 'sc2', count: 1, bankTiles: [[mark(1)], [], []], sharedTiles: 2 })
    })
    const session = tileSession(PATH)
    await settled()

    setBank(session, 0)
    select(session, MAX_TILES - 1) // inside the top 2 shared indices
    setColor(session, 9)
    beginStroke(session)
    paint(session, [{ x: 0, y: 0 }], 'fg')
    endStroke(session, 'paint')

    expect(session.doc.bankTiles[0]).toHaveLength(1) // unchanged
    expect(session.status).toMatch(/shared/i)
  })

  it('refuses to paint tile 0 in a bank view when reserveTile0 locks it', async () => {
    files[PATH] = serializeResource({
      kind: 'tiles',
      doc: normalizeTiles({ mode: 'sc2', count: 1, reserveTile0: true, bankTiles: [[], [], [mark(1)]] })
    })
    const session = tileSession(PATH)
    await settled()

    setBank(session, 1)
    select(session, 0)
    setColor(session, 9)
    beginStroke(session)
    paint(session, [{ x: 0, y: 0 }], 'fg')
    endStroke(session, 'paint')

    expect(session.doc.bankTiles[1]).toEqual([])
    expect(session.status).toMatch(/reserved/i)
  })

  it('still raises the conflict popover on a bank row, and resolving it lands in bankTiles', async () => {
    // Pattern bit 1 set (x=1 is FG), everything else clear (BG) — so painting
    // x=2 with a third, distinct color has both roles already in use in that
    // row and cannot resolve on its own.
    const rowInUse: TileEntry = { pattern: [0x40, 0, 0, 0, 0, 0, 0, 0], color: [0x12, 0xf1, 0xf1, 0xf1, 0xf1, 0xf1, 0xf1, 0xf1] }
    files[PATH] = serializeResource({
      kind: 'tiles',
      doc: normalizeTiles({ mode: 'sc2', count: 1, bankTiles: [[rowInUse], [], []] })
    })
    const session = tileSession(PATH)
    await settled()

    setBank(session, 0)
    select(session, 0)
    setColor(session, 9)
    beginStroke(session)
    paint(session, [{ x: 2, y: 0 }]) // no role — can conflict
    expect(session.conflict).not.toBeNull()
    expect(session.conflict?.bank).toBe(0)

    resolveConflict(session, 'bg')
    endStroke(session, 'paint')

    expect(session.conflict).toBeNull()
    expect(splitColorByte(session.doc.bankTiles[0][0].color[0]).bg).toBe(9)
  })

  it('undo after a bank paint restores bankTiles without resetting the selection', async () => {
    // `count` is 1 here, the shape a `packBankedTiles` import actually leaves
    // behind — a naive `active >= doc.count` clamp on undo would yank the
    // selection back to tile 0.
    files[PATH] = serializeResource({
      kind: 'tiles',
      doc: normalizeTiles({ mode: 'sc2', count: 1, bankTiles: [[], [], [mark(1)]] })
    })
    const session = tileSession(PATH)
    await settled()

    setBank(session, 1)
    select(session, 5)
    setColor(session, 9)
    beginStroke(session)
    paint(session, [{ x: 0, y: 0 }], 'fg')
    endStroke(session, 'paint')

    expect(session.doc.bankTiles[1]).toHaveLength(6)
    expect(session.active).toBe(5)

    undo(session)

    expect(session.doc.bankTiles[1]).toEqual([])
    expect(session.active).toBe(5)
  })

  it('fills a bank exactly to its capacity, and refuses the tile just past it', async () => {
    // 252 distinct overrides, 3 shared — one free hardware index (252) before
    // the shared region starts at 253. Deliberately not `count: 256`: every
    // entry differs (`mark(i)`), so a wrong-index write would still show up.
    const overrides = Array.from({ length: MAX_TILES - 4 }, (_, i) => mark(i % 256))
    files[PATH] = serializeResource({
      kind: 'tiles',
      doc: normalizeTiles({ mode: 'sc2', count: 1, bankTiles: [overrides, [], []], sharedTiles: 3 })
    })
    const session = tileSession(PATH)
    await settled()

    setBank(session, 0)
    setColor(session, 9)

    select(session, MAX_TILES - 4) // the last hardware index before the shared region
    beginStroke(session)
    paint(session, [{ x: 0, y: 0 }], 'fg')
    endStroke(session, 'paint')

    expect(session.doc.bankTiles[0]).toHaveLength(MAX_TILES - 3)
    expect(bankBudgetLabel(session.doc, 0)).toBe(`bank 1: ${MAX_TILES - 3} + 3 shared = ${MAX_TILES} / ${MAX_TILES}`)

    select(session, MAX_TILES - 3) // the first shared index
    beginStroke(session)
    paint(session, [{ x: 0, y: 0 }], 'fg')
    endStroke(session, 'paint')

    expect(session.doc.bankTiles[0]).toHaveLength(MAX_TILES - 3) // refused; capacity unchanged
  })

  it('refuses to delete or reorder tiles on a banked tileset — a bank\'s own art does not renumber with the common set', async () => {
    files[PATH] = serializeResource({
      kind: 'tiles',
      doc: normalizeTiles({ mode: 'sc2', count: 4, tiles: [mark(0), mark(1), mark(2), mark(3)], bankTiles: [[mark(9)], [], []] })
    })
    const session = tileSession(PATH)
    await settled()

    deleteTiles(session, [1])
    expect(session.doc.count).toBe(4)
    expect(session.status).toMatch(/renumber/i)

    reorder(session, 0, 2)
    expect(session.doc.tiles.map((t) => t.pattern[0])).toEqual([0, 1, 2, 3])
    expect(session.status).toMatch(/renumber/i)
  })
})

describe('bankBudgetLabel', () => {
  it('reports overrides, shared and the 256 ceiling for a partial bank', () => {
    const doc = normalizeTiles({ mode: 'sc2', count: 1, bankTiles: [[mark(1)], [], []], sharedTiles: 0 })
    expect(bankBudgetLabel(doc, 0)).toBe('bank 1: 1 + 0 shared = 1 / 256')
    expect(bankBudgetLabel(doc, 1)).toBe('bank 2: 0 + 0 shared = 0 / 256')
    expect(bankBudgetLabel(doc, 2)).toBe('bank 3: 0 + 0 shared = 0 / 256')
  })
})

describe('setBank', () => {
  it('clamps to a valid bank index', async () => {
    files[PATH] = serializeResource({
      kind: 'tiles',
      doc: normalizeTiles({ mode: 'sc2', count: 1, bankTiles: [[mark(1)], [], []] })
    })
    const session = tileSession(PATH)
    await settled()

    setBank(session, 5)
    expect(session.bank).toBe(2)
    setBank(session, -1)
    expect(session.bank).toBe(0)
    setBank(session, Number.NaN)
    expect(session.bank).toBe(0)
  })
})

describe('a tileset replaced elsewhere', () => {
  it('a promotion to banked starts the history over: no snapshot from before it can be pushed back', async () => {
    // The map editor's promotion hands the store a whole new document, not
    // this one plus some tiles. Adopting it as an undoable step would let one
    // undo push the unbanked snapshot back under a bank-relative map.
    const session = tileSession(PATH)
    await settled()
    setColor(session, 9)
    beginStroke(session)
    paint(session, [{ x: 0, y: 0 }], 'fg')
    endStroke(session, 'paint')
    expect(canUndo(session.history)).toBe(true)

    const banked = normalizeTiles({ mode: 'sc2', count: 1, bankTiles: [[mark(1)], [mark(2)], [mark(3)]] })
    useTilesetStore().set(PATH, banked, 'res/level.map.json')

    expect(canUndo(session.history)).toBe(false)
    expect(session.status).toContain('undo')
    undo(session)
    expect(useTilesetStore().patternDoc(PATH)).toBe(banked)
    expect(session.doc).toBe(banked)
  })

  it('an ordinary change elsewhere is still one undoable step', async () => {
    const session = tileSession(PATH)
    await settled()
    const before = session.doc

    const grown = normalizeTiles({ ...before, count: 9, tiles: [...before.tiles, mark(9)] })
    useTilesetStore().set(PATH, grown, 'res/level.map.json')

    expect(session.doc).toBe(grown)
    expect(canUndo(session.history)).toBe(true)
    undo(session)
    expect(session.doc).toBe(before)
  })
})
