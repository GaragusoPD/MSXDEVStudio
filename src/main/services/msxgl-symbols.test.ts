import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { indexMsxglSymbols, parseHeaderSymbols } from './msxgl-symbols'

/** A real MSXgl checkout, when one is available — the parser's actual input. */
const REAL_MSXGL = '/home/pablo/MSXgl'

/** MSXgl's headers are CRLF; the fixtures below are too, deliberately. */
const crlf = (lines: string[]): string => lines.join('\r\n')

describe('parseHeaderSymbols', () => {
  it('reads a documented function: signature, description, params and machine tag', () => {
    const symbols = parseHeaderSymbols(
      crlf([
        '// Function: VDP_SetPaletteEntry',
        '// Set a given color entry in the palette. [MSX2/2+/TR]',
        '//',
        '// Parameters:',
        '//   index - Index of the palette entry (0-15)',
        '//   color - 16 bits color value',
        '//           Format: [0:5|green:3]',
        'void VDP_SetPaletteEntry(u8 index, u16 color);'
      ]),
      'vdp.h'
    )
    expect(symbols).toEqual([
      {
        name: 'VDP_SetPaletteEntry',
        kind: 'function',
        signature: 'void VDP_SetPaletteEntry(u8 index, u16 color)',
        detail: 'Set a given color entry in the palette. [MSX2/2+/TR]',
        // The indented continuation line folds into the parameter it belongs to.
        params: ['index - Index of the palette entry (0-15)', 'color - 16 bits color value Format: [0:5|green:3]'],
        machines: 'MSX2/2+/TR',
        file: 'vdp.h'
      }
    ])
  })

  it('strips SDCC calling-convention attributes from the signature', () => {
    const [symbol] = parseHeaderSymbols(
      crlf(['// Function: VDP_SetPalette', '// Set a palette.', 'void VDP_SetPalette(const u8* pal) __FASTCALL __PRESERVES(d, e, iyl, iyh);']),
      'vdp.h'
    )
    expect(symbol.signature).toBe('void VDP_SetPalette(const u8* pal)')
  })

  it('finds the declaration past a preprocessor guard', () => {
    const [symbol] = parseHeaderSymbols(
      crlf(['// Function: VDP_SetDefaultPalette', '// Reset the palette.', '#if (VDP_USE_DEFAULT_PALETTE)', 'void VDP_SetDefaultPalette();']),
      'vdp.h'
    )
    expect(symbol.signature).toBe('void VDP_SetDefaultPalette()')
  })

  it('picks up declarations that exist only as comments (the VDP command family)', () => {
    const [symbol] = parseHeaderSymbols(
      crlf(['// inline void VDP_CommandHMMV(u16 dx, u16 dy, u16 nx, u16 ny, u8 col); // High speed move VDP to VRAM.']),
      'vdp.h'
    )
    expect(symbol).toMatchObject({
      name: 'VDP_CommandHMMV',
      kind: 'function',
      signature: 'inline void VDP_CommandHMMV(u16 dx, u16 dy, u16 nx, u16 ny, u8 col)',
      detail: 'High speed move VDP to VRAM.'
    })
  })

  it('indexes enum members, including values that are macro calls containing commas', () => {
    const symbols = parseHeaderSymbols(
      crlf(['enum KEYS', '{', '\tKEY_ESC\t= MAKE_KEY(7, 2),', '\tKEY_F1 = MAKE_KEY(6, 5), // function key', '\tKEY_PLAIN,', '};']),
      'keyboard.h'
    )
    expect(symbols.map((s) => s.name)).toEqual(['KEY_ESC', 'KEY_F1', 'KEY_PLAIN'])
    expect(symbols.every((s) => s.kind === 'constant')).toBe(true)
    expect(symbols[1].detail).toBe('function key')
  })

  it('separates object-like and function-like defines, and skips include guards', () => {
    const symbols = parseHeaderSymbols(
      crlf(['#define COLOR_H', '#define VDP_OP_TIMP 0x08 // 1000', '#define RGB16(r, g, b) (u16)((g) << 8)']),
      'color.h'
    )
    expect(symbols.map((s) => [s.name, s.kind, s.signature])).toEqual([
      ['VDP_OP_TIMP', 'constant', undefined],
      ['RGB16', 'function', 'RGB16(r, g, b)']
    ])
    expect(symbols[0].detail).toBe('1000')
  })

  it('does not treat a stray brace-less enum reference as an enum body', () => {
    const symbols = parseHeaderSymbols(
      crlf(['#define AFTER_ENUM 1', 'enum VDP_MODE', '{', '\tVDP_MODE_TEXT1,', '};', '#define STILL_PARSED 2']),
      'vdp.h'
    )
    expect(symbols.map((s) => s.name)).toEqual(['AFTER_ENUM', 'VDP_MODE_TEXT1', 'STILL_PARSED'])
  })
})

describe.skipIf(!existsSync(REAL_MSXGL))('indexMsxglSymbols against a real checkout', () => {
  it('indexes the documented API with signatures and parameter docs', () => {
    const symbols = indexMsxglSymbols(REAL_MSXGL)
    // Enough breadth that a regression in any one rule shows up here.
    expect(symbols.length).toBeGreaterThan(3000)
    expect(symbols.filter((s) => s.signature).length).toBeGreaterThan(1000)
    expect(symbols.filter((s) => s.params).length).toBeGreaterThan(500)

    const byName = new Map(symbols.map((s) => [s.name, s]))
    // One symbol per parsing rule: doc block, comment-only decl, enum, define.
    expect(byName.get('VDP_LoadPattern_GM2')?.signature).toBe(
      'void VDP_LoadPattern_GM2(const u8* src, u8 count, u8 offset)'
    )
    expect(byName.get('VDP_CommandHMMM')?.params?.length).toBeGreaterThan(0)
    expect(byName.get('KEY_ESC')?.kind).toBe('constant')
    expect(byName.get('RGB16')?.signature).toBe('RGB16(r, g, b)')
    expect(byName.get('VDP_SetPaletteEntry')?.machines).toBe('MSX2/2+/TR')
  })

  it('returns nothing for a path that is not an MSXgl checkout, without throwing', () => {
    expect(indexMsxglSymbols('/nonexistent/msxgl')).toEqual([])
  })
})
