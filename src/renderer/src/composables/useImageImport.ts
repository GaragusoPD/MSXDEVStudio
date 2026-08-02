/**
 * State behind the shared "Import image" flow (Spec 07 D): decode a picked
 * image, re-quantize it in a worker whenever an option changes, and expose the
 * before/after previews plus the lossiness report.
 *
 * Specs 08–10 mount `ImportImageDialog.vue` on top of this; the Resources
 * panel uses it standalone until they exist.
 */

import { onUnmounted, reactive, ref, watch, type Ref } from 'vue'
import type { LossReport, PaletteChoice, DitherMode } from '../../../shared/msx/quantize'
import type { ScreenMode } from '../../../shared/msx/modes'
import type { Rgb } from '../../../shared/msx/palette'
import type { QuantizeRequest, QuantizeResponse } from '../workers/quantize.worker'

export interface ImportOptions {
  mode: ScreenMode
  palette: PaletteChoice
  dither: DitherMode
}

export interface ImportResult {
  width: number
  height: number
  indices: Uint8Array
  palette: number[] | null
  rgb: Rgb[]
  report: LossReport
}

export interface ImageImport {
  fileName: Ref<string | null>
  source: Ref<ImageData | null>
  options: ImportOptions
  result: Ref<ImportResult | null>
  busy: Ref<boolean>
  error: Ref<string | null>
  loadFile(file: File): Promise<void>
  reset(): void
  /** Paints an ImageData of the converted result — the "after" preview. */
  toImageData(result: ImportResult): ImageData
}

/** Decodes any image the browser understands into raw RGBA. Exported (Spec 10): the screen editor
 *  also decodes a `Blob` built from a project file's bytes (`fs:readBinary`), not just a picked `File`. */
export async function decode(file: Blob): Promise<ImageData> {
  const bitmap = await createImageBitmap(file)
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Could not get a 2D context to decode the image.')
    context.drawImage(bitmap, 0, 0)
    return context.getImageData(0, 0, bitmap.width, bitmap.height)
  } finally {
    bitmap.close()
  }
}

export function useImageImport(initial: Partial<ImportOptions> = {}): ImageImport {
  const fileName = ref<string | null>(null)
  const source = ref<ImageData | null>(null)
  const result = ref<ImportResult | null>(null)
  const busy = ref(false)
  const error = ref<string | null>(null)
  const options = reactive<ImportOptions>({
    mode: initial.mode ?? 'sc2',
    palette: initial.palette ?? 'optimized',
    dither: initial.dither ?? 'none'
  })

  const worker = new Worker(new URL('../workers/quantize.worker.ts', import.meta.url), { type: 'module' })
  let nextId = 0
  let pending = -1

  worker.onmessage = (event: MessageEvent<QuantizeResponse>): void => {
    // Options can change while a conversion is in flight; ignore stale answers.
    if (event.data.id !== pending) return
    busy.value = false
    if (event.data.error) {
      error.value = event.data.error
      result.value = null
      return
    }
    error.value = null
    result.value = {
      width: event.data.width,
      height: event.data.height,
      indices: new Uint8Array(event.data.indices),
      palette: event.data.palette,
      rgb: event.data.rgb,
      report: event.data.report
    }
  }

  function convert(): void {
    const image = source.value
    if (!image) return
    busy.value = true
    pending = ++nextId
    // The worker consumes the buffer, so hand it a copy: the source stays live
    // for the "before" preview and for the next option change.
    const data = image.data.slice().buffer as ArrayBuffer
    const request: QuantizeRequest = {
      id: pending,
      width: image.width,
      height: image.height,
      data,
      options: { ...options }
    }
    worker.postMessage(request, [data])
  }

  watch(() => [options.mode, options.palette, options.dither], convert)

  async function loadFile(file: File): Promise<void> {
    try {
      error.value = null
      fileName.value = file.name
      source.value = await decode(file)
      convert()
    } catch (loadError) {
      error.value = loadError instanceof Error ? loadError.message : String(loadError)
      source.value = null
      result.value = null
    }
  }

  function reset(): void {
    fileName.value = null
    source.value = null
    result.value = null
    error.value = null
  }

  function toImageData(converted: ImportResult): ImageData {
    const out = new ImageData(converted.width, converted.height)
    for (let i = 0; i < converted.indices.length; i++) {
      const color = converted.rgb[converted.indices[i]] ?? { r: 0, g: 0, b: 0 }
      out.data[i * 4] = color.r
      out.data[i * 4 + 1] = color.g
      out.data[i * 4 + 2] = color.b
      // Index 0 is the MSX's transparent entry; show it as a hole, not black.
      out.data[i * 4 + 3] = converted.indices[i] === 0 ? 0 : 255
    }
    return out
  }

  onUnmounted(() => worker.terminate())

  return { fileName, source, options, result, busy, error, loadFile, reset, toImageData }
}
