import { describe, expect, it } from 'vitest'
import {
  AYFX_END_NOISE,
  createSfxDoc,
  decodeAyfxBank,
  decodeAyfxStream,
  encodeAyfxBank,
  encodeAyfxStream,
  importAyfx,
  MAX_NOISE,
  MAX_TONE,
  normalizeSfx,
  presetEffect,
  SFX_PRESETS,
  validateSfx,
  type SfxEffect,
  type SfxFrame
} from './sfx'

/**
 * Real ayFX data, verbatim from the MSXgl checkout — the ground truth for
 * byte-identity. Both were produced by AYFX Editor and converted to C tables
 * by MSXbin; these are the same bytes, base64'd.
 *
 *  - `REAL_BANK`  = `projects/samples/content/ayfx/ayfx_bank.h`  (`ayfx_bank.afb`, 19 effects, 1012 B)
 *  - `REAL_AFX`   = `projects/samples/content/ayfx/ayfx_fx017.h` (`ayfx_fx017.afx`, one stream, 171 B)
 */
const REAL_BANK_B64 =
  'EyUAVgCNALYAygDcAGQBmQHDAdQBKAJZAokCugICAy8DYgN1A7QD728BAK4yAa0aAabpAKXdAKUyAYSEpEsBqxoBqawAqFYAoz4A' +
  'o0oAolYAgqE+AKExANAgb5QBGm4aAhjsDwMX68YDEOpABA7pNQUQ6OwFE+fhBhHlZwcM5B8ICeOACAfiBwkC4jgJAKFpCdAg7z8A' +
  'AKqXAKYAAUQfRBHqTAAAp34AZMkAH2QAARHCAIKhLgGhYAGhkgHQIO9lAACvlwCOhYWFhYWFhISEg4KB0CBvqwAH6G4AAKVJAKQw' +
  'AIMhAADQIGlrAAAJCalHAImJqC8AiIioawCIiKdHAIeHpy8Ah4emawCGhqZHAIaGpS8AhYWlawCFhaVHAIWFpS8AhYWkawCEhKRH' +
  'AISEpC8AhISkawCEhKNHAIODoy8Ag4OjawCDg6NHAIODoi8AgoKiawCCgqNHAIODoy8Ag4OhawCBgaFHAIGBoS8AgYHQIG8CAB9O' +
  'FUwUC0oSSRFoAwAPCGcEAA4GJgYAZQoAD2ULABBkDgASYxgAFGIpABkiRQBhZwAc0CDv3wAArJQAq4kAoAAAgICAgKjfAKWUAKSJ' +
  'AKAAAICAgICl3wCilAChiQDQIOwlAACJiIeGhYSEg4OCgoGB0CDvaAEAj68gAa/wAK9oAY+vIAGv8ACvaAGPryABr/AAr2gBj6sg' +
  'AavwAKtoAYunIAGn8ACnaAGHpSABpfAApWgBhaMgAaPwAKNoAYOhIAGh8AChaAHQIO/QAgCPr+ABj61oAY2t8ACNrLQAjKx4AIyn' +
  '0AKHp+ABh6doAYen8ACHp7QAh6d4AIfQIO9aAACOrXgAjKu0AIqpWgCIp3gAgKC0AIenWgCGpngAhaW0AISkWgCDo3gAgqK0ANAg' +
  '72gBAK9AAa0gAaxAAasgAaoOAakgAagOAafwAKYOAaXwAKTYAKTwAKPYAKLAAKKvANAgbzIABu8AAABIAgjsMgAArLwAqAcBqEYB' +
  'ppIBpqsBpDUCpIACpgcBpkYBpJIBpKsBojUCooACpAcBpEYBo5IBo6sBoTUCoYAC0CDvVAAArUQAqzwAqToAg4OjVACGiKdEAKY8' +
  'AKU6AIKColQAg4WkRACjPACiOgDQIG8+ABdOEE0LTRAMayUAEUoPaD4AF0gQRwtGEAVkJQARRA9mPgAXRRBEC0MQAmIlABFBD9Ag' +
  '7zIAAK5LAI2BgYqJqDIAoyUAgtAg7bMAAKu1AKq3AIitdQCtdwCreQCJja1rAIuJja1HAIyLiYeFhYWFqWsAqEcAhoWEg4KCgqdr' +
  'AKVHAISDgoGB0CDsXAIAr1oBjo6OhoiIh4eHh4eHh4aGhILQIA=='

const REAL_AFX_B64 =
  '7n0AH46uPgCOrmMAjq5PAI6uQgCOrjcAjqx9AIysPgCMrGMAjKxPAIysQgCMrDcAjKp9AIqqPgCKqmMAiqpPAIqqQgCKqjcAiqh9' +
  'AIioPgCIqGMAiKhPAIioQgCIqDcAiKZ9AIamPgCGpmMAhqZPAIamQgCGpjcAhqR9AISkPgCEpGMAhKRPAISkQgCEpDcAhKJ9AIKi' +
  'PgCComMAgqJPAIKiQgCCojcAgtAg'

const bytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (char) => char.charCodeAt(0))
const REAL_BANK = bytes(REAL_BANK_B64)
const REAL_AFX = bytes(REAL_AFX_B64)

const frame = (over: Partial<SfxFrame> = {}): SfxFrame => ({
  toneOn: true,
  tone: 0,
  noiseOn: false,
  noise: 0,
  volume: 0,
  ...over
})

describe('ayFX bank format (against real MSXgl data)', () => {
  it('decodes the s_ayfx sample bank', () => {
    expect(REAL_BANK).toHaveLength(1012)
    expect(REAL_BANK[0]).toBe(19)
    const effects = decodeAyfxBank(REAL_BANK)
    expect(effects).toHaveLength(19)
    expect(effects.map((e) => e.frames.length)).toEqual([18, 14, 14, 15, 6, 81, 18, 19, 14, 33, 24, 23, 16, 24, 20, 21, 10, 38, 19])
    for (const effect of effects) {
      for (const f of effect.frames) {
        expect(f.tone).toBeLessThanOrEqual(MAX_TONE)
        expect(f.noise).toBeLessThanOrEqual(MAX_NOISE)
        expect(f.volume).toBeLessThanOrEqual(15)
      }
    }
  })

  it('re-emits the real bank byte-identically', () => {
    expect(encodeAyfxBank(decodeAyfxBank(REAL_BANK))).toEqual(REAL_BANK)
  })

  it('re-emits each real stream byte-identically, and the streams tile the file exactly', () => {
    const count = REAL_BANK[0]
    let expectedStart = 1 + 2 * count
    for (let i = 0; i < count; i++) {
      const increment = REAL_BANK[1 + 2 * i] | (REAL_BANK[2 + 2 * i] << 8)
      const start = 2 + 2 * i + increment
      expect(start).toBe(expectedStart)
      const decoded = decodeAyfxStream(REAL_BANK, start)
      expect(encodeAyfxStream(decoded.frames)).toEqual(REAL_BANK.subarray(start, decoded.end))
      expectedStart = decoded.end
    }
    expect(expectedStart).toBe(REAL_BANK.length)
  })

  it('re-emits a real single-effect .afx byte-identically', () => {
    const decoded = decodeAyfxStream(REAL_AFX)
    expect(decoded.end).toBe(REAL_AFX.length)
    expect(decoded.frames).toHaveLength(84)
    expect(encodeAyfxStream(decoded.frames)).toEqual(REAL_AFX)
  })

  it('reads the first real frame with the player-derived bit layout', () => {
    // fx0's first control byte is 0xEF: noise off, new noise, new tone, tone on, volume 15.
    const first = decodeAyfxBank(REAL_BANK)[0].frames[0]
    expect(first).toEqual({ toneOn: true, tone: 0x016f, noiseOn: false, noise: 0, volume: 15 })
  })
})

describe('ayFX codec', () => {
  it('terminates every stream with the D0 20 sentinel', () => {
    const stream = encodeAyfxStream([frame({ volume: 9 })])
    expect([...stream.subarray(-2)]).toEqual([0xd0, AYFX_END_NOISE])
  })

  it('omits tone/noise bytes while the values are unchanged', () => {
    // Frame 1 latches tone+noise (control | 0x60); frames 2-3 repeat them, so only a control byte each.
    const frames = [frame({ tone: 100, noise: 5, volume: 8 }), frame({ tone: 100, noise: 5, volume: 7 }), frame({ tone: 100, noise: 5, volume: 6 })]
    const stream = encodeAyfxStream(frames)
    expect(stream.length).toBe(1 + 3 + 1 + 1 + 2)
    expect(decodeAyfxStream(stream).frames).toEqual(frames)
  })

  it('round-trips edge frames: all off, max periods, max volume', () => {
    const frames = [
      frame({ toneOn: false, noiseOn: false, volume: 0 }),
      frame({ toneOn: true, tone: MAX_TONE, noiseOn: true, noise: MAX_NOISE, volume: 15 }),
      frame({ toneOn: false, tone: MAX_TONE, noiseOn: true, noise: 0, volume: 1 }),
      frame({ toneOn: true, tone: 0, noiseOn: false, noise: MAX_NOISE, volume: 15 })
    ]
    expect(decodeAyfxStream(encodeAyfxStream(frames)).frames).toEqual(frames)
  })

  it('round-trips an empty effect', () => {
    expect(decodeAyfxStream(encodeAyfxStream([])).frames).toEqual([])
  })

  it('refuses frames whose noise would collide with the end marker', () => {
    expect(() => encodeAyfxStream([frame({ noise: AYFX_END_NOISE, noiseOn: true })])).toThrow(/out of range/)
    expect(() => encodeAyfxStream([frame({ tone: MAX_TONE + 1 })])).toThrow(/out of range/)
  })

  it('round-trips a multi-effect bank and lays the header out as the player expects', () => {
    const effects: SfxEffect[] = [
      { name: 'a', frames: [frame({ tone: 7, volume: 15 })] },
      { name: 'b', frames: [] },
      { name: 'c', frames: [frame({ noiseOn: true, noise: 3, volume: 4 }), frame({ volume: 2 })] }
    ]
    const bank = encodeAyfxBank(effects)
    expect(bank[0]).toBe(3)
    // First increment always points just past the offset table: 1 + 2n - (2 + 0).
    expect(bank[1] | (bank[2] << 8)).toBe(2 * 3 - 1)
    const back = decodeAyfxBank(bank)
    expect(back.map((e) => e.frames)).toEqual(effects.map((e) => e.frames))
  })

  it('writes 0 as the count byte for a full 256-effect bank', () => {
    const effects = Array.from({ length: 256 }, (_, i) => ({ name: `fx${i}`, frames: [frame({ volume: 1 })] }))
    const bank = encodeAyfxBank(effects)
    expect(bank[0]).toBe(0)
    expect(decodeAyfxBank(bank)).toHaveLength(256)
  })

  it('rejects malformed input instead of inventing frames', () => {
    expect(() => decodeAyfxStream(Uint8Array.from([0x2f]))).toThrow(/Truncated/)
    expect(() => decodeAyfxStream(Uint8Array.from([0x4f]))).toThrow(/Truncated/)
    expect(() => decodeAyfxBank(Uint8Array.from([1, 0]))).toThrow(/too short/)
    expect(() => decodeAyfxBank(Uint8Array.from([2, 0xff, 0xff, 0x03, 0x00, 0xd0, 0x20]))).toThrow(/outside the file/)
  })
})

describe('importAyfx', () => {
  it('reads a .afb as a bank and a .afx as one stream', () => {
    expect(importAyfx(REAL_BANK, 'sfx/ayfx_bank.afb')).toHaveLength(19)
    const single = importAyfx(REAL_AFX, 'a/b/ayfx_fx017.afx')
    expect(single).toHaveLength(1)
    expect(single[0].name).toBe('ayfx_fx017')
  })

  it('falls back to the other reading for a mislabelled file', () => {
    expect(importAyfx(REAL_BANK, 'mislabelled.afx')).toHaveLength(19)
  })

  it('clamps garbage so a bad import can never break a later export', () => {
    // A stream whose tone byte pair carries bits above the 12-bit period field.
    const junk = Uint8Array.from([0x2f, 0xff, 0xff, 0xd0, AYFX_END_NOISE])
    const [effect] = importAyfx(junk, 'weird.afx')
    expect(effect.frames[0].tone).toBe(MAX_TONE)
    expect(() => encodeAyfxStream(effect.frames)).not.toThrow()
  })

  it('re-imports the real files unchanged, so an import/export round trip is lossless', () => {
    expect(encodeAyfxBank(importAyfx(REAL_BANK, 'ayfx_bank.afb'))).toEqual(REAL_BANK)
    expect(encodeAyfxStream(importAyfx(REAL_AFX, 'ayfx_fx017.afx')[0].frames)).toEqual(REAL_AFX)
  })
})

describe('sfx document', () => {
  it('creates a usable default document', () => {
    const doc = createSfxDoc()
    expect(doc.rate).toBe(50)
    expect(doc.effects).toHaveLength(1)
    expect(doc.effects[0].frames).toHaveLength(16)
    expect(validateSfx(doc)).toEqual([])
  })

  it('clamps out-of-range values and fills missing fields', () => {
    const doc = normalizeSfx({
      rate: 60,
      effects: [{ name: 'x', frames: [{ tone: 99999, noise: -4, volume: 40, noiseOn: true }, {}] }]
    })
    expect(doc.rate).toBe(60)
    expect(doc.effects[0].frames[0]).toEqual({ toneOn: true, tone: MAX_TONE, noiseOn: true, noise: 0, volume: 15 })
    expect(doc.effects[0].frames[1]).toEqual({ toneOn: true, tone: 0, noiseOn: false, noise: 0, volume: 0 })
  })

  it('survives a round trip through JSON', () => {
    const doc = normalizeSfx({ rate: 60, effects: SFX_PRESETS })
    expect(normalizeSfx(JSON.parse(JSON.stringify(doc)))).toEqual(doc)
  })

  it('flags an empty effect and a both-off audible frame', () => {
    const doc = normalizeSfx({ effects: [{ name: 'a', frames: [frame({ volume: 9, toneOn: false, noiseOn: false })] }] })
    expect(validateSfx(doc).join(' ')).toMatch(/both tone and noise off/)
    const empty = normalizeSfx({ effects: [{ name: '', frames: [] }] })
    empty.effects[0].frames = []
    expect(validateSfx(empty).join(' ')).toMatch(/no name.*no frames|no frames/s)
  })
})

describe('presets', () => {
  it('ships the five the toolbar offers', () => {
    expect(SFX_PRESETS.map((p) => p.name)).toEqual(['laser', 'jump', 'explosion', 'pickup', 'hit'])
  })

  it('are valid, audible, and survive an ayFX round trip', () => {
    const doc = normalizeSfx({ effects: SFX_PRESETS })
    expect(validateSfx(doc)).toEqual([])
    for (const preset of SFX_PRESETS) {
      expect(preset.frames.length).toBeGreaterThan(2)
      // Volume 0 tells the player to skip the frame entirely, so no preset frame is silent.
      expect(preset.frames.every((f) => f.volume > 0)).toBe(true)
      expect(preset.frames.every((f) => f.toneOn || f.noiseOn)).toBe(true)
      expect(decodeAyfxStream(encodeAyfxStream(preset.frames)).frames).toEqual(preset.frames)
    }
  })

  it('sweeps pitch downward for laser and upward for jump', () => {
    const laser = presetEffect('laser').frames
    const jump = presetEffect('jump').frames
    expect(laser[laser.length - 1].tone).toBeGreaterThan(laser[0].tone)
    expect(jump[jump.length - 1].tone).toBeLessThan(jump[0].tone)
    expect(presetEffect('explosion').frames.every((f) => f.noiseOn && !f.toneOn)).toBe(true)
  })

  it('hands out copies, not the shared preset data', () => {
    const a = presetEffect('hit')
    a.frames[0].volume = 1
    expect(SFX_PRESETS.find((p) => p.name === 'hit')!.frames[0].volume).toBe(15)
    expect(() => presetEffect('nope')).toThrow()
  })
})
