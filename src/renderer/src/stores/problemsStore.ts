import { defineStore } from 'pinia'

export interface Problem {
  id: string
  severity: 'error' | 'warning' | 'info'
  message: string
  file?: string
  line?: number
}

/**
 * Backs the bottom panel's Problems pane. Later specs (build diagnostics,
 * config validation…) report into this store; empty until then.
 */
export const useProblemsStore = defineStore('problems', {
  state: () => ({
    problems: [] as Problem[]
  }),

  actions: {
    set(problems: Problem[]): void {
      this.problems = problems
    },

    clear(): void {
      this.problems = []
    }
  }
})
