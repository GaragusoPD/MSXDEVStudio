/**
 * The renderer half of the MCP server: each request answered through the same
 * store the equivalent button uses, and every answer — or failure — sent back.
 */

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpRendererResponse } from '../../shared/ipc'
import { answerMcpRequest } from './mcp-bridge'
import { useMcpStore } from './stores/mcpStore'
import { useTabsStore } from './stores/tabsStore'

// The real one reaches Monaco, which has no business in a node test. Saves
// every dirty tab except `stuck.c`, the way a failed save leaves it dirty.
vi.mock('./commands', () => ({
  saveAllTabs: vi.fn(async () => {
    const tabs = useTabsStore()
    for (const tab of tabs.tabs) if (tab.filePath !== 'stuck.c') tabs.setDirty(tab.id, false)
  })
}))
vi.mock('./components/resource-thumbnails', () => ({ thumbnailUrl: async (path: string) => `data:image/png;base64,${path}` }))

let responses: McpRendererResponse[]
let files: Record<string, string>

beforeEach(() => {
  setActivePinia(createPinia())
  responses = []
  files = {}
  ;(globalThis as { window?: unknown }).window = {
    api: {
      on: vi.fn(() => () => {}),
      invoke: vi.fn(async (channel: string, args: { path?: string; content?: string } & McpRendererResponse) => {
        if (channel === 'mcp:respond') responses.push(args)
        if (channel === 'fs:stat') return args.path! in files ? { isDirectory: false } : null
        if (channel === 'fs:write') files[args.path!] = args.content!
        if (channel === 'resources:list') return []
        return undefined
      })
    }
  }
})

describe('the MCP bridge', () => {
  it('lists the file tabs with their dirty flags, and opens one', async () => {
    const tabs = useTabsStore()
    tabs.openFile('src/main.c', 'main.c')
    tabs.setDirty('src/main.c', true)
    tabs.openFile('res/level.map.json', 'level.map.json')
    await answerMcpRequest({ id: 1, method: 'tabs', params: undefined })
    expect(responses[0]).toEqual({
      id: 1,
      ok: true,
      result: [
        { path: 'src/main.c', title: 'main.c', dirty: true, active: false },
        { path: 'res/level.map.json', title: 'level.map.json', dirty: false, active: true }
      ]
    })
    await answerMcpRequest({ id: 2, method: 'open', params: { path: 'src/main.c' } })
    expect(tabs.activeTab?.filePath).toBe('src/main.c')
  })

  it('saves all, and reports only the tabs that really were saved', async () => {
    const tabs = useTabsStore()
    for (const path of ['a.c', 'stuck.c', 'b.c']) tabs.openFile(path, path)
    tabs.setDirty('a.c', true)
    tabs.setDirty('stuck.c', true)
    await answerMcpRequest({ id: 8, method: 'saveAll', params: undefined })
    expect(responses[0]).toEqual({ id: 8, ok: true, result: ['a.c'] })
  })

  it('draws a preview with the Resources panel’s own thumbnail', async () => {
    await answerMcpRequest({ id: 9, method: 'preview', params: { path: 'res/t.tiles.json' } })
    expect(responses[0]).toEqual({ id: 9, ok: true, result: 'data:image/png;base64,res/t.tiles.json' })
  })

  it('shows a message, and fades it unless it is an error', async () => {
    vi.useFakeTimers()
    try {
      await answerMcpRequest({ id: 3, method: 'notify', params: { text: 'Built.', level: 'info' } })
      await answerMcpRequest({ id: 4, method: 'notify', params: { text: 'Broke.', level: 'error' } })
      expect(useMcpStore().messages.map((m) => m.text)).toEqual(['Built.', 'Broke.'])
      vi.advanceTimersByTime(9000)
      expect(useMcpStore().messages.map((m) => m.text)).toEqual(['Broke.'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('creates a resource as the Resources panel does, and opens it', async () => {
    await answerMcpRequest({ id: 5, method: 'createResource', params: { kind: 'map', name: 'forest!' } })
    expect(responses[0]).toEqual({ id: 5, ok: true, result: 'res/forest.map.json' })
    expect(JSON.parse(files['res/forest.map.json'])).toMatchObject({ version: 1, export: { out: 'content/forest_map.h' } })
    expect(useTabsStore().activeTab?.filePath).toBe('res/forest.map.json')
  })

  it('answers an unknown method — or a failure — with an error rather than silence', async () => {
    await answerMcpRequest({ id: 6, method: 'formatDisk', params: undefined })
    await answerMcpRequest({ id: 7, method: 'createResource', params: { kind: 'map', name: '!!!' } })
    expect(responses).toEqual([
      { id: 6, ok: false, error: 'The IDE has no "formatDisk"' },
      { id: 7, ok: false, error: '"!!!" has no letters or digits to name a file with' }
    ])
  })
})
