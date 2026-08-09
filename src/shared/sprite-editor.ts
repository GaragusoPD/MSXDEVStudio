/**
 * Sprite editor (Spec 09) — the editor-side logic that isn't hardware
 * knowledge: undo history, tool strokes, frame/sprite/layer list operations,
 * size/mode conversion loss checks, the scanline budget hint, PNG-strip
 * import, and animation playback ticking.
 *
 * Everything here is pure and DOM-free, so it lives in `shared/` where
 * Vitest already runs; `editors/sprite/*.vue` is a thin shell on top. All
 * *hardware* rules — pattern layout, OR-color composite, mode conversion,
 * validation — stay in `shared/msx/sprite.ts` and are only ever called from
 * here.
 */

import type { History } from './history'
import {
  cellLayers,
  createLayer,
  getSpritePixel,
  lockLeadingCc,
  MAX_GRID,
  MAX_LAYERS,
  setSpritePixel,
  SPRITE_COLOR_MASK,
  type SpriteCharacter,
  type SpriteFrame,
  type SpriteLayer,
  type SpriteMode,
  type SpriteSize,
  type SpritesDoc
} from './msx/sprite'

// ── undo/redo ────────────────────────────────────────────────────────────

/** The shared past/present/future stack, over this editor's document. */
export type SpriteHistory = History<SpritesDoc>
export { createHistory, pushHistory, undo, redo } from './history'

// ── active-target helper ─────────────────────────────────────────────────

export interface SpriteTarget {
  sprite: number
  frame: number
  layer: number
}

/** Replaces the item at `index` via `fn`; returns the same array reference when `fn` didn't change it. */
function mapAt<T>(list: readonly T[], index: number, fn: (item: T) => T): T[] {
  const next = fn(list[index])
  return next === list[index] ? (list as T[]) : list.map((item, i) => (i === index ? next : item))
}

/** Replaces one layer's data via `fn`; a true no-op (including an out-of-range target) returns `doc` unchanged. */
export function updateLayer(doc: SpritesDoc, target: SpriteTarget, fn: (layer: SpriteLayer) => SpriteLayer): SpritesDoc {
  const sprite = doc.sprites[target.sprite]
  const frame = sprite?.frames[target.frame]
  const layer = frame?.layers[target.layer]
  if (!sprite || !frame || !layer) return doc
  const sprites = mapAt(doc.sprites, target.sprite, (s) => {
    const frames = mapAt(s.frames, target.frame, (f) => {
      const layers = mapAt(f.layers, target.layer, fn)
      return lockLeadingCc(layers === f.layers ? f : { layers }, doc.mode)
    })
    return frames === s.frames ? s : { ...s, frames }
  })
  return sprites === doc.sprites ? doc : { ...doc, sprites }
}

/** Every frame of `sprite` with the leading-CC rule applied; same reference when none needed it. */
function lockFrames(sprite: SpriteCharacter, mode: SpriteMode): SpriteCharacter {
  const frames = sprite.frames.map((frame) => lockLeadingCc(frame, mode))
  return frames.every((frame, i) => frame === sprite.frames[i]) ? sprite : { ...sprite, frames }
}

/** A true no-op `fn` (including an out-of-range index) returns `doc` unchanged. */
function updateSprite(doc: SpritesDoc, index: number, fn: (sprite: SpriteCharacter) => SpriteCharacter): SpritesDoc {
  if (!doc.sprites[index]) return doc
  // Every plane list change lands here — add, delete, reorder, grid change — so
  // this is where a plane that has just *become* the first one gets its CC cleared.
  const sprites = mapAt(doc.sprites, index, (sprite) => lockFrames(fn(sprite), doc.mode))
  return sprites === doc.sprites ? doc : { ...doc, sprites }
}

// ── stroke tools (pure layer transforms) ────────────────────────────────

export type SpriteTool = 'pencil' | 'erase' | 'line' | 'fill'

export function paintPixel(layer: SpriteLayer, x: number, y: number, size: SpriteSize, on: boolean): SpriteLayer {
  if (x < 0 || y < 0 || x >= size || y >= size) return layer
  return setSpritePixel(layer, x, y, size, on)
}

/** Bresenham line between two points (inclusive) — also what a freehand drag uses between two mouse samples. */
export function paintLine(
  layer: SpriteLayer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  size: SpriteSize,
  on: boolean
): SpriteLayer {
  let x = x0
  let y = y0
  const dx = Math.abs(x1 - x0)
  const dy = -Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1
  const sy = y0 < y1 ? 1 : -1
  let err = dx + dy
  let out = layer
  for (;;) {
    out = paintPixel(out, x, y, size, on)
    if (x === x1 && y === y1) break
    const e2 = 2 * err
    if (e2 >= dy) {
      err += dy
      x += sx
    }
    if (e2 <= dx) {
      err += dx
      y += sy
    }
  }
  return out
}

/** Flood-fills the 4-connected region sharing `(x,y)`'s on/off state. No-op if that pixel is already `on`. */
export function floodFill(layer: SpriteLayer, x: number, y: number, size: SpriteSize, on: boolean): SpriteLayer {
  if (x < 0 || y < 0 || x >= size || y >= size) return layer
  const target = getSpritePixel(layer, x, y, size)
  if (target === on) return layer
  let out = layer
  const seen = new Set<number>()
  const stack: [number, number][] = [[x, y]]
  while (stack.length) {
    const [cx, cy] = stack.pop() as [number, number]
    if (cx < 0 || cy < 0 || cx >= size || cy >= size) continue
    const key = cy * size + cx
    if (seen.has(key)) continue
    seen.add(key)
    if (getSpritePixel(out, cx, cy, size) !== target) continue
    out = setSpritePixel(out, cx, cy, size, on)
    stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1])
  }
  return out
}

export function mirrorLayer(layer: SpriteLayer, size: SpriteSize, axis: 'x' | 'y'): SpriteLayer {
  let out = layer
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const on = getSpritePixel(layer, x, y, size)
      const tx = axis === 'x' ? size - 1 - x : x
      const ty = axis === 'y' ? size - 1 - y : y
      out = setSpritePixel(out, tx, ty, size, on)
    }
  }
  return out
}

/** Translates the pattern by `(dx, dy)`, wrapping around the edges. */
export function shiftLayer(layer: SpriteLayer, size: SpriteSize, dx: number, dy: number): SpriteLayer {
  const wrap = (v: number): number => ((v % size) + size) % size
  const source = Array.from({ length: size }, (_, y) => Array.from({ length: size }, (_, x) => getSpritePixel(layer, x, y, size)))
  let out = layer
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) out = setSpritePixel(out, wrap(x + dx), wrap(y + dy), size, source[y][x])
  }
  return out
}

// ── frame / sprite / layer list ops ─────────────────────────────────────

function cloneLayers(layers: readonly SpriteLayer[]): SpriteLayer[] {
  return layers.map((layer) => ({ ...layer, pattern: [...layer.pattern], lineColors: [...layer.lineColors] }))
}

/** A blank frame with the same layer count/cells/colors as frame 0, so the character stays visually consistent. */
export function addFrame(doc: SpritesDoc, spriteIndex: number): SpritesDoc {
  return updateSprite(doc, spriteIndex, (sprite) => ({
    ...sprite,
    frames: [
      ...sprite.frames,
      {
        layers: sprite.frames[0].layers.map((source) => ({
          ...createLayer(doc.size, source.color, source.cx, source.cy),
          ec: source.ec,
          lineColors: source.lineColors.slice(),
          cc: source.cc
        }))
      }
    ]
  }))
}

export function cloneFrame(doc: SpritesDoc, spriteIndex: number, frameIndex: number): SpritesDoc {
  return updateSprite(doc, spriteIndex, (sprite) => {
    const source = sprite.frames[frameIndex]
    if (!source) return sprite
    const frames = sprite.frames.slice()
    frames.splice(frameIndex + 1, 0, { layers: cloneLayers(source.layers) })
    return { ...sprite, frames }
  })
}

export function removeFrame(doc: SpritesDoc, spriteIndex: number, frameIndex: number): SpritesDoc {
  return updateSprite(doc, spriteIndex, (sprite) =>
    sprite.frames.length <= 1 ? sprite : { ...sprite, frames: sprite.frames.filter((_, i) => i !== frameIndex) }
  )
}

export function reorderFrame(doc: SpritesDoc, spriteIndex: number, from: number, to: number): SpritesDoc {
  return updateSprite(doc, spriteIndex, (sprite) => {
    if (from === to || !sprite.frames[from] || !sprite.frames[to]) return sprite
    const frames = sprite.frames.slice()
    const [moved] = frames.splice(from, 1)
    frames.splice(to, 0, moved)
    return { ...sprite, frames }
  })
}

export function addSprite(doc: SpritesDoc): SpritesDoc {
  const name = `sprite_${doc.sprites.length}`
  return { ...doc, sprites: [...doc.sprites, { name, cols: 1, rows: 1, frames: [{ layers: [createLayer(doc.size)] }] }] }
}

export function duplicateSprite(doc: SpritesDoc, index: number): SpritesDoc {
  const source = doc.sprites[index]
  if (!source) return doc
  const copy: SpriteCharacter = {
    ...source,
    name: `${source.name}_copy`,
    frames: source.frames.map((frame) => ({ layers: cloneLayers(frame.layers) }))
  }
  const sprites = doc.sprites.slice()
  sprites.splice(index + 1, 0, copy)
  return { ...doc, sprites }
}

export function removeSprite(doc: SpritesDoc, index: number): SpritesDoc {
  if (doc.sprites.length <= 1 || !doc.sprites[index]) return doc
  return { ...doc, sprites: doc.sprites.filter((_, i) => i !== index) }
}

export function renameSprite(doc: SpritesDoc, index: number, name: string): SpritesDoc {
  return updateSprite(doc, index, (sprite) => ({ ...sprite, name }))
}

/**
 * Adds a blank plane on cell `(cx, cy)` to every frame, keeping the layer
 * count in sync across frames; no-op once that cell holds MAX_LAYERS (the
 * OR-color stack limit is per hardware sprite, so each cell gets its own 4).
 */
export function addLayer(doc: SpritesDoc, spriteIndex: number, cx = 0, cy = 0): SpritesDoc {
  return updateSprite(doc, spriteIndex, (sprite) => ({
    ...sprite,
    frames: sprite.frames.map((frame) =>
      cellLayers(frame, cx, cy).length >= MAX_LAYERS ? frame : { layers: [...frame.layers, createLayer(doc.size, 15, cx, cy)] }
    )
  }))
}

/**
 * Removes one layer index from every frame; no-op if any frame would be left
 * with none. A cell *may* end up empty — that just means the metasprite
 * doesn't spend a hardware sprite there.
 */
export function removeLayer(doc: SpritesDoc, spriteIndex: number, layerIndex: number): SpritesDoc {
  return updateSprite(doc, spriteIndex, (sprite) =>
    sprite.frames.some((frame) => frame.layers.length <= 1)
      ? sprite
      : { ...sprite, frames: sprite.frames.map((frame) => ({ layers: frame.layers.filter((_, i) => i !== layerIndex) })) }
  )
}

/**
 * Moves a plane in *every* frame at once. Array order is the OR-stack priority
 * `compositePixel` reads and the order `eachLayer` exports in, so it has to
 * stay identical across frames — same reason `addLayer`/`removeLayer` do.
 */
export function reorderLayer(doc: SpritesDoc, spriteIndex: number, from: number, to: number): SpritesDoc {
  return updateSprite(doc, spriteIndex, (sprite) => {
    const layers = sprite.frames[0]?.layers
    if (from === to || !layers?.[from] || !layers[to]) return sprite
    return {
      ...sprite,
      frames: sprite.frames.map((frame) => {
        const moved = frame.layers.slice()
        moved.splice(to, 0, ...moved.splice(from, 1))
        return { layers: moved }
      })
    }
  })
}

/** Index of the first plane on cell `(cx, cy)`, or -1 — what a canvas click selects. */
export function layerAtCell(frame: SpriteFrame, cx: number, cy: number): number {
  return frame.layers.findIndex((layer) => layer.cx === cx && layer.cy === cy)
}

/**
 * Resizes a character's metasprite grid. Growing gives every new cell one
 * blank plane so it can be drawn on immediately; shrinking drops the planes
 * that fall outside — which is real pixel loss, so the editor confirms first
 * (`gridShrinkLossy`).
 */
export function setCharacterGrid(doc: SpritesDoc, spriteIndex: number, cols: number, rows: number): SpritesDoc {
  const clamp = (value: number): number => Math.min(MAX_GRID, Math.max(1, value | 0))
  const nextCols = clamp(cols)
  const nextRows = clamp(rows)
  return updateSprite(doc, spriteIndex, (sprite) => {
    if (sprite.cols === nextCols && sprite.rows === nextRows) return sprite
    const added: { cx: number; cy: number }[] = []
    for (let cy = 0; cy < nextRows; cy++) {
      for (let cx = 0; cx < nextCols; cx++) if (cx >= sprite.cols || cy >= sprite.rows) added.push({ cx, cy })
    }
    return {
      ...sprite,
      cols: nextCols,
      rows: nextRows,
      frames: sprite.frames.map((frame) => ({
        layers: [
          ...frame.layers.filter((layer) => layer.cx < nextCols && layer.cy < nextRows),
          ...added.map(({ cx, cy }) => createLayer(doc.size, 15, cx, cy))
        ]
      }))
    }
  })
}

/** True when shrinking to `cols × rows` would discard planes that carry pixels. */
export function gridShrinkLossy(doc: SpritesDoc, spriteIndex: number, cols: number, rows: number): boolean {
  const sprite = doc.sprites[spriteIndex]
  if (!sprite) return false
  return sprite.frames.some((frame) =>
    frame.layers.some(
      (layer) => (layer.cx >= cols || layer.cy >= rows) && layer.pattern.some((value) => value !== 0)
    )
  )
}

// ── size conversion (editor-level convenience; the VDP only ever has 8 or 16) ──

/** True when shrinking 16→8 would discard set pixels outside the kept top-left 8×8 quadrant. */
export function sizeConversionLossy(doc: SpritesDoc, targetSize: SpriteSize): boolean {
  if (doc.size !== 16 || targetSize !== 8) return false
  return doc.sprites.some((sprite) =>
    sprite.frames.some((frame) =>
      frame.layers.some((layer) => {
        for (let y = 0; y < 16; y++) {
          for (let x = 0; x < 16; x++) {
            if ((x >= 8 || y >= 8) && getSpritePixel(layer, x, y, 16)) return true
          }
        }
        return false
      })
    )
  )
}

/** Re-anchors every pattern at the top-left corner: growing pads with transparent pixels, shrinking crops. */
export function convertSpriteSize(doc: SpritesDoc, size: SpriteSize): SpritesDoc {
  if (doc.size === size) return doc
  const from = doc.size
  const min = Math.min(from, size)
  const sprites = doc.sprites.map((sprite) => ({
    ...sprite,
    frames: sprite.frames.map((frame) => ({
      layers: frame.layers.map((layer) => {
        let out: SpriteLayer = {
          ...createLayer(size, layer.color, layer.cx, layer.cy),
          ec: layer.ec,
          lineColors: layer.lineColors.slice(),
          cc: layer.cc
        }
        for (let y = 0; y < min; y++) {
          for (let x = 0; x < min; x++) {
            if (getSpritePixel(layer, x, y, from)) out = setSpritePixel(out, x, y, size, true)
          }
        }
        return out
      })
    }))
  }))
  return { ...doc, size, sprites }
}

// ── mode conversion loss check (the conversion itself is `convertSpriteMode`) ──

/** True when 2→1 would discard real per-line color data (line variation, or an OR-color CC plane). */
export function modeConversionLossy(doc: SpritesDoc, targetMode: SpriteMode): boolean {
  if (doc.mode !== 2 || targetMode !== 1) return false
  return doc.sprites.some((sprite) =>
    sprite.frames.some((frame) =>
      frame.layers.some((layer) => {
        const base = layer.lineColors[0] & SPRITE_COLOR_MASK
        return layer.cc || layer.lineColors.some((v) => (v & SPRITE_COLOR_MASK) !== base)
      })
    )
  )
}

// ── scanline budget hint ─────────────────────────────────────────────────

export interface ScanlineBudget {
  limit: number
  total: number
  exceeded: boolean
}

/**
 * What one character costs on the scanline it crosses: the planes of its
 * busiest *cell row*, in its resting pose. Stacked planes (superposition) all
 * land on the same lines and each cost one; a second row of cells sits `size`
 * dots lower and never shares a scanline with the first, so rows don't add up.
 */
export function characterPlaneCost(sprite: SpriteCharacter): number {
  const perRow = new Map<number, number>()
  for (const layer of sprite.frames[0]?.layers ?? []) perRow.set(layer.cy, (perRow.get(layer.cy) ?? 0) + 1)
  return Math.max(0, ...perRow.values())
}

/**
 * ponytail: the editor has no notion of on-screen placement, so this sums every
 * character's `characterPlaneCost` — what you'd burn if every character were
 * placed on the same scanline. Upgrade to real placement tracking if a
 * scene/map editor ever knows actual sprite Y coordinates.
 */
export function scanlineBudget(doc: SpritesDoc): ScanlineBudget {
  const limit = doc.mode === 1 ? 4 : 8
  const total = doc.sprites.reduce((sum, sprite) => sum + characterPlaneCost(sprite), 0)
  return { limit, total, exceeded: total > limit }
}

// ── PNG-strip import ─────────────────────────────────────────────────────

/** Assigns a quantized source palette index (0-15) to a target layer slot (0..MAX_LAYERS-1), or null to skip it. */
export type LayerAssignment = (sourceIndex: number) => number | null

/**
 * Slices a horizontal filmstrip into `size`-square frames (ponytail: strips are
 * assumed single-row; rows beyond `size` are ignored) and decomposes each one
 * onto up to `MAX_LAYERS` layers per `assign`. A layer's color is whichever
 * mapped source index is found first (ascending) — layers are hardware
 * monochrome (mode 1) or one color per line (mode 2), so two source colors
 * assigned to the same layer share that first color; map them to separate
 * layers if they need to stay visually distinct.
 */
export function stripToFrames(
  indices: Uint8Array,
  width: number,
  height: number,
  size: SpriteSize,
  assign: LayerAssignment
): SpriteFrame[] {
  const frameCount = Math.max(1, Math.floor(width / size))
  const rows = Math.min(size, height)
  const frames: SpriteFrame[] = []

  for (let f = 0; f < frameCount; f++) {
    const colorOfSlot = new Map<number, number>()
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < size; x++) {
        const source = indices[y * width + f * size + x]
        if (!source) continue
        const slot = assign(source)
        if (slot === null || colorOfSlot.has(slot)) continue
        colorOfSlot.set(slot, source)
      }
    }
    const slots = [...colorOfSlot.keys()].sort((a, b) => a - b).slice(0, MAX_LAYERS)
    const layers = slots.map((slot) => {
      const color = colorOfSlot.get(slot) as number
      let layer = createLayer(size, color)
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < size; x++) {
          const source = indices[y * width + f * size + x]
          if (source && assign(source) === slot) layer = setSpritePixel(layer, x, y, size, true)
        }
      }
      return layer
    })
    frames.push({ layers: layers.length ? layers : [createLayer(size)] })
  }
  return frames
}

// ── animation playback ───────────────────────────────────────────────────

export interface PlaybackState {
  frameIndex: number
  /** Leftover time (ms) not yet consumed by a frame advance. */
  elapsedMs: number
}

/** Advances playback by `deltaMs` at `fps`, wrapping the frame index. `frameCount <= 1` never advances. */
export function tickPlayback(state: PlaybackState, deltaMs: number, fps: number, frameCount: number): PlaybackState {
  if (frameCount <= 1) return { frameIndex: 0, elapsedMs: 0 }
  const frameDuration = 1000 / Math.max(1, fps)
  let elapsedMs = state.elapsedMs + deltaMs
  let frameIndex = state.frameIndex % frameCount
  while (elapsedMs >= frameDuration) {
    elapsedMs -= frameDuration
    frameIndex = (frameIndex + 1) % frameCount
  }
  return { frameIndex, elapsedMs }
}
