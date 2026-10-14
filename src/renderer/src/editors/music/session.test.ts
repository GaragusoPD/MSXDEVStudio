import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeMusic, type MusicDoc } from '../../../../shared/msx/music'
import { parseResource, serializeResource } from '../../../../shared/msx/resource'
import { resetExternalWatches } from '../external-changes'
import {
  beginDrag,
  canUndo,
  currentSong,
  doc,
  endDrag,
  moveDrag,
  musicSession,
  pruneMusicSessions,
  saveSession,
  undo,
  type MusicSession
} from './session'

const PATH = 'res/music.music.json'
let files: Record<string, string>
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const note = (row: number, length: number, pitch: number) => ({ row, length, pitch, instrument: 0, volume: 15 })

beforeEach(() => {
  resetExternalWatches()
  setActivePinia(createPinia())
  files = {
    [PATH]: serializeResource({
      kind: 'music',
      doc: normalizeMusic({ instruments: [{ name: 'lead' }], songs: [{ name: 'theme', bars: 1, channels: [[note(0, 4, 60)], [], []] }] })
    })
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
  pruneMusicSessions(new Set())
})

async function open(): Promise<MusicSession> {
  const session = musicSession(PATH)
  await settled()
  return session
}

describe('music session', () => {
  it('loads the bank from disk', async () => {
    const session = await open()
    expect(session.error).toBeNull()
    expect(currentSong(session).channels[0]).toEqual([note(0, 4, 60)])
  })

  it('lands a drawn note as one undo step and selects it', async () => {
    const session = await open()
    beginDrag(session, { kind: 'draw', channel: 0, origin: note(8, 2, 64) }, 8, 64)
    moveDrag(session, 9, 64)
    moveDrag(session, 11, 64)
    // While dragging, the draft is what the roll shows; nothing is committed yet.
    expect(currentSong(session).channels[0]).toEqual([note(0, 4, 60), note(8, 4, 64)])
    expect(canUndo(session)).toBe(false)
    endDrag(session)
    expect(doc(session).songs[0].channels[0]).toEqual([note(0, 4, 60), note(8, 4, 64)])
    expect(session.selected).toBe(1)
    expect(session.dirty).toBe(true)
    expect(session.history.past).toHaveLength(1)
  })

  it('keeps a moved note selected where it landed', async () => {
    const session = await open()
    const original = currentSong(session).channels[0][0]
    beginDrag(session, { kind: 'move', channel: 0, index: 0, original, grabRow: 1, grabPitch: 60 }, 1, 60)
    moveDrag(session, 11, 67)
    endDrag(session)
    expect(currentSong(session).channels[0]).toEqual([note(10, 4, 67)])
    expect(session.selected).toBe(0)
  })

  it('erases everything a right-drag crosses, in one step', async () => {
    const session = await open()
    beginDrag(session, { kind: 'erase', channel: 0 }, 2, 60)
    endDrag(session)
    expect(currentSong(session).channels[0]).toEqual([])
    undo(session)
    expect(currentSong(session).channels[0]).toEqual([note(0, 4, 60)])
  })

  it('a click on nothing changes nothing, and records nothing', async () => {
    const session = await open()
    beginDrag(session, { kind: 'erase', channel: 0 }, 10, 90)
    endDrag(session)
    expect(canUndo(session)).toBe(false)
    expect(session.dirty).toBe(false)
  })

  it('saves what it holds', async () => {
    const session = await open()
    beginDrag(session, { kind: 'draw', channel: 2, origin: note(4, 1, 48) }, 4, 48)
    endDrag(session)
    await saveSession(session)
    const saved = parseResource(PATH, files[PATH]) as { kind: 'music'; doc: MusicDoc }
    expect(saved.doc.songs[0].channels[2]).toEqual([note(4, 1, 48)])
    expect(session.dirty).toBe(false)
  })
})
