/**
 * That an open editor notices its file changing underneath it.
 *
 * The subtle half is *not* reacting: the app's own save comes back through the
 * same watcher, so every session compares the incoming text against what it
 * would write. Get that comparison wrong — miss a sibling key, say — and saving
 * reloads over the work that was just saved.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetExternalWatches, watchResourceFile } from './external-changes'

let files: Record<string, string>
let pushed: ((payload: unknown) => void)[]

/** Fires `fs:changed` and waits for the debounce plus the read. */
async function changedOnDisk(path: string, text: string): Promise<void> {
  files[path] = text
  for (const handler of pushed) handler({ type: 'change', path })
  await new Promise((resolve) => setTimeout(resolve, 140))
}

beforeEach(() => {
  resetExternalWatches()
  files = { 'res/a.json': 'ORIGINAL' }
  pushed = []
  ;(globalThis as { window?: unknown }).window = {
    api: {
      on: vi.fn((channel: string, handler: (payload: unknown) => void) => {
        if (channel === 'fs:changed') pushed.push(handler)
      }),
      invoke: vi.fn(async (_channel: string, args: { path: string }) => files[args.path] ?? '')
    }
  }
})

/** A stand-in session: a document, a dirty flag, and a reload that re-reads. */
function session(initial: string) {
  const state = { held: initial, dirty: false, diverged: 0, reloads: 0 }
  const stop = watchResourceFile('res/a.json', {
    serialize: () => state.held,
    reload: () => {
      state.reloads++
      state.held = files['res/a.json']
    },
    isDirty: () => state.dirty,
    onDiverged: () => {
      state.diverged++
    }
  })
  return { state, stop }
}

describe('watchResourceFile', () => {
  it('adopts a file rewritten outside the app', async () => {
    const { state } = session('ORIGINAL')
    await changedOnDisk('res/a.json', 'REWRITTEN BY AN AGENT')
    expect(state.held).toBe('REWRITTEN BY AN AGENT')
    expect(state.reloads).toBe(1)
  })

  it('ignores the app\'s own save coming back through the watcher', async () => {
    const { state } = session('ORIGINAL')
    // Exactly what this session would write: it was us.
    await changedOnDisk('res/a.json', 'ORIGINAL')
    expect(state.reloads).toBe(0)
    expect(state.diverged).toBe(0)
  })

  it('never discards unsaved work, and says the two have diverged', async () => {
    const { state } = session('EDITED IN THE APP')
    state.dirty = true
    await changedOnDisk('res/a.json', 'EDITED ON DISK')
    expect(state.held).toBe('EDITED IN THE APP')
    expect(state.reloads).toBe(0)
    expect(state.diverged).toBe(1)
  })

  it('coalesces the burst one write can produce into a single reload', async () => {
    const { state } = session('ORIGINAL')
    files['res/a.json'] = 'NEW'
    // A truncate-then-write, or a formatter, fires several events.
    for (const handler of pushed) {
      handler({ type: 'change', path: 'res/a.json' })
      handler({ type: 'change', path: 'res/a.json' })
      handler({ type: 'change', path: 'res/a.json' })
    }
    await new Promise((resolve) => setTimeout(resolve, 140))
    expect(state.reloads).toBe(1)
  })

  it('stops when the session lets go', async () => {
    const { state, stop } = session('ORIGINAL')
    stop()
    await changedOnDisk('res/a.json', 'NEW')
    expect(state.reloads).toBe(0)
  })

  it('ignores events for other files, and non-change events', async () => {
    const { state } = session('ORIGINAL')
    files['res/b.json'] = 'SOMETHING ELSE'
    for (const handler of pushed) handler({ type: 'change', path: 'res/b.json' })
    for (const handler of pushed) handler({ type: 'unlink', path: 'res/a.json' })
    await new Promise((resolve) => setTimeout(resolve, 140))
    expect(state.reloads).toBe(0)
  })
})
