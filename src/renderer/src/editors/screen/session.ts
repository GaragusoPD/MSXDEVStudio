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
 * - The rectangular selection and the floating selection a move, a paste or
 *   an import makes (`shared/floating.ts`). A float lives here, above the
 *   document, until it is dropped; `displayPixels` is the picture with it on.
 */

import { shallowReactive } from 'vue'
import type { ImportResult } from '../../composables/useImageImport'
import { decode, fitToMode } from '../../composables/useImageImport'
import { MODES, type BitmapMode } from '../../../../shared/msx/modes'
import { paletteToRgb, type Rgb } from '../../../../shared/msx/palette'
import { quantize } from '../../../../shared/msx/quantize'
import { serializeResource } from '../../../../shared/msx/resource'
import {
  blankConverted,
  normalizeScreen,
  resizeScreen,
  screenPixels,
  screenRgb,
  type ScreenConvert,
  type ScreenDoc
} from '../../../../shared/msx/screen'
import {
  clampFloat,
  clipRect,
  composeFloat,
  copyClip,
  fillRect,
  floatRect,
  liftFloat,
  normalizeRect,
  placeFloat,
  type Clip,
  type Float,
  type Rect
} from '../../../../shared/floating'
import {
  applyConversion,
  canRedo,
  canUndo,
  clearRetouch,
  createHistory,
  flattenScreen,
  paintScreen,
  pushHistory,
  redo as redoHistory,
  retouchFillPoints,
  setPaletteEntry,
  setScreenPixels,
  undo as undoHistory,
  type Point,
  type ScreenHistory
} from '../../../../shared/screen-editor'
import { bitmapToolPoints, type TileTool } from '../../../../shared/bitmap-tile-editor'
import { useTabsStore } from '../../stores/tabsStore'
import { watchResourceFile } from '../external-changes'

/**
 * `TileTool`'s four plus the three this editor adds. Pencil/line/rect/fill are
 * `bitmapToolPoints`' — the same geometry the bitmap tileset editor uses, over
 * whatever index buffer it is handed — so this editor gains line and rectangle
 * without a second implementation of Bresenham.
 *
 * `fragment` names a rectangle and leaves the pixels where they are; `select`
 * is the one that cuts, copies and moves them.
 */
export type ScreenTool = TileTool | 'pick' | 'fragment' | 'select'

/**
 * A float over a screen. An import also carries what has to happen to the
 * screen to take it: the palette it was converted with, which the screen
 * adopts on the drop when it differs, and `flatten`, because a pasted picture
 * is no longer something the screen's own source converts to.
 */
export interface ScreenFloat extends Float {
  palette: number[] | null
  flatten: boolean
}

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

  /** The selected rectangle, in pixels. While something floats it is the float's own rectangle. */
  selection: Rect | null
  /** Pixels held above the picture: a moved selection, a paste or an import, until it is dropped. */
  float: ScreenFloat | null
  clipboard: Clip | null
  /** The pixel at the top-left of what is in view — where an import first appears when nothing is selected. */
  viewOrigin: Point
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
    preview: null,
    selection: null,
    float: null,
    clipboard: null,
    viewOrigin: { x: 0, y: 0 }
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
  // What is on the canvas is what gets saved: a float left hanging would
  // otherwise be in the picture the user saw and not in the file.
  dropFloat(session)
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

/**
 * `ImportImageDialog`'s `@imported` handler: the converted picture becomes a
 * float over the screen, to be dragged into place and dropped like a paste.
 *
 * The screen keeps its size and what is already on it: an import is pasted
 * onto the picture rather than replacing it. Index 0 — where the converter
 * puts the image's see-through pixels — is not written, so a cut-out sits on
 * whatever is under it. The dialog converts in the screen's mode; when it
 * converted to a different palette, the screen takes that palette on the drop.
 */
/**
 * `transparent` is the index the float leaves the screen alone under — 0, the
 * transparent entry, by default; none in SCREEN 8, whose 0 is black, unless the
 * caller converted with index 0 kept free for it (the sheet importer does).
 */
export function importImage(session: ScreenSession, result: ImportResult, transparent?: number | null): void {
  dropFloat(session)
  const current = doc(session)
  const info = MODES[current.mode]
  const palette = info.palette === 'grb333' && result.palette ? result.palette : null
  const own = current.converted?.palette ?? null
  const adopt = palette !== null && !(own && own.length === palette.length && own.every((entry, i) => entry === palette[i]))
  // Only a changed entry something is drawn with changes what is on screen;
  // the ones a shared conversion filled were free.
  const used = usedEntries(current)
  const recolours = adopt && own !== null && palette!.some((entry, i) => used.has(i) && own[i] !== entry)
  const clip: Clip = { width: result.width, height: result.height, values: result.indices }
  const size = pictureSize(current)
  // A selection the user made says where; otherwise the top-left of what is in view.
  const at = session.selection ? { x: session.selection.x, y: session.selection.y } : session.viewOrigin
  session.float = {
    ...placeFloat(clip, at, size.width, size.height, transparent === undefined ? (info.palette === 'rgb332' ? null : 0) : transparent),
    palette: adopt ? palette : null,
    flatten: true
  }
  session.selection = floatRect(session.float)
  session.tool = 'select'
  session.status =
    `Drag the picture into place, then press Enter or click outside it. Esc cancels.` +
    (recolours ? " Placing it gives the screen the picture's palette, which recolours what is already drawn." : '') +
    (current.source ? ' Placing it also turns this conversion into a drawing.' : '')
}

/** The palette entries some pixel of the picture is drawn with. */
function usedEntries(current: ScreenDoc): Set<number> {
  return current.converted ? new Set(shownPixels(current).indices) : new Set()
}

/**
 * The entries of the screen's palette no pixel uses, entry 0 aside — what an
 * import may fill with colours of its own without recolouring anything
 * (`QuantizeOptions.freeEntries`). Empty in the modes with a fixed palette.
 */
export function freePaletteEntries(session: ScreenSession): number[] {
  const current = doc(session)
  const palette = current.converted?.palette
  if (!palette || MODES[current.mode].palette !== 'grb333') return []
  const used = usedEntries(current)
  return palette.map((_, index) => index).filter((index) => index > 0 && !used.has(index))
}

/** The canvas reports the pixel at the top-left of what is in view as it scrolls. UI state, not a history step. */
export function setViewOrigin(session: ScreenSession, origin: Point): void {
  if (origin.x !== session.viewOrigin.x || origin.y !== session.viewOrigin.y) session.viewOrigin = origin
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
  dropFloat(session)
  // A stale decoded image outlives the source it came from — an import
  // flattens the screen and the image stays in memory for undo — so the
  // document decides whether there is anything to re-run, not the cache.
  const picked = current.source ? session.sourceImage : null
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

/** Whether there is a source to re-run the conversion from — what the Reconvert button asks. */
export function canReconvert(session: ScreenSession): boolean {
  return Boolean(doc(session).source && session.sourceImage)
}

/**
 * Starts an empty canvas at the mode's resolution, for a screen that is drawn
 * here rather than converted from artwork — a tile atlas, a HUD strip, a
 * software-sprite sheet. The pencil, fill, palette and cut tools all work off
 * `converted`, so giving it something to work on is the whole feature.
 */
export function startBlank(session: ScreenSession): void {
  dropFloat(session)
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
  dropFloat(session)
  commit(session, resizeScreen(doc(session), width, height))
  if (session.selection) session.selection = clipRect(session.selection, doc(session).width, doc(session).height)
}

/** Switching tools drops whatever floats, so a float only ever exists under the select tool. */
export function setTool(session: ScreenSession, tool: ScreenTool): void {
  if (tool !== 'select') dropFloat(session)
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

/** Undo while something floats takes the float back, and nothing else: it was the last thing done. */
export function undo(session: ScreenSession): void {
  if (session.float) {
    cancelFloat(session)
    return
  }
  const next = undoHistory(session.history)
  if (next === session.history) return
  session.history = next
  session.preview = null
  markDirty(session)
}

export function redo(session: ScreenSession): void {
  // Nothing to redo past a float: dropping it would be a new step, which ends the redo trail.
  if (session.float) return
  const next = redoHistory(session.history)
  if (next === session.history) return
  session.history = next
  session.preview = null
  markDirty(session)
}

export { canRedo, canUndo }

// ── selection / clipboard / the floating selection ──────────────────────

/**
 * The picture's size, whether or not there is a picture yet: an import onto a
 * screen that was never drawn floats over a blank one of the document's size.
 */
function pictureSize(current: ScreenDoc): { width: number; height: number } {
  return current.converted ? { width: current.converted.width, height: current.converted.height } : { width: current.width, height: current.height }
}

/**
 * The picture under the float: what is shown, or a blank one when nothing has
 * been drawn yet. Kept per document, because a drag asks for it on every
 * pointer move and the document under a float does not change while it moves.
 * Read-only to every caller — `composeFloat` and `fillRect` copy before writing.
 */
const shownCache = new WeakMap<ScreenDoc, { width: number; height: number; indices: Uint8Array }>()
function shownPixels(current: ScreenDoc): { width: number; height: number; indices: Uint8Array } {
  const cached = shownCache.get(current)
  if (cached) return cached
  const size = pictureSize(current)
  const shown = screenPixels(current) ?? { ...size, indices: new Uint8Array(size.width * size.height) }
  shownCache.set(current, shown)
  return shown
}

/**
 * What the canvas draws: the picture with the float on it. Null only when
 * there is no picture and nothing floating — the "nothing to draw on" state.
 */
export function displayPixels(session: ScreenSession): { width: number; height: number; indices: Uint8Array } | null {
  const current = doc(session)
  const float = session.float
  if (!float) return screenPixels(current)
  const shown = shownPixels(current)
  return { ...shown, indices: composeFloat(shown.indices, shown.width, shown.height, float) }
}

/** The colours `displayPixels` is drawn in — the import's own palette while it floats, since that is what the drop gives the screen. */
export function displayRgb(session: ScreenSession): Rgb[] {
  const palette = session.float?.palette
  return palette ? paletteToRgb(palette) : screenRgb(doc(session))
}

export function setSelection(session: ScreenSession, a: Point, b: Point): void {
  const size = pictureSize(doc(session))
  session.selection = normalizeRect(a, b, size.width, size.height)
}

export function selectAll(session: ScreenSession): void {
  dropFloat(session)
  const size = pictureSize(doc(session))
  session.selection = { x: 0, y: 0, ...size }
  session.tool = 'select'
}

export function clearSelection(session: ScreenSession): void {
  dropFloat(session)
  session.selection = null
}

/**
 * Lifts the selection into a float, ready to be dragged. `copy` leaves the
 * original where it is (a Ctrl-drag). Returns false when there is nothing to lift.
 */
export function liftSelection(session: ScreenSession, copy = false): boolean {
  if (session.float) return true
  const current = doc(session)
  const shown = screenPixels(current)
  if (!shown || !session.selection) return false
  session.float = { ...liftFloat(shown.indices, shown.width, shown.height, session.selection, copy), palette: null, flatten: false }
  return true
}

/** Moves the float so its top-left is at `at`, keeping a row and a column of it on the picture. */
export function moveFloatTo(session: ScreenSession, at: Point): void {
  const float = session.float
  if (!float) return
  const size = pictureSize(doc(session))
  const next = clampFloat(at, float.clip.width, float.clip.height, size.width, size.height)
  if (next.x === float.x && next.y === float.y) return
  session.float = { ...float, ...next }
  session.selection = floatRect(session.float)
}

/** The arrow keys: lifts the selection if it is not floating yet, then moves it by one step. */
export function nudgeSelection(session: ScreenSession, dx: number, dy: number): void {
  if (!session.float && !liftSelection(session)) return
  const float = session.float!
  moveFloatTo(session, { x: float.x + dx, y: float.y + dy })
}

/**
 * Puts the float down: one undo step, written the way a pencil stroke would
 * be (`setScreenPixels`). An import first flattens a conversion and adopts its
 * palette, and onto a screen never drawn it starts a blank canvas. A move
 * dropped exactly where it was lifted is not an edit.
 */
export function dropFloat(session: ScreenSession): void {
  const float = session.float
  if (!float) return
  session.float = null
  const before = doc(session)
  const size = pictureSize(before)
  // A placed import is not selected: the next one would otherwise start on top of it.
  session.selection = float.flatten ? null : clipRect(floatRect(float), size.width, size.height)
  if (float.from && float.x === float.from.x && float.y === float.from.y) return
  let current = float.flatten ? flattenScreen(before) : before
  if (!current.converted) current = { ...current, converted: blankConverted(current.mode, current.width, current.height) }
  if (float.palette && current.converted!.palette) current = { ...current, converted: { ...current.converted!, palette: float.palette } }
  const shown = shownPixels(current)
  const next = setScreenPixels(current, composeFloat(shown.indices, shown.width, shown.height, float))
  commit(session, next)
  session.status = float.flatten
    ? `Placed the picture at ${float.x},${float.y}.` + (before.source ? ' The screen is a drawing now: it no longer re-converts from its source.' : '')
    : ''
}

/** Puts the float back: a move returns to where it was, a paste or an import is gone. Nothing reaches the undo stack. */
export function cancelFloat(session: ScreenSession): void {
  const float = session.float
  if (!float) return
  session.float = null
  session.selection = float.from
  session.status = ''
}

export function copySelection(session: ScreenSession): void {
  const float = session.float
  if (float) {
    session.clipboard = float.clip
  } else {
    const shown = screenPixels(doc(session))
    if (!shown || !session.selection) return
    session.clipboard = copyClip(shown.indices, shown.width, shown.height, session.selection)
  }
  session.status = `Copied ${session.clipboard.width}×${session.clipboard.height}`
}

/**
 * Clears the selection to colour 0. On a float that was lifted, that is
 * keeping the hole it left and throwing the pixels away; on a paste or an
 * import, nothing was there to begin with, so it is just a cancel.
 */
export function deleteSelection(session: ScreenSession): void {
  const float = session.float
  if (float) {
    session.float = null
    if (float.from) {
      const shown = screenPixels(doc(session))
      if (shown) commit(session, setScreenPixels(doc(session), fillRect(shown.indices, shown.width, shown.height, float.from)))
    }
    session.selection = null
    return
  }
  const shown = screenPixels(doc(session))
  if (!shown || !session.selection) return
  commit(session, setScreenPixels(doc(session), fillRect(shown.indices, shown.width, shown.height, session.selection)))
}

export function cutSelection(session: ScreenSession): void {
  if (!session.float && !session.selection) return
  copySelection(session)
  deleteSelection(session)
}

/**
 * The clipboard as a float, at the selection's corner (or the picture's), to
 * be dragged into place. Switches to the select tool, which is the one that
 * drags it.
 */
export function pasteClipboard(session: ScreenSession, at?: Point): void {
  const clip = session.clipboard
  if (!clip) return
  dropFloat(session)
  const size = pictureSize(doc(session))
  const corner = at ?? (session.selection ? { x: session.selection.x, y: session.selection.y } : { x: 0, y: 0 })
  session.float = { ...placeFloat(clip, corner, size.width, size.height), palette: null, flatten: false }
  session.selection = floatRect(session.float)
  session.tool = 'select'
  session.status = 'Pasted — drag it into place, then press Enter or click outside it.'
}
