/**
 * RLEp — MSXgl's own run-length format, so a compressed table is read back by
 * the engine's `RLEp_UnpackToRAM` (`engine/src/compress.c`) and not by anything
 * reimplemented here. MSXgl also ships Pletter, ZX0, LZ48 and Bitbuster
 * decompressors, but their *compressors* are external tools; RLEp is the one
 * whose packer is a page of code, and it is the right shape for name tables,
 * which are mostly runs of the same tile.
 *
 * Chunk header — `TTCCCCCC`: type in bits 7-6, count-1 in bits 5-0 (1..64).
 *
 * | type | payload  | writes                                   |
 * |------|----------|------------------------------------------|
 * | 0    | —        | `count` copies of the default byte        |
 * | 1    | 1 byte   | `count` copies of it                      |
 * | 2    | 2 bytes  | `count` copies of the *pair* (2×count out)|
 * | 3    | n bytes  | the bytes themselves                      |
 *
 * Two rules fall out of the unpacker and both are load-bearing:
 *
 * 1. `while (*src != 0)` ends the stream, so a header byte of 0x00 is the
 *    terminator — a type-0 chunk is never emitted with count 1.
 * 2. This packs for `COMPRESS_USE_RLEP_DEFAULT TRUE` (what MSXgl's project
 *    template sets, so what every MSXDEVStudio project inherits): the stream
 *    starts with the default byte, which the unpacker consumes. Set that flag
 *    FALSE and every chunk lands one byte early.
 */

const MAX_COUNT = 64

/** Longest run of `data[at]` starting at `at`, capped at `limit`. */
function runLength(data: Uint8Array, at: number, limit = MAX_COUNT): number {
  let length = 1
  while (length < limit && at + length < data.length && data[at + length] === data[at]) length++
  return length
}

/** How many whole `data[at], data[at+1]` pairs repeat from `at`, capped at `limit`. */
function pairRuns(data: Uint8Array, at: number, limit = MAX_COUNT): number {
  if (at + 1 >= data.length) return 0
  let pairs = 1
  while (
    pairs < limit &&
    at + pairs * 2 + 1 < data.length &&
    data[at + pairs * 2] === data[at] &&
    data[at + pairs * 2 + 1] === data[at + 1]
  ) {
    pairs++
  }
  return pairs
}

/** The byte a type-0 chunk stands for: whichever occurs most, so the free chunks cover the most ground. */
export function defaultByte(data: Uint8Array): number {
  const counts = new Map<number, number>()
  for (const value of data) counts.set(value, (counts.get(value) ?? 0) + 1)
  let best = 0
  let bestCount = -1
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value
      bestCount = count
    }
  }
  return best
}

/**
 * Packs `data` into RLEp. Greedy and single-pass: at each position it takes the
 * cheapest chunk that starts there, and anything else joins the literal being
 * accumulated. The thresholds are where a chunk of its own actually pays for
 * its header — a 2-byte run inside a literal costs 2 bytes, as its own type-1
 * chunk it costs 2 plus the header of the literal that has to reopen after it.
 */
export function packRlep(data: Uint8Array): Uint8Array {
  const def = defaultByte(data)
  const out: number[] = [def]
  let literal: number[] = []

  const flushLiteral = (): void => {
    while (literal.length) {
      const take = literal.slice(0, MAX_COUNT)
      out.push(0xc0 | (take.length - 1), ...take)
      literal = literal.slice(take.length)
    }
  }

  let at = 0
  while (at < data.length) {
    const run = runLength(data, at)
    // A run of the default costs one byte and nothing else, so it is worth
    // taking at 2 — but never at 1, where the header would be the terminator.
    if (data[at] === def && run >= 2) {
      flushLiteral()
      out.push(run - 1)
      at += run
      continue
    }
    if (run >= 3) {
      flushLiteral()
      out.push(0x40 | (run - 1), data[at])
      at += run
      continue
    }
    const pairs = pairRuns(data, at)
    if (pairs >= 3) {
      flushLiteral()
      out.push(0x80 | (pairs - 1), data[at], data[at + 1])
      at += pairs * 2
      continue
    }
    literal.push(data[at])
    at++
  }
  flushLiteral()
  out.push(0) // terminator — `RLEp_UnpackToRAM` loops until a zero header
  return Uint8Array.from(out)
}

/**
 * The inverse, mirroring `RLEp_UnpackToRAM` step for step. The editor never
 * needs it; the round-trip test does, and a packer whose output nothing reads
 * back is a packer nobody has checked.
 */
export function unpackRlep(packed: Uint8Array): Uint8Array {
  const out: number[] = []
  let at = 0
  const def = packed[at++] ?? 0
  while (at < packed.length && packed[at] !== 0) {
    const header = packed[at++]
    const type = header >> 6
    const count = (header & 0x3f) + 1
    if (type === 0) {
      for (let i = 0; i < count; i++) out.push(def)
    } else if (type === 1) {
      const value = packed[at++]
      for (let i = 0; i < count; i++) out.push(value)
    } else if (type === 2) {
      const pair = [packed[at], packed[at + 1]]
      at += 2
      for (let i = 0; i < count * 2; i++) out.push(pair[i & 1])
    } else {
      for (let i = 0; i < count; i++) out.push(packed[at + i])
      at += count
    }
  }
  return Uint8Array.from(out)
}
