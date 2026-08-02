/**
 * `*.screen.json` (Spec 10 B): a bitmap-mode screen. The source of truth is
 * the original image plus conversion settings, not hand-painted pixels — but
 * the file also caches the converted result (`converted`), because the
 * conversion runs in the renderer (browser image decoding) while the export
 * runs in main. Re-running the conversion refreshes the cache and the
 * `retouch` pixels are re-applied on top.
 */

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
    converted: input.converted ?? null,
    export: input.export ?? null
  }
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
