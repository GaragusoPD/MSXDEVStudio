import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { WindowApi } from '../shared/ipc'

const api: WindowApi = {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  on: (channel, handler) => {
    const listener = (_event: IpcRendererEvent, payload: unknown): void =>
      handler(payload as never)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

// contextIsolation is always on (see src/main/index.ts) — window.api is the
// only surface the renderer ever gets. No other ipcRenderer access is exposed.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error('[preload] failed to expose window.api', error)
  }
} else {
  // @ts-expect-error — fallback for contextIsolation disabled (not expected)
  window.api = api
}
