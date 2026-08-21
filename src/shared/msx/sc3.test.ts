import { describe, expect, it } from 'vitest'
import {
  SC3_COLS,
  SC3_NT_ADDR,
  SC3_PAGE_ADDR,
  SC3_ROWS,
  SC3_STRIPS,
  SC3_VRAM_BYTES,
  sc3Constants,
  sc3NameTable,
  sc3Offset,
  sc3Pack,
  sc3PatternBytes,
  sc3ScreenHelperC,
  sc3Strip,
  sc3TileBytes,
  sc3TileHelperC
} from './sc3'

/**
 * What the VDP actually does in MULTICOLOR, spelled out: the cell's name times
 * eight, plus a two-byte slice chosen by the screen row, plus the block row
 * inside the cell. `sc3Offset` is the closed form of exactly this, and the first
 * test is that the two agree everywhere — everything else in the mode rests on it.
 */
function offsetViaNameTable(x: number, y: number): number {
  const cx = x >> 1
  const cy = y >> 1
  const name = (cy >> 2) * 32 + cx
  return name * 8 + (cy & 3) * 2 + (y & 1)
}

describe('sc3Offset', () => {
  it('agrees with the name-table derivation for every block', () => {
    for (let y = 0; y < SC3_ROWS; y++) {
      for (let x = 0; x < SC3_COLS; x++) {
        expect(sc3Offset(x, y)).toBe(offsetViaNameTable(x, y))
      }
    }
  })

  it('maps the 3072 blocks onto 1536 bytes with no gaps and no collisions', () => {
    const slots = new Set<number>()
    let max = 0
    for (let y = 0; y < SC3_ROWS; y++) {
      for (let x = 0; x < SC3_COLS; x++) {
        const at = sc3Offset(x, y)
        // Two blocks share a byte; the nibble is what makes the slot unique.
        slots.add(at * 2 + (x & 1))
        max = Math.max(max, at)
      }
    }
    expect(slots.size).toBe(SC3_COLS * SC3_ROWS)
    expect(max).toBe(SC3_VRAM_BYTES - 1)
  })

  it('puts eight consecutive bytes in one column strip', () => {
    // The whole dirty-upload design depends on this: one VDP_WriteVRAM of 8
    // contiguous bytes covers an 8×32-dot column.
    for (let y = 0; y < 8; y++) expect(sc3Offset(2, y)).toBe(sc3Offset(2, 0) + y)
    expect(sc3Offset(0, 0)).toBe(0)
    expect(sc3Offset(1, 0)).toBe(0)
    expect(sc3Offset(2, 0)).toBe(8)
  })
})

describe('sc3Strip', () => {
  it('numbers the 192 strips and points at each one`s first byte', () => {
    const seen = new Set<number>()
    for (let y = 0; y < SC3_ROWS; y++) {
      for (let x = 0; x < SC3_COLS; x++) {
        const strip = sc3Strip(x, y)
        seen.add(strip)
        expect(strip * 8).toBe(sc3Offset(x, y & ~7))
        expect(sc3Offset(x, y) - strip * 8).toBe(y & 7)
      }
    }
    expect(seen.size).toBe(SC3_STRIPS)
    expect(SC3_STRIPS).toBe(192)
  })
})

describe('sc3NameTable', () => {
  it('repeats each group of 32 names over four screen rows', () => {
    const nt = sc3NameTable()
    expect(nt.length).toBe(768)
    for (let row = 0; row < 4; row++) expect([...nt.subarray(row * 32, row * 32 + 32)]).toEqual([...Array(32).keys()])
    expect(nt[4 * 32]).toBe(32)
    expect(nt[4 * 32 + 31]).toBe(63)
    // Six groups of four rows; the last name used is 191, so the pattern table
    // ends at 1535 and never reaches the name table at 0x0800.
    expect(nt[23 * 32 + 31]).toBe(191)
    expect(Math.max(...nt) * 8 + 7).toBe(SC3_VRAM_BYTES - 1)
  })
})

describe('VRAM layout', () => {
  it('keeps both pattern pages clear of the name, sprite attribute and sprite pattern tables', () => {
    const busy = [
      [SC3_NT_ADDR, SC3_NT_ADDR + 768],
      [0x1b00, 0x1b80], // VDP_MC_ADDR_SAT
      [0x3800, 0x4000] // VDP_MC_ADDR_SPT
    ]
    for (const page of SC3_PAGE_ADDR) {
      for (const [from, to] of busy) {
        expect(page + SC3_VRAM_BYTES <= from || page >= to).toBe(true)
      }
    }
    // And the pages do not overlap each other.
    expect(SC3_PAGE_ADDR[0] + SC3_VRAM_BYTES).toBeLessThanOrEqual(SC3_PAGE_ADDR[1])
  })
})

describe('sc3Pack', () => {
  it('puts the left block in the high nibble', () => {
    const indices = new Uint8Array(SC3_COLS * SC3_ROWS)
    indices[0] = 0x0a // block (0,0) — left
    indices[1] = 0x03 // block (1,0) — right, same byte
    const bytes = sc3Pack(indices, SC3_COLS, SC3_ROWS)
    expect(bytes.length).toBe(SC3_VRAM_BYTES)
    expect(bytes[0]).toBe(0xa3)
  })

  it('writes each block to its own address', () => {
    const indices = new Uint8Array(SC3_COLS * SC3_ROWS)
    // (4, 9): odd row inside the second strip row, so neither term is zero.
    indices[9 * SC3_COLS + 4] = 0x0f
    const bytes = sc3Pack(indices, SC3_COLS, SC3_ROWS)
    expect(bytes[sc3Offset(4, 9)]).toBe(0xf0)
    expect(bytes.reduce((n, b) => n + (b ? 1 : 0), 0)).toBe(1)
  })

  it('ignores blocks outside the mode rather than throwing', () => {
    const bytes = sc3Pack(new Uint8Array(100 * 100).fill(7), 100, 100)
    expect(bytes.length).toBe(SC3_VRAM_BYTES)
    expect(bytes.every((b) => b === 0x77)).toBe(true)
  })
})

describe('sc3PatternBytes', () => {
  it('repeats the tile`s two bytes four times, so it draws the same at every row', () => {
    // One 2×2 tile: top row 1,2 and bottom row 3,4.
    const bytes = sc3PatternBytes(Uint8Array.from([1, 2, 3, 4]), 1)
    expect([...bytes]).toEqual([0x12, 0x34, 0x12, 0x34, 0x12, 0x34, 0x12, 0x34])
  })

  it('emits eight bytes per tile', () => {
    expect(sc3PatternBytes(new Uint8Array(4 * 16), 16).length).toBe(128)
  })
})

describe('sc3TileBytes', () => {
  it('packs each tile on its own at ceil(width / 2) bytes per row', () => {
    // Two 4×2 tiles, filled with their own index so the boundary is visible.
    const pixels = new Uint8Array(2 * 4 * 2)
    pixels.fill(1, 0, 8)
    pixels.fill(2, 8, 16)
    const bytes = sc3TileBytes(pixels, 2, 4, 2)
    expect(bytes.length).toBe(2 * 2 * 2)
    expect([...bytes]).toEqual([0x11, 0x11, 0x11, 0x11, 0x22, 0x22, 0x22, 0x22])
  })
})

describe('emitted C', () => {
  it('declares the geometry the helpers read, and page 1 only when double buffered', () => {
    expect(sc3Constants('g_Play', false)).toContain('#define G_PLAY_SIZE 1536')
    expect(sc3Constants('g_Play', false)).toContain('#define G_PLAY_STRIPS 192')
    expect(sc3Constants('g_Play', false).join('\n')).not.toContain('PAGE1')
    expect(sc3Constants('g_Play', true)).toContain('#define G_PLAY_PAGE1 0x1000')
  })

  it('calls MSXgl rather than reimplementing VRAM access', () => {
    const { source } = sc3ScreenHelperC('g_Play', 'g_Play', false, false)
    const text = source.join('\n')
    expect(text).toContain('VDP_SetMode(VDP_MODE_MULTICOLOR);')
    expect(text).toContain('VDP_WriteVRAM(')
    // No page flip, no interrupt wait and no second page when single buffered.
    expect(text).not.toContain('VDP_SetPatternTable')
    expect(text).not.toContain('Halt();')
    expect(text).not.toContain('PAGE1')
  })

  it('flips a register instead of copying a page when double buffered', () => {
    const { header, source } = sc3ScreenHelperC('g_Play', 'g_Play', true, false)
    const text = source.join('\n')
    expect(header.join('\n')).toContain('void g_Play_Flip(void);')
    expect(text).toContain('VDP_SetPatternTable(g_Play_Back ? G_PLAY_PAGE1 : G_PLAY_PAGE0);')
    expect(text).toContain('g_Play_Back ^= 1;')
    // Halt() hangs forever if nothing ever interrupts.
    expect(text).toContain('VDP_EnableVBlank(TRUE);')
    expect(text).toContain('Halt();')
  })

  it('offers the pattern-table upload only for 2×2 tiles, which is what a name entry holds', () => {
    expect(sc3TileHelperC('g_Tiles', 2, 2, 8, null).header.join('\n')).toContain('void g_Tiles_Upload(void);')
    expect(sc3TileHelperC('g_Tiles', 4, 4, 8, null).header.join('\n')).not.toContain('_Upload(void);')
  })

  it('masks against the tileset`s transparent colour, and degrades to the plain blit without one', () => {
    const masked = sc3TileHelperC('g_Hero', 4, 4, 8, 1).source.join('\n')
    expect(masked).toContain('if(v == 0x11)')
    expect(masked).toContain('if((v >> 4) == 1)')
    const plain = sc3TileHelperC('g_Hero', 4, 4, 8, null).source.join('\n')
    expect(plain).toContain('g_Hero_DrawTile(buf, tile, x, y);')
  })
})
