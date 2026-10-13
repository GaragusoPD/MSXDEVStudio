/**
 * Per-tab state for the animated-tile editor (`*.anim-tiles.json`).
 *
 * Same shape as the other resource sessions: a module-level map keyed by path,
 * one immutable document per undo step (`shared/history.ts`), and every edit a
 * pure function from `shared/msx/tile-anim.ts`.
 *
 * Painting goes through the tile editor's own stroke functions against a
 * scratch tileset holding one pose (`frameTiles`), so the two-colours-per-row
 * rule is the tile editor's answer here too, not a copy of it.
 *
 * Attaching is not done from here. A binding lives on the tileset, and the
 * tileset is a document the tile editor owns (and the tileset store shares);
 * this editor lists where the animation is attached and opens that tileset.
 * What it does do is tell open tile tabs when the poses change, so the window
 * shows the new frame 0 without waiting for a build (`onAnimSaved`).
 */

import { shallowReactive } from 'vue'
import {
  animDocCells,
  colorsVary,
  createTileAnimDoc,
  DEFAULT_ANIM_DURATION,
  frameTiles,
  MAX_ANIM_CELLS,
  MAX_ANIM_DURATION,
  MAX_ANIM_FRAMES,
  normalizeTileAnim,
  withFrameTiles,
  type TileAnimDoc
} from '../../../../shared/msx/tile-anim'
import { tilePixels, type AnimLoop, type TileBlock } from '../../../../shared/msx/tile'
import { applyRoleStroke, splitBlockPoints, type Point, type TileTool } from '../../../../shared/tile-editor'
import { canRedo, canUndo, createHistory, pushHistory, redo as redoHistory, undo as undoHistory, type History } from '../../../../shared/history'
import { parseResource, serializeResource } from '../../../../shared/msx/resource'
import { samePath } from '../../../../shared/map-editor'
import { useResourcesStore } from '../../stores/resourcesStore'
import { useTabsStore } from '../../stores/tabsStore'
import { watchResourceFile } from '../external-changes'
import { emitAnimSaved } from './events'

/** Where this animation is attached: a tileset, and the window it drives there. */
export interface AnimAttachment {
  tileset: string
  slot: number
  bank: number | null
}

export interface AnimSession {
  path: string
  history: History<TileAnimDoc>
  loading: boolean
  error: string | null
  dirty: boolean
  /** The pose being edited. */
  frame: number
  tool: TileTool
  color: number
  /** Canvas pixels per dot. */
  zoom: number
  filledRect: boolean
  /** Preview playback in the editor — UI state, never saved. */
  playing: boolean
  /** The document mid-stroke; `doc()` answers with it so the canvas follows the drag. */
  preview: TileAnimDoc | null
  strokeActive: boolean
  attachedTo: AnimAttachment[]
  status: string
  stopWatching: (() => void) | null
}

const sessions = new Map<string, AnimSession>()

export function animSession(path: string): AnimSession {
  const existing = sessions.get(path)
  if (existing) return existing
  const session = shallowReactive<AnimSession>({
    path,
    history: createHistory(createTileAnimDoc()),
    loading: true,
    error: null,
    dirty: false,
    frame: 0,
    tool: 'pencil',
    color: 15,
    zoom: 24,
    filledRect: false,
    playing: false,
    preview: null,
    strokeActive: false,
    attachedTo: [],
    status: '',
    stopWatching: null
  })
  sessions.set(path, session)
  session.stopWatching = watchResourceFile(path, {
    serialize: () => serializeResource({ kind: 'anim', doc: session.history.present }),
    reload: () => void load(session),
    isDirty: () => session.dirty
  })
  void load(session)
  return session
}

export function pruneAnimSessions(openPaths: Set<string>): void {
  for (const path of [...sessions.keys()]) {
    if (openPaths.has(path)) continue
    sessions.get(path)?.stopWatching?.()
    sessions.delete(path)
  }
}

export function doc(session: AnimSession): TileAnimDoc {
  return session.preview ?? session.history.present
}

async function load(session: AnimSession): Promise<void> {
  try {
    const text = await window.api.invoke('fs:read', { path: session.path })
    const raw: unknown = text.trim() ? JSON.parse(text) : {}
    session.history = createHistory(normalizeTileAnim(raw))
    session.frame = Math.min(session.frame, doc(session).frames.length - 1)
    session.dirty = false
    session.error = null
  } catch (error) {
    session.error = `Couldn't open ${session.path}: ${String(error)}`
  } finally {
    session.loading = false
  }
  await findAttachments(session)
}

/**
 * Every tileset in the project this animation is attached to, read from the
 * files. Listed rather than edited here — see the module header.
 */
export async function findAttachments(session: AnimSession): Promise<void> {
  const found: AnimAttachment[] = []
  // Listed fresh: the store is only filled when the Resources panel has been
  // shown, and a tab opened from the Explorer would otherwise find nothing —
  // "not attached yet" about an animation a tileset is playing.
  const resources = useResourcesStore()
  await resources.refresh()
  for (const entry of resources.entries) {
    if (entry.kind !== 'tiles') continue
    try {
      const parsed = parseResource(entry.path, await window.api.invoke('fs:read', { path: entry.path }))
      if (parsed.kind !== 'tiles') continue
      for (const binding of parsed.doc.animations) {
        if (samePath(binding.path, session.path)) found.push({ tileset: entry.path, slot: binding.slot, bank: binding.bank })
      }
    } catch {
      // A tileset that cannot be read is not a reason to break this list.
    }
  }
  session.attachedTo = found
}

export async function saveSession(session: AnimSession): Promise<void> {
  const current = session.history.present
  await window.api.invoke('fs:write', { path: session.path, content: serializeResource({ kind: 'anim', doc: current }) })
  session.dirty = false
  useTabsStore().setDirty(session.path, false)
  session.status = 'Saved'
  emitAnimSaved({ path: session.path, doc: current })
}

function markDirty(session: AnimSession): void {
  session.dirty = true
  useTabsStore().setDirty(session.path, true)
}

/** One undo step; a no-op when nothing changed. */
export function commit(session: AnimSession, next: TileAnimDoc): void {
  if (next === session.history.present) return
  session.history = pushHistory(session.history, next)
  markDirty(session)
}

export function undo(session: AnimSession): void {
  if (!canUndo(session.history)) return
  session.history = undoHistory(session.history)
  session.frame = Math.min(session.frame, doc(session).frames.length - 1)
  markDirty(session)
}

export function redo(session: AnimSession): void {
  if (!canRedo(session.history)) return
  session.history = redoHistory(session.history)
  session.frame = Math.min(session.frame, doc(session).frames.length - 1)
  markDirty(session)
}

export { canRedo, canUndo }

// ── painting ─────────────────────────────────────────────────────────────────

/** The pose's cells as one block over its scratch tileset — tile i is cell i. */
function poseBlock(anim: TileAnimDoc): TileBlock {
  return { name: 'pose', width: anim.width, height: anim.height, tiles: Array.from({ length: animDocCells(anim) }, (_, i) => i) }
}

export function beginStroke(session: AnimSession): void {
  session.preview = session.history.present
  session.strokeActive = true
}

/**
 * Paints `points` (in the pose's own dot space, `width*8 × height*8`) into the
 * current pose. Left button paints a row's ink, right its paper — the tile and
 * meta editors' model, which is why a third colour lands instead of raising a
 * popover.
 */
export function paint(session: AnimSession, points: Point[], role: 'fg' | 'bg'): void {
  if (!session.strokeActive) beginStroke(session)
  const current = doc(session)
  let scratch = frameTiles(current, session.frame)
  for (const [tile, tilePoints] of splitBlockPoints(poseBlock(current), points)) {
    scratch = applyRoleStroke(scratch, tile, tilePoints, session.color, role)
  }
  session.preview = withFrameTiles(current, session.frame, scratch)
}

/** Ends the drag: one stroke, one undo step. */
export function endStroke(session: AnimSession): void {
  const preview = session.preview
  session.preview = null
  session.strokeActive = false
  if (preview && preview !== session.history.present) commit(session, preview)
}

/** The pose as palette indices, `width*8 × height*8` — what the canvas and the preview draw. */
export function posePixels(session: AnimSession, frame: number): { width: number; height: number; indices: Uint8Array } {
  const anim = doc(session)
  const width = anim.width * 8
  const height = anim.height * 8
  const indices = new Uint8Array(width * height)
  // The scratch tileset decodes exactly as the tile editor would, sc1's pair included.
  const scratch = frameTiles(anim, frame)
  for (let cy = 0; cy < anim.height; cy++) {
    for (let cx = 0; cx < anim.width; cx++) {
      const pixels = tilePixels(scratch, cy * anim.width + cx)
      for (let y = 0; y < 8; y++) indices.set(pixels.subarray(y * 8, y * 8 + 8), (cy * 8 + y) * width + cx * 8)
    }
  }
  return { width, height, indices }
}

// ── frames ───────────────────────────────────────────────────────────────────

export function setFrame(session: AnimSession, frame: number): void {
  session.frame = Math.max(0, Math.min(doc(session).frames.length - 1, frame))
}

/** Appends a pose — a copy of `copyOf` when given, since a pose usually starts from the last one. */
export function addFrame(session: AnimSession, copyOf: number | null = session.frame): void {
  const current = doc(session)
  if (current.frames.length >= MAX_ANIM_FRAMES) {
    session.status = `An animation holds at most ${MAX_ANIM_FRAMES} poses.`
    return
  }
  const source = copyOf !== null ? current.frames[copyOf] : null
  const fresh = normalizeTileAnim({ ...current, frames: [{}] }).frames[0]
  const frame = source
    ? { duration: source.duration, tiles: source.tiles.map((t) => ({ pattern: t.pattern.slice(), color: t.color.slice() })) }
    : { ...fresh, duration: current.frames[current.frames.length - 1]?.duration ?? DEFAULT_ANIM_DURATION }
  const at = (copyOf ?? current.frames.length - 1) + 1
  const frames = [...current.frames.slice(0, at), frame, ...current.frames.slice(at)]
  commit(session, { ...current, frames })
  session.frame = at
}

export function removeFrame(session: AnimSession, index: number): void {
  const current = doc(session)
  if (current.frames.length <= 1) {
    session.status = 'An animation needs at least one pose.'
    return
  }
  commit(session, { ...current, frames: current.frames.filter((_, i) => i !== index) })
  session.frame = Math.min(session.frame, current.frames.length - 2)
}

export function moveFrame(session: AnimSession, from: number, to: number): void {
  const current = doc(session)
  if (from === to || !current.frames[from] || to < 0 || to >= current.frames.length) return
  const frames = current.frames.slice()
  const [moved] = frames.splice(from, 1)
  frames.splice(to, 0, moved)
  commit(session, { ...current, frames })
  session.frame = to
}

/** How many frames (VBlanks) pose `index` is held, or every pose when `index` is null. */
export function setDuration(session: AnimSession, index: number | null, duration: number): void {
  const value = Math.max(1, Math.min(MAX_ANIM_DURATION, Math.round(duration) || 1))
  const current = doc(session)
  const frames = current.frames.map((frame, i) => (index === null || i === index ? { ...frame, duration: value } : frame))
  if (frames.every((frame, i) => frame.duration === current.frames[i].duration)) return
  commit(session, { ...current, frames })
}

export function setLoop(session: AnimSession, loop: AnimLoop): void {
  const current = doc(session)
  if (current.loop !== loop) commit(session, { ...current, loop })
}

/**
 * Resizes the window. Cells keep their place from the top-left; new ones are
 * blank. Refused past `MAX_ANIM_CELLS` — and the tilesets it is attached to
 * will refuse to export until their windows have room, which their own
 * validation says.
 */
export function resize(session: AnimSession, width: number, height: number): void {
  const current = doc(session)
  const w = Math.max(1, Math.round(width) || 1)
  const h = Math.max(1, Math.round(height) || 1)
  if (w * h > MAX_ANIM_CELLS) {
    session.status = `An animation window holds at most ${MAX_ANIM_CELLS} tiles.`
    return
  }
  if (w === current.width && h === current.height) return
  const blank = normalizeTileAnim({ mode: current.mode, frames: [{}] }).frames[0].tiles[0]
  const frames = current.frames.map((frame) => ({
    ...frame,
    tiles: Array.from({ length: w * h }, (_, i) => {
      const x = i % w
      const y = Math.floor(i / w)
      const old = x < current.width && y < current.height ? frame.tiles[y * current.width + x] : undefined
      return old ? { pattern: old.pattern.slice(), color: old.color.slice() } : { pattern: blank.pattern.slice(), color: blank.color.slice() }
    })
  }))
  commit(session, { ...current, width: w, height: h, frames })
}

/** SCREEN 1's one ink/paper pair, which every pose is drawn in. */
export function setPair(session: AnimSession, fg: number, bg: number): void {
  const current = doc(session)
  const pair = ((fg & 15) << 4) | (bg & 15)
  if (current.mode !== 'sc1' || current.pair === pair) return
  commit(session, { ...current, pair })
}

export function setTool(session: AnimSession, tool: TileTool): void {
  session.tool = tool
}

export function setColor(session: AnimSession, color: number): void {
  session.color = color
}

export function setZoom(session: AnimSession, zoom: number): void {
  session.zoom = Math.max(4, Math.min(64, Math.round(zoom) || session.zoom))
}

export function togglePlaying(session: AnimSession): void {
  session.playing = !session.playing
}

/**
 * VRAM bytes one pose change writes, the way the generated step writes them:
 * 8 pattern bytes a tile, into each of SCREEN 2/4's three banks, and the same
 * again for colours only when the poses differ in colour. SCREEN 1 has one
 * pattern table and no per-tile colours. (A window on one bank's own art
 * writes that bank only — a third of this; the tileset knows which, not the
 * animation.)
 */
export function stepBytes(anim: TileAnimDoc): number {
  const cells = animDocCells(anim)
  if (anim.mode === 'sc1') return cells * 8
  return cells * 8 * 3 * (colorsVary(anim) ? 2 : 1)
}

/**
 * The pose a preview shows `ticks` frames (VBlanks) after the start — the same
 * stepping the generated `_Animate()` does, so the preview tells the truth
 * about timing, ping-pong and play-once.
 */
export function poseAtTick(anim: TileAnimDoc, ticks: number): number {
  const order: number[] = []
  const count = anim.frames.length
  if (anim.loop === 'pingpong' && count > 1) {
    for (let f = 0; f < count; f++) order.push(f)
    for (let f = count - 2; f > 0; f--) order.push(f)
  } else {
    for (let f = 0; f < count; f++) order.push(f)
  }
  const total = order.reduce((sum, f) => sum + anim.frames[f].duration, 0)
  if (anim.loop === 'once' && ticks >= total - anim.frames[count - 1].duration) return count - 1
  let t = total > 0 ? ticks % total : 0
  for (const f of order) {
    if (t < anim.frames[f].duration) return f
    t -= anim.frames[f].duration
  }
  return order[order.length - 1]
}
