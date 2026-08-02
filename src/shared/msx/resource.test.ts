import { describe, expect, it } from 'vitest'
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
    expect(defaultExport('art/city_bg.tiles.json')).toEqual({
      name: 'g_CityBg',
      format: 'c',
      out: 'content/city_bg.h'
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
    expect(text).toContain('const unsigned char g_Fixture_Patterns[] =')
  })

  it('renders bin as the raw concatenation', () => {
    const bytes = renderResource(fixtureTiles(), 'x.tiles.json', { name: 'g_X', format: 'bin', out: 'content/x.bin' })
    expect(bytes).toHaveLength(32)
    expect(bytes[1]).toBe(0x7e)
  })
})

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
})

describe('map resource', () => {
  it('emits one table per layer, named after the layer', () => {
    const doc = normalizeMap({
      tileset: './main.tiles.json',
      width: 4,
      height: 2,
      layers: [
        { name: 'background', data: [1, 2, 3, 4, 5, 6, 7, 8] },
        { name: 'collision', kind: 'flags', data: [0, 1, 0, 1, 0, 1, 0, 1] }
      ]
    })
    const tables = resourceTables({ kind: 'map', doc })
    expect(tables.map((table) => table.suffix)).toEqual(['_Background', '_Collision'])
    expect([...tables[0].bytes]).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(tables[1].comment).toContain('Flags layer')
  })

  it('defaults to a single background layer of the right size', () => {
    const doc = createMapDoc('./main.tiles.json')
    expect(doc.layers).toHaveLength(1)
    expect(doc.layers[0].data).toHaveLength(32 * 24)
    expect(validateResource({ kind: 'map', doc })).toEqual([])
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
      name: 'g_Fx',
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
    expect(text).toContain('const unsigned char g_Fx[] =')
  })

  it('parses, serializes and validates through the resource family', () => {
    const parsed = parseResource('audio/fx.sfx.json', serializeResource(fixtureSfx()))
    expect(parsed).toEqual(fixtureSfx())
    expect(validateResource(parsed)).toEqual([])
    expect(defaultExport('audio/fx.sfx.json')).toEqual({ name: 'g_Fx', format: 'c', out: 'content/fx.h' })
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
