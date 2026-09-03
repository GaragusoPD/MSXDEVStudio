# Tiled-mode screen editor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Paint pixels directly on a SCREEN 1/2/4 map — touch up an imported screen, edit part of a hand-built map, or draw one from scratch.

**Architecture:** Extract `meta-paint.ts`'s stroke core as `paintGrid` over a plain `{width, height, tiles}` grid, which `MapLayer.data` already satisfies. `paintMeta` becomes a wrapper, so the meta editor is provably unchanged. Painting joins the map editor as a mode beside stamping; a second allocator puts forked tiles in the row's own bank instead of the shared region.

**Tech Stack:** TypeScript, Vue 3, Pinia, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-03-tiled-screen-editor-design.md`

## Global Constraints

- **Branch:** `feat/tiled-screen-editor`, off `main` at `21f4b6e`.
- **`findOrCreateTile` must not change behaviour.** Meta-tiles depend on its shared-region allocation: one index means one picture in every bank, which is what lets `_DrawPlacements` stay bank-unaware. Bank-local allocation is a *second* function beside it.
- **The gate is `npm run check`** (lint + typecheck). Every task ends green.
- **Do NOT run the real-MSXgl compile tests.** This machine HAS a checkout at `~/Applications/MSXgl`, so they do **not** auto-skip. Exclude them explicitly: append `-t '^(?!.*generated headers compile into a ROM).+$'` to any vitest run that would reach `src/main/services/resources.test.ts`.
- **Vitest covers `src/shared/`, `src/main/`, `renderer/src/stores`, and `renderer/src/editors/*/session.ts`.** `.vue` files and `sheet.ts` are NOT covered — no logic may live there. Every offset and hit test is computed in `session.ts`.
- **Fixtures must not be uniform.** Banked fixtures use banks at *different* lengths with a non-zero `sharedTiles`. Four defects on the banking branch survived review because fixtures were dense.
- `TILE_SIZE` is 8, `MAX_TILES` is 256, `BANK_COUNT` is 3, `SCREEN_ROWS` is 24 — all from `src/shared/msx/tile.ts` and `src/shared/msx/map.ts`.

---

### Task 1: `paintGrid` — extract the core, prove `paintMeta` unchanged

**Files:**
- Modify: `src/shared/msx/meta-paint.ts`
- Test: `src/shared/msx/meta-paint.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PaintGrid` (`{ width: number; height: number; tiles: number[] }`), `PaintGridResult`, and `paintGrid(grid, tiles, points, color, role?, options?)`. Task 2 adds `options.write`; Task 3 adds `options.bankOf`; Task 5 calls it.

`paintMeta` today reads `meta.width`/`meta.height`, reads the current tile at `meta.frames[frame].tiles[key]`, and writes through `setFrameTile`. That is a grid interface. Extract it verbatim — no behaviour change in this task.

- [ ] **Step 1: Write the failing test**

```ts
// src/shared/msx/meta-paint.test.ts
import { describe, expect, it } from 'vitest'
import { createTilesDoc } from './tile'
import { paintGrid } from './meta-paint'

describe('paintGrid', () => {
  it('paints a dot into a plain grid and forks a tile for it', () => {
    const tiles = createTilesDoc('sc2', 1)
    const grid = { width: 2, height: 1, tiles: [0, 0] }

    const result = paintGrid(grid, tiles, [{ x: 1, y: 1 }], 7)

    // The painted cell repoints; its neighbour does not.
    expect(result.grid.tiles[0]).not.toBe(0)
    expect(result.grid.tiles[1]).toBe(0)
    expect(result.added).toEqual([result.grid.tiles[0]])
    expect(result.refused).toBeUndefined()
  })

  it('ignores points outside the grid, so a drag off-canvas needs no clamping', () => {
    const tiles = createTilesDoc('sc2', 1)
    const grid = { width: 1, height: 1, tiles: [0] }

    const result = paintGrid(grid, tiles, [{ x: 99, y: 0 }, { x: -1, y: 0 }], 7)

    expect(result.grid).toBe(grid)
    expect(result.tiles).toBe(tiles)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/msx/meta-paint.test.ts -t 'paintGrid'`
Expected: FAIL — `paintGrid` is not exported from `./meta-paint`.

- [ ] **Step 3: Extract the core**

In `src/shared/msx/meta-paint.ts`, add above `paintMeta`:

```ts
/** A grid of tile references: a meta's frame, or a map layer's `data`. */
export interface PaintGrid {
  width: number
  height: number
  tiles: number[]
}

export interface PaintGridResult {
  grid: PaintGrid
  tiles: TilesDoc
  /** Indices appended by this stroke — what Compact would reclaim if it is undone. */
  added: number[]
  /** Points the hardware colour limit refused. Reported, never fatal. */
  dropped: number
  /** Set when nothing could be done at all; `grid` and `tiles` come back unchanged. */
  refused?: string
}

/**
 * Applies a stroke to a grid of tile references, resolving each touched cell
 * copy-on-write into `tiles`.
 *
 * Points are in the grid's own pixel space — `(0,0)` is its top-left dot, not
 * the tile's. Points outside it are ignored, so a drag that leaves the canvas
 * needs no clamping by the caller.
 *
 * `role` is which half of the row's colour pair the stroke owns — the mouse
 * button, as in the tile editor. sc2/sc4 hold two colours per 8×1 row and sc1
 * two per group of eight tiles: without a role the second colour a row is asked
 * for is dropped, which reads as an editor that stopped working.
 */
export function paintGrid(
  grid: PaintGrid,
  tiles: TilesDoc,
  points: readonly Point[],
  color: number,
  role?: 'fg' | 'bg'
): PaintGridResult {
  // Grouped by cell so each tile is derived once, however many points hit it.
  const byCell = new Map<number, Point[]>()
  for (const point of points) {
    const cx = Math.floor(point.x / TILE_SIZE)
    const cy = Math.floor(point.y / TILE_SIZE)
    if (point.x < 0 || point.y < 0 || cx >= grid.width || cy >= grid.height) continue
    const key = cy * grid.width + cx
    const list = byCell.get(key)
    if (list) list.push(point)
    else byCell.set(key, [point])
  }
  if (!byCell.size) return { grid, tiles, added: [], dropped: 0 }

  let nextTiles = tiles
  let nextCells: number[] | null = null
  const added: number[] = []
  let dropped = 0

  for (const [key, cellPoints] of byCell) {
    let work = scratch(nextTiles, (nextCells ?? grid.tiles)[key] ?? 0)
    for (const point of cellPoints) {
      const result = paintPixel(work, 0, point.x % TILE_SIZE, point.y % TILE_SIZE, color, role)
      // Only reachable without a role. With one, `paintPixel` recolours that
      // role for the row and can never refuse.
      if (!result.ok) {
        dropped++
        continue
      }
      work = result.doc
    }

    const pair = nextTiles.mode === 'sc1' ? work.groupColors[0] : undefined
    const found = findOrCreateTile(nextTiles, canonical(work), pair)
    if (!found) {
      // A half-drawn stroke against a full bank is worse than no change at all.
      return {
        grid,
        tiles,
        added: [],
        dropped: 0,
        refused:
          `The tileset is full — ${MAX_TILES} tiles is the hardware limit. ` +
          'Run "Compact unused tiles", or free a tile in the tile editor.'
      }
    }
    // An unbanked allocation appends at `count`, so an index beyond the old
    // count is new. A banked allocation takes from the shared top (count stays
    // 256), so it is detected by `sharedTiles` growing.
    if (found.index >= nextTiles.count || found.doc.sharedTiles > nextTiles.sharedTiles)
      added.push(found.index)
    nextTiles = found.doc
    if (!nextCells) nextCells = grid.tiles.slice()
    nextCells[key] = found.index
  }

  return {
    grid: nextCells ? { ...grid, tiles: nextCells } : grid,
    tiles: nextTiles,
    added,
    dropped
  }
}
```

- [ ] **Step 4: Rewrite `paintMeta` as a wrapper**

Replace `paintMeta`'s body (keep its exported signature and doc comment exactly as they are) with:

```ts
  const frameTiles = meta.frames[frame]
  if (!frameTiles) return { meta, tiles, added: [], dropped: 0 }

  const result = paintGrid(
    { width: meta.width, height: meta.height, tiles: frameTiles.tiles },
    tiles,
    points,
    color,
    role
  )
  if (result.refused) return { meta, tiles, added: [], dropped: 0, refused: result.refused }
  if (result.grid.tiles === frameTiles.tiles) return { meta, tiles, added: [], dropped: 0 }

  const frames = meta.frames.slice()
  frames[frame] = { tiles: result.grid.tiles }
  return { meta: { ...meta, frames }, tiles: result.tiles, added: result.added, dropped: result.dropped }
```

`setFrameTile` is no longer called from `paintMeta`; leave the function itself alone — `meta/session.ts` uses it elsewhere.

- [ ] **Step 5: Run the full meta-paint suite — this is the refactor proof**

Run: `npx vitest run src/shared/msx/meta-paint.test.ts src/renderer/src/editors/meta`
Expected: PASS, with **no test file edited except the two `paintGrid` cases added in Step 1**. Every pre-existing `paintMeta` assertion passing unchanged is what proves the extraction is behaviour-preserving. If any pre-existing test needs editing, stop and report — the extraction is wrong.

- [ ] **Step 6: Commit**

```bash
npm run check
git add src/shared/msx/meta-paint.ts src/shared/msx/meta-paint.test.ts
git commit -m "refactor(paint): paintMeta is a wrapper over a grid-shaped core"
```

---

### Task 2: `write: 'edit'` — rewrite a tile in place

**Files:**
- Modify: `src/shared/msx/meta-paint.ts`
- Test: `src/shared/msx/meta-paint.test.ts`

**Interfaces:**
- Consumes: `paintGrid`, `PaintGridResult` (Task 1).
- Produces: `PaintOptions` (`{ write?: 'fork' | 'edit' }`) as `paintGrid`'s 6th parameter, and `PaintGridResult.tileEdits: { index: number; before: TileEntry }[]`. Task 4 stores `tileEdits`; Task 5 passes `write`.

`'fork'` (the default) is Task 1's behaviour. `'edit'` writes the derived entry back at the cell's *current* index: no allocation, works on a full tileset, and changes that tile for every cell and every map using it.

- [ ] **Step 1: Write the failing test**

```ts
  it("edit mode rewrites the cell's own tile and repoints nothing", () => {
    const tiles = createTilesDoc('sc2', 4)
    const grid = { width: 2, height: 1, tiles: [2, 2] }

    const result = paintGrid(grid, tiles, [{ x: 1, y: 1 }], 7, undefined, { write: 'edit' })

    // Both cells still point at tile 2 — and both now show the new art.
    expect(result.grid.tiles).toEqual([2, 2])
    expect(result.tiles.tiles[2]).not.toEqual(tiles.tiles[2])
    expect(result.added).toEqual([])
    expect(result.tiles.count).toBe(tiles.count)
  })

  it('edit mode records the entry it overwrote, so undo can restore it', () => {
    const tiles = createTilesDoc('sc2', 4)
    const grid = { width: 1, height: 1, tiles: [2] }

    const result = paintGrid(grid, tiles, [{ x: 1, y: 1 }], 7, undefined, { write: 'edit' })

    expect(result.tileEdits).toHaveLength(1)
    expect(result.tileEdits[0].index).toBe(2)
    expect(result.tileEdits[0].before).toEqual(tiles.tiles[2])
  })

  it('edit mode never refuses on a full tileset, because it allocates nothing', () => {
    const full = createTilesDoc('sc2', MAX_TILES)
    const grid = { width: 1, height: 1, tiles: [5] }

    const result = paintGrid(grid, full, [{ x: 0, y: 0 }], 7, undefined, { write: 'edit' })

    expect(result.refused).toBeUndefined()
    expect(result.tiles.tiles[5]).not.toEqual(full.tiles[5])
  })

  it('fork mode records no tileEdits', () => {
    const tiles = createTilesDoc('sc2', 4)
    const grid = { width: 1, height: 1, tiles: [2] }

    const result = paintGrid(grid, tiles, [{ x: 0, y: 0 }], 7)

    expect(result.tileEdits).toEqual([])
  })
```

Add `MAX_TILES` to the existing `./tile` import in the test file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/shared/msx/meta-paint.test.ts -t 'edit mode'`
Expected: FAIL — `paintGrid` takes no 6th argument and `PaintGridResult` has no `tileEdits`.

- [ ] **Step 3: Implement**

Add to `meta-paint.ts`:

```ts
/** One tile's pixels as they were before an `edit` stroke overwrote them. */
export interface TileEdit {
  index: number
  before: TileEntry
}

export interface PaintOptions {
  /**
   * `fork` (default) derives the new art and find-or-creates it, repointing
   * only this cell — copy-on-write, and what a meta must always do.
   *
   * `edit` rewrites the tile at the cell's current index. It allocates nothing
   * and cannot refuse, and it changes that tile for **every** cell and every
   * map that uses it. `tileEdits` carries the inverse so undo can restore it.
   */
  write?: 'fork' | 'edit'
}
```

Add `tileEdits: TileEdit[]` to `PaintGridResult` (non-optional; `[]` in every return).

In `paintGrid`, take `options: PaintOptions = {}` as the 6th parameter and add `const tileEdits: TileEdit[] = []` beside `added`. Replace the `findOrCreateTile` block with:

```ts
    const entry = canonical(work)
    if (options.write === 'edit') {
      const index = (nextCells ?? grid.tiles)[key] ?? 0
      const before = nextTiles.tiles[index]
      // A cell pointing past the end of the bank has nothing to rewrite;
      // falling through to fork is the only honest thing left.
      if (before) {
        if (!tileEdits.some((edit) => edit.index === index)) tileEdits.push({ index, before })
        const written = nextTiles.tiles.slice()
        written[index] = entry
        nextTiles = { ...nextTiles, tiles: written }
        continue
      }
    }

    const pair = nextTiles.mode === 'sc1' ? work.groupColors[0] : undefined
    const found = findOrCreateTile(nextTiles, entry, pair)
```

Return `tileEdits` from every exit, and `[]` from the refusal and early-return paths.

Note the `continue` skips the cell-repointing tail, which is correct: an `edit` stroke changes pixels, never references.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/shared/msx/meta-paint.test.ts src/renderer/src/editors/meta`
Expected: PASS. `paintMeta` still passes unchanged — it never sets `write`, so it always forks.

- [ ] **Step 5: Commit**

```bash
npm run check
git add src/shared/msx/meta-paint.ts src/shared/msx/meta-paint.test.ts
git commit -m "feat(paint): an edit stroke rewrites the tile instead of forking one"
```

---

### Task 3: bank-local allocation

**Files:**
- Modify: `src/shared/msx/meta-paint.ts`
- Test: `src/shared/msx/meta-paint.test.ts`

**Interfaces:**
- Consumes: `paintGrid`, `PaintOptions` (Tasks 1–2).
- Produces: `findOrCreateBankTile(doc, bank, entry, pair?)` returning `{ doc: TilesDoc; index: number } | null`, and `PaintOptions.bankOf?: (cellRow: number) => number`. Task 5 passes `bankOf`.

`findOrCreateTile` allocates into the **shared** region on a banked tileset, so one index means one picture in every bank. Meta-tiles need that. A screen does not: painting row 3 needs art in bank 0 only, and a shared slot costs a slot in all three banks. **Do not change `findOrCreateTile`.**

- [ ] **Step 1: Write the failing test**

```ts
describe('findOrCreateBankTile', () => {
  /** Banks at different lengths and a real shared region — a uniform fixture proves nothing. */
  function banked(): TilesDoc {
    const solid = (byte: number) => ({
      pattern: new Array(8).fill(byte),
      color: new Array(8).fill(mergeColorByte(15, 4))
    })
    return normalizeTiles({
      mode: 'sc2',
      count: 2,
      tiles: [solid(0x11), solid(0x22)],
      bankTiles: [[solid(0x33), solid(0x44), solid(0x55)], [solid(0x66)], []],
      sharedTiles: 2
    })
  }

  it('appends into the named bank and leaves the other two alone', () => {
    const doc = banked()
    const entry = { pattern: new Array(8).fill(0x7e), color: new Array(8).fill(mergeColorByte(15, 4)) }

    const found = findOrCreateBankTile(doc, 0, entry)

    expect(found).not.toBeNull()
    expect(found!.index).toBe(3)                       // bank 0 held 3 entries
    expect(found!.doc.bankTiles[0]).toHaveLength(4)
    expect(found!.doc.bankTiles[1]).toHaveLength(1)    // untouched
    expect(found!.doc.bankTiles[2]).toHaveLength(0)    // untouched
    expect(found!.doc.sharedTiles).toBe(2)             // shared budget not spent
  })

  it('reuses an identical tile already in that bank rather than appending', () => {
    const doc = banked()
    const found = findOrCreateBankTile(doc, 0, doc.bankTiles[0][1])

    expect(found!.index).toBe(1)
    expect(found!.doc).toBe(doc)
  })

  it('finds the shared region too, since every bank shows it', () => {
    const doc = banked()
    const sharedIndex = MAX_TILES - doc.sharedTiles
    const found = findOrCreateBankTile(doc, 1, doc.tiles[sharedIndex])

    expect(found!.index).toBe(sharedIndex)
    expect(found!.doc).toBe(doc)
  })

  it('returns null when that bank is full, without touching the others', () => {
    const solid = (byte: number) => ({
      pattern: new Array(8).fill(byte),
      color: new Array(8).fill(mergeColorByte(15, 4))
    })
    const doc = normalizeTiles({
      mode: 'sc2',
      count: 1,
      bankTiles: [Array.from({ length: MAX_TILES - 2 }, (_, i) => solid(i & 0xff)), [], []],
      sharedTiles: 2
    })
    const entry = { pattern: new Array(8).fill(0x7e), color: new Array(8).fill(mergeColorByte(15, 4)) }

    expect(findOrCreateBankTile(doc, 0, entry)).toBeNull()
  })
})
```

Import `normalizeTiles`, `mergeColorByte`, `MAX_TILES` from `./tile` in the test file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/shared/msx/meta-paint.test.ts -t 'findOrCreateBankTile'`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement the allocator**

```ts
/**
 * The index of a tile identical to `entry` **in `bank`'s view**, appending to
 * that bank's own overrides when it has none.
 *
 * The sibling of `findOrCreateTile` for painting a screen. That one allocates
 * into the shared region, which every bank sees — right for a meta-tile, whose
 * index must mean one picture wherever it is drawn. A screen cell is read in
 * its row's bank only, so paying a slot in all three banks for it wastes the
 * scarcest resource the tileset has.
 *
 * The search still reaches the shared region: those tiles show in this bank
 * too, so reusing one is free and correct.
 *
 * Null means that bank is full. `bankCapacityLeft` is the ceiling, not policy.
 */
export function findOrCreateBankTile(
  doc: TilesDoc,
  bank: number,
  entry: TileEntry,
  pair?: number
): { doc: TilesDoc; index: number } | null {
  const sc1 = doc.mode === 'sc1'
  for (let i = 0; i < MAX_TILES; i++) {
    const candidate = bankTileAt(doc, bank, i)
    if (!sameEntry(candidate, entry)) continue
    if (sc1 && doc.groupColors[i >> SC1_SHIFT] !== pair) continue
    // Only a slot the bank or the common set actually fills is a real match —
    // `bankTileAt` answers `blankTileEntry` for everything past both.
    const own = doc.bankTiles[bank]?.[i]
    if (!own && i >= doc.count && i < MAX_TILES - doc.sharedTiles) continue
    return { doc, index: i }
  }

  if (bankCapacityLeft(doc, bank) <= 0) return null
  const index = doc.bankTiles[bank]?.length ?? 0
  const grown = (doc.bankTiles[bank] ?? []).slice()
  // Slots below `index` that the bank did not have are seeded from what that
  // bank already showed, so nothing the user is not looking at changes.
  for (let i = grown.length; i < index; i++) grown[i] = bankTileAt(doc, bank, i)
  grown[index] = { pattern: entry.pattern.slice(), color: entry.color.slice() }
  const bankTiles = doc.bankTiles.slice()
  bankTiles[bank] = grown
  return { doc: { ...doc, bankTiles }, index }
}
```

Import `bankTileAt` and `bankCapacityLeft` from `./tile`.

- [ ] **Step 4: Wire `bankOf` into `paintGrid`**

Add to `PaintOptions`:

```ts
  /**
   * Which bank a cell row is drawn in — `bankForRow`, wrapped by `SCREEN_ROWS`
   * by the caller. Takes the **cell** row (`point.y / TILE_SIZE`), not the pixel
   * row. Omitted for a meta, whose tiles must mean one picture in every bank.
   */
  bankOf?: (cellRow: number) => number
```

In `paintGrid`'s fork path, replace the `findOrCreateTile` call with:

```ts
    const bank = options.bankOf && isBanked(nextTiles) ? options.bankOf(cy) : null
    const found =
      bank === null
        ? findOrCreateTile(nextTiles, entry, pair)
        : findOrCreateBankTile(nextTiles, bank, entry, pair)
```

`cy` is already computed for the key; keep it in the map value or recompute it as `Math.floor(key / grid.width)`. Make the refusal message name the bank when one was used:

```ts
        refused:
          bank === null
            ? `The tileset is full — ${MAX_TILES} tiles is the hardware limit. ` +
              'Run "Compact unused tiles", or free a tile in the tile editor.'
            : `Bank ${bank} is full — ${MAX_TILES} tiles is the hardware limit for one bank. ` +
              'Free a tile, or paint on a row served by another bank.'
```

The `added` detection must also cover a bank append, which grows neither `count` nor `sharedTiles`:

```ts
    const grew = bank === null
      ? found.index >= nextTiles.count || found.doc.sharedTiles > nextTiles.sharedTiles
      : (found.doc.bankTiles[bank]?.length ?? 0) > (nextTiles.bankTiles[bank]?.length ?? 0)
    if (grew) added.push(found.index)
```

- [ ] **Step 5: Test the wiring**

```ts
  it('paintGrid with bankOf allocates into the row that was painted', () => {
    const solid = (byte: number) => ({
      pattern: new Array(8).fill(byte),
      color: new Array(8).fill(mergeColorByte(15, 4))
    })
    const tiles = normalizeTiles({
      mode: 'sc2',
      count: 1,
      bankTiles: [[solid(0x11)], [solid(0x22), solid(0x33)], []],
      sharedTiles: 1
    })
    // A 32-wide grid; cell row 9 is bank 1.
    const grid = { width: 32, height: 24, tiles: new Array(32 * 24).fill(0) }

    const result = paintGrid(grid, tiles, [{ x: 0, y: 9 * 8 }], 7, undefined, {
      bankOf: (row) => row >> 3
    })

    expect(result.tiles.bankTiles[1]).toHaveLength(3)   // grew
    expect(result.tiles.bankTiles[0]).toHaveLength(1)   // untouched
    expect(result.tiles.sharedTiles).toBe(1)            // shared budget not spent
    expect(result.grid.tiles[9 * 32]).toBe(2)           // bank-local index
  })

  it('without bankOf a banked tileset still allocates shared, as a meta needs', () => {
    const solid = (byte: number) => ({
      pattern: new Array(8).fill(byte),
      color: new Array(8).fill(mergeColorByte(15, 4))
    })
    const tiles = normalizeTiles({ mode: 'sc2', count: 1, bankTiles: [[solid(0x11)], [], []], sharedTiles: 1 })
    const grid = { width: 1, height: 1, tiles: [0] }

    const result = paintGrid(grid, tiles, [{ x: 0, y: 0 }], 7)

    expect(result.tiles.sharedTiles).toBe(2)
    expect(result.tiles.bankTiles[0]).toHaveLength(1)
  })
```

Run: `npx vitest run src/shared/msx/meta-paint.test.ts src/renderer/src/editors/meta`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npm run check
git add src/shared/msx/meta-paint.ts src/shared/msx/meta-paint.test.ts
git commit -m "feat(paint): a screen's stroke allocates in its own row's bank"
```

---

### Task 4: map history carries the inverse of an edit stroke

**Files:**
- Modify: `src/shared/map-editor.ts`, `src/renderer/src/editors/map/session.ts`
- Test: `src/shared/map-editor.test.ts`

**Interfaces:**
- Consumes: `TileEdit` (Task 2).
- Produces: `MapEntry` (`{ doc: MapDoc; tileEdits?: TileEdit[] }`), `MapHistory = History<MapEntry>`, and `commit(session, next, tileEdits?)`. Task 5 passes `tileEdits`.

`History<T>` is already generic, so this instantiates it with a richer `T` rather than adding a history module. A `fork` stroke records nothing new — copy-on-write only appends, so undo can leak art but never lose it. An `edit` stroke changes pixels and may not touch the grid at all, so without the inverse its undo would do nothing and the change would be permanent.

- [ ] **Step 1: Write the failing test**

```ts
// src/shared/map-editor.test.ts
import { createHistory, pushHistory, undo } from './history'
import type { MapEntry } from './map-editor'

it('a history entry can carry the tiles an edit stroke overwrote', () => {
  const before = { pattern: new Array(8).fill(0x11), color: new Array(8).fill(0xf1) }
  const base: MapEntry = { doc: createMapDoc('res/t.tiles.json') }
  const history = pushHistory(createHistory(base), {
    doc: base.doc,
    tileEdits: [{ index: 4, before }]
  })

  expect(history.present.tileEdits).toEqual([{ index: 4, before }])
  expect(undo(history).present.tileEdits).toBeUndefined()
})
```

Import `createMapDoc` from `./msx/map`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/map-editor.test.ts -t 'edit stroke overwrote'`
Expected: FAIL — `MapEntry` is not exported.

- [ ] **Step 3: Change the history's element type**

In `src/shared/map-editor.ts`, replace `export type MapHistory = History<MapDoc>` with:

```ts
/**
 * One undo step: the map, plus the tiles an `edit` stroke overwrote to get
 * here. `tileEdits` is absent on every step that only moved cell references —
 * a `fork` stroke appends to the bank and never destroys art, so it needs no
 * inverse (its orphans are Compact's job, exactly as in the meta editor).
 */
export interface MapEntry {
  doc: MapDoc
  tileEdits?: TileEdit[]
}

export type MapHistory = History<MapEntry>
```

Import `type TileEdit` from `./msx/meta-paint`.

- [ ] **Step 4: Follow the type through `map/session.ts`**

Every `session.history.present` now yields a `MapEntry`. Change:

```ts
export function doc(session: MapSession): MapDoc {
  return session.history.present.doc
}

export function commit(session: MapSession, next: MapDoc, tileEdits?: TileEdit[]): void {
  const entry: MapEntry = tileEdits?.length ? { doc: next, tileEdits } : { doc: next }
  // `pushHistory` compares by reference, and a fresh object is never the
  // present — so guard on the document itself, or every no-op stroke would
  // push an undo step.
  if (next === session.history.present.doc && !tileEdits?.length) return
  session.history = pushHistory(session.history, entry)
  markDirty(session)
}
```

Initialise the history with `createHistory({ doc })` wherever it is created. Run `npm run typecheck:web` and fix each error it points at — they are all this one change.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/shared/map-editor.test.ts src/renderer/src/editors/map src/renderer/src/stores`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npm run check
git add src/shared/map-editor.ts src/shared/map-editor.test.ts src/renderer/src/editors/map/session.ts
git commit -m "refactor(map): an undo step is a document plus what it overwrote"
```

---

### Task 5: paint mode in the map session

**Files:**
- Modify: `src/renderer/src/editors/map/session.ts`
- Test: `src/renderer/src/editors/map/session.test.ts`

**Interfaces:**
- Consumes: `paintGrid`, `PaintOptions` (Tasks 1–3); `commit(session, next, tileEdits?)` (Task 4); `bankSheetOffset` (already present).
- Produces: `session.mode`, `session.paintTool`, `session.paintColor`, `session.paintWrite`; `setMode`, `setPaintTool`, `setPaintColor`, `setPaintWrite`, `paintStroke(session, from, to, role)`, `paintBankOf(session)`, `paintBudgetLabel(session)`. Tasks 6–7 call these.

This is the layer vitest actually covers, so all of it lives here and none of it in a `.vue`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/renderer/src/editors/map/session.test.ts
describe('paint mode', () => {
  it('starts in tiles mode, so an existing map behaves exactly as before', () => {
    const session = openTestSession()   // the file's existing helper
    expect(session.mode).toBe('tiles')
  })

  it('a fork stroke repoints one cell and leaves its neighbour alone', () => {
    const session = openTestSession()
    setMode(session, 'paint')
    setPaintWrite(session, 'fork')

    paintStroke(session, { x: 1, y: 1 }, { x: 1, y: 1 }, 'fg')

    const layer = doc(session).layers[session.activeLayer]
    expect(layer.data[0]).not.toBe(0)
    expect(layer.data[1]).toBe(0)
  })

  it('an edit stroke records the inverse in history, so undo restores the pixels', () => {
    const session = openTestSession()
    setMode(session, 'paint')
    setPaintWrite(session, 'edit')
    const store = useTilesetStore()
    const beforeArt = store.patternDoc(doc(session).tileset)!.tiles[0]

    paintStroke(session, { x: 1, y: 1 }, { x: 1, y: 1 }, 'fg')
    expect(store.patternDoc(doc(session).tileset)!.tiles[0]).not.toEqual(beforeArt)

    undoSession(session)
    expect(store.patternDoc(doc(session).tileset)!.tiles[0]).toEqual(beforeArt)
  })

  it('paintBankOf is null unbanked, and wraps by SCREEN_ROWS when banked', () => {
    const session = openTestSession()
    expect(paintBankOf(session)).toBeNull()

    setBankedTileset(session)          // helper: three uneven banks, sharedTiles 2
    const bankOf = paintBankOf(session)!
    expect(bankOf(0)).toBe(0)
    expect(bankOf(9)).toBe(1)
    expect(bankOf(17)).toBe(2)
    // A taller-than-one-screen map is editable even though export refuses it.
    expect(bankOf(25)).toBe(0)
  })

  it('a refused stroke changes nothing and says why', () => {
    const session = openTestSession()
    fillTilesetToCapacity(session)     // helper: count = MAX_TILES
    setMode(session, 'paint')
    setPaintWrite(session, 'fork')
    const before = doc(session)

    paintStroke(session, { x: 1, y: 1 }, { x: 1, y: 1 }, 'fg')

    expect(doc(session)).toBe(before)
    expect(session.status).toContain('full')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/editors/map/session.test.ts -t 'paint mode'`
Expected: FAIL — none of these exports exist.

- [ ] **Step 3: Add the session state**

To `MapSession`:

```ts
  /** Which tool set is live. UI state, not a history step — like `session.bank` in the tile editor. */
  mode: 'tiles' | 'paint'
  paintTool: TileTool
  paintColor: number
  /** Per-stroke, because neither is a safe default: see the spec's write-mode table. */
  paintWrite: 'fork' | 'edit'
```

Initialise to `'tiles'`, `'pencil'`, `1`, `'fork'`. Add the four plain setters.

- [ ] **Step 4: Implement the stroke**

```ts
/**
 * Which bank a cell row is drawn in, or null when the tileset is not banked.
 *
 * Wrapped by `SCREEN_ROWS` for the same reason `bankSheetOffset` is: a map
 * taller than one screen is editable in progress even though `validateMap`
 * refuses it at export, and an unwrapped row would index a bank that does not
 * exist.
 */
export function paintBankOf(session: MapSession): ((cellRow: number) => number) | null {
  const tileset = session.tileset
  if (!tileset || !isBanked(tileset)) return null
  return (cellRow: number) => bankForRow(cellRow % SCREEN_ROWS)
}

/** Applies one paint stroke to the active layer, resolving it into the tileset. */
export function paintStroke(session: MapSession, from: Point, to: Point, role: 'fg' | 'bg'): void {
  const tileset = session.tileset
  const current = doc(session)
  const layer = current.layers[session.activeLayer]
  if (!tileset || !layer) return

  const points = toolPoints(session.paintTool, from, to, [], session.filledRect)
  const result = paintGrid(
    { width: current.width * TILE_SIZE, height: current.height * TILE_SIZE, tiles: layer.data },
    tileset,
    points,
    session.paintColor,
    role,
    { write: session.paintWrite, bankOf: paintBankOf(session) ?? undefined }
  )
  if (result.refused) {
    session.status = result.refused
    return
  }

  const layers = current.layers.slice()
  layers[session.activeLayer] = { ...layer, data: result.grid.tiles }
  useTilesetStore().set(current.tileset, result.tiles, session.path)
  commit(session, { ...current, layers }, result.tileEdits)
  session.status = result.dropped
    ? `${result.dropped} pixel${result.dropped === 1 ? '' : 's'} dropped: colour limit`
    : ''
}
```

`paintGrid`'s grid is in **pixels** (`width * TILE_SIZE`), while `layer.data` is indexed in **cells** — that is exactly the meta's own relationship between its pixel space and `frames[frame].tiles`, and `paintGrid` already divides by `TILE_SIZE` to get the cell. Passing `current.width` here instead would silently paint into the wrong cells; the Task 3 wiring test is what catches it.

- [ ] **Step 5: Undo restores the pixels**

In the map session's `undo`, before applying the history step:

```ts
export function undoSession(session: MapSession): void {
  if (!canUndo(session.history)) return
  // The step being left behind is the one whose pixel writes must be reversed.
  const leaving = session.history.present
  session.history = undo(session.history)
  restoreTileEdits(session, leaving.tileEdits)
  markDirty(session)
}

/** Puts back the tiles an `edit` stroke overwrote — for every map using them, as the stroke was. */
function restoreTileEdits(session: MapSession, edits: TileEdit[] | undefined): void {
  if (!edits?.length) return
  const store = useTilesetStore()
  const path = doc(session).tileset
  const tileset = store.patternDoc(path)
  if (!tileset) return
  const tiles = tileset.tiles.slice()
  for (const edit of edits) tiles[edit.index] = edit.before
  store.set(path, { ...tileset, tiles }, session.path)
}
```

Redo re-applies by painting forward: on redo, capture the *current* entries at those indices as the new inverse and write the redone step's art back. Implement `redoSession` symmetrically, swapping which entry is captured.

- [ ] **Step 6: The budget readout**

```ts
/** `tiles: 137/256`, or the per-bank form when banked. Reuses the tile editor's label. */
export function paintBudgetLabel(session: MapSession): string {
  const tileset = session.tileset
  if (!tileset) return ''
  if (!isBanked(tileset)) return `tiles: ${tileset.count}/${MAX_TILES}`
  return tileset.bankTiles
    .map((bank, index) => `bank ${index}: ${bank.length + tileset.sharedTiles}/${MAX_TILES}`)
    .join('   ')
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/editors/map src/renderer/src/stores src/shared`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
npm run check
git add src/renderer/src/editors/map/session.ts src/renderer/src/editors/map/session.test.ts
git commit -m "feat(map): a paint mode that resolves strokes into the tileset"
```

---

### Task 6: the canvas paint path, in its own component

**Files:**
- Create: `src/renderer/src/editors/map/MapPaintLayer.vue`
- Modify: `src/renderer/src/editors/map/MapCanvas.vue`

**Interfaces:**
- Consumes: `paintStroke`, `session.mode`, `session.paintTool` (Task 5).
- Produces: nothing other tasks depend on.

`MapCanvas.vue` is already the largest file in this directory and this adds a second input path. Split rather than grow — and per the Global Constraints no logic may live in either file, because vitest does not cover them.

- [ ] **Step 1: Create `MapPaintLayer.vue`**

A component taking `session` as its only prop, rendering a transparent overlay over the canvas that:
- converts a pointer event to a **dot**: `{ x: Math.floor(offsetX / zoom * TILE_SIZE / cellPx), y: ... }` using the same zoom the canvas already exposes — compute the divisor once and pass it in as a prop rather than deriving geometry twice;
- tracks a drag as `from`/`to` and calls `paintStroke(session, from, to, role)` on move and on release, with `role` = `'bg'` when `event.button === 2` or `event.buttons & 2`, else `'fg'` — the same convention as the tile editor;
- calls `event.preventDefault()` on `contextmenu` so a right-drag paints instead of opening a menu.

It renders nothing itself; the canvas redraws from the session as it already does.

- [ ] **Step 2: Mount it conditionally**

In `MapCanvas.vue`, render `<MapPaintLayer v-if="session.mode === 'paint'" :session="session" :zoom="zoom" />` over the existing canvas, and guard the existing cell-level pointer handlers with `v-if="session.mode === 'tiles'"` (or an early `return` when `session.mode !== 'tiles'`) so the two input paths can never both fire.

- [ ] **Step 3: Verify by hand**

Run `npm run dev`. Open a map, switch to Paint, draw with the left button and confirm the canvas updates; draw with the right button and confirm it paints the background role and no context menu appears; switch back to Tiles and confirm stamping still works.

- [ ] **Step 4: Commit**

```bash
npm run check
git add src/renderer/src/editors/map/MapPaintLayer.vue src/renderer/src/editors/map/MapCanvas.vue
git commit -m "feat(map): the paint path is its own component over the canvas"
```

---

### Task 7: the paint sidebar

**Files:**
- Create: `src/renderer/src/editors/map/MapPaintPanel.vue`
- Modify: `src/renderer/src/editors/map/MapSidePanel.vue`, `src/renderer/src/editors/map/MapToolbar.vue` (or wherever `MapTool` buttons live — find it with `grep -rln "setTool" src/renderer/src/editors/map`)

**Interfaces:**
- Consumes: `setMode`, `setPaintTool`, `setPaintColor`, `setPaintWrite`, `paintBudgetLabel` (Task 5).
- Produces: nothing other tasks depend on.

- [ ] **Step 1: The mode toggle**

Two buttons — **Tiles** / **Paint** — bound to `setMode`, in the existing toolbar beside the tool buttons. When `mode === 'paint'`, show the `TileTool` buttons (`pencil`, `line`, `rect`, `fill`, `spray`) instead of the `MapTool` ones, reusing the tile editor's icons and labels so the two editors read the same.

- [ ] **Step 2: `MapPaintPanel.vue`**

Shown in the side panel only when `mode === 'paint'`:
- the palette, bound to `setPaintColor`, built from the tileset's palette exactly as the tile editor's does;
- a **Write** control with two options, `Fork tile` / `Edit tile`, bound to `setPaintWrite`, with the Edit option's title attribute reading: *"Rewrites this tile everywhere it is used, in this map and any other map on this tileset."*;
- `paintBudgetLabel(session)` as a plain readout.

- [ ] **Step 3: Verify by hand**

`npm run dev`: switch to Paint, confirm the palette, the write toggle and the budget readout appear and that the budget number rises as fork strokes create tiles and stays put on edit strokes.

- [ ] **Step 4: Commit**

```bash
npm run check
git add src/renderer/src/editors/map/MapPaintPanel.vue src/renderer/src/editors/map/MapSidePanel.vue src/renderer/src/editors/map/MapToolbar.vue
git commit -m "feat(map): a paint sidebar with the palette, the write toggle and the budget"
```

---

### Task 8: New tiled screen

**Files:**
- Modify: `src/renderer/src/commands.ts`, `src/main/menu.ts`, and the store that creates resources (find it: `grep -rln "createTilesDoc\|createMapDoc" src/renderer/src/stores`)
- Test: the store's own test file

**Interfaces:**
- Consumes: `createTilesDoc`, `createMapDoc`.
- Produces: a `MenuCommand` value `'new-tiled-screen'`.

A tiled screen is a tileset plus a map — this command scaffolds the pair and opens the map, so "draw one from scratch" needs no new document type.

- [ ] **Step 1: Write the failing test**

```ts
it('new tiled screen writes a tileset and a 32x24 map that references it', async () => {
  const created = await newTiledScreen('res/title')

  expect(created.tileset).toBe('res/title.tiles.json')
  expect(created.map).toBe('res/title.map.json')
  const map = normalizeMap(JSON.parse(written('res/title.map.json')).doc)
  expect(map.width).toBe(32)
  expect(map.height).toBe(SCREEN_ROWS)
  expect(map.tileset).toBe('res/title.tiles.json')
  // Tile 0 is reserved so an unpainted cell is blank rather than art.
  const tiles = normalizeTiles(JSON.parse(written('res/title.tiles.json')).doc)
  expect(tiles.reserveTile0).toBe(true)
})
```

- [ ] **Step 2: Run it to verify it fails**

Expected: FAIL — `newTiledScreen` is not defined.

- [ ] **Step 3: Implement**

```ts
/**
 * A tiled screen is a tileset plus a map — no third document type. Tile 0 is
 * reserved so an unpainted cell reads as blank instead of as whatever art
 * happens to land at index 0.
 */
export async function newTiledScreen(base: string): Promise<{ tileset: string; map: string }> {
  const tilesetPath = `${base}.tiles.json`
  const mapPath = `${base}.map.json`
  const tiles = createTilesDoc('sc2', 1, true)
  const map = createMapDoc(tilesetPath, 32, SCREEN_ROWS)
  await window.api.invoke('fs:write', {
    path: tilesetPath,
    content: serializeResource({ kind: 'tiles', doc: tiles })
  })
  await window.api.invoke('fs:write', {
    path: mapPath,
    content: serializeResource({ kind: 'map', doc: map })
  })
  return { tileset: tilesetPath, map: mapPath }
}
```

- [ ] **Step 4: Wire the menu**

Add `'new-tiled-screen'` to the `MenuCommand` union in `src/shared/ipc.ts`, an item under File → New in `src/main/menu.ts`, and a case in `src/renderer/src/commands.ts` that prompts for a name, calls `newTiledScreen`, opens the map tab and calls `setMode(session, 'paint')`.

- [ ] **Step 5: Run tests, then verify by hand**

Run the store's test file, then `npm run dev` and use File → New → Tiled screen.

- [ ] **Step 6: Commit**

```bash
npm run check
git add -A src/renderer/src/stores src/renderer/src/commands.ts src/main/menu.ts src/shared/ipc.ts
git commit -m "feat: New tiled screen scaffolds a tileset and a map, ready to paint"
```

---

### Task 9: promotion to banked at the 256-tile ceiling

**Files:**
- Modify: `src/renderer/src/editors/map/session.ts`, `src/renderer/src/editors/map/MapPaintPanel.vue`
- Test: `src/renderer/src/editors/map/session.test.ts`

**Interfaces:**
- Consumes: `packBankedTiles` (`src/shared/msx/tile.ts`), `paintStroke` (Task 5), `screenPixelsFromMap` — if no such renderer exists, write one in `src/shared/msx/map.ts` as `renderMapPixels(doc, tiles, layerIndex): { width, height, indices: Uint8Array }`, looping cells and copying `tilePixels`.
- Produces: `canPromoteToBanked(session)`, `promoteToBanked(session)`.

Promotion **re-uses the importer** rather than inventing a redistributor: the screen is already fully described by tileset + map, so render it and hand it to `packBankedTiles`, which is tested and ROM-verified.

- [ ] **Step 1: Write the failing tests**

```ts
it('offers promotion only for a 32x24 map, because packBankedTiles needs 256x192', () => {
  const session = openTestSession()
  expect(canPromoteToBanked(session)).toBe(true)

  resizeSession(session, 32, 40)
  expect(canPromoteToBanked(session)).toBe(false)
})

it('promotion re-derives banks and leaves the map showing the same picture', () => {
  const session = openTestSession()
  fillTilesetToCapacity(session)
  const before = renderMapPixels(doc(session), session.tileset!, 0)

  promoteToBanked(session)

  expect(isBanked(session.tileset!)).toBe(true)
  expect(renderMapPixels(doc(session), session.tileset!, 0)).toEqual(before)
})

it('refuses promotion on a taller map and says why', () => {
  const session = openTestSession()
  resizeSession(session, 32, 40)
  fillTilesetToCapacity(session)
  setMode(session, 'paint')

  paintStroke(session, { x: 1, y: 1 }, { x: 1, y: 1 }, 'fg')

  expect(session.status).toContain('24 rows')
})
```

- [ ] **Step 2: Run them to verify they fail**

Expected: FAIL — `canPromoteToBanked` is not defined.

- [ ] **Step 3: Implement**

```ts
/**
 * Promotion is only legal at exactly 32×24: `packBankedTiles` takes a 256×192
 * image, and `validateMap` refuses a banked map that is not `SCREEN_ROWS` tall.
 */
export function canPromoteToBanked(session: MapSession): boolean {
  const current = doc(session)
  return current.width === 32 && current.height === SCREEN_ROWS && !!session.tileset && !isBanked(session.tileset)
}

/**
 * Renders the screen as it stands and repacks it into three banks.
 *
 * This is the one moment renumbering a tileset is legal — it is still
 * unbanked, so Task 9 of the banking branch does not forbid it. It renumbers
 * every tile, so **every other map on this tileset is rewritten**; the caller
 * must have said so before getting here.
 */
export function promoteToBanked(session: MapSession): void { /* render, packBankedTiles, write both docs through the stores */ }
```

In `paintStroke`, when `result.refused` names the whole-tileset limit and `canPromoteToBanked(session)` is true, set `session.promptPromote = true` instead of only setting status; when it is false because the map is not 24 rows, set the status to name that: `` `This screen is out of tiles. Switching to banked needs a map exactly ${SCREEN_ROWS} rows tall — this one is ${current.height}.` ``

**The triggering stroke is discarded, not replayed** — promotion renumbers, so its cell indices are stale by the time it completes.

- [ ] **Step 4: The prompt**

In `MapPaintPanel.vue`, when `session.promptPromote`, show a confirm reading: *"This screen is out of tiles. Switch to banked (three banks of 256)? This renumbers every tile in the tileset, so any other map using it will be rewritten."* Accept calls `promoteToBanked`; decline clears the flag.

- [ ] **Step 5: Run tests, then commit**

```bash
npx vitest run src/renderer/src/editors/map src/shared/msx
npm run check
git add -A src/renderer/src/editors/map src/shared/msx/map.ts src/shared/msx/map.test.ts
git commit -m "feat(map): offer to switch a full screen to banked, once"
```

---

### Task 10: the docs

**Files:**
- Modify: `specs/10-map-screen-editors.md`, `CHANGELOG.md`

**Interfaces:** none.

`src/main/services/agent-guide.ts` needs **nothing**: the emitted C, the generated file names and the way a resource is used from C are all unchanged by this feature. State that in the commit message rather than leaving a reader to wonder — CLAUDE.md makes the guide a deliverable whenever any of those change, so "no change needed" is a conclusion, not an omission.

- [ ] **Step 1: spec 10**

Add a "Painting a tiled screen" section: the Tiles/Paint mode toggle, the `fork`/`edit` write modes and that `edit` reaches every map on the tileset, bank-local allocation for banked screens, the budget readout, New tiled screen, and the one-time promotion offer with its 32×24 requirement.

- [ ] **Step 2: CHANGELOG**

Under `[Unreleased]`, describing the capability and naming the two things a user can be surprised by: an `edit` stroke changes every map using that tile, and promotion renumbers the tileset.

- [ ] **Step 3: Verify and commit**

```bash
npx vitest run src/main/services/agent-guide.test.ts src/main/services/agent-guide-meta.test.ts
npm run check
git add specs/10-map-screen-editors.md CHANGELOG.md
git commit -m "docs: painting a tiled screen, in spec 10 and the changelog"
```

---

## Self-Review

**Spec coverage:** `paintGrid` core → Task 1; `write` modes → Task 2; `bankOf` and the second allocator → Task 3; undo carrying the inverse → Tasks 4–5; the editor surface → Tasks 6–7; creation from scratch → Task 8; the 256 ceiling and promotion → Task 9; deliverables beyond the code → Task 10. The spec's "SCREEN 1 needs no special handling" is covered by the existing `pair` plumbing that Tasks 1–3 carry through unchanged, and is asserted nowhere because there is nothing new to assert.

**Placeholders:** Task 9's `promoteToBanked` body is a one-line description rather than code, because it depends on whether `renderMapPixels` already exists — the task says to write it if not and gives its signature. Tasks 6 and 7 describe `.vue` markup in prose; both name every function they call and every prop they pass, and neither may contain logic per the Global Constraints.

**Type consistency:** `PaintGrid`/`PaintGridResult`/`PaintOptions`/`TileEdit` are defined in Tasks 1–3 and used unchanged in 4–5. `MapEntry`/`MapHistory` are defined in Task 4 and consumed in 5 and 9. `paintBankOf` returns `((cellRow: number) => number) | null` and is adapted to `PaintOptions.bankOf`'s optional with `?? undefined` at the one call site.
