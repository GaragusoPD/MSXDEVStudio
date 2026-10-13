/**
 * Animated meta-tiles through an attached animation: the meta editor points
 * cells at an animation's window, and painting never mistakes that window for
 * still art.
 */

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMetaTileDoc } from '../../../../shared/msx/meta-tile'
import { serializeResource } from '../../../../shared/msx/resource'
import { normalizeTiles } from '../../../../shared/msx/tile'
import { attachAnimation, normalizeTileAnim } from '../../../../shared/msx/tile-anim'
import { useTilesetStore } from '../../stores/tilesetStore'
import { animationAtCell, doc, metaAnimations, metaSession, paint, placeAnimation, pruneMetaSessions, setColor, undo } from './session'

const META = 'res/torch.meta-tiles.json'
const TILES = 'res/main.tiles.json'
const FLAME = 'res/flame.anim-tiles.json'
let files: Record<string, string>
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  setActivePinia(createPinia())
  const flame = normalizeTileAnim({ width: 2, height: 1, frames: [{}, {}] })
  const tiles = attachAnimation(normalizeTiles({ mode: 'sc2', count: 4, reserveTile0: true }), FLAME, flame, { slot: 1, bank: null, name: 'g_Flame' })
  files = {
    [META]: serializeResource({
      kind: 'metatiles',
      doc: { ...createMetaTileDoc(TILES, 2, 2), frames: [{ tiles: [0, 0, 3, 3] }, { tiles: [0, 0, 3, 3] }] }
    }),
    [TILES]: serializeResource({ kind: 'tiles', doc: tiles })
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
        throw new Error(`unexpected channel ${channel}`)
      })
    }
  }
  pruneMetaSessions(new Set())
})

async function open(): Promise<ReturnType<typeof metaSession>> {
  const session = metaSession(META)
  for (let i = 0; i < 4; i++) await settled()
  return session
}

describe('an attached animation in a meta', () => {
  it("offers the tileset's animations and places one in every frame, as one undo step", async () => {
    const session = await open()
    expect(metaAnimations(session).map((b) => b.path)).toEqual([FLAME])
    placeAnimation(session, FLAME, 0, 0)
    expect(doc(session).frames.map((f) => f.tiles)).toEqual([
      [1, 2, 3, 3],
      [1, 2, 3, 3]
    ])
    expect(animationAtCell(session, 1, 0)?.path).toBe(FLAME)
    expect(animationAtCell(session, 0, 1)).toBeNull()
    expect(session.status).toMatch(/every copy of this meta animates/)
    undo(session)
    expect(doc(session).frames[0].tiles).toEqual([0, 0, 3, 3])
  })

  it('says why it will not fit', async () => {
    const session = await open()
    placeAnimation(session, FLAME, 1, 1)
    expect(doc(session).frames[0].tiles).toEqual([0, 0, 3, 3])
    expect(session.status).toMatch(/does not fit at 1,1/)
  })

  it('painting over an animated cell gives it a still tile and leaves the window alone', async () => {
    const session = await open()
    placeAnimation(session, FLAME, 0, 0)
    const windowArt = useTilesetStore().patternDoc(TILES)!.tiles[1]
    setColor(session, 9)
    paint(session, [{ x: 0, y: 0 }], 'fg')
    expect(doc(session).frames[0].tiles[0]).not.toBe(1)
    expect(useTilesetStore().patternDoc(TILES)!.tiles[1]).toEqual(windowArt)
    expect(session.status).toMatch(/showed an attached animation and now has a still tile/)
  })
})
