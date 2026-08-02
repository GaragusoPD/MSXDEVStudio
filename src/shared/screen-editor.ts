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

import { encodeIndices, screenPixels, type ConvertedScreen, type ScreenDoc } from './msx/screen'
import type { Point } from './tile-editor'

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
  return { ...doc, converted }
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

// ── undo/redo (same past/present/future shape as `shared/sprite-editor.ts`) ──

export interface ScreenHistory {
  past: ScreenDoc[]
  present: ScreenDoc
  future: ScreenDoc[]
}

const HISTORY_LIMIT = 200

export function createHistory(doc: ScreenDoc): ScreenHistory {
  return { past: [], present: doc, future: [] }
}

export function pushHistory(history: ScreenHistory, next: ScreenDoc): ScreenHistory {
  if (next === history.present) return history
  return { past: [...history.past, history.present].slice(-HISTORY_LIMIT), present: next, future: [] }
}

export function undo(history: ScreenHistory): ScreenHistory {
  if (!history.past.length) return history
  const present = history.past[history.past.length - 1]
  return { past: history.past.slice(0, -1), present, future: [history.present, ...history.future] }
}

export function redo(history: ScreenHistory): ScreenHistory {
  if (!history.future.length) return history
  const [present, ...future] = history.future
  return { past: [...history.past, history.present], present, future }
}

export function canUndo(history: ScreenHistory): boolean {
  return history.past.length > 0
}

export function canRedo(history: ScreenHistory): boolean {
  return history.future.length > 0
}
