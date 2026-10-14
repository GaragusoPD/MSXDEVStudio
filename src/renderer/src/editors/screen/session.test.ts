/**
 * The screen editor's selection: move, cut/copy/paste, delete, and an import
 * that floats until it is dropped.
 *
 * A float lives on the session, above the document, so the ways it can go
 * wrong are all lifecycle: a float left out of a save, an undo that reaches
 * past it, a drop that lands as two undo steps or none. None of that is
 * visible from `shared/floating.ts`, which only knows grids.
 */

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportResult } from '../../composables/useImageImport'
import { serializeResource } from '../../../../shared/msx/resource'
import { blankConverted, decodeIndices, encodeIndices, normalizeScreen, screenPixels, type ScreenDoc } from '../../../../shared/msx/screen'
import { MSX1_PALETTE_GRB } from '../../../../shared/msx/palette'
import { resetExternalWatches } from '../external-changes'
import {
  canUndo,
  copySelection,
  cutSelection,
  deleteSelection,
  displayPixels,
  doc,
  dropFloat,
  importImage,
  liftSelection,
  moveFloatTo,
  nudgeSelection,
  pasteClipboard,
  pruneScreenSessions,
  redo,
  saveSession,
  screenSession,
  setSelection,
  setTool,
  undo,
  type ScreenSession
} from './session'

const PATH = 'res/title.screen.json'
let files: Record<string, string>
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** A 16×8 SCREEN 5 drawing with colour 3 at (1,1) and colour 4 at (2,1). */
function drawing(extra: Partial<ScreenDoc> = {}): ScreenDoc {
  const converted = blankConverted('sc5', 16, 8)
  const indices = decodeIndices(converted.indices)
  indices[1 * 16 + 1] = 3
  indices[1 * 16 + 2] = 4
  return { ...normalizeScreen({ mode: 'sc5', width: 16, height: 8 }), converted: { ...converted, indices: encodeIndices(indices) }, ...extra }
}

async function open(screen: ScreenDoc | null): Promise<ScreenSession> {
  if (screen) files[PATH] = serializeResource({ kind: 'screen', doc: screen })
  const session = screenSession(PATH)
  await settled()
  return session
}

function shown(session: ScreenSession): Uint8Array {
  return screenPixels(doc(session))!.indices
}

/** What the import dialog hands over: a `width × height` picture of one colour, converted with `palette`. */
function imported(width: number, height: number, color: number, palette: number[] | null = [...MSX1_PALETTE_GRB]): ImportResult {
  return {
    width,
    height,
    indices: new Uint8Array(width * height).fill(color),
    palette,
    rgb: [],
    report: { colorsUsed: 1, colorsMerged: 0, rowsAltered: 0, pixelsChanged: 0 }
  }
}

beforeEach(() => {
  resetExternalWatches()
  setActivePinia(createPinia())
  pruneScreenSessions(new Set())
  files = {}
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
})

describe('moving a selection', () => {
  it('floats above the picture while dragged, and lands as one undo step', async () => {
    const session = await open(drawing())
    setSelection(session, { x: 1, y: 1 }, { x: 2, y: 1 })
    expect(liftSelection(session)).toBe(true)
    moveFloatTo(session, { x: 5, y: 4 })
    moveFloatTo(session, { x: 6, y: 5 })

    // The canvas shows it moved; the document has not been touched.
    const display = displayPixels(session)!.indices
    expect(display[1 * 16 + 1]).toBe(0)
    expect(display[5 * 16 + 6]).toBe(3)
    expect(shown(session)[1 * 16 + 1]).toBe(3)
    expect(canUndo(session.history)).toBe(false)

    dropFloat(session)
    expect(session.float).toBeNull()
    expect(shown(session)[1 * 16 + 1]).toBe(0)
    expect([...shown(session).slice(5 * 16 + 6, 5 * 16 + 8)]).toEqual([3, 4])
    expect(session.selection).toEqual({ x: 6, y: 5, width: 2, height: 1 })
    expect(session.history.past).toHaveLength(1)

    undo(session)
    expect(shown(session)[1 * 16 + 1]).toBe(3)
    redo(session)
    expect(shown(session)[5 * 16 + 6]).toBe(3)
  })

  it('takes the float back on undo, and goes no further', async () => {
    const session = await open(drawing())
    setSelection(session, { x: 1, y: 1 }, { x: 1, y: 1 })
    nudgeSelection(session, 3, 0)
    expect(session.float).not.toBeNull()
    undo(session)
    expect(session.float).toBeNull()
    expect(session.selection).toEqual({ x: 1, y: 1, width: 1, height: 1 })
    expect(shown(session)[1 * 16 + 1]).toBe(3)
  })

  it('is not an edit when dropped where it was lifted', async () => {
    const session = await open(drawing())
    setSelection(session, { x: 1, y: 1 }, { x: 2, y: 1 })
    liftSelection(session)
    dropFloat(session)
    expect(canUndo(session.history)).toBe(false)
    expect(session.dirty).toBe(false)
  })

  it('duplicates when lifted as a copy', async () => {
    const session = await open(drawing())
    setSelection(session, { x: 1, y: 1 }, { x: 1, y: 1 })
    liftSelection(session, true)
    moveFloatTo(session, { x: 0, y: 0 })
    dropFloat(session)
    expect(shown(session)[0]).toBe(3)
    expect(shown(session)[1 * 16 + 1]).toBe(3)
  })

  it('records a move on a converted screen as retouch, so a reconversion replays it', async () => {
    const session = await open(drawing({ source: 'res/title.png' }))
    setSelection(session, { x: 1, y: 1 }, { x: 1, y: 1 })
    nudgeSelection(session, 0, 2)
    dropFloat(session)
    expect(doc(session).retouch).toEqual([1, 1, 0, 1, 3, 3])
    expect(doc(session).source).toBe('res/title.png')
  })

  it('is dropped by switching tools and by saving — what was on screen is what gets saved', async () => {
    const session = await open(drawing())
    setSelection(session, { x: 1, y: 1 }, { x: 1, y: 1 })
    nudgeSelection(session, 1, 0)
    setTool(session, 'pencil')
    expect(session.float).toBeNull()
    expect(shown(session)[1 * 16 + 2]).toBe(3)

    setTool(session, 'select')
    nudgeSelection(session, 1, 0)
    await saveSession(session)
    expect(session.float).toBeNull()
    const saved = normalizeScreen(JSON.parse(files[PATH]))
    expect(screenPixels(saved)!.indices[1 * 16 + 3]).toBe(3)
  })
})

describe('cut, copy, paste and delete', () => {
  it('cuts to the clipboard and pastes as a float to drag into place', async () => {
    const session = await open(drawing())
    setSelection(session, { x: 1, y: 1 }, { x: 2, y: 1 })
    cutSelection(session)
    expect(session.clipboard).toMatchObject({ width: 2, height: 1 })
    expect(shown(session)[1 * 16 + 1]).toBe(0)

    setTool(session, 'pencil')
    pasteClipboard(session)
    expect(session.tool).toBe('select')
    // At the selection's corner — where it was cut from — until it is dragged.
    expect(session.float).toMatchObject({ x: 1, y: 1, from: null })
    moveFloatTo(session, { x: 10, y: 6 })
    dropFloat(session)
    expect([...shown(session).slice(6 * 16 + 10, 6 * 16 + 12)]).toEqual([3, 4])
    expect(session.history.past).toHaveLength(2)
  })

  it('copies what floats, and deleting a lifted float keeps the hole it left', async () => {
    const session = await open(drawing())
    setSelection(session, { x: 1, y: 1 }, { x: 2, y: 1 })
    nudgeSelection(session, 0, 1)
    copySelection(session)
    expect(Array.from(session.clipboard!.values)).toEqual([3, 4])
    deleteSelection(session)
    expect(session.float).toBeNull()
    expect(shown(session).every((value) => value === 0)).toBe(true)
  })

  it('clears a plain selection to colour 0', async () => {
    const session = await open(drawing())
    setSelection(session, { x: 0, y: 0 }, { x: 15, y: 7 })
    deleteSelection(session)
    expect(shown(session).every((value) => value === 0)).toBe(true)
  })
})

describe('importing an image', () => {
  it('floats the picture over the screen, keeps the screen size, and lets index 0 show through', async () => {
    const session = await open(drawing())
    const picture = imported(2, 2, 7)
    picture.indices[0] = 0
    importImage(session, picture)
    expect(session.tool).toBe('select')
    expect(session.float).toMatchObject({ x: 0, y: 0, from: null, transparent: 0 })
    moveFloatTo(session, { x: 1, y: 0 })
    dropFloat(session)
    expect(doc(session).width).toBe(16)
    // The see-through top-left of the picture left (1,0) as it was; the rest is 7, over the old art at (1,1).
    expect(shown(session)[1]).toBe(0)
    expect(shown(session)[2]).toBe(7)
    expect([...shown(session).slice(16 + 1, 16 + 3)]).toEqual([7, 7])
    expect(session.history.past).toHaveLength(1)
  })

  it("turns a conversion into a drawing and takes the picture's palette when they differ", async () => {
    const palette = [...MSX1_PALETTE_GRB]
    palette[7] = 0x0777
    const session = await open(drawing({ source: 'res/title.png', retouch: [0, 0, 9] }))
    importImage(session, imported(1, 1, 7, palette))
    expect(session.status).toMatch(/palette/)
    moveFloatTo(session, { x: 4, y: 4 })
    dropFloat(session)
    const after = doc(session)
    expect(after.source).toBe('')
    expect(after.retouch).toEqual([])
    expect(after.converted!.palette![7]).toBe(0x0777)
    // The old retouch is baked in, not lost.
    expect(shown(session)[0]).toBe(9)
    expect(shown(session)[4 * 16 + 4]).toBe(7)

    undo(session)
    expect(doc(session).source).toBe('res/title.png')
    expect(doc(session).converted!.palette![7]).toBe(MSX1_PALETTE_GRB[7])
  })

  it('onto a screen never drawn, starts the canvas at the document size when it lands', async () => {
    const session = await open(normalizeScreen({ mode: 'sc5', width: 16, height: 8 }))
    expect(displayPixels(session)).toBeNull()
    importImage(session, imported(4, 4, 5))
    expect(displayPixels(session)).toMatchObject({ width: 16, height: 8 })
    moveFloatTo(session, { x: 12, y: 4 })
    dropFloat(session)
    expect(doc(session).converted).toMatchObject({ width: 16, height: 8 })
    expect(shown(session)[7 * 16 + 15]).toBe(5)
    expect(shown(session)[0]).toBe(0)
  })

  it('cancels with nothing to undo', async () => {
    const session = await open(drawing())
    importImage(session, imported(2, 2, 7))
    undo(session)
    expect(session.float).toBeNull()
    expect(session.selection).toBeNull()
    expect(canUndo(session.history)).toBe(false)
  })
})
