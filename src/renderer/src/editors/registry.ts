import type { Component } from 'vue'
import { isBinaryExtension } from '../../../shared/file-kind'

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
  /**
   * Tear-down for a tab this editor owns, keyed by tab **id** rather than path
   * — a synthetic tab (a terminal) has no path, and it is what holds the
   * resource that must be released.
   */
  close?: (id: string) => void
}

const registry = new Map<string, EditorRegistration>()
/** What opens a file no specific editor claimed. See `registerFallbackEditor`. */
let fallback: EditorRegistration | null = null

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

/**
 * The editor for everything nothing else claimed — the plain text one.
 *
 * Registered rather than hardcoded in `EditorArea` so that component stays
 * agnostic about what a text editor is, which is the same reason the specific
 * editors register themselves.
 */
export function registerFallbackEditor(registration: EditorRegistration): void {
  fallback = registration
}

/**
 * The editor for `extension`, or undefined when the file cannot be edited here.
 *
 * A specific registration wins; anything else is text. That default is the
 * point: a project holds shell scripts, batch files, READMEs, `.gitignore`,
 * makefiles and files with no extension at all, and an allowlist makes every
 * one of them a bug report. Only known-binary types get nothing — opening a ROM
 * or a PNG as text shows mojibake and, for a large one, can lock the window up.
 */
export function getEditorFor(extension: string): EditorRegistration | undefined {
  const specific = registry.get(extension.toLowerCase())
  if (specific) return specific
  return isBinaryExtension(extension) ? undefined : (fallback ?? undefined)
}
