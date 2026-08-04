import { describe, expect, it } from 'vitest'
import { isValidGrb } from './msx/palette'
import { quantize, type RgbaImage } from './msx/quantize'
import {
  createScreenDoc,
  encodeIndices,
  fragmentRectBytes,
  fragmentStrip,
  fragmentStripBytes,
  fragmentStripPixels,
  normalizeScreen,
  screenHelperC,
  screenPixels,
  type ScreenDoc
} from './msx/screen'
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

describe('bitmap fragments', () => {
  /** A 64×32 sc5 screen whose pixel (x, y) is a recognisable value. */
  function screen(fragments: { name: string; x: number; y: number; width: number; height: number }[]): ScreenDoc {
    const width = 64
    const height = 32
    const indices = new Uint8Array(width * height)
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) indices[y * width + x] = (x + y) % 16
    return normalizeScreen({
      mode: 'sc5',
      source: 'art/hero.png',
      fragments,
      converted: { width, height, palette: new Array(16).fill(0), indices: encodeIndices(indices) }
    })
  }

  it('lays fragments side by side into one strip, tallest first setting the height', () => {
    const doc = screen([
      { name: 'idle', x: 0, y: 0, width: 16, height: 16 },
      { name: 'jump', x: 20, y: 4, width: 8, height: 24 }
    ])
    expect(fragmentStrip(doc)).toEqual({ width: 24, height: 24, offsets: [0, 16] })
  })

  it('cuts each fragment out of the converted image at its own offset', () => {
    const doc = screen([{ name: 'a', x: 3, y: 2, width: 4, height: 2 }])
    const strip = fragmentStripPixels(doc)
    // Source pixel (x, y) is (x + y) % 16, so the fragment's first row starts at 3 + 2.
    expect([...strip.subarray(0, 4)]).toEqual([5, 6, 7, 8])
    expect([...strip.subarray(4, 8)]).toEqual([6, 7, 8, 9])
  })

  it('leaves the short fragments transparent where the strip is taller', () => {
    const doc = screen([
      { name: 'short', x: 0, y: 0, width: 2, height: 1 },
      { name: 'tall', x: 0, y: 0, width: 2, height: 3 }
    ])
    const strip = fragmentStripPixels(doc)
    expect(strip).toHaveLength(4 * 3)
    expect([...strip.subarray(4, 6)]).toEqual([0, 0]) // row 1 under 'short'
  })

  it('clips a fragment that runs off the image instead of reading past it', () => {
    const doc = screen([{ name: 'edge', x: 62, y: 30, width: 8, height: 8 }])
    const strip = fragmentStripPixels(doc)
    expect(strip).toHaveLength(8 * 8)
    expect(strip[2]).toBe(0) // past the right edge of a 64-wide image
  })

  it('packs the strip for the mode and describes each rect for the runtime', () => {
    const doc = screen([
      { name: 'idle', x: 0, y: 0, width: 16, height: 16 },
      { name: 'jump', x: 20, y: 4, width: 8, height: 16 }
    ])
    // sc5 is 2 pixels per byte: a 24×16 strip is 12 bytes per row.
    expect(fragmentStripBytes(doc)).toHaveLength(12 * 16)
    expect([...fragmentRectBytes(doc)]).toEqual([0, 0, 16, 16, 16, 0, 8, 16])
  })

  it('carries a 16-bit strip offset once the frames run past 255 dots', () => {
    const doc = screen(
      Array.from({ length: 20 }, (_, i) => ({ name: `f${i}`, x: 0, y: 0, width: 16, height: 8 }))
    )
    const rects = fragmentRectBytes(doc)
    expect(fragmentStrip(doc).width).toBe(320)
    expect([...rects.subarray(19 * 4, 19 * 4 + 2)]).toEqual([304 & 0xff, 1]) // 304 = 0x130
  })

  it('emits the software-sprite runtime only for the fragments it has', () => {
    const doc = screen([{ name: 'idle', x: 0, y: 0, width: 16, height: 16 }])
    const helper = screenHelperC(doc, 'g_Hero')
    const code = [...helper.header, ...helper.source].join('\n')
    // The struct and the prototypes are the header's; the bodies are the .c's.
    expect(helper.header.join('\n')).toContain('} g_Hero_SwSprite;')
    expect(helper.header.join('\n')).toContain('void g_Hero_Upload(u8 stripY);')
    expect(helper.source.join('\n')).toContain('void g_Hero_Upload(u8 stripY)')
    expect(code).toContain('VDP_CommandLMMM(sx, stripY, x, y, w, h, VDP_OP_TIMP);')
    // Each object saves its background in its own column, or they eat each other's.
    expect(code).toContain('s->slot * G_HERO_BACKUP_PITCH')
  })

  it('survives a save/load round-trip', () => {
    const doc = screen([{ name: 'idle', x: 1, y: 2, width: 3, height: 4 }])
    expect(normalizeScreen(JSON.parse(JSON.stringify(doc)))).toEqual(doc)
  })
})
