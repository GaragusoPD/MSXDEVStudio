/**
 * Mouse-wheel zoom for the drawing canvases, as plain math: which way a wheel
 * event zooms, the next zoom level, and where to scroll so the dot under the
 * pointer stays under it. `renderer/src/composables/useWheelZoom.ts` wires it
 * to the DOM; every editor with a zoom control uses that one handler.
 *
 * The convention, the same in every editor:
 * - wheel: zoom in (wheel pushed away) and out, centred on the pointer;
 * - Shift + wheel: scroll sideways (the browser's own, left alone);
 * - Ctrl + wheel: scroll up and down;
 * - middle button drag: pan.
 */

/** A wheel delta this big (in pixels) is one mouse notch; smaller ones (a trackpad) add up to one. */
export const NOTCH_PIXELS = 50
/** Each notch multiplies or divides the zoom by this much, as image editors do. */
export const ZOOM_FACTOR = 1.25

export interface WheelState {
  /** Wheel distance not yet turned into a notch, in pixels. */
  pending: number
}

/**
 * Turns one wheel event into notches: +1 zooms in (wheel pushed away, `deltaY`
 * negative), -1 out, 0 not yet. A mouse notch is always exactly one step,
 * however large the platform reports it (53 or 120 pixels, or 3 lines); a
 * trackpad's small deltas are summed until they make one, so a swipe does not
 * zoom from one end of the range to the other.
 */
export function wheelNotch(state: WheelState, deltaY: number, deltaMode: number): -1 | 0 | 1 {
  // DOM_DELTA_LINE (1) and DOM_DELTA_PAGE (2) are mouse wheels in coarse units.
  const pixels = deltaMode === 1 ? deltaY * 40 : deltaMode === 2 ? deltaY * 400 : deltaY
  if (Math.abs(pixels) >= NOTCH_PIXELS) {
    state.pending = 0
    return pixels < 0 ? 1 : -1
  }
  // A change of direction starts over, so a trackpad never needs to undo a backlog.
  if (Math.sign(pixels) !== Math.sign(state.pending)) state.pending = 0
  state.pending += pixels
  if (Math.abs(state.pending) < NOTCH_PIXELS) return 0
  const notch = state.pending < 0 ? 1 : -1
  state.pending = 0
  return notch
}

export interface ZoomRange {
  min: number
  max: number
  /** The smallest change the editor takes (its slider's step); zooms land on multiples of it. */
  quantum: number
}

/**
 * The zoom one notch in (`direction` 1) or out (-1) from `zoom`: `ZOOM_FACTOR`
 * times or over, on the range's quantum, always at least one quantum away, and
 * clamped to the range. At the end of the range it returns `zoom` unchanged.
 */
export function stepZoom(zoom: number, direction: 1 | -1, range: ZoomRange): number {
  const { min, max } = range
  const quantum = Math.max(1, range.quantum)
  const scaled = direction > 0 ? zoom * ZOOM_FACTOR : zoom / ZOOM_FACTOR
  let next = Math.round(scaled / quantum) * quantum
  if (direction > 0 && next <= zoom) next = zoom + quantum
  if (direction < 0 && next >= zoom) next = zoom - quantum
  return Math.max(min, Math.min(max, next))
}

/**
 * Where to scroll after zooming from `before` to `after` so the content under
 * the pointer stays under it. `scroll` is the container's scroll offset on one
 * axis and `pointer` the pointer's offset from the container's edge on it; the
 * content is assumed to scale from the scroll origin, which a canvas inside a
 * scrolling pane does once it is bigger than the pane (smaller, it is centred
 * and there is nothing to scroll). Never negative.
 */
export function anchoredScroll(scroll: number, pointer: number, before: number, after: number): number {
  if (before <= 0) return scroll
  return Math.max(0, ((scroll + pointer) * after) / before - pointer)
}
