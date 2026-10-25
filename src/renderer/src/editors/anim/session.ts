/**
 * Per-tab state for the editor of anything made of poses: an animated tile
 * (`*.anim-tiles.json`), and a meta-tile that owns its pixels
 * (`*.meta-tiles.json` version 3). A meta is an animation's poses plus a
 * footprint (`holes`) and eight flags, and attaches to tilesets the same way,
 * so it is the same editor with three more controls — not a second copy of
 * this one. `session.kind` says which file it is.
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
 * shows the new frame 0 without waiting for a build (`onAnimSaved`), and
 * remove a meta-tile from a tileset it is attached to (`removeFromTileset`).
 */

import { shallowReactive } from 'vue'
import { MAX_META_SIZE } from '../../../../shared/msx/meta-tile'
import { detachMeta, isOwnedMeta, metaWindowAnim, normalizeOwnedMeta, type OwnedMetaDoc } from '../../../../shared/msx/meta-owned'
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
  type PoseDoc,
  type TileAnimDoc
} from '../../../../shared/msx/tile-anim'
import { tilePixels, type AnimLoop, type TileBlock } from '../../../../shared/msx/tile'
import { paletteToRgb } from '../../../../shared/msx/palette'
import { pictureTiles } from '../../../../shared/msx/sheet-convert'
import { pictureClipboard } from '../picture-clipboard'
import { applyRoleStroke, splitBlockPoints, type Point, type TileTool } from '../../../../shared/tile-editor'
import { canRedo, canUndo, createHistory, pushHistory, redo as redoHistory, undo as undoHistory, type History } from '../../../../shared/history'
import { parseResource, resourceKindOf, serializeResource } from '../../../../shared/msx/resource'
import { samePath } from '../../../../shared/map-editor'
import { useResourcesStore } from '../../stores/resourcesStore'
import { useTabsStore } from '../../stores/tabsStore'
import { useTilesetStore } from '../../stores/tilesetStore'
import { watchResourceFile } from '../external-changes'
import { removeMetaFromTileset } from '../meta-removal'
import { emitAnimSaved } from './events'

/** Either file this editor opens. */
export type PoseFile = TileAnimDoc | OwnedMetaDoc

/**
 * Where this file is attached: a tileset, and the window it drives there —
 * null for a meta-tile that has no moving cells, and so no window.
 */
export interface AnimAttachment {
  tileset: string
  slot: number | null
  bank: number | null
  /** How many slots the window spans. */
  cells: number
}

export interface AnimSession {
  path: string
  /** Which file this is: an animation, or a meta-tile that owns its pixels. */
  kind: 'anim' | 'metatiles'
  history: History<PoseFile>
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
  preview: PoseFile | null
  /** Meta-tiles only: clicks toggle a cell see-through instead of painting. */
  holeMode: boolean
  strokeActive: boolean
  attachedTo: AnimAttachment[]
  /** An imported picture over the pose, in dots, until `placeFloat` cuts it in or `dropFloat` lets go. */
  float: { picture: Picture; x: number; y: number } | null
  status: string
  stopWatching: (() => void) | null
}

const sessions = new Map<string, AnimSession>()

const kindOf = (path: string): AnimSession['kind'] => (resourceKindOf(path) === 'metatiles' ? 'metatiles' : 'anim')

export function animSession(path: string): AnimSession {
  const existing = sessions.get(path)
  if (existing) return existing
  const kind = kindOf(path)
  const session = shallowReactive<AnimSession>({
    path,
    kind,
    history: createHistory<PoseFile>(kind === 'metatiles' ? normalizeOwnedMeta({}) : createTileAnimDoc()),
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
    holeMode: false,
    strokeActive: false,
    attachedTo: [],
    float: null,
    status: '',
    stopWatching: null
  })
  sessions.set(path, session)
  session.stopWatching = watchResourceFile(path, {
    serialize: () => serialize(session),
    reload: () => void load(session),
    isDirty: () => session.dirty
  })
  void load(session)
  return session
}

/** The session for `path` if one is open — never creates one. What the menu's save/undo hooks ask first. */
export function existingAnimSession(path: string): AnimSession | null {
  return sessions.get(path) ?? null
}

function serialize(session: AnimSession): string {
  const present = session.history.present
  return isOwnedMeta(present)
    ? serializeResource({ kind: 'metatiles', doc: present })
    : serializeResource({ kind: 'anim', doc: present as TileAnimDoc })
}

export function pruneAnimSessions(openPaths: Set<string>): void {
  for (const path of [...sessions.keys()]) {
    if (openPaths.has(path)) continue
    sessions.get(path)?.stopWatching?.()
    sessions.delete(path)
  }
}

export function doc(session: AnimSession): PoseFile {
  return session.preview ?? session.history.present
}

/** The meta-tile being edited, or null in an animation's tab. */
export function ownedMeta(session: AnimSession): OwnedMetaDoc | null {
  const current = doc(session)
  return isOwnedMeta(current) ? current : null
}

async function load(session: AnimSession): Promise<void> {
  try {
    const text = await window.api.invoke('fs:read', { path: session.path })
    const raw: unknown = text.trim() ? JSON.parse(text) : {}
    session.history = createHistory<PoseFile>(session.kind === 'metatiles' ? normalizeOwnedMeta(raw) : normalizeTileAnim(raw))
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
      const window_ = parsed.doc.animations.find((binding) => samePath(binding.path, session.path))
      const attached = session.kind === 'anim' ? Boolean(window_) : parsed.doc.metas.some((binding) => samePath(binding.path, session.path))
      if (attached) {
        found.push({
          tileset: entry.path,
          slot: window_?.slot ?? null,
          bank: window_?.bank ?? null,
          cells: window_ ? window_.width * window_.height : 0
        })
      }
    } catch {
      // A tileset that cannot be read is not a reason to break this list.
    }
  }
  session.attachedTo = found
}

/**
 * Removes this meta-tile from one tileset it is attached to, and from the maps
 * drawn with that tileset (`meta-removal.ts`), asking first when one places
 * it. The tileset is saved straight away unless it already had unsaved edits:
 * the maps beside it are rewritten on disk now (open ones with nothing else
 * unsaved included), and no tab may have it open to show it dirty.
 */
export async function removeFromTileset(session: AnimSession, tileset: string): Promise<void> {
  if (session.kind !== 'metatiles') return
  const store = useTilesetStore()
  try {
    await store.load(tileset)
  } catch (error) {
    store.release(tileset)
    session.status = `Couldn't open ${tileset}: ${String(error)}`
    return
  }
  try {
    const wasDirty = store.isDirty(tileset)
    const status = await removeMetaFromTileset(
      tileset,
      session.path,
      () => {
        const current = store.patternDoc(tileset)
        const next = current && detachMeta(current, session.path)
        if (!current || !next || next === current) return false
        store.set(tileset, next, session.path)
        return true
      },
      { persist: !wasDirty }
    )
    if (status === null) return
    if (wasDirty) {
      session.status = `${status} ${tileset.split('/').pop()} has other unsaved edits — save it to keep this.`
    } else {
      if (store.isDirty(tileset)) await store.save(tileset)
      session.status = status
    }
  } catch (error) {
    session.status = `Couldn't save ${tileset}: ${String(error)}`
  } finally {
    store.release(tileset)
  }
  await findAttachments(session)
}

export async function saveSession(session: AnimSession): Promise<void> {
  // Nothing loaded is nothing to save: writing the blank document over a file
  // that failed to open would lose it.
  if (session.error) return
  const current = session.history.present
  await window.api.invoke('fs:write', { path: session.path, content: serialize(session) })
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
export function commit(session: AnimSession, next: PoseFile): void {
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
function poseBlock(anim: PoseDoc): TileBlock {
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
    session.status = `At most ${MAX_ANIM_FRAMES} poses.`
    return
  }
  const source = copyOf !== null ? current.frames[copyOf] : null
  // One blank tile of the document's mode, repeated: an animation's own
  // normalizer would cap a big meta's pose at a window's 16 tiles.
  const blank = normalizeTileAnim({ mode: current.mode, frames: [{}] }).frames[0].tiles[0]
  const frame = source
    ? { duration: source.duration, tiles: source.tiles.map((t) => ({ pattern: t.pattern.slice(), color: t.color.slice() })) }
    : {
        tiles: Array.from({ length: animDocCells(current) }, () => ({ pattern: blank.pattern.slice(), color: blank.color.slice() })),
        duration: current.frames[current.frames.length - 1]?.duration ?? DEFAULT_ANIM_DURATION
      }
  const at = (copyOf ?? current.frames.length - 1) + 1
  const frames = [...current.frames.slice(0, at), frame, ...current.frames.slice(at)]
  commit(session, { ...current, frames })
  session.frame = at
}

export function removeFrame(session: AnimSession, index: number): void {
  const current = doc(session)
  if (current.frames.length <= 1) {
    session.status = 'There has to be at least one pose.'
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
 * Resizes the window, or the meta. Cells keep their place from the top-left;
 * new ones are blank (and opaque). An animation is refused past
 * `MAX_ANIM_CELLS` — and the tilesets it is attached to will refuse to export
 * until their windows have room, which their own validation says. A meta may
 * be up to `MAX_META_SIZE` a side; only what *moves* in it is a window.
 */
export function resize(session: AnimSession, width: number, height: number): void {
  const next = resized(doc(session), width, height)
  if (typeof next === 'string') session.status = next
  else commit(session, next)
}

/** The document at another size, or why it cannot be — `resize`'s rule, also used by a paste that grows a meta. */
function resized(current: PoseFile, width: number, height: number): PoseFile | string {
  const w = Math.max(1, Math.round(width) || 1)
  const h = Math.max(1, Math.round(height) || 1)
  if (isOwnedMeta(current)) {
    if (w > MAX_META_SIZE || h > MAX_META_SIZE) return `A meta-tile is at most ${MAX_META_SIZE}×${MAX_META_SIZE} tiles.`
  } else if (w * h > MAX_ANIM_CELLS) {
    return `An animation window holds at most ${MAX_ANIM_CELLS} tiles.`
  }
  if (w === current.width && h === current.height) return current
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
  if (isOwnedMeta(current)) {
    const holes = Array.from({ length: w * h }, (_, i) => {
      const x = i % w
      const y = Math.floor(i / w)
      return x < current.width && y < current.height ? current.holes[y * current.width + x] : false
    })
    return { ...current, width: w, height: h, frames, holes }
  }
  return { ...current, width: w, height: h, frames }
}

// ── the pixel clipboard (`picture-clipboard.ts`) ─────────────────────────────

/** Copies the current pose's pixels, for a paste into a map or another meta-tile. */
export function copyPose(session: AnimSession): void {
  const current = doc(session)
  pictureClipboard.value = { picture: posePixels(session, session.frame), rgb: paletteToRgb(null), mode: current.mode, from: session.path }
  session.status = `Copied pose ${session.frame + 1} (${current.width}×${current.height} tiles).`
}

/**
 * Pastes the clipboard's pixels into the current pose, top-left on top-left,
 * as one undo step. A meta-tile grows to fit (up to its limit); an animation
 * keeps its window's size and the picture is cut to it. A tile the picture
 * draws into stops being see-through.
 */
export function pastePose(session: AnimSession): void {
  const clip = pictureClipboard.value
  if (!clip) {
    session.status = 'Copy something first — a selection in a map, or a pose.'
    return
  }
  const cols = Math.ceil(clip.picture.width / 8)
  const rows = Math.ceil(clip.picture.height / 8)
  let current = doc(session)
  if (isOwnedMeta(current)) {
    const grown = resized(current, Math.min(MAX_META_SIZE, Math.max(current.width, cols)), Math.min(MAX_META_SIZE, Math.max(current.height, rows)))
    if (typeof grown === 'string') {
      session.status = grown
      return
    }
    current = grown
  }
  const { tiles, lossy } = pictureTiles(current.mode, clip.picture, current.mode === 'sc1' ? current.pair : undefined)
  const at = (i: number): number | null => {
    const x = i % current.width
    const y = Math.floor(i / current.width)
    return x < cols && y < rows ? y * cols + x : null
  }
  const frames = current.frames.map((frame, f) =>
    f !== session.frame ? frame : { ...frame, tiles: frame.tiles.map((tile, i) => (at(i) === null ? tile : tiles[at(i)!])) }
  )
  const drawn = (i: number): boolean => {
    const k = at(i)
    return k !== null && (tiles[k].pattern.some(Boolean) || tiles[k].color.some(Boolean))
  }
  const next: PoseFile = isOwnedMeta(current)
    ? { ...current, frames, holes: current.holes.map((hole, i) => hole && !drawn(i)) }
    : { ...current, frames }
  commit(session, next)
  const cut = cols > current.width || rows > current.height
  session.status =
    `Pasted ${cols}×${rows} tiles into pose ${session.frame + 1}` +
    (lossy ? ` (${lossy} reduced to two colours a row)` : '') +
    (cut ? ` — cut to ${current.width}×${current.height}` : '') +
    '.'
}

// ── an imported picture, floated then placed ─────────────────────────────────

type Picture = { width: number; height: number; indices: Uint8Array }

/** Floats a converted picture over the current pose, top-left, to be moved and then placed. */
export function floatImage(session: AnimSession, picture: Picture): void {
  session.float = { picture, x: 0, y: 0 }
  session.status = 'Drag the picture where it goes, then Place (Enter). Esc cancels.'
}

export function moveFloat(session: AnimSession, x: number, y: number): void {
  if (session.float) session.float = { ...session.float, x, y }
}

export function dropFloat(session: AnimSession): void {
  session.float = null
  session.status = ''
}

/**
 * Cuts the floating picture into the current pose at its size and in its
 * mode's colour rule, as one undo step: what falls outside the pose is cut
 * off, colour 0 leaves the pose's dot under it, and a cell it draws into stops
 * being see-through.
 */
export function placeFloat(session: AnimSession): void {
  const float = session.float
  if (!float) return
  const current = doc(session)
  const pose = posePixels(session, session.frame)
  const drawn = new Set<number>()
  for (let y = 0; y < float.picture.height; y++) {
    for (let x = 0; x < float.picture.width; x++) {
      const px = float.x + x
      const py = float.y + y
      const index = float.picture.indices[y * float.picture.width + x]
      if (!index || px < 0 || py < 0 || px >= pose.width || py >= pose.height) continue
      pose.indices[py * pose.width + px] = index
      drawn.add(Math.floor(py / 8) * current.width + Math.floor(px / 8))
    }
  }
  const { tiles, lossy } = pictureTiles(current.mode, pose, current.mode === 'sc1' ? current.pair : undefined)
  const frames = current.frames.map((frame, f) => (f === session.frame ? { ...frame, tiles } : frame))
  commit(session, isOwnedMeta(current) ? { ...current, frames, holes: current.holes.map((hole, i) => hole && !drawn.has(i)) } : { ...current, frames })
  session.float = null
  session.status = `Placed the picture into pose ${session.frame + 1}` + (lossy ? ` (${lossy} tiles reduced to two colours a row)` : '') + '.'
}

// ── meta-tiles: footprint and flags ─────────────────────────────────────────

export function setHoleMode(session: AnimSession, on: boolean): void {
  session.holeMode = on && session.kind === 'metatiles'
}

/**
 * Makes cell `index` see-through, or opaque again. A see-through cell keeps its
 * art in the file — it is just never drawn — so toggling back loses nothing.
 */
export function toggleHole(session: AnimSession, index: number): void {
  const current = ownedMeta(session)
  if (!current || index < 0 || index >= current.holes.length) return
  const holes = current.holes.slice()
  holes[index] = !holes[index]
  commit(session, { ...current, holes })
  session.status = holes[index]
    ? 'See-through: whatever is under this cell shows, in every pose.'
    : 'Opaque again.'
}

/** Sets or clears gameplay flag `bit` (0-7) — what the meta *means* to the game. */
export function setFlag(session: AnimSession, bit: number, on: boolean): void {
  const current = ownedMeta(session)
  if (!current || bit < 0 || bit > 7) return
  const flags = on ? current.flags | (1 << bit) : current.flags & ~(1 << bit)
  if (flags !== current.flags) commit(session, { ...current, flags })
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
export function stepBytes(file: PoseFile): number {
  // A meta's step rewrites only the cells that move: its window.
  const anim = isOwnedMeta(file) ? metaWindowAnim(file) : file
  if (!anim) return 0
  const cells = animDocCells(anim)
  if (anim.mode === 'sc1') return cells * 8
  return cells * 8 * 3 * (colorsVary(anim) ? 2 : 1)
}

/**
 * The pose a preview shows `ticks` frames (VBlanks) after the start — the same
 * stepping the generated `_Animate()` does, so the preview tells the truth
 * about timing, ping-pong and play-once.
 */
export function poseAtTick(anim: Pick<PoseDoc, 'frames' | 'loop'>, ticks: number): number {
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
