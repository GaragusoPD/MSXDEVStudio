/**
 * Per-tab state for the software-sprite editor.
 *
 * Same shape as every other resource editor: a module-level map keyed by tab id
 * (= the project-relative path), a `History<SwSpritesDoc>` for undo, and a
 * `preview` document a drag writes into so a stroke costs one undo step rather
 * than one per pixel.
 *
 * The drawing itself is `bitmapToolPoints` — the same pencil/line/rect/fill
 * geometry the bitmap tileset and screen editors use, over whatever index buffer
 * it is handed. A software-sprite frame is one more such buffer.
 */

import { shallowReactive } from 'vue'
import { bitmapToolPoints, type Point, type TileTool } from '../../../../shared/bitmap-tile-editor'
import {
  canRedo as historyCanRedo,
  canUndo as historyCanUndo,
  createHistory,
  pushHistory,
  redo as redoHistory,
  undo as undoHistory,
  type History
} from '../../../../shared/history'
import { defaultExport, serializeResource, type ExportBlock } from '../../../../shared/msx/resource'
import {
  addSwSprite,
  createSwSpritesDoc,
  normalizeSwSprites,
  removeSwSprite,
  renameSwSprite,
  resizeSwSprite,
  setSwFrameCount,
  setSwFramePixels,
  swFramePixels,
  type SwMode,
  type SwSpritesDoc
} from '../../../../shared/msx/swsprite'
import { useTabsStore } from '../../stores/tabsStore'
import { watchResourceFile } from '../external-changes'

/** `bitmapToolPoints`' four, plus the eyedropper this editor adds on top of them. */
export type SwTool = TileTool | 'pick'

export interface SwSpriteSession {
  path: string
  /** Drops this session's file watch. */
  stopWatching: (() => void) | null
  history: History<SwSpritesDoc>
  loading: boolean
  error: string | null
  dirty: boolean

  /** Which character is open, and which of its frames. */
  sprite: number
  frame: number

  tool: SwTool
  filled: boolean
  color: number
  zoom: number
  grid: boolean

  /** Preview during a drag; `doc()` reads this over `history.present`. */
  preview: SwSpritesDoc | null
  /** Rubber-band anchor, so line and rect redraw from where the drag started. */
  anchor: Point | null

  /** Animation preview — a view control, so it is not in the document. */
  playing: boolean
  fps: number
}

const sessions = new Map<string, SwSpriteSession>()

export function swSpriteSession(path: string): SwSpriteSession {
  const existing = sessions.get(path)
  if (existing) return existing
  const session = shallowReactive<SwSpriteSession>({
    path,
    stopWatching: null,
    history: createHistory(createSwSpritesDoc('sc3')),
    loading: true,
    error: null,
    dirty: false,
    sprite: 0,
    frame: 0,
    tool: 'pencil',
    filled: false,
    color: 1,
    zoom: 12,
    grid: true,
    preview: null,
    anchor: null,
    playing: false,
    fps: 8
  })
  sessions.set(path, session)
  // An agent or a checkout can rewrite this file underneath the editor.
  // `load` is reused rather than a bespoke parse: it already does whatever
  // fix-ups this resource needs after reading.
  session.stopWatching = watchResourceFile(path, {
    serialize: () => serializeResource({ kind: 'swsprites', doc: session.history.present }),
    reload: () => void load(session),
    isDirty: () => session.dirty
  })
  void load(session)
  return session
}

export function pruneSwSpriteSessions(openPaths: Set<string>): void {
  for (const key of [...sessions.keys()]) {
    if (openPaths.has(key)) continue
    sessions.get(key)?.stopWatching?.()
    sessions.delete(key)
  }
}

export function doc(session: SwSpriteSession): SwSpritesDoc {
  return session.preview ?? session.history.present
}

/** The open character, clamped — a removed sprite must not leave the selection dangling. */
export function character(session: SwSpriteSession): SwSpritesDoc['sprites'][number] {
  const current = doc(session)
  return current.sprites[Math.min(session.sprite, current.sprites.length - 1)] ?? current.sprites[0]
}

export function framePixels(session: SwSpriteSession): Uint8Array {
  return swFramePixels(doc(session), session.sprite, session.frame)
}

async function load(session: SwSpriteSession): Promise<void> {
  // A session keyed on an empty path is a tab that has not resolved yet; reading
  // it produces "Path escapes project root: undefined" rather than anything a
  // user could act on.
  if (!session.path) {
    session.loading = false
    return
  }
  try {
    const text = (await window.api.invoke('fs:read', { path: session.path })) as string
    session.history = createHistory(normalizeSwSprites(JSON.parse(text) as unknown))
    session.error = null
  } catch (error) {
    session.error = String(error)
  } finally {
    session.loading = false
  }
}

export async function saveSession(session: SwSpriteSession): Promise<void> {
  await window.api.invoke('fs:write', {
    path: session.path,
    content: serializeResource({ kind: 'swsprites', doc: session.history.present })
  })
  session.dirty = false
  useTabsStore().setDirty(session.path, false)
}

function markDirty(session: SwSpriteSession): void {
  session.dirty = true
  useTabsStore().setDirty(session.path, true)
}

export function commit(session: SwSpriteSession, next: SwSpritesDoc): void {
  const history = pushHistory(session.history, next)
  if (history === session.history) return
  session.history = history
  clampSelection(session)
  markDirty(session)
}

function clampSelection(session: SwSpriteSession): void {
  const current = session.history.present
  session.sprite = Math.max(0, Math.min(session.sprite, current.sprites.length - 1))
  const open = current.sprites[session.sprite]
  session.frame = open ? Math.max(0, Math.min(session.frame, open.frames - 1)) : 0
}

export function undo(session: SwSpriteSession): void {
  session.history = undoHistory(session.history)
  clampSelection(session)
  markDirty(session)
}

export function redo(session: SwSpriteSession): void {
  session.history = redoHistory(session.history)
  clampSelection(session)
  markDirty(session)
}

export const canUndo = historyCanUndo
export const canRedo = historyCanRedo

// ── drawing ─────────────────────────────────────────────────────────────────

/**
 * One drag step. A pencil walks from where the last step ended so a fast drag
 * leaves no gaps; line and rectangle rubber-band from the anchor, so each step
 * replaces the last rather than adding to it.
 */
export function strokeMove(session: SwSpriteSession, point: Point): void {
  const open = character(session)
  if (!open) return
  const base = session.tool === 'pencil' ? (session.preview ?? session.history.present) : session.history.present
  const pixels = swFramePixels(base, session.sprite, session.frame)
  const from = session.anchor ?? point
  // 'pick' never reaches here — the canvas handles it before a drag starts.
  const tool = session.tool === 'pick' ? 'pencil' : session.tool
  const points = bitmapToolPoints(tool, from, point, pixels, open.width, open.height, session.filled)
  session.preview = setSwFramePixels(base, session.sprite, session.frame, applied(pixels, points, session.color, open.width))
  if (session.tool === 'pencil') session.anchor = point
}

function applied(pixels: Uint8Array, points: readonly Point[], color: number, width: number): Uint8Array {
  const out = pixels.slice()
  for (const p of points) {
    const at = p.y * width + p.x
    if (at >= 0 && at < out.length) out[at] = color & 0xff
  }
  return out
}

export function strokeStart(session: SwSpriteSession, point: Point): void {
  session.anchor = point
  strokeMove(session, point)
}

export function strokeEnd(session: SwSpriteSession): void {
  const preview = session.preview
  session.preview = null
  session.anchor = null
  if (preview && preview !== session.history.present) commit(session, preview)
}

/** The eyedropper: takes the colour under the cursor rather than painting one. */
export function pickAt(session: SwSpriteSession, point: Point): void {
  const open = character(session)
  if (!open) return
  const pixels = framePixels(session)
  const at = point.y * open.width + point.x
  if (at >= 0 && at < pixels.length) session.color = pixels[at]
}

/** Clears the open frame to the transparent index, which is what "empty" means here. */
export function clearFrame(session: SwSpriteSession): void {
  const current = doc(session)
  const open = character(session)
  if (!open) return
  const pixels = new Uint8Array(open.width * open.height).fill(current.transparent)
  commit(session, setSwFramePixels(current, session.sprite, session.frame, pixels))
}

/** Copies the open frame over the next one — the usual way to start a pose from the last. */
export function duplicateFrame(session: SwSpriteSession): void {
  const current = doc(session)
  const open = character(session)
  if (!open) return
  const pixels = swFramePixels(current, session.sprite, session.frame)
  const grown = setSwFrameCount(current, session.sprite, open.frames + 1)
  commit(session, setSwFramePixels(grown, session.sprite, open.frames, pixels))
  session.frame = open.frames
}

// ── document edits ──────────────────────────────────────────────────────────

export function selectSprite(session: SwSpriteSession, index: number): void {
  session.sprite = index
  session.frame = 0
}

export function selectFrame(session: SwSpriteSession, index: number): void {
  session.frame = index
}

export function addSprite(session: SwSpriteSession, name: string): void {
  const current = doc(session)
  commit(session, addSwSprite(current, name))
  session.sprite = current.sprites.length
  session.frame = 0
}

export function dropSprite(session: SwSpriteSession, index: number): void {
  commit(session, removeSwSprite(doc(session), index))
}

export function renameSprite(session: SwSpriteSession, index: number, name: string): void {
  commit(session, renameSwSprite(doc(session), index, name))
}

export function setSize(session: SwSpriteSession, width: number, height: number): void {
  commit(session, resizeSwSprite(doc(session), session.sprite, width, height))
}

export function setFrames(session: SwSpriteSession, frames: number): void {
  commit(session, setSwFrameCount(doc(session), session.sprite, frames))
}

/**
 * Switches the whole sheet to another mode.
 *
 * Through `normalizeSwSprites` rather than a spread, because the mode carries
 * its size rule with it: the same 12×12 character is legal in SCREEN 3 and has
 * to become 16×16 in SCREEN 2, where nothing is smaller than a character cell.
 */
export function setMode(session: SwSpriteSession, mode: SwMode): void {
  const current = doc(session)
  if (current.mode === mode) return
  commit(session, normalizeSwSprites({ ...current, mode, palette: undefined }))
}

export function setTransparent(session: SwSpriteSession, transparent: number): void {
  commit(session, { ...doc(session), transparent })
}

export function setPaletteEntry(session: SwSpriteSession, index: number, grb: number): void {
  const current = doc(session)
  if (!current.palette) return
  const palette = current.palette.slice()
  palette[index] = grb & 0x0777
  commit(session, { ...current, palette })
}

export function setupExport(session: SwSpriteSession): void {
  commit(session, { ...doc(session), export: defaultExport(session.path) })
}

export function patchExport(session: SwSpriteSession, patch: Partial<ExportBlock>): void {
  const current = doc(session)
  if (!current.export) return
  commit(session, { ...current, export: { ...current.export, ...patch } })
}
