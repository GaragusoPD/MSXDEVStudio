/**
 * Attaching animations from the tile editor, and what a window does to the
 * rest of the editor.
 *
 * The window's art is rewritten from the animation file at every export, so
 * the failure worth guarding is quiet: an edit that appears to work on a
 * window tile and vanishes at the next build, or a window still showing the
 * old first pose after the animation was saved.
 */

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseResource, serializeResource } from '../../../../shared/msx/resource'
import { normalizeTiles, type TileEntry } from '../../../../shared/msx/tile'
import { normalizeTileAnim, type TileAnimDoc } from '../../../../shared/msx/tile-anim'
import {
  attachAnim,
  attachableAnimations,
  beginStroke,
  deleteTile,
  detachAnim,
  endStroke,
  extractAnimation,
  paint,
  pruneTileSessions,
  select,
  tileSession,
  transform
} from './session'
import { emitAnimSaved } from '../anim/events'
import { useResourcesStore } from '../../stores/resourcesStore'

const TILES = 'res/main.tiles.json'
const COIN = 'res/coin.anim-tiles.json'
let files: Record<string, string>
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const tile = (mark: number): TileEntry => ({ pattern: new Array(8).fill(mark), color: new Array(8).fill(0xf1) })

function coin(first = 0x18): TileAnimDoc {
  return normalizeTileAnim({
    mode: 'sc2',
    frames: [first, 0x3c, 0x7e].map((mark) => ({ tiles: [tile(mark)], duration: 6 })),
    export: { name: 'g_Coin', format: 'c', out: 'content/coin.h' }
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  files = {
    [TILES]: serializeResource({ kind: 'tiles', doc: normalizeTiles({ mode: 'sc2', count: 8, tiles: Array.from({ length: 8 }, (_, i) => tile(i)) }) }),
    [COIN]: serializeResource({ kind: 'anim', doc: coin() })
  }
  ;(globalThis as { window?: unknown }).window = {
    confirm: vi.fn(() => true),
    api: {
      on: vi.fn(),
      invoke: vi.fn(async (channel: string, args: { path: string; content?: string }) => {
        if (channel === 'fs:read') {
          if (args.path in files) return files[args.path]
          throw new Error(`ENOENT ${args.path}`)
        }
        if (channel === 'fs:write') {
          files[args.path] = args.content ?? ''
          return undefined
        }
        if (channel === 'fs:stat') return args.path in files ? { size: 1 } : null
        if (channel === 'fs:create') return undefined
        if (channel === 'resources:list') return Object.keys(files).map((path) => ({ path, kind: path.endsWith('.anim-tiles.json') ? 'anim' : 'tiles', out: null }))
        throw new Error(`unexpected channel ${channel}`)
      })
    }
  }
  useResourcesStore().entries = [
    { path: TILES, kind: 'tiles', out: null },
    { path: COIN, kind: 'anim', out: null }
  ]
  pruneTileSessions(new Set())
})

async function open(): Promise<ReturnType<typeof tileSession>> {
  const session = tileSession(TILES)
  for (let i = 0; i < 4; i++) await settled()
  return session
}

describe('attaching from the tile editor', () => {
  it('attaches at the selected tile and shows the first pose there', async () => {
    const session = await open()
    select(session, 5)
    await attachAnim(session, COIN)
    expect(session.doc.animations.map((b) => [b.path, b.slot])).toEqual([[COIN, 5]])
    expect(session.doc.tiles[5].pattern[0]).toBe(0x18)
    expect(session.status).toContain('g_MainTiles_Animate()')
    expect(attachableAnimations(session)).toEqual([])
  })

  it('refuses a window that would write over the reserved see-through tile', async () => {
    files[TILES] = serializeResource({ kind: 'tiles', doc: normalizeTiles({ mode: 'sc2', count: 8, reserveTile0: true }) })
    const session = await open()
    select(session, 0)
    await attachAnim(session, COIN)
    expect(session.doc.animations).toEqual([])
    expect(session.status).toMatch(/reserved see-through/)
  })

  it('refuses poses in a mode the tileset cannot show', async () => {
    files[COIN] = serializeResource({ kind: 'anim', doc: normalizeTileAnim({ mode: 'sc1' }) })
    const session = await open()
    await attachAnim(session, COIN)
    expect(session.doc.animations).toEqual([])
    expect(session.status).toMatch(/sc1 poses/)
  })

  it('detaching keeps the pose as art', async () => {
    const session = await open()
    select(session, 5)
    await attachAnim(session, COIN)
    detachAnim(session, COIN)
    expect(session.doc.animations).toEqual([])
    expect(session.doc.tiles[5].pattern[0]).toBe(0x18)
  })
})

describe('a window is the animation’s, not the tile editor’s', () => {
  it('a stroke on it is refused and says where to edit instead', async () => {
    const session = await open()
    select(session, 5)
    await attachAnim(session, COIN)
    const before = session.doc
    beginStroke(session)
    paint(session, [{ x: 0, y: 0 }], 'fg')
    endStroke(session, 'paint')
    expect(session.doc).toBe(before)
    expect(session.status).toMatch(/shows the animation coin\.anim-tiles\.json/)
  })

  it('so is a transform', async () => {
    const session = await open()
    select(session, 5)
    await attachAnim(session, COIN)
    const before = session.doc
    transform(session, 'shiftLeft')
    expect(session.doc).toBe(before)
  })

  it('deleting one of its tiles detaches it, and says so', async () => {
    const session = await open()
    select(session, 5)
    await attachAnim(session, COIN)
    deleteTile(session, 5)
    expect(session.doc.animations).toEqual([])
    expect(session.status).toMatch(/Detached coin\.anim-tiles\.json/)
  })

  it('a reorder below it moves the window with its tile', async () => {
    const session = await open()
    select(session, 5)
    await attachAnim(session, COIN)
    deleteTile(session, 1)
    expect(session.doc.animations[0].slot).toBe(4)
  })
})

describe('the window follows the animation', () => {
  it('opening a tileset whose animation changed shows the new first pose', async () => {
    const attached = normalizeTiles({
      mode: 'sc2',
      count: 8,
      animations: [{ path: COIN, slot: 3, bank: null, name: 'g_Coin', width: 1, height: 1, frames: 3, colorsVary: false, loop: 'loop' }]
    })
    files[TILES] = serializeResource({ kind: 'tiles', doc: attached })
    files[COIN] = serializeResource({ kind: 'anim', doc: coin(0xff) })
    const session = await open()
    expect(session.doc.tiles[3].pattern[0]).toBe(0xff)
    expect(session.status).toMatch(/new first pose/)
  })

  it('saving the animation updates an open tileset straight away', async () => {
    const session = await open()
    select(session, 5)
    await attachAnim(session, COIN)
    emitAnimSaved({ path: COIN, doc: coin(0x81) })
    expect(session.doc.tiles[5].pattern[0]).toBe(0x81)
  })
})

describe('extracting an animation from a pose block', () => {
  it('writes the file and attaches it at the chosen slot', async () => {
    files[TILES] = serializeResource({
      kind: 'tiles',
      doc: normalizeTiles({
        mode: 'sc2',
        count: 8,
        tiles: Array.from({ length: 8 }, (_, i) => tile(i)),
        blocks: [{ name: 'spin', width: 3, height: 1, tiles: [4, 5, 6] }]
      })
    })
    const session = await open()
    await extractAnimation(session, 0, { width: 1, height: 1, duration: 10 }, 2)
    const written = parseResource('res/spin.anim-tiles.json', files['res/spin.anim-tiles.json'])
    if (written.kind !== 'anim') throw new Error('not an animation')
    expect(written.doc.frames.map((f) => [f.tiles[0].pattern[0], f.duration])).toEqual([
      [4, 10],
      [5, 10],
      [6, 10]
    ])
    expect(written.doc.export?.name).toBe('g_SpinAnim')
    expect(session.doc.animations.map((b) => [b.path, b.slot])).toEqual([['res/spin.anim-tiles.json', 2]])
    // Frame 0 now shows at the slot.
    expect(session.doc.tiles[2].pattern[0]).toBe(4)
  })

  it('will not overwrite a file that is already there', async () => {
    files[TILES] = serializeResource({
      kind: 'tiles',
      doc: normalizeTiles({ mode: 'sc2', count: 8, blocks: [{ name: 'coin', width: 2, height: 1, tiles: [1, 2] }] })
    })
    const session = await open()
    await extractAnimation(session, 0, { width: 1, height: 1, duration: 10 }, 5)
    expect(session.status).toMatch(/already exists/)
    expect(session.doc.animations).toEqual([])
  })
})
