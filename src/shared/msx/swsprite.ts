/**
 * `*.swsprites.json`: **software sprites** — objects the CPU or the VDP's
 * blitter draws into the picture, as against the 32 the sprite hardware puts on
 * top of it.
 *
 * A different thing from `*.sprites.json`, which is the hardware: that one is
 * one-bit planes, an OR-colour stack and the 4-or-8-per-line ceiling. This one
 * is images. It exists because hardware sprites run out — of colours, of size,
 * of per-line slots — and because SCREEN 3 and the bitmap modes can afford to
 * draw into the frame instead.
 *
 * ## Every character carries its own size
 *
 * That is the whole reason this is not a `*.btiles.json` with named blocks. A
 * tile bank has one size for the entire bank, so a 16×16 hero and an 8×8 bullet
 * cannot live in one file; a sprite sheet is exactly the case where they must.
 * Frames of *one* character are all the same size — that is what makes an
 * animation — and different characters are not.
 *
 * ## Three modes of transport, one document
 *
 * The document is the same everywhere: palette indices, frames end to end. What
 * the bytes become differs, because the hardware does:
 *
 * - **SCREEN 3** — frames are packed two blocks to a byte and blitted out of
 *   ROM by the CPU into a shadow buffer. No command engine on an MSX1.
 * - **Bitmap (5/6/7/8)** — every frame goes into one wide strip, uploaded to
 *   off-screen VRAM once with `HMMC`; drawing is `LMMM` with `VDP_OP_TIMP`, so
 *   transparency is the VDP's and the CPU writes coordinates, not pixels.
 * - **Tiled (1/2/4)** — there are no pixels to blit. A frame becomes whole 8×8
 *   cells' patterns and colours, written into a reserved band of the pattern
 *   table with the name table pointed at them. That is what a software sprite
 *   *is* in a pattern mode, and it is why sizes there are multiples of 8.
 *
 * `swSpriteFamily` is the one place that fork is decided; everything else asks
 * it rather than testing the mode again.
 */

import { defineName, type HelperC } from './emitC'
import { isTileMode, MODES, type BitmapMode } from './modes'
import type { ExportBlock } from './resource'
// Base64 for `BitmapTilesDoc`'s reason: an eight-frame 16×16 character is 2048
// numbers, and as JSON that is a file nobody can diff anyway. The pair lives in
// `screen.ts` and is already chunked against `fromCharCode`'s argument limit.
import { decodeIndices as decode, encodeIndices as encode, packBitmap } from './screen'
import { sc3LinearBytes, sc3LinearPack, SC3_BLOCK_DOTS } from './sc3'
import { tileFromPixels, TILE_SIZE } from './tile'

/** Modes a software sprite can be drawn for. SCREEN 0 has no pixels; 10/12 are import-only. */
export const SW_MODES = ['sc1', 'sc2', 'sc3', 'sc4', 'sc5', 'sc6', 'sc7', 'sc8'] as const
export type SwMode = (typeof SW_MODES)[number]

/** Past this a "sprite" is a screen; the cap only stops a bad file allocating forever. */
export const MAX_SW_SIZE = 128
export const MAX_SW_FRAMES = 64
export const MAX_SW_SPRITES = 64

export interface SwSpriteChar {
  name: string
  /**
   * Frame size in the mode's own unit: 4×4 **blocks** in SCREEN 3, dots
   * everywhere else. `swSpriteDots` converts when a renderer needs real
   * proportions.
   */
  width: number
  height: number
  /** Animation frames. All the same size — that is what makes them frames. */
  frames: number
  /** Base64, one palette index per pixel, frames end to end. */
  pixels: string
}

export interface SwSpritesDoc {
  version: 1
  mode: SwMode
  /** 16 packed GRB333 entries on the V9938's programmable modes; null on the fixed ones. */
  palette: number[] | null
  /**
   * The index a masked draw leaves alone.
   *
   * Not nullable, unlike a tileset's: a sprite that cannot be drawn over
   * something is a rectangle, and every one of these is drawn over something.
   * 0 is the default because it is the MSX1 palette's own transparent.
   */
  transparent: number
  sprites: SwSpriteChar[]
  export: ExportBlock | null
}

export type SwFamily = 'sc3' | 'bitmap' | 'tiled'

/** Which of the three transports this mode uses. The single fork in the file. */
export function swSpriteFamily(mode: SwMode): SwFamily {
  if (mode === 'sc3') return 'sc3'
  return isTileMode(mode) ? 'tiled' : 'bitmap'
}

/**
 * The granularity a frame's width and height must land on, in the mode's unit.
 *
 * Never a style rule — each one is a hardware boundary the blitter cannot see
 * past. Two blocks share a SCREEN 3 byte; a bitmap byte holds
 * `pixelsPerByte` dots and the VDP copies whole bytes; a pattern mode has
 * nothing smaller than a character cell.
 */
export function swSizeStep(mode: SwMode): { x: number; y: number } {
  if (mode === 'sc3') return { x: 2, y: 1 }
  if (isTileMode(mode)) return { x: TILE_SIZE, y: TILE_SIZE }
  return { x: MODES[mode].pixelsPerByte, y: 1 }
}

/** Dots per document unit — 4 in SCREEN 3, whose unit is a block, 1 elsewhere. */
export function swSpriteDots(mode: SwMode): number {
  return mode === 'sc3' ? SC3_BLOCK_DOTS : 1
}

const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = Math.round(Number(value))
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
}

/** Rounds up to the mode's step, so a size the hardware cannot draw never reaches the document. */
export function snapSize(mode: SwMode, width: number, height: number): { width: number; height: number } {
  const step = swSizeStep(mode)
  const up = (value: number, to: number): number => Math.max(to, Math.ceil(value / to) * to)
  return { width: up(width, step.x), height: up(height, step.y) }
}

/** The default frame size for a mode: one character cell in a tiled mode, 16 dots otherwise. */
export function defaultSwSize(mode: SwMode): { width: number; height: number } {
  if (mode === 'sc3') return { width: 4, height: 4 }
  if (isTileMode(mode)) return { width: 16, height: 16 }
  return { width: 16, height: 16 }
}

export function createSwSpritesDoc(mode: SwMode = 'sc3'): SwSpritesDoc {
  return normalizeSwSprites({ mode, sprites: [{ name: 'player' }] })
}

/** Fills in everything a hand-edited or older file is missing; never throws. */
export function normalizeSwSprites(raw: unknown): SwSpritesDoc {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<SwSpritesDoc>
  const mode: SwMode = (SW_MODES as readonly string[]).includes(String(input.mode)) ? (input.mode as SwMode) : 'sc3'
  const rawSprites = Array.isArray(input.sprites) && input.sprites.length ? input.sprites : [{ name: 'player' }]
  return {
    version: 1,
    mode,
    palette:
      Array.isArray(input.palette) && MODES[mode].palette === 'grb333'
        ? input.palette.slice(0, 16).map((value) => Number(value) || 0)
        : MODES[mode].palette === 'grb333'
          ? new Array<number>(16).fill(0)
          : null,
    transparent: clamp(input.transparent, 0, 15, 0),
    sprites: rawSprites.slice(0, MAX_SW_SPRITES).map((entry, index) => normalizeChar(entry, mode, index)),
    export: (input.export as ExportBlock) ?? null
  }
}

function normalizeChar(raw: unknown, mode: SwMode, index: number): SwSpriteChar {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<SwSpriteChar>
  const fallback = defaultSwSize(mode)
  const size = snapSize(
    mode,
    clamp(input.width, 1, MAX_SW_SIZE, fallback.width),
    clamp(input.height, 1, MAX_SW_SIZE, fallback.height)
  )
  const frames = clamp(input.frames, 1, MAX_SW_FRAMES, 1)
  const per = size.width * size.height
  const stored = typeof input.pixels === 'string' ? decode(input.pixels) : new Uint8Array(0)
  const pixels = new Uint8Array(frames * per)
  pixels.set(stored.subarray(0, pixels.length))
  return {
    name: String(input.name ?? `sprite_${index}`),
    width: size.width,
    height: size.height,
    frames,
    pixels: encode(pixels)
  }
}

/** One frame's indices, row-major. Empty when the sprite or frame does not exist. */
export function swFramePixels(doc: SwSpritesDoc, sprite: number, frame: number): Uint8Array {
  const character = doc.sprites[sprite]
  if (!character) return new Uint8Array(0)
  const per = character.width * character.height
  const all = decode(character.pixels)
  const at = frame * per
  const out = new Uint8Array(per)
  out.set(all.subarray(at, at + per))
  return out
}

/** Replaces one frame's indices, returning a new document. */
export function setSwFramePixels(
  doc: SwSpritesDoc,
  sprite: number,
  frame: number,
  pixels: ArrayLike<number>
): SwSpritesDoc {
  const character = doc.sprites[sprite]
  if (!character) return doc
  const per = character.width * character.height
  const all = decode(character.pixels)
  const at = frame * per
  if (at + per > all.length) return doc
  let changed = false
  for (let i = 0; i < per; i++) {
    const value = (pixels[i] ?? 0) & 0xff
    if (all[at + i] !== value) {
      all[at + i] = value
      changed = true
    }
  }
  if (!changed) return doc
  const sprites = doc.sprites.slice()
  sprites[sprite] = { ...character, pixels: encode(all) }
  return { ...doc, sprites }
}

/** Resizes a character, cropping rather than scaling — the same rule tilesets follow. */
export function resizeSwSprite(doc: SwSpritesDoc, sprite: number, width: number, height: number): SwSpritesDoc {
  const character = doc.sprites[sprite]
  if (!character) return doc
  const size = snapSize(doc.mode, width, height)
  if (size.width === character.width && size.height === character.height) return doc
  const from = decode(character.pixels)
  const out = new Uint8Array(character.frames * size.width * size.height)
  for (let frame = 0; frame < character.frames; frame++) {
    for (let y = 0; y < Math.min(size.height, character.height); y++) {
      for (let x = 0; x < Math.min(size.width, character.width); x++) {
        out[frame * size.width * size.height + y * size.width + x] =
          from[frame * character.width * character.height + y * character.width + x] ?? 0
      }
    }
  }
  const sprites = doc.sprites.slice()
  sprites[sprite] = { ...character, width: size.width, height: size.height, pixels: encode(out) }
  return { ...doc, sprites }
}

/** Adds or removes frames, keeping the ones that stay. */
export function setSwFrameCount(doc: SwSpritesDoc, sprite: number, frames: number): SwSpritesDoc {
  const character = doc.sprites[sprite]
  if (!character) return doc
  const count = clamp(frames, 1, MAX_SW_FRAMES, character.frames)
  if (count === character.frames) return doc
  const per = character.width * character.height
  const from = decode(character.pixels)
  const out = new Uint8Array(count * per)
  out.set(from.subarray(0, Math.min(from.length, out.length)))
  const sprites = doc.sprites.slice()
  sprites[sprite] = { ...character, frames: count, pixels: encode(out) }
  return { ...doc, sprites }
}

export function addSwSprite(doc: SwSpritesDoc, name: string): SwSpritesDoc {
  if (doc.sprites.length >= MAX_SW_SPRITES) return doc
  const size = defaultSwSize(doc.mode)
  return {
    ...doc,
    sprites: [...doc.sprites, normalizeChar({ name, ...size, frames: 1 }, doc.mode, doc.sprites.length)]
  }
}

export function removeSwSprite(doc: SwSpritesDoc, sprite: number): SwSpritesDoc {
  if (doc.sprites.length <= 1 || !doc.sprites[sprite]) return doc
  return { ...doc, sprites: doc.sprites.filter((_, index) => index !== sprite) }
}

export function renameSwSprite(doc: SwSpritesDoc, sprite: number, name: string): SwSpritesDoc {
  if (!doc.sprites[sprite]) return doc
  const sprites = doc.sprites.slice()
  sprites[sprite] = { ...sprites[sprite], name }
  return { ...doc, sprites }
}

// ── export ──────────────────────────────────────────────────────────────────

/** Bytes one frame takes in the exported table, which is the transport's business. */
export function swFrameBytes(doc: SwSpritesDoc, character: SwSpriteChar): number {
  switch (swSpriteFamily(doc.mode)) {
    case 'sc3':
      return sc3LinearBytes(character.width, character.height)
    case 'tiled':
      // Per 8×8 cell: eight pattern bytes then eight colour bytes, so one cell is
      // one contiguous run and the runtime writes it to two tables in one pass.
      return (character.width / TILE_SIZE) * (character.height / TILE_SIZE) * TILE_SIZE * 2
    default:
      return Math.ceil(character.width / MODES[doc.mode].pixelsPerByte) * character.height
  }
}

export interface SwSpriteLayout {
  bytes: Uint8Array
  /** Per sprite, in document order: where its first frame starts in `bytes`. */
  offsets: number[]
  /** Bitmap modes only: the sheet the strip was packed as, for `_Upload`. */
  sheet?: { width: number; height: number }
}

/**
 * Every frame of every character, in one table.
 *
 * Bitmap modes lay them **side by side as one image**, because that is what a
 * single `HMMC` can upload into off-screen VRAM and what an `LMMM` then reads a
 * rectangle out of. The other two families read the table linearly out of ROM,
 * so their frames are simply concatenated.
 */
export function swSpriteLayout(doc: SwSpritesDoc): SwSpriteLayout {
  const family = swSpriteFamily(doc.mode)
  if (family === 'bitmap') return bitmapStrip(doc)

  const offsets: number[] = []
  const parts: Uint8Array[] = []
  let at = 0
  for (const character of doc.sprites) {
    offsets.push(at)
    for (let frame = 0; frame < character.frames; frame++) {
      const pixels = swFramePixels(doc, doc.sprites.indexOf(character), frame)
      const packed =
        family === 'sc3'
          ? sc3LinearPack(pixels, 0, 0, character.width, character.height, character.width)
          : tiledFrameBytes(pixels, character.width, character.height)
      parts.push(packed)
      at += packed.length
    }
  }
  const bytes = new Uint8Array(at)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return { bytes, offsets }
}

/**
 * A pattern-mode frame: each 8×8 cell reduced to the two colours per row the
 * hardware allows, emitted as eight pattern bytes then eight colour bytes.
 *
 * The reduction is `tileFromPixels`', the same one the tile editor and the
 * image importer use — a software sprite in SCREEN 2 lives under exactly the
 * colour-clash rule everything else there does, and `validateSwSprites` is what
 * says so before the bytes are silently flattened.
 */
function tiledFrameBytes(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const cols = width / TILE_SIZE
  const rows = height / TILE_SIZE
  const out = new Uint8Array(cols * rows * TILE_SIZE * 2)
  let at = 0
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const cell = new Uint8Array(TILE_SIZE * TILE_SIZE)
      for (let y = 0; y < TILE_SIZE; y++) {
        for (let x = 0; x < TILE_SIZE; x++) {
          cell[y * TILE_SIZE + x] = pixels[(cy * TILE_SIZE + y) * width + cx * TILE_SIZE + x] ?? 0
        }
      }
      const entry = tileFromPixels(cell)
      for (let y = 0; y < TILE_SIZE; y++) out[at + y] = entry.pattern[y]
      for (let y = 0; y < TILE_SIZE; y++) out[at + TILE_SIZE + y] = entry.color[y]
      at += TILE_SIZE * 2
    }
  }
  return out
}

/** The bitmap-mode strip: every frame of every character side by side, one image. */
function bitmapStrip(doc: SwSpritesDoc): SwSpriteLayout {
  const height = Math.max(1, ...doc.sprites.map((character) => character.height))
  let width = 0
  const offsets: number[] = []
  for (const character of doc.sprites) {
    offsets.push(width)
    width += character.width * character.frames
  }
  width = Math.max(1, width)
  const indices = new Uint8Array(width * height)
  doc.sprites.forEach((character, sprite) => {
    for (let frame = 0; frame < character.frames; frame++) {
      const pixels = swFramePixels(doc, sprite, frame)
      const ox = offsets[sprite] + frame * character.width
      for (let y = 0; y < character.height; y++) {
        for (let x = 0; x < character.width; x++) {
          indices[y * width + ox + x] = pixels[y * character.width + x]
        }
      }
    }
  })
  return {
    // Only reached for the bitmap family, which is exactly `packBitmap`'s domain.
    bytes: packBitmap(indices, width, height, doc.mode as BitmapMode),
    offsets,
    sheet: { width, height }
  }
}

/**
 * Per sprite: `baseLo, baseHi, width, height, frames`.
 *
 * Five bytes rather than a define per character, because a game with a table of
 * enemies indexes this at run time; the `#define`s in `swSpriteConstants` are
 * for the ones it names in source.
 */
export function swSpriteInfoBytes(doc: SwSpritesDoc): Uint8Array {
  const layout = swSpriteLayout(doc)
  return Uint8Array.from(
    doc.sprites.flatMap((character, index) => [
      layout.offsets[index] & 0xff,
      (layout.offsets[index] >> 8) & 0xff,
      character.width & 0xff,
      character.height & 0xff,
      character.frames & 0xff
    ])
  )
}

export function swSpriteConstants(doc: SwSpritesDoc, name: string): string[] {
  const prefix = defineName(name)
  const layout = swSpriteLayout(doc)
  const family = swSpriteFamily(doc.mode)
  const widest = Math.max(0, ...doc.sprites.map((character) => character.width))
  const lines = [
    `#define ${prefix}_COUNT ${doc.sprites.length}`,
    `#define ${prefix}_TRANSPARENT ${doc.transparent}`
  ]
  if (family === 'sc3') {
    // Both nibbles transparent, so a wholly empty byte is one compare rather
    // than two shifts.
    lines.push(
      `#define ${prefix}_TRANSPARENT_PAIR 0x${(((doc.transparent << 4) | doc.transparent) & 0xff)
        .toString(16)
        .toUpperCase()
        .padStart(2, '0')}`,
      // One buffer big enough for the largest frame serves any object.
      `#define ${prefix}_SAVE_BYTES ${Math.max(
        0,
        ...doc.sprites.map((character) => swFrameBytes(doc, character))
      )}`
    )
  }
  if (layout.sheet) {
    lines.push(
      `#define ${prefix}_SHEET_W ${layout.sheet.width}`,
      `#define ${prefix}_SHEET_H ${layout.sheet.height}`,
      // Backups sit side by side under the sheet; the widest frame plus the
      // HMMM byte-alignment margin is how far apart they have to be.
      `#define ${prefix}_BACKUP_PITCH ${widest + 4}`
    )
  }
  if (family === 'tiled') {
    // The reserved pattern range: the biggest sprite's cell count decides how
    // much each on-screen object borrows, and where the range can start.
    const slotCells = Math.max(
      1,
      ...doc.sprites.map((character) => (character.width / TILE_SIZE) * (character.height / TILE_SIZE))
    )
    lines.push(
      `#define ${prefix}_SLOT_CELLS ${slotCells}`,
      `// Patterns from here up belong to the sprites — keep the map off them.`,
      `#define ${prefix}_FIRST_PATTERN 192`
    )
  }
  doc.sprites.forEach((character, index) => {
    const own = `${prefix}_${defineName(character.name)}`
    lines.push(
      `#define ${own} ${index}`,
      `#define ${own}_W ${character.width}`,
      `#define ${own}_H ${character.height}`,
      `#define ${own}_FRAMES ${character.frames}`
    )
  })
  return lines
}

export function validateSwSprites(doc: SwSpritesDoc): string[] {
  const problems: string[] = []
  if (doc.version !== 1) problems.push(`Unsupported version ${doc.version}`)
  if (!(SW_MODES as readonly string[]).includes(doc.mode)) problems.push(`"${doc.mode}" cannot hold software sprites`)
  if (!doc.sprites.length) problems.push('No sprites')
  const step = swSizeStep(doc.mode)
  const unit = doc.mode === 'sc3' ? 'blocks' : 'dots'
  for (const character of doc.sprites) {
    if (character.width % step.x || character.height % step.y) {
      problems.push(
        `"${character.name}" is ${character.width}×${character.height} ${unit}; ${doc.mode} needs a multiple of ` +
          `${step.x}×${step.y} — the blitter cannot see inside one`
      )
    }
  }
  if (swSpriteFamily(doc.mode) === 'tiled') {
    // Two colours per 8×1 row is the mode's rule, and `tileFromPixels` silently
    // flattens anything richer. Say it here, where the art can still be changed.
    doc.sprites.forEach((character, sprite) => {
      for (let frame = 0; frame < character.frames; frame++) {
        const pixels = swFramePixels(doc, sprite, frame)
        for (let y = 0; y < character.height; y++) {
          const row = new Set<number>()
          for (let x = 0; x < character.width; x++) row.add(pixels[y * character.width + x])
          if (row.size > 2) {
            problems.push(
              `"${character.name}" frame ${frame + 1} row ${y} uses ${row.size} colours; ${doc.mode} allows two per ` +
                '8-dot row and the extras will be merged'
            )
            break
          }
        }
      }
    })
  }
  return problems
}

/** The ready-made C, which is a different runtime per transport. */
export function swSpriteHelperC(doc: SwSpritesDoc, name: string): HelperC {
  switch (swSpriteFamily(doc.mode)) {
    case 'sc3':
      return sc3SwHelperC(doc, name)
    case 'bitmap':
      return bitmapSwHelperC(doc, name)
    default:
      return tiledSwHelperC(doc, name)
  }
}

function sc3SwHelperC(doc: SwSpritesDoc, name: string): HelperC {
  const prefix = defineName(name)
  return {
    header: [
      '',
      `// ── ${name}: SCREEN 3 software sprites ────────────────────────────────`,
      '//',
      '// Drawn into the shadow buffer a screen resource flushes, so they are not',
      '// subject to the 4-per-line sprite limit and can be any size and any mix',
      `// of the sixteen colours. Colour ${doc.transparent} is left alone.`,
      '//',
      '// `x` must be even: two blocks share a VRAM byte and this copies bytes.',
      '// Nothing clips — keep the whole frame on screen.',
      '//',
      `// \`save\` needs ${prefix}_SAVE_BYTES bytes per object on screen at once.`,
      '//',
      '// These do not touch the screen resource\'s dirty flags — it is a different',
      '// header. Call its _Mark(x, y, w, h) after drawing, then its _Flush().',
      '//',
      '// Example:',
      `//   ${name}_Restore(buf, under, ${prefix}_PLAYER, oldX, oldY);`,
      `//   ${name}_Save(buf, under, ${prefix}_PLAYER, x, y);`,
      `//   ${name}_Draw(buf, ${prefix}_PLAYER, frame, x, y);`,
      '',
      `u8   ${name}_Width(u8 sprite);`,
      `u8   ${name}_Height(u8 sprite);`,
      `void ${name}_Draw(u8* buf, u8 sprite, u8 frame, u8 x, u8 y);`,
      `void ${name}_Save(const u8* buf, u8* save, u8 sprite, u8 x, u8 y);`,
      `void ${name}_Restore(u8* buf, const u8* save, u8 sprite, u8 x, u8 y);`
    ],
    source: [
      '',
      `static u16 ${name}_Offset(u8 x, u8 y)`,
      '{',
      '\treturn ((u16)(y & 0xF8) << 5) | ((u16)(x >> 1) << 3) | (y & 7);',
      '}',
      '',
      `// _Info is baseLo, baseHi, width, height, frames for each sprite.`,
      `u8 ${name}_Width(u8 sprite) { return ${name}_Info[(u16)sprite * 5 + 2]; }`,
      `u8 ${name}_Height(u8 sprite) { return ${name}_Info[(u16)sprite * 5 + 3]; }`,
      '',
      `static const u8* ${name}_Frame(u8 sprite, u8 frame)`,
      '{',
      `\tconst u8* info = ${name}_Info + ((u16)sprite * 5);`,
      '\tu8 stride = (info[2] + 1) >> 1;',
      `\treturn ${name}_Data + (info[0] | ((u16)info[1] << 8)) + ((u16)frame * stride * info[3]);`,
      '}',
      '',
      `void ${name}_Draw(u8* buf, u8 sprite, u8 frame, u8 x, u8 y)`,
      '{',
      `\tconst u8* info = ${name}_Info + ((u16)sprite * 5);`,
      `\tconst u8* src = ${name}_Frame(sprite, frame);`,
      '\tu8 stride = (info[2] + 1) >> 1;',
      '\tu8 rows = info[3];',
      '\tu8 row, col;',
      '\tfor(row = 0; row < rows; ++row)',
      '\t{',
      `\t\tu16 d = ${name}_Offset(x, y + row);`,
      '\t\tfor(col = 0; col < stride; ++col)',
      '\t\t{',
      '\t\t\tu8 v = *src++;',
      '\t\t\tu8* p = buf + d + ((u16)col << 3);',
      `\t\t\tif(v == ${prefix}_TRANSPARENT_PAIR)`,
      '\t\t\t\tcontinue;',
      `\t\t\tif((v >> 4) == ${prefix}_TRANSPARENT)`,
      '\t\t\t\t*p = (*p & 0xF0) | (v & 0x0F);',
      `\t\t\telse if((v & 0x0F) == ${prefix}_TRANSPARENT)`,
      '\t\t\t\t*p = (*p & 0x0F) | (v & 0xF0);',
      '\t\t\telse',
      '\t\t\t\t*p = v;',
      '\t\t}',
      '\t}',
      '}',
      '',
      `void ${name}_Save(const u8* buf, u8* save, u8 sprite, u8 x, u8 y)`,
      '{',
      `\tconst u8* info = ${name}_Info + ((u16)sprite * 5);`,
      '\tu8 stride = (info[2] + 1) >> 1;',
      '\tu8 rows = info[3];',
      '\tu8 row, col;',
      '\tfor(row = 0; row < rows; ++row)',
      '\t{',
      `\t\tu16 d = ${name}_Offset(x, y + row);`,
      '\t\tfor(col = 0; col < stride; ++col)',
      '\t\t\t*save++ = buf[d + ((u16)col << 3)];',
      '\t}',
      '}',
      '',
      `void ${name}_Restore(u8* buf, const u8* save, u8 sprite, u8 x, u8 y)`,
      '{',
      `\tconst u8* info = ${name}_Info + ((u16)sprite * 5);`,
      '\tu8 stride = (info[2] + 1) >> 1;',
      '\tu8 rows = info[3];',
      '\tu8 row, col;',
      '\tfor(row = 0; row < rows; ++row)',
      '\t{',
      `\t\tu16 d = ${name}_Offset(x, y + row);`,
      '\t\tfor(col = 0; col < stride; ++col)',
      '\t\t\tbuf[d + ((u16)col << 3)] = *save++;',
      '\t}',
      '}'
    ]
  }
}

function bitmapSwHelperC(doc: SwSpritesDoc, name: string): HelperC {
  const prefix = defineName(name)
  return {
    header: [
      '',
      `// ── ${name}: bitmap-mode software sprites ─────────────────────────────`,
      '//',
      `// Every frame lives in one ${prefix}_SHEET_W×${prefix}_SHEET_H strip. Upload it once into`,
      '// VRAM the display never shows, then each draw is one LMMM out of it — the',
      '// CPU writes coordinates, not pixels.',
      '//',
      `// Transparency is the VDP's: VDP_OP_TIMP skips colour ${doc.transparent}, so this needs`,
      `// that index to be the one your art leaves empty.`,
      '//',
      '// Needs MSXgl\'s VDP command engine: MSX2 or later with VDP_USE_COMMAND.',
      '//',
      '// Give every object its own backup slot — two sharing one would eat each',
      "// other's background — and when they overlap, Restore them all in reverse",
      '// draw order before drawing any.',
      '//',
      '// Example:',
      `//   ${name}_Upload(212);`,
      `//   ${name}_Draw(&hero, ${prefix}_PLAYER, frame, x, y, 212);`,
      'typedef struct',
      '{',
      '\tu8 slot;',
      '\tUX bx;',
      '\tUY by;',
      '\tu8 bw, bh;',
      `} ${name}_SwSprite;`,
      '',
      `void ${name}_Upload(UY sheetY);`,
      `void ${name}_Restore(${name}_SwSprite* s, UY sheetY);`,
      `void ${name}_Draw(${name}_SwSprite* s, u8 sprite, u8 frame, UX x, UY y, UY sheetY);`
    ],
    source: [
      '',
      `void ${name}_Upload(UY sheetY)`,
      '{',
      `\tVDP_CommandHMMC(${name}_Data, 0, sheetY, ${prefix}_SHEET_W, ${prefix}_SHEET_H);`,
      '}',
      '',
      `void ${name}_Restore(${name}_SwSprite* s, UY sheetY)`,
      '{',
      '\tif(s->bw == 0)',
      '\t\treturn;',
      `\tVDP_CommandHMMM(s->slot * ${prefix}_BACKUP_PITCH, sheetY + ${prefix}_SHEET_H, s->bx, s->by, s->bw, s->bh);`,
      '\ts->bw = 0;',
      '}',
      '',
      `void ${name}_Draw(${name}_SwSprite* s, u8 sprite, u8 frame, UX x, UY y, UY sheetY)`,
      '{',
      `\tconst u8* info = ${name}_Info + ((u16)sprite * 5);`,
      '\tUX sx = (info[0] | ((u16)info[1] << 8)) + ((u16)frame * info[2]);',
      '\tu8 w = info[2];',
      '\tu8 h = info[3];',
      '\t// HMMM copies whole bytes, so the backup starts a little early and runs',
      '\t// wider — otherwise the sprite leaves its edges behind.',
      '\ts->bx = (x > 2) ? x - 2 : 0;',
      '\ts->by = y;',
      '\ts->bw = w + 4;',
      '\ts->bh = h;',
      `\tVDP_CommandHMMM(s->bx, y, s->slot * ${prefix}_BACKUP_PITCH, sheetY + ${prefix}_SHEET_H, s->bw, h);`,
      '\tVDP_CommandLMMM(sx, sheetY, x, y, w, h, VDP_OP_TIMP);',
      '}'
    ]
  }
}

function tiledSwHelperC(doc: SwSpritesDoc, name: string): HelperC {
  const prefix = defineName(name)
  return {
    header: [
      '',
      `// ── ${name}: pattern-mode software sprites ────────────────────────────`,
      '//',
      '// There are no pixels to blit in SCREEN 1/2/4, so a software sprite here is',
      '// **borrowed characters**: its cells\' patterns and colours are written into',
      `// a reserved range of the pattern table starting at ${prefix}_FIRST_PATTERN, and`,
      '// the name table is pointed at them. That is why sizes are multiples of 8.',
      '//',
      '// Reserve the range in your tileset — tiles from that index up must not be',
      '// used by the map, or the sprite will overwrite them wherever they appear.',
      '//',
      `// Costs one VRAM pattern per 8×8 cell of every object on screen at once, so`,
      '// a 16×16 sprite is four. That is the trade against the hardware sprites,',
      '// which cost none but run out at four per line.',
      '//',
      '// _Restore puts the map\'s own cells back, so keep a copy of what was there:',
      '// the layer the map exported is exactly that.',
      '//',
      '// Needs VDP_USE_MODE_G2 (or _G3) and "msxgl.h" before this header.',
      '',
      `u8   ${name}_Width(u8 sprite);`,
      `u8   ${name}_Height(u8 sprite);`,
      `void ${name}_Load(u8 sprite, u8 frame, u8 slot);`,
      `void ${name}_Place(u8 sprite, u8 slot, u8 x, u8 y);`,
      `void ${name}_Restore(const u8* layer, u8 mapWidth, u8 sprite, u8 x, u8 y);`
    ],
    source: [
      '',
      `u8 ${name}_Width(u8 sprite) { return ${name}_Info[(u16)sprite * 5 + 2]; }`,
      `u8 ${name}_Height(u8 sprite) { return ${name}_Info[(u16)sprite * 5 + 3]; }`,
      '',
      '// Copies one frame into the reserved patterns. `slot` is which object this',
      '// is, so two of the same sprite can show different frames at once.',
      `void ${name}_Load(u8 sprite, u8 frame, u8 slot)`,
      '{',
      `\tconst u8* info = ${name}_Info + ((u16)sprite * 5);`,
      '\tu8 cols = info[2] >> 3;',
      '\tu8 rows = info[3] >> 3;',
      '\tu8 cells = cols * rows;',
      `\tconst u8* src = ${name}_Data + (info[0] | ((u16)info[1] << 8)) + ((u16)frame * cells * 16);`,
      `\tu8 first = ${prefix}_FIRST_PATTERN + (slot * ${prefix}_SLOT_CELLS);`,
      '\tu8 cell;',
      '\tfor(cell = 0; cell < cells; ++cell)',
      '\t{',
      '\t\t// Eight pattern bytes then eight colour bytes, per cell.',
      '\t\tVDP_LoadPattern_GM2(src, 1, first + cell);',
      '\t\tVDP_LoadColor_GM2(src + 8, 1, first + cell);',
      '\t\tsrc += 16;',
      '\t}',
      '}',
      '',
      '// Points the name table at the loaded patterns. (x, y) are character cells.',
      `void ${name}_Place(u8 sprite, u8 slot, u8 x, u8 y)`,
      '{',
      `\tconst u8* info = ${name}_Info + ((u16)sprite * 5);`,
      '\tu8 cols = info[2] >> 3;',
      '\tu8 rows = info[3] >> 3;',
      `\tu8 first = ${prefix}_FIRST_PATTERN + (slot * ${prefix}_SLOT_CELLS);`,
      '\tu8 names[16];',
      '\tu8 row, col;',
      '\tfor(row = 0; row < rows; ++row)',
      '\t{',
      '\t\tfor(col = 0; col < cols; ++col)',
      '\t\t\tnames[col] = first + (row * cols) + col;',
      '\t\tVDP_WriteLayout_GM2(names, x, y + row, cols, 1);',
      '\t}',
      '}',
      '',
      '// Writes the map\'s own cells back over where the sprite was.',
      `void ${name}_Restore(const u8* layer, u8 mapWidth, u8 sprite, u8 x, u8 y)`,
      '{',
      `\tconst u8* info = ${name}_Info + ((u16)sprite * 5);`,
      '\tu8 cols = info[2] >> 3;',
      '\tu8 rows = info[3] >> 3;',
      '\tu8 row;',
      '\tfor(row = 0; row < rows; ++row)',
      '\t\tVDP_WriteLayout_GM2(layer + ((u16)(y + row) * mapWidth) + x, x, y + row, cols, 1);',
      '}'
    ]
  }
}
