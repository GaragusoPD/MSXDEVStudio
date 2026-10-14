/**
 * The quantize worker as a promise: one worker for a component's life, each
 * `run` answered by its own result. `useImageImport` keeps its own because it
 * owns its options and previews; this is for callers that hold the image
 * themselves — the sheet importer converts a strip of cells it cut.
 */

import { onUnmounted } from 'vue'
import type { QuantizeOptions, QuantizeResult, RgbaImage } from '../../../shared/msx/quantize'
import type { QuantizeRequest, QuantizeResponse } from '../workers/quantize.worker'

export interface Quantizer {
  run(image: RgbaImage, options: QuantizeOptions): Promise<QuantizeResult>
}

export function useQuantizer(): Quantizer {
  const worker = new Worker(new URL('../workers/quantize.worker.ts', import.meta.url), { type: 'module' })
  const waiting = new Map<number, { resolve: (result: QuantizeResult) => void; reject: (error: Error) => void }>()
  let nextId = 0

  worker.onmessage = (event: MessageEvent<QuantizeResponse>): void => {
    const pending = waiting.get(event.data.id)
    if (!pending) return
    waiting.delete(event.data.id)
    if (event.data.error) {
      pending.reject(new Error(event.data.error))
      return
    }
    pending.resolve({
      width: event.data.width,
      height: event.data.height,
      indices: new Uint8Array(event.data.indices),
      palette: event.data.palette,
      rgb: event.data.rgb,
      report: event.data.report
    })
  }

  function run(image: RgbaImage, options: QuantizeOptions): Promise<QuantizeResult> {
    const id = ++nextId
    // The worker takes the buffer; the caller's image stays usable.
    const data = Uint8Array.from(image.data).buffer as ArrayBuffer
    const request: QuantizeRequest = { id, width: image.width, height: image.height, data, options }
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject })
      worker.postMessage(request, [data])
    })
  }

  onUnmounted(() => {
    worker.terminate()
    for (const pending of waiting.values()) pending.reject(new Error('closed'))
    waiting.clear()
  })

  return { run }
}
