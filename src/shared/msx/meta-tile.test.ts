import { describe, expect, it } from 'vitest'
import {
  addFrame,
  createMetaTileDoc,
  frameTileAt,
  metaBytes,
  metaCells,
  normalizeMetaTile,
  remapMetaTiles,
  removeFrame,
  reorderFrames,
  resizeMeta,
  setFrameTile,
  validateMetaTile
} from './meta-tile'

describe('normalizeMetaTile', () => {
  it('creates one frame of the right size', () => {
    const doc = createMetaTileDoc('res/tiles.tiles.json', 2, 3)
    expect(doc.version).toBe(2)
    expect(doc.frames).toHaveLength(1)
    expect(doc.frames[0].tiles).toHaveLength(6)
    expect(metaCells(doc)).toBe(6)
    expect(doc.flags).toBe(0)
  })

  it('resizes every frame to the document geometry, so the stride never varies', () => {
    const doc = normalizeMetaTile({
      tileset: 't.tiles.json',
      width: 2,
      height: 2,
      frames: [{ tiles: [1, 2, 3, 4] }, { tiles: [9] }]
    })
    expect(doc.frames[1].tiles).toEqual([9, 0, 0, 0])
  })

  it('migrates a version-1 set to its first meta and drops the rest', () => {
    const doc = normalizeMetaTile({
      version: 1,
      tileset: 't.tiles.json',
      width: 2,
      height: 2,
      metas: [
        { name: 'tree', width: 2, height: 2, tiles: [5, 6, 7, 8] },
        { name: 'rock', width: 2, height: 2, tiles: [1, 1, 1, 1] }
      ]
    })
    expect(doc.version).toBe(2)
    expect(doc.frames).toHaveLength(1)
    expect(doc.frames[0].tiles).toEqual([5, 6, 7, 8])
  })

  it('never produces a frameless document', () => {
    expect(normalizeMetaTile({ frames: [] }).frames).toHaveLength(1)
  })

  it('clamps flags to one byte', () => {
    expect(normalizeMetaTile({ flags: 0x1ff }).flags).toBe(0xff)
  })

  it('clamps the size to MAX_META_SIZE', () => {
    const doc = normalizeMetaTile({ tileset: 't', width: 99, height: 0 })
    expect(doc.width).toBe(16)
    expect(doc.height).toBe(2)
  })
})

describe('frames', () => {
  const base = createMetaTileDoc('t.tiles.json', 2, 1)

  it('addFrame copies the frame it is given, so animation starts from a pose', () => {
    const doc = addFrame(setFrameTile(base, 0, 0, 0, 7), 0)
    expect(doc.frames).toHaveLength(2)
    expect(doc.frames[1].tiles).toEqual([7, 0])
  })

  it('addFrame with no source appends a blank frame', () => {
    expect(addFrame(setFrameTile(base, 0, 0, 0, 7)).frames[1].tiles).toEqual([0, 0])
  })

  it('removeFrame refuses to remove the last one — a meta with no pose is not drawable', () => {
    expect(removeFrame(base, 0)).toBe(base)
  })

  it('reorderFrames moves a frame', () => {
    const doc = reorderFrames(addFrame(setFrameTile(base, 0, 0, 0, 7), 0), 1, 0)
    expect(doc.frames[0].tiles).toEqual([7, 0])
  })

  it('setFrameTile is a no-op outside the meta', () => {
    expect(setFrameTile(base, 0, 5, 5, 3)).toBe(base)
  })

  it('setFrameTile is a no-op when nothing changes, so it pushes no undo step', () => {
    expect(setFrameTile(base, 0, 0, 0, 0)).toBe(base)
  })

  it('frameTileAt reads back what was set', () => {
    expect(frameTileAt(setFrameTile(base, 0, 1, 0, 42), 0, 1, 0)).toBe(42)
  })

  it('metaBytes concatenates every frame in order', () => {
    const doc = addFrame(setFrameTile(base, 0, 0, 0, 7), 0)
    expect([...metaBytes(doc)]).toEqual([7, 0, 7, 0])
  })
})

describe('resizeMeta', () => {
  it('keeps the tiles that still fit, anchored top-left, across every frame', () => {
    let doc = normalizeMetaTile({
      tileset: 't',
      width: 2,
      height: 2,
      frames: [{ tiles: [1, 2, 3, 4] }, { tiles: [5, 6, 7, 8] }]
    })
    doc = resizeMeta(doc, 1, 2)
    expect(doc.frames[0].tiles).toEqual([1, 3])
    expect(doc.frames[1].tiles).toEqual([5, 7])
  })

  it('grows with tile 0, which is the transparent one', () => {
    const doc = resizeMeta(normalizeMetaTile({ tileset: 't', width: 1, height: 1, frames: [{ tiles: [9] }] }), 2, 1)
    expect(doc.frames[0].tiles).toEqual([9, 0])
  })
})

describe('remapMetaTiles', () => {
  it('replays a tileset reorder across every frame', () => {
    const doc = normalizeMetaTile({ tileset: 't', width: 2, height: 1, frames: [{ tiles: [0, 1] }, { tiles: [1, 0] }] })
    const next = remapMetaTiles(doc, [5, 6])
    expect(next.frames[0].tiles).toEqual([5, 6])
    expect(next.frames[1].tiles).toEqual([6, 5])
  })

  it('sends a tile the mapping does not cover to 0, not to undefined', () => {
    const doc = normalizeMetaTile({ tileset: 't', width: 1, height: 1, frames: [{ tiles: [9] }] })
    expect(remapMetaTiles(doc, [0]).frames[0].tiles).toEqual([0])
  })
})

describe('validateMetaTile', () => {
  it('accepts a well-formed meta', () => {
    expect(validateMetaTile(createMetaTileDoc('res/t.tiles.json', 2, 2))).toEqual([])
  })

  it('reports a missing tileset', () => {
    expect(validateMetaTile(createMetaTileDoc('', 2, 2))).toContain('No tileset referenced')
  })
})
