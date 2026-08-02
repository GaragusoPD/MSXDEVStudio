/**
 * One table describing every MSX screen mode the editors can target. Single
 * source of truth: no editor hard-codes a resolution or a color-per-row rule.
 */

export type ScreenMode = 'sc0' | 'sc1' | 'sc2' | 'sc3' | 'sc4' | 'sc5' | 'sc6' | 'sc7' | 'sc8' | 'sc10' | 'sc12'

/** How color is attached to pixels. */
export type ColorModel =
  /** Two colors per 8×1 pattern row (sc2/sc4). */
  | 'row2'
  /** Two colors per group of 8 tiles (sc1). */
  | 'group2'
  /** Every pixel carries its own index (bitmap modes). */
  | 'perPixel'
  /** Text: one FG/BG pair for the whole screen. */
  | 'screen2'
  /** sc3's 4×4 color blocks — displayed, never authored by these editors. */
  | 'block'

export interface ModeInfo {
  id: ScreenMode
  /** What MSXgl/BASIC calls it (`VDP_MODE_SCREEN5`). */
  label: string
  width: number
  height: number
  /** Colors simultaneously addressable per pixel/attribute. */
  colors: number
  colorModel: ColorModel
  kind: 'text' | 'tile' | 'bitmap'
  /** VDP sprite mode available in this screen mode; 0 = no sprites (sc0). */
  spriteMode: 0 | 1 | 2
  /** Palette source: `fixed` = TMS9918A's 16; `grb333` = 16 programmable entries; `rgb332` = sc8's fixed 256. */
  palette: 'fixed' | 'grb333' | 'rgb332' | 'yjk'
  /** Pixels packed into one byte in VRAM (bitmap modes only). */
  pixelsPerByte: number
  /** True when the mode needs a V9938 or later. */
  msx2: boolean
}

export const MODES: Readonly<Record<ScreenMode, ModeInfo>> = {
  sc0: {
    id: 'sc0', label: 'SCREEN 0 (TEXT 1)', width: 240, height: 192, colors: 2,
    colorModel: 'screen2', kind: 'text', spriteMode: 0, palette: 'fixed', pixelsPerByte: 8, msx2: false
  },
  sc1: {
    id: 'sc1', label: 'SCREEN 1 (GRAPHIC 1)', width: 256, height: 192, colors: 16,
    colorModel: 'group2', kind: 'tile', spriteMode: 1, palette: 'fixed', pixelsPerByte: 8, msx2: false
  },
  sc2: {
    id: 'sc2', label: 'SCREEN 2 (GRAPHIC 2)', width: 256, height: 192, colors: 16,
    colorModel: 'row2', kind: 'tile', spriteMode: 1, palette: 'fixed', pixelsPerByte: 8, msx2: false
  },
  sc3: {
    id: 'sc3', label: 'SCREEN 3 (MULTICOLOR)', width: 64, height: 48, colors: 16,
    colorModel: 'block', kind: 'tile', spriteMode: 1, palette: 'fixed', pixelsPerByte: 2, msx2: false
  },
  sc4: {
    id: 'sc4', label: 'SCREEN 4 (GRAPHIC 3)', width: 256, height: 192, colors: 16,
    colorModel: 'row2', kind: 'tile', spriteMode: 2, palette: 'grb333', pixelsPerByte: 8, msx2: true
  },
  sc5: {
    id: 'sc5', label: 'SCREEN 5 (GRAPHIC 4)', width: 256, height: 212, colors: 16,
    colorModel: 'perPixel', kind: 'bitmap', spriteMode: 2, palette: 'grb333', pixelsPerByte: 2, msx2: true
  },
  sc6: {
    id: 'sc6', label: 'SCREEN 6 (GRAPHIC 5)', width: 512, height: 212, colors: 4,
    colorModel: 'perPixel', kind: 'bitmap', spriteMode: 2, palette: 'grb333', pixelsPerByte: 4, msx2: true
  },
  sc7: {
    id: 'sc7', label: 'SCREEN 7 (GRAPHIC 6)', width: 512, height: 212, colors: 16,
    colorModel: 'perPixel', kind: 'bitmap', spriteMode: 2, palette: 'grb333', pixelsPerByte: 2, msx2: true
  },
  sc8: {
    id: 'sc8', label: 'SCREEN 8 (GRAPHIC 7)', width: 256, height: 212, colors: 256,
    colorModel: 'perPixel', kind: 'bitmap', spriteMode: 2, palette: 'rgb332', pixelsPerByte: 1, msx2: true
  },
  sc10: {
    id: 'sc10', label: 'SCREEN 10 (YJK + YAE)', width: 256, height: 212, colors: 12499,
    colorModel: 'perPixel', kind: 'bitmap', spriteMode: 2, palette: 'yjk', pixelsPerByte: 1, msx2: true
  },
  sc12: {
    id: 'sc12', label: 'SCREEN 12 (YJK)', width: 256, height: 212, colors: 19268,
    colorModel: 'perPixel', kind: 'bitmap', spriteMode: 2, palette: 'yjk', pixelsPerByte: 1, msx2: true
  }
}

/** Modes the tile editor (Spec 08) offers. */
export const TILE_MODES = ['sc1', 'sc2', 'sc4'] as const
export type TileMode = (typeof TILE_MODES)[number]

/** Modes the bitmap-screen editor (Spec 10) offers; 10/12 are import-only. */
export const BITMAP_MODES = ['sc5', 'sc6', 'sc7', 'sc8', 'sc10', 'sc12'] as const
export type BitmapMode = (typeof BITMAP_MODES)[number]

export function modeInfo(mode: ScreenMode): ModeInfo {
  return MODES[mode]
}

export function isTileMode(mode: string): mode is TileMode {
  return (TILE_MODES as readonly string[]).includes(mode)
}

export function isBitmapMode(mode: string): mode is BitmapMode {
  return (BITMAP_MODES as readonly string[]).includes(mode)
}
