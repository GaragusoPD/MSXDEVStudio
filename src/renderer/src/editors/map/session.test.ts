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
import { createMetaTileDoc } from '../../../../shared/msx/meta-tile'
import { defaultExport, serializeResource } from '../../../../shared/msx/resource'
import { normalizeTiles } from '../../../../shared/msx/tile'
import {
  bankSheetOffset,
  doc,
  mapSession,
  metaRowOffsets,
  pickerBankOffset,
  pickMeta,
  placeMetaAt,
  pruneMapSessions,
  saveSession,
  selectPlacementAt,
  setBaked,
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
