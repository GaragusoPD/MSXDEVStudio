/**
 * Where a sheet import lands: new files written whole, existing ones changed
 * through their editors as one undo step. The conversion rules are tested in
 * `shared/msx/sheet-convert.test.ts`; this is whether the result reaches the
 * file, the session and the tab — and refuses before writing anything.
 */

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeMap } from '../../../shared/msx/map'
import { createOwnedMeta, normalizeOwnedMeta } from '../../../shared/msx/meta-owned'
import { MSX1_PALETTE_GRB, MSX1_PALETTE_RGB } from '../../../shared/msx/palette'
import { parseResource, serializeResource } from '../../../shared/msx/resource'
import type { SheetCell } from '../../../shared/msx/sheet-convert'
import { createSpritesDoc, normalizeSprites } from '../../../shared/msx/sprite'
import { createTileAnimDoc } from '../../../shared/msx/tile-anim'
import { normalizeTiles, type TileEntry } from '../../../shared/msx/tile'
import { useTabsStore } from '../stores/tabsStore'
import { resetExternalWatches } from './external-changes'
import { animSession, pruneAnimSessions } from './anim/session'
import { mapSession, pruneMapSessions } from './map/session'
import { applySheetImport, describeTarget, type SheetImport } from './sheet-import'
import { pruneSpriteSessions, spriteSession } from './sprite/session'
import { pruneTileSessions, tileSession } from './tile/session'
import { bitmapTileSession, pruneBitmapTileSessions } from './btiles/session'
import { metaSession, pruneMetaSessions } from './meta/session'
import { pruneScreenSessions, screenSession } from './screen/session'
import { pruneSwSpriteSessions, swSpriteSession } from './swsprites/session'
import { createBitmapTilesDoc, normalizeBitmapTiles, tileImage } from '../../../shared/msx/bitmap-tile'
import { createMetaTileDoc } from '../../../shared/msx/meta-tile'
import { blankConverted, createScreenDoc, encodeIndices } from '../../../shared/msx/screen'
import { createSwSpritesDoc, swFramePixels, type SwSpritesDoc } from '../../../shared/msx/swsprite'
import { useTilesetStore } from '../stores/tilesetStore'

let files: Record<string, string>

function cell(width: number, height: number, at: (x: number, y: number) => number): SheetCell {
  const indices = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) indices[y * width + x] = at(x, y)
  return { width, height, indices }
}

/** A 16×16 cell: a vertical bar of `color`, `x0` dots in, on transparency. */
const bar = (color: number, x0 = 4): SheetCell => cell(16, 16, (x) => (x >= x0 && x < x0 + 4 ? color : 0))

function request(over: Partial<SheetImport>): SheetImport {
  const cells = over.cells ?? [bar(15), bar(6, 8)]
  return {
    destination: 'tiles',
    target: null,
    name: 'hero',
    mode: 'sc2',
    bitmapMode: 'sc5',
    tileset: null,
    sprite: { mode: 2, size: 16 },
    cells,
    at: cells.map((_, i) => ({ col: i, row: 0 })),
    groups: [cells.map((_, i) => i)],
    palette: null,
    rgb: [...MSX1_PALETTE_RGB],
    blocks: true,
    withMap: false,
    duration: 6,
    maxPlanes: 3,
    ...over
  }
}

const read = <T>(path: string): T => parseResource(path, files[path]).doc as T

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  resetExternalWatches()
  setActivePinia(createPinia())
  files = {}
  ;(globalThis as { window?: unknown }).window = {
    confirm: vi.fn(() => true),
    api: {
      on: vi.fn(),
      invoke: vi.fn(async (channel: string, args: { path: string; content?: string }) => {
        if (channel === 'fs:read') {
          if (!(args.path in files)) throw new Error(`ENOENT ${args.path}`)
          return files[args.path]
        }
        if (channel === 'fs:write') {
          files[args.path] = args.content ?? ''
          return undefined
        }
        if (channel === 'fs:stat') return args.path in files ? { kind: 'file' } : null
        if (channel === 'fs:create') return undefined
        if (channel === 'resources:list') return []
        if (channel === 'resources:msximgHelp') return ''
        throw new Error(`unexpected channel ${channel}`)
      })
    }
  }
  for (const prune of [
    pruneTileSessions,
    pruneMapSessions,
    pruneAnimSessions,
    pruneSpriteSessions,
    pruneBitmapTileSessions,
    pruneMetaSessions,
    pruneScreenSessions,
    pruneSwSpriteSessions
  ]) {
    prune(new Set())
  }
})

describe('a new tileset', () => {
  it('is written with a block per cell, a map laying them out, and opened', async () => {
    const outcome = await applySheetImport(request({ withMap: true, at: [{ col: 0, row: 0 }, { col: 1, row: 1 }] }))
    expect(outcome.failed).toBeUndefined()
    const tiles = read<ReturnType<typeof normalizeTiles>>('res/hero.tiles.json')
    expect(tiles.reserveTile0).toBe(true)
    expect(tiles.blocks.map((block) => [block.name, block.width, block.height])).toEqual([
      ['hero_0', 2, 2],
      ['hero_1', 2, 2]
    ])
    const map = read<ReturnType<typeof normalizeMap>>('res/hero.map.json')
    expect([map.width, map.height, map.tileset]).toEqual([4, 4, 'res/hero.tiles.json'])
    // The second cell sits at sheet (1,1): its tiles are the map's bottom-right quarter.
    expect(map.layers[0].data[2 * 4 + 2]).toBe(tiles.blocks[1].tiles[0])
    expect(map.layers[0].data[0 * 4 + 2]).toBe(0)
    expect(useTabsStore().tabs.map((tab) => tab.id)).toEqual(expect.arrayContaining(['res/hero.tiles.json', 'res/hero.map.json']))
    expect(outcome.status).toMatch(/Created hero\.tiles\.json and hero\.map\.json — 2 cells:/)
  })

  it('refuses to overwrite a file, and writes nothing', async () => {
    files['res/hero.map.json'] = '{}'
    const outcome = await applySheetImport(request({ withMap: true }))
    expect(outcome.failed).toBe(true)
    expect(outcome.status).toMatch(/hero\.map\.json already exists/)
    expect(files['res/hero.tiles.json']).toBeUndefined()
  })
})

describe('an existing tileset', () => {
  it('takes the tiles as one undo step in its open editor, blocks numbered after its own', async () => {
    files['res/main.tiles.json'] = serializeResource({ kind: 'tiles', doc: normalizeTiles({ mode: 'sc2', count: 1, reserveTile0: true }) })
    const outcome = await applySheetImport(request({ target: 'res/main.tiles.json' }))
    expect(outcome.status).toMatch(/is open, unsaved/)
    const session = tileSession('res/main.tiles.json')
    expect(session.dirty).toBe(true)
    expect(session.doc.blocks.map((block) => block.name)).toEqual(['hero_0', 'hero_1'])
    // Not written: the editor holds it until saved.
    expect(read<ReturnType<typeof normalizeTiles>>('res/main.tiles.json').blocks).toEqual([])
  })

  it('says what it needs for converting: its mode, and an sc4 palette', async () => {
    const palette = Array.from({ length: 16 }, (_, i) => i * 3)
    files['res/s4.tiles.json'] = serializeResource({ kind: 'tiles', doc: normalizeTiles({ mode: 'sc4', count: 1, palette }) })
    expect(await describeTarget('tiles', 'res/s4.tiles.json')).toMatchObject({ mode: 'sc4', palette })
  })
})

describe('a map', () => {
  it('gets the cells floating over it, in its tileset’s mode, to drop where they go', async () => {
    files['res/main.tiles.json'] = serializeResource({ kind: 'tiles', doc: normalizeTiles({ mode: 'sc2', count: 1, reserveTile0: true }) })
    files['res/level.map.json'] = serializeResource({ kind: 'map', doc: normalizeMap({ tileset: 'res/main.tiles.json', width: 32, height: 24 }) })
    expect(await describeTarget('map', 'res/level.map.json')).toMatchObject({ mode: 'sc2' })
    const outcome = await applySheetImport(request({ destination: 'map', target: 'res/level.map.json' }))
    expect(outcome.failed).toBeUndefined()
    const session = mapSession('res/level.map.json')
    expect(session.float?.kind).toBe('picture')
  })

  it('refuses a map with no tileset to put tiles in', async () => {
    files['res/empty.map.json'] = serializeResource({ kind: 'map', doc: normalizeMap({ tileset: '' }) })
    expect((await describeTarget('map', 'res/empty.map.json')).error).toMatch(/pattern tileset/)
  })
})

describe('animated tiles and meta-tiles', () => {
  it('one per row makes one file per row, numbered', async () => {
    const cells = [bar(15), bar(15, 8), bar(6), bar(6, 8)]
    const outcome = await applySheetImport(
      request({ destination: 'anim', cells, groups: [[0, 1], [2, 3]], at: cells.map((_, i) => ({ col: i % 2, row: i >> 1 })) })
    )
    expect(outcome.status).toMatch(/Created 2 animated tiles: hero_1\.anim-tiles\.json, hero_2\.anim-tiles\.json/)
    const anim = read<{ width: number; frames: unknown[]; export: { name: string } }>('res/hero_2.anim-tiles.json')
    expect([anim.width, anim.frames.length, anim.export.name]).toEqual([2, 2, 'g_Hero2Anim'])
  })

  it('an untouched meta-tile is replaced, keeping its flags', async () => {
    files['res/rock.meta-tiles.json'] = serializeResource({ kind: 'metatiles', doc: { ...createOwnedMeta('sc2', 2, 2), flags: 5 } })
    const outcome = await applySheetImport(request({ destination: 'meta', target: 'res/rock.meta-tiles.json' }))
    expect(outcome.failed).toBeUndefined()
    const session = animSession('res/rock.meta-tiles.json')
    const meta = session.history.present as ReturnType<typeof createOwnedMeta>
    expect(meta.frames).toHaveLength(2)
    expect(meta.flags).toBe(5)
    // Both bars leave the right half empty in the first pose, but the second
    // reaches x=8-11: no tile is empty in both, top-right included.
    expect(meta.holes).toEqual([false, false, false, false])
  })

  it('a drawn meta-tile gets the poses added, and a tile stays see-through only if the new poses leave it empty', async () => {
    const pose = (mark: number): TileEntry => ({ pattern: new Array(8).fill(mark), color: new Array(8).fill(0xf1) })
    files['res/rock.meta-tiles.json'] = serializeResource({
      kind: 'metatiles',
      doc: normalizeOwnedMeta({ version: 3, mode: 'sc2', width: 2, height: 2, holes: [false, true, false, true], frames: [{ tiles: [pose(0x81), pose(0), pose(0x81), pose(0)] }] })
    })
    // Bars at x=4..7: the right column of tiles stays empty in the new poses too.
    await applySheetImport(request({ destination: 'meta', target: 'res/rock.meta-tiles.json', cells: [bar(15), bar(6)] }))
    const meta = animSession('res/rock.meta-tiles.json').history.present as ReturnType<typeof createOwnedMeta>
    expect(meta.frames).toHaveLength(3)
    expect(meta.holes).toEqual([false, true, false, true])
  })

  it('refuses poses of another size than the file’s', async () => {
    files['res/coin.anim-tiles.json'] = serializeResource({ kind: 'anim', doc: createTileAnimDoc('sc2', 2, 2) })
    expect(await describeTarget('anim', 'res/coin.anim-tiles.json')).toMatchObject({ size: { width: 2, height: 2 } })
    const outcome = await applySheetImport(request({ destination: 'anim', target: 'res/coin.anim-tiles.json', cells: [cell(8, 8, () => 15)] }))
    expect(outcome.failed).toBe(true)
    expect(outcome.status).toMatch(/2×2 tiles and the cells are 1×1/)
  })
})

describe('sprites', () => {
  it('a new MSX2 sheet keeps the conversion’s palette', async () => {
    const palette = Array.from({ length: 16 }, (_, i) => i * 5)
    const outcome = await applySheetImport(request({ destination: 'sprites', palette }))
    expect(outcome.status).toMatch(/Created hero\.sprites\.json — 1 character, 2 frames\./)
    const sheet = read<ReturnType<typeof normalizeSprites>>('res/hero.sprites.json')
    expect(sheet.palette).toEqual(palette)
    expect(sheet.sprites.map((sprite) => sprite.name)).toEqual(['hero'])
  })

  it('an existing sheet keeps its sprites and gets a new name for a clash, as one undo step', async () => {
    const drawn = createSpritesDoc(1, 16)
    drawn.sprites[0].name = 'hero'
    drawn.sprites[0].frames[0].layers[0].pattern[0] = 0xff
    files['res/cast.sprites.json'] = serializeResource({ kind: 'sprites', doc: drawn })
    expect(await describeTarget('sprites', 'res/cast.sprites.json')).toMatchObject({ sprite: { mode: 1, size: 16 } })
    await applySheetImport(request({ destination: 'sprites', target: 'res/cast.sprites.json' }))
    const session = spriteSession('res/cast.sprites.json')
    expect(session.history.present.sprites.map((sprite) => sprite.name)).toEqual(['hero', 'hero_2'])
    expect(session.dirty).toBe(true)
    await settle()
  })

  it('says when a character crosses more sprites on a line than the VDP shows', async () => {
    // 64 dots wide, four colours side by side in every 16-dot column: 4 sprites × 4 planes on a line.
    const wide = cell(64, 16, (x) => [2, 4, 6, 8][x % 4])
    const outcome = await applySheetImport(request({ destination: 'sprites', cells: [wide], maxPlanes: 4, sprite: { mode: 1, size: 16 } }))
    expect(outcome.status).toMatch(/Up to 16 sprites share a line — the VDP shows 4/)
  })
})

describe('MSX2: a bitmap tileset', () => {
  /** An 8-colour palette's worth of entries: 0-7 drawn with, 8-15 free. */
  const PALETTE = Array.from({ length: 16 }, (_, i) => i * 0x11)

  it('a new one takes the cell as its tile size, reserves tile 0, and gets a bitmap map beside it', async () => {
    const outcome = await applySheetImport(request({ destination: 'btiles', bitmapMode: 'sc5', palette: PALETTE, withMap: true }))
    expect(outcome.status).toMatch(/Created hero\.btiles\.json and hero\.map\.json/)
    const tiles = read<ReturnType<typeof normalizeBitmapTiles>>('res/hero.btiles.json')
    expect([tiles.mode, tiles.width, tiles.height, tiles.count, tiles.reserveTile0, tiles.transparent]).toEqual(['sc5', 16, 16, 3, true, 0])
    expect(tiles.palette).toEqual(PALETTE)
    expect(tiles.blocks.map((block) => block.tiles)).toEqual([[1], [2]])
    const map = read<ReturnType<typeof normalizeMap>>('res/hero.map.json')
    expect(map.cell).toMatchObject({ width: 16, height: 16, cols: 16 })
    expect(map.layers[0].data).toEqual([1, 2])
  })

  it('an existing one cuts each cell into its own tile size and takes the new colours in free entries only', async () => {
    const pixels = new Uint8Array(8 * 8 * 2).fill(3)
    files['res/bank.btiles.json'] = serializeResource({
      kind: 'btiles',
      doc: normalizeBitmapTiles({ ...createBitmapTilesDoc('sc5', 8, 8, 2), palette: PALETTE, pixels: encodeIndices(pixels) })
    })
    expect(await describeTarget('btiles', 'res/bank.btiles.json')).toMatchObject({ mode: 'sc5', tileSize: { width: 8, height: 8 } })
    expect((await describeTarget('btiles', 'res/bank.btiles.json')).freeEntries).toEqual([1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
    // The conversion refilled entry 9; entry 3, which the tiles use, is untouched.
    const refilled = PALETTE.map((entry, i) => (i === 9 ? 0x777 : entry))
    const outcome = await applySheetImport(request({ destination: 'btiles', target: 'res/bank.btiles.json', palette: refilled, cells: [cell(16, 16, (x) => (x < 8 ? 9 : 3))] }))
    expect(outcome.status).toMatch(/1 new tile, 3 reused/)
    const session = bitmapTileSession('res/bank.btiles.json')
    const doc = session.history.present
    expect(doc.palette).toEqual(refilled)
    expect(doc.blocks.map((block) => [block.width, block.height, block.tiles])).toEqual([[2, 2, [2, 0, 2, 0]]])
    expect([...tileImage(doc, 2)].every((value) => value === 9)).toBe(true)
    expect(session.dirty).toBe(true)
  })

  it('a new one converted to the MSX1 colours says what they are, rather than sixteen blacks', async () => {
    await applySheetImport(request({ destination: 'btiles', bitmapMode: 'sc5', palette: null }))
    expect(read<ReturnType<typeof normalizeBitmapTiles>>('res/hero.btiles.json').palette).toEqual([...MSX1_PALETTE_GRB])
    await applySheetImport(request({ destination: 'swsprites', bitmapMode: 'sc7', palette: null }))
    expect(read<SwSpritesDoc>('res/hero.swsprites.json').palette).toEqual([...MSX1_PALETTE_GRB])
  })

  it('refuses cells that are not a whole number of its tiles', async () => {
    files['res/bank.btiles.json'] = serializeResource({ kind: 'btiles', doc: createBitmapTilesDoc('sc5', 16, 16, 1) })
    const outcome = await applySheetImport(request({ destination: 'btiles', target: 'res/bank.btiles.json', cells: [cell(24, 16, () => 1)] }))
    expect(outcome.failed).toBe(true)
    expect(outcome.status).toMatch(/whole number of tiles/)
  })
})

describe('MSX2: a bitmap meta-tile', () => {
  const tileset = () =>
    serializeResource({ kind: 'btiles', doc: normalizeBitmapTiles({ ...createBitmapTilesDoc('sc5', 8, 8, 1), reserveTile0: true }) })

  it('a new one is drawn with the tileset picked, which gains its tiles and is saved', async () => {
    files['res/bank.btiles.json'] = tileset()
    const outcome = await applySheetImport(
      request({ destination: 'metab', tileset: 'res/bank.btiles.json', cells: [bar(15), bar(6, 8)], groups: [[0, 1]] })
    )
    expect(outcome.status).toMatch(/Created hero\.meta-btiles\.json — \d+ new tiles? in bank\.btiles\.json\./)
    const meta = read<ReturnType<typeof createMetaTileDoc>>('res/hero.meta-btiles.json')
    expect([meta.tileset, meta.width, meta.height, meta.frames.length]).toEqual(['res/bank.btiles.json', 2, 2, 2])
    const saved = read<ReturnType<typeof normalizeBitmapTiles>>('res/bank.btiles.json')
    // Every tile a frame names exists in the saved tileset.
    for (const frame of meta.frames) for (const tile of frame.tiles) expect(tile).toBeLessThan(saved.count)
    expect(useTilesetStore().isDirty('res/bank.btiles.json')).toBe(false)
  })

  it('an existing one gets frames added, and its tileset the tiles, unsaved together', async () => {
    files['res/bank.btiles.json'] = tileset()
    files['res/rock.meta-btiles.json'] = serializeResource({
      kind: 'metabtiles',
      doc: { ...createMetaTileDoc('res/bank.btiles.json', 2, 2), frames: [{ tiles: [0, 0, 0, 0] }, { tiles: [0, 0, 0, 0] }] }
    })
    expect(await describeTarget('metab', 'res/rock.meta-btiles.json')).toMatchObject({ tileset: 'res/bank.btiles.json', size: { width: 2, height: 2 } })
    const outcome = await applySheetImport(request({ destination: 'metab', target: 'res/rock.meta-btiles.json' }))
    expect(outcome.failed).toBeUndefined()
    const session = metaSession('res/rock.meta-btiles.json')
    expect(session.history.present.frames).toHaveLength(4)
    expect(useTilesetStore().isDirty('res/bank.btiles.json')).toBe(true)
  })

  it('refuses frames of another size than the meta\u2019s', async () => {
    files['res/bank.btiles.json'] = tileset()
    files['res/rock.meta-btiles.json'] = serializeResource({ kind: 'metabtiles', doc: createMetaTileDoc('res/bank.btiles.json', 3, 3) })
    const outcome = await applySheetImport(request({ destination: 'metab', target: 'res/rock.meta-btiles.json' }))
    expect(outcome.status).toMatch(/3×3 tiles and the cells are 2×2/)
  })
})

describe('MSX2: software sprites', () => {
  it('a new sheet in the chosen mode, a character per row, frames padded to the mode\u2019s bytes', async () => {
    const cells = [cell(10, 8, () => 4), cell(10, 8, () => 5), cell(10, 8, () => 6)]
    const outcome = await applySheetImport(
      request({ destination: 'swsprites', bitmapMode: 'sc6', cells, groups: [[0, 1], [2]], at: cells.map((_, i) => ({ col: i, row: 0 })) })
    )
    expect(outcome.status).toMatch(/Created hero\.swsprites\.json — 2 characters, 3 frames of 12×8\./)
    const sheet = read<SwSpritesDoc>('res/hero.swsprites.json')
    expect(sheet.mode).toBe('sc6')
    expect(sheet.sprites.map((sprite) => [sprite.name, sprite.frames])).toEqual([
      ['hero_1', 2],
      ['hero_2', 1]
    ])
  })

  it('an existing sheet\u2019s blank character is replaced, and its own transparent index used', async () => {
    files['res/cast.swsprites.json'] = serializeResource({ kind: 'swsprites', doc: { ...createSwSpritesDoc('sc5'), transparent: 15 } })
    await applySheetImport(request({ destination: 'swsprites', target: 'res/cast.swsprites.json', cells: [cell(2, 1, (x) => (x ? 7 : 0))] }))
    const doc = swSpriteSession('res/cast.swsprites.json').history.present
    expect(doc.sprites.map((sprite) => sprite.name)).toEqual(['hero'])
    expect([...swFramePixels(doc, 0, 0)]).toEqual([15, 7])
  })
})

describe('MSX2: a screen', () => {
  it('gets the cells floating over it, see-through where the sheet was', async () => {
    files['res/title.screen.json'] = serializeResource({ kind: 'screen', doc: { ...createScreenDoc('sc5'), converted: blankConverted('sc5') } })
    expect(await describeTarget('screen', 'res/title.screen.json')).toMatchObject({ mode: 'sc5' })
    const outcome = await applySheetImport(request({ destination: 'screen', target: 'res/title.screen.json', palette: null }))
    expect(outcome.failed).toBeUndefined()
    const session = screenSession('res/title.screen.json')
    expect(session.float).not.toBeNull()
    expect(session.float?.transparent).toBe(0)
  })
})
