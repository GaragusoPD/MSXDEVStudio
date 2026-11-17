/**
 * The sprite session's wiring that the shared bar leans on. The bar only says
 * "move frame a to b"; whether the selection goes with the frame is decided
 * here, and a wrong answer is invisible in a screenshot — the highlight simply
 * sits on the neighbour, and pressing "Move later" twice swaps it back.
 */

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { serializeResource } from '../../../../shared/msx/resource'
import { createSpritesDoc } from '../../../../shared/msx/sprite'
import { addFrame, setFrameDuration } from '../../../../shared/sprite-editor'
import { canUndo, doc, moveFrame, pruneSpriteSessions, selectFrame, spriteSession, undo } from './session'

const PATH = 'res/hero.sprites.json'

/** Three frames told apart by how long each is held: 3, 6, 9. */
function threeFrames(): string {
  let sheet = createSpritesDoc()
  sheet = addFrame(addFrame(sheet, 0), 0)
  sheet = [3, 6, 9].reduce((d, duration, i) => setFrameDuration(d, 0, i, duration), sheet)
  return serializeResource({ kind: 'sprites', doc: sheet })
}

const durations = (session: ReturnType<typeof spriteSession>): number[] => doc(session).sprites[0].frames.map((f) => f.duration)

/** Waits for the session's own `load()`, which is async and untracked. */
const settled = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  setActivePinia(createPinia())
  const files: Record<string, string> = { [PATH]: threeFrames() }
  ;(globalThis as { window?: unknown }).window = {
    api: {
      on: vi.fn(),
      invoke: vi.fn(async (channel: string, args: { path: string }) => {
        if (channel === 'fs:read') return files[args.path] ?? ''
        throw new Error(`unexpected channel ${channel}`)
      })
    }
  }
  pruneSpriteSessions(new Set())
})

describe('moveFrame', () => {
  it('takes the selection with the moved frame, so moving twice keeps going', async () => {
    const session = spriteSession(PATH)
    await settled()
    selectFrame(session, 0)

    moveFrame(session, 0, 1)
    expect(durations(session)).toEqual([6, 3, 9])
    expect(session.selection.frame).toBe(1)

    moveFrame(session, session.selection.frame, session.selection.frame + 1)
    expect(durations(session)).toEqual([6, 9, 3])
    expect(session.selection.frame).toBe(2)
  })

  it('is one undo step', async () => {
    const session = spriteSession(PATH)
    await settled()

    moveFrame(session, 2, 0)
    expect(durations(session)).toEqual([9, 3, 6])
    expect(session.dirty).toBe(true)
    undo(session)
    expect(durations(session)).toEqual([3, 6, 9])
    expect(canUndo(session)).toBe(false)
  })

  it('selects a frame dragged from elsewhere', async () => {
    const session = spriteSession(PATH)
    await settled()
    selectFrame(session, 1)

    moveFrame(session, 2, 0)
    expect(session.selection.frame).toBe(0)
    expect(durations(session)[session.selection.frame]).toBe(9)
  })

  it('keeps the moved frame’s hidden planes, since it is still the frame being edited', async () => {
    const session = spriteSession(PATH)
    await settled()
    selectFrame(session, 0)
    session.hiddenLayers = [0]

    moveFrame(session, 0, 2)
    expect(session.hiddenLayers).toEqual([0])

    moveFrame(session, 0, 1)
    expect(session.hiddenLayers).toEqual([])
  })

  it('changes nothing for a move onto itself or out of range', async () => {
    const session = spriteSession(PATH)
    await settled()
    selectFrame(session, 1)

    moveFrame(session, 1, 1)
    moveFrame(session, 1, 5)
    expect(durations(session)).toEqual([3, 6, 9])
    expect(session.selection.frame).toBe(1)
    expect(session.dirty).toBe(false)
    expect(canUndo(session)).toBe(false)
  })
})
