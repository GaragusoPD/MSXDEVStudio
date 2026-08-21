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
import { MODES, type ScreenMode } from '../../../shared/msx/modes'
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

/**
 * Scales an image to what the mode can actually hold, when it is larger.
 *
 * Only SCREEN 3 needs it in practice: its screen is 64×48 *blocks*, so a 256×192
 * picture has to be reduced 4:1 before quantizing rather than cropped — the
 * aspect is unchanged because a block is square, and reducing first is also what
 * gives the quantizer a fair average of each block's colours.
 *
 * The browser's own scaler does the work; there is no resampler here to get
 * wrong. Images already small enough are returned untouched.
 */
export function fitToMode(image: ImageData, mode: ScreenMode): ImageData {
  const info = MODES[mode]
  if (image.width <= info.width && image.height <= info.height) return image
  const scale = Math.min(info.width / image.width, info.height / image.height)
  const width = Math.max(1, Math.round(image.width * scale))
  const height = Math.max(1, Math.round(image.height * scale))
  const from = new OffscreenCanvas(image.width, image.height)
  const fromContext = from.getContext('2d')
  const to = new OffscreenCanvas(width, height)
  const context = to.getContext('2d')
  if (!fromContext || !context) return image
  fromContext.putImageData(image, 0, 0)
  context.drawImage(from, 0, 0, width, height)
  return context.getImageData(0, 0, width, height)
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
    const picked = source.value
    if (!picked) return
    // Reduce before quantizing, not after: SCREEN 3's 64×48 is four times
    // smaller than the art it is usually made from, and averaging the colours
    // down is the conversion, not a step after it.
    const image = fitToMode(picked, options.mode)
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
