import { describe, expect, it } from 'vitest'
import {
  addEntity,
  cleanEntityTypeName,
  entityBytes,
  entityIds,
  entityIndexAt,
  entityProblems,
  entityTypesOf,
  normalizeEntities,
  removeEntity,
  updateEntity
} from './map-entity'
import { mapEntities, normalizeMap, resizeMap, validateMap, withEntities } from './map'
import { parseResource, renderResourceFiles, serializeResource } from './resource'

describe('map entities', () => {
  it('a map without entities round-trips without the key, as every older file does', () => {
    const map = normalizeMap({ tileset: 'res/t.tiles.json' })
    expect('entities' in map).toBe(false)
    expect(serializeResource({ kind: 'map', doc: map })).not.toContain('entities')
    // Deleting the last one removes the key again rather than saving `[]`.
    const one = withEntities(map, [{ type: 'chest', x: 1, y: 1, param: 0 }])
    expect('entities' in withEntities(one, [])).toBe(false)
  })

  it('keeps what is on the grid, drops what is not, and cleans names and params', () => {
    const entities = normalizeEntities(
      [
        { type: 'chest', x: 2, y: 3, param: 300 },
        { type: 'enemy bat', x: 0, y: 0, param: 1 },
        { type: 'gone', x: 40, y: 0 },
        'junk'
      ],
      32,
      24
    )
    expect(entities).toEqual([
      { type: 'chest', x: 2, y: 3, param: 300 & 0xff },
      { type: 'enemy_bat', x: 0, y: 0, param: 1 }
    ])
  })

  it('makes any typed name a C identifier', () => {
    expect(cleanEntityTypeName('  big key! ')).toBe('big_key')
    expect(cleanEntityTypeName('1up')).toBe('e_1up')
    expect(cleanEntityTypeName('')).toBe('entity')
  })

  it('edits as new lists, and finds the topmost entity on a cell', () => {
    let list = addEntity([], { type: 'key', x: 1, y: 1, param: 0 })
    list = addEntity(list, { type: 'chest', x: 1, y: 1, param: 2 })
    expect(entityIndexAt(list, 1, 1)).toBe(1)
    expect(entityIndexAt(list, 0, 0)).toBeNull()
    list = updateEntity(list, 0, { x: 5, param: 513 })
    expect(list[0]).toEqual({ type: 'key', x: 5, y: 1, param: 1 })
    expect(removeEntity(list, 1)).toEqual([list[0]])
  })

  it('a resize drops entities that fall off the grid', () => {
    const map = withEntities(normalizeMap({ tileset: 't', width: 64, height: 24 }), [
      { type: 'a', x: 10, y: 1, param: 0 },
      { type: 'b', x: 40, y: 1, param: 0 }
    ])
    expect(mapEntities(resizeMap(map, 32, 24)).map((entity) => entity.type)).toEqual(['a'])
  })

  it('numbers a map’s own types from 1, in sorted order, and writes four bytes an entity', () => {
    const list = [
      { type: 'key', x: 1, y: 2, param: 7 },
      { type: 'chest', x: 3, y: 4, param: 0 }
    ]
    const ids = entityIds(entityTypesOf(list))
    expect([...ids]).toEqual([
      ['chest', 1],
      ['key', 2]
    ])
    expect([...entityBytes(list, ids)]).toEqual([2, 1, 2, 7, 1, 3, 4, 0])
  })

  it('refuses coordinates a byte cannot hold', () => {
    expect(entityProblems([{ type: 'far', x: 300, y: 0, param: 0 }]).join()).toContain('at most 255')
    const wide = withEntities(normalizeMap({ tileset: 't', width: 400, height: 2 }), [{ type: 'far', x: 300, y: 0, param: 0 }])
    expect(validateMap(wide).join()).toContain('coordinates are one byte')
  })

  it('a map with entities exports the table and an id per type, from the file alone', () => {
    const map = withEntities(normalizeMap({ tileset: 'res/t.tiles.json' }), [
      { type: 'key', x: 1, y: 2, param: 7 },
      { type: 'chest', x: 3, y: 4, param: 0 }
    ])
    map.export = { name: 'g_Level', format: 'c', out: 'content/level.h' }
    const parsed = parseResource('res/level.map.json', serializeResource({ kind: 'map', doc: map }))
    const files = renderResourceFiles(parsed, 'res/level.map.json', map.export)
    expect(files.header).toContain('#define G_LEVEL_ENTITIES 2')
    expect(files.header).toContain('#define G_LEVEL_ENT_CHEST 1')
    expect(files.header).toContain('#define G_LEVEL_ENT_KEY 2')
    expect(files.header).toContain('extern const unsigned char g_Level_Entities[];')
    expect(files.source).toContain('0x02, 0x01, 0x02, 0x07,')
  })

  it('a map without entities exports exactly what it did', () => {
    const map = normalizeMap({ tileset: 'res/t.tiles.json' })
    map.export = { name: 'g_Level', format: 'c', out: 'content/level.h' }
    const files = renderResourceFiles({ kind: 'map', doc: map }, 'res/level.map.json', map.export)
    expect(files.header).not.toContain('ENTIT')
  })
})
