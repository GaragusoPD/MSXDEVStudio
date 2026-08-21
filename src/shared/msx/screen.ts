/**
 * `*.screen.json` (Spec 10 B): a bitmap-mode screen. The source of truth is
 * the original image plus conversion settings, not hand-painted pixels — but
 * the file also caches the converted result (`converted`), because the
 * conversion runs in the renderer (browser image decoding) while the export
 * runs in main. Re-running the conversion refreshes the cache and the
 * `retouch` pixels are re-applied on top.
 */

import { packRlep } from './compress'
import type { HelperC } from './emitC'
import { isBitmapMode, MODES, type BitmapMode } from './modes'
import { MSX1_PALETTE_GRB, paletteToRgb, type Rgb } from './palette'
import type { ExportBlock } from './resource'
import { rgb332Palette, type DitherMode } from './quantize'
import { sc3LinearBytes, sc3LinearPack, sc3Pack, sc3ScreenHelperC } from './sc3'

export interface ScreenConvert {
  dither: DitherMode
  /** 'msx1' = the fixed palette; 'optimized' = median-cut from the image; an array locks specific GRB333 entries. */
  palette: 'msx1' | 'optimized' | number[]
}

export interface ConvertedScreen {
  width: number
  height: number
  /** 16 packed GRB333 entries for sc5/6/7; null for sc8 (fixed RGB332) and YJK modes. */
  palette: number[] | null
  /** Base64 of one index per pixel, row-major (not yet packed into VRAM bytes). */
  indices: string
}

/**
 * A named rectangle of the converted image — the bitmap-mode counterpart of a
 * tileset's block, and what a software sprite's frames are made of. Bitmap
 * modes have no name table, so a "tile" here is just a patch of pixels
 * stamped into the screen at any size.
 *
 * Like a block, a fragment owns no pixels: it is a window onto the image, so
 * retouching the image updates every fragment over it.
 */
export interface ScreenFragment {
  name: string
  x: number
  y: number
  width: number
  height: number
}

export interface ScreenDoc {
  version: 1
  mode: BitmapMode
  /**
   * The picture's size, in the mode's own unit — 4×4 blocks in SCREEN 3, dots
   * elsewhere. Defaults to one screenful and may be **larger**.
   *
   * That is the whole of what separates a screen from a map: a map is W×H
   * continuous data you scroll a window over, and so is this once the size is
   * free. A picture bigger than the display exports as a *world* — packed
   * linearly rather than in the VDP's own byte order — and its helpers window
   * into it instead of uploading it whole.
   */
  width: number
  height: number
  /** Project-relative path of the original artwork. */
  source: string
  convert: ScreenConvert
  /**
   * Retouch pixels applied after conversion, flattened `x, y, color` triples.
   * ponytail: a flat pixel list, not vector strokes — a full-screen fill costs
   * ~160 KB of JSON. Switch to run-length or per-tool records if that bites.
   */
  retouch: number[]
  /** Named cut-outs: bitmap blocks, and the frames of software sprites. */
  fragments: ScreenFragment[]
  converted: ConvertedScreen | null
  export: ExportBlock | null
}

export function createScreenDoc(mode: BitmapMode = 'sc5', source = ''): ScreenDoc {
  return normalizeScreen({ mode, source })
}

/**
 * A converted image with nothing in it, so a screen can be drawn from scratch
 * instead of converted from a PNG. Everything downstream — retouch, fragments,
 * the export — reads `converted` and does not care where it came from; only
 * re-running the conversion would replace this, and there is no source to
 * re-run it from.
 *
 * The palette is the one the machine boots with, so what the editor shows and
 * what an un-`VDP_SetPalette`d game shows are the same sixteen colors.
 */
export function blankConverted(mode: BitmapMode, width?: number, height?: number): ConvertedScreen {
  const info = MODES[mode]
  const size = snapScreenSize(mode, width ?? info.width, height ?? info.height)
  return {
    width: size.width,
    height: size.height,
    palette: info.palette === 'grb333' ? [...MSX1_PALETTE_GRB] : null,
    indices: encodeIndices(new Uint8Array(size.width * size.height))
  }
}

export function normalizeScreen(raw: unknown): ScreenDoc {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<ScreenDoc>
  const mode: BitmapMode = isBitmapMode(String(input.mode)) ? (input.mode as BitmapMode) : 'sc5'
  const convert = (input.convert ?? {}) as Partial<ScreenConvert>
  // sc3 has the TMS9918A's sixteen and no way to change them, so median-cutting
  // an optimised palette out of the image would only mislead the preview.
  const palette: ScreenConvert['palette'] =
    mode === 'sc3'
      ? 'msx1'
      : Array.isArray(convert.palette)
        ? convert.palette.map(Number)
        : convert.palette === 'msx1'
          ? 'msx1'
          : 'optimized'
  const info = MODES[mode]
  // Every file written before the size existed states it only through the
  // conversion it cached, so that is where the default comes from — taking the
  // mode's screen size instead would crop or pad art that was already right.
  const cached = input.converted
  const size = snapScreenSize(
    mode,
    size1(input.width, cached ? size1(cached.width, info.width) : info.width),
    size1(input.height, cached ? size1(cached.height, info.height) : info.height)
  )
  return {
    version: 1,
    mode,
    width: size.width,
    height: size.height,
    source: String(input.source ?? ''),
    convert: {
      dither: convert.dither === 'floyd' || convert.dither === 'bayer4' ? convert.dither : 'none',
      palette
    },
    retouch: Array.isArray(input.retouch) ? input.retouch.map((value) => Number(value) || 0) : [],
    fragments: normalizeFragments(input.fragments),
    // The cache has to agree with the size, or every consumer downstream reads a
    // different picture from the one the document claims to be.
    converted: input.converted ? fitConverted(input.converted, size.width, size.height) : null,
    export: input.export ?? null
  }
}

/** Past this a "screen" is a memory problem, not a picture. Dimensions only; `validateScreen` reports the bytes. */
export const MAX_SCREEN_SIZE = 1024

function size1(value: unknown, fallback: number): number {
  const n = Math.round(Number(value))
  return Number.isFinite(n) && n >= 1 ? Math.min(MAX_SCREEN_SIZE, n) : fallback
}

/**
 * Rounds the width up to what the mode can address.
 *
 * Every one of these is a byte boundary the exporter and the blitters cannot see
 * past: two SCREEN 3 blocks share a byte, four SCREEN 6 dots do, and a picture
 * whose row ends mid-byte cannot be windowed at all.
 */
export function snapScreenSize(mode: BitmapMode, width: number, height: number): { width: number; height: number } {
  const step = MODES[mode].pixelsPerByte
  return { width: Math.max(step, Math.ceil(width / step) * step), height: Math.max(1, height) }
}

/** Crops or zero-pads a cached conversion to the document's size. */
function fitConverted(converted: ConvertedScreen, width: number, height: number): ConvertedScreen {
  if (converted.width === width && converted.height === height) return converted
  const from = decodeIndices(converted.indices)
  const out = new Uint8Array(width * height)
  for (let y = 0; y < Math.min(height, converted.height); y++) {
    for (let x = 0; x < Math.min(width, converted.width); x++) {
      out[y * width + x] = from[y * converted.width + x] ?? 0
    }
  }
  return { ...converted, width, height, indices: encodeIndices(out) }
}

/**
 * True when the picture is bigger than the display — the case that makes it a
 * world rather than a screen, and the one thing the export forks on.
 */
export function isScreenWorld(doc: ScreenDoc): boolean {
  const info = MODES[doc.mode]
  return doc.width > info.width || doc.height > info.height
}

/** Resizes the picture, cropping rather than scaling — the same rule tilesets follow. */
export function resizeScreen(doc: ScreenDoc, width: number, height: number): ScreenDoc {
  const size = snapScreenSize(doc.mode, width, height)
  if (size.width === doc.width && size.height === doc.height) return doc
  return normalizeScreen({ ...doc, ...size })
}

/** Absent in files written before fragments existed, so default to none. */
function normalizeFragments(raw: unknown): ScreenFragment[] {
  if (!Array.isArray(raw)) return []
  const at = (value: unknown, min = 0): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(min, value | 0) : min
  return raw.map((entry, index) => {
    const fragment = (typeof entry === 'object' && entry !== null ? entry : {}) as Partial<ScreenFragment>
    return {
      name: String(fragment.name ?? `fragment_${index}`),
      x: at(fragment.x),
      y: at(fragment.y),
      width: at(fragment.width, 1),
      height: at(fragment.height, 1)
    }
  })
}

// ── base64 for the cached index buffer ──────────────────────────────────────

export function encodeIndices(indices: Uint8Array): string {
  let binary = ''
  // Chunked: String.fromCharCode(...54272 args) overflows the call stack.
  for (let i = 0; i < indices.length; i += 0x8000) {
    binary += String.fromCharCode(...indices.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

export function decodeIndices(base64: string): Uint8Array {
  const binary = atob(base64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** The converted image with `retouch` applied — what the editor shows and what gets exported. */
export function screenPixels(doc: ScreenDoc): { width: number; height: number; indices: Uint8Array } | null {
  if (!doc.converted) return null
  const { width, height } = doc.converted
  const indices = decodeIndices(doc.converted.indices)
  for (let i = 0; i + 2 < doc.retouch.length; i += 3) {
    const x = doc.retouch[i]
    const y = doc.retouch[i + 1]
    if (x >= 0 && y >= 0 && x < width && y < height) indices[y * width + x] = doc.retouch[i + 2] & 0xff
  }
  return { width, height, indices }
}

/**
 * Packs indexed pixels into VRAM bytes for `mode`: 2 pixels/byte (sc5, sc7),
 * 4 pixels/byte (sc6), 1 byte/pixel (sc8 — the index *is* the RGB332 value).
 * YJK modes (sc10/12) are import-only and pass through unpacked.
 *
 * sc3 is the one mode where the byte *order* differs too, not just the packing:
 * its framebuffer is the pattern table read through the name table, so a row is
 * not contiguous. `sc3.ts` owns that address, and the result is always the full
 * 1536 bytes regardless of the source size.
 */
export function packBitmap(indices: Uint8Array, width: number, height: number, mode: BitmapMode): Uint8Array {
  if (mode === 'sc3') return sc3Pack(indices, width, height)
  const perByte = MODES[mode].pixelsPerByte
  if (perByte === 1) return Uint8Array.from(indices)
  const bits = 8 / perByte
  const mask = (1 << bits) - 1
  const stride = Math.ceil(width / perByte)
  const out = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const shift = 8 - bits * ((x % perByte) + 1)
      out[y * stride + Math.floor(x / perByte)] |= (indices[y * width + x] & mask) << shift
    }
  }
  return out
}

// ── compression: the picture, in bands ──────────────────────────────────────

/**
 * How much RAM the unpack buffer may take on the MSX side. A whole SCREEN 5
 * picture is 27 KB, which no 32K-ROM program can hold in RAM, so a compressed
 * picture is packed as a **strip of bands** — each one unpacked into a buffer
 * this size and blitted with `HMMC` before the next one is touched. 2 KB is one
 * band of 16 lines in SCREEN 5, and leaves the 16 KB RAM page room to live in.
 */
export const BAND_BUDGET = 2048

/**
 * The symbol the picture table is exported under.
 *
 * `resourceTables` gives it `_Data` only when something else is already in the
 * file — a palette, or the band offsets a compressed picture needs beside it —
 * and the bare base name otherwise. The helpers have to name the same symbol,
 * and guessing either way produces a header that references one that does not
 * exist. So it is computed once, here, and both sides ask.
 */
export function screenTableSuffix(doc: ScreenDoc, compress: ExportBlock['compress']): string {
  const geometry = screenDataExport(doc, compress).geometry
  return doc.converted?.palette || geometry ? '_Data' : ''
}

export interface ScreenDataExport {
  /** The packed bands back to back, or the raw bitmap when compression wasn't taken. */
  bytes: Uint8Array
  /** Total unpacked size — set only when `bytes` is compressed. */
  unpacked?: number
  /** Where each band starts in `bytes`, as u16 little-endian pairs. */
  offsets?: Uint8Array
  /** Rows per band, bands, buffer size, and the row stride the helper divides by. */
  geometry?: { rows: number; count: number; bufferBytes: number; stride: number; width: number; height: number }
}

/**
 * The picture as it goes into the header. Compression is all-or-nothing, like
 * a map's layers: the offsets table has to be paid for, and a dithered photo
 * packs no smaller than it started, so the raw bitmap ships instead.
 */
export function screenDataExport(doc: ScreenDoc, compress: ExportBlock['compress']): ScreenDataExport {
  const pixels = screenPixels(doc)
  if (!pixels) throw new Error('no converted image')
  // SCREEN 3's VRAM byte order exists because the VDP reads it that way, which
  // is only useful for a picture that gets uploaded whole. A world is read by
  // the CPU a window at a time, so it is packed for that reader instead — rows
  // in order, `ceil(w / 2)` bytes each.
  const world = isScreenWorld(doc)
  const raw =
    doc.mode === 'sc3' && world
      ? sc3LinearPack(pixels.indices, 0, 0, pixels.width, pixels.height, pixels.width)
      : packBitmap(pixels.indices, pixels.width, pixels.height, doc.mode)
  // A world is read a row at a time by `_DrawWindow`; RLEp bands are not rows.
  // Unpacking one would also want a buffer the size of the whole world, which is
  // the thing a world is too big for. Declined rather than half-supported, and
  // `validateScreen` says why so the checkbox is not a mystery.
  if (compress !== 'rlep' || world) return { bytes: raw }

  const stride = Math.ceil(pixels.width / MODES[doc.mode].pixelsPerByte)
  const rows = Math.max(1, Math.floor(BAND_BUDGET / Math.max(1, stride)))
  const count = Math.ceil(pixels.height / rows)
  const packed: Uint8Array[] = []
  const offsets = new Uint8Array(count * 2)
  let at = 0
  for (let band = 0; band < count; band++) {
    const start = band * rows * stride
    const bytes = packRlep(raw.subarray(start, Math.min(raw.length, start + rows * stride)))
    offsets[band * 2] = at & 0xff
    offsets[band * 2 + 1] = (at >> 8) & 0xff
    at += bytes.length
    packed.push(bytes)
  }
  if (at + offsets.length >= raw.length) return { bytes: raw }

  const bytes = new Uint8Array(at)
  let offset = 0
  for (const band of packed) {
    bytes.set(band, offset)
    offset += band.length
  }
  return {
    bytes,
    unpacked: raw.length,
    offsets,
    geometry: { rows, count, bufferBytes: rows * stride, stride, width: pixels.width, height: pixels.height }
  }
}

// ── fragments: the strip, and the code that draws it ────────────────────────

/**
 * Fragments are exported as **one image**, laid side by side left to right —
 * the layout MSXgl's own software-sprite sample uses, because a single
 * `HMMC` then uploads them all into one off-screen VRAM strip and each frame
 * is a plain `(x, 0, w, h)` rectangle inside it.
 */
export interface FragmentStrip {
  width: number
  height: number
  /** Per fragment, in document order: its x offset inside the strip. */
  offsets: number[]
}

export function fragmentStrip(doc: ScreenDoc): FragmentStrip {
  let width = 0
  const offsets = doc.fragments.map((fragment) => {
    const offset = width
    width += fragment.width
    return offset
  })
  return { width, height: Math.max(0, ...doc.fragments.map((fragment) => fragment.height)), offsets }
}

/** The strip's pixels, cut out of the converted image. Empty when nothing is converted yet. */
export function fragmentStripPixels(doc: ScreenDoc): Uint8Array {
  const strip = fragmentStrip(doc)
  const source = screenPixels(doc)
  const out = new Uint8Array(strip.width * strip.height)
  if (!source || !strip.width) return out
  doc.fragments.forEach((fragment, index) => {
    const offset = strip.offsets[index]
    for (let y = 0; y < fragment.height; y++) {
      const sy = fragment.y + y
      if (sy >= source.height) break
      for (let x = 0; x < fragment.width; x++) {
        const sx = fragment.x + x
        if (sx >= source.width) break
        out[y * strip.width + offset + x] = source.indices[sy * source.width + sx]
      }
    }
  })
  return out
}

export function fragmentStripBytes(doc: ScreenDoc): Uint8Array {
  if (doc.mode === 'sc3') return sc3FragmentBytes(doc)
  const strip = fragmentStrip(doc)
  return packBitmap(fragmentStripPixels(doc), strip.width, strip.height, doc.mode)
}

/**
 * sc3's fragments, each packed on its own rather than side by side.
 *
 * The strip layout exists because one `HMMC` uploads it into VRAM and each frame
 * is then a rectangle inside it. sc3 has no command engine and no off-screen
 * strip to blit from — frames are read straight out of ROM by the CPU — so
 * side-by-side buys nothing and costs correctness: two blocks share a byte, so a
 * frame at an odd column would start mid-byte and could not be blitted at all.
 */
function sc3FragmentBytes(doc: ScreenDoc): Uint8Array {
  const source = screenPixels(doc)
  const parts = doc.fragments.map((fragment) =>
    source
      ? sc3LinearPack(source.indices, fragment.x, fragment.y, fragment.width, fragment.height, source.width)
      : new Uint8Array(sc3LinearBytes(fragment.width, fragment.height))
  )
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/**
 * Per fragment: `offsetLo, offsetHi, width, height` — where that frame sits in
 * `_Strip` and how big it is, for the runtime's frame table.
 *
 * In the bitmap modes the offset is a dot column inside one wide image; in sc3
 * it is a byte offset, because the frames are packed one after another. Both are
 * "where this frame starts", which is all the helpers ask of it.
 */
export function fragmentRectBytes(doc: ScreenDoc): Uint8Array {
  if (doc.mode === 'sc3') {
    let at = 0
    return Uint8Array.from(
      doc.fragments.flatMap((fragment) => {
        const offset = at
        at += sc3LinearBytes(fragment.width, fragment.height)
        return [offset & 0xff, (offset >> 8) & 0xff, fragment.width & 0xff, fragment.height & 0xff]
      })
    )
  }
  const strip = fragmentStrip(doc)
  return Uint8Array.from(
    doc.fragments.flatMap((fragment, index) => [
      strip.offsets[index] & 0xff,
      (strip.offsets[index] >> 8) & 0xff,
      fragment.width & 0xff,
      fragment.height & 0xff
    ])
  )
}

/**
 * The ready-made software-sprite runtime. MSXgl has no software-sprite module
 * — only the `s_swsprt` sample — so this is that sample's cycle, generalised:
 * upload the frames to an off-screen VRAM strip once, then per object
 * restore the old background, save the new one, and blit the frame over it.
 *
 * Opt-in (`ExportBlock.helpers`); needs MSXgl's VDP command engine, so MSX2+
 * with `VDP_USE_COMMAND`.
 */
export function screenHelperC(doc: ScreenDoc, name: string, doubleBuffer = false, table = name): HelperC {
  // sc3 shares none of this: no command engine, so no HMMC upload and no LMMM
  // blit, and the whole picture lives in a RAM shadow that is flushed by the
  // strip. `sc3.ts` emits that runtime, software sprites included.
  if (doc.mode === 'sc3') {
    const world = isScreenWorld(doc) ? { width: doc.width, height: doc.height } : null
    return sc3ScreenHelperC(name, table, doubleBuffer, doc.fragments.length > 0, world)
  }
  const prefix = name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()
  const first = doc.fragments[0]?.name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase() ?? 'FRAGMENT'
  return {
    header: [
    '',
    `// ── ${name}: software sprites ─────────────────────────────────────────`,
    '//',
    '// Software sprites are drawn *into* the screen, so they escape the VDP\'s',
    '// 4/8-sprites-per-line limit — at the price of putting back what they',
    `// covered. The frames live side by side in ${name}_Strip; upload it once`,
    '// into VRAM the screen never shows (below the visible lines is the usual',
    '// spot), then move each object with Restore/Draw.',
    '//',
    '// Needs MSXgl\'s VDP command engine: MSX2 or later with VDP_USE_COMMAND,',
    '// and "msxgl.h" included before this header.',
    '//',
    '// Two rules:',
    '//  - Give every object its own slot (0, 1, 2 …). Backgrounds are saved',
    `//    side by side in the row under the strip, ${prefix}_BACKUP_PITCH dots apart,`,
    '//    and two objects sharing a slot would eat each other\'s background.',
    '//  - When objects can overlap, Restore them all in *reverse* draw order',
    '//    first, then Draw them all in order. Restoring one at a time rubs out',
    '//    whatever was drawn on top of it.',
    '//',
    '// Example:',
    `//   ${name}_Upload(212);                  // strip parked at VRAM row 212`,
    `//   ${name}_SwSprite hero = { 0 };        // slot 0`,
    '//   // every frame:',
    `//   ${name}_Restore(&hero, 212);`,
    `//   ${name}_Draw(&hero, ${prefix}_${first}, x, y, 212);`,
    'typedef struct',
    '{',
    '\tu8  slot; // which backup column this object owns',
    '\tUX  bx;   // the saved background rectangle; bw = 0 means nothing is on screen',
    '\tUY  by;',
    '\tu8  bw, bh;',
    `} ${name}_SwSprite;`,
    '',
    `void ${name}_Upload(UY stripY);`,
    `void ${name}_Restore(${name}_SwSprite* s, UY stripY);`,
    `void ${name}_Draw(${name}_SwSprite* s, u8 frame, UX x, UY y, UY stripY);`
    ],
    source: [
    '',
    '// Copies every frame into the off-screen strip at VRAM row `stripY`.',
    `void ${name}_Upload(UY stripY)`,
    '{',
    `\tVDP_CommandHMMC(${name}_Strip, 0, stripY, ${prefix}_STRIP_W, ${prefix}_STRIP_H);`,
    '}',
    '',
    '// Puts back what the object was covering. Safe before the first draw.',
    `void ${name}_Restore(${name}_SwSprite* s, UY stripY)`,
    '{',
    '\tif(s->bw == 0)',
    '\t\treturn;',
    `\tVDP_CommandHMMM(s->slot * ${prefix}_BACKUP_PITCH, stripY + ${prefix}_STRIP_H, s->bx, s->by, s->bw, s->bh);`,
    '\ts->bw = 0;',
    '}',
    '',
    '// Saves the background at the new position, then blits `frame` over it.',
    `void ${name}_Draw(${name}_SwSprite* s, u8 frame, UX x, UY y, UY stripY)`,
    '{',
    `\tconst u8* rect = ${name}_Rects + ((u16)frame * 4);`,
    '\tUX sx = rect[0] + ((u16)rect[1] << 8);',
    '\tu8  w  = rect[2];',
    '\tu8  h  = rect[3];',
    '\t// HMMM copies whole bytes, so the backup starts a couple of dots early',
    '\t// and runs wider — otherwise the sprite leaves its edges behind.',
    '\ts->bx = (x > 2) ? x - 2 : 0;',
    '\ts->by = y;',
    '\ts->bw = w + 4;',
    '\ts->bh = h;',
    `\tVDP_CommandHMMM(s->bx, y, s->slot * ${prefix}_BACKUP_PITCH, stripY + ${prefix}_STRIP_H, s->bw, h);`,
    '\tVDP_CommandLMMM(sx, stripY, x, y, w, h, VDP_OP_TIMP);',
    '}'
    ]
  }
}

/**
 * Windowing a bitmap-mode **world** — a picture bigger than the display.
 *
 * The world stays in ROM: one that fits VRAM would not need windowing, and one
 * that does not could not be parked there anyway. So a row of the view is one
 * `HMMC` out of ROM, because a row of the *world* is contiguous while a row of
 * the *window* is not — there is no rectangle copy that can stride a source.
 *
 * That makes a full redraw one command per line, which is a screen transition's
 * price, not a frame's. A scroller calls `_DrawRow` for the line coming into
 * view and leaves the rest alone, which is the whole point of the shape.
 */
export function screenWorldHelperC(doc: ScreenDoc, name: string, table = `${name}_Data`): HelperC {
  const prefix = name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()
  const info = MODES[doc.mode]
  const rowSignature = `void ${name}_DrawRow(UX camX, UY camY, u8 row, UY destY)`
  const windowSignature = `void ${name}_DrawWindow(UX camX, UY camY, UY destY)`
  return {
    header: [
      '',
      `// ── ${name}: a ${doc.width}×${doc.height} world, windowed ${'─'.repeat(20)}`,
      '//',
      `// Bigger than the ${info.width}×${info.height} on screen, so this is scrolled rather than`,
      '// shown: the picture stays in ROM and the visible rectangle is copied out of',
      '// it a line at a time.',
      '//',
      `// \`camX\` must be a multiple of ${info.pixelsPerByte} — that is how many dots share a byte in`,
      `// ${doc.mode}, and the copy cannot start inside one.`,
      '//',
      '// `destY` is the VRAM row the view starts at, so the same call serves a page',
      '// the display is not showing.',
      '//',
      '// Needs MSXgl\'s VDP command engine: MSX2 or later with VDP_USE_COMMAND.',
      '//',
      '// Example — redraw once, then one row per scroll step:',
      `//   ${name}_DrawWindow(camX, camY, 0);`,
      `//   ${name}_DrawRow(camX, camY, ${prefix}_VIEW_H - 1, 0);`,
      `${rowSignature};`,
      `${windowSignature};`
    ],
    source: [
      '',
      rowSignature,
      '{',
      `\tVDP_CommandHMMC(${table} + ((u16)(camY + row) * ${prefix}_STRIDE) + (camX / ${prefix}_PPB),`,
      `\t                0, destY + row, ${prefix}_VIEW_W, 1);`,
      '}',
      '',
      windowSignature,
      '{',
      '\tu8 row;',
      `\tfor(row = 0; row < ${prefix}_VIEW_H; ++row)`,
      `\t\t${name}_DrawRow(camX, camY, row, destY);`,
      '}'
    ]
  }
}

/**
 * Draws an RLEp-compressed picture. It arrives as bands (see
 * `screenDataExport`) precisely so this can exist on a 32K-ROM machine: one
 * band is unpacked into a small RAM buffer and blitted before the next is
 * touched, so the whole 27 KB picture never has to be anywhere but VRAM.
 */
export function screenUnpackC(name: string, mode: BitmapMode = 'sc5', table = `${name}_Data`): HelperC {
  const prefix = name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()
  if (mode === 'sc3') {
    // 1536 bytes is under one band's budget, so there is only ever one — and no
    // command engine to blit it with, so it goes straight to the page.
    const signature = `void ${name}_Unpack(u8* buffer)`
    return {
      header: [
        '',
        `// ── ${name}: the picture, RLEp-packed ─────────────────────────────────`,
        '//',
        `// Unpacks into \`buffer\` (${prefix}_SIZE bytes — the same shadow buffer the`,
        '// drawing helpers use) and writes it to the visible page.',
        '//',
        '// Needs MSXgl\'s "compress" library module, with COMPRESS_USE_RLEP TRUE and',
        '// COMPRESS_USE_RLEP_DEFAULT TRUE in msxgl_config.h.',
        '//',
        '// Example:',
        `//   u8 g_Screen[${prefix}_SIZE];`,
        `//   ${name}_InitScreen();`,
        `//   ${name}_Unpack(g_Screen);`,
        `${signature};`
      ],
      source: [
        '',
        signature,
        '{',
        `\tRLEp_UnpackToRAM(${table}, buffer);`,
        `\t${name}_FlushAll(buffer);`,
        '}'
      ]
    }
  }
  const signature = `void ${name}_Unpack(u8* buffer, UY y)`
  return {
    header: [
    '',
    `// ── ${name}: the picture, RLEp-packed ─────────────────────────────────`,
    '//',
    `// Unpacks band by band into \`buffer\` (${prefix}_BAND_BYTES bytes — a plain`,
    '// global array is fine) and blits each one to VRAM row `y` onwards.',
    '//',
    '// Needs MSXgl\'s VDP command engine (MSX2+ with VDP_USE_COMMAND) and the',
    '// "compress" library module, with COMPRESS_USE_RLEP TRUE and',
    '// COMPRESS_USE_RLEP_DEFAULT TRUE in msxgl_config.h.',
    '//',
    '// Example:',
    `//   u8 buffer[${prefix}_BAND_BYTES];`,
    `//   ${name}_Unpack(buffer, 0);`,
    `${signature};`
    ],
    source: [
    '',
    signature,
    '{',
    '\tu8 band;',
    `\tfor(band = 0; band < ${prefix}_BANDS; ++band)`,
    '\t{',
    `\t\tconst u8* src = ${table} + (${name}_Bands[band * 2] + ((u16)${name}_Bands[band * 2 + 1] << 8));`,
    '\t\tu16 size = RLEp_UnpackToRAM(src, buffer);',
    // The last band is short, so its height comes from what it unpacked to.
    `\t\tVDP_CommandHMMC(buffer, 0, y + (band * ${prefix}_BAND_ROWS), ${prefix}_W, size / ${prefix}_STRIDE);`,
    '\t}',
    '}'
    ]
  }
}

/**
 * The RGB an editor draws this screen's indices with. sc8/10/12 have no
 * palette of their own — their index *is* the color — so they get the fixed
 * table approximated; sc5/6/7 use whatever the conversion baked.
 */
export function screenRgb(doc: ScreenDoc): Rgb[] {
  const info = MODES[doc.mode]
  if (info.palette === 'rgb332' || info.palette === 'yjk') return rgb332Palette()
  return paletteToRgb(doc.converted?.palette ?? null)
}

/** Palette table bytes in V9938 write order: `[0RRR0BBB, 00000GGG]` per entry. */
export function palettePairBytes(palette: readonly number[]): Uint8Array {
  const out = new Uint8Array(palette.length * 2)
  palette.forEach((value, index) => {
    out[index * 2] = value & 0x77
    out[index * 2 + 1] = (value >> 8) & 0x07
  })
  return out
}

export function validateScreen(doc: ScreenDoc): string[] {
  const problems: string[] = []
  if (doc.version !== 1) problems.push(`Unsupported version ${doc.version}`)
  if (!isBitmapMode(doc.mode)) problems.push(`"${doc.mode}" is not a bitmap mode`)
  // A screen drawn from scratch has no source and never will — `blankConverted`
  // exists for exactly that, and everything downstream reads `converted` without
  // caring where it came from. What is not exportable is a document with
  // *neither*: nothing to convert and nothing converted.
  if (!doc.source && !doc.converted) problems.push('No source image, and nothing drawn yet')
  const info = MODES[doc.mode]
  if (doc.width % info.pixelsPerByte) {
    problems.push(
      `Width ${doc.width} is not a multiple of ${info.pixelsPerByte} — ${doc.mode} packs that many per byte, ` +
        'and a row that ends mid-byte cannot be windowed'
    )
  }
  if (doc.converted) {
    if (doc.converted.width !== doc.width || doc.converted.height !== doc.height) {
      problems.push(
        `Converted image is ${doc.converted.width}×${doc.converted.height} but the screen is ${doc.width}×${doc.height}`
      )
    }
    const palette = doc.converted.palette
    if (palette) {
      if (palette.length > info.colors) problems.push(`${palette.length} palette entries, ${doc.mode} allows ${info.colors}`)
      if (palette.some((value) => (value & ~0x0777) !== 0)) problems.push('Palette entry outside the GRB333 space')
    }
  }
  if (isScreenWorld(doc)) {
    const bytes = Math.ceil(doc.width / info.pixelsPerByte) * doc.height
    // The emitted window helpers index the world with a u16, and a Z80 has 64 KB
    // of address space in total — past this the arithmetic wraps and the export
    // would be quietly wrong rather than obviously too big.
    if (bytes > 0xffff) {
      problems.push(
        `${doc.width}×${doc.height} packs to ${bytes} bytes — past the 65535 a u16 offset can reach. ` +
          'Cut it into several screens, or use a tilemap, which is what repetition is for.'
      )
    }
    if (doc.export?.compress === 'rlep') {
      problems.push(
        'A screen larger than the display cannot be compressed yet — its helpers read raw rows out of the ' +
          'table, and RLEp bands are not rows. Turn compression off, or keep the picture to one screenful.'
      )
    }
  }
  if (doc.mode === 'sc3') {
    // Two blocks share a byte, and the blitter copies bytes. A frame starting or
    // ending mid-byte cannot be drawn without a shift the runtime does not do.
    for (const fragment of doc.fragments) {
      if (fragment.x % 2 || fragment.width % 2) {
        problems.push(
          `Fragment "${fragment.name}" is at x=${fragment.x} and ${fragment.width} wide; ` +
            'SCREEN 3 frames need an even column and an even width (two blocks per byte)'
        )
      }
    }
  }
  return problems
}
