/**
 * Spec 17: the renderer half of the MCP server. `main/services/mcp-service.ts`
 * owns the server and everything the main process can do on its own (the
 * build, the files, the emulator); what only the window knows — the open tabs
 * and whether they have unsaved changes, how to open an editor, what a resource
 * looks like, where to show the user a message — it asks for over
 * `mcp:request`, and this answers over `mcp:respond`.
 *
 * Every method goes through the same store action or command the equivalent
 * button uses, so an agent opening a file or saving all is indistinguishable
 * from the user doing it.
 */

import type { McpRendererRequest } from '../../shared/ipc'
import type { ResourceKind } from '../../shared/msx/resource'
import { saveAllTabs } from './commands'
import { thumbnailUrl } from './components/resource-thumbnails'
import { useMcpStore } from './stores/mcpStore'
import { useResourcesStore } from './stores/resourcesStore'
import { useTabsStore } from './stores/tabsStore'

type Handler = (params: never) => unknown

const fileName = (path: string): string => path.split('/').pop() ?? path

export const mcpHandlers: Record<string, Handler> = {
  tabs: () => {
    const tabs = useTabsStore()
    return tabs.tabs
      .filter((tab) => tab.filePath)
      .map((tab) => ({ path: tab.filePath!, title: tab.title, dirty: tab.dirty, active: tab.id === tabs.activeTabId }))
  },

  open: ({ path }: { path: string }) => {
    useTabsStore().openFile(path, fileName(path))
  },

  saveAll: async () => {
    const dirty = useTabsStore()
      .tabs.filter((tab) => tab.dirty && tab.filePath)
      .map((tab) => tab.filePath!)
    await saveAllTabs()
    // What is still dirty failed, and saveAllTabs already said why in Output.
    const still = new Set(useTabsStore().tabs.filter((tab) => tab.dirty).map((tab) => tab.filePath))
    return dirty.filter((path) => !still.has(path))
  },

  notify: ({ text, level }: { text: string; level: 'info' | 'warning' | 'error' }) => {
    useMcpStore().show(text, level)
  },

  preview: ({ path }: { path: string }) => thumbnailUrl(path),

  createResource: async ({ kind, name }: { kind: ResourceKind; name: string }) => {
    const path = await useResourcesStore().createResource(kind, name)
    useTabsStore().openFile(path, fileName(path))
    return path
  }
}

/** Answers one request; exported for tests. */
export async function answerMcpRequest(request: McpRendererRequest): Promise<void> {
  const handler = mcpHandlers[request.method]
  try {
    if (!handler) throw new Error(`The IDE has no "${request.method}"`)
    const result = await handler(request.params as never)
    await window.api.invoke('mcp:respond', { id: request.id, ok: true, result })
  } catch (error) {
    await window.api.invoke('mcp:respond', {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

/** Subscribes once, from App.vue, with the rest of the workbench. */
export function initMcpBridge(): () => void {
  void useMcpStore().init()
  return window.api.on('mcp:request', (request) => void answerMcpRequest(request))
}
