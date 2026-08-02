import type { Component } from 'vue'

export interface EditorRegistration {
  /** Lower-case file extensions this editor handles, without the dot. */
  extensions: string[]
  component: Component
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
