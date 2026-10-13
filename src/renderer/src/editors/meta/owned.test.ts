/**
 * A `.meta-tiles.json` from the editor's side: it opens in the pose editor
 * (`editors/anim/`), whose edits — see-through cells, flags, a size past an
 * animation window's — have to survive a save as a version-3 file.
 */

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isOwnedMeta, normalizeOwnedMeta, type OwnedMetaDoc } from '../../../../shared/msx/meta-owned'
import { defaultExport, parseResource, serializeResource } from '../../../../shared/msx/resource'
import { normalizeTiles, type TileEntry } from '../../../../shared/msx/tile'
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
})

async function open<T>(make: () => T): Promise<T> {
  const session = make()
  for (let i = 0; i < 6; i++) await settled()
  return session
}

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
