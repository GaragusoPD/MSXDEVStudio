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

import type { ExportBlock } from './resource'

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
      return { layers: kept.length ? kept : [createLayer(size)] }
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
    sprites: sprites.length ? sprites : [{ name: 'sprite_0', cols: 1, rows: 1, frames: [{ layers: [createLayer(size)] }] }],
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
      frames: sprite.frames
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
}

export function spritePlacements(doc: SpritesDoc): SpritePlacement[] {
  let base = 0
  return doc.sprites.map((sprite) => {
    const planes = sprite.frames[0]?.layers.length ?? 0
    const placement = { name: sprite.name, base, planes, frames: sprite.frames.length }
    base += sprite.frames.reduce((sum, frame) => sum + frame.layers.length, 0)
    return placement
  })
}

/** True once a character spans more than one hardware sprite — the only case that needs a layout table. */
export function hasMetasprite(doc: SpritesDoc): boolean {
  return doc.sprites.some((sprite) => sprite.cols * sprite.rows > 1)
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
export function spriteHelperC(doc: SpritesDoc, name: string): string[] {
  const prefix = name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()
  // 16×16 sprites take four VRAM patterns each; 8×8 take one.
  const step = doc.size === 16 ? 4 : 1
  const setSprite =
    doc.mode === 1
      ? `VDP_SetSpriteSM1(index + i, px, py, plane * ${step}, ${name}_Colors[plane]);`
      : `VDP_SetSpriteExMultiColor(index + i, px, py, plane * ${step}, ${name}_Colors + ((u16)plane * 16));`
  return [
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
    `static void ${name}_SetMeta(u8 index, u8 x, u8 y, u8 base, u8 planes)`,
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
