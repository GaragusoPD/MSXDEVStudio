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
import { createBitmapTilesDoc } from '../../../../shared/msx/bitmap-tile'
import { createMetaTileDoc } from '../../../../shared/msx/meta-tile'
import { defaultExport, serializeResource } from '../../../../shared/msx/resource'
import {
  blankTileEntry,
  isBanked,
  MAX_TILES,
  normalizeTiles,
  TILE_SIZE,
  type TileEntry
} from '../../../../shared/msx/tile'
import { normalizeMap, SCREEN_ROWS } from '../../../../shared/msx/map'
import { singleStamp } from '../../../../shared/map-editor'
import { emitTilesReordered } from '../../../../shared/tile-editor'
import {
  addLayer,
  bankSheetOffset,
  beginPaint,
  canPaint,
  canPromoteToBanked,
  canUndo,
  commit,
  declinePromotion,
  doc,
  endPaint,
  extendPaint,
  finishDrag,
  mapSession,
  metaRowOffsets,
  paintBankOf,
  paintBudgetLabel,
  paintDotSize,
  paintDrag,
  paintPointAt,
  paintPreviewPoints,
  pickerBankOffset,
  pickMeta,
  pickTile,
  placeMetaAt,
  promoteToBanked,
  PROMOTION_PROMPT,
  promotionBlocker,
  pruneMapSessions,
  redo,
  reloadTileset,
  renderMapPixels,
  resize,
  saveSession,
  selectPlacementAt,
  setBaked,
  setMode,
  setPaintColor,
  setPaintTool,
  setPaintWrite,
  setTileset,
  undo,
  type MapSession
} from './session'
// The tile editor's session, for the two-tabs cases: the map rewrites or
// replaces a tileset the tile tab holds an undo history over.
import { pruneTileSessions, tileSession, undo as undoTile } from '../tile/session'
import { useResourcesStore } from '../../stores/resourcesStore'
import { useTilesetStore } from '../../stores/tilesetStore'
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
    // The reorder-replay confirm. Accepted: what these tests check is whether
    // the replay is offered from the right log, not what declining does.
    confirm: vi.fn(() => true),
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
  // Tile sessions are module-level too, and a survivor from an earlier test
  // would be listening on that test's pinia, not this one's.
  pruneTileSessions(new Set())
})

async function openMap(): Promise<ReturnType<typeof mapSession>> {
  const session = mapSession(MAP)
  for (let i = 0; i < 4; i++) await settled()
  return session
}

describe('the map shares its tileset with the store', () => {
  it('adopts a tileset change made by another editor', async () => {
    const session = await openMap()
    const store = useTilesetStore()
    const before = session.tileset!

    const grown = normalizeTiles({ mode: 'sc2', count: 5 })
    store.set(TILES, grown, 'some/other/editor.tiles.json')

    expect(session.tileset).not.toBe(before)
    expect(session.tileset!.count).toBe(5)
  })

  it('does not treat merely opening the map as an edit to the tileset', async () => {
    await openMap()
    // Loading a tileset that already matches disk must not dirty it — a spare
    // `set()` on load would mark every tileset a map merely opens as having
    // unsaved changes, badging tabs that were never touched.
    expect(useTilesetStore().isDirty(TILES)).toBe(false)
  })

  it('saves the tileset alongside the map when the tileset is dirty', async () => {
    const session = await openMap()
    const store = useTilesetStore()
    store.set(TILES, normalizeTiles({ mode: 'sc2', count: 5 }), session.path)

    await saveSession(session)

    expect(JSON.parse(files[TILES]).count).toBe(5)
  })
})

describe('reorders the map missed while it was closed', () => {
  it("replays the store's live log, not the file's — an unsaved reorder in a tile tab reaches a map opened afterwards", async () => {
    // Cells 0-2 hold tiles 1, 2, 3, so a renumbering shows.
    const data = new Array(64).fill(0)
    data[0] = 1
    data[1] = 2
    data[2] = 3
    files[MAP] = JSON.stringify({ version: 1, tileset: TILES, width: 8, height: 8, layers: [{ name: 'background', data }] })

    // The tileset is open in a tile tab, which moves tile 1 after tile 2 and
    // has not saved: the document and the log are in the store, the file on
    // disk still has neither. `session.tileset` is the store's document, so
    // the map's cells must follow the store's log — read against the file's,
    // cell 0 keeps pointing at index 1, which is now a different tile.
    const store = useTilesetStore()
    await store.load(TILES)
    const live = store.patternDoc(TILES)!
    const tiles = live.tiles.slice()
    ;[tiles[1], tiles[2]] = [tiles[2], tiles[1]]
    store.set(TILES, { ...live, tiles }, TILES)
    const mapping = [0, 2, 1, 3]
    const at = Date.now()
    store.appendReorder(TILES, { path: TILES, mapping, at })

    const session = await openMap()

    const layer = doc(session).layers[0].data
    expect(layer.slice(0, 3)).toEqual([2, 1, 3])
    expect(session.tilesetReorderSeen).toBe(at)
  })
})

describe('a live reorder reaches an open map', () => {
  /** Four tiles with art that says which one it is: 0x11, 0x22, 0x33, 0x44. */
  const art = (i: number): TileEntry => ({ pattern: new Array(8).fill(0x11 * (i + 1)), color: new Array(8).fill(0xf1) })
  /** A rotation, so applying it twice gives a different answer from applying it once. */
  const mapping = [1, 2, 3, 0]

  /** The tileset after `mapping`: `tiles[new] = old tiles[old]`, as the tile editor's `reorderTiles` builds it. */
  function renumbered(original: ReturnType<typeof normalizeTiles>) {
    const tiles = original.tiles.slice()
    original.tiles.forEach((tile, i) => {
      tiles[mapping[i]] = tile
    })
    return { ...original, tiles }
  }

  beforeEach(() => {
    files[TILES] = serializeResource({
      kind: 'tiles',
      doc: normalizeTiles({ mode: 'sc2', count: 4, tiles: [art(0), art(1), art(2), art(3)] })
    })
    const data = new Array(64).fill(0)
    data[0] = 1
    data[1] = 2
    data[2] = 3
    files[MAP] = JSON.stringify({ version: 1, tileset: TILES, width: 8, height: 8, layers: [{ name: 'background', data }] })
  })

  it("the meta editor's ordering — the store first, then the event — renumbers the cells once and the art not at all", async () => {
    // `session.tileset` is the store's document. The meta editor publishes the
    // renumbered tileset *before* it emits, so by the time the map's handler
    // runs the map has already adopted it. A second, local remap on top of that
    // is what sent tile 3's art into slot 1.
    const session = await openMap()
    const store = useTilesetStore()
    const next = renumbered(store.patternDoc(TILES)!)
    store.set(TILES, next, 'res/some.meta-tiles.json')
    const at = Date.now()
    store.appendReorder(TILES, { path: TILES, mapping, at })

    emitTilesReordered({ path: TILES, mapping, at })

    // Slot 1 holds what was tile 0. Applied twice, it holds what was tile 3.
    expect(session.tileset!.tiles[1].pattern[0]).toBe(0x11)
    expect(session.tileset!.tiles.map((tile) => tile.pattern[0])).toEqual([0x44, 0x11, 0x22, 0x33])
    expect(session.tileset).toBe(store.patternDoc(TILES))
    expect(doc(session).layers[0].data.slice(0, 3)).toEqual([2, 3, 0])
    expect(session.tilesetReorderSeen).toBe(at)
  })

  it("the tile editor's ordering — the event first, then the store — ends in the same place", async () => {
    const session = await openMap()
    const store = useTilesetStore()
    const next = renumbered(store.patternDoc(TILES)!)
    const at = Date.now()
    store.appendReorder(TILES, { path: TILES, mapping, at })

    emitTilesReordered({ path: TILES, mapping, at })
    store.set(TILES, next, TILES)

    expect(session.tileset).toBe(store.patternDoc(TILES))
    expect(session.tileset!.tiles.map((tile) => tile.pattern[0])).toEqual([0x44, 0x11, 0x22, 0x33])
    expect(doc(session).layers[0].data.slice(0, 3)).toEqual([2, 3, 0])
    expect(session.tilesetReorderSeen).toBe(at)
  })
})

describe('what the map holds in the tileset store', () => {
  const TILES2 = 'res/other.tiles.json'
  const BTILES = 'res/world.btiles.json'

  beforeEach(() => {
    files[TILES2] = serializeResource({ kind: 'tiles', doc: normalizeTiles({ mode: 'sc2', count: 3 }) })
    files[BTILES] = serializeResource({ kind: 'btiles', doc: createBitmapTilesDoc() })
  })

  it('reloading the tileset does not take a second hold — closing the tab still lets the document go', async () => {
    const session = await openMap()
    await reloadTileset(session)
    expect(session.tileset).toBe(useTilesetStore().patternDoc(TILES))

    pruneMapSessions(new Set())

    // The map was the only holder and the document is clean, so it is gone.
    expect(useTilesetStore().patternDoc(TILES)).toBeNull()
  })

  it('switching tilesets gives up the old one and holds the new one', async () => {
    const session = await openMap()
    const store = useTilesetStore()

    await setTileset(session, TILES2)

    expect(store.patternDoc(TILES)).toBeNull()
    expect(store.patternDoc(TILES2)).not.toBeNull()
    expect(session.tileset).toBe(store.patternDoc(TILES2))

    pruneMapSessions(new Set())
    expect(store.patternDoc(TILES2)).toBeNull()
  })

  it('closing a map over a .btiles.json it never loaded leaves the document to the editor that did', async () => {
    // A bitmap-tiles tab (or a bitmap meta) is the one holder. The map points
    // at the same file, but its `.btiles.json` branch parses the file itself
    // and never asks the store for it — so it has nothing to give back.
    const store = useTilesetStore()
    await store.load(BTILES)
    const session = await openMap()
    await setTileset(session, BTILES)
    expect(store.patternDoc(TILES)).toBeNull()

    pruneMapSessions(new Set())

    expect(store.bitmapDoc(BTILES)).not.toBeNull()
  })
})

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

describe('bankSheetOffset — which row reads which pattern bank', () => {
  const solid = () => ({ pattern: new Array(8).fill(0xaa), color: new Array(8).fill(0xf1) })
  // Any bank carrying its own art at all is enough to make the tileset
  // "banked" (see `isBanked`) — the fixture only needs one override.
  const bankedTileset = normalizeTiles({ mode: 'sc2', count: 1, bankTiles: [[solid()], [], []] })
  const unbankedTileset = normalizeTiles({ mode: 'sc2', count: 1 })

  it('returns 0/256/512 for rows 0/8/16 on a banked tileset — a whole band, not just the boundary row', () => {
    const session = { tileset: bankedTileset } as MapSession
    expect(bankSheetOffset(session, 0)).toBe(0)
    expect(bankSheetOffset(session, 7)).toBe(0)
    expect(bankSheetOffset(session, 8)).toBe(256)
    expect(bankSheetOffset(session, 15)).toBe(256)
    expect(bankSheetOffset(session, 16)).toBe(512)
    expect(bankSheetOffset(session, 23)).toBe(512)
  })

  it('wraps every screen (24 rows) back onto banks 0-2, rather than reading off the end of the stacked sheet', () => {
    // `validateMap` refuses to export a banked map that isn't exactly
    // `SCREEN_ROWS` tall, but nothing stops the editor from showing a taller
    // one mid-edit (`resize()`), so row 24 and up must still resolve to a
    // real cell of the 768-cell sheet rather than one past its end.
    const session = { tileset: bankedTileset } as MapSession
    expect(bankSheetOffset(session, 24)).toBe(0)
    expect(bankSheetOffset(session, 31)).toBe(0)
    expect(bankSheetOffset(session, 32)).toBe(256)
  })

  it('is 0 for every row on an unbanked tileset — a byte is already the sheet index', () => {
    const session = { tileset: unbankedTileset } as MapSession
    for (const row of [0, 7, 8, 15, 16, 23]) expect(bankSheetOffset(session, row)).toBe(0)
  })

  it('is 0 with no tileset loaded at all', () => {
    const session = { tileset: null } as MapSession
    expect(bankSheetOffset(session, 8)).toBe(0)
  })
})

describe('pickerBankOffset — which bank the picker paints from', () => {
  const solid = () => ({ pattern: new Array(8).fill(0xaa), color: new Array(8).fill(0xf1) })
  const bankedTileset = normalizeTiles({ mode: 'sc2', count: 1, bankTiles: [[solid()], [], []] })
  const unbankedTileset = normalizeTiles({ mode: 'sc2', count: 1 })

  it('is session.bank * MAX_TILES on a banked tileset', () => {
    const session = { tileset: bankedTileset, bank: 2 } as MapSession
    expect(pickerBankOffset(session)).toBe(512)
  })

  it('is 0 on an unbanked tileset even with a stale non-zero bank left over from a banked one', () => {
    // `bank` is session state, not tileset state — `setTileset`/`reloadTileset`
    // don't reset it, so this is the case that used to offset the picker's
    // draw loop past the end of a small unbanked sheet and draw nothing.
    const session = { tileset: unbankedTileset, bank: 2 } as MapSession
    expect(pickerBankOffset(session)).toBe(0)
  })

  it('is 0 with no tileset loaded at all', () => {
    const session = { tileset: null, bank: 2 } as MapSession
    expect(pickerBankOffset(session)).toBe(0)
  })
})

describe('metaRowOffsets — per-row offsets for a meta thumbnail (Defect B)', () => {
  const solid = () => ({ pattern: new Array(8).fill(0xaa), color: new Array(8).fill(0xf1) })
  // Bank lengths deliberately uneven, and a non-zero shared region — a
  // uniform fixture would not have caught a transposed row/bank arithmetic.
  const bankedTileset = normalizeTiles({
    mode: 'sc2',
    count: 4,
    bankTiles: [[solid(), solid()], [], [solid(), solid(), solid(), solid(), solid()]],
    sharedTiles: 6
  })
  const unbankedTileset = normalizeTiles({ mode: 'sc2', count: 4 })

  it('resolves each row of a meta against the bank that row sits in, not the placement\'s own row', () => {
    // Placed at row 6, height 4: rows 6,7 are still bank 0 (rows 0-7); rows
    // 8,9 have crossed into bank 1 (rows 8-15) — a single offset for the
    // whole thumbnail could not represent both.
    const session = { tileset: bankedTileset, bank: 0 } as MapSession
    expect(metaRowOffsets(session, 6, 4)).toEqual([0, 0, 256, 256])
  })

  it('is 0 for every row on an unbanked tileset', () => {
    const session = { tileset: unbankedTileset, bank: 0 } as MapSession
    expect(metaRowOffsets(session, 6, 4)).toEqual([0, 0, 0, 0])
  })

  it('wraps every screen (24 rows), matching bankSheetOffset', () => {
    const session = { tileset: bankedTileset, bank: 0 } as MapSession
    // Row 22-25 crosses back over the SCREEN_ROWS wrap into bank 0 again.
    expect(metaRowOffsets(session, 22, 4)).toEqual([512, 512, 0, 0])
  })

  it('falls back to the picker\'s own bank when there is no placement to anchor to', () => {
    const session = { tileset: bankedTileset, bank: 2 } as MapSession
    expect(metaRowOffsets(session, null, 3)).toEqual([512, 512, 512])
  })

  it('is 0 for the picker fallback too when the tileset is unbanked', () => {
    const session = { tileset: unbankedTileset, bank: 2 } as MapSession
    expect(metaRowOffsets(session, null, 3)).toEqual([0, 0, 0])
  })
})

describe('paint mode', () => {
  /** A tile that is all foreground except row 7, which carries `n` so tiles stay distinct. */
  const distinct = (n: number): TileEntry => ({
    pattern: [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, n & 0xff],
    color: new Array(8).fill(0xf1)
  })
  const solid = (): TileEntry => distinct(0xff)
  const blank = (): TileEntry => ({ pattern: new Array(8).fill(0), color: new Array(8).fill(0xf1) })

  /** Uneven bank lengths and a non-zero shared region: a uniform fixture cannot catch transposed arithmetic. */
  function bankedFixture() {
    return normalizeTiles({
      mode: 'sc2',
      count: 4,
      bankTiles: [[solid(), solid()], [], [solid(), solid(), solid(), solid(), solid()]],
      sharedTiles: 6
    })
  }

  /**
   * Bank 0 has no slot left below the shared region (250 overrides + 6 shared
   * = 256). That only refuses a stroke whose result is not already there — a
   * found tile succeeds on a full bank — and every override is white on rows
   * 0-6, so a stroke there at colour 15 is a found no-op while any other
   * colour recolours the row and needs a slot. The other two banks have room.
   */
  function fullBankedFixture() {
    const full = Array.from({ length: MAX_TILES - 6 }, (_, i) => distinct(i))
    return normalizeTiles({
      mode: 'sc2',
      count: 4,
      bankTiles: [full, [solid()], [solid(), solid(), solid()]],
      sharedTiles: 6
    })
  }

  const cell = (session: MapSession, x: number, y: number): number =>
    doc(session).layers[session.activeLayer].data[y * doc(session).width + x]

  /** One click: begin, one segment, release. */
  function dab(session: MapSession, x: number, y: number, role: 'fg' | 'bg' = 'fg'): void {
    beginPaint(session, role)
    extendPaint(session, { x, y }, { x, y })
    endPaint(session)
  }

  it('starts in tiles mode, so an existing map behaves exactly as before', async () => {
    expect((await openMap()).mode).toBe('tiles')
  })

  it('paints into the cell the pixel falls in, using the grid width as stride', async () => {
    const session = await openMap()          // 8x8 map
    setMode(session, 'paint')
    beginPaint(session, 'fg')
    // Pixel (0, 8) is cell (0, 1) — data index 8 on an 8-wide map.
    extendPaint(session, { x: 0, y: 8 }, { x: 0, y: 8 })
    endPaint(session)

    const layer = doc(session).layers[session.activeLayer]
    expect(layer.data[8]).not.toBe(0)
    expect(layer.data[0]).toBe(0)
  })

  it('a drag is one undo step, not one per sample', async () => {
    const session = await openMap()
    setMode(session, 'paint')
    const before = session.history.past.length

    beginPaint(session, 'fg')
    extendPaint(session, { x: 0, y: 0 }, { x: 1, y: 0 })
    extendPaint(session, { x: 1, y: 0 }, { x: 2, y: 0 })
    extendPaint(session, { x: 2, y: 0 }, { x: 3, y: 0 })
    endPaint(session)

    expect(session.history.past.length).toBe(before + 1)
  })

  it('paintBankOf is null unbanked and wraps by SCREEN_ROWS when banked', async () => {
    const session = await openMap()
    expect(paintBankOf(session)).toBeNull()

    useTilesetStore().set(TILES, bankedFixture(), 'x')
    const bankOf = paintBankOf(session)!
    expect(bankOf(0)).toBe(0)
    expect(bankOf(9)).toBe(1)
    expect(bankOf(17)).toBe(2)
    expect(bankOf(25)).toBe(0)   // taller-than-a-screen map, still editable
  })

  it('a refused stroke changes nothing and names the bank', async () => {
    const session = await openMap()
    useTilesetStore().set(TILES, fullBankedFixture(), 'x')
    setMode(session, 'paint')
    const before = doc(session)
    const steps = session.history.past.length
    const tileset = session.tileset

    // Pinned, not the default: at 15 this stroke would be a found no-op (see
    // the fixture), and the test would pass without ever reaching a refusal.
    setPaintColor(session, 1)
    beginPaint(session, 'fg')
    extendPaint(session, { x: 0, y: 0 }, { x: 0, y: 0 })
    endPaint(session)

    expect(doc(session)).toBe(before)
    // 1-based, as `bankBudgetLabel` is — the two sit side by side in the sidebar.
    expect(session.status).toContain('Bank 1 is full')
    // Nothing pushed, nothing published: a refusal is not an edit.
    expect(session.history.past.length).toBe(steps)
    expect(useTilesetStore().patternDoc(TILES)).toBe(tileset)
  })

  it('the first stroke on a fresh tileset is visible: the default colour is not the background', async () => {
    const session = await openMap()
    setMode(session, 'paint')
    dab(session, 0, 0)

    // A fresh tileset decodes as fg 15 on bg 1. Colour 1 would land the dot
    // and change nothing on screen — while still minting a tile.
    const { indices } = renderMapPixels(doc(session), session.tileset!, 0)
    expect(indices[0]).not.toBe(indices[1])
    expect(indices[0]).toBe(15)
  })

  it('a second stroke builds on the first: the session draws the tileset the stroke produced', async () => {
    const session = await openMap()
    setMode(session, 'paint')
    dab(session, 0, 0)
    dab(session, 1, 0)

    // The store skips the writer's own listener, so the session has to adopt
    // its own result — otherwise stroke two resolves against a tileset that
    // never saw stroke one, and overwrites it.
    expect(session.tileset).toBe(useTilesetStore().patternDoc(TILES))
    const tile = cell(session, 0, 0)
    expect(tile).not.toBe(0)
    expect(session.tileset!.tiles[tile].pattern[0]).toBe(0xc0)
  })

  it('an idle repaint — the same colour over the same pixel — pushes no undo step', async () => {
    const session = await openMap()
    setMode(session, 'paint')
    dab(session, 0, 0)
    const steps = session.history.past.length
    const tiles = session.tileset

    dab(session, 0, 0)

    expect(session.history.past.length).toBe(steps)
    expect(session.tileset).toBe(tiles)
  })

  it('fill floods the whole picture, not the 8x8 cell fillPoints defaults to', async () => {
    const session = await openMap()
    setMode(session, 'paint')
    setPaintTool(session, 'fill')
    dab(session, 0, 0)

    const layer = doc(session).layers[session.activeLayer]
    expect(layer.data.every((tile) => tile !== 0)).toBe(true)
    // One shape, one tile: sixty-four cells of the same solid.
    expect(new Set(layer.data).size).toBe(1)
  })

  it('a line drag is its final line, not every intermediate one', async () => {
    const session = await openMap()
    setMode(session, 'paint')
    setPaintTool(session, 'line')
    beginPaint(session, 'fg')
    // The pointer swings from a horizontal line into a vertical one before release.
    extendPaint(session, { x: 0, y: 0 }, { x: 15, y: 0 })
    extendPaint(session, { x: 0, y: 0 }, { x: 0, y: 15 })
    endPaint(session)

    expect(cell(session, 0, 1)).not.toBe(0)
    expect(cell(session, 1, 0)).toBe(0)
  })

  it('a pencil drag keeps every segment', async () => {
    const session = await openMap()
    setMode(session, 'paint')
    beginPaint(session, 'fg')
    extendPaint(session, { x: 0, y: 0 }, { x: 15, y: 0 })
    extendPaint(session, { x: 15, y: 0 }, { x: 15, y: 15 })
    endPaint(session)

    expect(cell(session, 0, 0)).not.toBe(0)
    expect(cell(session, 1, 0)).not.toBe(0)
    expect(cell(session, 1, 1)).not.toBe(0)
  })

  it('an edit stroke rewrites the tile in place, and undo/redo swap the art the canvas draws', async () => {
    const session = await openMap()
    setMode(session, 'paint')
    setPaintWrite(session, 'edit')
    dab(session, 0, 0)

    // Nothing minted, nothing repointed: tile 0 itself changed.
    expect(cell(session, 0, 0)).toBe(0)
    expect(session.tileset!.count).toBe(4)
    expect(session.tileset!.tiles[0].pattern[0]).toBe(0x80)

    undo(session)
    expect(session.tileset).toBe(useTilesetStore().patternDoc(TILES))
    expect(session.tileset!.tiles[0].pattern[0]).toBe(0)

    redo(session)
    expect(session.tileset).toBe(useTilesetStore().patternDoc(TILES))
    expect(session.tileset!.tiles[0].pattern[0]).toBe(0x80)
  })

  it('undo of a fork stroke restores the cell', async () => {
    const session = await openMap()
    setMode(session, 'paint')
    dab(session, 0, 0)
    expect(cell(session, 0, 0)).not.toBe(0)
    undo(session)
    expect(cell(session, 0, 0)).toBe(0)
  })

  it('paints a banked screen into the bank that row is drawn in', async () => {
    const session = await openMap()
    useTilesetStore().set(TILES, bankedFixture(), 'x')
    setMode(session, 'paint')
    // 8 wide, 24 tall: exactly one screen, so row 9 is bank 1.
    resize(session, 8, 24)
    dab(session, 0, 9 * TILE_SIZE)

    const tile = cell(session, 0, 9)
    expect(tile).not.toBe(0)
    const tileset = session.tileset!
    expect(tileset.bankTiles[1][tile]).toBeDefined()
    expect(tileset.bankTiles[0][tile]).toBeUndefined()
  })

  it('painting inside a baked meta drops its receipt, as cell painting does', async () => {
    const session = await openMap()
    pickMeta(session, META)
    placeMetaAt(session, 2, 2)
    setBaked(session, true)
    expect(doc(session).layers[0].placements).toHaveLength(1)

    setMode(session, 'paint')
    dab(session, 2 * TILE_SIZE, 2 * TILE_SIZE)

    expect(doc(session).layers[0].placements).toHaveLength(0)
    expect(session.status).toContain('baked')
  })

  describe('renderMapPixels', () => {
    it('reads each row from its own bank, so a fill floods what the screen shows', () => {
      // Common tile 1 is blank; bank 1 overrides it with a solid. Same byte,
      // different art on row 8.
      const tiles = normalizeTiles({
        mode: 'sc2',
        count: 4,
        bankTiles: [[], [blank(), solid()], [solid(), solid(), solid()]],
        sharedTiles: 2
      })
      const data = new Array(9).fill(0)
      data[0] = 1
      data[8] = 1
      const map = normalizeMap({ tileset: TILES, width: 1, height: 9, layers: [{ data }] })

      const { width, height, indices } = renderMapPixels(map, tiles, 0)
      expect(width).toBe(TILE_SIZE)
      expect(height).toBe(9 * TILE_SIZE)
      expect(indices[0]).toBe(1)                     // row 0: common tile 1, background only
      expect(indices[8 * TILE_SIZE * width]).toBe(15) // row 8: bank 1's solid
    })

    it('is all zero for a layer that does not exist', () => {
      const map = normalizeMap({ tileset: TILES, width: 2, height: 2 })
      const { indices } = renderMapPixels(map, normalizeTiles({ mode: 'sc2', count: 1 }), 3)
      expect(indices.length).toBe(4 * TILE_SIZE * TILE_SIZE)
      expect(indices.every((value) => value === 0)).toBe(true)
    })
  })

  it('paintPointAt turns a canvas offset into a dot at the session zoom (pixels per cell)', async () => {
    const session = await openMap()
    session.zoom = 16 // one dot is two canvas pixels
    expect(paintPointAt(session, 5, 17)).toEqual({ x: 2, y: 8 })
    expect(paintPointAt(session, 0, 0)).toEqual({ x: 0, y: 0 })
    // A captured drag can leave the canvas; paintGrid drops what falls outside.
    expect(paintPointAt(session, -1, -3)).toEqual({ x: -1, y: -2 })
  })

  describe('the preview overlay: its numbers live here because the .vue is not under test', () => {
    it('paintDotSize is the inverse of paintPointAt at every zoom the slider offers', async () => {
      const session = await openMap()
      // The slider runs 4..48 in steps of 2, so most zooms give a fractional dot
      // (zoom 12 is 1.5 canvas pixels): the case a rounded size drifts on, and
      // the one a single zoom-16 check can never see.
      for (let zoom = 4; zoom <= 48; zoom += 2) {
        session.zoom = zoom
        const size = paintDotSize(session)
        // Eight dots span exactly one cell, or the preview walks off the grid.
        expect(size * TILE_SIZE).toBe(zoom)
        for (const x of [0, 1, 7, 8, 13, 255]) {
          for (const y of [0, 3, 8, 191]) {
            // A dot's leading edge maps back to it...
            expect(paintPointAt(session, x * size, y * size)).toEqual({ x, y })
            // ...and so does its trailing edge, so the rect drawn for a dot
            // covers exactly the offsets that resolve to it and nothing past.
            expect(paintPointAt(session, (x + 1) * size - 1e-6, (y + 1) * size - 1e-6)).toEqual({ x, y })
          }
        }
      }
    })

    it('paintPreviewPoints is the stroke in progress for the tools a preview helps', async () => {
      const session = await openMap()
      setMode(session, 'paint')
      expect(paintPreviewPoints(session)).toEqual([])
      for (const tool of ['pencil', 'line', 'rect', 'spray'] as const) {
        setPaintTool(session, tool)
        beginPaint(session, 'fg')
        extendPaint(session, { x: 1, y: 1 }, { x: 6, y: 1 })
        expect(session.paintPoints.length).toBeGreaterThan(0)
        expect(paintPreviewPoints(session)).toEqual(session.paintPoints)
        endPaint(session)
        // The real canvas takes over on release; a preview left up would double-draw.
        expect(paintPreviewPoints(session)).toEqual([])
      }
    })

    it('paintPreviewPoints declines a fill: its point set is the flooded region, not a stroke', async () => {
      const session = await openMap()
      setMode(session, 'paint')
      setPaintTool(session, 'fill')
      beginPaint(session, 'fg')
      extendPaint(session, { x: 0, y: 0 }, { x: 0, y: 0 })
      // The flood itself is real — only the preview declines to draw it.
      expect(session.paintPoints.length).toBeGreaterThan(0)
      expect(paintPreviewPoints(session)).toEqual([])
      endPaint(session)
    })

    it('a refused stroke leaves nothing behind for the preview to show', async () => {
      // The preview reads `paintPoints`; if a refusal returned before clearing
      // them, the overlay would keep showing art that was never committed.
      const session = await openMap()
      resize(session, 32, SCREEN_ROWS)
      useTilesetStore().set(
        TILES,
        normalizeTiles({ mode: 'sc2', count: MAX_TILES, tiles: Array.from({ length: MAX_TILES }, (_, i) => distinct(i)) }),
        'x'
      )
      setMode(session, 'paint')
      // Colour 1 on a row `distinct` paints white: a recolour that needs the slot a full tileset has not got.
      setPaintColor(session, 1)
      beginPaint(session, 'fg')
      extendPaint(session, { x: 0, y: 0 }, { x: 0, y: 0 })
      expect(paintPreviewPoints(session)).toHaveLength(1)
      const before = doc(session)

      endPaint(session)

      expect(session.promptPromote).toBe(true) // it was refused, not painted
      expect(doc(session)).toBe(before)
      expect(paintPreviewPoints(session)).toEqual([])
    })
  })

  it('paintBudgetLabel phrases the budget the way the tile editor does', async () => {
    const session = await openMap()
    expect(paintBudgetLabel(session)).toBe(`tiles: 4/${MAX_TILES}`)
    useTilesetStore().set(TILES, bankedFixture(), 'x')
    expect(paintBudgetLabel(session)).toBe(
      'bank 1: 2 + 6 shared = 8 / 256   bank 2: 0 + 6 shared = 6 / 256   bank 3: 5 + 6 shared = 11 / 256'
    )
  })

  it('a line fed pencil-style — each segment starting where the last ended — is still drawn from the drag origin', async () => {
    // The paint layer advances `from` on every move for every tool, so a line
    // must anchor on the session's own origin, not on whatever `from` the latest
    // segment carried. The existing "final line" test feeds keep-origin style,
    // where `from` *is* the origin on every call and cannot tell the two apart.
    const session = await openMap()
    setMode(session, 'paint')
    setPaintTool(session, 'line')
    beginPaint(session, 'fg')
    extendPaint(session, { x: 0, y: 0 }, { x: 15, y: 0 })
    extendPaint(session, { x: 15, y: 0 }, { x: 15, y: 15 })
    endPaint(session)

    // One diagonal from (0,0) to (15,15): its ends and its middle, and not the
    // horizontal first segment (cell (1,0)) that anchoring on `from` would keep.
    expect(cell(session, 0, 0)).not.toBe(0)
    expect(cell(session, 1, 1)).not.toBe(0)
    expect(cell(session, 1, 0)).toBe(0)
  })

  describe('canPaint — whether there is a pattern tileset to paint into', () => {
    const BTILES = 'res/world.btiles.json'

    it('is true for a map over a pattern tileset', async () => {
      expect(canPaint(await openMap())).toBe(true)
    })

    it('is false over a bitmap tileset, where a stroke would be dropped silently', async () => {
      files[BTILES] = serializeResource({ kind: 'btiles', doc: createBitmapTilesDoc() })
      files[MAP] = JSON.stringify({
        version: 1,
        tileset: BTILES,
        width: 8,
        height: 8,
        cell: { width: 16, height: 16, cols: 16 }
      })
      const session = await openMap()
      // The fixture loaded as what it claims to be — not as a load error, which
      // would also leave `tileset` null and pass this test for the wrong reason.
      expect(session.bitmapTileset).not.toBeNull()
      expect(session.tilesetError).toBeNull()

      expect(canPaint(session)).toBe(false)

      // What the predicate exists to keep the user away from: a stroke that
      // changes nothing and leaves no trace, beside a budget that reads as nothing.
      setMode(session, 'paint')
      const before = doc(session)
      const steps = session.history.past.length
      dab(session, 0, 0)
      expect(doc(session)).toBe(before)
      expect(session.history.past.length).toBe(steps)
      expect(paintBudgetLabel(session)).toBe('')
    })

    it('is false with no tileset set at all', async () => {
      files[MAP] = JSON.stringify({ version: 1, width: 8, height: 8 })
      const session = await openMap()
      expect(session.tileset).toBeNull()
      expect(canPaint(session)).toBe(false)
    })
  })

  it('a rect fed pencil-style — each segment starting where the last ended — is still anchored on the drag origin', async () => {
    // The sibling of the line test above: the paint layer advances `from` for
    // every tool, and a rect anchored on `from` would collapse to whatever
    // shape the last segment alone describes.
    const session = await openMap()
    setMode(session, 'paint')
    setPaintTool(session, 'rect')
    beginPaint(session, 'fg')
    extendPaint(session, { x: 0, y: 0 }, { x: 15, y: 0 })
    extendPaint(session, { x: 15, y: 0 }, { x: 15, y: 15 })
    endPaint(session)

    // A hollow 16×16 from (0,0): its left edge runs down x = 0 through cell
    // (0,1), which a rect anchored on `from` — a vertical line at x = 15 —
    // never reaches.
    expect(cell(session, 0, 0)).not.toBe(0)
    expect(cell(session, 0, 1)).not.toBe(0)
    expect(cell(session, 1, 1)).not.toBe(0)
  })

  it('fill floods from where the button went down, not from wherever it was released', async () => {
    const pixel = (session: MapSession, x: number, y: number): number => {
      const { width, indices } = renderMapPixels(doc(session), session.tileset!, session.activeLayer)
      return indices[y * width + x]
    }
    const session = await openMap()
    setMode(session, 'paint')
    // One white dot on a black picture: two regions, one of them a single pixel.
    dab(session, 20, 20)
    expect(pixel(session, 20, 20)).toBe(15)

    setPaintTool(session, 'fill')
    setPaintColor(session, 7)
    beginPaint(session, 'fg')
    extendPaint(session, { x: 20, y: 20 }, { x: 20, y: 20 })
    const flooded = session.paintPoints
    // The pointer wanders onto the black region before release.
    extendPaint(session, { x: 20, y: 20 }, { x: 0, y: 0 })
    // A later sample is not a new flood: nothing was recomputed.
    expect(session.paintPoints).toBe(flooded)
    endPaint(session)

    // The dot was recoloured; the black region it was released over was not.
    expect(pixel(session, 20, 20)).toBe(7)
    expect(cell(session, 0, 0)).toBe(0)
  })

  describe('setMode ends whatever drag is open', () => {
    it('folds a cell drag into one step, so the next paint stroke does not resolve against a stale preview', async () => {
      const session = await openMap()
      // Not the default brush: tile 0 over a grid of zeros is a drag that changes nothing.
      session.brush = singleStamp(1)
      const steps = session.history.past.length
      paintDrag(session, [{ x: 3, y: 3 }])
      expect(session.preview).not.toBeNull()

      setMode(session, 'paint')

      expect(session.preview).toBeNull()
      expect(session.paintedPoints).toEqual([])
      expect(session.history.past.length).toBe(steps + 1)
      expect(cell(session, 3, 3)).toBe(1)
    })

    it('resolves an open paint stroke, so its points cannot leak into a later drag', async () => {
      const session = await openMap()
      setMode(session, 'paint')
      beginPaint(session, 'fg')
      extendPaint(session, { x: 0, y: 0 }, { x: 0, y: 0 })

      setMode(session, 'tiles')

      expect(session.paintActive).toBe(false)
      expect(session.paintPoints).toEqual([])
      expect(session.paintOrigin).toBeNull()
      expect(cell(session, 0, 0)).not.toBe(0)
    })
  })

  describe('paint mode does not outlive its tileset', () => {
    const BTILES = 'res/world.btiles.json'
    const OTHER = 'res/other.tiles.json'

    it('falls back to tiles mode when the map is pointed at a bitmap tileset', async () => {
      // Otherwise neither input path is live: the paint overlay is gated on
      // `canPaint`, the cell handlers step aside for any mode but tiles, and
      // the toggle that would bring the user back is hidden for the same reason.
      files[BTILES] = serializeResource({ kind: 'btiles', doc: createBitmapTilesDoc() })
      const session = await openMap()
      setMode(session, 'paint')

      await setTileset(session, BTILES)

      expect(session.bitmapTileset).not.toBeNull()
      expect(canPaint(session)).toBe(false)
      expect(session.mode).toBe('tiles')
    })

    it('falls back to tiles mode when the tileset reference is cleared', async () => {
      // The side panel's "— choose —" option, or an outside edit that drops
      // `tileset` from the file: `loadTileset` leaves by its early exit, and
      // that exit has to reset too.
      const session = await openMap()
      setMode(session, 'paint')

      await setTileset(session, '')

      expect(session.tileset).toBeNull()
      expect(session.tilesetError).toContain('No tileset set')
      expect(canPaint(session)).toBe(false)
      expect(session.mode).toBe('tiles')
    })

    it('stays in paint mode across a reload or a swap to another pattern tileset', async () => {
      files[OTHER] = serializeResource({ kind: 'tiles', doc: normalizeTiles({ mode: 'sc2', count: 6 }) })
      const session = await openMap()
      setMode(session, 'paint')

      await reloadTileset(session)
      expect(session.mode).toBe('paint')

      await setTileset(session, OTHER)
      expect(session.tileset?.count).toBe(6)
      expect(session.mode).toBe('paint')
    })

    it('survives being chosen before the map has loaded — a fresh tiled screen opens straight into paint', async () => {
      // Task 9 opens the map it just wrote and calls `setMode` at once, while
      // the tileset is still on its way: the reset must wait for the answer.
      const session = mapSession(MAP)
      setMode(session, 'paint')
      for (let i = 0; i < 4; i++) await settled()
      expect(canPaint(session)).toBe(true)
      expect(session.mode).toBe('paint')
    })
  })

  describe('promotion to banked at the 256-tile ceiling', () => {
    /** An unbanked tileset with no slot left: 256 tiles, every one distinct. */
    function fullTilesetFixture(mode: 'sc2' | 'sc1' = 'sc2') {
      return normalizeTiles({
        mode,
        count: MAX_TILES,
        tiles: Array.from({ length: MAX_TILES }, (_, i) => distinct(i))
      })
    }

    /**
     * A stroke that needs a slot. Colour 1, not the default 15: `distinct`'s
     * rows 0-6 are already white, so a white dot on (0, 0) is a found no-op
     * and never reaches the refusal at all.
     */
    function strokeNeedingATile(session: MapSession, x = 0, y = 0): void {
      setPaintColor(session, 1)
      dab(session, x, y)
    }

    it('offers promotion only for a 32x24 map', async () => {
      const session = await openMap()          // fixture is 8x8
      expect(canPromoteToBanked(session)).toBe(false)

      resize(session, 32, SCREEN_ROWS)
      expect(canPromoteToBanked(session)).toBe(true)

      // Exactly 32 wide too: 8×8 already fails on height, so it cannot tell.
      resize(session, 40, SCREEN_ROWS)
      expect(canPromoteToBanked(session)).toBe(false)
    })

    it('a refused stroke on a 32x24 screen raises the offer, and keeps the refusal on screen', async () => {
      const session = await openMap()
      resize(session, 32, SCREEN_ROWS)
      useTilesetStore().set(TILES, fullTilesetFixture(), 'x')
      setMode(session, 'paint')
      const before = doc(session)

      strokeNeedingATile(session)

      expect(session.promptPromote).toBe(true)
      expect(session.status).toContain('full')
      // The triggering stroke is discarded: nothing changed, nothing to replay.
      expect(doc(session)).toBe(before)
    })

    it('declining is remembered: the next refused stroke does not ask again', async () => {
      const session = await openMap()
      resize(session, 32, SCREEN_ROWS)
      useTilesetStore().set(TILES, fullTilesetFixture(), 'x')
      setMode(session, 'paint')
      strokeNeedingATile(session)
      expect(session.promptPromote).toBe(true)

      declinePromotion(session)
      expect(session.promptPromote).toBe(false)
      expect(session.promotionDeclined).toBe(true)

      strokeNeedingATile(session, 8, 0)
      expect(session.promptPromote).toBe(false)
      expect(session.status).toContain('full')
    })

    it('promotion keeps the tileset fields packBankedTiles does not carry', async () => {
      const session = await openMap()
      resize(session, 32, SCREEN_ROWS)
      // Every field the packer drops set to something a default would not
      // equal — the file fixture's `export` is null, and null equals null
      // whether or not it was carried.
      useTilesetStore().set(
        TILES,
        normalizeTiles({
          mode: 'sc4',
          count: 4,
          reserveTile0: true,
          palette: Array.from({ length: 16 }, (_, i) => i * 4 + 1),
          export: defaultExport(TILES),
          flags: [0, 1, 2, 3],
          blocks: [{ name: 'door', width: 1, height: 2, tiles: [1, 2] }]
        }),
        'x'
      )
      const before = useTilesetStore().patternDoc(TILES)!
      expect(before.export).not.toBeNull()
      expect(before.palette).not.toBeNull()

      promoteToBanked(session)

      const after = useTilesetStore().patternDoc(TILES)!
      expect(isBanked(after)).toBe(true)
      expect(after.mode).toBe('sc4')
      expect(after.export).toEqual(before.export)
      expect(after.reserveTile0).toBe(before.reserveTile0)
      expect(after.palette).toEqual(before.palette)
      // Deliberately not carried: both name tiles by number, and every number
      // changed. `normalizeTiles` would clamp them to the new count of 1 on the
      // next load anyway; until then a carried block would stamp stale indices.
      expect(after.blocks).toEqual([])
      expect(after.flags).toEqual([0])
      // The session draws the document it published, as it does after a stroke.
      expect(session.tileset).toBe(after)
    })

    it('promotion leaves the screen showing the same picture', async () => {
      const session = await openMap()
      resize(session, 32, SCREEN_ROWS)
      setMode(session, 'paint')
      // Different art in each of the three bands, at different counts — a
      // uniform picture cannot tell a transposed bank from the right one.
      for (const [x, row, color] of [
        [0, 0, 15],
        [8, 3, 5],
        [0, 9, 7],
        [0, 17, 9],
        [8, 20, 11],
        [16, 23, 13]
      ]) {
        setPaintColor(session, color)
        dab(session, x, row * TILE_SIZE)
      }
      const tileset = useTilesetStore().patternDoc(TILES)!
      const before = renderMapPixels(doc(session), tileset, 0)
      expect(new Set(before.indices).size).toBeGreaterThan(3)

      promoteToBanked(session)

      const banked = useTilesetStore().patternDoc(TILES)!
      expect(isBanked(banked)).toBe(true)
      // Blank plus the dabs each band holds: 2, 1 and 3 of them.
      expect(banked.bankTiles.map((bank) => bank.length)).toEqual([3, 2, 4])
      const after = renderMapPixels(doc(session), banked, 0)
      expect(after.indices).toEqual(before.indices)
    })

    it('honours reserveTile0: bank tile 0 is blank, and a see-through cell stays tile 0', async () => {
      // The packer numbers each bank from 0 and puts real art there, while
      // `bankIndexEditable` locks bank index 0 under the flag — the same
      // shift `importImage` performs, in all three banks.
      const session = await openMap()
      resize(session, 32, SCREEN_ROWS)
      useTilesetStore().set(
        TILES,
        normalizeTiles({ mode: 'sc2', count: 3, reserveTile0: true, tiles: [blank(), solid(), distinct(1)] }),
        'x'
      )
      const current = doc(session)
      const data = current.layers[0].data.slice()
      data[0] = 1                    // band 0, art
      data[1] = 0                    // band 0, see-through
      data[9 * current.width] = 2    // band 1, art
      data[17 * current.width] = 1   // band 2, art
      commit(session, { ...current, layers: [{ ...current.layers[0], data }] })
      const before = renderMapPixels(doc(session), session.tileset!, 0)

      promoteToBanked(session)

      const banked = useTilesetStore().patternDoc(TILES)!
      expect(banked.reserveTile0).toBe(true)
      for (const bank of banked.bankTiles) expect(bank[0]).toEqual(blankTileEntry('sc2'))
      const layer = doc(session).layers[0]
      expect(layer.data[1]).toBe(0)
      expect(layer.data[0]).not.toBe(0)
      expect(layer.data[9 * current.width]).not.toBe(0)
      expect(layer.data[17 * current.width]).not.toBe(0)
      expect(renderMapPixels(doc(session), banked, 0).indices).toEqual(before.indices)
    })

    it('promotion restarts the history and leaves both files dirty for the pair-save', async () => {
      const session = await openMap()
      resize(session, 32, SCREEN_ROWS)
      expect(canUndo(session.history)).toBe(true)

      promoteToBanked(session)

      // Every earlier step indexes a numbering that no longer exists.
      expect(canUndo(session.history)).toBe(false)
      expect(session.dirty).toBe(true)
      expect(useTilesetStore().isDirty(TILES)).toBe(true)
      expect(session.promptPromote).toBe(false)
      expect(session.status).toContain('banked')
    })

    it('promotion drops every session reference that named a tile by number', async () => {
      // The brush and clipboard would stamp old indices as bank art on the
      // next click; a picked-but-unplaced meta names old tiles too, and the
      // blocker only refuses *placements*. `setTileset` is the precedent.
      const session = await openMap()
      resize(session, 32, SCREEN_ROWS)
      pickTile(session, 2, [1, 2], { width: 2, height: 1, tiles: [1, 2] })
      session.clipboard = { width: 1, height: 1, tiles: [3] }
      pickMeta(session, META)
      expect(session.brushMeta).toBe(META)
      expect(doc(session).metas).toHaveLength(1)

      promoteToBanked(session)

      expect(isBanked(useTilesetStore().patternDoc(TILES)!)).toBe(true)
      expect(session.brush).toEqual(singleStamp(0))
      expect(session.clipboard).toBeNull()
      expect(session.brushBlock).toBeNull()
      expect(session.brushMeta).toBeNull()
      expect(session.pickerSelection).toEqual([0])
      expect(doc(session).metas).toEqual([])
    })

    it('refuses promotion on a taller map and says why', async () => {
      const session = await openMap()
      resize(session, 32, 40)
      useTilesetStore().set(TILES, fullTilesetFixture(), 'x')
      setMode(session, 'paint')

      strokeNeedingATile(session)

      expect(session.status).toContain(`${SCREEN_ROWS} rows`)
      expect(session.promptPromote).toBeFalsy()
    })

    it('refuses promotion when a second layer would keep the old numbering', async () => {
      const session = await openMap()
      resize(session, 32, SCREEN_ROWS)
      addLayer(session)
      useTilesetStore().set(TILES, fullTilesetFixture(), 'x')
      setMode(session, 'paint')

      strokeNeedingATile(session)

      expect(session.status).toContain('layer')
      expect(session.promptPromote).toBeFalsy()
    })

    it('refuses promotion on SCREEN 1, which has one pattern table', async () => {
      const session = await openMap()
      resize(session, 32, SCREEN_ROWS)
      useTilesetStore().set(TILES, normalizeTiles({ mode: 'sc1', count: 4 }), 'x')
      const tileset = useTilesetStore().patternDoc(TILES)

      expect(canPromoteToBanked(session)).toBe(false)
      promoteToBanked(session)

      expect(session.status).toContain('SCREEN 1')
      // Nothing published: `normalizeTiles` would strip the banks on the next load anyway.
      expect(useTilesetStore().patternDoc(TILES)).toBe(tileset)
    })

    it('refuses promotion while the map places meta-tiles, which name tiles by number', async () => {
      const session = await openMap()
      resize(session, 32, SCREEN_ROWS)
      pickMeta(session, META)
      placeMetaAt(session, 2, 2)

      expect(promotionBlocker(session)).toContain('meta-tiles')
      expect(canPromoteToBanked(session)).toBe(false)
    })

    it('a full bank on a banked screen is not something banking can fix', async () => {
      // 32×24, so everything but the banking itself qualifies. Without the
      // `refusedBank` guard this refusal would run through the blocker, whose
      // first answer for a banked tileset is "already banked" — a message about
      // promotion in place of the one that names the bank. (The size check sits
      // *after* `isBanked`, so a banked map can never be told it "needs 24 rows".)
      const session = await openMap()
      resize(session, 32, SCREEN_ROWS)
      useTilesetStore().set(TILES, fullBankedFixture(), 'x')
      setMode(session, 'paint')

      strokeNeedingATile(session)

      expect(session.status).toContain('Bank 1 is full')
      expect(session.status).not.toContain('out of tiles')
      expect(session.promptPromote).toBeFalsy()
    })

    it('the prompt says what promotion does to other files: wrong art, not a rewrite', () => {
      // Nothing emits a reorder event for a promotion, so no other file
      // changes — an open map keeps its old cell indices and draws them
      // against the new banks. "Rewritten" promised the opposite.
      expect(PROMOTION_PROMPT).toContain('wrong art')
      expect(PROMOTION_PROMPT).toContain('repainted')
      expect(PROMOTION_PROMPT).not.toContain('rewritten')
      // The rest of what the user is agreeing to.
      expect(PROMOTION_PROMPT).toContain('meta-tile')
      expect(PROMOTION_PROMPT).toContain('blocks and tile flags are cleared')
      expect(PROMOTION_PROMPT).toContain('draw it again')
    })

    it('accepting after the map stopped qualifying refuses rather than repacking', async () => {
      const session = await openMap()
      resize(session, 32, SCREEN_ROWS)
      useTilesetStore().set(TILES, fullTilesetFixture(), 'x')
      setMode(session, 'paint')
      strokeNeedingATile(session)
      expect(session.promptPromote).toBe(true)
      const tileset = useTilesetStore().patternDoc(TILES)

      resize(session, 32, 40)
      promoteToBanked(session)

      expect(session.promptPromote).toBe(false)
      expect(session.status).toContain(`${SCREEN_ROWS} rows`)
      expect(useTilesetStore().patternDoc(TILES)).toBe(tileset)
    })

    it('a tile tab open on the same tileset cannot undo past the promotion and push the unbanked document back', async () => {
      // The tile editor adopts an outside change as a new history step. A
      // promotion is not an append but a replacement: one undo in that tab
      // would put the *unbanked* snapshot back into the store under a map
      // layer whose bytes are now bank-relative — wrong art, no error, on a
      // document the user just consented to change.
      const tab = tileSession(TILES)
      await settled()
      const session = await openMap()
      resize(session, 32, SCREEN_ROWS)
      useTilesetStore().set(TILES, fullTilesetFixture(), 'x')
      setMode(session, 'paint')
      strokeNeedingATile(session)
      promoteToBanked(session)
      const banked = useTilesetStore().patternDoc(TILES)!
      expect(isBanked(banked)).toBe(true)

      undoTile(tab)

      expect(useTilesetStore().patternDoc(TILES)).toBe(banked)
      expect(isBanked(tab.doc)).toBe(true)
      expect(tab.status).toContain('undo')
    })
  })

  describe('undo against a tileset another editor has changed since', () => {
    /** What another editor leaves in a slot: recognisably not what this map painted. */
    const theirs = (): TileEntry => ({ pattern: new Array(8).fill(0x5a), color: new Array(8).fill(0xf1) })

    /** Rewrites one common tile from "some other editor", and returns the document the store now holds. */
    function meddle(index: number, entry: TileEntry = theirs()) {
      const store = useTilesetStore()
      const current = store.patternDoc(TILES)!
      const tiles = current.tiles.slice()
      tiles[index] = entry
      const next = { ...current, tiles }
      store.set(TILES, next, 'some/other/editor')
      return next
    }

    /** Puts tile 1 in cell (1, 0) — every cell of a fresh map holds tile 0, so an edit stroke there would rewrite tile 0. */
    function stampTile1(session: MapSession): void {
      pickTile(session, 1, [1], singleStamp(1))
      paintDrag(session, [{ x: 1, y: 0 }])
      finishDrag(session)
    }

    it('refuses to restore a tile someone else has changed since, and says so', async () => {
      const session = await openMap()
      stampTile1(session)
      setMode(session, 'paint')
      setPaintWrite(session, 'edit')
      dab(session, 8, 0)
      expect(session.tileset!.tiles[1].pattern[0]).toBe(0x80)

      const meddled = meddle(1)

      undo(session)

      const store = useTilesetStore()
      expect(store.patternDoc(TILES)!.tiles[1].pattern[0]).toBe(0x5a)   // not clobbered
      // Nothing applied, nothing published: re-setting an identical document
      // would dirty the tileset and push a step into every other tab on it.
      expect(store.patternDoc(TILES)).toBe(meddled)
      expect(session.status).toContain('changed')
      // The map's own side of the step still moved.
      expect(session.history.future).toHaveLength(1)
    })

    it('redo is guarded the same way: a tile changed after the undo is left alone', async () => {
      const session = await openMap()
      setMode(session, 'paint')
      setPaintWrite(session, 'edit')
      dab(session, 0, 0)
      undo(session)
      expect(session.tileset!.tiles[0].pattern[0]).toBe(0)

      const meddled = meddle(0)

      redo(session)

      const store = useTilesetStore()
      expect(store.patternDoc(TILES)!.tiles[0].pattern[0]).toBe(0x5a)
      expect(store.patternDoc(TILES)).toBe(meddled)
      expect(session.status).toContain('changed')
    })

    it('restores the tiles still as it left them, and drops only the changed one from the step', async () => {
      const session = await openMap()
      stampTile1(session)
      setMode(session, 'paint')
      setPaintWrite(session, 'edit')
      // One pencil segment across the seam: row 0 of tile 0, first dot of tile 1.
      beginPaint(session, 'fg')
      extendPaint(session, { x: 0, y: 0 }, { x: 8, y: 0 })
      endPaint(session)
      expect(session.tileset!.tiles[0].pattern[0]).toBe(0xff)
      expect(session.tileset!.tiles[1].pattern[0]).toBe(0x80)

      meddle(1)
      undo(session)

      let tiles = useTilesetStore().patternDoc(TILES)!.tiles
      expect(tiles[0].pattern[0]).toBe(0)       // restored
      expect(tiles[1].pattern[0]).toBe(0x5a)    // left alone
      expect(session.status).toContain('1 tile')

      redo(session)
      tiles = useTilesetStore().patternDoc(TILES)!.tiles
      expect(tiles[0].pattern[0]).toBe(0xff)    // re-applied
      // Still theirs: the skipped edit left the step, so redo does not try
      // to write the map's art over it either.
      expect(tiles[1].pattern[0]).toBe(0x5a)
    })

    it('a skipped edit leaves the step for good: redo does not write the pre-stroke art once the slot holds the painted art again', async () => {
      const session = await openMap()
      stampTile1(session)
      setMode(session, 'paint')
      setPaintWrite(session, 'edit')
      dab(session, 8, 0)
      const painted = session.tileset!.tiles[1]

      meddle(1)
      undo(session)                       // skipped: tile 1 is theirs
      meddle(1, painted)                  // the other editor puts the painted art back (its own undo, say)

      redo(session)

      // Had the skipped entry stayed in the step as it was, redo would have
      // found the slot equal to its `after` and written its `before` — the
      // blank from before the stroke — over art nobody asked it to touch.
      expect(useTilesetStore().patternDoc(TILES)!.tiles[1].pattern[0]).toBe(0x80)
    })

    it('in SCREEN 1 the group colour is half the picture: a group recoloured elsewhere is left alone too', async () => {
      files[TILES] = serializeResource({ kind: 'tiles', doc: normalizeTiles({ mode: 'sc1', count: 4 }) })
      const session = await openMap()
      setMode(session, 'paint')
      setPaintWrite(session, 'edit')
      // Colour 15 on a 0xf1 group: the pattern changes, the group byte does not.
      dab(session, 0, 0)
      expect(session.tileset!.tiles[0].pattern[0]).toBe(0x80)
      expect(session.tileset!.groupColors[0]).toBe(0xf1)

      // Another editor recolours the group and leaves the pattern exactly as painted.
      const store = useTilesetStore()
      const current = store.patternDoc(TILES)!
      const groupColors = current.groupColors.slice()
      groupColors[0] = 0x2a
      const recoloured = { ...current, groupColors }
      store.set(TILES, recoloured, 'some/other/editor')

      undo(session)

      expect(store.patternDoc(TILES)).toBe(recoloured)
      expect(store.patternDoc(TILES)!.groupColors[0]).toBe(0x2a)
      expect(store.patternDoc(TILES)!.tiles[0].pattern[0]).toBe(0x80)
      expect(session.status).toContain('changed')
    })

    it('a slot that no longer exists in its table — a bank shrunk elsewhere — is a changed slot, not a crash', async () => {
      const session = await openMap()
      useTilesetStore().set(TILES, bankedFixture(), 'x')
      setMode(session, 'paint')
      resize(session, 8, 24)
      // A fork stroke on row 9 mints a bank-1 tile; an edit stroke on the same
      // cell then rewrites it *there*, so the record points into bank 1.
      dab(session, 0, 9 * TILE_SIZE)
      const index = cell(session, 0, 9)
      expect(session.tileset!.bankTiles[1][index]).toBeDefined()
      setPaintWrite(session, 'edit')
      setPaintColor(session, 4)
      dab(session, 1, 9 * TILE_SIZE)
      expect(session.history.present.tileEdits).toEqual([expect.objectContaining({ bank: 1, index })])

      // The tile tab undoes its own bank painting: bank 1 is empty again and
      // the slot the record names is simply not there.
      const store = useTilesetStore()
      const current = store.patternDoc(TILES)!
      const shrunk = { ...current, bankTiles: [current.bankTiles[0], [], current.bankTiles[2]] }
      store.set(TILES, shrunk, 'some/other/editor')

      undo(session)

      expect(store.patternDoc(TILES)).toBe(shrunk)
      expect(store.patternDoc(TILES)!.bankTiles[1]).toEqual([])
      expect(session.status).toContain('changed')
    })

    it('a step whose tileset is not loaded is refused whole, and says so, rather than undone by half', async () => {
      // Reached by undoing across a tileset switch: the map painted into
      // `TILES`, saved, and was pointed at another tileset — giving up its
      // hold, so the clean document left the store. Undo the switch, and the
      // next undo names a document the store no longer has. Moving history
      // without the swap would leave the record out of phase: the redo after
      // it finds the slot still holding `after` and writes `before` over the
      // stroke. So the step stays where it is until the tileset is back.
      const TILES2 = 'res/other.tiles.json'
      files[TILES2] = serializeResource({ kind: 'tiles', doc: normalizeTiles({ mode: 'sc2', count: 3 }) })
      const session = await openMap()
      stampTile1(session)
      setMode(session, 'paint')
      setPaintWrite(session, 'edit')
      dab(session, 8, 0)
      await saveSession(session)
      await setTileset(session, TILES2)
      undo(session) // the switch
      expect(doc(session).tileset).toBe(TILES)
      expect(useTilesetStore().patternDoc(TILES)).toBeNull()
      const present = session.history.present
      session.status = ''

      undo(session) // the stroke

      expect(session.history.present).toBe(present)
      expect(session.status).toContain('not loaded')
    })

    it('a clean undo still restores every tile and says nothing', async () => {
      const session = await openMap()
      stampTile1(session)
      setMode(session, 'paint')
      setPaintWrite(session, 'edit')
      dab(session, 8, 0)
      session.status = ''

      undo(session)

      expect(useTilesetStore().patternDoc(TILES)!.tiles[1].pattern[0]).toBe(0)
      expect(session.status).toBe('')
    })
  })
})

describe('a file that appears under an open tab', () => {
  it('a map whose file was missing when the tab opened loads it once it exists, and keeps paint mode', async () => {
    // The trap, as met live: the app restores a tab for `res/title.map.json`,
    // the file is gone, the session fails with ENOENT. "New tiled screen" then
    // writes that path and calls `setMode('paint')` on the stale session.
    // Nothing re-runs `load` for it but the watcher — which used to ignore a
    // file being *created* — so it sat on its error, in paint mode, with no canvas.
    const api = window.api as unknown as { invoke: (channel: string, args: { path: string }) => Promise<unknown> }
    const read = api.invoke
    api.invoke = async (channel, args) => {
      if (channel === 'fs:read' && !(args.path in files)) throw new Error(`ENOENT: no such file or directory, open '${args.path}'`)
      return read(channel, args)
    }
    delete files[MAP]
    const session = await openMap()
    expect(session.error).toContain('ENOENT')
    expect(canPaint(session)).toBe(false)

    setMode(session, 'paint')
    files[MAP] = serializeResource({ kind: 'map', doc: normalizeMap({ tileset: TILES, width: 32, height: 24 }) })
    for (const handler of pushed['fs:changed'] ?? []) handler({ type: 'add', path: MAP })
    await new Promise((resolve) => setTimeout(resolve, 140))
    for (let i = 0; i < 4; i++) await settled()

    expect(session.error).toBeNull()
    expect(doc(session).tileset).toBe(TILES)
    expect(canPaint(session)).toBe(true)
    expect(session.mode).toBe('paint')
  })
})
