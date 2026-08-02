import { describe, expect, it } from 'vitest'
import { isValidGrb } from './msx/palette'
import { quantize, type RgbaImage } from './msx/quantize'
import { createScreenDoc, screenPixels } from './msx/screen'
import {
  applyConversion,
  canRedo,
  canUndo,
  clearRetouch,
  createHistory,
  paintRetouch,
  pushHistory,
  redo,
  retouchFillPoints,
  setPaletteEntry,
  setRetouchPixel,
  undo
} from './screen-editor'

/** A smooth RGB gradient — far more than 16 distinct colors, so quantizing it down actually exercises median cut. */
function gradientImage(width: number, height: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      data[i] = Math.floor((x / width) * 255)
      data[i + 1] = Math.floor((y / height) * 255)
      data[i + 2] = Math.floor(((x + y) / (width + height)) * 255)
      data[i + 3] = 255
    }
  }
  return { width, height, data }
}

describe('acceptance: PNG → sc5 conversion + retouch survives reconversion', () => {
  it('produces a ≤16-color 256×212 output whose palette validates as GRB333', () => {
    const image = gradientImage(256, 212)
    const result = quantize(image, { mode: 'sc5' })
    expect(result.width).toBe(256)
    expect(result.height).toBe(212)
    expect(new Set(result.indices).size).toBeLessThanOrEqual(16)
    expect(result.palette).not.toBeNull()
    expect(result.palette!.length).toBeLessThanOrEqual(16)
    for (const entry of result.palette!) expect(isValidGrb(entry)).toBe(true)
  })

  it('retouch survives a reconversion with different settings', () => {
    const image = gradientImage(256, 212)
    const first = quantize(image, { mode: 'sc5', dither: 'none' })
    let doc = applyConversion(createScreenDoc('sc5', 'art/title.png'), first)

    // A retouch pixel that the raw conversion is very unlikely to have produced there.
    doc = setRetouchPixel(doc, 5, 5, 15)
    expect(screenPixels(doc)!.indices[5 * 256 + 5]).toBe(15)

    // Re-run the conversion with different settings, as "reconvert" would after a dither/palette change.
    const second = quantize(image, { mode: 'sc5', dither: 'floyd' })
    doc = applyConversion(doc, second)

    // The retouch pixel still overrides whatever the fresh conversion produced there…
    expect(screenPixels(doc)!.indices[5 * 256 + 5]).toBe(15)
    // …while an untouched pixel reflects the new conversion.
    const untouched = 200 * 256 + 200
    expect(screenPixels(doc)!.indices[untouched]).toBe(second.indices[untouched])
  })
})

describe('retouch tools', () => {
  it('setRetouchPixel replaces (not appends) a repeated coordinate', () => {
    const result = quantize(gradientImage(8, 8), { mode: 'sc5' })
    let doc = applyConversion(createScreenDoc('sc5'), result)
    doc = setRetouchPixel(doc, 0, 0, 3)
    doc = setRetouchPixel(doc, 0, 0, 9)
    expect(doc.retouch).toEqual([0, 0, 9])
  })

  it('is a no-op when the pixel already has that color', () => {
    const result = quantize(gradientImage(8, 8), { mode: 'sc5' })
    const doc = applyConversion(createScreenDoc('sc5'), result)
    const once = setRetouchPixel(doc, 0, 0, 7)
    expect(setRetouchPixel(once, 0, 0, 7)).toBe(once)
  })

  it('paintRetouch applies a whole stroke of points', () => {
    const result = quantize(gradientImage(8, 8), { mode: 'sc5' })
    const doc = applyConversion(createScreenDoc('sc5'), result)
    const painted = paintRetouch(doc, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }], 4)
    expect(painted.retouch).toEqual([0, 0, 4, 1, 0, 4, 2, 0, 4])
  })

  it('retouchFillPoints floods the region matching the start pixel', () => {
    const image: RgbaImage = {
      width: 4,
      height: 1,
      data: new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255])
    }
    const result = quantize(image, { mode: 'sc5', palette: 'msx1' })
    const doc = applyConversion(createScreenDoc('sc5'), result)
    const points = retouchFillPoints(doc, { x: 0, y: 0 })
    expect(points.map((p) => p.x).sort()).toEqual([0, 1])
  })

  it('retouchFillPoints returns nothing when there is no converted image yet', () => {
    expect(retouchFillPoints(createScreenDoc('sc5'), { x: 0, y: 0 })).toEqual([])
  })

  it('clearRetouch drops every retouch pixel', () => {
    const result = quantize(gradientImage(4, 4), { mode: 'sc5' })
    let doc = applyConversion(createScreenDoc('sc5'), result)
    doc = setRetouchPixel(doc, 0, 0, 1)
    expect(clearRetouch(doc).retouch).toEqual([])
  })
})

describe('palette touch-up', () => {
  it('replaces one converted palette entry without requantizing', () => {
    const result = quantize(gradientImage(8, 8), { mode: 'sc5' })
    let doc = applyConversion(createScreenDoc('sc5'), result)
    doc = setPaletteEntry(doc, 0, 0x0777)
    expect(doc.converted!.palette![0]).toBe(0x0777)
    // The pixel indices themselves are untouched — this is a palette swap, not a requantize.
    expect(doc.converted!.indices).toBe(applyConversion(createScreenDoc('sc5'), result).converted!.indices)
  })

  it('is a no-op on a fixed palette (sc8)', () => {
    const result = quantize(gradientImage(8, 8), { mode: 'sc8' })
    const doc = applyConversion(createScreenDoc('sc8'), result)
    expect(setPaletteEntry(doc, 0, 0x0777)).toBe(doc)
  })
})

describe('undo/redo', () => {
  it('round-trips through retouch edits', () => {
    const result = quantize(gradientImage(4, 4), { mode: 'sc5' })
    const start = applyConversion(createScreenDoc('sc5'), result)
    let history = createHistory(start)
    history = pushHistory(history, setRetouchPixel(start, 0, 0, 1))
    expect(history.present.retouch).toEqual([0, 0, 1])

    history = undo(history)
    expect(history.present).toBe(start)
    expect(canUndo(history)).toBe(false)

    history = redo(history)
    expect(history.present.retouch).toEqual([0, 0, 1])
    expect(canRedo(history)).toBe(false)
  })

  it('a no-op commit does not grow the stack', () => {
    const result = quantize(gradientImage(4, 4), { mode: 'sc5' })
    const start = applyConversion(createScreenDoc('sc5'), result)
    let history = createHistory(start)
    history = pushHistory(history, start)
    expect(canUndo(history)).toBe(false)
  })
})
