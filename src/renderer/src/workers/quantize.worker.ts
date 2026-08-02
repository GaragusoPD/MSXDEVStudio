/**
 * Runs `quantize.ts` off the UI thread: a full-screen sc5 conversion with
 * Floyd–Steinberg is tens of milliseconds, and the import dialog re-runs it on
 * every option change.
 */

import { quantize, type LossReport, type QuantizeOptions } from '../../../shared/msx/quantize'
import type { Rgb } from '../../../shared/msx/palette'

export interface QuantizeRequest {
  /** Echoed back so the dialog can drop results from superseded runs. */
  id: number
  width: number
  height: number
  /** RGBA bytes, transferred (not copied). */
  data: ArrayBuffer
  options: QuantizeOptions
}

export interface QuantizeResponse {
  id: number
  width: number
  height: number
  /** One palette index per pixel. */
  indices: ArrayBuffer
  palette: number[] | null
  rgb: Rgb[]
  report: LossReport
  error?: string
}

// `self` is typed as a Window under the DOM lib; this is the worker surface we use.
const worker = globalThis as unknown as {
  onmessage: ((event: MessageEvent<QuantizeRequest>) => void) | null
  postMessage(message: QuantizeResponse, transfer?: Transferable[]): void
}

worker.onmessage = (event): void => {
  const { id, width, height, data, options } = event.data
  try {
    const result = quantize({ width, height, data: new Uint8Array(data) }, options)
    const indices = result.indices.buffer as ArrayBuffer
    worker.postMessage(
      {
        id,
        width: result.width,
        height: result.height,
        indices,
        palette: result.palette,
        rgb: result.rgb,
        report: result.report
      },
      [indices]
    )
  } catch (error) {
    worker.postMessage({
      id,
      width,
      height,
      indices: new ArrayBuffer(0),
      palette: null,
      rgb: [],
      report: { colorsUsed: 0, colorsMerged: 0, rowsAltered: 0, pixelsChanged: 0 },
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
