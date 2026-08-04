import { describe, expect, it } from 'vitest'
import { unpackRlep } from './compress'
import { defineName, emitBin, emitCHeader } from './emitC'
import { createMapDoc, normalizeMap } from './map'
import { packGrb } from './palette'
import {
  RESOURCE_SUFFIXES,
  defaultExport,
  defaultTableName,
  parseResource,
  renderResource,
  resourceBaseName,
  resourceKindOf,
  resourceTables,
  serializeResource,
  validateResource,
  type ResourceDoc
} from './resource'
import { encodeIndices, normalizeScreen, packBitmap, palettePairBytes, screenPixels } from './screen'
import { decodeAyfxBank, normalizeSfx, SFX_PRESETS, type SfxDoc } from './sfx'
import { createSpritesDoc } from './sprite'
import { addLayer, setCharacterGrid } from '../sprite-editor'
import { createBlock } from '../tile-editor'
import { createTilesDoc, mergeColorByte, normalizeTiles } from './tile'

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

/** A small, fully specified tileset so the emitted bytes are predictable. */
function fixtureTiles(): ResourceDoc {
  return {
    kind: 'tiles',
    doc: normalizeTiles({
      mode: 'sc2',
      count: 2,
      tiles: [
        { pattern: [0x00, 0x7e, 0x81, 0xa5, 0x81, 0xbd, 0x42, 0x3c], color: new Array(8).fill(mergeColorByte(15, 1)) },
        { pattern: [0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00], color: new Array(8).fill(mergeColorByte(6, 4)) }
      ]
    })
  }
}

describe('emitCHeader', () => {
  it('is byte-stable across runs — no dates, no absolute paths', () => {
    const options = {
      name: 'g_Fixture',
      tables: resourceTables(fixtureTiles()),
      notes: ['Source: art/fixture.tiles.json'],
      defines: true
    }
    const first = emitCHeader(options)
    const second = emitCHeader({ ...options, tables: resourceTables(fixtureTiles()) })
    expect(second).toBe(first)
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}/)
    expect(first).not.toMatch(/\/home\/|[A-Z]:\\/)
  })

  it('writes MSXgl-style tables with per-byte art and a size comment', () => {
    const text = emitCHeader({
      name: 'g_Test',
      tables: [{ suffix: '_Patterns', bytes: Uint8Array.from([0x7e, 0x00]), art: true }]
    })
    expect(text).toContain('const unsigned char g_Test_Patterns[] =')
    expect(text).toContain('\t0x7E, /* .######. */')
    expect(text).toContain('\t0x00, /* ........ */')
    expect(text).toContain('// g_Test_Patterns size: 2 Bytes')
    expect(text.endsWith('\n')).toBe(true)
  })

  it('emits size defines when asked', () => {
    const text = emitCHeader({
      name: 'g_Test',
      tables: [{ suffix: '', bytes: new Uint8Array(4) }],
      defines: true
    })
    expect(text).toContain('#define G_TEST_SIZE 4')
    expect(defineName('g_My-Tiles')).toBe('G_MY_TILES')
  })

  it('wraps plain tables at 16 bytes per line', () => {
    const text = emitCHeader({ name: 'g_T', tables: [{ suffix: '', bytes: new Uint8Array(20) }] })
    const body = text.split('\n').filter((line) => line.startsWith('\t'))
    expect(body).toHaveLength(2)
    expect(body[0].split(',').filter(Boolean)).toHaveLength(16)
  })

  it('totals multi-table headers', () => {
    const text = emitCHeader({
      name: 'g_T',
      tables: [
        { suffix: '_A', bytes: new Uint8Array(3) },
        { suffix: '_B', bytes: new Uint8Array(5) }
      ]
    })
    expect(text).toContain('// Total size: 8 Bytes')
  })
})

describe('emitBin', () => {
  it('concatenates the tables in order', () => {
    const bytes = emitBin([
      { suffix: '', bytes: Uint8Array.from([1, 2]) },
      { suffix: '', bytes: Uint8Array.from([3]) }
    ])
    expect([...bytes]).toEqual([1, 2, 3])
  })
})

describe('file naming', () => {
  it('recognises every resource suffix', () => {
    expect(resourceKindOf('art/hero.tiles.json')).toBe('tiles')
    expect(resourceKindOf('hero.sprites.json')).toBe('sprites')
    expect(resourceKindOf('levels/l1.map.json')).toBe('map')
    expect(resourceKindOf('title.screen.json')).toBe('screen')
    expect(resourceKindOf('audio/blips.sfx.json')).toBe('sfx')
    expect(resourceKindOf('main.c')).toBeNull()
    expect(resourceKindOf('notes.json')).toBeNull()
  })

  it('derives table names and default export blocks', () => {
    expect(resourceBaseName('art/city_bg.tiles.json')).toBe('city_bg')
    expect(defaultTableName('city_bg')).toBe('g_CityBg')
    // The kind is part of the default name, so a tileset and a map of the same
    // subject cannot both land on `g_CityBg` in `content/city_bg.h`.
    expect(defaultExport('art/city_bg.tiles.json')).toEqual({
      name: 'g_CityBgTiles',
      format: 'c',
      out: 'content/city_bg_tiles.h'
    })
  })
})

describe('tiles resource', () => {
  it('emits patterns then colors, sized by the mode', () => {
    const tables = resourceTables(fixtureTiles())
    expect(tables.map((table) => table.suffix)).toEqual(['_Patterns', '_Colors'])
    expect(tables[0].bytes).toHaveLength(16)
    expect(tables[1].bytes).toHaveLength(16)
    expect([...tables[0].bytes.subarray(0, 8)]).toEqual([0x00, 0x7e, 0x81, 0xa5, 0x81, 0xbd, 0x42, 0x3c])
  })

  it('emits one color byte per group for sc1', () => {
    const tables = resourceTables({ kind: 'tiles', doc: createTilesDoc('sc1', 16) })
    expect(tables[0].bytes).toHaveLength(128)
    expect(tables[1].bytes).toHaveLength(2)
  })

  it('appends a palette table on sc4', () => {
    const doc = createTilesDoc('sc4', 1)
    doc.palette = new Array(16).fill(packGrb(7, 0, 0))
    const tables = resourceTables({ kind: 'tiles', doc })
    expect(tables.map((table) => table.suffix)).toEqual(['_Patterns', '_Colors', '_Palette'])
    expect(tables[2].bytes).toHaveLength(32)
    expect([...tables[2].bytes.subarray(0, 2)]).toEqual([0x70, 0x00]) // [0RRR0BBB][00000GGG]
  })

  it('appends a flags table only once a tile carries a bit', () => {
    const doc = createTilesDoc('sc2', 4)
    expect(resourceTables({ kind: 'tiles', doc }).map((t) => t.suffix)).toEqual(['_Patterns', '_Colors'])

    doc.flags[2] = 0b0000_0101
    const tables = resourceTables({ kind: 'tiles', doc })
    expect(tables.map((t) => t.suffix)).toEqual(['_Patterns', '_Colors', '_Flags'])
    // One byte per tile, so the game can index it straight with a tile id.
    expect([...tables[2].bytes]).toEqual([0, 0, 0b101, 0])
  })

  it('emits a blocks table with per-block offsets, and the stamper on request', () => {
    const doc = createBlock(createTilesDoc('sc2', 2), 'door', 2, 3)
    const resource: ResourceDoc = { kind: 'tiles', doc }
    const tables = resourceTables(resource)
    expect(tables.map((t) => t.suffix)).toEqual(['_Patterns', '_Colors', '_Blocks'])
    expect([...tables[2].bytes]).toEqual([2, 3, 4, 5, 6, 7]) // row-major tile ids

    const block = defaultExport('scenery.tiles.json')
    const plain = decode(renderResource(resource, 'scenery.tiles.json', block))
    expect(plain).toContain('#define G_SCENERYTILES_DOOR_BASE 0')
    expect(plain).toContain('#define G_SCENERYTILES_DOOR_W 2')
    expect(plain).toContain('#define G_SCENERYTILES_DOOR_H 3')
    expect(plain).not.toContain('DrawBlock')

    const withCode = decode(renderResource(resource, 'scenery.tiles.json', { ...block, helpers: true }))
    expect(withCode).toContain('static void g_SceneryTiles_DrawBlock(u8 x, u8 y, u16 base, u8 w, u8 h)')
    expect(withCode).toContain('VDP_WriteLayout_GM2(g_SceneryTiles_Blocks + base, x, y, w, h);')
  })

  it('round-trips through JSON', () => {
    const resource = fixtureTiles()
    const reparsed = parseResource('x.tiles.json', serializeResource(resource))
    expect(reparsed).toEqual(resource)
    expect(validateResource(reparsed)).toEqual([])
  })

  it('renders a C header naming its source, not an absolute path', () => {
    const text = decode(renderResource(fixtureTiles(), 'art/fixture.tiles.json', defaultExport('art/fixture.tiles.json')))
    expect(text).toContain('//  - Source: art/fixture.tiles.json')
    expect(text).toContain('//  - Mode: SCREEN 2 (GRAPHIC 2)')
    expect(text).toContain('const unsigned char g_FixtureTiles_Patterns[] =')
  })

  it('renders bin as the raw concatenation', () => {
    const bytes = renderResource(fixtureTiles(), 'x.tiles.json', { name: 'g_X', format: 'bin', out: 'content/x.bin' })
    expect(bytes).toHaveLength(32)
    expect(bytes[1]).toBe(0x7e)
  })
})

/** One 2×2 metasprite of 16×16 sprites — four planes, one per cell. */
function metaResource(): ResourceDoc {
  return { kind: 'sprites', doc: setCharacterGrid(createSpritesDoc(2, 16), 0, 2, 2) }
}

describe('sprites resource', () => {
  it('emits patterns and 16-byte line colors in mode 2', () => {
    const tables = resourceTables({ kind: 'sprites', doc: createSpritesDoc(2, 16) })
    expect(tables.map((table) => table.suffix)).toEqual(['_Patterns', '_Colors'])
    expect(tables[0].bytes).toHaveLength(32)
    expect(tables[1].bytes).toHaveLength(16)
  })

  it('round-trips through the on-disk shape', () => {
    const resource: ResourceDoc = { kind: 'sprites', doc: createSpritesDoc(2, 16) }
    expect(parseResource('x.sprites.json', serializeResource(resource))).toEqual(resource)
  })

  it('adds a layout table only once a character takes several hardware sprites', () => {
    const plain = { kind: 'sprites', doc: createSpritesDoc(2, 16) } as ResourceDoc
    expect(resourceTables(plain).map((t) => t.suffix)).toEqual(['_Patterns', '_Colors'])

    // Superposition: planes stacked on one cell also need placing from one x/y.
    const stacked = { kind: 'sprites', doc: addLayer(createSpritesDoc(1, 16), 0) } as ResourceDoc
    const stackedTables = resourceTables(stacked)
    expect(stackedTables.map((t) => t.suffix)).toEqual(['_Patterns', '_Colors', '_Layout'])
    expect([...stackedTables[2].bytes]).toEqual([0, 0, 0, 0])

    const tables = resourceTables(metaResource())
    expect(tables.map((t) => t.suffix)).toEqual(['_Patterns', '_Colors', '_Layout'])
    // 2×2 grid of 16×16 sprites: one plane per cell, dx/dy in dots.
    expect([...tables[2].bytes]).toEqual([0, 0, 16, 0, 0, 16, 16, 16])
  })

  it('emits per-character offsets so one character can be addressed out of a sheet', () => {
    const text = decode(renderResource(metaResource(), 'hero.sprites.json', defaultExport('hero.sprites.json')))
    expect(text).toContain('#define G_HEROSPRITES_SPRITE_0_BASE 0')
    expect(text).toContain('#define G_HEROSPRITES_SPRITE_0_PLANES 4')
    expect(text).toContain('#define G_HEROSPRITES_SPRITE_0_FRAMES 1')
  })

  it('appends the placement helper only when the export opts in', () => {
    const block = defaultExport('hero.sprites.json')
    expect(decode(renderResource(metaResource(), 'hero.sprites.json', block))).not.toContain('g_HeroSprites_SetMeta')

    const text = decode(renderResource(metaResource(), 'hero.sprites.json', { ...block, helpers: true }))
    expect(text).toContain('static void g_HeroSprites_SetMeta(u8 index, u8 x, u8 y, u8 base, u8 planes)')
    // Mode 2 drives the per-line color table; 16×16 patterns step by 4.
    expect(text).toContain('VDP_SetSpriteExMultiColor(index + i, px, py, plane * 4, g_HeroSprites_Colors + ((u16)plane * 16));')
  })

  it('uses the mode-1 setter and 8×8 pattern step when that is what the sheet is', () => {
    const doc = setCharacterGrid(createSpritesDoc(1, 8), 0, 2, 1)
    const text = decode(
      renderResource({ kind: 'sprites', doc }, 'hero.sprites.json', { ...defaultExport('hero.sprites.json'), helpers: true })
    )
    expect(text).toContain('VDP_SetSpriteSM1(index + i, px, py, plane * 1, g_HeroSprites_Colors[plane]);')
  })
})

describe('map resource', () => {
  it('emits one table per layer, named after the layer', () => {
    const doc = normalizeMap({
      tileset: './main.tiles.json',
      width: 4,
      height: 2,
      layers: [
        { name: 'background', data: [1, 2, 3, 4, 5, 6, 7, 8] },
        { name: 'foreground', data: [0, 1, 0, 1, 0, 1, 0, 1] }
      ]
    })
    const tables = resourceTables({ kind: 'map', doc })
    expect(tables.map((table) => table.suffix)).toEqual(['_Background', '_Foreground'])
    expect([...tables[0].bytes]).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(tables[1].comment).toContain('Names layer')
  })

  it('defaults to a single background layer of the right size', () => {
    const doc = createMapDoc('./main.tiles.json')
    expect(doc.layers).toHaveLength(1)
    expect(doc.layers[0].data).toHaveLength(32 * 24)
    expect(validateResource({ kind: 'map', doc })).toEqual([])
  })

  it('packs the layers when the export asks for it, and says what it unpacks to', () => {
    const doc = createMapDoc('./main.tiles.json')
    doc.layers[0].data.fill(3)
    const [table] = resourceTables({ kind: 'map', doc }, 'rlep')
    expect(table.unpacked).toBe(32 * 24)
    expect(table.bytes.length).toBeLessThan(40)
    expect([...unpackRlep(table.bytes)]).toEqual(doc.layers[0].data)

    const header = new TextDecoder().decode(
      renderResource({ kind: 'map', doc }, 'art/level.map.json', {
        name: 'g_Level',
        format: 'c',
        out: 'content/level.h',
        helpers: true,
        compress: 'rlep'
      })
    )
    expect(header).toContain('#define G_LEVEL_BACKGROUND_UNPACKED_SIZE 768')
    expect(header).toContain('RLEp_UnpackToRAM(layer, buffer)')
  })

  it('ships the layer raw when packing it would make it bigger, helper included', () => {
    // 8 cells of alternating noise: every chunk costs more than the byte it saves.
    const doc = normalizeMap({
      tileset: './main.tiles.json',
      width: 4,
      height: 2,
      layers: [{ name: 'background', data: [1, 2, 3, 4, 5, 6, 7, 8] }]
    })
    const [table] = resourceTables({ kind: 'map', doc }, 'rlep')
    expect(table.unpacked).toBeUndefined()
    expect([...table.bytes]).toEqual([1, 2, 3, 4, 5, 6, 7, 8])

    const header = new TextDecoder().decode(
      renderResource({ kind: 'map', doc }, 'art/level.map.json', {
        name: 'g_Level',
        format: 'c',
        out: 'content/level.h',
        helpers: true,
        compress: 'rlep'
      })
    )
    // The helper has to agree with the table it sits next to, or it unpacks raw bytes.
    expect(header).not.toContain('RLEp_UnpackToRAM')
    expect(header).toContain('VDP_WriteLayout_GM2(layer, x, y, G_LEVEL_W, G_LEVEL_H)')
  })
})

describe('screen resource', () => {
  const indices = Uint8Array.from({ length: 16 }, (_, i) => i % 16)
  const doc = normalizeScreen({
    mode: 'sc5',
    source: './title.png',
    converted: { width: 4, height: 4, palette: new Array(16).fill(packGrb(1, 2, 3)), indices: encodeIndices(indices) }
  })

  it('packs sc5 at two pixels per byte, high nibble first', () => {
    const tables = resourceTables({ kind: 'screen', doc })
    expect(tables.map((table) => table.suffix)).toEqual(['_Palette', '_Data'])
    expect(tables[1].bytes).toHaveLength(8)
    expect(tables[1].bytes[0]).toBe(0x01)
    expect(tables[1].bytes[1]).toBe(0x23)
  })

  it('packs sc6 at four pixels per byte and sc8 at one', () => {
    expect([...packBitmap(Uint8Array.from([3, 2, 1, 0]), 4, 1, 'sc6')]).toEqual([0xe4])
    expect([...packBitmap(Uint8Array.from([200, 5]), 2, 1, 'sc8')]).toEqual([200, 5])
  })

  it('applies retouch pixels on top of the cached conversion', () => {
    const retouched = { ...doc, retouch: [0, 0, 9] }
    expect(screenPixels(retouched)?.indices[0]).toBe(9)
    expect(screenPixels(doc)?.indices[0]).toBe(0)
  })

  it('refuses to export before the editor has cached a conversion', () => {
    const bare = normalizeScreen({ mode: 'sc5', source: './title.png' })
    expect(() => resourceTables({ kind: 'screen', doc: bare })).toThrow(/no converted image cached/)
  })

  it('writes palette entries as the V9938 register pair (screen)', () => {
    expect([...palettePairBytes([packGrb(1, 2, 3)])]).toEqual([0x13, 0x02])
  })

  it('packs a picture into bands small enough to unpack on an MSX', () => {
    // A full SCREEN 5 of one colour: 27 136 bytes raw, which no 32K-ROM
    // program could unpack in one piece.
    const flat = normalizeScreen({
      mode: 'sc5',
      source: './title.png',
      converted: {
        width: 256,
        height: 212,
        palette: new Array(16).fill(packGrb(1, 2, 3)),
        indices: encodeIndices(new Uint8Array(256 * 212).fill(4))
      }
    })
    const tables = resourceTables({ kind: 'screen', doc: flat }, 'rlep')
    expect(tables.map((table) => table.suffix)).toEqual(['_Palette', '_Data', '_Bands'])

    const data = tables[1]
    const offsets = tables[2].bytes
    expect(data.unpacked).toBe(256 * 212 / 2)
    expect(data.bytes.length).toBeLessThan(1000)
    expect(offsets).toHaveLength(14 * 2) // 212 lines in bands of 16

    // Every band unpacks to its own slice of the raw bitmap, in order.
    const rebuilt: number[] = []
    for (let band = 0; band < offsets.length / 2; band++) {
      const at = offsets[band * 2] + (offsets[band * 2 + 1] << 8)
      rebuilt.push(...unpackRlep(data.bytes.subarray(at)))
    }
    expect(rebuilt).toEqual([...packBitmap(new Uint8Array(256 * 212).fill(4), 256, 212, 'sc5')])

    const header = new TextDecoder().decode(
      renderResource({ kind: 'screen', doc: flat }, 'art/title.screen.json', {
        name: 'g_Title',
        format: 'c',
        out: 'content/title.h',
        helpers: true,
        compress: 'rlep'
      })
    )
    expect(header).toContain('#define G_TITLE_BANDS 14')
    expect(header).toContain('#define G_TITLE_BAND_ROWS 16')
    expect(header).toContain('#define G_TITLE_BAND_BYTES 2048')
    expect(header).toContain('#define G_TITLE_STRIDE 128')
    expect(header).toContain('RLEp_UnpackToRAM(src, buffer)')
  })

  it('leaves a picture that will not shrink alone, and says so', () => {
    // 4×4 of 16 distinct indices: nothing repeats, and the band table would
    // cost more than the packing saves.
    const tables = resourceTables({ kind: 'screen', doc }, 'rlep')
    expect(tables.map((table) => table.suffix)).toEqual(['_Palette', '_Data'])
    expect(tables[1].unpacked).toBeUndefined()

    const header = new TextDecoder().decode(
      renderResource({ kind: 'screen', doc }, 'art/title.screen.json', {
        name: 'g_Title',
        format: 'c',
        out: 'content/title.h',
        helpers: true,
        compress: 'rlep'
      })
    )
    expect(header).toContain('packing gained nothing here')
    expect(header).not.toContain('RLEp_UnpackToRAM')
  })
})

describe('sfx resource', () => {
  const sfxDoc = (): SfxDoc =>
    normalizeSfx({
      rate: 50,
      effects: [
        { name: 'zap', frames: [{ toneOn: true, tone: 0x123, volume: 15 }] },
        { name: 'boom', frames: [{ toneOn: false, noiseOn: true, noise: 4, volume: 12 }] }
      ]
    })
  const fixtureSfx = (): ResourceDoc => ({ kind: 'sfx', doc: sfxDoc() })

  it('emits one table: the raw ayFX bank the player takes a pointer to', () => {
    const [table, ...rest] = resourceTables(fixtureSfx())
    expect(rest).toHaveLength(0)
    expect(table.suffix).toBe('')
    expect(table.comment).toContain('zap, boom')
    expect([...table.bytes]).toEqual([
      0x02, // two effects
      0x03, 0x00, // increment for #0: stream at 5, entry high byte at 2
      0x07, 0x00, // increment for #1: stream at 11, entry high byte at 4
      0xef, 0x23, 0x01, 0x00, // noise off + new noise + new tone + tone on, volume 15; tone 0x0123; noise 0
      0xd0, 0x20, // end marker
      0x7c, 0x00, 0x00, 0x04, // tone off + noise on, volume 12; each stream latches tone and noise afresh
      0xd0, 0x20
    ])
    expect(decodeAyfxBank(table.bytes).map((effect) => effect.frames)).toEqual(sfxDoc().effects.map((e) => e.frames))
  })

  it('re-parses an exported bank back into the in-memory model', () => {
    const doc = normalizeSfx({ effects: SFX_PRESETS })
    const bank = renderResource({ kind: 'sfx', doc }, 'audio/fx.sfx.json', {
      name: 'g_FxSfx',
      format: 'bin',
      out: 'content/fx.afb'
    })
    expect(decodeAyfxBank(bank).map((effect) => effect.frames)).toEqual(doc.effects.map((effect) => effect.frames))
  })

  it('renders a C header naming the ayFX module to enable', () => {
    const text = decode(renderResource(fixtureSfx(), 'audio/fx.sfx.json', defaultExport('audio/fx.sfx.json')))
    expect(text).toContain('//  - Source: audio/fx.sfx.json')
    expect(text).toContain('ayfx/ayfx_player')
    expect(text).toContain('//  - Effects: 0=zap, 1=boom')
    expect(text).toContain('//  - Replay rate: 50 Hz')
    expect(text).toContain('const unsigned char g_FxSfx[] =')
  })

  it('parses, serializes and validates through the resource family', () => {
    const parsed = parseResource('audio/fx.sfx.json', serializeResource(fixtureSfx()))
    expect(parsed).toEqual(fixtureSfx())
    expect(validateResource(parsed)).toEqual([])
    expect(defaultExport('audio/fx.sfx.json')).toEqual({ name: 'g_FxSfx', format: 'c', out: 'content/fx_sfx.h' })
    // A stem that already names the kind is left alone, rather than doubled.
    expect(defaultExport('tiles.tiles.json')).toEqual({ name: 'g_Tiles', format: 'c', out: 'content/tiles.h' })
    expect(defaultExport('hero_sprites.sprites.json')).toEqual({
      name: 'g_HeroSprites',
      format: 'c',
      out: 'content/hero_sprites.h'
    })
  })

  it('creates a valid default doc from {} for every kind — the Resources panel New button', () => {
    for (const [kind, suffix] of Object.entries(RESOURCE_SUFFIXES)) {
      const path = `untitled${suffix}`
      const resource = parseResource(path, '{}')
      expect(resource.kind).toBe(kind)
      resource.doc.export = defaultExport(path)
      // Blank maps/screens legitimately warn until their editor picks a tileset / imports a source.
      const blankStateWarnings: Record<string, string[]> = {
        map: ['No tileset referenced'],
        screen: ['No source image']
      }
      expect(validateResource(resource)).toEqual(blankStateWarnings[kind] ?? [])
      expect(parseResource(path, serializeResource(resource))).toEqual(resource)
    }
  })
})
