/**
 * Mouse-wheel zoom and middle-button pan for a scrolling canvas pane — one
 * handler for every editor that has a zoom control, so the wheel means the same
 * thing in all of them. The math is `shared/wheel-zoom.ts`; this only reads the
 * events and the pane's scroll offsets.
 *
 * - wheel: one zoom step per notch, centred on the pointer;
 * - Shift + wheel: left alone (the browser scrolls sideways);
 * - Ctrl + wheel: scrolls up and down, which the plain wheel no longer does;
 * - middle button drag: pans.
 *
 * `get`/`set` are the editor's own zoom and setter: the setter keeps its own
 * clamping and snapping, and the pane is re-anchored on the zoom it really
 * took, read back after the DOM has re-rendered at it.
 */
import { nextTick, onBeforeUnmount, watch, type Ref } from 'vue'
import { anchoredScroll, stepZoom, wheelNotch, type WheelState, type ZoomRange } from '../../../shared/wheel-zoom'

export interface WheelZoomOptions extends ZoomRange {
  get: () => number
  set: (zoom: number) => void
}

export function useWheelZoom(pane: Ref<HTMLElement | null>, options: WheelZoomOptions): void {
  const state: WheelState = { pending: 0 }
  let pan: { x: number; y: number; left: number; top: number } | null = null

  function onWheel(event: WheelEvent): void {
    const element = pane.value
    if (!element || event.shiftKey) return
    event.preventDefault()
    if (event.ctrlKey) {
      element.scrollTop += event.deltaMode === 1 ? event.deltaY * 40 : event.deltaY
      return
    }
    const notch = wheelNotch(state, event.deltaY, event.deltaMode)
    if (notch === 0) return
    const before = options.get()
    const wanted = stepZoom(before, notch, options)
    if (wanted === before) return
    const rect = element.getBoundingClientRect()
    const pointerX = event.clientX - rect.left
    const pointerY = event.clientY - rect.top
    const scrollX = element.scrollLeft
    const scrollY = element.scrollTop
    options.set(wanted)
    void nextTick(() => {
      const after = options.get()
      if (after === before) return
      element.scrollLeft = anchoredScroll(scrollX, pointerX, before, after)
      element.scrollTop = anchoredScroll(scrollY, pointerY, before, after)
    })
  }

  function onMouseDown(event: MouseEvent): void {
    const element = pane.value
    if (!element || event.button !== 1) return
    // Middle-click would otherwise start the browser's autoscroll (or paste, on X11).
    event.preventDefault()
    pan = { x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  function onMouseMove(event: MouseEvent): void {
    const element = pane.value
    if (!element || !pan) return
    element.scrollLeft = pan.left - (event.clientX - pan.x)
    element.scrollTop = pan.top - (event.clientY - pan.y)
  }

  function onMouseUp(event: MouseEvent): void {
    if (event.button !== 1) return
    stopPan()
  }

  function stopPan(): void {
    pan = null
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mouseup', onMouseUp)
  }

  // The pane can come and go with the editor's own `v-if`s (a loading state, an error).
  watch(
    pane,
    (element, previous) => {
      previous?.removeEventListener('wheel', onWheel)
      previous?.removeEventListener('mousedown', onMouseDown)
      element?.addEventListener('wheel', onWheel, { passive: false })
      element?.addEventListener('mousedown', onMouseDown)
    },
    { immediate: true, flush: 'post' }
  )

  onBeforeUnmount(() => {
    pane.value?.removeEventListener('wheel', onWheel)
    pane.value?.removeEventListener('mousedown', onMouseDown)
    stopPan()
  })
}
