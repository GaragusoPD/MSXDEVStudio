import { describe, expect, it } from 'vitest'
import { normalizeMap } from './map'
import { createOwnedMeta } from './meta-owned'
import { normalizeTiles, type TileEntry } from './tile'
import { thumbnailOf } from './thumbnail'

/** Every dot ink 15 when `on`, else paper 4. */
const solid = (on: boolean): TileEntry => ({ pattern: new Array(8).fill(on ? 0xff : 0), color: new Array(8).fill(0xf4) })

describe('thumbnailOf', () => {
  it('a tileset shows its tiles, eight across', () => {
    const doc = normalizeTiles({ mode: 'sc2', count: 10, tiles: Array.from({ length: 10 }, (_, i) => solid(i % 2 === 1)) })
    const thumb = thumbnailOf({ kind: 'tiles', doc })!
    expect([thumb.width, thumb.height]).toEqual([64, 16])
    expect(thumb.indices[8]).toBe(15) // tile 1, solid ink
    expect(thumb.indices[0]).toBe(4) // tile 0, paper
  })

  it('a meta-tile shows its resting pose, its see-through cells empty', () => {
    const doc = { ...createOwnedMeta('sc2', 2, 1), holes: [false, true], frames: [{ tiles: [solid(true), solid(true)], duration: 8 }] }
    const thumb = thumbnailOf({ kind: 'metatiles', doc })!
    expect([thumb.width, thumb.height]).toEqual([16, 8])
    expect(thumb.indices[0]).toBe(15)
    expect(thumb.indices[8]).toBe(0)
  })

  it('a map draws its grid and its live placements from the tile numbers it mirrors', () => {
    const tiles = normalizeTiles({ mode: 'sc2', count: 3, tiles: [solid(false), solid(true), solid(false)] })
    const map = normalizeMap({
      tileset: 'res/t.tiles.json',
      width: 4,
      height: 2,
      layers: [{ name: 'background', data: [2, 2, 2, 2, 2, 2, 2, 2], placements: [{ slot: 0, x: 1, y: 1 }] }],
      metas: [{ path: 'res/m.meta-tiles.json', name: 'g_M', width: 2, height: 1, frames: 1, flags: 0, cells: [1, 0] }]
    })
    const thumb = thumbnailOf({ kind: 'map', doc: map }, tiles)!
    expect([thumb.width, thumb.height]).toEqual([32, 16])
    const at = (cx: number, cy: number): number => thumb.indices[cy * 8 * 32 + cx * 8]
    expect(at(0, 0)).toBe(4) // the grid's tile 2
    expect(at(1, 1)).toBe(15) // the placement's opaque cell
    expect(at(2, 1)).toBe(4) // its see-through cell leaves the grid showing
  })

  it('a map without its tileset, and sound, have no picture', () => {
    expect(thumbnailOf({ kind: 'map', doc: normalizeMap({ width: 2, height: 2 }) })).toBeNull()
    expect(thumbnailOf({ kind: 'sfx', doc: {} as never })).toBeNull()
  })
})
