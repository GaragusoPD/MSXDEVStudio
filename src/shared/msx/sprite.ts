/**
 * `*.sprites.json` (Spec 09): hardware sprite planes for both VDP sprite
 * modes, including the mode-2 OR-color composite.
 *
 * Pattern bytes use the VDP's own 16×16 layout — four 8-byte quadrants in the
 * order top-left, bottom-left, top-right, bottom-right — so a pattern table is
 * emitted verbatim.
 *
 * Colors:
 * - **mode 1** one color for the whole plane, in the attribute byte
 *   (`EC<<7 | color`).
 * - **mode 2** one byte per line in the sprite color table:
 *   `EC<<7 | CC<<6 | IC<<5 | color`.
 */

import { defineName, type HelperC } from './emitC'
import type { ExportBlock } from './resource'
import { DEFAULT_ANIM_DURATION, MAX_ANIM_DURATION } from './tile-anim'

export type SpriteMode = 1 | 2
export type SpriteSize = 8 | 16

/** Sprite attribute/color bits — same names and values as MSXgl's `VDP_SPRITE_*`. */
export const SPRITE_EC = 0x80
export const SPRITE_CC = 0x40
export const SPRITE_IC = 0x20
export const SPRITE_COLOR_MASK = 0x0f

/** Planes stacked on one cell — the OR-color limit, not a grid limit. */
export const MAX_LAYERS = 4
/** Cells per axis in a metasprite grid. 4 × 16 = 64 dots, past any practical character. */
export const MAX_GRID = 4

export interface SpriteLayer {
  /** 8 bytes for an 8×8 sprite, 32 for 16×16 (four quadrants). */
  pattern: number[]
  /** Mode 1: the plane's single color index 0–15. */
  color: number
  /** Mode 1: early-clock (shift the plane 32 dots left). */
  ec: boolean
  /** Mode 2: one byte per line, `EC|CC|IC|color`. Always 16 entries (8×8 sprites use the first 8). */
  lineColors: number[]
  /** Mode 2 convenience mirror: true when every line byte has CC set. Writing it rewrites all 16. */
  cc: boolean
  /** Metasprite grid column this plane sits in, in `size` units. 0 for a plain character. */
  cx: number
  /** Metasprite grid row, in `size` units. */
  cy: number
}

export interface SpriteFrame {
  /**
   * Every plane of every cell, flat. Order is priority order within a cell
   * (and the order planes are emitted in); planes of different cells never
   * overlap, so their relative order doesn't matter.
   */
  layers: SpriteLayer[]
  /**
   * How many frames (VBlanks) this frame is held, 1..255 — the unit a
   * meta-tile's poses use, so one number means the same in both. Exported as
   * `_Durations`.
   */
  duration: number
}

/**
 * A frame duration as a file or an input field hands it in: rounded and kept
 * to 1..255, `fallback` for anything that is not a number.
 */
export function clampSpriteDuration(value: unknown, fallback = DEFAULT_ANIM_DURATION): number {
  const n = typeof value === 'number' || typeof value === 'string' ? Math.round(Number(value)) : Number.NaN
  return Number.isFinite(n) ? Math.min(MAX_ANIM_DURATION, Math.max(1, n)) : fallback
}

export interface SpriteCharacter {
  name: string
  /**
   * Metasprite grid, in `size` units: a 32×32 Metal Gear-style character is
   * `cols: 2, rows: 2` of 16×16 hardware sprites. 1×1 is one sprite (plus
   * however many planes are stacked on it).
   */
  cols: number
  rows: number
  /** Animation frames; `frames[0]` is the resting pose. */
  frames: SpriteFrame[]
}

export interface SpritesDoc {
  version: 1
  mode: SpriteMode
  size: SpriteSize
  /** null = the fixed TMS9918A palette; 16 packed GRB333 entries on MSX2. */
  palette: number[] | null
  sprites: SpriteCharacter[]
  export: ExportBlock | null
}

export function patternBytesFor(size: SpriteSize): number {
  return size === 16 ? 32 : 8
}

const zeros = (n: number): number[] => new Array<number>(n).fill(0)

export function createLayer(size: SpriteSize, color = 15, cx = 0, cy = 0): SpriteLayer {
  return {
    pattern: zeros(patternBytesFor(size)),
    color,
    ec: false,
    lineColors: new Array<number>(16).fill(color & SPRITE_COLOR_MASK),
    cc: false,
    cx,
    cy
  }
}

export function createSpritesDoc(mode: SpriteMode = 2, size: SpriteSize = 16): SpritesDoc {
  return normalizeSprites({ mode, size, sprites: [{ name: 'sprite_0', layers: [createLayer(size)] }] })
}

/** Layers of one cell, in document order. */
export function cellLayers(frame: SpriteFrame, cx: number, cy: number): SpriteLayer[] {
  return frame.layers.filter((layer) => layer.cx === cx && layer.cy === cy)
}

function byte(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? ((value | 0) & 0xff) : fallback
}

/** Clamps to `1..max`, falling back to 1 for anything non-numeric. */
function extent(value: unknown, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(1, value | 0)) : 1
}

function normalizeLayer(raw: unknown, size: SpriteSize, cols: number, rows: number): SpriteLayer {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<SpriteLayer>
  const length = patternBytesFor(size)
  const color = typeof input.color === 'number' ? input.color & SPRITE_COLOR_MASK : 15
  const lineColors = Array.from({ length: 16 }, (_, i) =>
    input.lineColors?.[i] === undefined
      ? (input.ec ? SPRITE_EC : 0) | (input.cc ? SPRITE_CC : 0) | color
      : byte(input.lineColors[i])
  )
  // A cell outside the grid would be a plane the editor can't reach, so clamp rather than keep it.
  const cell = (value: unknown, limit: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(limit - 1, Math.max(0, value | 0)) : 0
  return {
    pattern: Array.from({ length }, (_, i) => byte(input.pattern?.[i])),
    color,
    ec: input.ec === true,
    lineColors,
    // Derived, never trusted from the file: the line bytes are what the VDP reads.
    cc: lineColors.every((value) => (value & SPRITE_CC) !== 0),
    cx: cell(input.cx, cols),
    cy: cell(input.cy, rows)
  }
}

/**
 * Accepts both shapes the format allows: a sprite with a bare `layers` array
 * (frame 0) and/or an explicit `frames` array. `frames[0]` always wins when
 * both are present, which is how `serializeSprites` writes them back.
 */
export function normalizeSprites(raw: unknown): SpritesDoc {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const mode: SpriteMode = input.mode === 1 ? 1 : 2
  const size: SpriteSize = input.size === 8 ? 8 : 16
  const rawSprites = Array.isArray(input.sprites) ? input.sprites : []

  const sprites = rawSprites.map((entry, index) => {
    const sprite = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>
    const cols = extent(sprite.cols, MAX_GRID)
    const rows = extent(sprite.rows, MAX_GRID)
    const rawFrames = Array.isArray(sprite.frames) && sprite.frames.length ? sprite.frames : null
    const frameSources = rawFrames ?? [{ layers: sprite.layers }]
    const frames: SpriteFrame[] = frameSources.map((frame) => {
      const layers = (frame as { layers?: unknown })?.layers
      const duration = clampSpriteDuration((frame as { duration?: unknown })?.duration)
      const list = Array.isArray(layers) && layers.length ? layers : [null]
      // MAX_LAYERS is the OR-color stack per cell, so the cap is counted per cell, not per frame.
      const perCell = new Map<string, number>()
      const kept: SpriteLayer[] = []
      for (const raw of list) {
        const layer = normalizeLayer(raw, size, cols, rows)
        const key = `${layer.cx},${layer.cy}`
        const count = perCell.get(key) ?? 0
        if (count >= MAX_LAYERS) continue
        perCell.set(key, count + 1)
        kept.push(layer)
      }
      // Also on load, so a sheet that already carries the mistake heals itself.
      return lockLeadingCc({ layers: kept.length ? kept : [createLayer(size)], duration }, mode)
    })
    return { name: String(sprite.name ?? `sprite_${index}`), cols, rows, frames }
  })

  const palette =
    Array.isArray(input.palette) && (input.palette as unknown[]).length
      ? Array.from({ length: 16 }, (_, i) => Number((input.palette as number[])[i]) || 0)
      : null

  return {
    version: 1,
    mode,
    size,
    palette: mode === 2 ? palette : null,
    sprites: sprites.length
      ? sprites
      : [{ name: 'sprite_0', cols: 1, rows: 1, frames: [{ layers: [createLayer(size)], duration: DEFAULT_ANIM_DURATION }] }],
    export: (input.export as ExportBlock | undefined) ?? null
  }
}

/** Writes the on-disk shape from Spec 09: `layers` mirrors `frames[0].layers`. */
export function serializeSprites(doc: SpritesDoc): unknown {
  return {
    version: 1,
    mode: doc.mode,
    size: doc.size,
    palette: doc.palette,
    sprites: doc.sprites.map((sprite) => ({
      name: sprite.name,
      cols: sprite.cols,
      rows: sprite.rows,
      layers: sprite.frames[0]?.layers ?? [],
      // Duration first: it is the one field a person reads, above a wall of bytes.
      frames: sprite.frames.map((frame) => ({ duration: frame.duration, layers: frame.layers }))
    })),
    export: doc.export
  }
}

// ── pattern pixels ──────────────────────────────────────────────────────────

/** Byte index and bit mask for pixel (x, y) in the VDP's quadrant layout. */
function patternBit(x: number, y: number, size: SpriteSize): { index: number; mask: number } {
  if (size === 8) return { index: y, mask: 0x80 >> x }
  const quadrant = (x < 8 ? 0 : 2) + (y < 8 ? 0 : 1)
  return { index: quadrant * 8 + (y & 7), mask: 0x80 >> (x & 7) }
}

export function getSpritePixel(layer: SpriteLayer, x: number, y: number, size: SpriteSize): boolean {
  const { index, mask } = patternBit(x, y, size)
  return (layer.pattern[index] & mask) !== 0
}

/** Returns a new layer — the editors keep a plain undo stack over whole documents. */
export function setSpritePixel(layer: SpriteLayer, x: number, y: number, size: SpriteSize, on: boolean): SpriteLayer {
  const { index, mask } = patternBit(x, y, size)
  const pattern = layer.pattern.slice()
  pattern[index] = on ? pattern[index] | mask : pattern[index] & ~mask & 0xff
  return { ...layer, pattern }
}

/** The color byte the VDP uses for this layer on line `y`. */
export function lineColorByte(layer: SpriteLayer, y: number, mode: SpriteMode): number {
  if (mode === 1) return (layer.ec ? SPRITE_EC : 0) | (layer.color & SPRITE_COLOR_MASK)
  return layer.lineColors[y] ?? 0
}

export function setLineColorByte(layer: SpriteLayer, y: number, value: number): SpriteLayer {
  const lineColors = layer.lineColors.slice()
  lineColors[y] = value & 0xff
  return { ...layer, lineColors, cc: lineColors.every((v) => (v & SPRITE_CC) !== 0) }
}

/**
 * Clears CC on a frame's first plane — the one place the bit can never mean
 * anything. CC says "share the priority of the nearest plane above me whose CC
 * is 0", and above the first plane there is nothing, so the VDP does not draw
 * such a plane at all: MSX2 Technical Handbook 4.5, *"To display the sprite
 * whose CC is '1', CC bit of the sprite which has smaller number should be set
 * to '0'."* A set bit here costs a whole plane and reports nothing, which is
 * exactly the mistake that is impossible to see in an editor.
 *
 * Enforced rather than merely validated, and enforced *here* rather than in the
 * panel, because a plane can also arrive at the front by being reordered or by
 * having the plane above it deleted — no checkbox guards those. With the first
 * plane clear every later plane is legal by construction, so this one rule
 * keeps the whole frame legal.
 *
 * Mode 1 has no CC bit, so its line bytes are left alone.
 */
export function lockLeadingCc(frame: SpriteFrame, mode: SpriteMode): SpriteFrame {
  const first = frame.layers[0]
  if (mode !== 2 || !first || !first.lineColors.some((value) => (value & SPRITE_CC) !== 0)) return frame
  const lineColors = first.lineColors.map((value) => value & ~SPRITE_CC & 0xff)
  return { ...frame, layers: [{ ...first, lineColors, cc: false }, ...frame.layers.slice(1)] }
}

/** Sets (or clears) CC on all 16 lines — the layer-level `cc` toggle in the editor. */
export function setLayerCc(layer: SpriteLayer, cc: boolean): SpriteLayer {
  const lineColors = layer.lineColors.map((value) => (cc ? value | SPRITE_CC : value & ~SPRITE_CC & 0xff))
  return { ...layer, lineColors, cc }
}

// ── OR-color composite (the Spec 09 core) ───────────────────────────────────

/**
 * The composite color the VDP shows at (x, y) for one frame's planes, in
 * *character* space — for a metasprite that is the whole `cols × rows` grid,
 * and each plane only answers for dots inside its own cell.
 * Returns 0 when nothing is displayed (sprite color 0 is transparent).
 *
 * VDP rule (MSX2 Technical Handbook 4.5, sprite mode 2): a plane whose CC bit
 * is set "has the same priority as the sprite that has higher priority than
 * this sprite, whose CC bit is 0, and that is nearest to this sprite plane",
 * and "when sprites having the same priority are overlapped, the colour for
 * which OR of both colour codes is displayed". So the planes split into
 * priority groups that each start at a CC=0 plane; inside a group the colors
 * of every plane with a pixel at this dot are OR'ed, and the first group with
 * any pixel there wins outright over lower-priority groups.
 *
 * Mode 1 has no CC bit: every plane is its own group, i.e. plain priority.
 */
export function compositePixel(
  layers: readonly SpriteLayer[],
  x: number,
  y: number,
  mode: SpriteMode,
  size: SpriteSize
): number {
  let groupColor = 0
  let groupHasPixel = false

  for (const layer of layers) {
    // Character space → this plane's own 8×8/16×16 space. Out-of-cell dots
    // simply have no pixel, and their (zero) color byte closes the group,
    // which is what a lower-priority plane would do anyway.
    const lx = x - layer.cx * size
    const ly = y - layer.cy * size
    const inCell = lx >= 0 && ly >= 0 && lx < size && ly < size
    const byteValue = inCell ? lineColorByte(layer, ly, mode) : 0
    const startsGroup = mode === 1 || (byteValue & SPRITE_CC) === 0
    if (startsGroup) {
      // The previous group is complete: if it painted this dot, it wins.
      if (groupHasPixel) return groupColor
      groupColor = 0
      groupHasPixel = false
    }
    if (inCell && getSpritePixel(layer, lx, ly, size)) {
      groupColor |= byteValue & SPRITE_COLOR_MASK
      groupHasPixel = true
    }
  }
  return groupHasPixel ? groupColor : 0
}

/**
 * `(cols·size) × (rows·size)` composite color indices, row-major.
 * 0 = transparent. The default 1×1 grid is one hardware sprite.
 */
export function compositeFrame(
  layers: readonly SpriteLayer[],
  mode: SpriteMode,
  size: SpriteSize,
  cols = 1,
  rows = 1
): Uint8Array {
  const width = cols * size
  const height = rows * size
  const out = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) out[y * width + x] = compositePixel(layers, x, y, mode, size)
  }
  return out
}

// ── mode / size conversion ──────────────────────────────────────────────────

/**
 * Switches sprite mode, keeping every pattern byte. 1 → 2 spreads the plane
 * color over all 16 line bytes; 2 → 1 keeps line 0's color and drops the rest
 * (the editor warns about that loss).
 */
export function convertSpriteMode(doc: SpritesDoc, mode: SpriteMode): SpritesDoc {
  if (doc.mode === mode) return doc
  const sprites = doc.sprites.map((sprite) => ({
    ...sprite,
    frames: sprite.frames.map((frame) => ({
      ...frame,
      layers: frame.layers.map((layer) => {
        if (mode === 2) {
          const value = (layer.ec ? SPRITE_EC : 0) | (layer.color & SPRITE_COLOR_MASK)
          return { ...layer, lineColors: new Array<number>(16).fill(value), cc: false }
        }
        const first = layer.lineColors[0] ?? 0
        return { ...layer, color: first & SPRITE_COLOR_MASK, ec: (first & SPRITE_EC) !== 0 }
      })
    }))
  }))
  return { ...doc, mode, palette: mode === 2 ? doc.palette : null, sprites }
}

// ── export bytes ────────────────────────────────────────────────────────────

function eachLayer(doc: SpritesDoc, visit: (layer: SpriteLayer) => void): void {
  for (const sprite of doc.sprites) for (const frame of sprite.frames) for (const layer of frame.layers) visit(layer)
}

/** Every plane's pattern, in sprite → frame → layer order. */
export function spritePatternBytes(doc: SpritesDoc): Uint8Array {
  const out: number[] = []
  eachLayer(doc, (layer) => out.push(...layer.pattern))
  return Uint8Array.from(out)
}

/** Mode 1: one attribute color byte per plane. Mode 2: the 16-byte line-color block per plane. */
export function spriteColorBytes(doc: SpritesDoc): Uint8Array {
  const out: number[] = []
  eachLayer(doc, (layer) => {
    if (doc.mode === 1) out.push(lineColorByte(layer, 0, 1))
    else out.push(...layer.lineColors)
  })
  return Uint8Array.from(out)
}

/**
 * Where each character sits in the flat plane order the pattern, color and
 * layout tables share — what the emitted `#define`s carry so game code can
 * address one character out of a sheet.
 */
export interface SpritePlacement {
  name: string
  /** Plane index of the character's first frame. */
  base: number
  /** Planes per frame (identical across a character's frames — `validateSprites` checks it). */
  planes: number
  frames: number
  /** Index of the character's first frame in `_Durations`: frames of the characters before it. */
  frame0: number
}

export function spritePlacements(doc: SpritesDoc): SpritePlacement[] {
  let base = 0
  let frame0 = 0
  return doc.sprites.map((sprite) => {
    const planes = sprite.frames[0]?.layers.length ?? 0
    const placement = { name: sprite.name, base, planes, frames: sprite.frames.length, frame0 }
    base += sprite.frames.reduce((sum, frame) => sum + frame.layers.length, 0)
    frame0 += sprite.frames.length
    return placement
  })
}

/** VDP pattern numbers per plane: a 16×16 sprite is four 8×8 patterns. */
export function spritePatternStep(size: SpriteSize): number {
  return size === 16 ? 4 : 1
}

/** Planes the VDP's sprite pattern table holds: 256 patterns of 8×8, so 64 of 16×16. */
export function spritePatternCapacity(size: SpriteSize): number {
  return 256 / spritePatternStep(size)
}

/** Every plane of every frame of every character — what the pattern table has to hold. */
export function spritePlaneCount(doc: SpritesDoc): number {
  return doc.sprites.reduce((sum, sprite) => sum + sprite.frames.reduce((n, frame) => n + frame.layers.length, 0), 0)
}

/**
 * True once some character has a second frame — when there is something to
 * time, so `_Durations`, `_FRAME0` and the animation helpers are emitted.
 */
export function hasSpriteAnimation(doc: SpritesDoc): boolean {
  return doc.sprites.some((sprite) => sprite.frames.length > 1)
}

/** One byte per frame, characters in sheet order: how many VBlanks it is held. */
export function spriteDurationBytes(doc: SpritesDoc): Uint8Array {
  return Uint8Array.from(doc.sprites.flatMap((sprite) => sprite.frames.map((frame) => frame.duration & 0xff)))
}

/**
 * Characters whose names make the same C identifier as an earlier one's
 * (`sprite_1` twice — `addSprite` names by count, so a delete and an add
 * repeat one — or `Hero` and `hero`). Two sets of the same `#define`s would
 * be a redefinition, so only the first gets them; the header says which.
 */
export function spriteNameClashes(doc: SpritesDoc): { index: number; name: string; first: number }[] {
  const seen = new Map<string, number>()
  const clashes: { index: number; name: string; first: number }[] = []
  doc.sprites.forEach((sprite, index) => {
    const id = defineName(sprite.name)
    const first = seen.get(id)
    if (first === undefined) seen.set(id, index)
    else clashes.push({ index, name: sprite.name, first })
  })
  return clashes
}

/**
 * Where each character is, as `#define`s: game code addresses one character
 * out of a sheet by these rather than by counting frames, which is what broke
 * the first time a character before it grew a frame.
 *
 * - `_CHARS`, `_PLANE_PATTERNS`: the sheet's character count, and VDP
 *   patterns per plane (4 at 16×16, 1 at 8×8).
 * - per character: `_BASE` (first plane), `_PLANES` (per frame), `_FRAMES`,
 *   `_ID` (its position — what the helpers take as `chr`), `_PATTERN` (the
 *   VDP pattern number of its first plane with the sheet loaded at pattern 0),
 *   and `_FRAME0` (its first frame in `_Durations`) once a `_Durations` exists.
 *
 * The suffixes hold no underscore, so two different names can never produce
 * the same `#define` — except names that are the same identifier already
 * (`spriteNameClashes`), which get none.
 */
export function spriteConstants(doc: SpritesDoc, name: string): string[] {
  const prefix = defineName(name)
  const step = spritePatternStep(doc.size)
  const animated = hasSpriteAnimation(doc)
  const skipped = new Set(spriteNameClashes(doc).map((clash) => clash.index))
  return [
    `#define ${prefix}_CHARS ${doc.sprites.length}`,
    `#define ${prefix}_PLANE_PATTERNS ${step}`,
    ...spritePlacements(doc).flatMap((placement, index) => {
      if (skipped.has(index)) return []
      const id = `${prefix}_${defineName(placement.name)}`
      return [
        `#define ${id}_BASE ${placement.base}`,
        `#define ${id}_PLANES ${placement.planes}`,
        `#define ${id}_FRAMES ${placement.frames}`,
        `#define ${id}_ID ${index}`,
        `#define ${id}_PATTERN ${placement.base * step}`,
        ...(animated ? [`#define ${id}_FRAME0 ${placement.frame0}`] : [])
      ]
    })
  ]
}

/** Header notes for a sheet's defines: the characters left without any, and a sheet too big for the VDP. */
export function spriteNotes(doc: SpritesDoc): string[] {
  const notes = spriteNameClashes(doc).map(
    ({ index, name, first }) =>
      `No defines for character ${index} (${name}): its C name is the same as character ${first}’s (${doc.sprites[first].name}) — rename one`
  )
  const planes = spritePlaneCount(doc)
  const capacity = spritePatternCapacity(doc.size)
  if (planes > capacity) {
    notes.push(
      `${planes} planes, more than the ${capacity} ${doc.size}×${doc.size} sprite patterns the VDP holds: load the sheet in parts — ` +
        '_PATTERN and the helpers assume it whole at pattern 0'
    )
  }
  return notes
}

/** True once a character spans more than one cell of the grid. */
export function hasMetasprite(doc: SpritesDoc): boolean {
  return doc.sprites.some((sprite) => sprite.cols * sprite.rows > 1)
}

/**
 * True once some character is drawn by more than one hardware sprite — by
 * spanning cells, by stacking planes on one cell (superposition, the only way
 * to get a multi-color character in sprite mode 1), or both. That is exactly
 * the case where placing the character means writing several attribute
 * entries from one coordinate, so it's what the layout table and the
 * `_SetMeta` helper are emitted for.
 */
export function hasSpriteGroups(doc: SpritesDoc): boolean {
  return doc.sprites.some((sprite) => sprite.cols * sprite.rows > 1 || (sprite.frames[0]?.layers.length ?? 0) > 1)
}

/**
 * Two bytes per plane — `dx, dy` in dots from the character's top-left — in
 * the same plane order as the pattern table. Everything else a plane needs
 * (its pattern number, its slice of the color table) follows from that index,
 * so the table stays two bytes wide.
 */
export function spriteLayoutBytes(doc: SpritesDoc): Uint8Array {
  const out: number[] = []
  eachLayer(doc, (layer) => out.push((layer.cx * doc.size) & 0xff, (layer.cy * doc.size) & 0xff))
  return Uint8Array.from(out)
}

/**
 * The ready-made C the export can carry alongside the tables: one function
 * that writes a whole character's hardware sprites from a single coordinate.
 * Opt-in (`ExportBlock.helpers`) because it calls into MSXgl's VDP module,
 * which a data-only header must not depend on.
 */
export function spriteHelperC(doc: SpritesDoc, name: string): HelperC {
  const prefix = name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()
  // 16×16 sprites take four VRAM patterns each; 8×8 take one.
  const step = doc.size === 16 ? 4 : 1
  const setSprite =
    doc.mode === 1
      ? `VDP_SetSpriteSM1(index + i, px, py, plane * ${step}, ${name}_Colors[plane]);`
      : `VDP_SetSpriteExMultiColor(index + i, px, py, plane * ${step}, ${name}_Colors + ((u16)plane * 16));`
  const signature = `void ${name}_SetMeta(u8 index, u8 x, u8 y, u8 base, u8 planes)`
  return {
    header: [
    '',
    `// Places one character of ${name} as a group of hardware sprites, from a single`,
    '// coordinate. Needs MSXgl\'s VDP module (#include "msxgl.h" before this header),',
    `// and the patterns loaded at VRAM pattern 0:`,
    `//   VDP_LoadSpritePattern(${name}_Patterns, 0, ${prefix}_PATTERNS_SIZE / 8);`,
    '//',
    '// Parameters:',
    '//   index  - first hardware sprite plane to write [0:31]',
    '//   x, y   - screen position of the character\'s top-left corner',
    `//   base   - first plane of the frame to show: ${prefix}_<CHARACTER>_BASE + frame * ..._PLANES`,
    '//   planes - ..._PLANES for that character',
    `${signature};`
    ],
    source: [
    '',
    signature,
    '{',
    `\tconst u8* rec = ${name}_Layout + ((u16)base * 2);`,
    '\tfor(u8 i = 0; i < planes; ++i)',
    '\t{',
    '\t\tu8 plane = base + i;',
    '\t\tu8 px = x + rec[0];',
    '\t\tu8 py = y + rec[1];',
    '\t\trec += 2;',
    `\t\t${setSprite}`,
    '\t}',
    '}'
    ]
  }
}

/**
 * The animation helpers, emitted beside `_SetMeta` once some character has a
 * second frame: show one frame of a character, and step a character by its
 * `_Durations`. What they need per character sits in one `static const u8`
 * table in the `.c` — four bytes each, indexed rather than switched on (SDCC
 * 4.x miscompiles constant arguments inlined into `case 0:`). A byte is
 * enough: the pattern table holds at most 256 planes, the limit `_SetMeta`'s
 * `plane * step` already lives with (`spriteNotes` says when a sheet passes it).
 *
 * Every call is MSXgl's own: `VDP_SetSpritePattern`, and `VDP_SetSpriteColorSM1`
 * (mode 1) or `VDP_SetSpriteMultiColor` (mode 2, MSX2 only — as is the mode).
 */
export function spriteAnimHelperC(doc: SpritesDoc, name: string): HelperC {
  const prefix = defineName(name)
  const step = spritePatternStep(doc.size)
  const placements = spritePlacements(doc)
  const info = placements.flatMap((placement) => [placement.base, placement.planes, placement.frames, placement.frame0])
  const clashes = new Set(spriteNameClashes(doc).map((clash) => clash.index))
  const shown = placements.findIndex((placement, index) => placement.frames > 1 && !clashes.has(index))
  const chr = shown >= 0 ? `${prefix}_${defineName(placements[shown].name)}_ID` : '0'
  const setColor =
    doc.mode === 1
      ? `VDP_SetSpriteColorSM1(index + i, ${name}_Colors[plane]);`
      : `VDP_SetSpriteMultiColor(index + i, ${name}_Colors + ((u16)plane * 16));`
  const setFrame = `void ${name}_SetFrame(u8 index, u8 chr, u8 frame)`
  const animStep = `bool ${name}_AnimStep(u8 chr, u8* state)`
  return {
    header: [
      '',
      `// ── ${name}: sprite animation ─────────────────────────────────────────`,
      '//',
      `// chr below is a character's ${prefix}_<CHARACTER>_ID. Needs MSXgl's VDP`,
      '// module (#include "msxgl.h" before this header), and the patterns loaded',
      '// at VRAM pattern 0:',
      `//   VDP_LoadSpritePattern(${name}_Patterns, 0, ${prefix}_PATTERNS_SIZE / 8);`,
      '//',
      '// Shows frame `frame` of character chr on hardware sprites index onward, one',
      `// per plane (${prefix}_<CHARACTER>_PLANES of them): patterns and colours only,`,
      '// the positions are left as they are — place the sprites first (VDP_SetSprite...,',
      '// or _SetMeta for a group). A frame past the last shows frame 0; a chr past',
      '// the last character does nothing.',
      `${setFrame};`,
      '',
      "// Steps character chr's animation on by one VBlank. Call it once a frame with",
      '// two bytes kept per animation — state[0] the frame shown, state[1] the VBlanks',
      `// spent on it — and show state[0] when it returns TRUE. Each frame is held for`,
      `// its ${name}_Durations entry, in VBlanks, and the animation loops.`,
      '// RAM is not cleared at boot on a ROM target: zero state before the first',
      '// step (a frame past the last starts over at 0, and returns TRUE).',
      '//',
      '// Example:',
      '//   u8 anim[2] = { 0, 0 };',
      `//   ${name}_SetFrame(0, ${chr}, 0);`,
      '//   while(1)',
      '//   {',
      '//       Halt();',
      `//       if(${name}_AnimStep(${chr}, anim))`,
      `//           ${name}_SetFrame(0, ${chr}, anim[0]);`,
      '//   }',
      `${animStep};`
    ],
    source: [
      '',
      `// Per character: first plane, planes per frame, frames, first frame in ${name}_Durations.`,
      `static const u8 ${name}_CharInfo[${prefix}_CHARS * 4] = { ${info.join(', ')} };`,
      '',
      setFrame,
      '{',
      `\tif(chr >= ${prefix}_CHARS) return;`,
      `\tconst u8* info = ${name}_CharInfo + ((u16)chr * 4);`,
      '\tif(frame >= info[2]) frame = 0;',
      '\tu8 plane = info[0] + frame * info[1];',
      '\tfor(u8 i = 0; i < info[1]; ++i, ++plane)',
      '\t{',
      `\t\tVDP_SetSpritePattern(index + i, plane * ${step});`,
      `\t\t${setColor}`,
      '\t}',
      '}',
      '',
      animStep,
      '{',
      `\tif(chr >= ${prefix}_CHARS) return FALSE;`,
      `\tconst u8* info = ${name}_CharInfo + ((u16)chr * 4);`,
      '\tu8 f = state[0];',
      '\t// Clamped: a frame past the last means nobody zeroed state.',
      '\tif(f >= info[2])',
      '\t{',
      '\t\tstate[0] = 0;',
      '\t\tstate[1] = 0;',
      '\t\treturn TRUE;',
      '\t}',
      `\tif(++state[1] < ${name}_Durations[info[3] + f]) return FALSE;`,
      '\tstate[1] = 0;',
      '\tif(++f >= info[2]) f = 0;',
      '\tif(f == state[0]) return FALSE;',
      '\tstate[0] = f;',
      '\treturn TRUE;',
      '}'
    ]
  }
}

export function validateSprites(doc: SpritesDoc): string[] {
  const problems: string[] = []
  if (doc.version !== 1) problems.push(`Unsupported version ${doc.version}`)
  if (doc.mode !== 1 && doc.mode !== 2) problems.push(`Unknown sprite mode ${doc.mode}`)
  if (doc.size !== 8 && doc.size !== 16) problems.push(`Unknown sprite size ${doc.size}`)
  const length = patternBytesFor(doc.size)
  doc.sprites.forEach((sprite, s) => {
    if (!sprite.frames.length) problems.push(`Sprite ${s} (${sprite.name}) has no frames`)
    // The emitted per-character offsets are `base + frame * planes`, which only
    // holds while every frame spends the same number of planes.
    if (sprite.frames.some((frame) => frame.layers.length !== sprite.frames[0].layers.length)) {
      problems.push(`${sprite.name}: frames don't all have the same layer count`)
    }
    if (sprite.cols < 1 || sprite.cols > MAX_GRID || sprite.rows < 1 || sprite.rows > MAX_GRID) {
      problems.push(`${sprite.name}: grid ${sprite.cols}×${sprite.rows} outside 1..${MAX_GRID}`)
    }
    sprite.frames.forEach((frame, f) => {
      if (!frame.layers.length) problems.push(`${sprite.name} frame ${f} has no layers`)
      const perCell = new Map<string, number>()
      frame.layers.forEach((layer) => {
        const key = `${layer.cx},${layer.cy}`
        perCell.set(key, (perCell.get(key) ?? 0) + 1)
      })
      for (const [cell, count] of perCell) {
        if (count > MAX_LAYERS) problems.push(`${sprite.name} frame ${f} cell (${cell}) has more than ${MAX_LAYERS} layers`)
      }
      frame.layers.forEach((layer, l) => {
        if (layer.cx >= sprite.cols || layer.cy >= sprite.rows || layer.cx < 0 || layer.cy < 0) {
          problems.push(`${sprite.name} frame ${f} layer ${l}: cell (${layer.cx},${layer.cy}) outside the ${sprite.cols}×${sprite.rows} grid`)
        }
        if (layer.pattern.length !== length) {
          problems.push(`${sprite.name} frame ${f} layer ${l}: expected ${length} pattern bytes`)
        }
        if (doc.mode === 2 && layer.lineColors.length !== 16) {
          problems.push(`${sprite.name} frame ${f} layer ${l}: expected 16 line colors`)
        }
      })
    })
  })
  if (doc.palette && doc.palette.some((value) => (value & ~0x0777) !== 0)) {
    problems.push('Palette entry outside the GRB333 space')
  }
  return problems
}
