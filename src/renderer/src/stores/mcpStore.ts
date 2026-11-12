import { defineStore } from 'pinia'
import type { McpSettings, McpStatus } from '../../../shared/ipc'

/** A message an agent asked the IDE to show (`show_message`). */
export interface AgentMessage {
  id: number
  text: string
  level: 'info' | 'warning' | 'error'
}

/**
 * Spec 17: the renderer's view of the MCP server — whether it is running, for
 * the status bar and Preferences — and the messages an agent sent the user.
 */
export const useMcpStore = defineStore('mcp', {
  state: () => ({
    status: null as McpStatus | null,
    messages: [] as AgentMessage[],
    nextId: 1
  }),

  actions: {
    async init(): Promise<void> {
      window.api.on('mcp:statusChanged', (status) => {
        this.status = status
      })
      this.status = await window.api.invoke('mcp:status', undefined)
    },

    async configure(settings: Partial<McpSettings>): Promise<McpStatus> {
      this.status = await window.api.invoke('mcp:configure', settings)
      return this.status
    },

    /** Shows a message for a while; an error stays until dismissed. */
    show(text: string, level: AgentMessage['level']): void {
      const id = this.nextId++
      this.messages.push({ id, text, level })
      // A few at a time: an agent looping on show_message must not bury the window.
      if (this.messages.length > 4) this.messages.splice(0, this.messages.length - 4)
      if (level !== 'error') setTimeout(() => this.dismiss(id), level === 'warning' ? 12000 : 8000)
    },

    dismiss(id: number): void {
      this.messages = this.messages.filter((message) => message.id !== id)
    }
  }
})
