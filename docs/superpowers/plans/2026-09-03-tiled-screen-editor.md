# Tiled-mode screen editor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Paint pixels directly on a SCREEN 1/2/4 map — touch up an imported screen, edit part of a hand-built map, or draw one from scratch.

**Architecture:** Extract `meta-paint.ts`'s stroke core as `paintGrid` over a plain `{width, height, tiles}` grid of **cell** references, which `MapLayer.data` already satisfies. `paintMeta` becomes a wrapper, so the meta editor is provably unchanged. Painting joins the map editor as a mode beside stamping; a second allocator reads and writes the row's own bank instead of the shared region.

**Tech Stack:** TypeScript, Vue 3, Pinia, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-03-tiled-screen-editor-design.md`

**Plan revision:** rewritten after an adversarial review found 7 Critical defects in the first draft. Where a step below looks unnecessarily emphatic, it is guarding a specific bug that review caught.

## Global Constraints

- **Branch:** `feat/tiled-screen-editor`. Base: `e457deb` (`git merge-base main HEAD`).
- **`grid.width`/`grid.height` are in CELLS, never pixels.** `paintGrid` computes `cx = Math.floor(point.x / TILE_SIZE)` and compares it to `grid.width`, then indexes `tiles[cy * grid.width + cx]`. `points` are in pixels; the grid is in cells. Passing a pixel width makes the row stride wrong and writes past the array — it is the single easiest mistake here and a same-cell test cannot catch it.
- **`findOrCreateTile` must not change behaviour.** Meta-tiles depend on its shared-region allocation: one index means one picture in every bank, which is what lets `_DrawPlacements` stay bank-unaware. Bank-local work is a *second* function beside it.
- **Every read of a cell's current art goes through `bankTileAt`** when a bank is in play. `doc.tiles[index]` is the common set; on a banked tileset `count` is often 1 and the art lives in `bankTiles[b]`, so a direct read returns `undefined` and silently destroys the picture under the stroke.
- **The gate is `npm run check`** (lint + typecheck). Every task ends green.
- **Do NOT run the real-MSXgl compile tests.** This machine HAS a checkout at `~/Applications/MSXgl`, so they do **not** auto-skip. Exclude them: append `-t '^(?!.*generated headers compile into a ROM).+$'` to any vitest run reaching `src/main/services/resources.test.ts`.
- **Vitest covers `src/shared/`, `src/main/`, `renderer/src/stores`, and `renderer/src/editors/*/session.ts`.** `.vue` files and `sheet.ts` are NOT covered — no logic may live there, including hit tests and geometry.
- **A test that passes whether or not the code is right is worse than no test.** Before committing, break the line you just wrote, confirm the new test fails, and put it back.
- **Fixtures must not be uniform.** Banked fixtures use banks at *different* lengths with a non-zero `sharedTiles`, and real art in the shared region (`normalizeTiles` leaves it blank by default, so a blank probe matches everything).
- `TILE_SIZE` = 8, `MAX_TILES` = 256, `BANK_COUNT` = 3, `SCREEN_ROWS` = 24.
- The map session's test helper is **`openMap()`** (`session.test.ts:97`) and its fixture map is **8×8** with a 4-tile `sc2` tileset. There is no `openTestSession`. The resize function is **`resize`**.

---

### Task 1: the map editor joins the tileset store

**Files:**
- Modify: `src/renderer/src/editors/map/session.ts`
- Test: `src/renderer/src/editors/map/session.test.ts`

**Interfaces:**
- Consumes: `useTilesetStore()` — `patternDoc(path)`, `set(path, doc, source)`, `onExternalChange(path, source, fn)`, `release(path)`.
- Produces: `session.tileset` staying in sync with the store. Tasks 6 and 10 write through the store and rely on this.

**Why this is first.** `grep useTilesetStore src/renderer/src/editors/map/` returns nothing today: the map `fs:read`s its tileset into `session.tileset` and keeps a private copy. That is harmless while the map only *reads* tiles, and fatal the moment it writes them — a second stroke would derive from the pre-stroke document and overwrite the store with a doc missing the first stroke's tiles, `sheet.ts:50` caches on the document's identity so the canvas would never repaint, and `saveSession` writes only the map so painted tiles would never reach disk. Build this before any painting exists.

The tile editor already does exactly this at `tile/session.ts:166`; copy its shape.

- [ ] **Step 1: Write the failing test**

```ts
it('adopts a tileset change made by another editor', async () => {
  const session = await openMap()
  const store = useTilesetStore()
  const before = session.tileset!

  const grown = normalizeTiles({ mode: 'sc2', count: 5 })
  store.set(TILES, grown, 'some/other/editor.tiles.json')

  expect(session.tileset).not.toBe(before)
  expect(session.tileset!.count).toBe(5)
})

it('saves the tileset alongside the map when the tileset is dirty', async () => {
  const session = await openMap()
  const store = useTilesetStore()
  store.set(TILES, normalizeTiles({ mode: 'sc2', count: 5 }), session.path)

  await saveSession(session)

  expect(JSON.parse(files[TILES]).count).toBe(5)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/src/editors/map/session.test.ts -t 'another editor'`
Expected: FAIL — nothing updates `session.tileset`.

- [ ] **Step 3: Load through the store and subscribe**

In `loadTileset`, after parsing a `'tiles'` resource, replace the bare assignment with a store write plus a read-back, then subscribe once at session creation (beside the existing `stopWatching` wiring):

```ts
  useTilesetStore().set(path, parsed.doc, session.path)
  session.tileset = useTilesetStore().patternDoc(path)
```

```ts
  // Another editor — the tile editor, or a meta being painted — can change this
  // same document. Adopt it: `sheet.ts` caches on the document's identity, so a
  // private copy would leave the canvas showing art that no longer exists.
  session.stopWatchingTileset = useTilesetStore().onExternalChange(
    tilesetPath,
    session.path,
    (next) => {
      session.tileset = next as TilesDoc
    }
  )
```

Add `stopWatchingTileset: (() => void) | null` to `MapSession`, call it before re-subscribing on a tileset change, and call it plus `release(tilesetPath)` in `pruneMapSessions`.

- [ ] **Step 4: Save the pair**

In `saveSession`, after writing the map, write the tileset when the store says it is dirty — `meta/session.ts:361-362` is the precedent:

```ts
  const tilesetPath = doc(session).tileset
  const store = useTilesetStore()
  if (tilesetPath && store.isDirty(tilesetPath)) {
    const tiles = store.patternDoc(tilesetPath)
    if (tiles) {
      await window.api.invoke('fs:write', {
        path: tilesetPath,
        content: serializeResource({ kind: 'tiles', doc: tiles })
      })
      store.set(tilesetPath, tiles, session.path)   // clears the dirty flag
    }
  }
```

Check `tilesetStore.set`'s dirty-clearing convention and follow it rather than the line above if they differ.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/editors/map src/renderer/src/stores`
Expected: PASS, including every pre-existing map test — this task must change no behaviour a test already pins.

- [ ] **Step 6: Commit**

```bash
npm run check
git add src/renderer/src/editors/map/session.ts src/renderer/src/editors/map/session.test.ts
git commit -m "fix(map): the map editor shares one tileset document with every other editor"
```

---

### Task 2: `paintGrid` — extract the core, prove `paintMeta` unchanged

**Files:**
- Modify: `src/shared/msx/meta-paint.ts`
- Test: `src/shared/msx/meta-paint.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PaintGrid` (`{ width: number; height: number; tiles: number[] }`, **cells**), `PaintGridResult`, `paintGrid(grid, tiles, points, color, role?)`. Tasks 3–4 add options; Task 6 calls it.

- [ ] **Step 1: Write the failing test**

```ts
describe('paintGrid', () => {
  it('paints a dot into a plain grid and forks a tile for it', () => {
    const tiles = createTilesDoc('sc2', 1)
    const grid = { width: 2, height: 1, tiles: [0, 0] }

    const result = paintGrid(grid, tiles, [{ x: 1, y: 1 }], 7)

    expect(result.grid.tiles[0]).not.toBe(0)
    expect(result.grid.tiles[1]).toBe(0)
    expect(result.added).toEqual([result.grid.tiles[0]])
    expect(result.refused).toBeUndefined()
  })

  it('indexes by CELL, so a point in the second cell row uses the grid width as stride', () => {
    const tiles = createTilesDoc('sc2', 1)
    const grid = { width: 4, height: 4, tiles: new Array(16).fill(0) }

    // Pixel (0, 8) is cell (0, 1) — index 4 with a stride of 4.
    const result = paintGrid(grid, tiles, [{ x: 0, y: 8 }], 7)

    expect(result.grid.tiles[4]).not.toBe(0)
    expect(result.grid.tiles[0]).toBe(0)
  })

  it('ignores points outside the grid, so a drag off-canvas needs no clamping', () => {
    const tiles = createTilesDoc('sc2', 1)
    const grid = { width: 1, height: 1, tiles: [0] }

    const result = paintGrid(grid, tiles, [{ x: 99, y: 0 }, { x: -1, y: 0 }], 7)

    expect(result.grid).toBe(grid)
    expect(result.tiles).toBe(tiles)
  })

  it('returns the same grid by reference when a stroke resolves to the tiles already there', () => {
    const tiles = createTilesDoc('sc2', 1)
    const grid = { width: 1, height: 1, tiles: [0] }
    const once = paintGrid(grid, tiles, [{ x: 1, y: 1 }], 7)

    const twice = paintGrid(once.grid, once.tiles, [{ x: 1, y: 1 }], 7)

    expect(twice.grid).toBe(once.grid)
    expect(twice.tiles).toBe(once.tiles)
    expect(twice.added).toEqual([])
  })
})
```

The fourth test is load-bearing. `setFrameTile` returns its input unchanged when the tile is already there, so the original `paintMeta` returned `meta` **by reference** for an idle re-stroke and `pushHistory` (reference-equal) no-op'd. Allocating a new array unconditionally would make the meta editor push an undo step for a click that changed nothing.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/shared/msx/meta-paint.test.ts -t 'paintGrid'`
Expected: FAIL — `paintGrid` is not exported.

- [ ] **Step 3: Extract the core**

```ts
/** A grid of tile references — a meta's frame, or a map layer's `data`. Sizes are in CELLS. */
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
 * `points` are in the grid's own **pixel** space — `(0,0)` is its top-left dot.
 * `grid.width`/`height` are in **cells**. Points outside are ignored, so a drag
 * that leaves the canvas needs no clamping by the caller.
 *
 * `role` is which half of the row's colour pair the stroke owns — the mouse
 * button, as in the tile editor. Without one, the second colour a row is asked
 * for is dropped, which reads as an editor that stopped working.
 */
export function paintGrid(
  grid: PaintGrid,
  tiles: TilesDoc,
  points: readonly Point[],
  color: number,
  role?: 'fg' | 'bg'
): PaintGridResult {
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

  for (const key of byCell.keys()) {
    const cellPoints = byCell.get(key)!
    const currentTile = (nextCells ?? grid.tiles)[key] ?? 0
    let work = scratch(nextTiles, currentTile)
    for (const point of cellPoints) {
      const result = paintPixel(work, 0, point.x % TILE_SIZE, point.y % TILE_SIZE, color, role)
      if (!result.ok) {
        dropped++
        continue
      }
      work = result.doc
    }

    const pair = nextTiles.mode === 'sc1' ? work.groupColors[0] : undefined
    const found = findOrCreateTile(nextTiles, canonical(work), pair)
    if (!found) {
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
    if (found.index >= nextTiles.count || found.doc.sharedTiles > nextTiles.sharedTiles)
      added.push(found.index)
    nextTiles = found.doc
    // Only clone once a cell actually moves. A stroke that resolves to the tile
    // already there must return the SAME array, or every caller's
    // reference-equal no-op check (and its undo stack) stops working.
    if (found.index !== currentTile) {
      if (!nextCells) nextCells = grid.tiles.slice()
      nextCells[key] = found.index
    }
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

Keep its exported signature and doc comment exactly; replace the body:

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
  // Nothing moved: hand back the same meta so `pushHistory` no-ops, exactly as
  // `setFrameTile` used to make it. `dropped` still travels — an all-dropped
  // stroke reported its count before and must keep doing so.
  if (result.grid.tiles === frameTiles.tiles)
    return { meta, tiles: result.tiles, added: result.added, dropped: result.dropped }

  const frames = meta.frames.slice()
  frames[frame] = { tiles: result.grid.tiles }
  return { meta: { ...meta, frames }, tiles: result.tiles, added: result.added, dropped: result.dropped }
```

- [ ] **Step 5: Run the full suite — this is the refactor proof**

Run: `npx vitest run src/shared/msx/meta-paint.test.ts src/renderer/src/editors/meta`
Expected: PASS with **no pre-existing test edited**. If one needs editing, stop and report: the extraction is wrong.

- [ ] **Step 6: Commit**

```bash
npm run check
git add src/shared/msx/meta-paint.ts src/shared/msx/meta-paint.test.ts
git commit -m "refactor(paint): paintMeta is a wrapper over a grid-shaped core"
```

---

### Task 3: bank-aware reads and a bank-local allocator

**Files:**
- Modify: `src/shared/msx/meta-paint.ts`
- Test: `src/shared/msx/meta-paint.test.ts`

**Interfaces:**
- Consumes: `paintGrid` (Task 2).
- Produces: `findOrCreateBankTile(doc, bank, entry, pair?)`, `PaintOptions.bankOf?: (cellRow: number) => number`, `PaintGridResult.refusedBank?: number | null`. Tasks 4 and 6 use them.

**Two separate bugs this task exists to prevent**, both found in review:

1. `scratch(doc, tile)` reads `doc.tiles[tile]` — the **common** set. On a banked tileset `count` is often 1 and the art is in `bankTiles[b]`, so that read is `undefined`, the scratch comes back blank, and one dot destroys the imported picture under the stroke. Reads must go through `bankTileAt`.
2. Appending at `bankTiles[bank].length` **shadows common tiles**. A bank shorter than `count` (`bankTiles[2] = []` with `count` 1) would append at index 0, so with `reserveTile0` every empty cell in the bottom third shows the first stroke's art.

- [ ] **Step 1: Write the failing tests**

```ts
describe('findOrCreateBankTile', () => {
  const solid = (byte: number) => ({
    pattern: new Array(8).fill(byte),
    color: new Array(8).fill(mergeColorByte(15, 4))
  })

  /** Uneven banks, a real shared region with real art, and count > 0. */
  function banked(): TilesDoc {
    const doc = normalizeTiles({
      mode: 'sc2',
      count: 2,
      tiles: [solid(0x11), solid(0x22)],
      bankTiles: [[solid(0x33), solid(0x44), solid(0x55)], [solid(0x66)], []],
      sharedTiles: 2
    })
    // normalizeTiles leaves the shared region blank; blank matches everything,
    // so give it art or the "finds the shared region" test proves nothing.
    const tiles = doc.tiles.slice()
    tiles[MAX_TILES - 2] = solid(0xaa)
    tiles[MAX_TILES - 1] = solid(0xbb)
    return { ...doc, tiles }
  }

  it('appends above the common range, never shadowing a common tile', () => {
    const doc = banked()
    // Bank 2 has NO overrides and count is 2 — appending at 0 would shadow
    // common tiles 0 and 1 for every cell in the bottom third of the screen.
    const found = findOrCreateBankTile(doc, 2, solid(0x7e))

    expect(found!.index).toBe(2)
    expect(bankTileAt(found!.doc, 2, 0)).toEqual(bankTileAt(doc, 2, 0))
    expect(bankTileAt(found!.doc, 2, 1)).toEqual(bankTileAt(doc, 2, 1))
  })

  it('appends into the named bank and leaves the other two alone', () => {
    const doc = banked()
    const found = findOrCreateBankTile(doc, 0, solid(0x7e))

    expect(found!.index).toBe(3)
    expect(found!.doc.bankTiles[1]).toHaveLength(1)
    expect(found!.doc.bankTiles[2]).toHaveLength(0)
    expect(found!.doc.sharedTiles).toBe(2)
  })

  it('reuses an identical tile already in that bank', () => {
    const doc = banked()
    const found = findOrCreateBankTile(doc, 0, doc.bankTiles[0][1])

    expect(found!.index).toBe(1)
    expect(found!.doc).toBe(doc)
  })

  it('finds the shared region too, since every bank shows it', () => {
    const doc = banked()
    const found = findOrCreateBankTile(doc, 1, doc.tiles[MAX_TILES - 1])

    expect(found!.index).toBe(MAX_TILES - 1)
    expect(found!.doc).toBe(doc)
  })

  it('returns null when the bank has no room below the shared region', () => {
    const doc = normalizeTiles({
      mode: 'sc2',
      count: 1,
      bankTiles: [Array.from({ length: MAX_TILES - 2 }, (_, i) => solid(i & 0xff)), [], []],
      sharedTiles: 2
    })
    // A probe that is NOT in the fill: solid(0x7e) collides with fill entry 126.
    const probe = { pattern: [1, 2, 3, 4, 5, 6, 7, 8], color: new Array(8).fill(mergeColorByte(15, 4)) }

    expect(findOrCreateBankTile(doc, 0, probe)).toBeNull()
  })
})

it("paintGrid with bankOf derives from the bank's art, not the common set", () => {
  const solid = (byte: number) => ({
    pattern: new Array(8).fill(byte),
    color: new Array(8).fill(mergeColorByte(15, 4))
  })
  // The shape a real import produces: count 1, art only in the banks.
  const tiles = normalizeTiles({
    mode: 'sc2',
    count: 1,
    bankTiles: [[solid(0xff)], [solid(0x0f)], []],
    sharedTiles: 0
  })
  const grid = { width: 32, height: 24, tiles: new Array(32 * 24).fill(0) }

  const result = paintGrid(grid, tiles, [{ x: 0, y: 0 }], 0, 'bg', { bankOf: (row) => row >> 3 })

  // Derived from bank 0's solid(0xff) with one dot cleared — NOT from a blank.
  const painted = bankTileAt(result.tiles, 0, result.grid.tiles[0])
  expect(painted.pattern[0]).toBe(0x7f)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/shared/msx/meta-paint.test.ts -t 'BankTile'`
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
 * Null means the bank has no room below the shared region.
 */
export function findOrCreateBankTile(
  doc: TilesDoc,
  bank: number,
  entry: TileEntry,
  pair?: number
): { doc: TilesDoc; index: number } | null {
  const sc1 = doc.mode === 'sc1'
  const sharedStart = MAX_TILES - doc.sharedTiles
  const own = doc.bankTiles[bank] ?? []
  for (let i = 0; i < MAX_TILES; i++) {
    // Only a slot something actually fills is a real match — `bankTileAt`
    // answers `blankTileEntry` for every slot past the bank, the common range
    // and the shared region, and a blank probe would match all of them.
    if (!own[i] && i >= doc.count && i < sharedStart) continue
    if (!sameEntry(bankTileAt(doc, bank, i), entry)) continue
    if (sc1 && doc.groupColors[i >> SC1_SHIFT] !== pair) continue
    return { doc, index: i }
  }

  // Never below `count`: a bank override at a common index shadows that common
  // tile for every cell in this bank's rows — including a reserved tile 0.
  const index = Math.max(own.length, doc.count)
  if (index >= sharedStart) return null

  const grown = own.slice()
  // Slots the bank did not have are seeded from what it already showed, so
  // nothing the user is not looking at changes appearance.
  for (let i = grown.length; i < index; i++) grown[i] = bankTileAt(doc, bank, i)
  grown[index] = { pattern: entry.pattern.slice(), color: entry.color.slice() }
  const bankTiles = doc.bankTiles.slice()
  bankTiles[bank] = grown
  return { doc: { ...doc, bankTiles }, index }
}
```

Import `bankTileAt` from `./tile`.

- [ ] **Step 4: Make reads bank-aware and wire `bankOf`**

Give `scratch` an optional bank:

```ts
/** A one-tile document holding a copy of `tile` as `bank` sees it, for `paintPixel` to work on. */
function scratch(doc: TilesDoc, tile: number, bank: number | null): TilesDoc {
  const entry = bank === null ? (doc.tiles[tile] ?? blankTileEntry(doc.mode)) : bankTileAt(doc, bank, tile)
  ...
}
```

`groupColors: doc.mode === 'sc1' ? [colorByteAt(doc, tile, 0)] : []` stays as it is — sc1 never banks.

Add:

```ts
export interface PaintOptions {
  /**
   * Which bank a cell row is drawn in — the **cell** row
   * (`Math.floor(point.y / TILE_SIZE)`), not the pixel row. Omitted for a meta,
   * whose tiles must mean one picture in every bank.
   */
  bankOf?: (cellRow: number) => number
}
```

In `paintGrid`, take `options: PaintOptions = {}`, and inside the cell loop:

```ts
    const cy = Math.floor(key / grid.width)
    const bank = options.bankOf && isBanked(nextTiles) ? options.bankOf(cy) : null
    let work = scratch(nextTiles, currentTile, bank)
```

and replace the allocation:

```ts
    const found =
      bank === null
        ? findOrCreateTile(nextTiles, canonical(work), pair)
        : findOrCreateBankTile(nextTiles, bank, canonical(work), pair)
    if (!found) {
      return {
        grid,
        tiles,
        added: [],
        dropped: 0,
        refusedBank: bank,
        refused:
          bank === null
            ? `The tileset is full — ${MAX_TILES} tiles is the hardware limit. ` +
              'Run "Compact unused tiles", or free a tile in the tile editor.'
            : `Bank ${bank} is full — ${MAX_TILES} tiles is the hardware limit for one bank. ` +
              'Free a tile, or paint on a row served by another bank.'
      }
    }
```

`refusedBank` is a field on `PaintGridResult` (`bank: number | null`) so callers branch on structure, not on matching the message text.

`added` detection must cover a bank append, which grows neither `count` nor `sharedTiles`:

```ts
    const grew =
      bank === null
        ? found.index >= nextTiles.count || found.doc.sharedTiles > nextTiles.sharedTiles
        : (found.doc.bankTiles[bank]?.length ?? 0) > (nextTiles.bankTiles[bank]?.length ?? 0)
    if (grew) added.push(found.index)
```

- [ ] **Step 5: Run tests, then break the code to prove they bite**

Run: `npx vitest run src/shared/msx/meta-paint.test.ts src/renderer/src/editors/meta` → PASS.

Then temporarily change `Math.max(own.length, doc.count)` to `own.length`, rerun, and confirm the shadowing test fails. Put it back. Do the same for `scratch`'s bank read against the derivation test.

- [ ] **Step 6: Commit**

```bash
npm run check
git add src/shared/msx/meta-paint.ts src/shared/msx/meta-paint.test.ts
git commit -m "feat(paint): read and allocate in the row's own bank"
```

---

### Task 4: `write: 'edit'` — rewrite a tile in place

**Files:**
- Modify: `src/shared/msx/meta-paint.ts`
- Test: `src/shared/msx/meta-paint.test.ts`

**Interfaces:**
- Consumes: `paintGrid`, `PaintOptions`, `findOrCreateBankTile` (Tasks 2–3).
- Produces: `PaintOptions.write?: 'fork' | 'edit'`, `TileEdit` (`{ index: number; bank: number | null; before: TileEntry; beforeGroup?: number }`), `PaintGridResult.tileEdits: TileEdit[]`. Tasks 5–6 store and reverse them.

- [ ] **Step 1: Write the failing tests**

```ts
  it("edit mode rewrites the cell's own tile and repoints nothing", () => {
    const tiles = createTilesDoc('sc2', 4)
    const grid = { width: 2, height: 1, tiles: [2, 2] }

    const result = paintGrid(grid, tiles, [{ x: 1, y: 1 }], 7, undefined, { write: 'edit' })

    expect(result.grid.tiles).toEqual([2, 2])
    expect(result.tiles.tiles[2]).not.toEqual(tiles.tiles[2])
    expect(result.added).toEqual([])
    expect(result.tiles.count).toBe(tiles.count)
    expect(result.tileEdits).toEqual([
      { index: 2, bank: null, before: tiles.tiles[2] }
    ])
  })

  it('edit mode never refuses on a full tileset, because it allocates nothing', () => {
    const full = createTilesDoc('sc2', MAX_TILES)
    const grid = { width: 1, height: 1, tiles: [5] }

    const result = paintGrid(grid, full, [{ x: 0, y: 0 }], 7, undefined, { write: 'edit' })

    expect(result.refused).toBeUndefined()
    expect(result.tiles.tiles[5]).not.toEqual(full.tiles[5])
  })

  it('edit mode writes into the bank that shows the tile, not the common set', () => {
    const solid = (byte: number) => ({
      pattern: new Array(8).fill(byte),
      color: new Array(8).fill(mergeColorByte(15, 4))
    })
    const tiles = normalizeTiles({
      mode: 'sc2',
      count: 1,
      bankTiles: [[solid(0xff)], [solid(0x0f)], []],
      sharedTiles: 0
    })
    const grid = { width: 32, height: 24, tiles: new Array(32 * 24).fill(0) }

    const result = paintGrid(grid, tiles, [{ x: 0, y: 0 }], 0, 'bg', {
      write: 'edit',
      bankOf: (row) => row >> 3
    })

    expect(result.tiles.bankTiles[0][0].pattern[0]).toBe(0x7f)
    expect(result.tiles.bankTiles[1][0]).toEqual(solid(0x0f))   // untouched
    expect(result.tileEdits[0].bank).toBe(0)
  })

  it('edit mode forks instead of overwriting a reserved tile 0', () => {
    const tiles = createTilesDoc('sc2', 4, true)
    const grid = { width: 1, height: 1, tiles: [0] }

    const result = paintGrid(grid, tiles, [{ x: 1, y: 1 }], 7, undefined, { write: 'edit' })

    expect(result.tiles.tiles[0]).toEqual(tiles.tiles[0])   // still blank
    expect(result.grid.tiles[0]).not.toBe(0)                // forked instead
    expect(result.tileEdits).toEqual([])
  })

  it('fork mode records no tileEdits', () => {
    const tiles = createTilesDoc('sc2', 4)
    const result = paintGrid({ width: 1, height: 1, tiles: [2] }, tiles, [{ x: 0, y: 0 }], 7)

    expect(result.tileEdits).toEqual([])
  })
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/shared/msx/meta-paint.test.ts -t 'edit mode'`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
/** One tile's art as it was before an `edit` stroke overwrote it. */
export interface TileEdit {
  index: number
  /** Which table it lives in: a bank's overrides, or null for the common set. */
  bank: number | null
  before: TileEntry
  /** sc1 only: the group colour byte, which is half the picture there. */
  beforeGroup?: number
}
```

Add `write?: 'fork' | 'edit'` to `PaintOptions` and `tileEdits: TileEdit[]` to `PaintGridResult` (always present, `[]` when empty, including on every early return and the refusal).

In the cell loop, before the allocation:

```ts
    const entry = canonical(work)
    // Reserved tile 0 is locked blank and `normalizeTiles` re-blanks it on load,
    // so an in-place write there vanishes on the next open — and until then
    // shows in every transparent cell of every map. Fork instead.
    const editable = options.write === 'edit' && !(currentTile === 0 && nextTiles.reserveTile0)
    if (editable) {
      const inBank = bank !== null && !!nextTiles.bankTiles[bank]?.[currentTile]
      const before = inBank ? nextTiles.bankTiles[bank!][currentTile] : nextTiles.tiles[currentTile]
      // A cell pointing at a slot nothing fills has no art to rewrite; forking
      // is the only honest thing left.
      if (before) {
        const at = inBank ? bank : null
        if (!tileEdits.some((edit) => edit.index === currentTile && edit.bank === at)) {
          tileEdits.push({
            index: currentTile,
            bank: at,
            before,
            ...(nextTiles.mode === 'sc1' ? { beforeGroup: nextTiles.groupColors[currentTile >> SC1_SHIFT] } : {})
          })
        }
        if (inBank) {
          const banked = nextTiles.bankTiles[bank!].slice()
          banked[currentTile] = entry
          const bankTiles = nextTiles.bankTiles.slice()
          bankTiles[bank!] = banked
          nextTiles = { ...nextTiles, bankTiles }
        } else {
          const written = nextTiles.tiles.slice()
          written[currentTile] = entry
          // sc1 holds colour per group of eight tiles, not in the entry — a role
          // stroke's recoloured pair is lost without this.
          const groupColors =
            nextTiles.mode === 'sc1' ? nextTiles.groupColors.slice() : nextTiles.groupColors
          if (nextTiles.mode === 'sc1') groupColors[currentTile >> SC1_SHIFT] = work.groupColors[0]
          nextTiles = { ...nextTiles, tiles: written, groupColors }
        }
        continue   // an edit changes pixels, never references
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/shared/msx/meta-paint.test.ts src/renderer/src/editors/meta`
Expected: PASS. `paintMeta` never sets `write`, so it always forks and is unaffected.

- [ ] **Step 5: Commit**

```bash
npm run check
git add src/shared/msx/meta-paint.ts src/shared/msx/meta-paint.test.ts
git commit -m "feat(paint): an edit stroke rewrites the tile instead of forking one"
```

---

### Task 5: map history carries the inverse, and redo can undo the undo

**Files:**
- Modify: `src/shared/map-editor.ts`, `src/renderer/src/editors/map/session.ts`
- Test: `src/shared/map-editor.test.ts`, `src/renderer/src/editors/map/session.test.ts`

**Interfaces:**
- Consumes: `TileEdit` (Task 4).
- Produces: `MapEntry` (`{ doc: MapDoc; tileEdits?: TileEdit[] }`), `MapHistory = History<MapEntry>`, `commit(session, next, tileEdits?)`. Task 6 passes `tileEdits`.

**The redo trap.** `TileEdit` holds only `before`. If undo simply writes `before` back, the painted art exists nowhere and redo cannot restore it — it would write `before` a second time and the paint would be gone while history claims the step is applied. **Undo must swap:** capture the entries it is about to displace, write `before` in, and store the captured (painted) entries as the `before` of the entry it moved into the future. Redo performs the identical swap in the other direction. One function serves both.

- [ ] **Step 1: Write the failing tests**

```ts
// src/shared/map-editor.test.ts
it('a history entry can carry the tiles an edit stroke overwrote', () => {
  const before = { pattern: new Array(8).fill(0x11), color: new Array(8).fill(0xf1) }
  const base: MapEntry = { doc: createMapDoc('res/t.tiles.json') }
  const history = pushHistory(createHistory(base), {
    doc: base.doc,
    tileEdits: [{ index: 4, bank: null, before }]
  })

  expect(history.present.tileEdits?.[0].before).toBe(before)
  expect(undo(history).present.tileEdits).toBeUndefined()
})
```

```ts
// src/renderer/src/editors/map/session.test.ts
it('undo restores the pixels an edit stroke overwrote, and redo puts them back', async () => {
  const session = await openMap()
  setMode(session, 'paint')
  setPaintWrite(session, 'edit')
  const store = useTilesetStore()
  const original = store.patternDoc(TILES)!.tiles[1]

  beginPaint(session, 'fg')
  extendPaint(session, { x: 8, y: 0 }, { x: 8, y: 0 })
  endPaint(session)
  const painted = store.patternDoc(TILES)!.tiles[1]
  expect(painted).not.toEqual(original)

  undo(session)
  expect(store.patternDoc(TILES)!.tiles[1]).toEqual(original)

  redo(session)
  expect(store.patternDoc(TILES)!.tiles[1]).toEqual(painted)
})
```

The fixture map's layer starts filled with 0 and its tileset has 4 tiles; paint at pixel x 8 so the cell is 1, not the reserved 0. Adjust the index if the fixture differs — read `session.test.ts:72` first.

- [ ] **Step 2: Run to verify they fail**

Expected: FAIL — `MapEntry` is not exported; the paint functions do not exist yet (Task 6 adds them, so this session test is expected to stay red until Task 6 — note that in the commit and keep it skipped with `it.todo` if the task boundary matters).

- [ ] **Step 3: Change the history's element type**

```ts
/**
 * One undo step: the map, plus the tiles an `edit` stroke overwrote to get
 * here. Absent on every step that only moved cell references — a `fork` stroke
 * appends and never destroys art, so it needs no inverse (its orphans are
 * Compact's job, exactly as in the meta editor).
 */
export interface MapEntry {
  doc: MapDoc
  tileEdits?: TileEdit[]
}

export type MapHistory = History<MapEntry>
```

Import `type TileEdit` from `./msx/meta-paint`.

- [ ] **Step 4: Follow the type through the session**

```ts
export function doc(session: MapSession): MapDoc {
  return session.history.present.doc
}

export function commit(session: MapSession, next: MapDoc, tileEdits?: TileEdit[]): void {
  // `pushHistory` compares by reference and a fresh entry is never the present,
  // so guard on the document — otherwise every no-op stroke pushes a step.
  if (next === session.history.present.doc && !tileEdits?.length) return
  session.history = pushHistory(session.history, tileEdits?.length ? { doc: next, tileEdits } : { doc: next })
  markDirty(session)
}
```

Initialise with `createHistory({ doc })`. Run `npm run typecheck:web` and fix every error it points at — `session.ts` around lines 202, 219, 233, 327, 405, 656, 680 all read `history.present`. In `refreshMetaRefs` the forced rewrap must be `{ ...present, doc: next }`, **not** `{ doc: next }`, or a meta refresh silently drops the present step's `tileEdits`.

- [ ] **Step 5: Swap on undo and redo — modify the existing functions in place**

The real callers are `MapEditorTab.vue:164/172` and the menu; they call `undo`/`redo`. **Do not add `undoSession`/`redoSession`** — a new name leaves Ctrl+Z not restoring tile edits while the session test passes.

```ts
/**
 * Puts back the tiles an `edit` stroke overwrote, and returns what was there —
 * so the caller can store the displaced art as the inverse of the step it just
 * moved. Without that swap, redo would write `before` a second time and the
 * painted pixels would be lost while history claims the step is applied.
 */
function swapTileEdits(session: MapSession, edits: TileEdit[] | undefined): TileEdit[] | undefined {
  if (!edits?.length) return edits
  const store = useTilesetStore()
  const path = doc(session).tileset
  const tileset = store.patternDoc(path)
  if (!tileset) return edits
  const tiles = tileset.tiles.slice()
  const bankTiles = tileset.bankTiles.map((bank) => bank.slice())
  const groupColors = tileset.groupColors.slice()
  const displaced: TileEdit[] = edits.map((edit) => {
    const current =
      edit.bank === null ? tiles[edit.index] : bankTiles[edit.bank][edit.index]
    if (edit.bank === null) tiles[edit.index] = edit.before
    else bankTiles[edit.bank][edit.index] = edit.before
    const currentGroup = groupColors[edit.index >> 3]
    if (edit.beforeGroup !== undefined) groupColors[edit.index >> 3] = edit.beforeGroup
    return {
      index: edit.index,
      bank: edit.bank,
      before: current,
      ...(edit.beforeGroup !== undefined ? { beforeGroup: currentGroup } : {})
    }
  })
  store.set(path, { ...tileset, tiles, bankTiles, groupColors }, session.path)
  return displaced
}
```

In `undo`, the step being *left* is the one to reverse; store the displaced art on the entry that moves into the future:

```ts
export function undo(session: MapSession): void {
  if (!canUndo(session.history)) return
  const leaving = session.history.present
  const displaced = swapTileEdits(session, leaving.tileEdits)
  const next = undoHistory(session.history)
  session.history = displaced
    ? { ...next, future: [{ ...leaving, tileEdits: displaced }, ...next.future.slice(1)] }
    : next
  session.selection = null
  session.preview = null
  markDirty(session)
}
```

`redo` is symmetric: swap the entering entry's `tileEdits` and write the displaced art back onto that entry as it becomes the present. Keep both functions' existing `selection`/`preview` resets.

- [ ] **Step 6: Run tests, then commit**

```bash
npx vitest run src/shared/map-editor.test.ts src/renderer/src/editors/map src/renderer/src/stores
npm run check
git add src/shared/map-editor.ts src/shared/map-editor.test.ts src/renderer/src/editors/map
git commit -m "refactor(map): an undo step is a document plus what it overwrote"
```

---

### Task 6: paint mode in the map session

**Files:**
- Modify: `src/renderer/src/editors/map/session.ts`
- Test: `src/renderer/src/editors/map/session.test.ts`

**Interfaces:**
- Consumes: `paintGrid`, `PaintOptions` (Tasks 2–4); `commit(session, next, tileEdits?)` (Task 5); `useTilesetStore` (Task 1).
- Produces: `session.mode`, `paintTool`, `paintColor`, `paintWrite`, `brushRadius`, `brushDensity`; `setMode`, `setPaintTool`, `setPaintColor`, `setPaintWrite`; `beginPaint`, `extendPaint`, `endPaint`; `paintBankOf`, `paintPointAt`, `paintBudgetLabel`, `renderMapPixels`. Tasks 7–8 call these; Task 10 uses `renderMapPixels`.

**Three traps this task exists to avoid**, all found in review:

1. **The grid is in cells.** `{ width: current.width, height: current.height, tiles: layer.data }` — never `* TILE_SIZE`.
2. **One stroke is one resolution.** Resolving per pointer move bakes every intermediate line into the tileset and mints a tile per pencil sample. Accumulate and resolve once on release, re-deriving from the committed document each time — `meta/session.ts:579-690` is the precedent, and the map already does the same for cell tools (`paintDrag`/`finishDrag`).
3. **`toolPoints` is ambiguous.** `map-editor.ts` exports a 4-arg `toolPoints` and `tile-editor.ts` a 5-arg one; `session.ts:67` already imports the map one. Import the tile-editor one under an alias (`toolPoints as pixelToolPoints`) or `npm run check` fails on the clash. `fillPoints` needs real pixels and bounds, and `spray` is a separate call.

- [ ] **Step 1: Write the failing tests**

```ts
describe('paint mode', () => {
  it('starts in tiles mode, so an existing map behaves exactly as before', async () => {
    expect((await openMap()).mode).toBe('tiles')
  })

  it('paints into the cell the pixel falls in, using the grid width as stride', async () => {
    const session = await openMap()          // 8x8 map
    setMode(session, 'paint')
    beginPaint(session, 'fg')
    // Pixel (0, 8) is cell (0, 1) — data index 8 on an 8-wide map.
    extendPaint(session, { x: 0, y: 8 }, { x: 0, y: 8 })
    endPaint(session)

    const layer = doc(session).layers[session.activeLayer]
    expect(layer.data[8]).not.toBe(0)
    expect(layer.data[0]).toBe(0)
  })

  it('a drag is one undo step, not one per sample', async () => {
    const session = await openMap()
    setMode(session, 'paint')
    const before = session.history.past.length

    beginPaint(session, 'fg')
    extendPaint(session, { x: 0, y: 0 }, { x: 1, y: 0 })
    extendPaint(session, { x: 1, y: 0 }, { x: 2, y: 0 })
    extendPaint(session, { x: 2, y: 0 }, { x: 3, y: 0 })
    endPaint(session)

    expect(session.history.past.length).toBe(before + 1)
  })

  it('paintBankOf is null unbanked and wraps by SCREEN_ROWS when banked', async () => {
    const session = await openMap()
    expect(paintBankOf(session)).toBeNull()

    useTilesetStore().set(TILES, bankedFixture(), 'x')
    const bankOf = paintBankOf(session)!
    expect(bankOf(0)).toBe(0)
    expect(bankOf(9)).toBe(1)
    expect(bankOf(17)).toBe(2)
    expect(bankOf(25)).toBe(0)   // taller-than-a-screen map, still editable
  })

  it('a refused stroke changes nothing and names the bank', async () => {
    const session = await openMap()
    useTilesetStore().set(TILES, fullBankedFixture(), 'x')
    setMode(session, 'paint')
    const before = doc(session)

    beginPaint(session, 'fg')
    extendPaint(session, { x: 0, y: 0 }, { x: 0, y: 0 })
    endPaint(session)

    expect(doc(session)).toBe(before)
    expect(session.status).toContain('Bank 0')
  })
})
```

Write `bankedFixture()` and `fullBankedFixture()` in the test file with **uneven** bank lengths and a non-zero `sharedTiles`.

- [ ] **Step 2: Run to verify they fail**

Expected: FAIL — none of these exports exist.

- [ ] **Step 3: Session state**

```ts
  /** Which tool set is live. UI state, not a history step — like `session.bank` in the tile editor. */
  mode: 'tiles' | 'paint'
  paintTool: TileTool
  paintColor: number
  /** Per-stroke, because neither is a safe default: see the spec's write-mode table. */
  paintWrite: 'fork' | 'edit'
  brushRadius: number
  brushDensity: number
  /** Accumulated across a drag; resolved into the tileset once, on release. */
  paintPoints: Point[]
  paintRole: 'fg' | 'bg'
  paintActive: boolean
  /** Set once the user declines promotion, so the offer is made once per session. */
  promotionDeclined: boolean
```

Defaults: `'tiles'`, `'pencil'`, `1`, `'fork'`, `2`, `50`, `[]`, `'fg'`, `false`, `false`. Add the four plain setters.

- [ ] **Step 4: The pixel renderer and the hit test**

```ts
/**
 * The screen as it currently looks, one byte per dot — what `fill` floods
 * against and what promotion repacks.
 *
 * Bank-aware: a cell in rows 8-15 draws from bank 1, so a common-set read would
 * flood against art the screen is not showing.
 */
export function renderMapPixels(
  map: MapDoc,
  tiles: TilesDoc,
  layerIndex: number
): { width: number; height: number; indices: Uint8Array } {
  const width = map.width * TILE_SIZE
  const height = map.height * TILE_SIZE
  const indices = new Uint8Array(width * height)
  const layer = map.layers[layerIndex]
  if (!layer) return { width, height, indices }
  const banked = isBanked(tiles)
  for (let cy = 0; cy < map.height; cy++) {
    const bank = banked ? bankForRow(cy % SCREEN_ROWS) : 0
    for (let cx = 0; cx < map.width; cx++) {
      const tile = layer.data[cy * map.width + cx] ?? 0
      const pixels = banked ? bankTilePixels(tiles, bank, tile) : tilePixels(tiles, tile)
      for (let y = 0; y < TILE_SIZE; y++)
        for (let x = 0; x < TILE_SIZE; x++)
          indices[(cy * TILE_SIZE + y) * width + cx * TILE_SIZE + x] = pixels[y * TILE_SIZE + x]
    }
  }
  return { width, height, indices }
}

/** Canvas offset to a dot. Lives here, not in the `.vue`, because only this layer is tested. */
export function paintPointAt(session: MapSession, offsetX: number, offsetY: number, zoom: number): Point {
  // `zoom` is pixels per CELL (MapCanvas.vue), so a dot is that over TILE_SIZE.
  const dot = zoom / TILE_SIZE
  return { x: Math.floor(offsetX / dot), y: Math.floor(offsetY / dot) }
}

/**
 * Which bank a cell row is drawn in, or null when the tileset is not banked.
 * Wrapped by `SCREEN_ROWS` for the same reason `bankSheetOffset` is: a taller
 * map is editable in progress even though `validateMap` refuses it at export.
 */
export function paintBankOf(session: MapSession): ((cellRow: number) => number) | null {
  const tileset = session.tileset
  if (!tileset || !isBanked(tileset)) return null
  return (cellRow) => bankForRow(cellRow % SCREEN_ROWS)
}
```

- [ ] **Step 5: The stroke**

```ts
export function beginPaint(session: MapSession, role: 'fg' | 'bg'): void {
  session.paintRole = role
  session.paintPoints = []
  session.paintActive = true
}

/** Accumulates one drag segment. Resolution happens once, in `endPaint`. */
export function extendPaint(session: MapSession, from: Point, to: Point): void {
  if (!session.paintActive) return
  session.paintPoints.push(...pointsFor(session, from, to))
}

function pointsFor(session: MapSession, from: Point, to: Point): Point[] {
  if (session.paintTool === 'spray') return sprayPoints(to, session.brushRadius, session.brushDensity)
  if (session.paintTool === 'fill') {
    const tileset = session.tileset
    if (!tileset) return []
    const { width, height, indices } = renderMapPixels(doc(session), tileset, session.activeLayer)
    return fillPoints(indices, to, width, height)
  }
  return pixelToolPoints(session.paintTool, from, to, [], session.filledRect)
}
```

Read `fillPoints`' real signature in `tile-editor.ts:90` and pass whatever bounds it takes — the default is an 8×8 tile, which would flood only the origin cell.

```ts
/** Resolves the whole drag into the tileset as one undo step. */
export function endPaint(session: MapSession): void {
  if (!session.paintActive) return
  session.paintActive = false
  const points = session.paintPoints
  session.paintPoints = []
  const tileset = session.tileset
  const current = doc(session)
  const layer = current.layers[session.activeLayer]
  if (!tileset || !layer || !points.length) return

  const result = paintGrid(
    { width: current.width, height: current.height, tiles: layer.data },
    tileset,
    points,
    session.paintColor,
    session.paintRole,
    { write: session.paintWrite, bankOf: paintBankOf(session) ?? undefined }
  )
  if (result.refused) {
    session.status = result.refused
    offerPromotion(session, result)     // Task 10 defines this; a no-op stub until then
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

- [ ] **Step 6: The budget readout**

Reuse the tile editor's `bankBudgetLabel` (`tile/session.ts:460`) rather than reimplementing it, so both editors phrase the budget identically — it is 1-based ("bank 1: 3 + 2 shared = 5 / 256"). Export it from there if it is not already exported.

```ts
export function paintBudgetLabel(session: MapSession): string {
  const tileset = session.tileset
  if (!tileset) return ''
  if (!isBanked(tileset)) return `tiles: ${tileset.count}/${MAX_TILES}`
  return tileset.bankTiles.map((_, bank) => bankBudgetLabel(tileset, bank)).join('   ')
}
```

- [ ] **Step 7: Run tests, then break the stride to prove they bite**

Run: `npx vitest run src/renderer/src/editors/map src/renderer/src/stores src/shared` → PASS.
Then change `width: current.width` to `width: current.width * TILE_SIZE`, rerun, and confirm the "uses the grid width as stride" test fails. Put it back.

- [ ] **Step 8: Commit**

```bash
npm run check
git add src/renderer/src/editors/map/session.ts src/renderer/src/editors/map/session.test.ts
git commit -m "feat(map): a paint mode that resolves one stroke into the tileset once"
```

---

### Task 7: the canvas paint path, in its own component

**Files:**
- Create: `src/renderer/src/editors/map/MapPaintLayer.vue`
- Modify: `src/renderer/src/editors/map/MapCanvas.vue`

**Interfaces:**
- Consumes: `beginPaint`, `extendPaint`, `endPaint`, `paintPointAt` (Task 6).
- Produces: nothing other tasks depend on.

**No geometry in this file.** `paintPointAt` does the conversion and is tested; this component passes `offsetX`, `offsetY` and the canvas's `zoom` and does nothing else with numbers.

- [ ] **Step 1: Create `MapPaintLayer.vue`**

Props: `session`, `zoom`. It renders a transparent overlay sized to the canvas and:
- on `pointerdown`, calls `beginPaint(session, event.button === 2 ? 'bg' : 'fg')` and records `paintPointAt(session, event.offsetX, event.offsetY, zoom)` as `from`;
- on `pointermove` while down, computes `to` the same way, calls `extendPaint(session, from, to)`, then sets `from = to`;
- on `pointerup` / `pointerleave`, calls `endPaint(session)`;
- on `contextmenu`, calls `event.preventDefault()` so a right-drag paints instead of opening a menu.

- [ ] **Step 2: Mount it conditionally**

In `MapCanvas.vue`: `<MapPaintLayer v-if="session.mode === 'paint'" :session="session" :zoom="zoom" />` over the canvas, and make the existing cell-level pointer handlers return early when `session.mode !== 'tiles'`, so the two input paths can never both fire.

- [ ] **Step 3: Verify by hand**

`npm run dev`: draw with the left button and confirm the canvas updates; right-drag and confirm it paints the background role with no context menu; switch to Tiles and confirm stamping still works.

- [ ] **Step 4: Commit**

```bash
npm run check
git add src/renderer/src/editors/map/MapPaintLayer.vue src/renderer/src/editors/map/MapCanvas.vue
git commit -m "feat(map): the paint path is its own component over the canvas"
```

---

### Task 8: the paint sidebar and the mode toggle

**Files:**
- Create: `src/renderer/src/editors/map/MapPaintPanel.vue`
- Modify: `src/renderer/src/editors/map/MapEditorTab.vue` (the `TOOLS` list is at `:39-44` — there is **no** `MapToolbar.vue`), `src/renderer/src/editors/map/MapSidePanel.vue`

**Interfaces:**
- Consumes: `setMode`, `setPaintTool`, `setPaintColor`, `setPaintWrite`, `paintBudgetLabel` (Task 6).
- Produces: nothing.

- [ ] **Step 1: The mode toggle**

Two buttons — **Tiles** / **Paint** — bound to `setMode`, beside the existing `TOOLS` list in `MapEditorTab.vue`. When `mode === 'paint'`, show the `TileTool` buttons (`pencil`, `line`, `rect`, `fill`, `spray`) instead of the `MapTool` ones, reusing the tile editor's icons and labels.

**Hide the toggle entirely when the map is bitmap-mode** (`doc(session).cell` is set, or `session.tileset` is null): those maps have the screen editor, and paint mode would silently do nothing.

- [ ] **Step 2: `MapPaintPanel.vue`**

Shown in the side panel only when `mode === 'paint'`:
- the palette bound to `setPaintColor`, built from the tileset's palette as the tile editor's does;
- a **Write** control, `Fork tile` / `Edit tile`, bound to `setPaintWrite`, with the Edit option titled: *"Rewrites this tile everywhere it is used, in this map and any other map on this tileset."*;
- `paintBudgetLabel(session)` as a plain readout.

- [ ] **Step 3: Verify by hand**

`npm run dev`: confirm the palette, write toggle and budget appear; the budget rises on fork strokes and stays put on edit strokes; the Paint toggle is absent on a bitmap map.

- [ ] **Step 4: Commit**

```bash
npm run check
git add src/renderer/src/editors/map/MapPaintPanel.vue src/renderer/src/editors/map/MapEditorTab.vue src/renderer/src/editors/map/MapSidePanel.vue
git commit -m "feat(map): a paint sidebar with the palette, the write toggle and the budget"
```

---

### Task 9: New tiled screen

**Files:**
- Modify: `src/renderer/src/stores/resourcesStore.ts`, `src/shared/ipc.ts`, `src/main/menu.ts`, `src/renderer/src/commands.ts`
- Test: `src/renderer/src/stores/resourcesStore.test.ts` (create if absent)

**Interfaces:**
- Consumes: `createTilesDoc`, `createMapDoc`, `serializeResource`.
- Produces: `newTiledScreen(base)` and the `MenuCommand` value.

Creation today lives in `ResourcesPanel.vue:96-114`, which vitest does not cover. Put `newTiledScreen` in `resourcesStore.ts` so it is testable, and have the panel call it.

**`serializeResource` writes the document FLAT** (`resource.ts:261-264`) — there is no `.doc` wrapper in the JSON. A test doing `JSON.parse(text).doc` gets `undefined` and every assertion silently passes against a default-normalised document.

- [ ] **Step 1: Write the failing test**

```ts
it('writes a tileset and a 32x24 map that references it', async () => {
  const created = await newTiledScreen('res/title')

  expect(created).toEqual({ tileset: 'res/title.tiles.json', map: 'res/title.map.json' })

  const map = normalizeMap(JSON.parse(files['res/title.map.json']))
  expect(map.width).toBe(32)
  expect(map.height).toBe(SCREEN_ROWS)
  expect(map.tileset).toBe('res/title.tiles.json')

  const tiles = normalizeTiles(JSON.parse(files['res/title.tiles.json']))
  expect(tiles.reserveTile0).toBe(true)
})
```

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL — `newTiledScreen` is not defined.

- [ ] **Step 3: Implement**

```ts
/**
 * A tiled screen is a tileset plus a map — no third document type. Tile 0 is
 * reserved so an unpainted cell reads as blank instead of as whatever art
 * happens to land at index 0.
 */
export async function newTiledScreen(base: string): Promise<{ tileset: string; map: string }> {
  const tileset = `${base}.tiles.json`
  const map = `${base}.map.json`
  await window.api.invoke('fs:write', {
    path: tileset,
    content: serializeResource({ kind: 'tiles', doc: createTilesDoc('sc2', 1, true) })
  })
  await window.api.invoke('fs:write', {
    path: map,
    content: serializeResource({ kind: 'map', doc: createMapDoc(tileset, 32, SCREEN_ROWS) })
  })
  return { tileset, map }
}
```

- [ ] **Step 4: Wire the menu**

Add `'file.newTiledScreen'` to the `MenuCommand` union in `src/shared/ipc.ts` (follow the existing dotted convention at `:458-488`), an item under File → New in `src/main/menu.ts`, and a case in `src/renderer/src/commands.ts` that prompts for a name, calls `newTiledScreen`, opens the map tab and calls `setMode(session, 'paint')`.

- [ ] **Step 5: Run tests, verify by hand, commit**

```bash
npx vitest run src/renderer/src/stores
npm run check
git add -A src/renderer/src/stores src/renderer/src/commands.ts src/main/menu.ts src/shared/ipc.ts src/renderer/src/components
git commit -m "feat: New tiled screen scaffolds a tileset and a map, ready to paint"
```

---

### Task 10: promotion to banked at the 256-tile ceiling

**Files:**
- Modify: `src/renderer/src/editors/map/session.ts`, `src/renderer/src/editors/map/MapPaintPanel.vue`
- Test: `src/renderer/src/editors/map/session.test.ts`

**Interfaces:**
- Consumes: `packBankedTiles`, `renderMapPixels` (Task 6), `PaintGridResult.refusedBank` (Task 3).
- Produces: `canPromoteToBanked(session)`, `promoteToBanked(session)`, `offerPromotion(session, result)`.

**`packBankedTiles` returns a fresh document** (`tile.ts:663`): `reserveTile0`, `flags`, `blocks`, `export`, `palette` and `mode` are **not** carried over unless re-threaded. Losing `export` alone breaks the build for that tileset.

- [ ] **Step 1: Write the failing tests**

```ts
it('offers promotion only for a 32x24 map', async () => {
  const session = await openMap()          // fixture is 8x8
  expect(canPromoteToBanked(session)).toBe(false)

  resize(session, 32, SCREEN_ROWS)
  expect(canPromoteToBanked(session)).toBe(true)
})

it('promotion keeps the tileset fields packBankedTiles does not carry', async () => {
  const session = await openMap()
  resize(session, 32, SCREEN_ROWS)
  const before = useTilesetStore().patternDoc(TILES)!

  promoteToBanked(session)

  const after = useTilesetStore().patternDoc(TILES)!
  expect(isBanked(after)).toBe(true)
  expect(after.export).toEqual(before.export)
  expect(after.reserveTile0).toBe(before.reserveTile0)
  expect(after.palette).toEqual(before.palette)
})

it('promotion leaves the screen showing the same picture', async () => {
  const session = await openMap()
  resize(session, 32, SCREEN_ROWS)
  const tileset = useTilesetStore().patternDoc(TILES)!
  const before = renderMapPixels(doc(session), tileset, 0)

  promoteToBanked(session)

  const after = renderMapPixels(doc(session), useTilesetStore().patternDoc(TILES)!, 0)
  expect(after.indices).toEqual(before.indices)
})

it('refuses promotion on a taller map and says why', async () => {
  const session = await openMap()
  resize(session, 32, 40)
  useTilesetStore().set(TILES, fullTilesetFixture(), 'x')
  setMode(session, 'paint')

  beginPaint(session, 'fg')
  extendPaint(session, { x: 0, y: 0 }, { x: 0, y: 0 })
  endPaint(session)

  expect(session.status).toContain(`${SCREEN_ROWS} rows`)
  expect(session.promptPromote).toBeFalsy()
})
```

The third test is the one that catches a non-bank-aware renderer, so it must run **after** promotion has made the tileset banked.

- [ ] **Step 2: Run to verify they fail**

Expected: FAIL — not defined.

- [ ] **Step 3: Implement**

```ts
/**
 * Promotion is only legal at exactly 32×24: `packBankedTiles` takes a 256×192
 * image, and `validateMap` refuses a banked map that is not `SCREEN_ROWS` tall.
 */
export function canPromoteToBanked(session: MapSession): boolean {
  const current = doc(session)
  return (
    current.width === 32 &&
    current.height === SCREEN_ROWS &&
    !!session.tileset &&
    !isBanked(session.tileset)
  )
}
```

`promoteToBanked` renders the screen with `renderMapPixels`, hands the indices to `packBankedTiles`, and writes both documents — **re-threading every field the packer drops**:

```ts
  const packed = packBankedTiles(/* pixels, per its real signature */)
  const merged: TilesDoc = {
    ...packed.doc,
    mode: tileset.mode,
    palette: tileset.palette,
    reserveTile0: tileset.reserveTile0,
    flags: tileset.flags,
    blocks: tileset.blocks,
    export: tileset.export
  }
```

Read `packBankedTiles`' real signature and `BankedPackResult` shape before writing this; the layout it returns is the new map layer.

**Only the active layer is repacked.** A second layer's indices are stale after renumbering, so refuse promotion when the map has more than one tile layer, with a status saying so — this is a different case from the "other maps" warning and neither covers it.

In `endPaint`'s refusal branch:

```ts
function offerPromotion(session: MapSession, result: PaintGridResult): void {
  // Only a whole-tileset refusal can be solved by banking; a full BANK cannot.
  if (result.refusedBank !== null || session.promotionDeclined) return
  const current = doc(session)
  if (canPromoteToBanked(session)) {
    session.promptPromote = true
    return
  }
  if (current.height !== SCREEN_ROWS)
    session.status =
      `This screen is out of tiles. Switching to banked needs a map exactly ${SCREEN_ROWS} rows tall — this one is ${current.height}.`
}
```

`refusedBank` is why Task 3 returns it as a field: matching the message text would break the moment the wording changes.

**The triggering stroke is discarded, not replayed** — promotion renumbers, so its cell indices are stale by the time it completes.

- [ ] **Step 4: The prompt**

In `MapPaintPanel.vue`, when `session.promptPromote`: *"This screen is out of tiles. Switch to banked (three banks of 256)? This renumbers every tile in the tileset, so any other map using it will be rewritten."* Accept calls `promoteToBanked`; decline sets `session.promotionDeclined = true` and clears the flag, so the offer is made once per session rather than on every refused stroke.

- [ ] **Step 5: Run tests and commit**

```bash
npx vitest run src/renderer/src/editors/map src/shared/msx
npm run check
git add -A src/renderer/src/editors/map
git commit -m "feat(map): offer to switch a full screen to banked, once"
```

---

### Task 11: rebase, and the docs

**Files:**
- Modify: `src/renderer/src/editors/map/session.ts`, `src/renderer/src/editors/tile/session.ts` (comment only), `specs/10-map-screen-editors.md`, `CHANGELOG.md`
- Test: `src/renderer/src/editors/map/session.test.ts`

**Interfaces:** none produced.

**The invariant `edit` mode breaks.** `tile/session.ts:160-165` adopts external tileset changes as a new present *"because painting only ever appends, so the two can never disagree about an existing tile."* An `edit` stroke makes that false: it changes an existing tile, so a tile editor open on the same file can undo to a snapshot that silently reverts the map's stroke, and the map can restore a `before` over art someone else changed since.

- [ ] **Step 1: Write the failing test**

```ts
it('refuses to restore a tile someone else has changed since', async () => {
  const session = await openMap()
  setMode(session, 'paint')
  setPaintWrite(session, 'edit')
  beginPaint(session, 'fg')
  extendPaint(session, { x: 8, y: 0 }, { x: 8, y: 0 })
  endPaint(session)

  // Another editor rewrites the same tile.
  const store = useTilesetStore()
  const meddled = store.patternDoc(TILES)!
  const tiles = meddled.tiles.slice()
  tiles[1] = { pattern: new Array(8).fill(0x5a), color: new Array(8).fill(0xf1) }
  store.set(TILES, { ...meddled, tiles }, 'some/other/editor')

  undo(session)

  expect(store.patternDoc(TILES)!.tiles[1].pattern[0]).toBe(0x5a)   // not clobbered
  expect(session.status).toContain('changed')
})
```

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL — undo restores blindly.

- [ ] **Step 3: Guard the restore**

In `swapTileEdits`, skip any edit whose current entry no longer equals the art this session painted, and set a status naming how many were skipped. That needs the painted entry, so record it on `TileEdit` as `after: TileEntry` in Task 4's push (add the field there and thread it) — or compare against the entry the swap is about to displace and skip when it differs from what this history step wrote.

- [ ] **Step 4: Correct the tile editor's comment**

`tile/session.ts:160-165` states the append-only justification as fact. Amend it: painting a *map* in edit mode can change an existing tile, so adoption is no longer loss-free, and the map guards its own restore.

- [ ] **Step 5: specs/10 and CHANGELOG**

Add a "Painting a tiled screen" section to `specs/10-map-screen-editors.md`: the Tiles/Paint toggle, `fork` vs `edit` and that `edit` reaches every map on the tileset, bank-local read and allocation, the budget readout, New tiled screen, and the one-time promotion offer with its 32×24 and single-layer requirements.

`CHANGELOG.md` under `[Unreleased]`, naming the two things a user can be surprised by: an `edit` stroke changes every map using that tile, and promotion renumbers the tileset.

**`agent-guide.ts` needs nothing** — the emitted C, the generated file names and the way a resource is used from C are all unchanged. Say so in the commit message: per CLAUDE.md the guide is a deliverable whenever any of those change, so "no change needed" is a conclusion, not an omission.

- [ ] **Step 6: Run the full suite and commit**

```bash
npx vitest run src/shared src/renderer -t '^(?!.*generated headers compile into a ROM).+$'
npm run check
git add -A src/renderer/src/editors specs/10-map-screen-editors.md CHANGELOG.md
git commit -m "fix(paint): an edit stroke no longer clobbers a tile someone else changed"
```

---

## Self-Review

**Spec coverage:** the store prerequisite → Task 1; `paintGrid` core → Task 2; bank-aware reads and the second allocator → Task 3; `write` modes with the tile-0 and sc1 guards → Task 4; undo carrying the inverse, with the redo swap → Task 5; the stroke model, budget and hit test → Task 6; the editor surface → Tasks 7–8; creation from scratch → Task 9; the 256 ceiling and promotion → Task 10; rebase and the docs → Task 11. The spec's "SCREEN 1 needs no special handling" is carried by the existing `pair` plumbing plus Task 4's `beforeGroup`.

**Placeholders:** `promoteToBanked`'s body (Task 10 Step 3) and `fillPoints`' bounds (Task 6 Step 5) both say to read a real signature first rather than guessing it, because both were guessed wrong in the previous draft. Tasks 7–8 describe `.vue` markup in prose and name every function they call; neither may contain logic.

**Type consistency:** `PaintGrid`/`PaintGridResult`/`PaintOptions`/`TileEdit`/`refusedBank` are defined in Tasks 2–4 and used unchanged in 5–6 and 10. `MapEntry`/`MapHistory` are defined in Task 5 and consumed in 6 and 10. `paintBankOf` returns `((cellRow: number) => number) | null`, adapted to `PaintOptions.bankOf`'s optional with `?? undefined` at its one call site. Task 11 adds `after` to `TileEdit`, which Task 4 must therefore emit — noted in Task 11 Step 3 rather than left to collide.
