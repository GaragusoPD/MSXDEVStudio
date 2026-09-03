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
import { bankCapacityLeft, colorByteAt, mergeColorByte, normalizeTiles, splitColorByte } from '../../../../shared/msx/tile'
import { useTilesetStore } from '../../stores/tilesetStore'
import {
  beginStroke,
  doc,
  endStroke,
  metaSession,
  paint,
  pruneMetaSessions,
  reclaimOrphans,
  reserveTile0,
  saveSession,
  setColor,
  tiles,
  undo
} from './session'

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
    // reserveTile0() asks before a migration; every test here says yes.
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

describe('a drag is one edit, not one per sample', () => {
  /** The reported failure: intermediate tiles piling up while drawing. */
  it('mints tiles for the final shape only, however many samples the drag has', async () => {
    const session = metaSession(META)
    await settled()
    await settled()
    const before = useTilesetStore().patternDoc(TILES)!.count

    // Forty samples across one row, as a real pointer drag produces.
    beginStroke(session, 'fg')
    for (let x = 0; x < 8; x++) {
      for (let sample = 0; sample < 5; sample++) paint(session, [{ x, y: 0 }], 'fg')
    }
    // Nothing has reached the bank yet — the canvas is drawing a preview.
    expect(useTilesetStore().patternDoc(TILES)!.count).toBe(before)
    endStroke(session)

    // One cell changed, so one tile. Not forty.
    expect(useTilesetStore().patternDoc(TILES)!.count).toBe(before + 1)
  })

  it('is one undo step, so undo takes back the whole drag', async () => {
    const session = metaSession(META)
    await settled()
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
    await settled()
    const before = useTilesetStore().patternDoc(TILES)!.count

    // Draw, redraw, redraw — each stroke supersedes the last, so two of the
    // three tiles end up referenced by nothing.
    for (const colour of [15, 4, 6]) {
      setColor(session, colour)
      paint(session, [{ x: 0, y: 0 }], 'fg')
    }
    expect(useTilesetStore().patternDoc(TILES)!.count).toBe(before + 3)

    await saveSession(session)
    expect(useTilesetStore().patternDoc(TILES)!.count).toBe(before + 1)
    expect(session.status).toMatch(/reclaimed 2 unused tiles/i)
    // The surviving tile is still the one the meta points at.
    expect(frameTileAt(doc(session), 0, 0, 0)).not.toBe(0)
  })
})

describe('reserving tile 0 on a tileset that already holds art', () => {
  it('refuses a full bank rather than dropping the last tile', async () => {
    // `demo_msx1/res/intro.tiles.json` really is 256 tiles. Shifting one in
    // means one falls off the end, and two live indices collapse onto one.
    files[TILES] = serializeResource({
      kind: 'tiles',
      doc: normalizeTiles({ mode: 'sc2', count: 256, reserveTile0: false })
    })
    const session = metaSession(META)
    await settled()
    await settled()
    const before = useTilesetStore().patternDoc(TILES)!

    reserveTile0(session)

    const after = useTilesetStore().patternDoc(TILES)!
    expect(after).toBe(before)
    expect(after.reserveTile0).toBe(false)
    expect(session.status).toMatch(/full/i)
  })

  it('refuses on a tileset with shared meta-tile slots, deliberately rather than by accident', async () => {
    // The shift below moves every index up by one, and the shared region has
    // nowhere to go — it already sits at the top of the hardware's own
    // 256-tile space. The old guard (`tiles.length >= MAX_TILES`) happened to
    // catch this too, but for the wrong reason: once any shared tile has ever
    // existed, `.length` reaches 256 regardless of how empty `count` still
    // is, so it would also wrongly refuse a mostly-empty banked tileset with
    // no shared tile in play at all — this test is on the boundary that tells
    // the two apart.
    files[TILES] = serializeResource({
      kind: 'tiles',
      doc: normalizeTiles({
        mode: 'sc2',
        count: 4,
        reserveTile0: false,
        // A bank override, so `sharedTiles` is genuinely banked rather than
        // clamped away as incoherent state (see `normalizeTiles`).
        bankTiles: [[{ pattern: new Array(8).fill(1), color: new Array(8).fill(0xf1) }], [], []],
        sharedTiles: 1
      })
    })
    const session = metaSession(META)
    await settled()
    await settled()
    const before = useTilesetStore().patternDoc(TILES)!

    reserveTile0(session)

    const after = useTilesetStore().patternDoc(TILES)!
    expect(after).toBe(before)
    expect(after.reserveTile0).toBe(false)
    expect(session.status).toMatch(/shared/i)
  })

  it('refuses on a banked tileset with no shared tiles yet — the boundary the check above does not catch', async () => {
    // A bank override with `sharedTiles: 0` is genuinely banked (`isBanked`)
    // but has none of the shared-region art the previous test's guard exists
    // for, so that guard lets it through. The shift here builds its own
    // `i => i + 1` mapping and publishes it directly, without ever going
    // through `reorderTiles`/`removeTile` — so it needs its own `isBanked`
    // refusal, and until Task 9 it had none.
    files[TILES] = serializeResource({
      kind: 'tiles',
      doc: normalizeTiles({
        mode: 'sc2',
        count: 4,
        reserveTile0: false,
        bankTiles: [[{ pattern: new Array(8).fill(1), color: new Array(8).fill(0xf1) }], [], []],
        sharedTiles: 0
      })
    })
    const session = metaSession(META)
    await settled()
    await settled()
    const before = useTilesetStore().patternDoc(TILES)!

    reserveTile0(session)

    const after = useTilesetStore().patternDoc(TILES)!
    expect(after).toBe(before)
    expect(after.reserveTile0).toBe(false)
    expect(session.status).toMatch(/banked/i)
    // No reorder event went out — nothing shifted, so nothing should replay.
    expect(useTilesetStore().reorderLog(TILES)).toEqual([])
  })

  it('blanks the new tile 0 and moves the art to tile 1', async () => {
    // Tile 0 as real, load-bearing art is the case this whole flag exists for:
    // `demo_msx1/res/tiles.tiles.json` draws its tile 0 274 times.
    files[TILES] = serializeResource({
      kind: 'tiles',
      doc: normalizeTiles({
        mode: 'sc2',
        count: 4,
        reserveTile0: false,
        tiles: [{ pattern: new Array(8).fill(0xff) }]
      })
    })
    const session = metaSession(META)
    await settled()
    await settled()

    reserveTile0(session)

    const shifted = useTilesetStore().patternDoc(TILES)!
    expect(shifted.reserveTile0).toBe(true)
    expect(shifted.count).toBe(5)
    // A cell holding 0 is a skipped write, so index 0 must not hold art.
    expect(shifted.tiles[0].pattern).toEqual(new Array(8).fill(0))
    expect(shifted.tiles[0].color).toEqual(new Array(8).fill(0))
    // Nothing is destroyed: the old artwork is one slot along.
    expect(shifted.tiles[1].pattern).toEqual(new Array(8).fill(0xff))
    expect(shifted.tiles.length).toBe(5)
  })

  it('flags the group-boundary tile lossy in sc1, and says so in the status', async () => {
    // sc1 shares one color pair across 8 tiles: 16 tiles in two groups with
    // different pairs (A, B) become 17 after the shift, and the tile that used
    // to be the last of group A now sits at the front of the shifted group B —
    // rendered with B, not the A it was authored with.
    const A = mergeColorByte(1, 2)
    const B = mergeColorByte(3, 4)
    files[TILES] = serializeResource({
      kind: 'tiles',
      doc: normalizeTiles({ mode: 'sc1', count: 16, reserveTile0: false, groupColors: [A, B] })
    })
    const session = metaSession(META)
    await settled()
    await settled()

    reserveTile0(session)

    const shifted = useTilesetStore().patternDoc(TILES)!
    expect(shifted.count).toBe(17)
    // A third group appears for the 17th tile; it has no sibling to disagree
    // with, so it repeats group 1's pair rather than losing anything.
    expect(shifted.groupColors).toEqual([A, B, B])
    expect(session.status).toMatch(/lost the color pair/)
  })
})

describe('a refused stroke is announced where the user is looking', () => {
  it('sets `blocked` when the bank has no room, and clears it once one does', async () => {
    // A full bank refuses every stroke. This went to `status` only, which the
    // toolbar renders ellipsised at 11px and 0.8 opacity — so the message was
    // invisible and the pencil simply looked broken.
    files[TILES] = serializeResource({
      kind: 'tiles',
      doc: normalizeTiles({ mode: 'sc2', count: 256, reserveTile0: false })
    })
    const session = metaSession(META)
    await settled()
    await settled()

    paint(session, [{ x: 0, y: 0 }])
    expect(session.blocked).toMatch(/full/i)
    expect(frameTileAt(doc(session), 0, 0, 0)).toBe(0)

    // Room again: the banner must go away rather than linger over a working
    // canvas, which would be its own kind of lie.
    useTilesetStore().set(TILES, normalizeTiles({ mode: 'sc2', count: 4 }), 'test')
    paint(session, [{ x: 1, y: 1 }])
    expect(session.blocked).toBeNull()
  })
})

describe('undo on a banked tileset tracks shared tiles for Compact', () => {
  it('Compact reclaims shared tiles and does not drop common tiles', async () => {
    // A banked tileset allocates shared tiles from the top (255 down), and they
    // do not increment `count`. The endStroke now tracks them via the paint
    // result's `added` array. But removeTile did not understand shared tiles,
    // so Compact would drop an unrelated common tile and leave sharedTiles
    // unchanged — silently corrupting the tileset. The fix teaches removeTile
    // to handle shared tiles: only the newest one can be removed, and it
    // decrements sharedTiles rather than count.
    const banked = normalizeTiles({
      mode: 'sc2',
      count: 4,
      reserveTile0: true,
      bankTiles: [[{ pattern: Array(8).fill(0), color: Array(8).fill(0x21) }], [], []]
    })
    files[TILES] = serializeResource({ kind: 'tiles', doc: banked })
    const session = metaSession(META)
    await settled()
    await settled()

    paint(session, [{ x: 0, y: 0 }])
    expect(session.appended).toEqual([255])
    const afterPaint = useTilesetStore().patternDoc(TILES)!
    expect(afterPaint.count).toBe(4)
    expect(afterPaint.sharedTiles).toBe(1)

    undo(session)
    expect(session.appended).toEqual([255])

    // Compact should find tile 255 as an orphan and reclaim it.
    const reclaimed = reclaimOrphans(session)
    expect(reclaimed).toBe(1)

    const afterCompact = useTilesetStore().patternDoc(TILES)!
    // The shared tile was reclaimed: sharedTiles goes back to 0.
    expect(afterCompact.sharedTiles).toBe(0)
    // Crucially, the common tiles are untouched: count stays 4, no artwork lost.
    expect(afterCompact.count).toBe(4)
    // session.appended is cleared by publishReclaim.
    expect(session.appended).toEqual([])
  })

  it('reclaims multiple shared orphans in the correct order (newest first)', async () => {
    // The critical bug: reclaimOrphans sorted all orphans descending, which is
    // correct for common tiles (highest index = newest) but inverted for shared
    // tiles (lowest index = newest, since they grow downward). Painting two
    // cells, undoing both, then compacting would silently leak one tile.
    const banked = normalizeTiles({
      mode: 'sc2',
      count: 4,
      reserveTile0: true,
      bankTiles: [[{ pattern: Array(8).fill(0), color: Array(8).fill(0x21) }], [], []]
    })
    files[TILES] = serializeResource({ kind: 'tiles', doc: banked })
    const session = metaSession(META)
    await settled()
    await settled()

    // Paint two distinct cells with different patterns to create two shared tiles.
    paint(session, [{ x: 0, y: 0 }])
    expect(session.appended).toEqual([255])
    paint(session, [{ x: 8, y: 1 }], 'fg')
    // Second paint creates a different tile, so appended grows.
    expect(session.appended).toEqual([255, 254])

    const afterPaint = useTilesetStore().patternDoc(TILES)!
    expect(afterPaint.sharedTiles).toBe(2)
    const bank0Capacity = bankCapacityLeft(afterPaint, 0)
    const bank1Capacity = bankCapacityLeft(afterPaint, 1)
    const bank2Capacity = bankCapacityLeft(afterPaint, 2)

    // Undo both strokes.
    undo(session)
    undo(session)
    expect(session.appended).toEqual([255, 254])

    // Compact: the old bug would try to remove 255 first (wrong order for shared),
    // removeTile would refuse (not the newest), and then remove only 254, leaving
    // 255 leaked. The fix removes newest-first: 254 then 255.
    const reclaimed = reclaimOrphans(session)
    expect(reclaimed).toBe(2)

    const afterCompact = useTilesetStore().patternDoc(TILES)!
    expect(afterCompact.sharedTiles).toBe(0)
    expect(afterCompact.count).toBe(4)
    // Bank capacity fully restored.
    expect(bankCapacityLeft(afterCompact, 0)).toBe(bank0Capacity + 2)
    expect(bankCapacityLeft(afterCompact, 1)).toBe(bank1Capacity + 2)
    expect(bankCapacityLeft(afterCompact, 2)).toBe(bank2Capacity + 2)
    expect(session.appended).toEqual([])
  })

  it('reclaims the shared orphan on a banked tileset and leaves the common one alone, without touching a live shared tile that belongs to no reclaim', async () => {
    // The shape neither round 1-3's fixes nor their tests exercised: a single
    // session with an orphan on *each* side of the sparse array — plus a
    // shared tile this session never created and never orphaned, standing in
    // for a meta in some other, unrelated session. The round-3 review found
    // `removeTile`'s common branch would compact that survivor into the gap
    // its own removal opened and lose it, even though this reclaim never
    // asked to touch it.
    //
    // Task 9 changed what "both regions" means here: a banked tileset's
    // common range never renumbers (see `shared/msx/tile.ts`'s `removeTile`),
    // so this reclaim now removes the shared orphan (254) and refuses the
    // common one (4) — the common tile is a genuine, permanent leak once the
    // tileset is banked, which is the documented cost of the rule (no tidying
    // the common tail on a banked tileset).
    files[TILES] = tilesFile(true) // unbanked: count 4, reserveTile0

    const session = metaSession(META)
    await settled()
    await settled()

    // First stroke, while still unbanked: mints an ordinary common tile.
    paint(session, [{ x: 0, y: 0 }])
    expect(session.appended).toEqual([4])
    undo(session) // orphaned, but the tile itself is left behind (append-only)

    // Now the tileset gets banked out from under this session — exactly what
    // a second editor tab (or a later banking pass) can do — and already
    // carries one *live* shared tile at 255 that belongs to no session here.
    const live = { pattern: new Array(8).fill(0x99), color: new Array(8).fill(0xf1) }
    const beforeBanking = useTilesetStore().patternDoc(TILES)!
    const rawTiles: unknown[] = beforeBanking.tiles.slice()
    rawTiles[255] = live
    useTilesetStore().set(
      TILES,
      normalizeTiles({
        ...beforeBanking,
        tiles: rawTiles,
        bankTiles: [[{ pattern: Array(8).fill(0), color: Array(8).fill(0x21) }], [], []],
        sharedTiles: 1
      }),
      'test'
    )

    // Second stroke, now banked: a different local pixel so it cannot dedup
    // against tile 4's pattern, mints a shared tile at 254 (255 is taken).
    paint(session, [{ x: 9, y: 9 }])
    expect(session.appended).toEqual([4, 254])
    undo(session) // orphaned too, same append-only leave-behind

    // Both of this session's tiles — one common, one shared — are now orphans,
    // and neither the pre-existing common tiles nor the other session's
    // shared tile at 255 are referenced by `appended` at all.
    const reclaimed = reclaimOrphans(session)
    // Only the shared orphan (254) comes back: `removeTile` now refuses the
    // common orphan (4) outright because the tileset is banked.
    expect(reclaimed).toBe(1)

    const after = useTilesetStore().patternDoc(TILES)!
    // The common orphan is NOT removed on a banked tileset — count stays at 5
    // (the pre-existing 4 plus this session's now-permanently-leaked tile 4).
    expect(after.count).toBe(5)
    expect(after.sharedTiles).toBe(1) // only this session's shared orphan left; the other survives
    // The live shared tile: same position, same bytes — never compacted,
    // never renumbered, never blanked by anything that ran in the same reclaim.
    expect(after.tiles[255]).toEqual(live)
    expect(session.appended).toEqual([])
  })
})
