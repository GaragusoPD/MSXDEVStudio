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
import { decode, fitToMode } from '../../composables/useImageImport'
import { BITMAP_MODES, isBitmapMode, type BitmapMode, type ScreenMode } from '../../../../shared/msx/modes'
import { quantize } from '../../../../shared/msx/quantize'
import { serializeResource } from '../../../../shared/msx/resource'
import {
  blankConverted,
  normalizeScreen,
  resizeScreen,
  screenPixels,
  type ScreenConvert,
  type ScreenDoc
} from '../../../../shared/msx/screen'
import {
  applyConversion,
  canRedo,
  canUndo,
  clearRetouch,
  createHistory,
  paintScreen,
  pushHistory,
  redo as redoHistory,
  retouchFillPoints,
  setPaletteEntry,
  undo as undoHistory,
  type Point,
  type ScreenHistory
} from '../../../../shared/screen-editor'
import { bitmapToolPoints, type TileTool } from '../../../../shared/bitmap-tile-editor'
import { useTabsStore } from '../../stores/tabsStore'
import { watchResourceFile } from '../external-changes'

/**
 * `TileTool`'s four plus the two this editor adds. Pencil/line/rect/fill are
 * `bitmapToolPoints`' — the same geometry the bitmap tileset editor uses, over
 * whatever index buffer it is handed — so this editor gains line and rectangle
 * without a second implementation of Bresenham.
 */
export type ScreenTool = TileTool | 'pick' | 'cut'

export interface ScreenSession {
  path: string
  /** Drops this session's file watch. */
  stopWatching: (() => void) | null
  history: ScreenHistory
  loading: boolean
  error: string | null
  dirty: boolean

  /** Decoded once from `doc.source` (or from a freshly picked file) — never persisted. */
  sourceImage: ImageData | null
  sourceError: string | null

  tool: ScreenTool
  /** Rectangle tool: filled or outline. Ignored by every other tool. */
  filled: boolean
  color: number
  zoom: number
  /** Overlays on the canvas: the block grid, the 8-dot cell, and one screenful. */
  grid: boolean
  cellGuide: boolean
  screenOutline: boolean
  /**
   * Whether the source image sits beside the canvas.
   *
   * Only ever consulted when there *is* a source — a document drawn from
   * scratch has no "before" to compare against, and half a pane showing a
   * placeholder is half a pane not being drawn on.
   */
  showOriginal: boolean
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
    stopWatching: null,
    history: createHistory(normalizeScreen({})),
    loading: true,
    error: null,
    dirty: false,
    sourceImage: null,
    sourceError: null,
    tool: 'pencil',
    filled: false,
    color: 1,
    zoom: 2,
    grid: false,
    cellGuide: false,
    screenOutline: true,
    showOriginal: true,
    status: '',
    busy: false,
    preview: null
  })
  sessions.set(path, session)
  // An agent or a checkout can rewrite this file underneath the editor.
  // `load` is reused rather than a bespoke parse: it already does whatever
  // fix-ups this resource needs after reading.
  session.stopWatching = watchResourceFile(path, {
    serialize: () => serializeResource({ kind: 'screen', doc: doc(session) }),
    reload: () => void load(session),
    isDirty: () => session.dirty
  })
  void load(session)
  return session
}

/** Drops sessions for tabs that were closed. Called by the tab component when the tab set changes. */
export function pruneScreenSessions(openPaths: Set<string>): void {
  for (const path of [...sessions.keys()]) {
    if (openPaths.has(path)) continue
    sessions.get(path)?.stopWatching?.()
    sessions.delete(path)
  }
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
    session.status = `${mode} has no screen document — pick one of ${BITMAP_MODES.join('/')}.`
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
  const picked = session.sourceImage
  if (!picked) {
    // No artwork to re-run, but the mode may have changed under a drawn canvas —
    // and a 64×48 SCREEN 3 buffer is not a 256×212 SCREEN 5 one.
    commit(
      session,
      next.mode === current.mode ? next : { ...next, converted: blankConverted(next.mode, next.width, next.height) }
    )
    return
  }
  session.busy = true
  try {
    const image = fitToMode(picked, next.mode, next.width, next.height)
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

/**
 * Starts an empty canvas at the mode's resolution, for a screen that is drawn
 * here rather than converted from artwork — a tile atlas, a HUD strip, a
 * software-sprite sheet. The pencil, fill, palette and cut tools all work off
 * `converted`, so giving it something to work on is the whole feature.
 */
export function startBlank(session: ScreenSession): void {
  const current = doc(session)
  commit(session, { ...current, converted: blankConverted(current.mode, current.width, current.height) })
  session.status = 'Blank canvas'
}

export function setPalette(session: ScreenSession, index: number, grb: number): void {
  commit(session, setPaletteEntry(doc(session), index, grb))
}

// ── retouch ──────────────────────────────────────────────────────────────

/** View and tool switches: they live on the session, not the document, so none of them is undoable. */
export function setFilled(session: ScreenSession, filled: boolean): void {
  session.filled = filled
}

export function setGrid(session: ScreenSession, grid: boolean): void {
  session.grid = grid
}

export function setCellGuide(session: ScreenSession, cellGuide: boolean): void {
  session.cellGuide = cellGuide
}

export function setScreenOutline(session: ScreenSession, screenOutline: boolean): void {
  session.screenOutline = screenOutline
}

export function setShowOriginal(session: ScreenSession, showOriginal: boolean): void {
  session.showOriginal = showOriginal
}

/**
 * Resizes the picture. Past the mode's screen size it becomes a **world** — the
 * same document, scrolled rather than shown, which is all that separates a
 * screen from a map.
 *
 * Cropping, not scaling: the same rule every other resource follows, and the one
 * that makes the operation reversible by resizing back.
 */
export function resize(session: ScreenSession, width: number, height: number): void {
  commit(session, resizeScreen(doc(session), width, height))
}

export function setTool(session: ScreenSession, tool: ScreenTool): void {
  session.tool = tool
}

/**
 * Names a rectangle of the converted image as a fragment — a bitmap-mode
 * block, and the frame of a software sprite. The pixels stay where they are;
 * a fragment is only a window onto them.
 */
export function addFragment(session: ScreenSession, rect: { x: number; y: number; width: number; height: number }): void {
  const current = doc(session)
  const fragment = { name: `fragment_${current.fragments.length}`, ...rect }
  commit(session, { ...current, fragments: [...current.fragments, fragment] })
  session.status = `Cut ${fragment.name} — ${rect.width}×${rect.height}`
}

export function removeFragment(session: ScreenSession, index: number): void {
  const current = doc(session)
  if (!current.fragments[index]) return
  commit(session, { ...current, fragments: current.fragments.filter((_, i) => i !== index) })
}

export function renameFragment(session: ScreenSession, index: number, name: string): void {
  const current = doc(session)
  if (!current.fragments[index]) return
  commit(session, {
    ...current,
    fragments: current.fragments.map((fragment, i) => (i === index ? { ...fragment, name } : fragment))
  })
}

export function setColor(session: ScreenSession, index: number): void {
  session.color = index
}

/** `points` come from `linePoints` (`shared/tile-editor.ts`) between drag samples, in image pixels. */
export function paintDrag(session: ScreenSession, points: Point[]): void {
  const base = session.preview ?? session.history.present
  session.preview = paintScreen(base, points, session.color)
}

/**
 * One drag step for the pencil, line and rectangle tools, in image pixels.
 *
 * Pencil and the rubber-band tools differ only in what `from` means: a pencil
 * walks, so each step starts where the last ended, while a line or rectangle is
 * redrawn from the anchor every time. That is the same split the bitmap tileset
 * editor makes, and this calls the same `bitmapToolPoints` to make it.
 */
export function toolDrag(session: ScreenSession, from: Point, point: Point): void {
  const current = session.history.present
  const pixels = screenPixels(current)
  if (!pixels) return
  const points = bitmapToolPoints(
    session.tool === 'pencil' || session.tool === 'line' || session.tool === 'rect' ? session.tool : 'pencil',
    from,
    point,
    pixels.indices,
    pixels.width,
    pixels.height,
    session.filled
  )
  // Rubber-band tools redraw from the anchor, so each step replaces the last
  // rather than adding to it — one undo entry either way.
  const base = session.tool === 'pencil' ? (session.preview ?? current) : current
  session.preview = paintScreen(base, points, session.color)
}

/** The eyedropper: takes the colour already under the cursor rather than painting one. */
export function pickAt(session: ScreenSession, point: Point): void {
  const pixels = screenPixels(doc(session))
  if (!pixels || point.x < 0 || point.y < 0 || point.x >= pixels.width || point.y >= pixels.height) return
  session.color = pixels.indices[point.y * pixels.width + point.x]
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
  commit(session, paintScreen(current, points, session.color))
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
