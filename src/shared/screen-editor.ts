/**
 * Bitmap-screen editor (Spec 10 B) — the editor-side logic that isn't hardware
 * or conversion knowledge: baking a quantize result into the doc's `converted`
 * cache, pencil/fill retouch on top of it, a post-conversion palette touch-up,
 * and undo/redo.
 *
 * Conversion itself (`quantize`) lives in `shared/msx/quantize.ts`; the
 * retouch replay (decoded indices + `retouch` triples) already lives in
 * `screenPixels` (`shared/msx/screen.ts`) — this file only decides what a
 * retouch stroke touches and how it becomes a new `ScreenDoc`. Same
 * relationship `shared/tile-editor.ts` has with `shared/msx/tile.ts`.
 */

import { decodeIndices, encodeIndices, screenPixels, type ConvertedScreen, type ScreenDoc } from './msx/screen'
import type { Point } from './tile-editor'
import type { History } from './history'

export type { Point }

export interface ConversionOutput {
  width: number
  height: number
  indices: Uint8Array
  palette: number[] | null
}

/** Bakes a fresh quantize result into `doc.converted`. `retouch` is untouched — it replays on top via `screenPixels`. */
export function applyConversion(doc: ScreenDoc, result: ConversionOutput): ScreenDoc {
  const converted: ConvertedScreen = {
    width: result.width,
    height: result.height,
    palette: result.palette,
    indices: encodeIndices(result.indices)
  }
  // The picture the conversion produced *is* the document's size now. Keeping
  // the old one would leave `converted` disagreeing with `width`/`height`, which
  // is a validation error and, worse, a silent crop on the next load.
  return { ...doc, width: result.width, height: result.height, converted }
}

/** sc5/6/7's editable palette: touches up one converted-image entry directly, no requantize. No-op on a fixed palette. */
export function setPaletteEntry(doc: ScreenDoc, index: number, grb: number): ScreenDoc {
  if (!doc.converted?.palette || index < 0 || index >= doc.converted.palette.length) return doc
  const palette = doc.converted.palette.slice()
  palette[index] = grb & 0x0777
  return { ...doc, converted: { ...doc.converted, palette } }
}

// ── retouch ──────────────────────────────────────────────────────────────

/** Sets one retouch pixel, replacing any earlier entry at the same coordinate instead of growing forever. */
export function setRetouchPixel(doc: ScreenDoc, x: number, y: number, color: number): ScreenDoc {
  const retouch = doc.retouch.slice()
  for (let i = 0; i + 2 < retouch.length; i += 3) {
    if (retouch[i] === x && retouch[i + 1] === y) {
      if (retouch[i + 2] === color) return doc
      retouch[i + 2] = color
      return { ...doc, retouch }
    }
  }
  retouch.push(x, y, color)
  return { ...doc, retouch }
}

/** The pencil tool: `points` come from `linePoints` between drag samples so a fast drag leaves no gaps. */
export function paintRetouch(doc: ScreenDoc, points: readonly Point[], color: number): ScreenDoc {
  let out = doc
  for (const p of points) out = setRetouchPixel(out, p.x, p.y, color)
  return out
}

/**
 * Where a stroke goes, which depends on whether this document is a *conversion*
 * or a *drawing*.
 *
 * `retouch` exists so a stroke survives re-running the conversion — it replays
 * on top. A document with no source image has no conversion to re-run and no
 * conversion to survive, so the stroke belongs in the picture itself: a flat
 * `x, y, colour` triple list costs three numbers per pixel and grows forever,
 * which is fine for touching up a photo and wrong for drawing one.
 *
 * The rule is the source, not the mode: a hand-drawn SCREEN 5 screen gets the
 * same treatment, and every document that names a source keeps behaving exactly
 * as it did.
 */
export function paintScreen(doc: ScreenDoc, points: readonly Point[], color: number): ScreenDoc {
  if (doc.source || !doc.converted) return paintRetouch(doc, points, color)
  const { width, height } = doc.converted
  const indices = decodeIndices(doc.converted.indices)
  let changed = false
  for (const p of points) {
    if (p.x < 0 || p.y < 0 || p.x >= width || p.y >= height) continue
    const at = p.y * width + p.x
    if (indices[at] === (color & 0xff)) continue
    indices[at] = color & 0xff
    changed = true
  }
  if (!changed) return doc
  return { ...doc, converted: { ...doc.converted, indices: encodeIndices(indices) } }
}

/**
 * Makes the picture show `next` — a whole `width × height` index buffer, as
 * `screenPixels` would return it — through the same channel a pencil stroke
 * uses (`paintScreen`'s rule): straight into `converted` on a drawing, as
 * retouch pixels on a conversion, so a moved or pasted region survives
 * re-running the conversion like any other stroke does.
 *
 * On a conversion only the pixels that differ from what is shown are touched,
 * and a pixel put back to what the conversion itself says loses its retouch
 * entry rather than gaining one — so moving something there and back again
 * leaves the file as it was. Built in one pass with an index, because a moved
 * region is tens of thousands of pixels and `setRetouchPixel` scans the list.
 */
export function setScreenPixels(doc: ScreenDoc, next: Uint8Array): ScreenDoc {
  const shown = screenPixels(doc)
  if (!doc.converted || !shown || next.length !== shown.indices.length) return doc
  const { width } = doc.converted
  if (!doc.source) {
    if (next.every((value, i) => value === shown.indices[i])) return doc
    return { ...doc, retouch: [], converted: { ...doc.converted, indices: encodeIndices(next) } }
  }
  const base = decodeIndices(doc.converted.indices)
  const entries = new Map<number, number>()
  for (let i = 0; i + 2 < doc.retouch.length; i += 3) entries.set(doc.retouch[i + 1] * width + doc.retouch[i], doc.retouch[i + 2])
  let changed = false
  for (let at = 0; at < next.length; at++) {
    if (next[at] === shown.indices[at]) continue
    changed = true
    if (next[at] === base[at]) entries.delete(at)
    else entries.set(at, next[at])
  }
  if (!changed) return doc
  const retouch: number[] = []
  for (const [at, color] of entries) retouch.push(at % width, Math.floor(at / width), color)
  return { ...doc, retouch }
}

/**
 * Turns a conversion into a drawing: the retouch baked into the picture and
 * the source forgotten. What pasting an imported image onto a screen does
 * first — the result is no longer what any one source converts to, so there
 * is nothing left to re-run.
 */
export function flattenScreen(doc: ScreenDoc): ScreenDoc {
  const shown = screenPixels(doc)
  if (!doc.converted || !shown) return doc.source ? { ...doc, source: '' } : doc
  if (!doc.source && !doc.retouch.length) return doc
  return { ...doc, source: '', retouch: [], converted: { ...doc.converted, indices: encodeIndices(shown.indices) } }
}

/** True when there is no picture yet, or every pixel of it is colour 0 — nothing a new palette would repaint. */
export function isBlankScreen(doc: ScreenDoc): boolean {
  const shown = screenPixels(doc)
  return !shown || shown.indices.every((value) => value === 0)
}

/** 4-connected flood over the doc's currently rendered pixels (conversion + retouch already applied). */
export function retouchFillPoints(doc: ScreenDoc, start: Point): Point[] {
  const pixels = screenPixels(doc)
  if (!pixels) return []
  const { width, height, indices } = pixels
  if (start.x < 0 || start.y < 0 || start.x >= width || start.y >= height) return []
  const target = indices[start.y * width + start.x]
  const seen = new Set<number>()
  const out: Point[] = []
  const stack: Point[] = [start]
  while (stack.length) {
    const p = stack.pop() as Point
    if (p.x < 0 || p.y < 0 || p.x >= width || p.y >= height) continue
    const key = p.y * width + p.x
    if (seen.has(key) || indices[key] !== target) continue
    seen.add(key)
    out.push(p)
    stack.push({ x: p.x + 1, y: p.y }, { x: p.x - 1, y: p.y }, { x: p.x, y: p.y + 1 }, { x: p.x, y: p.y - 1 })
  }
  return out
}

/** "Revert to conversion": drops every retouch pixel. */
export function clearRetouch(doc: ScreenDoc): ScreenDoc {
  return doc.retouch.length ? { ...doc, retouch: [] } : doc
}

// ── undo/redo ───────────────────────────────────────────────────────────────

/** The shared past/present/future stack, over this editor's document. */
export type ScreenHistory = History<ScreenDoc>
export { createHistory, pushHistory, undo, redo, canUndo, canRedo } from './history'
