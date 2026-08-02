import { defineStore } from 'pinia'

export interface OutputLine {
  channel: string
  line: string
}

const MAX_LINES = 5000

/**
 * Backs the bottom panel's Output pane. Later specs (build, toolchain, git…)
 * write into this from wherever they stream long-running process output.
 */
export const useOutputStore = defineStore('output', {
  state: () => ({
    lines: [] as OutputLine[]
  }),

  actions: {
    append(channel: string, line: string): void {
      this.lines.push({ channel, line })
      // A verbose MSXgl build prints thousands of lines; keep the pane light.
      if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES)
    },

    clear(): void {
      this.lines = []
    }
  }
})
