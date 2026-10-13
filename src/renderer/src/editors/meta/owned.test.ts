/**
 * A `.meta-tiles.json` that owns its pixels, from the editor's side: which
 * editor opens it, editing it with the pose editor, and converting a
 * version-2 meta into one.
 *
 * The failures worth guarding are quiet ones. Either editor opening the other
 * format reads it as its own and, on save, writes the other's data away — a
 * converted meta silently turned back into tile references, or a version-2
 * meta's references replaced by a blank pose. And a conversion that moved the
 * meta's tiles would redraw every map that placed it.
 */

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMetaTileDoc } from '../../../../shared/msx/meta-tile'
import { isOwnedMeta, normalizeOwnedMeta, type OwnedMetaDoc } from '../../../../shared/msx/meta-owned'
import { defaultExport, parseResource, serializeResource } from '../../../../shared/msx/resource'
import { normalizeTiles, type TileEntry } from '../../../../shared/msx/tile'
import { useTilesetStore } from '../../stores/tilesetStore'
import { resetExternalWatches } from '../external-changes'
import {
  addFrame,
  animSession,
  doc,
  existingAnimSession,
  pruneAnimSessions,
  resize,
  saveSession as savePoses,
  setFlag,
  stepBytes,
  toggleHole
} from '../anim/session'
import { metaFormat, setMetaFormat, sniffMetaFormat } from './format'
import { convertToOwned, metaSession, pruneMetaSessions, saveSession as saveV2 } from './session'

const META = 'res/torch.meta-tiles.json'
const TILES = 'res/main.tiles.json'
let files: Record<string, string>
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const tile = (mark: number, paper = 1): TileEntry => ({ pattern: new Array(8).fill(mark), color: new Array(8).fill(0xf0 | paper) })

/** A 2×2 torch whose top row flickers between two poses. */
function torch(): OwnedMetaDoc {
  return normalizeOwnedMeta({
    version: 3,
    mode: 'sc2',
    width: 2,
    height: 2,
    frames: [0x18, 0x3c].map((mark) => ({ tiles: [tile(mark, 9), tile(mark, 9), tile(0xff, 6), tile(0xff, 6)], duration: 5 })),
    export: defaultExport(META)
  })
}

beforeEach(() => {
  resetExternalWatches()
  setActivePinia(createPinia())
  files = {
    [TILES]: serializeResource({
      kind: 'tiles',
      doc: normalizeTiles({ mode: 'sc2', count: 4, tiles: [tile(0), tile(0x81), tile(0x42), tile(0x24)] })
    })
  }
  ;(globalThis as { window?: unknown }).window = {
    confirm: vi.fn(() => true),
    api: {
      on: vi.fn(),
      invoke: vi.fn(async (channel: string, args: { path: string; content?: string }) => {
        if (channel === 'fs:read') return files[args.path] ?? ''
        if (channel === 'fs:write') {
          files[args.path] = args.content ?? ''
          return undefined
        }
        if (channel === 'resources:list') return []
        throw new Error(`unexpected channel ${channel}`)
      })
    }
  }
  pruneAnimSessions(new Set())
  pruneMetaSessions(new Set())
})

async function open<T>(make: () => T): Promise<T> {
  const session = make()
  for (let i = 0; i < 6; i++) await settled()
  return session
}

describe('which editor a .meta-tiles.json opens in', () => {
  it('is read from the file: version 3 in the pose editor, version 2 in the meta editor, a new one in the pose editor', async () => {
    files[META] = serializeResource({ kind: 'metatiles', doc: torch() })
    expect(await sniffMetaFormat(META)).toBe('owned')
    files['res/old.meta-tiles.json'] = serializeResource({ kind: 'metatiles', doc: createMetaTileDoc(TILES) })
    expect(await sniffMetaFormat('res/old.meta-tiles.json')).toBe('refs')
    expect(await sniffMetaFormat('res/new.meta-tiles.json')).toBe('owned')
  })

  it('the meta editor will not save over a file that owns its pixels', async () => {
    files[META] = serializeResource({ kind: 'metatiles', doc: torch() })
    const before = files[META]
    const session = await open(() => metaSession(META))
    expect(session.ownsPixels).toBe(true)
    expect(session.error).toMatch(/owns its pixels/)
    await saveV2(session)
    expect(files[META]).toBe(before)
  })

  it('the pose editor will not save over a version-2 meta', async () => {
    files[META] = serializeResource({ kind: 'metatiles', doc: createMetaTileDoc(TILES) })
    const before = files[META]
    const session = await open(() => animSession(META))
    expect(session.error).toMatch(/references a tileset/)
    await savePoses(session)
    expect(files[META]).toBe(before)
  })
})

describe('editing a meta-tile with the pose editor', () => {
  beforeEach(() => {
    files[META] = serializeResource({ kind: 'metatiles', doc: torch() })
  })

  it('toggles see-through cells and flags, as undoable edits, and saves a version-3 file', async () => {
    const session = await open(() => animSession(META))
    expect(session.kind).toBe('metatiles')
    toggleHole(session, 3)
    setFlag(session, 0, true)
    setFlag(session, 6, true)
    await savePoses(session)
    const saved = parseResource(META, files[META]).doc
    expect(isOwnedMeta(saved)).toBe(true)
    expect((saved as OwnedMetaDoc).holes).toEqual([false, false, false, true])
    expect((saved as OwnedMetaDoc).flags).toBe(0x41)
  })

  it('grows past an animation window’s 16 tiles, keeping see-through cells where they were', async () => {
    const session = await open(() => animSession(META))
    toggleHole(session, 2)
    resize(session, 6, 4)
    const meta = doc(session) as OwnedMetaDoc
    expect([meta.width, meta.height]).toEqual([6, 4])
    expect(meta.holes[6]).toBe(true)
    expect(meta.holes.filter(Boolean)).toHaveLength(1)
    addFrame(session, null)
    expect(doc(session).frames[2].tiles).toHaveLength(24)
  })

  it('costs a step only for the cells that move', async () => {
    const session = await open(() => animSession(META))
    // Two moving tiles × 8 pattern bytes × 3 banks; the poses share colours.
    expect(stepBytes(doc(session))).toBe(48)
  })

  it('is the session the menu’s save reaches, once the tab has opened it', async () => {
    expect(existingAnimSession(META)).toBeNull()
    await open(() => animSession(META))
    expect(existingAnimSession(META)).not.toBeNull()
  })
})

describe('converting a version-2 meta', () => {
  beforeEach(() => {
    // A 2×1 meta: tile 3, then see-through; then a second frame on tile 2.
    files[META] = serializeResource({
      kind: 'metatiles',
      doc: { ...createMetaTileDoc(TILES, 2, 1), frames: [{ tiles: [3, 0] }], flags: 2, export: defaultExport(META) }
    })
  })

  it('copies the art out, stays attached at the same tiles, and reopens in the pose editor', async () => {
    setMetaFormat(META, 'refs')
    const session = await open(() => metaSession(META))
    expect(await convertToOwned(session)).toBe(true)
    const saved = parseResource(META, files[META]).doc as OwnedMetaDoc
    expect(isOwnedMeta(saved)).toBe(true)
    expect(saved.holes).toEqual([false, true])
    expect(saved.frames[0].tiles[0].pattern[0]).toBe(0x24)
    expect(saved.flags).toBe(2)
    // The tileset, saved with it since it had no edits of its own.
    const tileset = parseResource(TILES, files[TILES]).doc
    if (!('metas' in tileset)) throw new Error('not a tileset')
    expect(tileset.metas[0].cells).toEqual([3, 0])
    expect(tileset.count).toBe(4)
    expect(metaFormat(META)).toBe('owned')
  })

  it('leaves a tileset with unsaved edits of its own unsaved, and says so', async () => {
    const session = await open(() => metaSession(META))
    const store = useTilesetStore()
    store.set(TILES, { ...store.patternDoc(TILES)!, flags: [1, 0, 0, 0] }, 'someone')
    const before = files[TILES]
    expect(await convertToOwned(session)).toBe(true)
    expect(files[TILES]).toBe(before)
    expect(session.status).toMatch(/had unsaved edits/)
    expect(store.patternDoc(TILES)!.metas[0].cells).toEqual([3, 0])
  })

  it('does nothing when the confirm is declined', async () => {
    ;(window.confirm as ReturnType<typeof vi.fn>).mockReturnValue(false)
    const session = await open(() => metaSession(META))
    const before = files[META]
    expect(await convertToOwned(session)).toBe(false)
    expect(files[META]).toBe(before)
  })
})
