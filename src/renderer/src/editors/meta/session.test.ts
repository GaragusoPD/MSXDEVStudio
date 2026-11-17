/**
 * The bitmap meta session's wiring, which no shared module can reach.
 *
 * `paintBitmapMeta` is covered thoroughly next door; what is covered here is
 * whether a stroke *arrives* at it. Bugs found in this file by hand were of
 * that shape — a guard returning early, indistinguishable from a dead canvas —
 * and none was visible to any other suite.
 *
 * (A pattern-mode meta-tile owns its pixels and is edited by the pose editor in
 * `editors/anim/`; this session is the `.meta-btiles.json` editor only.)
 *
 * No DOM: `sheet()` is the only thing here that touches `document`, and it is
 * never called. `frameRgba` is what the animation bar draws a bitmap meta from,
 * and it is plain bytes for exactly that reason.
 */

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_BITMAP_TILES, normalizeBitmapTiles, tileImage } from '../../../../shared/msx/bitmap-tile'
import { createMetaTileDoc, frameTileAt } from '../../../../shared/msx/meta-tile'
import { paletteToRgb } from '../../../../shared/msx/palette'
import { serializeResource } from '../../../../shared/msx/resource'
import { encodeIndices } from '../../../../shared/msx/screen'
import { useTilesetStore } from '../../stores/tilesetStore'
import {
  beginStroke,
  doc,
  endStroke,
  metaSession,
  paint,
  pruneMetaSessions,
  reserveBitmapTile0,
  saveSession,
  setBackground,
  setColor,
  setDuration,
  frameDots,
  framePixels,
  frameRgba,
  setFrame,
  togglePlaying,
  addFrame,
  undo
} from './session'

const META = 'res/rock.meta-btiles.json'
const TILES = 'res/main.btiles.json'

let files: Record<string, string>

/** Waits for the session's own `load()` chain, which is async and untracked. */
const settled = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function tilesFile(over: Record<string, unknown> = {}): string {
  return serializeResource({
    kind: 'btiles',
    doc: normalizeBitmapTiles({ mode: 'sc5', width: 8, height: 8, count: 4, reserveTile0: true, ...over })
  })
}

const count = (): number => useTilesetStore().bitmapDoc(TILES)!.count

/** Sixteen distinct colours: sc5's default palette is all black, which would hide a wrong colour. */
const PALETTE = Array.from({ length: 16 }, (_, i) => ((i & 7) << 8) | (((i + 3) & 7) << 4) | ((i + 5) & 7))

const opaque = (index: number): number[] => {
  const { r, g, b } = paletteToRgb(PALETTE)[index]
  return [r, g, b, 255]
}

const rgbaAt = (image: { width: number; data: ArrayLike<number> }, x: number, y: number): number[] => {
  const at = (y * image.width + x) * 4
  return Array.from({ length: 4 }, (_, i) => image.data[at + i])
}

const cellPoints = (ox: number, oy: number, size: number): { x: number; y: number }[] =>
  Array.from({ length: size }, (_, y) => Array.from({ length: size }, (_, x) => ({ x: ox + x, y: oy + y }))).flat()

beforeEach(() => {
  setActivePinia(createPinia())
  files = {
    [META]: serializeResource({ kind: 'metabtiles', doc: createMetaTileDoc(TILES, 2, 2) }),
    [TILES]: tilesFile()
  }
  ;(globalThis as { window?: unknown }).window = {
    // reserveBitmapTile0() asks before a migration; every test here says yes.
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

    paint(session, [{ x: 0, y: 0 }])
    expect(frameTileAt(doc(session), 0, 0, 0)).not.toBe(0)
    expect(count()).toBe(5)
    expect(session.dirty).toBe(true)
  })

  it('says why when there is no tileset, rather than doing nothing', async () => {
    files[META] = serializeResource({ kind: 'metabtiles', doc: createMetaTileDoc('', 2, 2) })
    const session = metaSession(META)
    await settled()

    paint(session, [{ x: 0, y: 0 }])
    expect(session.status).toMatch(/Pick a tileset/)
  })

  it("tracks the cell the stroke landed in, in the tileset's own cell size", async () => {
    files[TILES] = tilesFile({ width: 16, height: 16 })
    const session = metaSession(META)
    await settled()

    // 9 is still cell 0 at 16 dots; an 8-dot grid would say 1.
    paint(session, [{ x: 9, y: 17 }])
    expect(session.activeCell).toEqual({ x: 0, y: 1 })
  })

  it('leaves the tileset alone when the same pixel is painted twice', async () => {
    const session = metaSession(META)
    await settled()

    paint(session, [{ x: 0, y: 0 }])
    const after = count()
    paint(session, [{ x: 0, y: 0 }])
    // The second stroke derives the same tile, so dedup finds it.
    expect(count()).toBe(after)
  })

  it('says so when the bank is full, and clears it once a stroke lands', async () => {
    files[TILES] = tilesFile({ count: MAX_BITMAP_TILES })
    const session = metaSession(META)
    await settled()

    paint(session, [{ x: 0, y: 0 }])
    expect(session.blocked).toBeTruthy()
    expect(frameTileAt(doc(session), 0, 0, 0)).toBe(0)

    // Painting colour 0 over a blank cell resolves to the reserved blank, which
    // needs no room.
    setColor(session, 0)
    paint(session, [{ x: 0, y: 0 }])
    expect(session.blocked).toBeNull()
  })
})

describe('a drag is one edit, not one per sample', () => {
  /** The reported failure: intermediate tiles piling up while drawing. */
  it('mints tiles for the final shape only, however many samples the drag has', async () => {
    const session = metaSession(META)
    await settled()
    const before = count()

    // Forty samples across one row, as a real pointer drag produces.
    beginStroke(session, 'fg')
    for (let x = 0; x < 8; x++) {
      for (let sample = 0; sample < 5; sample++) paint(session, [{ x, y: 0 }], 'fg')
    }
    // Nothing has reached the bank yet — the canvas is drawing a preview.
    expect(count()).toBe(before)
    endStroke(session)

    // One cell changed, so one tile. Not forty.
    expect(count()).toBe(before + 1)
  })

  it('is one undo step, so undo takes back the whole drag', async () => {
    const session = metaSession(META)
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
    const before = count()

    // Draw, redraw, redraw — each stroke supersedes the last, so two of the
    // three tiles end up referenced by nothing.
    for (const colour of [15, 4, 6]) {
      setColor(session, colour)
      paint(session, [{ x: 0, y: 0 }], 'fg')
    }
    expect(count()).toBe(before + 3)

    await saveSession(session)
    expect(count()).toBe(before + 1)
    expect(session.status).toMatch(/reclaimed 2 unused tiles/i)
    // The surviving tile is still the one the meta points at, and holds the
    // last colour painted.
    const tile = frameTileAt(doc(session), 0, 0, 0)
    expect(tile).not.toBe(0)
    expect(tileImage(useTilesetStore().bitmapDoc(TILES)!, tile)[0]).toBe(6)
  })
})

describe('reserving tile 0 on a tileset that already holds art', () => {
  it('blanks the new tile 0, shifts the art up, and renumbers the meta', async () => {
    files[TILES] = tilesFile({ reserveTile0: false, count: 1 })
    const session = metaSession(META)
    await settled()
    paint(session, [{ x: 0, y: 0 }])
    const painted = frameTileAt(doc(session), 0, 0, 0)

    reserveBitmapTile0(session)
    const tiles = useTilesetStore().bitmapDoc(TILES)!
    expect(tiles.reserveTile0).toBe(true)
    expect([...tileImage(tiles, 0)].every((p) => p === 0)).toBe(true)
    expect(frameTileAt(doc(session), 0, 0, 0)).toBe(painted + 1)
    expect(tileImage(tiles, painted + 1)[0]).toBe(15)
  })

  it('refuses a full bank rather than dropping the last tile', async () => {
    files[TILES] = tilesFile({ reserveTile0: false, count: MAX_BITMAP_TILES })
    const session = metaSession(META)
    await settled()

    reserveBitmapTile0(session)
    expect(useTilesetStore().bitmapDoc(TILES)!.reserveTile0).toBe(false)
    expect(session.status).toMatch(/full/)
  })
})

describe('frame durations', () => {
  it('setDuration is one undo step and marks the session dirty', async () => {
    const session = metaSession(META)
    await settled()
    expect(doc(session).frames[0].duration).toBe(8)

    setDuration(session, 0, 20)
    expect(doc(session).frames[0].duration).toBe(20)
    expect(session.dirty).toBe(true)

    undo(session)
    expect(doc(session).frames[0].duration).toBe(8)
  })

  it('an unchanged or out-of-range duration adds no step', async () => {
    const session = metaSession(META)
    await settled()
    const before = session.history

    setDuration(session, 0, 8)
    setDuration(session, 9, 20)
    expect(session.history).toBe(before)
    expect(session.dirty).toBe(false)
  })

  it('a copied frame lands after its source and becomes the current one', async () => {
    const session = metaSession(META)
    await settled()
    addFrame(session)
    setDuration(session, 0, 20)
    addFrame(session, 0)

    expect(session.frame).toBe(1)
    expect(doc(session).frames.map((f) => f.duration)).toEqual([20, 20, 8])
  })

  it('a blank frame is appended and becomes the current one', async () => {
    const session = metaSession(META)
    await settled()
    addFrame(session)
    addFrame(session)
    expect(session.frame).toBe(2)
  })
})

describe('the animation bar state', () => {
  it('the preview background defaults to checkered and changing it is not an edit', async () => {
    const session = metaSession(META)
    await settled()
    expect(session.background).toBe('checkered')

    const before = session.history
    setBackground(session, 'solid')
    expect(session.background).toBe('solid')
    expect(session.dirty).toBe(false)
    expect(session.history).toBe(before)
  })

  it('togglePlaying flips only playing: the frame and the document stay', async () => {
    const session = metaSession(META)
    await settled()
    addFrame(session)
    addFrame(session)
    setFrame(session, 1)
    const before = doc(session)

    togglePlaying(session)
    expect(session.playing).toBe(true)
    expect(session.frame).toBe(1)
    expect(doc(session)).toBe(before)

    togglePlaying(session)
    expect(session.playing).toBe(false)
    expect(session.frame).toBe(1)
  })

  it('a frame is drawn the way the canvas draws it: colour 0 inside a tile shows the background', async () => {
    files[TILES] = tilesFile({ palette: PALETTE })
    const session = metaSession(META)
    await settled()
    // A whole painted tile, then one dot erased inside it: Erase paints index 0.
    paint(session, cellPoints(0, 0, 8))
    setColor(session, 0)
    paint(session, [{ x: 3, y: 2 }])
    expect(frameTileAt(doc(session), 0, 0, 0)).not.toBe(0)

    const { width, height, indices } = framePixels(session, 0)
    expect({ width, height }).toEqual({ width: 16, height: 16 })
    expect(indices[2 * width + 3]).toBe(0)
    expect(indices[2 * width + 4]).toBe(15)

    const image = frameRgba(session, 0)
    expect(image).toMatchObject({ width: 16, height: 16 })
    expect(image.data).toHaveLength(16 * 16 * 4)
    expect(rgbaAt(image, 4, 2)).toEqual(opaque(15))
    expect(rgbaAt(image, 3, 2)[3]).toBe(0)
    // The cells still holding tile 0 are see-through as a whole.
    expect(rgbaAt(image, 12, 3)[3]).toBe(0)
    expect(rgbaAt(image, 5, 12)[3]).toBe(0)
  })

  it('colour 0 is see-through whether or not the tileset nominates a transparent colour', async () => {
    for (const transparent of [0, null]) {
      pruneMetaSessions(new Set())
      setActivePinia(createPinia())
      files[TILES] = tilesFile({ palette: PALETTE, transparent })
      const session = metaSession(META)
      await settled()
      expect(useTilesetStore().bitmapDoc(TILES)!.transparent).toBe(transparent)
      paint(session, cellPoints(0, 0, 8))
      setColor(session, 0)
      paint(session, [{ x: 0, y: 0 }])
      expect(rgbaAt(frameRgba(session, 0), 0, 0)[3]).toBe(0)
      expect(rgbaAt(frameRgba(session, 0), 1, 0)).toEqual(opaque(15))
    }
  })

  it('a cell holding tile 0 is a hole even when tile 0 has art, as the emitted C skips it', async () => {
    files[TILES] = tilesFile({ palette: PALETTE, reserveTile0: false, count: 1, pixels: encodeIndices(new Uint8Array(64).fill(9)) })
    const session = metaSession(META)
    await settled()
    expect(tileImage(useTilesetStore().bitmapDoc(TILES)!, 0)[0]).toBe(9)
    expect(framePixels(session, 0).indices.every((index) => index === 0)).toBe(true)
    expect(frameRgba(session, 0).data.every((byte) => byte === 0)).toBe(true)
  })

  it('shows a stroke still in progress, as the canvas does', async () => {
    files[TILES] = tilesFile({ palette: PALETTE })
    const session = metaSession(META)
    await settled()
    setColor(session, 6)
    beginStroke(session, 'fg')
    paint(session, [{ x: 9, y: 1 }], 'fg')
    // Not committed yet: the canvas and the bar both draw the preview.
    expect(frameTileAt(session.history.present, 0, 1, 0)).toBe(0)
    expect(framePixels(session, 0).indices[1 * 16 + 9]).toBe(6)
    expect(rgbaAt(frameRgba(session, 0), 9, 1)).toEqual(opaque(6))
    endStroke(session)
  })

  it('a frame with no tileset is blank, at the size the canvas measures', async () => {
    files[META] = serializeResource({ kind: 'metabtiles', doc: createMetaTileDoc('', 3, 2) })
    const session = metaSession(META)
    await settled()
    const { width, height, indices } = framePixels(session, 0)
    expect({ width, height }).toEqual({ width: 48, height: 32 })
    expect(indices).toHaveLength(48 * 32)
    expect(indices.every((index) => index === 0)).toBe(true)
    expect(frameRgba(session, 0).data.every((byte) => byte === 0)).toBe(true)
  })

  it("frameDots uses the tileset's tile size, not the mirrored cell", async () => {
    files[TILES] = tilesFile({ width: 16, height: 16 })
    const session = metaSession(META)
    await settled()
    // No mirrored cell at all, then a stale 8x8 one: both must read 2x2 tiles of 16.
    expect(doc(session).cell).toBeFalsy()
    expect(frameDots(session)).toEqual({ width: 32, height: 32 })
    session.history = { ...session.history, present: { ...doc(session), cell: { width: 8, height: 8, cols: 8 } } }
    expect(frameDots(session)).toEqual({ width: 32, height: 32 })
  })
})
