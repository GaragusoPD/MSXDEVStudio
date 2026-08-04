import { describe, expect, it } from 'vitest'
import {
  compositeFrame,
  convertSpriteMode,
  createLayer,
  createSpritesDoc,
  getSpritePixel,
  normalizeSprites,
  serializeSprites,
  MAX_GRID,
  setLayerCc,
  setLineColorByte,
  SPRITE_CC
} from './msx/sprite'
import {
  addFrame,
  addLayer,
  addSprite,
  characterPlaneCost,
  cloneFrame,
  convertSpriteSize,
  createHistory,
  duplicateSprite,
  floodFill,
  gridShrinkLossy,
  layerAtCell,
  mirrorLayer,
  modeConversionLossy,
  paintLine,
  paintPixel,
  pushHistory,
  redo,
  removeFrame,
  removeLayer,
  removeSprite,
  renameSprite,
  reorderFrame,
  scanlineBudget,
  setCharacterGrid,
  shiftLayer,
  sizeConversionLossy,
  stripToFrames,
  tickPlayback,
  undo,
  updateLayer,
  type SpriteTarget
} from './sprite-editor'

const TARGET: SpriteTarget = { sprite: 0, frame: 0, layer: 0 }

describe('undo/redo history', () => {
  it('pushes, undoes and redoes; a no-op push is skipped', () => {
    const docA = createSpritesDoc(2, 8)
    const docB = { ...docA, sprites: addSprite(docA).sprites }
    let history = createHistory(docA)
    expect(pushHistory(history, docA)).toBe(history) // reference-equal doc: no-op

    history = pushHistory(history, docB)
    expect(history.present).toBe(docB)
    expect(history.past).toEqual([docA])

    history = undo(history)
    expect(history.present).toBe(docA)
    expect(history.future).toEqual([docB])

    history = redo(history)
    expect(history.present).toBe(docB)
    expect(history.future).toEqual([])
  })

  it('undo/redo at the boundary is a no-op', () => {
    const history = createHistory(createSpritesDoc())
    expect(undo(history)).toBe(history)
    expect(redo(history)).toBe(history)
  })
})

describe('draw dispatch: strokes land on the active layer and the composite reflects it', () => {
  it('pencil/erase via updateLayer + paintPixel only touches the targeted layer', () => {
    const doc = createSpritesDoc(1, 8)
    const withSecondLayer = addLayer(doc, 0)
    const target: SpriteTarget = { sprite: 0, frame: 0, layer: 1 }

    const painted = updateLayer(withSecondLayer, target, (layer) => paintPixel(layer, 3, 2, 8, true))
    const layers = painted.sprites[0].frames[0].layers
    expect(getSpritePixel(layers[1], 3, 2, 8)).toBe(true)
    expect(getSpritePixel(layers[0], 3, 2, 8)).toBe(false) // untouched layer

    const composite = compositeFrame(layers, painted.mode, painted.size)
    expect(composite[2 * 8 + 3]).toBe(layers[1].color) // preview equals compositeFrame output

    const erased = updateLayer(painted, target, (layer) => paintPixel(layer, 3, 2, 8, false))
    expect(getSpritePixel(erased.sprites[0].frames[0].layers[1], 3, 2, 8)).toBe(false)
  })

  it('updateLayer is a no-op when the target does not exist', () => {
    const doc = createSpritesDoc()
    const bogus: SpriteTarget = { sprite: 9, frame: 0, layer: 0 }
    expect(updateLayer(doc, bogus, (l) => l)).toBe(doc)
  })

  it('line tool draws a straight run of pixels via Bresenham', () => {
    const layer = paintLine(createLayer(8, 6), 0, 0, 3, 0, 8, true)
    for (let x = 0; x <= 3; x++) expect(getSpritePixel(layer, x, 0, 8)).toBe(true)
    expect(getSpritePixel(layer, 4, 0, 8)).toBe(false)
  })

  it('fill flood-fills a contiguous region and stops at set pixels', () => {
    let layer = createLayer(8, 3)
    layer = paintLine(layer, 4, 0, 4, 7, 8, true) // a vertical wall splitting the sprite in two
    const filled = floodFill(layer, 0, 0, 8, true)
    expect(getSpritePixel(filled, 0, 0, 8)).toBe(true)
    expect(getSpritePixel(filled, 3, 7, 8)).toBe(true)
    expect(getSpritePixel(filled, 5, 0, 8)).toBe(false) // other side of the wall untouched
    expect(floodFill(filled, 0, 0, 8, true)).toBe(filled) // already on: no-op
  })

  it('mirror flips the pattern across the requested axis', () => {
    const layer = paintPixel(createLayer(8, 1), 0, 0, 8, true)
    expect(getSpritePixel(mirrorLayer(layer, 8, 'x'), 7, 0, 8)).toBe(true)
    expect(getSpritePixel(mirrorLayer(layer, 8, 'y'), 0, 7, 8)).toBe(true)
  })

  it('shift wraps pixels around the edges', () => {
    const layer = paintPixel(createLayer(8, 1), 0, 0, 8, true)
    const shifted = shiftLayer(layer, 8, -1, 0)
    expect(getSpritePixel(shifted, 7, 0, 8)).toBe(true)
    expect(getSpritePixel(shifted, 0, 0, 8)).toBe(false)
  })
})

describe('frame/sprite/layer list ops', () => {
  it('addFrame clones frame 0’s layer count/colors but starts blank', () => {
    const doc = createSpritesDoc(2, 8)
    const colored = updateLayer(doc, TARGET, (l) => setLineColorByte(l, 0, SPRITE_CC | 7))
    const next = addFrame(colored, 0)
    expect(next.sprites[0].frames).toHaveLength(2)
    const [blankLayer] = next.sprites[0].frames[1].layers
    expect(blankLayer.lineColors[0]).toBe(SPRITE_CC | 7) // colors carried over
    expect(blankLayer.pattern.every((b) => b === 0)).toBe(true) // pattern is blank
  })

  it('cloneFrame duplicates a frame right after it, removeFrame refuses to empty a sprite', () => {
    const doc = createSpritesDoc()
    const painted = updateLayer(doc, TARGET, (l) => paintPixel(l, 0, 0, doc.size, true))
    const cloned = cloneFrame(painted, 0, 0)
    expect(cloned.sprites[0].frames).toHaveLength(2)
    expect(getSpritePixel(cloned.sprites[0].frames[1].layers[0], 0, 0, doc.size)).toBe(true)

    const removedBack = removeFrame(cloned, 0, 1)
    expect(removedBack.sprites[0].frames).toHaveLength(1)
    expect(removeFrame(removedBack, 0, 0)).toBe(removedBack) // last frame: refused
  })

  it('reorderFrame moves a frame to a new index', () => {
    let doc = createSpritesDoc()
    doc = addFrame(doc, 0)
    doc = addFrame(doc, 0)
    const tagged = {
      ...doc,
      sprites: [{ ...doc.sprites[0], frames: doc.sprites[0].frames.map((f, i) => ({ layers: [{ ...f.layers[0], color: i }] })) }]
    }
    const reordered = reorderFrame(tagged, 0, 0, 2)
    expect(reordered.sprites[0].frames.map((f) => f.layers[0].color)).toEqual([1, 2, 0])
  })

  it('addSprite/duplicateSprite/removeSprite/renameSprite', () => {
    let doc = createSpritesDoc()
    doc = renameSprite(doc, 0, 'hero')
    doc = addSprite(doc)
    expect(doc.sprites).toHaveLength(2)
    doc = duplicateSprite(doc, 0)
    expect(doc.sprites).toHaveLength(3)
    expect(doc.sprites[1].name).toBe('hero_copy')
    expect(removeSprite(doc, 0).sprites.map((s) => s.name)).toEqual(['hero_copy', 'sprite_1'])
    // Never empties the document.
    const solo = createSpritesDoc()
    expect(removeSprite(solo, 0)).toBe(solo)
  })

  it('addLayer/removeLayer keep layer counts in sync across every frame', () => {
    let doc = createSpritesDoc(2, 8)
    doc = addFrame(doc, 0)
    doc = addLayer(doc, 0)
    expect(doc.sprites[0].frames[0].layers).toHaveLength(2)
    expect(doc.sprites[0].frames[1].layers).toHaveLength(2)

    for (let i = 0; i < 4; i++) doc = addLayer(doc, 0) // hits MAX_LAYERS (4) and then no-ops
    expect(doc.sprites[0].frames[0].layers).toHaveLength(4)

    doc = removeLayer(doc, 0, 0)
    expect(doc.sprites[0].frames[0].layers).toHaveLength(3)
    expect(doc.sprites[0].frames[1].layers).toHaveLength(3)

    const downToOne = createSpritesDoc(2, 8)
    expect(removeLayer(downToOne, 0, 0)).toBe(downToOne) // refuses to empty a frame
  })
})

describe('size conversion', () => {
  it('growing 8→16 keeps the pattern top-left and preserves color/EC/CC', () => {
    const doc = createSpritesDoc(2, 8)
    let painted = updateLayer(doc, TARGET, (l) => paintPixel(l, 7, 7, 8, true))
    painted = updateLayer(painted, TARGET, (l) => setLayerCc(l, true))
    const grown = convertSpriteSize(painted, 16)
    const layer = grown.sprites[0].frames[0].layers[0]
    expect(getSpritePixel(layer, 7, 7, 16)).toBe(true)
    expect(getSpritePixel(layer, 8, 8, 16)).toBe(false)
    expect(layer.cc).toBe(true)
  })

  it('shrinking 16→8 crops, and sizeConversionLossy flags pixels outside the kept quadrant', () => {
    const doc = createSpritesDoc(2, 16)
    expect(sizeConversionLossy(doc, 8)).toBe(false) // blank sprite: nothing to lose

    const painted = updateLayer(doc, TARGET, (l) => paintPixel(l, 12, 3, 16, true))
    expect(sizeConversionLossy(painted, 8)).toBe(true)

    const shrunk = convertSpriteSize(painted, 8)
    expect(shrunk.size).toBe(8)
    expect(shrunk.sprites[0].frames[0].layers[0].pattern).toHaveLength(8)

    const insideQuadrant = updateLayer(doc, TARGET, (l) => paintPixel(l, 2, 2, 16, true))
    expect(sizeConversionLossy(insideQuadrant, 8)).toBe(false)
    expect(getSpritePixel(convertSpriteSize(insideQuadrant, 8).sprites[0].frames[0].layers[0], 2, 2, 8)).toBe(true)
  })
})

describe('mode conversion loss check (the conversion itself is msx/sprite.ts’s job)', () => {
  it('is false for 1→2, and false for 2→1 when every line already agrees', () => {
    const mode1 = createSpritesDoc(1, 16)
    expect(modeConversionLossy(mode1, 2)).toBe(false)
    const uniform = createSpritesDoc(2, 16) // createLayer fills all 16 lines with the same color, cc false
    expect(modeConversionLossy(uniform, 1)).toBe(false)
  })

  it('is true when a layer has per-line color variation or CC set', () => {
    const varied = updateLayer(createSpritesDoc(2, 16), TARGET, (l) => setLineColorByte(l, 5, 9))
    expect(modeConversionLossy(varied, 1)).toBe(true)

    const blended = updateLayer(createSpritesDoc(2, 16), TARGET, (l) => setLayerCc(l, true))
    expect(modeConversionLossy(blended, 1)).toBe(true)
  })

  it('actually converts losslessly when not flagged, matching msx/sprite.ts’s convertSpriteMode', () => {
    const doc = createSpritesDoc(2, 16)
    expect(modeConversionLossy(doc, 1)).toBe(false)
    const converted = convertSpriteMode(doc, 1)
    expect(converted.mode).toBe(1)
  })
})

describe('scanline budget hint', () => {
  it('sums frame-0 layer counts across every sprite and flags when it exceeds the mode limit', () => {
    let doc = createSpritesDoc(1, 8) // mode 1: limit 4
    expect(scanlineBudget(doc).limit).toBe(4)
    expect(scanlineBudget(doc).exceeded).toBe(false)
    for (let i = 0; i < 4; i++) doc = addSprite(doc) // 5 sprites × 1 layer = 5 > 4
    const budget = scanlineBudget(doc)
    expect(budget.total).toBe(5)
    expect(budget.exceeded).toBe(true)
  })

  it('mode 2’s limit is 8', () => {
    expect(scanlineBudget(createSpritesDoc(2, 16)).limit).toBe(8)
  })

  it('charges a superposed character one hardware sprite per stacked plane', () => {
    let doc = createSpritesDoc(1, 16) // mode 1: a plane is one colour, so colours mean planes
    expect(characterPlaneCost(doc.sprites[0])).toBe(1)
    doc = addLayer(doc, 0)
    doc = addLayer(doc, 0)
    doc = addLayer(doc, 0) // MAX_LAYERS: a 4-colour character spends the whole mode-1 line
    expect(characterPlaneCost(doc.sprites[0])).toBe(4)
    expect(scanlineBudget(doc)).toMatchObject({ total: 4, limit: 4, exceeded: false })
    expect(scanlineBudget(addSprite(doc)).exceeded).toBe(true) // anything else beside it drops
  })

  it('charges a metasprite only its busiest cell row — the other rows sit on other scanlines', () => {
    let doc = setCharacterGrid(createSpritesDoc(2, 16), 0, 2, 2) // 4 cells, one plane each
    expect(scanlineBudget(doc).total).toBe(2) // 2 planes per cell row, not 4
    doc = addLayer(doc, 0, 0, 0) // second plane on the top-left cell
    expect(scanlineBudget(doc).total).toBe(3)
  })
})

describe('metasprite grid', () => {
  it('grows with one blank plane per new cell and shrinks by dropping the ones outside', () => {
    const doc = setCharacterGrid(createSpritesDoc(2, 8), 0, 2, 2)
    expect(doc.sprites[0]).toMatchObject({ cols: 2, rows: 2 })
    expect(doc.sprites[0].frames[0].layers.map((l) => [l.cx, l.cy])).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1]
    ])

    const shrunk = setCharacterGrid(doc, 0, 1, 1)
    expect(shrunk.sprites[0].frames[0].layers).toHaveLength(1)
    expect(shrunk.sprites[0].frames[0].layers[0]).toMatchObject({ cx: 0, cy: 0 })
  })

  it('resizes every frame, not just the one being edited', () => {
    let doc = addFrame(createSpritesDoc(2, 8), 0)
    doc = setCharacterGrid(doc, 0, 2, 1)
    expect(doc.sprites[0].frames.map((f) => f.layers.length)).toEqual([2, 2])
  })

  it('clamps the grid to 1..MAX_GRID', () => {
    const doc = setCharacterGrid(createSpritesDoc(2, 8), 0, 99, 0)
    expect(doc.sprites[0]).toMatchObject({ cols: MAX_GRID, rows: 1 })
  })

  it('only calls a shrink lossy when the dropped planes carry pixels', () => {
    const doc = setCharacterGrid(createSpritesDoc(2, 8), 0, 2, 1)
    expect(gridShrinkLossy(doc, 0, 1, 1)).toBe(false)
    const painted = updateLayer(doc, { sprite: 0, frame: 0, layer: 1 }, (l) => paintPixel(l, 0, 0, 8, true))
    expect(gridShrinkLossy(painted, 0, 1, 1)).toBe(true)
  })

  it('adds and finds layers per cell', () => {
    let doc = setCharacterGrid(createSpritesDoc(2, 8), 0, 2, 1)
    expect(layerAtCell(doc.sprites[0].frames[0], 1, 0)).toBe(1)
    expect(layerAtCell(doc.sprites[0].frames[0], 0, 1)).toBe(-1)

    for (let i = 0; i < 5; i++) doc = addLayer(doc, 0, 1, 0) // cell (1,0) fills at MAX_LAYERS
    const layers = doc.sprites[0].frames[0].layers
    expect(layers.filter((l) => l.cx === 1)).toHaveLength(4)
    expect(layers.filter((l) => l.cx === 0)).toHaveLength(1)
  })

  it('lets a cell go empty but never the whole frame', () => {
    const doc = setCharacterGrid(createSpritesDoc(2, 8), 0, 2, 1)
    const emptied = removeLayer(doc, 0, 1)
    expect(layerAtCell(emptied.sprites[0].frames[0], 1, 0)).toBe(-1)
    expect(removeLayer(emptied, 0, 0)).toBe(emptied)
  })

  it('keeps cells through a size conversion', () => {
    const doc = setCharacterGrid(createSpritesDoc(2, 8), 0, 2, 1)
    expect(convertSpriteSize(doc, 16).sprites[0].frames[0].layers.map((l) => l.cx)).toEqual([0, 1])
  })
})

describe('PNG-strip import', () => {
  it('slices a two-frame strip and decomposes two source colors onto two layers', () => {
    const size = 8
    const width = size * 2
    const height = size
    const indices = new Uint8Array(width * height)
    // Frame 0: color 3 fills column 0, color 5 fills column 1.
    for (let y = 0; y < size; y++) {
      indices[y * width + 0] = 3
      indices[y * width + 1] = 5
    }
    // Frame 1 (columns 8-15): only color 3, at column 8.
    for (let y = 0; y < size; y++) indices[y * width + size] = 3

    const assign = (source: number): number | null => (source === 3 ? 0 : source === 5 ? 1 : null)
    const frames = stripToFrames(indices, width, height, size, assign)

    expect(frames).toHaveLength(2)
    expect(frames[0].layers).toHaveLength(2)
    expect(frames[0].layers[0].color).toBe(3)
    expect(getSpritePixel(frames[0].layers[0], 0, 0, size)).toBe(true)
    expect(getSpritePixel(frames[0].layers[0], 1, 0, size)).toBe(false)
    expect(frames[0].layers[1].color).toBe(5)
    expect(getSpritePixel(frames[0].layers[1], 1, 0, size)).toBe(true)

    expect(frames[1].layers).toHaveLength(1) // color 5 never appears in frame 1
    expect(frames[1].layers[0].color).toBe(3)
  })

  it('unassigned (null) and transparent (0) source indices are skipped', () => {
    const size = 8
    const indices = new Uint8Array(size * size).fill(2) // all one color, never assigned
    const frames = stripToFrames(indices, size, size, size, () => null)
    expect(frames[0].layers).toHaveLength(1)
    expect(frames[0].layers[0].pattern.every((b) => b === 0)).toBe(true) // blank: nothing mapped
  })
})

describe('animation playback tick', () => {
  it('advances one frame per period and wraps', () => {
    let state = { frameIndex: 0, elapsedMs: 0 }
    state = tickPlayback(state, 100, 10, 3) // 10fps = 100ms/frame
    expect(state).toEqual({ frameIndex: 1, elapsedMs: 0 })
    state = tickPlayback(state, 250, 10, 3) // 2 more frames plus 50ms leftover
    expect(state).toEqual({ frameIndex: 0, elapsedMs: 50 })
  })

  it('never advances with one frame or fewer', () => {
    expect(tickPlayback({ frameIndex: 0, elapsedMs: 0 }, 500, 10, 1)).toEqual({ frameIndex: 0, elapsedMs: 0 })
  })
})

describe('export → re-import round trip on an editor-built document', () => {
  it('preserves every stroke/frame/sprite op through serialize → JSON → normalize', () => {
    let doc = createSpritesDoc(2, 16)
    doc = renameSprite(doc, 0, 'hero')
    doc = updateLayer(doc, TARGET, (l) => paintLine(l, 0, 0, 15, 0, 16, true))
    doc = updateLayer(doc, TARGET, (l) => setLineColorByte(l, 0, SPRITE_CC | 6))
    doc = addLayer(doc, 0)
    doc = updateLayer(doc, { sprite: 0, frame: 0, layer: 1 }, (l) => mirrorLayer(paintPixel(l, 3, 3, 16, true), 16, 'x'))
    doc = addFrame(doc, 0)
    doc = cloneFrame(doc, 0, 0)
    doc = addSprite(doc)

    const roundTripped = normalizeSprites(JSON.parse(JSON.stringify(serializeSprites(doc))))
    expect(roundTripped).toEqual(doc)
  })
})
