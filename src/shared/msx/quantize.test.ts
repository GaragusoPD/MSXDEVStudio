import { describe, expect, it } from 'vitest'
import { isValidGrb, MSX1_PALETTE_RGB } from './palette'
import { fitRowConstraint, medianCut, quantize, rgb332Palette, type RgbaImage } from './quantize'
import { packTiles, rowColorViolations, tilePixels, validateTiles } from './tile'

/**
 * A deterministic stand-in for "a reference image": diagonal RGB ramps with a
 * few saturated blocks, so the quantizer sees both smooth gradients and hard
 * edges. Programmatic on purpose — no PNG decoder in the unit tests.
 */
function referenceImage(width = 64, height = 48): RgbaImage {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4
      const block = ((x >> 4) + (y >> 4)) % 3
      data[at] = block === 0 ? (x * 255) / width : block === 1 ? 220 : 20
      data[at + 1] = block === 0 ? (y * 255) / height : block === 1 ? 30 : 180
      data[at + 2] = block === 0 ? ((x + y) * 255) / (width + height) : block === 1 ? 40 : 200
      data[at + 3] = 255
    }
  }
  return { width, height, data }
}

/** Solid-color image, for exact expectations. */
function solid(width: number, height: number, rgb: [number, number, number]): RgbaImage {
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb[0]
    data[i * 4 + 1] = rgb[1]
    data[i * 4 + 2] = rgb[2]
    data[i * 4 + 3] = 255
  }
  return { width, height, data }
}

describe('median cut', () => {
  it('returns at most the requested number of colors', () => {
    const histogram = new Map<number, number>()
    for (let i = 0; i < 500; i++) histogram.set((i * 7919) & 0xffffff, 1 + (i % 5))
    expect(medianCut(histogram, 16).length).toBeLessThanOrEqual(16)
  })

  it('cannot split beyond the number of distinct colors', () => {
    const histogram = new Map([[0xff0000, 10], [0x00ff00, 10]])
    expect(medianCut(histogram, 16)).toHaveLength(2)
  })

  it('is deterministic', () => {
    const histogram = new Map<number, number>()
    for (let i = 0; i < 200; i++) histogram.set((i * 104729) & 0xffffff, i + 1)
    expect(medianCut(histogram, 8)).toEqual(medianCut(histogram, 8))
  })
})

describe('sc5 (16 colors out of 512)', () => {
  const result = quantize(referenceImage(), { mode: 'sc5', palette: 'optimized', dither: 'none' })

  it('produces at most 16 colors, all inside the GRB333 space', () => {
    expect(result.palette).not.toBeNull()
    expect(result.palette).toHaveLength(16)
    expect(result.palette?.every(isValidGrb)).toBe(true)
    expect(new Set(result.indices).size).toBeLessThanOrEqual(16)
    expect([...result.indices].every((index) => index < 16)).toBe(true)
  })

  it('keeps index 0 free for transparency', () => {
    expect(result.indices).not.toContain(0)
  })

  it('reports how many source colors were merged', () => {
    expect(result.report.colorsUsed).toBeGreaterThan(1)
    expect(result.report.colorsMerged).toBeGreaterThan(0)
    expect(result.report.rowsAltered).toBe(0) // bitmap mode: no row constraint
  })

  it('is byte-stable across runs', () => {
    const again = quantize(referenceImage(), { mode: 'sc5', palette: 'optimized', dither: 'none' })
    expect(again.indices).toEqual(result.indices)
    expect(again.palette).toEqual(result.palette)
  })

  it('maps a solid color to a single palette entry', () => {
    const flat = quantize(solid(8, 8, [255, 0, 0]), { mode: 'sc5', palette: 'optimized', dither: 'none' })
    expect(new Set(flat.indices).size).toBe(1)
    expect(flat.rgb[flat.indices[0]]).toEqual({ r: 255, g: 0, b: 0 })
  })
})

describe('sc6 (4 colors)', () => {
  it('never emits an index above 3', () => {
    const result = quantize(referenceImage(32, 32), { mode: 'sc6', palette: 'optimized', dither: 'none' })
    expect(result.palette).toHaveLength(4)
    expect([...result.indices].every((index) => index < 4)).toBe(true)
  })
})

describe('sc8 (fixed RGB332)', () => {
  it('uses the hardware palette and reports no programmable one', () => {
    const result = quantize(solid(8, 8, [255, 255, 255]), { mode: 'sc8' })
    expect(result.palette).toBeNull()
    expect(result.rgb).toHaveLength(256)
    expect(rgb332Palette()[result.indices[0]]).toEqual({ r: 255, g: 255, b: 255 })
    expect(result.indices[0]).toBe(0xff)
  })
})

describe('sc2 constraint fit', () => {
  const image = referenceImage(64, 64)

  it('leaves no 8×1 span with more than two colors', () => {
    const result = quantize(image, { mode: 'sc2', dither: 'none' })
    expect(rowColorViolations(result.indices, result.width, result.height)).toEqual([])
  })

  it('produces a tileset that passes the tile validators and re-decodes unchanged', () => {
    const result = quantize(image, { mode: 'sc2', dither: 'none' })
    const { doc } = packTiles(result.indices, result.width, result.height, 'sc2')
    expect(validateTiles(doc)).toEqual([])

    // Constraint-fit output is exactly representable: packing then unpacking
    // tile 0 must return the same pixels.
    const decoded = tilePixels(doc, 0)
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        expect(decoded[y * 8 + x]).toBe(result.indices[y * result.width + x])
      }
    }
  })

  it('uses the fixed MSX1 palette for sc2, whatever the caller asks for', () => {
    const result = quantize(image, { mode: 'sc2', palette: 'optimized' })
    expect(result.palette).toBeNull()
    expect(result.rgb).toEqual([...MSX1_PALETTE_RGB])
  })

  it('reports the rows it had to reduce', () => {
    const result = quantize(image, { mode: 'sc2', dither: 'floyd' })
    expect(result.report.rowsAltered).toBeGreaterThan(0)
    expect(result.report.pixelsChanged).toBeGreaterThan(0)
  })

  it('leaves an already-compliant image alone', () => {
    const indices = new Uint8Array(16)
    indices.set([1, 1, 1, 1, 5, 5, 5, 5], 0)
    indices.set([2, 2, 2, 2, 2, 2, 2, 2], 8)
    const before = indices.slice()
    const report = fitRowConstraint(indices, 8, 2, MSX1_PALETTE_RGB)
    expect(report).toEqual({ rowsAltered: 0, pixelsChanged: 0 })
    expect(indices).toEqual(before)
  })

  it('keeps the two most-used colors and moves the rest to the nearer survivor', () => {
    const indices = Uint8Array.from([1, 1, 1, 15, 15, 15, 14, 4])
    // 14 (gray) is nearest white(15); 4 (dark blue) is nearest black(1).
    const report = fitRowConstraint(indices, 8, 1, MSX1_PALETTE_RGB)
    expect(report).toEqual({ rowsAltered: 1, pixelsChanged: 2 })
    expect([...indices]).toEqual([1, 1, 1, 15, 15, 15, 15, 1])
  })
})

describe('dithering', () => {
  const gradient: RgbaImage = (() => {
    const width = 32
    const height = 8
    const data = new Uint8Array(width * height * 4)
    for (let i = 0; i < width * height; i++) {
      const value = Math.round(((i % width) * 255) / (width - 1))
      data[i * 4] = value
      data[i * 4 + 1] = value
      data[i * 4 + 2] = value
      data[i * 4 + 3] = 255
    }
    return { width, height, data }
  })()

  /**
   * Squared error of 4×4 *block averages* — the thing dithering actually
   * optimizes. (Per-pixel error goes up: that's the noise it trades in.)
   */
  function blockError(result: ReturnType<typeof quantize>): number {
    let sum = 0
    for (let by = 0; by < gradient.height; by += 4) {
      for (let bx = 0; bx < gradient.width; bx += 4) {
        const want = [0, 0, 0]
        const got = [0, 0, 0]
        for (let y = by; y < by + 4; y++) {
          for (let x = bx; x < bx + 4; x++) {
            const at = y * gradient.width + x
            const color = result.rgb[result.indices[at]]
            want[0] += gradient.data[at * 4]
            want[1] += gradient.data[at * 4 + 1]
            want[2] += gradient.data[at * 4 + 2]
            got[0] += color.r
            got[1] += color.g
            got[2] += color.b
          }
        }
        for (let channel = 0; channel < 3; channel++) sum += ((want[channel] - got[channel]) / 16) ** 2
      }
    }
    return sum
  }

  it('trades banding for noise: both algorithms change the output and beat flat nearest-match', () => {
    const plain = quantize(gradient, { mode: 'sc5', palette: 'msx1', dither: 'none' })
    const bayer = quantize(gradient, { mode: 'sc5', palette: 'msx1', dither: 'bayer4' })
    const floyd = quantize(gradient, { mode: 'sc5', palette: 'msx1', dither: 'floyd' })
    expect(bayer.indices).not.toEqual(plain.indices)
    expect(floyd.indices).not.toEqual(plain.indices)
    // Error diffusion should track the ramp's local average better than a flat nearest match.
    expect(blockError(floyd)).toBeLessThan(blockError(plain))
    // Ordered dithering varies vertically even though every column of the
    // source is a single flat value.
    const varying = Array.from({ length: gradient.width }, (_, x) =>
      new Set(Array.from({ length: gradient.height }, (_, y) => bayer.indices[y * gradient.width + x])).size
    )
    expect(Math.max(...varying)).toBeGreaterThan(1)
  })

  it('is deterministic for both algorithms', () => {
    for (const dither of ['bayer4', 'floyd'] as const) {
      expect(quantize(gradient, { mode: 'sc5', dither }).indices).toEqual(
        quantize(gradient, { mode: 'sc5', dither }).indices
      )
    }
  })
})

describe('transparency', () => {
  it('sends fully transparent pixels to index 0', () => {
    const image = solid(4, 4, [10, 200, 10])
    image.data[3] = 0 // first pixel fully transparent
    const result = quantize(image, { mode: 'sc5' })
    expect(result.indices[0]).toBe(0)
    expect(result.indices[1]).not.toBe(0)
  })
})

describe('locked palettes', () => {
  it('uses exactly the entries the caller supplies', () => {
    const palette = [0x000, 0x700, 0x070, 0x007]
    const result = quantize(referenceImage(16, 16), { mode: 'sc5', palette, colors: 4 })
    expect(result.palette).toEqual(palette)
    expect([...result.indices].every((index) => index < 4)).toBe(true)
  })
})
