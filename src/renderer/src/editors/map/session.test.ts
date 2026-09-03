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
import { MAX_TILES, normalizeTiles, TILE_SIZE, type TileEntry } from '../../../../shared/msx/tile'
import { normalizeMap } from '../../../../shared/msx/map'
import {
  bankSheetOffset,
  beginPaint,
  canPaint,
  doc,
  endPaint,
  extendPaint,
  mapSession,
  metaRowOffsets,
  paintBankOf,
  paintBudgetLabel,
  paintPointAt,
  pickerBankOffset,
  pickMeta,
  placeMetaAt,
  pruneMapSessions,
  redo,
  renderMapPixels,
  resize,
  saveSession,
  selectPlacementAt,
  setBaked,
  setMode,
  setPaintColor,
  setPaintTool,
  setPaintWrite,
  undo,
  type MapSession
} from './session'
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
})
