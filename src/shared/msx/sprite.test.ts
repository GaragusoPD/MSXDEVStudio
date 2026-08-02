import { describe, expect, it } from 'vitest'
import {
  compositeFrame,
  compositePixel,
  convertSpriteMode,
  createLayer,
  createSpritesDoc,
  getSpritePixel,
  lineColorByte,
  normalizeSprites,
  patternBytesFor,
  serializeSprites,
  setLayerCc,
  setLineColorByte,
  setSpritePixel,
  SPRITE_CC,
  SPRITE_EC,
  SPRITE_IC,
  spriteColorBytes,
  spritePatternBytes,
  validateSprites,
  type SpriteLayer
} from './sprite'

/** An 8×8 layer whose row 0 is `row`, painted in `color`, with the given bits set on every line. */
function layer8(row: number, color: number, bits = 0): SpriteLayer {
  const base = createLayer(8, color)
  return {
    ...base,
    pattern: [row, 0, 0, 0, 0, 0, 0, 0],
    lineColors: new Array<number>(16).fill(bits | color),
    cc: (bits & SPRITE_CC) !== 0
  }
}

describe('pattern layout', () => {
  it('uses 8 bytes for 8×8 and 32 for 16×16', () => {
    expect(patternBytesFor(8)).toBe(8)
    expect(patternBytesFor(16)).toBe(32)
  })

  it('maps 16×16 pixels onto the VDP’s four quadrants (TL, BL, TR, BR)', () => {
    let layer = createLayer(16)
    layer = setSpritePixel(layer, 0, 0, 16, true) // top-left quadrant, byte 0
    layer = setSpritePixel(layer, 0, 8, 16, true) // bottom-left, byte 8
    layer = setSpritePixel(layer, 8, 0, 16, true) // top-right, byte 16
    layer = setSpritePixel(layer, 15, 15, 16, true) // bottom-right, byte 31
    expect(layer.pattern[0]).toBe(0x80)
    expect(layer.pattern[8]).toBe(0x80)
    expect(layer.pattern[16]).toBe(0x80)
    expect(layer.pattern[31]).toBe(0x01)
    expect(getSpritePixel(layer, 15, 15, 16)).toBe(true)
    expect(getSpritePixel(layer, 14, 15, 16)).toBe(false)
  })
})

describe('color bytes', () => {
  it('mode 1 packs EC into the attribute byte', () => {
    const layer = { ...createLayer(8, 6), ec: true }
    expect(lineColorByte(layer, 0, 1)).toBe(SPRITE_EC | 6)
    expect(lineColorByte(layer, 9, 1)).toBe(SPRITE_EC | 6) // one color for the whole plane
  })

  it('mode 2 reads the per-line byte, EC/CC/IC included', () => {
    let layer = createLayer(16, 4)
    layer = setLineColorByte(layer, 3, SPRITE_EC | SPRITE_IC | 9)
    expect(lineColorByte(layer, 3, 2)).toBe(SPRITE_EC | SPRITE_IC | 9)
    expect(lineColorByte(layer, 4, 2)).toBe(4)
  })

  it('the layer-level cc toggle rewrites all 16 lines and is derived back from them', () => {
    const on = setLayerCc(createLayer(16, 5), true)
    expect(on.cc).toBe(true)
    expect(on.lineColors.every((value) => (value & SPRITE_CC) !== 0)).toBe(true)
    expect(setLayerCc(on, false).cc).toBe(false)

    // One line without CC is enough to make the layer not-fully-CC.
    const partial = setLineColorByte(on, 7, 5)
    expect(partial.cc).toBe(false)
  })
})

describe('mode-2 OR-color composite', () => {
  // Hand-computed fixture: two planes, colors 1 (dark blue) and 4 (…),
  // pixel columns 0-3 on plane 0 and columns 2-5 on plane 1 (CC set).
  //   col:      0 1 2 3 4 5 6 7
  //   plane 0:  # # # #
  //   plane 1:      # # # #
  //   result:   1 1 5 5 4 4 . .      (5 = 1 | 4 where they overlap)
  const base = layer8(0b11110000, 1)
  const orLayer = layer8(0b00111100, 4, SPRITE_CC)

  it('ORs the color codes where a CC plane overlaps its group leader', () => {
    const row = [...compositeFrame([base, orLayer], 2, 8).subarray(0, 8)]
    expect(row).toEqual([1, 1, 5, 5, 4, 4, 0, 0])
  })

  it('three planes OR into a fourth colour', () => {
    //   plane 0 (CC=0): color 1, cols 0-7
    //   plane 1 (CC=1): color 2, cols 0-3
    //   plane 2 (CC=1): color 4, cols 2-5
    const layers = [layer8(0xff, 1), layer8(0b11110000, 2, SPRITE_CC), layer8(0b00111100, 4, SPRITE_CC)]
    expect([...compositeFrame(layers, 2, 8).subarray(0, 8)]).toEqual([3, 3, 7, 7, 5, 5, 1, 1])
  })

  it('a CC plane shows its own color where the group leader has no pixel', () => {
    // Same-priority group: the OR of "nothing" and colour 4 is 4.
    expect(compositePixel([base, orLayer], 5, 0, 2, 8)).toBe(4)
  })

  it('a CC=0 plane never blends — the higher-priority plane simply wins', () => {
    const opaque = layer8(0b00111100, 4)
    expect([...compositeFrame([base, opaque], 2, 8).subarray(0, 8)]).toEqual([1, 1, 1, 1, 4, 4, 0, 0])
  })

  it('a lower-priority group is fully hidden where the higher one paints', () => {
    // group 0 = plane 0 + plane 1(CC), group 1 = plane 2 + plane 3(CC)
    const layers = [
      layer8(0b11000000, 1),
      layer8(0b11000000, 2, SPRITE_CC),
      layer8(0b11110000, 8),
      layer8(0b11110000, 4, SPRITE_CC)
    ]
    // cols 0-1: group 0 wins with 1|2 = 3. cols 2-3: group 1 shows 8|4 = 12.
    expect([...compositeFrame(layers, 2, 8).subarray(0, 4)]).toEqual([3, 3, 12, 12])
  })

  it('colour 0 stays transparent even when a plane has a pixel there', () => {
    expect(compositePixel([layer8(0xff, 0)], 0, 0, 2, 8)).toBe(0)
  })

  it('per-line colors make each scanline blend independently', () => {
    let top = layer8(0xff, 1)
    let bottom = layer8(0xff, 2, SPRITE_CC)
    top = { ...top, pattern: [0xff, 0xff, 0, 0, 0, 0, 0, 0] }
    bottom = { ...bottom, pattern: [0xff, 0xff, 0, 0, 0, 0, 0, 0] }
    bottom = setLineColorByte(bottom, 1, SPRITE_CC | 8)
    const composite = compositeFrame([top, bottom], 2, 8)
    expect(composite[0]).toBe(3) // line 0: 1 | 2
    expect(composite[8]).toBe(9) // line 1: 1 | 8
  })

  it('mode 1 ignores CC entirely: highest-priority plane wins', () => {
    const row = [...compositeFrame([base, orLayer], 1, 8).subarray(0, 8)]
    expect(row).toEqual([1, 1, 1, 1, 4, 4, 0, 0])
  })
})

describe('mode conversion', () => {
  it('1 → 2 spreads the plane colour over all 16 lines, keeping patterns', () => {
    const doc = normalizeSprites({
      mode: 1,
      size: 16,
      sprites: [{ name: 'a', layers: [{ pattern: [0xff], color: 6, ec: true }] }]
    })
    const converted = convertSpriteMode(doc, 2)
    const layer = converted.sprites[0].frames[0].layers[0]
    expect(layer.lineColors).toEqual(new Array<number>(16).fill(SPRITE_EC | 6))
    expect(layer.pattern).toEqual(doc.sprites[0].frames[0].layers[0].pattern)
  })

  it('2 → 1 keeps line 0 and the patterns, dropping the rest', () => {
    let layer = createLayer(16, 3)
    layer = setLineColorByte(layer, 0, SPRITE_EC | 3)
    layer = setLineColorByte(layer, 5, 12)
    const doc = normalizeSprites({ mode: 2, size: 16, sprites: [{ name: 'a', layers: [layer] }] })
    const converted = convertSpriteMode(doc, 1)
    expect(converted.sprites[0].frames[0].layers[0].color).toBe(3)
    expect(converted.sprites[0].frames[0].layers[0].ec).toBe(true)
    expect(converted.palette).toBeNull()
  })
})

describe('document normalization', () => {
  it('accepts a sprite written with bare `layers` and lifts it to frame 0', () => {
    const doc = normalizeSprites({ mode: 2, size: 16, sprites: [{ name: 'hero', layers: [createLayer(16, 5)] }] })
    expect(doc.sprites[0].frames).toHaveLength(1)
    expect(doc.sprites[0].frames[0].layers).toHaveLength(1)
  })

  it('round-trips through the on-disk shape (layers mirrors frames[0])', () => {
    const doc = createSpritesDoc(2, 16)
    const written = serializeSprites(doc) as { sprites: { layers: unknown[] }[] }
    expect(written.sprites[0].layers).toEqual(doc.sprites[0].frames[0].layers)
    expect(normalizeSprites(JSON.parse(JSON.stringify(written)))).toEqual(doc)
  })

  it('caps a character at 4 layers', () => {
    const doc = normalizeSprites({
      mode: 2,
      size: 8,
      sprites: [{ name: 'x', layers: new Array(6).fill(createLayer(8)) }]
    })
    expect(doc.sprites[0].frames[0].layers).toHaveLength(4)
    expect(validateSprites(doc)).toEqual([])
  })
})

describe('export bytes', () => {
  it('emits every plane’s pattern and mode-appropriate colours', () => {
    const doc = normalizeSprites({
      mode: 2,
      size: 16,
      sprites: [
        { name: 'a', layers: [createLayer(16), createLayer(16)] },
        { name: 'b', frames: [{ layers: [createLayer(16)] }, { layers: [createLayer(16)] }] }
      ]
    })
    expect(spritePatternBytes(doc)).toHaveLength(4 * 32)
    expect(spriteColorBytes(doc)).toHaveLength(4 * 16)
    expect(spriteColorBytes(convertSpriteMode(doc, 1))).toHaveLength(4)
  })

  it('round-trips a document through export-shaped JSON without losing bytes', () => {
    const doc = createSpritesDoc(2, 16)
    const reloaded = normalizeSprites(JSON.parse(JSON.stringify(serializeSprites(doc))))
    expect(spritePatternBytes(reloaded)).toEqual(spritePatternBytes(doc))
    expect(spriteColorBytes(reloaded)).toEqual(spriteColorBytes(doc))
  })
})
