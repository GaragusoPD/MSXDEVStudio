// The one palette every asset in this demo shares.
//
// SCREEN 5 has a single 16-entry palette, and on MSX2 that palette colors the
// sprites too — a mode-2 sprite's per-line color byte is an index into it. So
// the canyon, the mist, the ship and the boss cannot each pick their own
// sixteen: there is one set, chosen here, and every generated PNG is drawn with
// exactly these RGB values. The screen editor is then told to *lock* this
// palette rather than optimize one out of the image, so a pixel drawn in
// colour 9 arrives in VRAM as index 9.
//
// Entries are GRB333 — three bits each, the V9938's 512-colour space — written
// as [r, g, b] here and packed on the way out.

/** [r, g, b], each 0–7. Index 0 is never drawn opaque: it is the transparent one. */
export const PALETTE = [
  [0, 0, 0], //  0 transparent — the backdrop shows through, and software sprites blit over it
  [1, 0, 1], //  1 near-black — outlines, pits
  [2, 1, 3], //  2 dark violet — canyon wall shadow
  [3, 2, 4], //  3 violet — canyon wall
  [5, 4, 6], //  4 pale violet — canyon wall lit edge
  [2, 1, 0], //  5 dark rust — canyon floor shadow
  [4, 2, 0], //  6 rust — canyon floor
  [7, 5, 2], //  7 sand — canyon floor lit
  [7, 2, 0], //  8 vein, coolest ─┐ these three are rotated every few frames,
  [7, 5, 0], //  9 vein, warmer   │ which is a whole layer of animation for
  [7, 7, 3], // 10 vein, hottest ─┘ three palette writes and no VRAM at all
  [2, 4, 5], // 11 mist — the near parallax layer
  [5, 7, 7], // 12 pale cyan — mist highlight, HUD
  [1, 6, 2], // 13 alien green — flora, pickups
  [7, 0, 1], // 14 crimson — enemies, danger
  [7, 7, 7] // 15 white — text, stars, the ship's canopy
]

/** The three entries `CyclePalette()` rotates in the game — see main.c. */
export const VEIN_CYCLE = [8, 9, 10]

/** 3-bit component → 8-bit, the same rounding the app and openMSX use. */
const expand = (value) => Math.round((value * 255) / 7)

/** The palette as RGB, for drawing PNGs the quantizer will map back 1:1. */
export const RGB = PALETTE.map(([r, g, b]) => [expand(r), expand(g), expand(b)])

/** Packed GRB333, the form `.screen.json` and the V9938 both want. */
export const GRB = PALETTE.map(([r, g, b]) => ((g & 7) << 8) | ((r & 7) << 4) | (b & 7))
