/**
 * That settings survive a restart.
 *
 * The bug this exists for looked like the feature was never written: a
 * preference applied live — the store patches itself first — while the IPC that
 * was supposed to persist it threw `An object could not be cloned`, because
 * anything read off a Pinia state object is a reactive proxy and structured
 * clone refuses to copy one. Nothing on screen said so, and the value was gone
 * on the next launch.
 *
 * So these assert the *payload*, not just the local state.
 */

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../../shared/ipc'
import { useAppStore } from './appStore'

let sent: Partial<AppState>[]
let stored: AppState | null

beforeEach(() => {
  setActivePinia(createPinia())
  sent = []
  stored = null
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    if (channel === 'app:setState') {
      sent.push(payload as Partial<AppState>)
      // Main merges shallowly onto what it holds, exactly as StateService does.
      stored = { ...(stored ?? ({} as AppState)), ...(payload as Partial<AppState>) }
      return stored
    }
    if (channel === 'app:getState') return stored
    throw new Error(`unexpected channel ${channel}`)
  })
  ;(globalThis as { window?: unknown }).window = { api: { invoke, on: vi.fn() } }
})

describe('persisting preferences', () => {
  it('sends the whole group, so main can merge it', async () => {
    const app = useAppStore()
    await app.patchPreferences('editor', { size: 18 })

    expect(sent).toHaveLength(1)
    expect(sent[0].preferences).toEqual({
      editor: { family: null, size: 18 },
      terminal: { family: null, size: 13 }
    })
  })

  it('sends data structured clone can actually copy', async () => {
    const app = useAppStore()
    await app.patchPreferences('editor', { family: 'Fira Code', size: 15 })

    // The exact failure: IPC uses structured clone, and a reactive proxy — which
    // is what `this.preferences` hands back — makes it throw.
    expect(() => structuredClone(sent[0])).not.toThrow()
  })

  it('leaves the other groups alone', async () => {
    const app = useAppStore()
    await app.patchPreferences('terminal', { size: 20 })
    await app.patchPreferences('editor', { family: 'Menlo' })

    expect(app.preferences.terminal.size).toBe(20)
    expect(app.preferences.editor.family).toBe('Menlo')
    expect(sent[1].preferences).toEqual({
      editor: { family: 'Menlo', size: 13 },
      terminal: { family: null, size: 20 }
    })
  })

  it('round-trips: what was sent is what a restart loads back', async () => {
    const app = useAppStore()
    await app.patchPreferences('editor', { family: 'Fira Code', size: 16 })

    // A fresh session against the same persisted state, as a restart is.
    setActivePinia(createPinia())
    const restarted = useAppStore()
    await restarted.load()
    expect(restarted.preferences.editor).toEqual({ family: 'Fira Code', size: 16 })
  })
})
