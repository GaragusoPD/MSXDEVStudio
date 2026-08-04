/**
 * `*.screen.json` (Spec 10 B): a bitmap-mode screen. The source of truth is
 * the original image plus conversion settings, not hand-painted pixels — but
 * the file also caches the converted result (`converted`), because the
 * conversion runs in the renderer (browser image decoding) while the export
 * runs in main. Re-running the conversion refreshes the cache and the
 * `retouch` pixels are re-applied on top.
 */

import { packRlep } from './compress'
import { isBitmapMode, MODES, type BitmapMode } from './modes'
import type { ExportBlock } from './resource'
import type { DitherMode } from './quantize'

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

export function normalizeScreen(raw: unknown): ScreenDoc {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<ScreenDoc>
  const mode: BitmapMode = isBitmapMode(String(input.mode)) ? (input.mode as BitmapMode) : 'sc5'
  const convert = (input.convert ?? {}) as Partial<ScreenConvert>
  const palette = Array.isArray(convert.palette)
    ? convert.palette.map(Number)
    : convert.palette === 'msx1'
      ? 'msx1'
      : 'optimized'
  return {
    version: 1,
    mode,
    source: String(input.source ?? ''),
    convert: {
      dither: convert.dither === 'floyd' || convert.dither === 'bayer4' ? convert.dither : 'none',
      palette
    },
    retouch: Array.isArray(input.retouch) ? input.retouch.map((value) => Number(value) || 0) : [],
    fragments: normalizeFragments(input.fragments),
    converted: input.converted ?? null,
    export: input.export ?? null
  }
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
 */
export function packBitmap(indices: Uint8Array, width: number, height: number, mode: BitmapMode): Uint8Array {
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
  const raw = packBitmap(pixels.indices, pixels.width, pixels.height, doc.mode)
  if (compress !== 'rlep') return { bytes: raw }

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
  const strip = fragmentStrip(doc)
  return packBitmap(fragmentStripPixels(doc), strip.width, strip.height, doc.mode)
}

/** Per fragment: `xLo, xHi, width, height` — the rectangle inside the strip, for the runtime's frame table. */
export function fragmentRectBytes(doc: ScreenDoc): Uint8Array {
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
export function screenHelperC(doc: ScreenDoc, name: string): string[] {
  const prefix = name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()
  const first = doc.fragments[0]?.name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase() ?? 'FRAGMENT'
  return [
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
    '\tu16 bx;   // the saved background rectangle; bw = 0 means nothing is on screen',
    '\tu8  by, bw, bh;',
    `} ${name}_SwSprite;`,
    '',
    '// Copies every frame into the off-screen strip at VRAM row `stripY`.',
    `static void ${name}_Upload(u8 stripY)`,
    '{',
    `\tVDP_CommandHMMC(${name}_Strip, 0, stripY, ${prefix}_STRIP_W, ${prefix}_STRIP_H);`,
    '}',
    '',
    '// Puts back what the object was covering. Safe before the first draw.',
    `static void ${name}_Restore(${name}_SwSprite* s, u8 stripY)`,
    '{',
    '\tif(s->bw == 0)',
    '\t\treturn;',
    `\tVDP_CommandHMMM(s->slot * ${prefix}_BACKUP_PITCH, stripY + ${prefix}_STRIP_H, s->bx, s->by, s->bw, s->bh);`,
    '\ts->bw = 0;',
    '}',
    '',
    '// Saves the background at the new position, then blits `frame` over it.',
    `static void ${name}_Draw(${name}_SwSprite* s, u8 frame, u16 x, u8 y, u8 stripY)`,
    '{',
    `\tconst u8* rect = ${name}_Rects + ((u16)frame * 4);`,
    '\tu16 sx = rect[0] + ((u16)rect[1] << 8);',
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

/**
 * Draws an RLEp-compressed picture. It arrives as bands (see
 * `screenDataExport`) precisely so this can exist on a 32K-ROM machine: one
 * band is unpacked into a small RAM buffer and blitted before the next is
 * touched, so the whole 27 KB picture never has to be anywhere but VRAM.
 */
export function screenUnpackC(name: string): string[] {
  const prefix = name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()
  return [
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
    `static void ${name}_Unpack(u8* buffer, u8 y)`,
    '{',
    '\tu8 band;',
    `\tfor(band = 0; band < ${prefix}_BANDS; ++band)`,
    '\t{',
    `\t\tconst u8* src = ${name}_Data + (${name}_Bands[band * 2] + ((u16)${name}_Bands[band * 2 + 1] << 8));`,
    '\t\tu16 size = RLEp_UnpackToRAM(src, buffer);',
    // The last band is short, so its height comes from what it unpacked to.
    `\t\tVDP_CommandHMMC(buffer, 0, y + (band * ${prefix}_BAND_ROWS), ${prefix}_W, size / ${prefix}_STRIDE);`,
    '\t}',
    '}'
  ]
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
  if (!doc.source) problems.push('No source image')
  const info = MODES[doc.mode]
  if (doc.converted) {
    if (doc.converted.width > info.width || doc.converted.height > info.height) {
      problems.push(`Converted image ${doc.converted.width}×${doc.converted.height} exceeds ${doc.mode}`)
    }
    const palette = doc.converted.palette
    if (palette) {
      if (palette.length > info.colors) problems.push(`${palette.length} palette entries, ${doc.mode} allows ${info.colors}`)
      if (palette.some((value) => (value & ~0x0777) !== 0)) problems.push('Palette entry outside the GRB333 space')
    }
  }
  return problems
}
