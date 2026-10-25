/**
 * One clipboard of *pixels* for the editors that draw pattern-mode art — the
 * map, the tile editor and the meta-tile/animation pose editor — so art
 * copied in one lands in another: a map drawn with another tileset, or a
 * meta-tile, which owns its pixels and no tile numbers.
 *
 * Each editor keeps its own clipboard as well, of what it copies natively
 * (a map's tile numbers, the tile editor's entries and flags). A paste takes
 * the native one only when the latest copy was made in that same file
 * (`from`); otherwise it takes these pixels, converted as an imported picture
 * is. The latest copy anywhere wins, which is what a user expects of Ctrl+V.
 */

import { shallowRef } from 'vue'
import type { Rgb } from '../../../shared/msx/palette'
import type { TileMode } from '../../../shared/msx/modes'

export interface PictureClip {
  /** Palette indices, row-major; 0 is transparent. Whole tiles: width and height are multiples of 8. */
  picture: { width: number; height: number; indices: Uint8Array }
  /** The colours to show it in while it floats. */
  rgb: Rgb[]
  mode: TileMode
  /** The file it was copied from. */
  from: string
}

export const pictureClipboard = shallowRef<PictureClip | null>(null)

/** Whether the latest copy came from somewhere other than `path` — a paste there takes the pixels. */
export function pixelsFromElsewhere(path: string): PictureClip | null {
  const clip = pictureClipboard.value
  return clip && clip.from !== path ? clip : null
}
