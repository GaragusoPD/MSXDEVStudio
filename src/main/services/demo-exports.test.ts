/**
 * The additive guard, run against the two demos that ship with the repo.
 *
 * `demo_msx1/content/` and `demo_msx2/content/` are committed, generated files.
 * `emitC` is byte-stable by construction (no dates, no absolute paths) — that is
 * what makes the exporter's mtime skip work at all — so re-rendering every
 * resource from its `res/*.json` must reproduce them exactly.
 *
 * It fails for one of two reasons, and both are worth being told about: an
 * exporter change leaked into output nobody meant to touch, or a deliberate
 * change landed without re-exporting the demos.
 */

import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseResource, renderResourceFiles, sourcePathFor } from '../../shared/msx/resource'

for (const demo of ['demo_msx1', 'demo_msx2']) {
  describe(demo, () => {
    const root = join(process.cwd(), demo)
    for (const file of readdirSync(join(root, 'res')).filter((name) => name.endsWith('.json'))) {
      it(`re-exports res/${file} byte-identically`, () => {
        const rel = `res/${file}`
        const resource = parseResource(rel, readFileSync(join(root, rel), 'utf-8'))
        const block = resource.doc.export
        if (!block) return
        const out = renderResourceFiles(resource, rel, block)
        if (block.format === 'bin') {
          expect(Buffer.from(out.bin!).equals(readFileSync(join(root, block.out)))).toBe(true)
          return
        }
        expect(out.header).toBe(readFileSync(join(root, block.out), 'utf-8'))
        const source = sourcePathFor(block.out)
        if (existsSync(join(root, source))) {
          expect(out.source).toBe(readFileSync(join(root, source), 'utf-8'))
        }
      })
    }
  })
}

describe("demo_msx1's coin spin", () => {
  const root = join(process.cwd(), 'demo_msx1')

  it('copies patterns only, so the HUD coin keeps its top-third colours', () => {
    // InitGame() recolours tile 6's top-third colour entry for the HUD. A colour
    // write mirrors into all three thirds, so the generated step must not make
    // one: every pose shares the coin's colours, and the exporter knows it.
    const source = readFileSync(join(root, 'content/tiles.c'), 'utf-8')
    expect(source).toContain('VDP_LoadPattern_GM2(g_CoinAnim_Patterns + (u16)frame * 8, 1, 6);')
    expect(source).not.toContain('LoadColor')
  })

  it("is attached at the slot the coin cells and the HUD draw, and the C reads the transparent tile by name", () => {
    const tiles = parseResource('res/tiles.tiles.json', readFileSync(join(root, 'res/tiles.tiles.json'), 'utf-8'))
    if (tiles.kind !== 'tiles') throw new Error('not a tileset')
    expect(tiles.doc.animations.map((binding) => [binding.path, binding.slot])).toEqual([['res/coin.anim-tiles.json', 6]])
    const trans = tiles.doc.blocks.find((block) => block.name === 'trans')!
    expect(tiles.doc.flags[trans.tiles[0]] & 0x80).toBe(0x80)
    expect(readFileSync(join(root, 'demo.h'), 'utf-8')).toContain('#define T_TRANS      (g_Tiles_Blocks[G_TILES_TRANS_BASE])')
  })
})
