import { describe, expect, it } from 'vitest'
import { defaultByte, packRlep, unpackRlep } from './compress'

/** A 32×24 screen of mostly-background with a floor and a few scattered tiles. */
function screenLikeMap(): Uint8Array {
  const data = new Uint8Array(32 * 24)
  for (let x = 0; x < 32; x++) {
    data[22 * 32 + x] = 5
    data[23 * 32 + x] = 6
  }
  for (let x = 4; x < 12; x++) data[14 * 32 + x] = 5
  data[10 * 32 + 3] = 9
  data[10 * 32 + 20] = 9
  return data
}

describe('packRlep', () => {
  it('round-trips through the format MSXgl unpacks', () => {
    const cases = [
      new Uint8Array(0),
      Uint8Array.from([7]),
      Uint8Array.from([0, 0]),
      new Uint8Array(200), // one long run of the default
      Uint8Array.from([1, 2, 1, 2, 1, 2, 1, 2, 9]),
      Uint8Array.from({ length: 300 }, (_, i) => i & 0xff), // no runs at all
      screenLikeMap()
    ]
    for (const data of cases) expect(unpackRlep(packRlep(data))).toEqual(data)
  })

  it('round-trips pseudo-random data, where every chunk type shows up', () => {
    // A fixed LCG rather than Math.random, so a failure is reproducible.
    let seed = 12345
    const next = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff)
    const data = Uint8Array.from({ length: 4000 }, () => {
      const roll = next() % 10
      return roll < 5 ? 0 : roll < 8 ? 3 : next() & 0xff
    })
    expect(unpackRlep(packRlep(data))).toEqual(data)
  })

  it('never emits a 0x00 header, which would end the stream early', () => {
    // Zero is fine as *payload* — it is a header of 0x00 that terminates, so
    // this walks the chunks rather than scanning for the byte.
    const headers = (packed: Uint8Array): number[] => {
      const out: number[] = []
      let at = 1 // past the default byte
      while (at < packed.length && packed[at] !== 0) {
        const header = packed[at]
        out.push(header)
        const type = header >> 6
        const count = (header & 0x3f) + 1
        at += 1 + (type === 0 ? 0 : type === 1 ? 1 : type === 2 ? 2 : count)
      }
      expect(at).toBe(packed.length - 1) // the walk ended on the terminator, not short of it
      return out
    }
    // A lone default byte between others is the case that tempts a type-0 count of 1.
    expect(headers(packRlep(Uint8Array.from([1, 0, 2, 0, 0, 3])))).not.toContain(0)
    expect(headers(packRlep(new Uint8Array(1)))).not.toContain(0)
    expect(headers(packRlep(screenLikeMap()))).not.toContain(0)
  })

  it('picks the commonest byte as the default, so type-0 chunks cover the most ground', () => {
    expect(defaultByte(Uint8Array.from([4, 4, 4, 1, 2]))).toBe(4)
    // A screen of one tile plus a floor: under 1 byte per 20 cells.
    const packed = packRlep(screenLikeMap())
    expect(packed.length).toBeLessThan(screenLikeMap().length / 20)
  })

  it('stays bounded on data that cannot compress', () => {
    const noise = Uint8Array.from({ length: 256 }, (_, i) => i)
    // Worst case is one header per 64 literal bytes, plus default and terminator.
    expect(packRlep(noise).length).toBe(256 + 4 + 2)
  })
})
