/**
 * Converted sheet cells into resources — the destinations of the sheet
 * importer (`sheet.ts` cuts the cells; the quantizer turns them into palette
 * indices; this turns those into tiles, poses, see-through cells and sprite
 * planes).
 *
 * Every function takes cells already in the destination's colours: one
 * palette index per dot, row-major, with 0 where the sheet was transparent.
 * What 0 then means is the destination's business, and the point of having
 * one function per destination: colour 0 (the backdrop) in a tile, a
 * see-through cell in a meta-tile, a dot no sprite plane sets, the reserved
 * blank tile of a bitmap tileset, a software sprite's transparent index.
 */

import { MAX_BITMAP_TILES, type BitmapTilesDoc } from './bitmap-tile'
import { cellEntry, placePicture, type Picture } from './tile-compact'
import { findOrCreateBitmapTile } from './meta-paint'
import { createMetaTileDoc, MAX_META_SIZE, type MetaTileDoc } from './meta-tile'
import { createOwnedMeta, type OwnedMetaDoc } from './meta-owned'
import { colorDistance, type Rgb } from './palette'
import {
  createLayer,
  MAX_GRID,
  MAX_LAYERS,
  setSpritePixel,
  SPRITE_COLOR_MASK,
  type SpriteCharacter,
  type SpriteFrame,
  type SpriteLayer,
  type SpriteMode,
  type SpriteSize
} from './sprite'
import { createTileAnimDoc, DEFAULT_ANIM_DURATION, MAX_ANIM_CELLS, type TileAnimDoc, type TileAnimFrame } from './tile-anim'
import { mergeColorByte, TILE_SIZE, type TileBlock, type TileEntry, type TilesDoc } from './tile'
import type { TileMode } from './modes'
import { encodeIndices } from './screen'
import { MAX_SW_FRAMES, MAX_SW_SIZE, snapSize, type SwMode, type SwSpriteChar } from './swsprite'

/** One converted cell. */
export interface SheetCell {
  width: number
  height: number
  /** Palette indices, row-major; 0 is transparent. */
  indices: Uint8Array
}

/** The 8×8 tile at tile column `tx`, row `ty` of a cell, row-major. */
function tilePixels(cell: SheetCell, tx: number, ty: number): Uint8Array {
  const out = new Uint8Array(TILE_SIZE * TILE_SIZE)
  for (let y = 0; y < TILE_SIZE; y++) {
    for (let x = 0; x < TILE_SIZE; x++) {
      const sx = tx * TILE_SIZE + x
      const sy = ty * TILE_SIZE + y
      out[y * TILE_SIZE + x] = sx < cell.width && sy < cell.height ? cell.indices[sy * cell.width + sx] & 0x0f : 0
    }
  }
  return out
}

const tilesAcross = (cell: SheetCell): { cols: number; rows: number } => ({
  cols: Math.ceil(cell.width / TILE_SIZE),
  rows: Math.ceil(cell.height / TILE_SIZE)
})

// ── tileset ─────────────────────────────────────────────────────────────────

export interface SheetTilesResult {
  doc: TilesDoc
  /** Per cell, its tiles row-major — what a block or a map cell holds. */
  cellTiles: number[][]
  added: number
  reused: number
  lossy: number
  /** Set when the tileset ran out of room; `doc` is then the tileset as it was. */
  refused?: string
}

/**
 * Each cell's 8×8 tiles into the tileset, matched against what it already
 * draws and appended otherwise — `placePicture`'s rule, so an import and a
 * picture dropped on a map agree about what "the same tile" is. All or
 * nothing. `blocks` names a block per cell (a 16×16 tile is then one stamp).
 * Transparent dots are colour 0, the backdrop.
 */
export function cellsToTiles(tiles: TilesDoc, cells: readonly SheetCell[], blocks: readonly string[] | null = null): SheetTilesResult {
  let doc = tiles
  const cellTiles: number[][] = []
  let added = 0
  let reused = 0
  let lossy = 0
  for (const cell of cells) {
    const { cols, rows } = tilesAcross(cell)
    const width = cols * TILE_SIZE
    const pixels = new Uint8Array(width * rows * TILE_SIZE)
    for (let y = 0; y < cell.height; y++) for (let x = 0; x < cell.width; x++) pixels[y * width + x] = cell.indices[y * cell.width + x]
    const placed = placePicture({ width: cols, height: rows, tiles: new Array<number>(cols * rows).fill(0) }, doc, pixels, cols, rows)
    if (placed.refused) return { doc: tiles, cellTiles: [], added: 0, reused: 0, lossy: 0, refused: placed.refused }
    doc = placed.tiles
    cellTiles.push(placed.grid.tiles)
    added += placed.added
    reused += placed.reused
    lossy += placed.lossy
  }
  if (blocks) {
    const named: TileBlock[] = cells.map((cell, i) => {
      const { cols, rows } = tilesAcross(cell)
      return { name: blocks[i] ?? `block_${doc.blocks.length + i}`, width: cols, height: rows, tiles: cellTiles[i] }
    })
    doc = { ...doc, blocks: [...doc.blocks, ...named] }
  }
  return { doc, cellTiles, added, reused, lossy }
}

/**
 * The cells' tiles laid out where the cells sit on the sheet (`at`, in cells),
 * gaps closed — the map a new tileset gets beside it. Cells not selected are
 * tile 0.
 */
export function layoutCells(
  cellTiles: readonly number[][],
  at: readonly { col: number; row: number }[],
  cellCols: number,
  cellRows: number
): { width: number; height: number; tiles: number[] } {
  const col0 = Math.min(...at.map((p) => p.col))
  const row0 = Math.min(...at.map((p) => p.row))
  const width = (Math.max(...at.map((p) => p.col)) - col0 + 1) * cellCols
  const height = (Math.max(...at.map((p) => p.row)) - row0 + 1) * cellRows
  const out = new Array<number>(width * height).fill(0)
  at.forEach((p, n) => {
    for (let y = 0; y < cellRows; y++) {
      for (let x = 0; x < cellCols; x++) out[((p.row - row0) * cellRows + y) * width + (p.col - col0) * cellCols + x] = cellTiles[n]?.[y * cellCols + x] ?? 0
    }
  })
  return { width, height, tiles: out }
}

/**
 * The selected cells as one picture laid out as on the sheet, gaps closed —
 * what floats over a map. Unselected cells inside the rectangle are 0,
 * see-through there too.
 */
export function selectionPicture(cells: readonly SheetCell[], at: readonly { col: number; row: number }[]): Picture {
  const cw = cells[0]?.width ?? 0
  const ch = cells[0]?.height ?? 0
  const col0 = Math.min(...at.map((p) => p.col))
  const row0 = Math.min(...at.map((p) => p.row))
  const width = (Math.max(...at.map((p) => p.col)) - col0 + 1) * cw
  const height = (Math.max(...at.map((p) => p.row)) - row0 + 1) * ch
  const indices = new Uint8Array(width * height)
  cells.forEach((cell, n) => {
    const ox = (at[n].col - col0) * cw
    const oy = (at[n].row - row0) * ch
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) indices[(oy + y) * width + ox + x] = cell.indices[y * cw + x]
  })
  return { width, height, indices }
}

// ── poses: animated tiles and meta-tiles ────────────────────────────────────

/**
 * SCREEN 1 holds one ink/paper pair per group of eight tiles, so a pose
 * document holds one for all its poses: the two colours used most across every
 * cell. Each dot is then ink unless it is the paper colour.
 */
function sc1Pair(cells: readonly SheetCell[]): { fg: number; bg: number } {
  const counts = new Map<number, number>()
  for (const cell of cells) for (const value of cell.indices) counts.set(value & 0x0f, (counts.get(value & 0x0f) ?? 0) + 1)
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([value]) => value)
  const bg = ranked.includes(0) ? 0 : (ranked[1] ?? 0)
  const fg = ranked.find((value) => value !== bg) ?? 15
  return { fg, bg }
}

function poseTiles(cell: SheetCell, mode: TileMode, sc1: { fg: number; bg: number } | null): { tiles: TileEntry[]; lossy: number } {
  const { cols, rows } = tilesAcross(cell)
  const tiles: TileEntry[] = []
  let lossy = 0
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const pixels = tilePixels(cell, tx, ty)
      if (sc1) {
        const pattern = Array.from({ length: TILE_SIZE }, (_, y) => {
          let bits = 0
          for (let x = 0; x < TILE_SIZE; x++) if (pixels[y * TILE_SIZE + x] !== sc1.bg) bits |= 0x80 >> x
          return bits
        })
        if (pixels.some((value) => value !== sc1.bg && value !== sc1.fg)) lossy++
        tiles.push({ pattern, color: [] })
        continue
      }
      const entry = cellEntry(pixels, mode)
      if (entry.lossy) lossy++
      tiles.push(entry.entry)
    }
  }
  return { tiles, lossy }
}

export interface SheetPosesResult<T> {
  doc: T
  /** Tiles the mode's colour rule could not draw exactly. */
  lossy: number
}

function poses(mode: TileMode, cells: readonly SheetCell[], duration: number, pair?: number): { frames: TileAnimFrame[]; pair: number; lossy: number } {
  const sc1 = mode !== 'sc1' ? null : pair === undefined ? sc1Pair(cells) : { fg: (pair >> 4) & 0x0f, bg: pair & 0x0f }
  let lossy = 0
  const frames = cells.map((cell) => {
    const pose = poseTiles(cell, mode, sc1)
    lossy += pose.lossy
    return { tiles: pose.tiles, duration }
  })
  return { frames, pair: sc1 ? mergeColorByte(sc1.fg, sc1.bg) : 0xf1, lossy }
}

/**
 * One pose per cell, as an animated tile: the cell is the window. Transparent
 * dots are colour 0 — an animation is drawn whole, nothing shows through it.
 * `pair` is SCREEN 1's ink and paper when the poses join a document that
 * already has them; otherwise the cells' own two most-used colours.
 */
export function cellsToTileAnim(
  mode: TileMode,
  cells: readonly SheetCell[],
  duration = DEFAULT_ANIM_DURATION,
  pair?: number
): SheetPosesResult<TileAnimDoc> | string {
  if (!cells.length) return 'Select at least one cell.'
  const { cols, rows } = tilesAcross(cells[0])
  if (cols * rows > MAX_ANIM_CELLS) {
    return `A ${cols}×${rows}-tile cell is ${cols * rows} tiles; an animated tile holds at most ${MAX_ANIM_CELLS}. Import it as a meta-tile instead.`
  }
  const made = poses(mode, cells, duration, pair)
  return { doc: { ...createTileAnimDoc(mode, cols, rows), pair: made.pair, frames: made.frames }, lossy: made.lossy }
}

/**
 * One pose per cell, as a meta-tile. A tile transparent in every pose is a
 * see-through cell — never written, so what is under the meta shows there;
 * other transparent dots are colour 0.
 */
export function cellsToOwnedMeta(
  mode: TileMode,
  cells: readonly SheetCell[],
  duration = DEFAULT_ANIM_DURATION,
  pair?: number
): SheetPosesResult<OwnedMetaDoc> | string {
  if (!cells.length) return 'Select at least one cell.'
  const { cols, rows } = tilesAcross(cells[0])
  if (cols > MAX_META_SIZE || rows > MAX_META_SIZE) {
    return `A ${cols}×${rows}-tile cell is too big for a meta-tile, which is at most ${MAX_META_SIZE}×${MAX_META_SIZE} tiles.`
  }
  const made = poses(mode, cells, duration, pair)
  const holes = Array.from({ length: cols * rows }, (_, i) =>
    cells.every((cell) => tilePixels(cell, i % cols, Math.floor(i / cols)).every((value) => value === 0))
  )
  // A meta with nothing but see-through cells would draw nothing at all.
  if (holes.every(Boolean)) return 'Every selected cell is empty.'
  return { doc: { ...createOwnedMeta(mode, cols, rows), pair: made.pair, frames: made.frames, holes }, lossy: made.lossy }
}

// ── sprites ─────────────────────────────────────────────────────────────────

export interface SheetSpriteOptions {
  mode: SpriteMode
  size: SpriteSize
  /** Planes stacked on one cell at most; colours past it go to the nearest kept one. */
  maxPlanes: number
  /** The sprite palette, for merging a colour that gets no plane into the nearest that does. */
  palette: readonly Rgb[]
  name: string
}

export interface SheetSpriteResult {
  character: SpriteCharacter
  /** Hardware sprites one screen line of the character crosses, at worst. */
  spritesPerLine: number
  /** Dots drawn in a colour that got no plane of its own. */
  merged: number
}

/** The colours worth a plane among `counts`, most used first, and where every other one goes. */
function keepColours(
  counts: Map<number, number>,
  limit: number,
  palette: readonly Rgb[],
  rank: (color: number) => number
): { kept: number[]; map: Map<number, number> } {
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || rank(a[0]) - rank(b[0])).map(([color]) => color)
  // Plane order follows the cell's own ranking, so a colour tends to keep its
  // plane from line to line — easier to edit, the same to the hardware.
  const kept = ranked.slice(0, limit).sort((a, b) => rank(a) - rank(b))
  const map = new Map<number, number>()
  for (const color of ranked) {
    if (kept.includes(color)) {
      map.set(color, color)
      continue
    }
    const from = palette[color]
    let best = kept[0]
    let bestDistance = Infinity
    for (const candidate of kept) {
      const to = palette[candidate]
      const distance = from && to ? colorDistance(from, to) : Math.abs(candidate - color)
      if (distance < bestDistance) {
        best = candidate
        bestDistance = distance
      }
    }
    map.set(color, best)
  }
  return { kept, map }
}

/**
 * One frame per cell, as a sprite character. A cell bigger than the sprite
 * size is a metasprite grid; each grid cell's colours are split into stacked
 * planes — per frame in mode 1, where a plane has one colour, and per line in
 * mode 2, where each line of a plane has its own. Every frame ends up with the
 * same planes per grid cell (the export's `_PLANES` is per character), padded
 * with empty ones.
 */
export function cellsToSprite(cells: readonly SheetCell[], options: SheetSpriteOptions): SheetSpriteResult | string {
  if (!cells.length) return 'Select at least one cell.'
  const { size, mode } = options
  const maxPlanes = Math.max(1, Math.min(MAX_LAYERS, options.maxPlanes | 0))
  const cols = Math.ceil(cells[0].width / size)
  const rows = Math.ceil(cells[0].height / size)
  if (cols > MAX_GRID || rows > MAX_GRID) {
    return `A ${cells[0].width}×${cells[0].height} frame needs a ${cols}×${rows} grid of ${size}×${size} sprites; a character is at most ${MAX_GRID}×${MAX_GRID}.`
  }
  const dot = (cell: SheetCell, x: number, y: number): number =>
    x < cell.width && y < cell.height ? cell.indices[y * cell.width + x] & SPRITE_COLOR_MASK : 0

  /** One plane of one grid cell: its colour on each line, and which dots it sets. */
  type Plane = { colors: number[]; bits: boolean[] }
  const perFrame: Plane[][][] = [] // [frame][grid cell][plane]
  let merged = 0
  for (const cell of cells) {
    const grid: Plane[][] = []
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const at = (x: number, y: number): number => dot(cell, cx * size + x, cy * size + y)
        const totals = new Map<number, number>()
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const color = at(x, y)
            if (color) totals.set(color, (totals.get(color) ?? 0) + 1)
          }
        }
        const order = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([color]) => color)
        const rank = (color: number): number => order.indexOf(color)
        const planes: Plane[] = []
        const paint = (plane: number, x: number, y: number, color: number): void => {
          while (planes.length <= plane) planes.push({ colors: new Array<number>(size).fill(0), bits: new Array<boolean>(size * size).fill(false) })
          planes[plane].colors[y] = color
          planes[plane].bits[y * size + x] = true
        }
        if (mode === 1) {
          const { kept, map } = keepColours(totals, maxPlanes, options.palette, rank)
          for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
              const color = at(x, y)
              if (!color) continue
              const to = map.get(color)!
              if (to !== color) merged++
              paint(kept.indexOf(to), x, y, to)
            }
          }
          // Mode 1 colours the whole plane: fill every line with it.
          planes.forEach((plane, i) => plane.colors.fill(kept[i]))
        } else {
          for (let y = 0; y < size; y++) {
            const line = new Map<number, number>()
            for (let x = 0; x < size; x++) {
              const color = at(x, y)
              if (color) line.set(color, (line.get(color) ?? 0) + 1)
            }
            const { kept, map } = keepColours(line, maxPlanes, options.palette, rank)
            for (let x = 0; x < size; x++) {
              const color = at(x, y)
              if (!color) continue
              const to = map.get(color)!
              if (to !== color) merged++
              paint(kept.indexOf(to), x, y, to)
            }
          }
        }
        grid.push(planes)
      }
    }
    perFrame.push(grid)
  }

  // The same planes per grid cell in every frame.
  const planesIn = Array.from({ length: cols * rows }, (_, g) => Math.max(...perFrame.map((grid) => grid[g].length)))
  const frames: SpriteFrame[] = perFrame.map((grid) => {
    const layers: SpriteLayer[] = []
    for (let g = 0; g < cols * rows; g++) {
      const cx = g % cols
      const cy = Math.floor(g / cols)
      for (let p = 0; p < planesIn[g]; p++) {
        const plane = grid[g][p]
        const colors = plane?.colors ?? new Array<number>(size).fill(0)
        const firstColor = colors.find((color) => color !== 0) ?? 0
        let layer = createLayer(size, mode === 1 ? firstColor : 15, cx, cy)
        if (mode === 2) layer = { ...layer, lineColors: Array.from({ length: 16 }, (_, y) => (y < size ? colors[y] : 0)) }
        if (plane) {
          for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (plane.bits[y * size + x]) layer = setSpritePixel(layer, x, y, size, true)
        }
        layers.push(layer)
      }
    }
    // A frame with nothing at all still needs a plane to be a frame.
    return { layers: layers.length ? layers : [createLayer(size, 15)] }
  })
  let spritesPerLine = 0
  for (let cy = 0; cy < rows; cy++) {
    let line = 0
    for (let cx = 0; cx < cols; cx++) line += planesIn[cy * cols + cx]
    spritesPerLine = Math.max(spritesPerLine, line)
  }
  return { character: { name: options.name, cols, rows, frames }, spritesPerLine, merged }
}

// ── MSX2: bitmap tiles, bitmap meta-tiles, software sprites ─────────────────

/**
 * The palette entries no pixel uses, entry 0 aside (it is the transparent
 * one) — what a conversion may refill with colours of its own while every
 * entry something is drawn with stays exactly as it is. How a second sheet
 * joins a tileset or a screen without recolouring the first.
 */
export function unusedEntries(drawn: readonly ArrayLike<number>[], count = 16): number[] {
  const used = new Set<number>()
  for (const pixels of drawn) for (let i = 0; i < pixels.length; i++) used.add(pixels[i])
  return Array.from({ length: count }, (_, i) => i).filter((i) => i > 0 && !used.has(i))
}

/** A `width × height` piece of a cell at (`x`, `y`), row-major; outside the cell is 0. */
function piece(cell: SheetCell, x: number, y: number, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height)
  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      const sx = x + dx
      const sy = y + dy
      out[dy * width + dx] = sx < cell.width && sy < cell.height ? cell.indices[sy * cell.width + sx] : 0
    }
  }
  return out
}

export interface SheetBitmapTilesResult {
  doc: BitmapTilesDoc
  /** Per cell, its tiles row-major. */
  cellTiles: number[][]
  /** The cell in tiles. */
  cols: number
  rows: number
  added: number
  reused: number
  /** Set when the tileset ran out of room; `doc` is then the tileset as it was. */
  refused?: string
}

/**
 * Each cell cut into tiles of the tileset's own size — one tile when the cell
 * is that size, several when it is a multiple — each matched against what the
 * tileset already holds, to the pixel, and appended otherwise. A tile with
 * nothing in it is tile 0 when the tileset reserves it: the cell a meta-tile
 * never blits. All or nothing. `blocks` names a block per cell.
 */
export function cellsToBitmapTiles(
  tiles: BitmapTilesDoc,
  cells: readonly SheetCell[],
  blocks: readonly string[] | null = null
): SheetBitmapTilesResult | string {
  const first = cells[0]
  if (!first) return 'Select at least one cell.'
  if (first.width % tiles.width || first.height % tiles.height) {
    return (
      `The cells are ${first.width}×${first.height} and the tileset's tiles ${tiles.width}×${tiles.height}: ` +
      'a cell has to be a whole number of tiles. Change the cell size, or import into a new tileset.'
    )
  }
  const cols = first.width / tiles.width
  const rows = first.height / tiles.height
  let doc = tiles
  let added = 0
  let reused = 0
  const cellTiles: number[][] = []
  for (const cell of cells) {
    const placed: number[] = []
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        const image = piece(cell, tx * tiles.width, ty * tiles.height, tiles.width, tiles.height)
        if (doc.reserveTile0 && image.every((value) => value === 0)) {
          placed.push(0)
          continue
        }
        const found = findOrCreateBitmapTile(doc, image)
        if (!found) {
          return {
            doc: tiles,
            cellTiles: [],
            cols,
            rows,
            added: 0,
            reused: 0,
            refused: `The tileset ran out of room after ${added} new tile${added === 1 ? '' : 's'} — it holds ${MAX_BITMAP_TILES}.`
          }
        }
        if (found.doc !== doc) added++
        else reused++
        doc = found.doc
        placed.push(found.index)
      }
    }
    cellTiles.push(placed)
  }
  if (blocks) {
    const named: TileBlock[] = cellTiles.map((placed, i) => ({ name: blocks[i] ?? `block_${doc.blocks.length + i}`, width: cols, height: rows, tiles: placed }))
    doc = { ...doc, blocks: [...doc.blocks, ...named] }
  }
  return { doc, cellTiles, cols, rows, added, reused }
}

/**
 * One frame per cell, as a bitmap meta-tile drawn with `tiles` (whose path is
 * `tileset`): each frame's tiles found or made there, as `cellsToBitmapTiles`
 * does. The meta and the grown tileset come back together; neither is any use
 * without the other.
 */
export function cellsToBitmapMeta(
  tiles: BitmapTilesDoc,
  tileset: string,
  cells: readonly SheetCell[]
): { meta: MetaTileDoc; tiles: BitmapTilesDoc; added: number } | string {
  const made = cellsToBitmapTiles(tiles, cells)
  if (typeof made === 'string') return made
  if (made.refused) return made.refused
  if (made.cols > MAX_META_SIZE || made.rows > MAX_META_SIZE) {
    return `A ${made.cols}×${made.rows}-tile cell is too big for a meta-tile, which is at most ${MAX_META_SIZE}×${MAX_META_SIZE} tiles.`
  }
  const meta: MetaTileDoc = { ...createMetaTileDoc(tileset, made.cols, made.rows), frames: made.cellTiles.map((placed) => ({ tiles: placed })) }
  return { meta, tiles: made.doc, added: made.added }
}

/**
 * One frame per cell, as a software-sprite character: each cell padded to the
 * mode's size step (whole bytes in a bitmap mode, whole 8×8 cells in a tiled
 * one), transparent dots as the sheet's `transparent` index.
 */
export function cellsToSwSprite(mode: SwMode, cells: readonly SheetCell[], name: string, transparent = 0): SwSpriteChar | string {
  const first = cells[0]
  if (!first) return 'Select at least one cell.'
  const { width, height } = snapSize(mode, first.width, first.height)
  if (width > MAX_SW_SIZE || height > MAX_SW_SIZE) return `A ${width}×${height} frame is past a software sprite's ${MAX_SW_SIZE}×${MAX_SW_SIZE}.`
  if (cells.length > MAX_SW_FRAMES) return `${cells.length} frames; a software sprite holds at most ${MAX_SW_FRAMES}.`
  const per = width * height
  const pixels = new Uint8Array(per * cells.length)
  cells.forEach((cell, n) => {
    const frame = piece(cell, 0, 0, width, height)
    for (let i = 0; i < per; i++) pixels[n * per + i] = frame[i] === 0 ? transparent : frame[i]
  })
  return { name, width, height, frames: cells.length, pixels: encodeIndices(pixels) }
}
