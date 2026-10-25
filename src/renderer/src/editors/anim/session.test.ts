import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseResource, serializeResource } from '../../../../shared/msx/resource'
import { normalizeTiles } from '../../../../shared/msx/tile'
import { normalizeTileAnim, type TileAnimDoc } from '../../../../shared/msx/tile-anim'
import {
  addFrame,
  animSession,
  copyPose,
  pastePose,
  floatImage,
  moveFloat,
  placeFloat,
  beginStroke,
  canUndo,
  doc,
  endStroke,
  moveFrame,
  paint,
  poseAtTick,
  posePixels,
  pruneAnimSessions,
  removeFrame,
  resize,
  saveSession,
  setColor,
  setDuration,
  setLoop,
  stepBytes,
  undo
} from './session'
import { onAnimSaved, type AnimSavedEvent } from './events'
import { useResourcesStore } from '../../stores/resourcesStore'
import { resetExternalWatches } from '../external-changes'
import { pictureClipboard } from '../picture-clipboard'
import { createOwnedMeta, type OwnedMetaDoc } from '../../../../shared/msx/meta-owned'

const PATH = 'res/coin.anim-tiles.json'
let files: Record<string, string>
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  resetExternalWatches()
  setActivePinia(createPinia())
  files = {
    [PATH]: serializeResource({ kind: 'anim', doc: normalizeTileAnim({ frames: [{ duration: 4 }, { duration: 6 }] }) }),
    'res/a.tiles.json': serializeResource({
      kind: 'tiles',
      doc: normalizeTiles({
        mode: 'sc2',
        count: 8,
        animations: [{ path: PATH, slot: 6, bank: null, name: 'g_Coin', width: 1, height: 1, frames: 2, colorsVary: false, loop: 'loop' }]
      })
    }),
    'res/b.tiles.json': serializeResource({ kind: 'tiles', doc: normalizeTiles({ mode: 'sc2', count: 8 }) })
  }
  ;(globalThis as { window?: unknown }).window = {
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
  useResourcesStore().entries = [
    { path: 'res/a.tiles.json', kind: 'tiles', out: null },
    { path: 'res/b.tiles.json', kind: 'tiles', out: null },
    { path: PATH, kind: 'anim', out: null }
  ]
  pruneAnimSessions(new Set())
})

async function open(): Promise<ReturnType<typeof animSession>> {
  const session = animSession(PATH)
  for (let i = 0; i < 4; i++) await settled()
  return session
}

describe('the animation editor', () => {
  it('loads the file and lists the tilesets it is attached to', async () => {
    const session = await open()
    expect(doc(session).frames.map((f) => f.duration)).toEqual([4, 6])
    expect(session.attachedTo).toEqual([{ tileset: 'res/a.tiles.json', slot: 6, bank: null, cells: 1 }])
  })

  it('finds its tilesets even when nothing has listed the project yet', async () => {
    // Opened from the Explorer: the Resources panel never ran, so the store is empty.
    useResourcesStore().entries = []
    const api = (globalThis as unknown as { window: { api: { invoke: ReturnType<typeof vi.fn> } } }).window.api
    const fallback = api.invoke.getMockImplementation() as (channel: string, args: unknown) => Promise<unknown>
    api.invoke.mockImplementation(async (channel: string, args: { path: string }) => {
      if (channel === 'resources:list') {
        return ['res/a.tiles.json', 'res/b.tiles.json'].map((path) => ({ path, kind: 'tiles', out: null }))
      }
      if (channel === 'resources:msximgHelp') return null
      return fallback(channel, args)
    })
    const session = await open()
    expect(session.attachedTo).toEqual([{ tileset: 'res/a.tiles.json', slot: 6, bank: null, cells: 1 }])
  })

  it('a drag is one undo step, and paints the row ink with the left button', async () => {
    const session = await open()
    setColor(session, 9)
    beginStroke(session)
    paint(session, [{ x: 0, y: 0 }], 'fg')
    paint(session, [{ x: 1, y: 0 }], 'fg')
    // The canvas follows the drag before anything is committed.
    expect(posePixels(session, 0).indices[1]).toBe(9)
    endStroke(session)
    expect(doc(session).frames[0].tiles[0].pattern[0]).toBe(0xc0)
    expect(doc(session).frames[0].tiles[0].color[0] >> 4).toBe(9)
    undo(session)
    expect(doc(session).frames[0].tiles[0].pattern[0]).toBe(0)
    expect(canUndo(session.history)).toBe(false)
  })

  it('adds a pose as a copy of the current one, removes and reorders them', async () => {
    const session = await open()
    addFrame(session, 1)
    expect(doc(session).frames.map((f) => f.duration)).toEqual([4, 6, 6])
    expect(session.frame).toBe(2)
    moveFrame(session, 2, 0)
    expect(session.frame).toBe(0)
    removeFrame(session, 0)
    expect(doc(session).frames).toHaveLength(2)
    removeFrame(session, 0)
    removeFrame(session, 0)
    expect(doc(session).frames).toHaveLength(1)
    expect(session.status).toMatch(/at least one pose/)
  })

  it('sets one pose’s duration, or all of them, clamped to a byte', async () => {
    const session = await open()
    setDuration(session, 1, 999)
    expect(doc(session).frames[1].duration).toBe(255)
    setDuration(session, null, 3)
    expect(doc(session).frames.map((f) => f.duration)).toEqual([3, 3])
  })

  it('resizes the window keeping cells from the top-left, and refuses past 16 tiles', async () => {
    const session = await open()
    setColor(session, 9)
    beginStroke(session)
    paint(session, [{ x: 0, y: 0 }], 'fg')
    endStroke(session)
    resize(session, 2, 2)
    expect(doc(session).frames[0].tiles).toHaveLength(4)
    expect(doc(session).frames[0].tiles[0].pattern[0]).toBe(0x80)
    resize(session, 5, 4)
    expect(doc(session).width).toBe(2)
    expect(session.status).toMatch(/at most 16/)
  })

  it('saving writes the file and tells open tilesets', async () => {
    const session = await open()
    setLoop(session, 'pingpong')
    const heard: AnimSavedEvent[] = []
    const stop = onAnimSaved((event) => heard.push(event))
    await saveSession(session)
    stop()
    const saved = parseResource(PATH, files[PATH])
    expect(saved.kind === 'anim' && saved.doc.loop).toBe('pingpong')
    expect(heard.map((event) => event.path)).toEqual([PATH])
    expect(session.dirty).toBe(false)
  })
})

describe('the preview keeps the generated C’s time', () => {
  const anim = (loop: 'loop' | 'pingpong' | 'once', durations: number[]): TileAnimDoc =>
    normalizeTileAnim({ loop, frames: durations.map((duration) => ({ duration })) })
  const run = (doc: TileAnimDoc, ticks: number): number[] => Array.from({ length: ticks }, (_, t) => poseAtTick(doc, t))

  it('holds each pose for its duration and loops', () => {
    expect(run(anim('loop', [2, 1, 3]), 8)).toEqual([0, 0, 1, 2, 2, 2, 0, 0])
  })

  it('ping-pong turns at both ends without repeating them', () => {
    // _Animate(): 0,1,2,1,0,1,2,... — each end shown once per pass.
    expect(run(anim('pingpong', [1, 1, 1]), 8)).toEqual([0, 1, 2, 1, 0, 1, 2, 1])
  })

  it('once holds the last pose', () => {
    expect(run(anim('once', [1, 2, 1]), 7)).toEqual([0, 1, 1, 2, 2, 2, 2])
  })
})

describe('what a step costs', () => {
  it('is 24 bytes a tile in SCREEN 2, doubled only when the poses differ in colour', () => {
    const same = normalizeTileAnim({ width: 2, frames: [{}, {}] })
    expect(stepBytes(same)).toBe(48)
    const recoloured = { ...same, frames: [same.frames[0], { ...same.frames[1], tiles: same.frames[1].tiles.map((t) => ({ ...t, color: new Array(8).fill(0x41) })) }] }
    expect(stepBytes(recoloured)).toBe(96)
    expect(stepBytes(normalizeTileAnim({ mode: 'sc1', width: 2 }))).toBe(16)
  })
})

describe('the pixel clipboard', () => {
  const META = 'res/rock.meta-tiles.json'
  /** `cols × rows` tiles of pixels, every dot `color` except the last tile column, left empty. */
  function clip(cols: number, rows: number, color: number) {
    const width = cols * 8
    const indices = new Uint8Array(width * rows * 8)
    for (let y = 0; y < rows * 8; y++) for (let x = 0; x < (cols - 1) * 8; x++) indices[y * width + x] = color
    return { picture: { width, height: rows * 8, indices }, rgb: [], mode: 'sc2' as const, from: 'res/level.map.json' }
  }

  it('a paste into a meta-tile grows it to fit, as one undo step, and the drawn tiles stop being see-through', async () => {
    files[META] = serializeResource({ kind: 'metatiles', doc: { ...createOwnedMeta('sc2', 1, 1), holes: [true] } })
    const session = animSession(META)
    await settled()
    pictureClipboard.value = clip(3, 2, 6)
    pastePose(session)

    const meta = doc(session) as OwnedMetaDoc
    expect([meta.width, meta.height]).toEqual([3, 2])
    expect(meta.holes).toEqual([false, false, false, false, false, false])
    const pixels = posePixels(session, 0)
    expect(pixels.indices[0]).toBe(6)
    expect(pixels.indices[2 * 8]).toBe(0) // the empty tile column pasted as empty
    undo(session)
    expect([doc(session).width, doc(session).height]).toEqual([1, 1])
  })

  it('an animation keeps its window size and the paste is cut to it', async () => {
    const session = animSession(PATH)
    await settled()
    pictureClipboard.value = clip(3, 2, 6)
    pastePose(session)
    expect([doc(session).width, doc(session).height]).toEqual([1, 1])
    expect(posePixels(session, 0).indices[0]).toBe(6)
    expect(session.status).toMatch(/cut to 1×1/)
  })

  it('an imported picture floats, moves, and is cut into the pose at its size when placed', async () => {
    files[META] = serializeResource({ kind: 'metatiles', doc: { ...createOwnedMeta('sc2', 2, 1), holes: [true, true] } })
    const session = animSession(META)
    await settled()
    const before = posePixels(session, 0).indices[12]
    floatImage(session, clip(3, 2, 6).picture)
    moveFloat(session, 12, 0)
    placeFloat(session)

    const meta = doc(session) as OwnedMetaDoc
    expect([meta.width, meta.height]).toEqual([2, 1])
    expect(meta.holes).toEqual([true, false])
    const pixels = posePixels(session, 0)
    expect(pixels.indices[11]).not.toBe(6) // left of where it was dropped
    expect(pixels.indices[12]).toBe(6)
    expect(session.float).toBeNull()
    undo(session)
    expect(posePixels(session, 0).indices[12]).toBe(before)
  })

  it('a copied pose is on the clipboard, named after its file', async () => {
    const session = animSession(PATH)
    await settled()
    copyPose(session)
    expect(pictureClipboard.value?.from).toBe(PATH)
    expect(pictureClipboard.value?.picture.width).toBe(8)
  })
})
