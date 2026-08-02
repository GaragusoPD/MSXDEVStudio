/**
 * Per-tab state for the bitmap screen editor (Spec 10 B).
 *
 * Same shape as `editors/tile/session.ts`: a module-level map keyed by tab id
 * (= the project-relative path). The doc's source of truth is the original
 * image + conversion settings (`shared/msx/screen.ts`'s `ScreenDoc`); this
 * file owns the parts that aren't persisted:
 *
 * - The decoded source `ImageData` (main can't decode PNGs — Spec 07's rule —
 *   so it's read once per session via the binary-safe `fs:readBinary` and kept
 *   in memory, never written back to the doc).
 * - Re-running `quantize()` synchronously (ponytail: no worker — this is a
 *   deliberate one-shot click when a mode/dither/palette setting changes, not
 *   live dragging like the import dialog's own worker-backed preview; move to
 *   a worker if reconversion ever needs to track every keystroke).
 * - Retouch strokes, going through `shared/screen-editor.ts`.
 */

import { shallowReactive } from 'vue'
import type { ImportResult } from '../../composables/useImageImport'
import { decode } from '../../composables/useImageImport'
import { isBitmapMode, type BitmapMode, type ScreenMode } from '../../../../shared/msx/modes'
import { quantize } from '../../../../shared/msx/quantize'
import { serializeResource } from '../../../../shared/msx/resource'
import { normalizeScreen, type ScreenConvert, type ScreenDoc } from '../../../../shared/msx/screen'
import {
  applyConversion,
  canRedo,
  canUndo,
  clearRetouch,
  createHistory,
  paintRetouch,
  pushHistory,
  redo as redoHistory,
  retouchFillPoints,
  setPaletteEntry,
  undo as undoHistory,
  type Point,
  type ScreenHistory
} from '../../../../shared/screen-editor'
import { useTabsStore } from '../../stores/tabsStore'

export type ScreenTool = 'pencil' | 'fill'

export interface ScreenSession {
  path: string
  history: ScreenHistory
  loading: boolean
  error: string | null
  dirty: boolean

  /** Decoded once from `doc.source` (or from a freshly picked file) — never persisted. */
  sourceImage: ImageData | null
  sourceError: string | null

  tool: ScreenTool
  color: number
  zoom: number
  status: string
  busy: boolean

  /** Doc for the retouch drag in progress; `doc()` reads this over `history.present`, same role
   *  as the map editor's `preview` (see `editors/map/session.ts`). */
  preview: ScreenDoc | null
}

const sessions = new Map<string, ScreenSession>()

export function screenSession(path: string): ScreenSession {
  const existing = sessions.get(path)
  if (existing) return existing
  const session = shallowReactive<ScreenSession>({
    path,
    history: createHistory(normalizeScreen({})),
    loading: true,
    error: null,
    dirty: false,
    sourceImage: null,
    sourceError: null,
    tool: 'pencil',
    color: 1,
    zoom: 2,
    status: '',
    busy: false,
    preview: null
  })
  sessions.set(path, session)
  void load(session)
  return session
}

/** Drops sessions for tabs that were closed. Called by the tab component when the tab set changes. */
export function pruneScreenSessions(openPaths: Set<string>): void {
  for (const path of [...sessions.keys()]) if (!openPaths.has(path)) sessions.delete(path)
}

export function doc(session: ScreenSession): ScreenDoc {
  return session.preview ?? session.history.present
}

async function load(session: ScreenSession): Promise<void> {
  try {
    const text = await window.api.invoke('fs:read', { path: session.path })
    // A brand-new file created via the Explorer is empty — that's a fresh screen, not an error.
    let raw: unknown = {}
    try {
      raw = text.trim() ? JSON.parse(text) : {}
    } catch {
      raw = {}
    }
    session.history = createHistory(normalizeScreen(raw))
    session.error = null
    await loadSourceImage(session)
  } catch (error) {
    session.error = `Couldn't open ${session.path}: ${String(error)}`
  } finally {
    session.loading = false
  }
}

async function loadSourceImage(session: ScreenSession): Promise<void> {
  const source = doc(session).source
  if (!source) {
    session.sourceImage = null
    session.sourceError = null
    return
  }
  try {
    const bytes = await window.api.invoke('fs:readBinary', { path: source })
    session.sourceImage = await decode(new Blob([bytes]))
    session.sourceError = null
  } catch (error) {
    session.sourceImage = null
    session.sourceError = `Couldn't load source image ${source}: ${String(error)}`
  }
}

export async function saveSession(session: ScreenSession): Promise<void> {
  await window.api.invoke('fs:write', { path: session.path, content: serializeResource({ kind: 'screen', doc: doc(session) }) })
  session.dirty = false
  useTabsStore().setDirty(session.path, false)
  session.status = 'Saved'
}

function markDirty(session: ScreenSession): void {
  session.dirty = true
  useTabsStore().setDirty(session.path, true)
}

/** Every mutation goes through here: pushes one undo step and marks the tab dirty (no-op if nothing changed). */
export function commit(session: ScreenSession, next: ScreenDoc): void {
  const history = pushHistory(session.history, next)
  if (history === session.history) return
  session.history = history
  markDirty(session)
}

// ── import / (re)conversion ─────────────────────────────────────────────

/** `basePath`'s folder + the picked file's own (sanitized) name — the default place a first import lands. */
function defaultSourcePath(basePath: string, fileName: string): string {
  const slash = basePath.lastIndexOf('/')
  const dir = slash === -1 ? '' : basePath.slice(0, slash)
  const safe = fileName.replace(/[^A-Za-z0-9._-]/g, '_') || 'source.png'
  return dir ? `${dir}/${safe}` : safe
}

/**
 * `ImportImageDialog`'s `@imported` handler: persists the picked file's bytes into the project
 * (reusing the existing path when replacing an already-set source) and bakes the dialog's own
 * conversion result into `doc.converted`.
 */
export async function importSource(session: ScreenSession, result: ImportResult, file: File | null, mode: ScreenMode): Promise<void> {
  if (!isBitmapMode(mode)) {
    session.status = `${mode} isn't a bitmap mode — pick one of sc5/6/7/8/10/12.`
    return
  }
  const current = doc(session)
  let source = current.source
  if (file) {
    try {
      source = current.source || defaultSourcePath(session.path, file.name)
      await window.api.invoke('fs:writeBinary', { path: source, content: await file.arrayBuffer() })
      session.sourceImage = await decode(file)
      session.sourceError = null
    } catch (error) {
      session.status = `Couldn't save source image: ${String(error)}`
      return
    }
  }
  commit(session, applyConversion({ ...current, mode, source }, result))
  session.status = `Converted: ${result.report.colorsUsed} colors used`
}

/** Re-runs `quantize()` against the already-decoded source with a settings patch (mode and/or convert options),
 *  baking the result straight into one undo step. With no source loaded yet, it just applies the settings. */
export function reconvertWith(session: ScreenSession, patch: { mode?: BitmapMode; convert?: Partial<ScreenConvert> }): void {
  const current = doc(session)
  const next: ScreenDoc = {
    ...current,
    mode: patch.mode ?? current.mode,
    convert: { ...current.convert, ...(patch.convert ?? {}) }
  }
  const image = session.sourceImage
  if (!image) {
    commit(session, next)
    return
  }
  session.busy = true
  try {
    const result = quantize(
      { width: image.width, height: image.height, data: image.data },
      { mode: next.mode, dither: next.convert.dither, palette: next.convert.palette }
    )
    commit(session, applyConversion(next, result))
    session.status = `Converted: ${result.report.colorsUsed} colors used`
  } finally {
    session.busy = false
  }
}

export function reconvertNow(session: ScreenSession): void {
  reconvertWith(session, {})
}

export function setPalette(session: ScreenSession, index: number, grb: number): void {
  commit(session, setPaletteEntry(doc(session), index, grb))
}

// ── retouch ──────────────────────────────────────────────────────────────

export function setTool(session: ScreenSession, tool: ScreenTool): void {
  session.tool = tool
}

export function setColor(session: ScreenSession, index: number): void {
  session.color = index
}

/** `points` come from `linePoints` (`shared/tile-editor.ts`) between drag samples, in image pixels. */
export function paintDrag(session: ScreenSession, points: Point[]): void {
  const base = session.preview ?? session.history.present
  session.preview = paintRetouch(base, points, session.color)
}

/** Ends the drag started by `paintDrag`: folds the preview into one undo step (no-op if nothing changed). */
export function finishDrag(session: ScreenSession): void {
  const preview = session.preview
  session.preview = null
  if (preview && preview !== session.history.present) commit(session, preview)
}

export function fillAt(session: ScreenSession, start: Point): void {
  const current = doc(session)
  const points = retouchFillPoints(current, start)
  if (!points.length) return
  commit(session, paintRetouch(current, points, session.color))
}

export function clearRetouchAction(session: ScreenSession): void {
  commit(session, clearRetouch(doc(session)))
}

// ── undo/redo ───────────────────────────────────────────────────────────

export function undo(session: ScreenSession): void {
  const next = undoHistory(session.history)
  if (next === session.history) return
  session.history = next
  session.preview = null
  markDirty(session)
}

export function redo(session: ScreenSession): void {
  const next = redoHistory(session.history)
  if (next === session.history) return
  session.history = next
  session.preview = null
  markDirty(session)
}

export { canRedo, canUndo }
