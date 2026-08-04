import type { Component } from 'vue'

export interface EditorRegistration {
  /** Lower-case file extensions this editor handles, without the dot. */
  extensions: string[]
  component: Component
  /**
   * Save / undo / redo for a tab this editor owns, keyed by its file path.
   * Each editor already implements them for its own Ctrl+S and toolbar; these
   * are what lets a caller that *isn't* the editor — the application menu,
   * Save All — reach them without knowing which editor it is talking to.
   * Omitted means "text file": the Monaco path in `monaco-models.ts`.
   */
  save?: (path: string) => Promise<void> | void
  undo?: (path: string) => void
  redo?: (path: string) => void
}

const registry = new Map<string, EditorRegistration>()

/**
 * Registers a Vue component as the editor for one or more file extensions.
 * Called by later specs (tile editor, sprite editor, map editor, …) — this
 * spec ships no registrations, just the mechanism.
 */
export function registerEditor(registration: EditorRegistration): void {
  for (const extension of registration.extensions) {
    registry.set(extension.toLowerCase(), registration)
  }
}

export function getEditorFor(extension: string): EditorRegistration | undefined {
  return registry.get(extension.toLowerCase())
}
