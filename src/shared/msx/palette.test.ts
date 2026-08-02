import { describe, expect, it } from 'vitest'
import {
  colorDistance,
  fromHex,
  grbToRgb,
  grbToVdpBytes,
  isValidGrb,
  MSX1_PALETTE_GRB,
  MSX1_PALETTE_RGB,
  nearestColor,
  packGrb,
  paletteToRgb,
  rgbToGrb,
  toHex,
  unpackGrb
} from './palette'

describe('GRB333', () => {
  it('round-trips every one of the 512 colors through RGB', () => {
    for (let g = 0; g < 8; g++) {
      for (let r = 0; r < 8; r++) {
        for (let b = 0; b < 8; b++) {
          const packed = packGrb(r, g, b)
          expect(unpackGrb(packed)).toEqual({ r, g, b })
          expect(rgbToGrb(grbToRgb(packed))).toBe(packed)
        }
      }
    }
  })

  it('packs into MSXgl RGB16 layout: [00000GGG][0RRR0BBB]', () => {
    const white = packGrb(7, 7, 7)
    expect(white).toBe(0x777)
    expect(grbToVdpBytes(white)).toEqual([0x77, 0x07])
    expect(grbToVdpBytes(packGrb(5, 2, 1))).toEqual([0x51, 0x02])
  })

  it('expands components the way openMSX does', () => {
    expect(grbToRgb(packGrb(0, 0, 0))).toEqual({ r: 0, g: 0, b: 0 })
    expect(grbToRgb(packGrb(7, 7, 7))).toEqual({ r: 255, g: 255, b: 255 })
    expect(grbToRgb(packGrb(1, 0, 0)).r).toBe(36)
    expect(grbToRgb(packGrb(4, 0, 0)).r).toBe(146)
  })

  it('rejects values with bits outside the three fields', () => {
    expect(isValidGrb(0x777)).toBe(true)
    expect(isValidGrb(0x888)).toBe(false)
    expect(isValidGrb(-1)).toBe(false)
  })

  it('snaps arbitrary RGB into the 512-color space', () => {
    // Anything the picker produces must land on a real hardware color.
    for (const sample of [0, 17, 63, 128, 200, 255]) {
      expect(isValidGrb(rgbToGrb({ r: sample, g: 255 - sample, b: sample }))).toBe(true)
    }
  })
})

describe('fixed palettes', () => {
  it('has 16 TMS9918A entries with black at 1 and white at 15', () => {
    expect(MSX1_PALETTE_RGB).toHaveLength(16)
    expect(MSX1_PALETTE_RGB[1]).toEqual({ r: 0, g: 0, b: 0 })
    expect(MSX1_PALETTE_RGB[15]).toEqual({ r: 255, g: 255, b: 255 })
  })

  it('mirrors MSXgl COLOR16_MSX1_* for MSX2 reproduction', () => {
    expect(MSX1_PALETTE_GRB).toHaveLength(16)
    expect(MSX1_PALETTE_GRB[2]).toBe(packGrb(1, 5, 1)) // medium green: RGB16(r=1,g=5,b=1)
    expect(MSX1_PALETTE_GRB[15]).toBe(packGrb(7, 7, 7))
    expect(MSX1_PALETTE_GRB.every(isValidGrb)).toBe(true)
  })

  it('resolves a null document palette to the fixed one', () => {
    expect(paletteToRgb(null)).toEqual([...MSX1_PALETTE_RGB])
    expect(paletteToRgb([packGrb(7, 0, 0)])[0]).toEqual({ r: 255, g: 0, b: 0 })
  })
})

describe('nearest color', () => {
  it('finds the exact entry when the color is in the palette', () => {
    expect(nearestColor({ r: 255, g: 255, b: 255 }, MSX1_PALETTE_RGB)).toBe(15)
    expect(nearestColor({ r: 33, g: 200, b: 66 }, MSX1_PALETTE_RGB)).toBe(2)
  })

  it('honours the skip list (index 0 is transparent, not a color)', () => {
    // Pure black matches both index 0 and 1; skipping 0 must return black.
    expect(nearestColor({ r: 0, g: 0, b: 0 }, MSX1_PALETTE_RGB)).toBe(0)
    expect(nearestColor({ r: 0, g: 0, b: 0 }, MSX1_PALETTE_RGB, [0])).toBe(1)
  })

  it('weights green more than blue', () => {
    const green = colorDistance({ r: 0, g: 0, b: 0 }, { r: 0, g: 10, b: 0 })
    const blue = colorDistance({ r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 10 })
    expect(green).toBeGreaterThan(blue)
  })
})

describe('hex', () => {
  it('round-trips', () => {
    expect(toHex({ r: 255, g: 0, b: 128 })).toBe('#ff0080')
    expect(fromHex('#ff0080')).toEqual({ r: 255, g: 0, b: 128 })
    expect(fromHex('FF00FF')).toEqual({ r: 255, g: 0, b: 255 })
  })
})
