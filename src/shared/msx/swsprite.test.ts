import { describe, expect, it } from 'vitest'
import { renderResourceFiles, resourceTables, validateResource, type ResourceDoc } from './resource'
import { encodeIndices } from './screen'
import {
  createSwSpritesDoc,
  normalizeSwSprites,
  setSwFramePixels,
  swFrameBytes,
  swSpriteFamily,
  swSpriteLayout,
  swSizeStep
} from './swsprite'

/** A one-sprite sheet whose single frame is filled with `colour`. */
function sheet(mode: string, width: number, height: number, frames = 1, colour = 5): ReturnType<typeof normalizeSwSprites> {
  const doc = normalizeSwSprites({ mode, transparent: 0, sprites: [{ name: 'hero', width, height, frames }] })
  const pixels = new Uint8Array(width * height).fill(colour)
  return setSwFramePixels(doc, 0, 0, pixels)
}

describe('sizes', () => {
  it('snaps to what the blitter can address, per mode', () => {
    // Two blocks share a SCREEN 3 byte; a pattern mode has nothing under a cell;
    // SCREEN 6 packs four dots into one.
    expect(swSizeStep('sc3')).toEqual({ x: 2, y: 1 })
    expect(swSizeStep('sc2')).toEqual({ x: 8, y: 8 })
    expect(swSizeStep('sc6')).toEqual({ x: 4, y: 1 })
    expect(normalizeSwSprites({ mode: 'sc3', sprites: [{ width: 3, height: 5 }] }).sprites[0]).toMatchObject({
      width: 4,
      height: 5
    })
    expect(normalizeSwSprites({ mode: 'sc2', sprites: [{ width: 9, height: 9 }] }).sprites[0]).toMatchObject({
      width: 16,
      height: 16
    })
  })

  it('lets characters in one sheet differ — the reason this is not a tileset', () => {
    const doc = normalizeSwSprites({
      mode: 'sc3',
      sprites: [
        { name: 'hero', width: 4, height: 4 },
        { name: 'bullet', width: 2, height: 2 }
      ]
    })
    expect(doc.sprites.map((s) => s.width)).toEqual([4, 2])
  })
})

describe('transport', () => {
  it('picks one per mode family', () => {
    expect(swSpriteFamily('sc3')).toBe('sc3')
    expect(swSpriteFamily('sc2')).toBe('tiled')
    expect(swSpriteFamily('sc5')).toBe('bitmap')
  })

  it('packs SCREEN 3 frames two blocks to a byte, end to end', () => {
    const doc = sheet('sc3', 4, 4, 2)
    expect(swFrameBytes(doc, doc.sprites[0])).toBe(8)
    const layout = swSpriteLayout(doc)
    expect(layout.bytes.length).toBe(16)
    expect(layout.sheet).toBeUndefined()
    expect(layout.bytes[0]).toBe(0x55)
  })

  it('lays bitmap frames side by side as one image, because that is what HMMC uploads', () => {
    const doc = sheet('sc5', 16, 16, 3)
    const layout = swSpriteLayout(doc)
    expect(layout.sheet).toEqual({ width: 48, height: 16 })
    expect(layout.bytes.length).toBe((48 / 2) * 16)
  })

  it('turns a pattern-mode frame into cells of eight pattern bytes then eight colour bytes', () => {
    const doc = sheet('sc2', 16, 8, 1, 3)
    // Two cells across, one down: 2 x 16 bytes.
    expect(swFrameBytes(doc, doc.sprites[0])).toBe(32)
    const { bytes } = swSpriteLayout(doc)
    // `tileFromPixels` calls a solid fill all-foreground: every pattern bit set,
    // and the colour in the byte's high nibble.
    expect([...bytes.slice(0, 8)].every((b) => b === 0xff)).toBe(true)
    expect(bytes[8] >> 4).toBe(3)
  })
})

describe('export', () => {
  const block = { name: 'g_Hero', format: 'c' as const, out: 'content/hero.h', helpers: true }

  it('states each character`s own size and frame count', () => {
    const doc = normalizeSwSprites({
      mode: 'sc3',
      sprites: [
        { name: 'hero', width: 4, height: 4, frames: 3 },
        { name: 'bullet', width: 2, height: 2, frames: 1 }
      ]
    })
    const text = rendered({ kind: 'swsprites', doc })
    expect(text).toContain('#define G_HERO_HERO_W 4')
    expect(text).toContain('#define G_HERO_HERO_FRAMES 3')
    expect(text).toContain('#define G_HERO_BULLET 1')
    expect(text).toContain('#define G_HERO_BULLET_W 2')
  })

  it('emits the runtime the mode actually has', () => {
    // SCREEN 3: CPU blit into a shadow buffer, no command engine anywhere.
    const sc3 = rendered({ kind: 'swsprites', doc: sheet('sc3', 4, 4) })
    expect(sc3).toContain('void g_Hero_Draw(u8* buf, u8 sprite, u8 frame, u8 x, u8 y);')
    expect(sc3).not.toContain('VDP_Command')

    // Bitmap: upload once, then the VDP blits with transparency.
    const sc5 = rendered({ kind: 'swsprites', doc: sheet('sc5', 16, 16) })
    expect(sc5).toContain('VDP_CommandHMMC')
    expect(sc5).toContain('VDP_OP_TIMP')

    // Pattern modes: there are no pixels, so it borrows characters.
    const sc2 = rendered({ kind: 'swsprites', doc: sheet('sc2', 16, 16) })
    expect(sc2).toContain('VDP_LoadPattern_GM2')
    expect(sc2).toContain('#define G_HERO_FIRST_PATTERN')
    expect(sc2).not.toContain('VDP_Command')
  })

  function rendered(resource: ResourceDoc): string {
    const files = renderResourceFiles(resource, 'res/hero.swsprites.json', block)
    return `${files.header ?? ''}\n${files.source ?? ''}`
  }

  it('carries a palette only where the mode has one', () => {
    expect(resourceTables({ kind: 'swsprites', doc: sheet('sc3', 4, 4) }).some((t) => t.suffix === '_Palette')).toBe(false)
    expect(resourceTables({ kind: 'swsprites', doc: sheet('sc5', 16, 16) }).some((t) => t.suffix === '_Palette')).toBe(true)
  })
})

describe('validation', () => {
  it('rejects a size the blitter cannot address', () => {
    const doc = createSwSpritesDoc('sc3')
    const bad = { ...doc, sprites: [{ ...doc.sprites[0], width: 3 }] }
    expect(validateResource({ kind: 'swsprites', doc: bad }).join(' ')).toContain('multiple of')
  })

  it('warns when a pattern-mode frame breaks the two-colours-per-row rule', () => {
    const doc = normalizeSwSprites({ mode: 'sc2', sprites: [{ name: 'hero', width: 8, height: 8 }] })
    const pixels = new Uint8Array(64)
    for (let x = 0; x < 8; x++) pixels[x] = x // eight colours on row 0
    const problems = validateResource({ kind: 'swsprites', doc: setSwFramePixels(doc, 0, 0, pixels) })
    expect(problems.join(' ')).toContain('two per')
    // The same art is fine in SCREEN 3, which has no attributes at all.
    const sc3 = normalizeSwSprites({ mode: 'sc3', sprites: [{ name: 'hero', width: 8, height: 8 }] })
    expect(validateResource({ kind: 'swsprites', doc: setSwFramePixels(sc3, 0, 0, pixels) })).toEqual([])
  })
})

describe('round trip', () => {
  it('survives serialize and parse', () => {
    const doc = sheet('sc3', 4, 4, 2, 9)
    const again = normalizeSwSprites(JSON.parse(JSON.stringify(doc)))
    expect(again).toEqual(doc)
    expect(encodeIndices(new Uint8Array([9]))).toBeTypeOf('string')
  })
})
