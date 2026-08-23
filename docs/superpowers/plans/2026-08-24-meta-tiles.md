# Meta-tiles as Authored Objects — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `*.meta-tiles.json` from a *set* of tile-index groups into a single authored object — its own size, animation frames and gameplay flags, painted in pixels — and let a map record hand-painted tiles *and* placed meta-tiles side by side.

**Architecture:** Pure logic lands in `src/shared/msx/` first (model → paint engine → map placements → export), each with Vitest coverage, before any renderer work. The renderer then gets one new Pinia store (`useTilesetStore`) that makes a `.tiles.json` a single shared document, and the two editors are rebuilt on top of it. Painting resolves pixels to tile indices on every stroke via copy-on-write into that shared bank, so the meta never owns pixels and no existing tile index ever shifts.

**Tech Stack:** TypeScript, Vue 3 `<script setup>`, Pinia, Vitest, Electron. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-24-meta-tiles-design.md` — read it before Task 1. It records six explicit decisions and the evidence behind them.

## Global Constraints

- **Stage 1 is pattern modes (SCREEN 1 / 2 / 4) and the map editor only.** Bitmap and multicolour pixel painting is stage 2. `.meta-btiles.json` shares the new document shape but keeps its cell-stamping editor.
- **Pure modules must not import Electron or Vue.** Everything in `src/shared/` runs unchanged in main, renderer and Vitest.
- **The tile bank is append-only.** No operation in this plan may renumber, delete or edit-in-place an existing tile in `TilesDoc.tiles`. Only the explicit `Compact` command may, and it publishes a `TilesReorderEvent`.
- **`MAX_TILES` is 256 and `MAX_META_SIZE` is 16.** Unchanged.
- **Emitted C calls MSXgl's own API**, never a reimplementation. Helper C is gated on `ExportBlock.helpers`; a data-only header must never reference the engine.
- **Every task ends green:** `npm run check` (lint + typecheck) and `npm run test` both pass before the commit step.
- Tests live next to their module, named `<module>.test.ts`.
- **Tasks 2 through 5 are one typecheck unit.** Task 2 deletes the set-shaped API
  that `resource.ts` still imports, and Task 5 is what rebuilds it. `npm run test`
  must stay green at every commit in between; `npm run check` will not be green
  again until Task 5, and each of those commits says so in its message. Do not
  paper over the gap with casts or stubs — the red typecheck is the list of call
  sites still to convert.
- Renderer components get no unit tests — per `CLAUDE.md`, renderer correctness rides on the shared modules it delegates to. Renderer tasks verify by running the app.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/shared/msx/meta-paint.ts` | The paint engine: pixels → tile indices, find-or-create, spray points. Pure. |
| `src/shared/msx/meta-paint.test.ts` | Its tests. |
| `src/renderer/src/stores/tilesetStore.ts` | Pinia store: one `TilesDoc` per path, shared by every editor. |
| `src/renderer/src/editors/meta/MetaCanvas.vue` | The pixel canvas for one frame. |
| `src/renderer/src/editors/meta/MetaFrameBar.vue` | Filmstrip, onion skin, playback. |
| `src/renderer/src/editors/meta/MetaSidePanel.vue` | Size, tileset, flags, tiles-used, Compact, export block. |
| `src/renderer/src/editors/map/MapMetaPicker.vue` | The sidebar's lower half — placeable meta-tiles. |

**Modified:**

| File | Change |
|---|---|
| `src/shared/msx/tile.ts` | `reserveTile0` field, tile-0 lock in `normalizeTiles`, `blankTileEntry()`. |
| `src/shared/msx/meta-tile.ts` | Rewritten to `MetaTileDoc` (one meta, frames, flags); set API deleted. |
| `src/shared/msx/map.ts` | `metas`/`placements` added; `MapDoc.meta` and the three meta-map helpers deleted. |
| `src/shared/msx/resource.ts` | Table/constant/helper/notes seams for the new shapes. |
| `src/shared/msx/quantize.ts` | Export `BAYER4`. |
| `src/shared/tile-editor.ts` | `'spray'` added to `TileTool`. |
| `src/renderer/src/editors/tile/session.ts` | Doc ownership moves to the store. |
| `src/renderer/src/editors/meta/session.ts` | Rewritten for one meta + frames + painting. |
| `src/renderer/src/editors/meta/MetaTileEditorTab.vue` | Shell over the three new components. |
| `src/renderer/src/editors/map/session.ts` | Placement state and actions. |
| `src/renderer/src/editors/map/MapCanvas.vue` | Draw, hit-test, drag placements. |
| `src/renderer/src/editors/map/MapSidePanel.vue` | Split picker; drop the meta-set branches. |
| `src/renderer/src/editors/map/sheet.ts` | Delete `metaSheet` (and its three cache globals); add `metaThumbnail`. |
| `src/renderer/src/editors/meta/MetaTileEditorTab.vue` | Rewritten — 865 lines of set-model UI, not adaptable. |
| `src/main/services/agent-guide.ts` | Meta-tile section rewritten. |
| `docs/tutorials/09-meta-tiles.md` | Rewritten. |
| `specs/10-map-screen-editors.md` | Placements and the store. |
| `CHANGELOG.md` | Move entries from `[Unreleased]` as they land. |

---

## Phase A — the shared model

### Task 1: `reserveTile0` on the tileset

**Files:**
- Modify: `src/shared/msx/tile.ts`
- Test: `src/shared/msx/tile.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `TilesDoc.reserveTile0: boolean`; `blankTileEntry(): TileEntry`; `createTilesDoc(mode, count, reserveTile0?)`.

- [ ] **Step 1: Write the failing tests**

Append to `src/shared/msx/tile.test.ts`:

```ts
describe('reserveTile0', () => {
  it('defaults to false so existing tilesets are untouched', () => {
    const doc = normalizeTiles({ mode: 'sc2', count: 4 })
    expect(doc.reserveTile0).toBe(false)
    // The 0xf1 white-on-black default still applies to tile 0.
    expect(doc.tiles[0].color[0]).toBe(0xf1)
  })

  it('forces tile 0 blank when set, discarding whatever art was there', () => {
    const doc = normalizeTiles({
      mode: 'sc2',
      count: 4,
      reserveTile0: true,
      tiles: [{ pattern: [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], color: [0x54, 0x54, 0x54, 0x54, 0x54, 0x54, 0x54, 0x54] }]
    })
    expect(doc.tiles[0].pattern).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    expect(doc.tiles[0].color).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })

  it('leaves every other tile alone', () => {
    const doc = normalizeTiles({
      mode: 'sc2',
      count: 2,
      reserveTile0: true,
      tiles: [{ pattern: [1, 1, 1, 1, 1, 1, 1, 1], color: [] }, { pattern: [2, 2, 2, 2, 2, 2, 2, 2], color: [] }]
    })
    expect(doc.tiles[1].pattern[0]).toBe(2)
  })

  it('blanks tile 0 in sc1 without touching the group pair, which serves 7 other tiles', () => {
    const doc = normalizeTiles({ mode: 'sc1', count: 8, reserveTile0: true, groupColors: [0x54] })
    expect(doc.tiles[0].pattern).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    expect(doc.groupColors[0]).toBe(0x54)
  })

  it('blankTileEntry is what tile 0 holds', () => {
    const doc = normalizeTiles({ mode: 'sc2', count: 1, reserveTile0: true })
    expect(doc.tiles[0]).toEqual(blankTileEntry('sc2'))
  })
})
```

Add `blankTileEntry` to the existing import at the top of the file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/shared/msx/tile.test.ts -t reserveTile0`
Expected: FAIL — `blankTileEntry is not a function`, `reserveTile0` undefined.

- [ ] **Step 3: Implement**

In `src/shared/msx/tile.ts`, add to the `TilesDoc` interface after `mode`:

```ts
  /**
   * Reserves tile 0 as "nothing": locked all-blank, drawn as a checkerboard,
   * and skipped when a meta-tile is stamped, which is what makes meta-tile
   * transparency possible at all — a name table has no holes, so the only way
   * to see through a cell is to not write it.
   *
   * False in every file written before meta-tiles became objects, because tile
   * 0 is real art in existing projects (demo_msx1 draws it 274 times). True for
   * newly created tilesets. Turning it on is a migration, not a toggle: see
   * `reserveTile0Migration` in the meta editor.
   */
  reserveTile0: boolean
```

Add the exported helper next to `zeros`:

```ts
/**
 * What tile 0 holds under `reserveTile0` — pattern and colour both zero, not
 * the `0xf1` white-on-black other blank tiles get. Colour 0 is the MSX's
 * transparent palette entry, so this renders through the checkerboard path the
 * tile canvas already has for index 0, with no new drawing code.
 */
export function blankTileEntry(mode: TileMode): TileEntry {
  return { pattern: zeros(TILE_SIZE), color: mode === 'sc1' ? [] : zeros(TILE_SIZE) }
}
```

In `normalizeTiles`, after the `tiles` loop and before the `groupCount` block:

```ts
  const reserveTile0 = input.reserveTile0 === true
  // Enforced here rather than at the call sites so a hand-edited file cannot
  // present art in tile 0 while claiming the flag.
  if (reserveTile0 && tiles[0]) tiles[0] = blankTileEntry(mode)
```

Add `reserveTile0` to the returned object. Note the sc1 group pair is deliberately *not* touched — it governs seven other tiles.

Extend `createTilesDoc`:

```ts
export function createTilesDoc(mode: TileMode = 'sc2', count = 256, reserveTile0 = true): TilesDoc {
  return normalizeTiles({ mode, count, reserveTile0 })
}
```

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run src/shared/msx/tile.test.ts && npm run check`
Expected: PASS. `createTilesDoc`'s new default makes newly created tilesets reserve tile 0; existing files are unaffected because `normalizeTiles` reads the stored value.

- [ ] **Step 5: Commit**

```bash
git add src/shared/msx/tile.ts src/shared/msx/tile.test.ts
git commit -m "feat(tiles): opt-in reserveTile0, locking tile 0 blank for meta transparency"
```

---

### Task 2: `MetaTileDoc` — one meta per file

**Files:**
- Modify: `src/shared/msx/meta-tile.ts` (rewrite the model half; helpers come in Task 5)
- Test: `src/shared/msx/meta-tile.test.ts` (rewrite)

**Interfaces:**
- Consumes: `TileBlock`, `MapCell`, `ExportBlock`.
- Produces: `MetaTileDoc`; `createMetaTileDoc(tileset, width, height, cell?)`; `normalizeMetaTile(raw)`; `metaCells(doc)`; `frameTileAt(doc, frame, tx, ty)`; `setFrameTile(doc, frame, tx, ty, tile)`; `addFrame(doc, copyOf?)`; `removeFrame(doc, index)`; `reorderFrames(doc, from, to)`; `resizeMeta(doc, width, height)`; `remapMetaTiles(doc, mapping)`; `validateMetaTile(doc)`; `metaFlagCount = 8`.

- [ ] **Step 1: Write the failing tests**

Replace `src/shared/msx/meta-tile.test.ts` with:

```ts
import { describe, expect, it } from 'vitest'
import {
  addFrame,
  createMetaTileDoc,
  frameTileAt,
  metaCells,
  normalizeMetaTile,
  removeFrame,
  reorderFrames,
  remapMetaTiles,
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
})

describe('frames', () => {
  const base = createMetaTileDoc('t.tiles.json', 2, 1)

  it('addFrame copies the frame it is given, so animation starts from a pose', () => {
    const painted = setFrameTile(base, 0, 0, 0, 7)
    const doc = addFrame(painted, 0)
    expect(doc.frames).toHaveLength(2)
    expect(doc.frames[1].tiles).toEqual([7, 0])
  })

  it('addFrame with no source appends a blank frame', () => {
    const doc = addFrame(setFrameTile(base, 0, 0, 0, 7))
    expect(doc.frames[1].tiles).toEqual([0, 0])
  })

  it('removeFrame refuses to remove the last one', () => {
    expect(removeFrame(base, 0)).toBe(base)
  })

  it('reorderFrames moves a frame', () => {
    const doc = reorderFrames(addFrame(setFrameTile(base, 0, 0, 0, 7), 0), 1, 0)
    expect(doc.frames[0].tiles).toEqual([7, 0])
  })

  it('setFrameTile is a no-op outside the meta', () => {
    expect(setFrameTile(base, 0, 5, 5, 3)).toBe(base)
  })

  it('frameTileAt reads back what was set', () => {
    expect(frameTileAt(setFrameTile(base, 0, 1, 0, 42), 0, 1, 0)).toBe(42)
  })
})

describe('resizeMeta', () => {
  it('keeps the tiles that still fit, anchored top-left, across every frame', () => {
    let doc = normalizeMetaTile({ tileset: 't', width: 2, height: 2, frames: [{ tiles: [1, 2, 3, 4] }, { tiles: [5, 6, 7, 8] }] })
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
    const mapping = [5, 6]
    const next = remapMetaTiles(doc, mapping)
    expect(next.frames[0].tiles).toEqual([5, 6])
    expect(next.frames[1].tiles).toEqual([6, 5])
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/shared/msx/meta-tile.test.ts`
Expected: FAIL — none of these exports exist.

- [ ] **Step 3: Implement the model**

Rewrite the top of `src/shared/msx/meta-tile.ts` (keep the `HelperC`/`defineName` imports; the helper functions are replaced in Task 5). Replace the module docblock, `MetaTilesDoc`, and every set-shaped function with:

```ts
/**
 * `*.meta-tiles.json` / `*.meta-btiles.json`: **one meta-tile** — a design
 * bigger than the hardware's 8×8 cell, authored as a picture and stored as
 * references into a tileset.
 *
 * This is the third instance of the pattern CLAUDE.md calls "a named group that
 * owns no pixels": like `TileBlock` and `SpriteCharacter`, a meta holds indices,
 * not art. What is new is that the *editor* presents it as a canvas — painting
 * a pixel resolves, through `meta-paint.ts`, to a tile index the same stroke
 * created or found. So the invariant survives a pixel-level editor: the meta
 * still owns nothing, and there is still no second copy to keep in sync.
 *
 * One file is one meta because a meta is now an object a level places — a tree,
 * a door, a coin — not a row in a compression table. Its size is its own, its
 * frames are its own, and its eight gameplay bits are its own, exactly as a
 * tile's are.
 */

/** Tiles per axis. A 16×16 meta is already 128×128 dots. */
export const MAX_META_SIZE = 16
/** Gameplay bits per meta — eight, so one byte, exactly `TILE_FLAG_COUNT`. */
export const META_FLAG_COUNT = 8
/** Frames per meta. A byte indexes them in the emitted C. */
export const MAX_FRAMES = 255

/** One animation pose: the whole meta's tile indices, row-major. */
export interface MetaFrame {
  tiles: number[]
}

export interface MetaTileDoc {
  version: 2
  /** Project-relative path of the tileset whose tiles this meta references. */
  tileset: string
  /** This meta's size in tiles. Every frame is exactly this. */
  width: number
  height: number
  /** Pixel geometry of one tile for a bitmap set; null in a pattern mode. */
  cell: MapCell | null
  /** `frames[0]` is the resting pose, as in `SpritesDoc`. Never empty. */
  frames: MetaFrame[]
  /**
   * Eight gameplay bits for the meta as a whole — what it *means* to the game,
   * in the manner of `TilesDoc.flags`. Independent of the flags on the tiles
   * underneath: a game walking the grid reads tile flags, a game walking a
   * map's placement table reads these, and neither overrides the other.
   */
  flags: number
  export: ExportBlock | null
}

export function createMetaTileDoc(tileset: string, width = 2, height = 2, cell: MapCell | null = null): MetaTileDoc {
  return normalizeMetaTile({ tileset, width, height, cell })
}

function extent(value: unknown, fallback: number): number {
  const n = Math.round(Number(value))
  return Number.isFinite(n) && n >= 1 ? Math.min(MAX_META_SIZE, n) : fallback
}

/** Fills in everything a hand-edited or older file is missing; never throws. */
export function normalizeMetaTile(raw: unknown): MetaTileDoc {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const width = extent(input.width, 2)
  const height = extent(input.height, 2)
  const cells = width * height

  // Version 1 held a *set*; its first meta is the only one that can survive as
  // this file's meta, and there is nowhere to put the others. No project has
  // one — the set model lived for a single commit — so this exists to keep an
  // in-flight working copy openable, not to preserve anyone's data.
  const legacy = Array.isArray(input.metas) ? (input.metas[0] as { tiles?: unknown } | undefined) : undefined
  const rawFrames = Array.isArray(input.frames) && input.frames.length
    ? (input.frames as { tiles?: unknown }[])
    : [{ tiles: legacy?.tiles }]

  const frames: MetaFrame[] = rawFrames.slice(0, MAX_FRAMES).map((frame) => ({
    // Resized to the document's geometry rather than kept as authored: the
    // exported table is read at a fixed stride, so one odd frame would shift
    // every frame after it.
    tiles: Array.from({ length: cells }, (_, i) => (Number((frame?.tiles as number[])?.[i]) || 0) & 0xff)
  }))

  return {
    version: 2,
    tileset: String(input.tileset ?? ''),
    width,
    height,
    cell: normalizeCell(input.cell),
    frames: frames.length ? frames : [{ tiles: new Array<number>(cells).fill(0) }],
    flags: (Number(input.flags) || 0) & 0xff,
    export: (input.export as ExportBlock | undefined) ?? null
  }
}
```

Keep `normalizeCell` unchanged. Then the accessors and mutators:

```ts
/** Tiles per frame — the stride of the exported table. */
export function metaCells(doc: MetaTileDoc): number {
  return doc.width * doc.height
}

export function frameTileAt(doc: MetaTileDoc, frame: number, tx: number, ty: number): number {
  return doc.frames[frame]?.tiles[ty * doc.width + tx] ?? 0
}

/** Every frame's tile indices, row-major, concatenated in frame order. */
export function metaBytes(doc: MetaTileDoc): Uint8Array {
  return Uint8Array.from(doc.frames.flatMap((frame) => frame.tiles.map((tile) => tile & 0xff)))
}

export function setFrameTile(doc: MetaTileDoc, frame: number, tx: number, ty: number, tile: number): MetaTileDoc {
  const current = doc.frames[frame]
  if (!current || tx < 0 || ty < 0 || tx >= doc.width || ty >= doc.height) return doc
  const at = ty * doc.width + tx
  if (current.tiles[at] === tile) return doc
  const tiles = current.tiles.slice()
  tiles[at] = tile & 0xff
  const frames = doc.frames.slice()
  frames[frame] = { tiles }
  return { ...doc, frames }
}

/** Appends a frame, copying `copyOf` when given — animation starts from a pose. */
export function addFrame(doc: MetaTileDoc, copyOf?: number): MetaTileDoc {
  if (doc.frames.length >= MAX_FRAMES) return doc
  const source = copyOf === undefined ? undefined : doc.frames[copyOf]
  const tiles = source ? source.tiles.slice() : new Array<number>(metaCells(doc)).fill(0)
  return { ...doc, frames: [...doc.frames, { tiles }] }
}

/** Removes a frame. The last one cannot go: a meta with no pose is not drawable. */
export function removeFrame(doc: MetaTileDoc, index: number): MetaTileDoc {
  if (doc.frames.length <= 1 || !doc.frames[index]) return doc
  return { ...doc, frames: doc.frames.filter((_, i) => i !== index) }
}

export function reorderFrames(doc: MetaTileDoc, from: number, to: number): MetaTileDoc {
  if (from === to || !doc.frames[from] || !doc.frames[to]) return doc
  const frames = doc.frames.slice()
  frames.splice(to, 0, ...frames.splice(from, 1))
  return { ...doc, frames }
}

/** Resizes the meta, keeping the tiles that still fit (top-left anchored). */
export function resizeMeta(doc: MetaTileDoc, width: number, height: number): MetaTileDoc {
  const w = Math.min(MAX_META_SIZE, Math.max(1, width | 0))
  const h = Math.min(MAX_META_SIZE, Math.max(1, height | 0))
  if (w === doc.width && h === doc.height) return doc
  const frames = doc.frames.map((frame) => {
    // Grown cells get tile 0 — the transparent one, so a meta that gets bigger
    // does not sprout opaque artwork along its new edge.
    const tiles = new Array<number>(w * h).fill(0)
    for (let y = 0; y < Math.min(h, doc.height); y++) {
      for (let x = 0; x < Math.min(w, doc.width); x++) tiles[y * w + x] = frame.tiles[y * doc.width + x] ?? 0
    }
    return { tiles }
  })
  return { ...doc, width: w, height: h, frames }
}

/** Replays a *tileset* reorder across every frame's references. */
export function remapMetaTiles(doc: MetaTileDoc, mapping: readonly number[]): MetaTileDoc {
  return { ...doc, frames: doc.frames.map((frame) => ({ tiles: frame.tiles.map((tile) => mapping[tile] ?? 0) })) }
}

export function validateMetaTile(doc: MetaTileDoc): string[] {
  const problems: string[] = []
  if (doc.version !== 2) problems.push(`Unsupported version ${doc.version}`)
  if (!doc.tileset) problems.push('No tileset referenced')
  if (doc.width < 1 || doc.width > MAX_META_SIZE || doc.height < 1 || doc.height > MAX_META_SIZE) {
    problems.push(`Meta size ${doc.width}×${doc.height} outside 1..${MAX_META_SIZE}`)
  }
  if (!doc.frames.length) problems.push('No frames')
  const cells = metaCells(doc)
  doc.frames.forEach((frame, index) => {
    if (frame.tiles.length !== cells) problems.push(`Frame ${index}: ${frame.tiles.length} tiles, expected ${cells}`)
  })
  return problems
}
```

Delete `MAX_METAS`, `metaStride`, `metaTileAt`, `setMetaTile`, `addMeta`, `renameMeta`, `resizeMetas`, `removeMeta`, `reorderMetas`, `validateMetaTiles`, `metaConstants`, `metaHelperC` and `bitmapMetaHelperC`. Constants and helpers are rebuilt in Task 5; the file will not typecheck until then, which is expected — `resource.ts` still imports the old names.

- [ ] **Step 4: Run the model tests**

Run: `npx vitest run src/shared/msx/meta-tile.test.ts`
Expected: PASS. `npm run check` still fails on `resource.ts` and the renderer — that is Task 5's and Phase B's job. Do not patch those here.

- [ ] **Step 5: Commit**

```bash
git add src/shared/msx/meta-tile.ts src/shared/msx/meta-tile.test.ts
git commit -m "feat(meta): one meta-tile per file, with animation frames and gameplay flags

Typecheck is red until the export seams are rebuilt (Task 5)."
```

---

### Task 3: the paint engine

**Files:**
- Create: `src/shared/msx/meta-paint.ts`
- Create: `src/shared/msx/meta-paint.test.ts`
- Modify: `src/shared/msx/quantize.ts` (export `BAYER4`)
- Modify: `src/shared/tile-editor.ts` (add `'spray'` to `TileTool`)

**Interfaces:**
- Consumes: `TilesDoc`, `TileEntry`, `blankTileEntry`, `paintPixel`, `tilePixels`, `colorByteAt`, `splitColorByte`, `MAX_TILES`, `SC1_GROUP`, `TILE_SIZE` from `tile.ts`; `MetaTileDoc`, `setFrameTile` from `meta-tile.ts`; `Point` from `tile-editor.ts`.
- Produces:
  ```ts
  findOrCreateTile(doc: TilesDoc, entry: TileEntry, pair?: number): { doc: TilesDoc; index: number } | null
  paintMeta(meta: MetaTileDoc, tiles: TilesDoc, frame: number, points: readonly Point[], color: number): PaintMetaResult
  sprayPoints(center: Point, radius: number, density: number): Point[]
  usedTiles(doc: MetaTileDoc): Set<number>
  interface PaintMetaResult { meta: MetaTileDoc; tiles: TilesDoc; added: number[]; dropped: number; refused?: string }
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/shared/msx/meta-paint.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createMetaTileDoc, frameTileAt } from './meta-tile'
import { findOrCreateTile, paintMeta, sprayPoints, usedTiles } from './meta-paint'
import { blankTileEntry, normalizeTiles, tilePixels, type TilesDoc } from './tile'

const bank = (over: Partial<TilesDoc> = {}): TilesDoc =>
  normalizeTiles({ mode: 'sc2', count: 4, reserveTile0: true, ...over })

describe('findOrCreateTile', () => {
  it('reuses an identical tile rather than appending — this is the dedup', () => {
    const doc = bank()
    const entry = { pattern: [1, 2, 3, 4, 5, 6, 7, 8], color: [0x21, 0x21, 0x21, 0x21, 0x21, 0x21, 0x21, 0x21] }
    const first = findOrCreateTile(doc, entry)!
    const second = findOrCreateTile(first.doc, entry)!
    expect(second.index).toBe(first.index)
    expect(second.doc.count).toBe(first.doc.count)
  })

  it('appends when the pattern is new, and never disturbs an existing index', () => {
    const doc = bank()
    const before = tilePixels(doc, 1)
    const result = findOrCreateTile(doc, { pattern: [9, 9, 9, 9, 9, 9, 9, 9], color: new Array(8).fill(0x21) })!
    expect(result.index).toBe(4)
    expect(result.doc.count).toBe(5)
    expect(tilePixels(result.doc, 1)).toEqual(before)
  })

  it('returns null when the bank is full — the caller refuses the whole stroke', () => {
    const full = bank({ count: 256 })
    expect(findOrCreateTile(full, { pattern: [0xaa, 0, 0, 0, 0, 0, 0, 0], color: new Array(8).fill(0x21) })).toBeNull()
  })

  it('matches the reserved blank at index 0 instead of appending a second blank', () => {
    const doc = bank()
    expect(findOrCreateTile(doc, blankTileEntry('sc2'))!.index).toBe(0)
  })

  it('sc1: reuses a tile only when its group pair matches too', () => {
    const doc = normalizeTiles({ mode: 'sc1', count: 16, reserveTile0: true, groupColors: [0x21, 0x54] })
    const entry = { pattern: [3, 3, 3, 3, 3, 3, 3, 3], color: [] }
    const made = findOrCreateTile(doc, entry, 0x21)!
    // Same pattern, different pair: cannot reuse, because the pair is the art.
    const other = findOrCreateTile(made.doc, entry, 0x54)!
    expect(other.index).not.toBe(made.index)
  })

  it('sc1: pads to the next group when the current one has a different pair', () => {
    // count 12 -> next append lands at 12, which is in group 1 (pair 0x54).
    const doc = normalizeTiles({ mode: 'sc1', count: 12, reserveTile0: true, groupColors: [0x21, 0x54] })
    const made = findOrCreateTile(doc, { pattern: [7, 7, 7, 7, 7, 7, 7, 7], color: [] }, 0x21)!
    expect(made.index).toBe(16)
    expect(made.doc.groupColors[2]).toBe(0x21)
  })
})

describe('paintMeta', () => {
  const meta = createMetaTileDoc('t.tiles.json', 2, 1)

  it('paints a pixel by creating a tile and repointing the cell — copy on write', () => {
    const doc = bank()
    const result = paintMeta(meta, doc, 0, [{ x: 0, y: 0 }], 5)
    expect(result.dropped).toBe(0)
    expect(result.added).toHaveLength(1)
    expect(frameTileAt(result.meta, 0, 0, 0)).toBe(result.added[0])
    // Tile 0 is untouched: nothing else that pointed at it has changed.
    expect(tilePixels(result.tiles, 0)).toEqual(tilePixels(doc, 0))
  })

  it('leaves the other cell alone', () => {
    const result = paintMeta(meta, bank(), 0, [{ x: 0, y: 0 }], 5)
    expect(frameTileAt(result.meta, 0, 1, 0)).toBe(0)
  })

  it('drops a pixel that would need a third colour in its row, and counts it', () => {
    // Row 0 already uses both of its pair: 0x21 = fg 2, bg 1, pattern 0xf0.
    const doc = normalizeTiles({
      mode: 'sc2',
      count: 2,
      reserveTile0: true,
      tiles: [{ pattern: [], color: [] }, { pattern: [0xf0, 0, 0, 0, 0, 0, 0, 0], color: new Array(8).fill(0x21) }]
    })
    const seeded = { ...meta, frames: [{ tiles: [1, 0] }] }
    const result = paintMeta(seeded, doc, 0, [{ x: 0, y: 0 }], 7)
    expect(result.dropped).toBe(1)
    expect(result.added).toEqual([])
    expect(frameTileAt(result.meta, 0, 0, 0)).toBe(1)
  })

  it('refuses the whole stroke when the bank is full, changing nothing', () => {
    const full = bank({ count: 256 })
    const result = paintMeta(meta, full, 0, [{ x: 0, y: 0 }], 5)
    expect(result.refused).toMatch(/256/)
    expect(result.meta).toBe(meta)
    expect(result.tiles).toBe(full)
  })

  it('erasing a whole cell resolves back to tile 0 through ordinary dedup', () => {
    const doc = bank()
    const painted = paintMeta(meta, doc, 0, [{ x: 0, y: 0 }], 5)
    const cell = Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => ({ x, y }))).flat()
    const erased = paintMeta(painted.meta, painted.tiles, 0, cell, 0)
    expect(frameTileAt(erased.meta, 0, 0, 0)).toBe(0)
  })

  it('two cells painted identically share one tile', () => {
    const result = paintMeta(meta, bank(), 0, [{ x: 0, y: 0 }, { x: 8, y: 0 }], 5)
    expect(frameTileAt(result.meta, 0, 0, 0)).toBe(frameTileAt(result.meta, 0, 1, 0))
    expect(result.added).toHaveLength(1)
  })

  it('ignores points outside the meta', () => {
    const result = paintMeta(meta, bank(), 0, [{ x: 99, y: 99 }], 5)
    expect(result.meta).toBe(meta)
  })
})

describe('sprayPoints', () => {
  it('is deterministic — the same call twice gives the same art', () => {
    expect(sprayPoints({ x: 10, y: 10 }, 3, 8)).toEqual(sprayPoints({ x: 10, y: 10 }, 3, 8))
  })

  it('stays inside the brush radius', () => {
    for (const p of sprayPoints({ x: 10, y: 10 }, 3, 16)) {
      expect((p.x - 10) ** 2 + (p.y - 10) ** 2).toBeLessThanOrEqual(9)
    }
  })

  it('density 16 fills the disc and density 0 paints nothing', () => {
    expect(sprayPoints({ x: 10, y: 10 }, 2, 0)).toEqual([])
    expect(sprayPoints({ x: 10, y: 10 }, 2, 16).length).toBeGreaterThan(
      sprayPoints({ x: 10, y: 10 }, 2, 8).length
    )
  })

  it('is keyed to absolute coordinates, so overlapping dabs form one dither field', () => {
    const a = sprayPoints({ x: 8, y: 8 }, 4, 8)
    const b = sprayPoints({ x: 10, y: 8 }, 4, 8)
    const overlap = a.filter((p) => b.some((q) => q.x === p.x && q.y === p.y))
    expect(overlap.length).toBeGreaterThan(0)
    // Every shared coordinate is on in both, never on in one and off in the other.
    for (const p of overlap) expect(b.some((q) => q.x === p.x && q.y === p.y)).toBe(true)
  })

  it('never returns a negative coordinate', () => {
    for (const p of sprayPoints({ x: 1, y: 1 }, 4, 16)) {
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('usedTiles', () => {
  it('collects every index across every frame', () => {
    const doc = { ...createMetaTileDoc('t', 2, 1), frames: [{ tiles: [1, 2] }, { tiles: [2, 3] }] }
    expect([...usedTiles(doc)].sort()).toEqual([1, 2, 3])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/shared/msx/meta-paint.test.ts`
Expected: FAIL — `Cannot find module './meta-paint'`.

- [ ] **Step 3: Export `BAYER4` and add the spray tool**

In `src/shared/msx/quantize.ts` change `const BAYER4 = [` to `export const BAYER4 = [`.

In `src/shared/tile-editor.ts`:

```ts
export type TileTool = 'pencil' | 'line' | 'rect' | 'fill' | 'spray'
```

`toolPoints` already switches on the tool; leave it — spray computes its own points and never goes through `toolPoints`.

- [ ] **Step 4: Implement the engine**

Create `src/shared/msx/meta-paint.ts`:

```ts
/**
 * Painting a meta-tile in pixels, when a meta-tile owns no pixels.
 *
 * The meta editor shows a canvas; the document underneath holds tile indices.
 * This module is the bridge, and it works **copy-on-write**: a stroke never
 * edits a tile in place, it derives the tile the cell *would* now look like and
 * then finds or creates that tile in the bank. Two consequences make the whole
 * feature safe:
 *
 * - Nothing that already pointed at a tile can be changed by painting a meta.
 *   A map drawn with tile 12 keeps tile 12; the meta moves to tile 87.
 * - The bank is append-only, so no index ever shifts and no other document ever
 *   needs to be renumbered. The price is orphans — undo repoints the cell and
 *   leaves the tile behind — which is what the editor's explicit Compact
 *   command is for. It is never automatic: reachability across maps, blocks and
 *   metas that are not open is not knowable from here.
 *
 * The hardware constraint is not reimplemented. `paintPixel` in `tile.ts`
 * already decides whether a pixel fits a row's (or an sc1 group's) two colours,
 * and already reports the conflict when it does not. This module runs it
 * against a **scratch one-tile document** holding a copy of the cell's tile —
 * so the answer is the tile editor's answer, arrived at without touching the
 * real bank.
 */

import { BAYER4 } from './quantize'
import type { Point } from '../tile-editor'
import {
  blankTileEntry,
  colorByteAt,
  MAX_TILES,
  paintPixel,
  SC1_GROUP,
  TILE_SIZE,
  type TileEntry,
  type TilesDoc
} from './tile'
import { metaCells, setFrameTile, type MetaTileDoc } from './meta-tile'

export interface PaintMetaResult {
  meta: MetaTileDoc
  tiles: TilesDoc
  /** Indices appended by this stroke — what Compact would reclaim if undone. */
  added: number[]
  /** Points the hardware colour limit refused. Reported, never fatal. */
  dropped: number
  /** Set when nothing could be done at all; `meta` and `tiles` are unchanged. */
  refused?: string
}

/** `SC1_GROUP` is 8, so the group of tile `i` is `i >> 3`. */
const SC1_SHIFT = 3

const sameEntry = (a: TileEntry, b: TileEntry): boolean =>
  a.pattern.every((byte, i) => byte === b.pattern[i]) && a.color.every((byte, i) => byte === b.color[i])

/**
 * The index of a tile identical to `entry`, creating it if the bank has none.
 * `pair` is the sc1 group colour the tile must live under; ignored elsewhere,
 * where colour travels in `entry.color`.
 *
 * Null means the bank is full — 256 tiles is a hardware ceiling, not a policy.
 */
export function findOrCreateTile(doc: TilesDoc, entry: TileEntry, pair?: number): { doc: TilesDoc; index: number } | null {
  const sc1 = doc.mode === 'sc1'
  for (let i = 0; i < doc.count; i++) {
    const candidate = doc.tiles[i]
    if (!candidate || !sameEntry(candidate, entry)) continue
    // In sc1 the pattern is only half the art: two tiles with identical bits
    // under different pairs are different pictures.
    if (sc1 && doc.groupColors[i >> SC1_SHIFT] !== pair) continue
    return { doc, index: i }
  }

  let index = doc.count
  const groupColors = doc.groupColors.slice()
  if (sc1) {
    // A tile can only be appended at `count`, so it lands in whatever group
    // `count` falls in. If that group already serves a different pair, skip to
    // the next boundary rather than recolour seven tiles that are not ours.
    const group = index >> SC1_SHIFT
    const fresh = index % SC1_GROUP === 0
    if (!fresh && groupColors[group] !== pair) index = (group + 1) * SC1_GROUP
    if (index + 1 > MAX_TILES) return null
    groupColors[index >> SC1_SHIFT] = pair ?? 0xf1
  }
  if (index >= MAX_TILES) return null

  const tiles = doc.tiles.slice()
  // Padding, when sc1 skipped a group boundary. Blank rather than a copy of
  // anything: these slots belong to no design.
  for (let i = doc.count; i < index; i++) tiles[i] = blankTileEntry(doc.mode)
  tiles[index] = { pattern: entry.pattern.slice(), color: entry.color.slice() }

  const count = index + 1
  const flags = doc.flags.slice()
  for (let i = doc.count; i < count; i++) flags[i] = 0
  return { doc: { ...doc, count, tiles, groupColors, flags }, index }
}

/** A one-tile document holding a copy of `tile`, for `paintPixel` to work on. */
function scratch(doc: TilesDoc, tile: number): TilesDoc {
  const entry = doc.tiles[tile] ?? blankTileEntry(doc.mode)
  return {
    ...doc,
    count: 1,
    tiles: [{ pattern: entry.pattern.slice(), color: entry.color.slice() }],
    groupColors: doc.mode === 'sc1' ? [colorByteAt(doc, tile, 0)] : [],
    flags: [0],
    blocks: [],
    export: null
  }
}

/**
 * Applies a stroke to one frame of a meta.
 *
 * Points are in the meta's own pixel space — `(0,0)` is the meta's top-left
 * dot, not the tile's. Points outside it are ignored, so a drag that leaves the
 * canvas does not need clamping by the caller.
 */
export function paintMeta(
  meta: MetaTileDoc,
  tiles: TilesDoc,
  frame: number,
  points: readonly Point[],
  color: number
): PaintMetaResult {
  if (!meta.frames[frame]) return { meta, tiles, added: [], dropped: 0 }

  // Grouped by cell so each tile is derived once, however many points hit it.
  const byCell = new Map<number, Point[]>()
  for (const point of points) {
    const cx = Math.floor(point.x / TILE_SIZE)
    const cy = Math.floor(point.y / TILE_SIZE)
    if (point.x < 0 || point.y < 0 || cx >= meta.width || cy >= meta.height) continue
    const key = cy * meta.width + cx
    const list = byCell.get(key)
    if (list) list.push(point)
    else byCell.set(key, [point])
  }
  if (!byCell.size) return { meta, tiles, added: [], dropped: 0 }

  let nextMeta = meta
  let nextTiles = tiles
  const added: number[] = []
  let dropped = 0

  for (const [key, cellPoints] of byCell) {
    const cx = key % meta.width
    const cy = Math.floor(key / meta.width)
    const source = nextMeta.frames[frame].tiles[key] ?? 0

    let work = scratch(nextTiles, source)
    for (const point of cellPoints) {
      const result = paintPixel(work, 0, point.x % TILE_SIZE, point.y % TILE_SIZE, color)
      // The row (or sc1 group) already spends both its colours on something
      // else. Dropping the point is the whole-editor rule: no modal mid-drag.
      if (!result.ok) {
        dropped++
        continue
      }
      work = result.doc
    }

    const entry = work.tiles[0]
    const pair = nextTiles.mode === 'sc1' ? work.groupColors[0] : undefined
    const found = findOrCreateTile(nextTiles, entry, pair)
    if (!found) {
      // A half-drawn meta against a full bank is worse than no change at all.
      return { meta, tiles, added: [], dropped: 0, refused: `The tileset is full — ${MAX_TILES} tiles is the hardware limit. Run Compact unused tiles, or free a tile in the tile editor.` }
    }
    if (found.index >= nextTiles.count) added.push(found.index)
    nextTiles = found.doc
    nextMeta = setFrameTile(nextMeta, frame, cx, cy, found.index)
  }

  return { meta: nextMeta, tiles: nextTiles, added, dropped }
}

/**
 * The pixels a spray dab covers: a disc, thinned by an ordered Bayer threshold.
 *
 * Ordered rather than random, for two reasons. The same drag twice gives the
 * same art, which is what makes it testable. And the threshold is keyed to
 * *absolute* coordinates, so overlapping dabs agree about every pixel they
 * share — a slow drag builds one coherent dither field instead of the mottle
 * random spray produces.
 *
 * `density` runs 0–16, matching the Bayer matrix's own range.
 */
export function sprayPoints(center: Point, radius: number, density: number): Point[] {
  const points: Point[] = []
  const r = Math.max(0, radius | 0)
  for (let y = center.y - r; y <= center.y + r; y++) {
    for (let x = center.x - r; x <= center.x + r; x++) {
      if (x < 0 || y < 0) continue
      const dx = x - center.x
      const dy = y - center.y
      if (dx * dx + dy * dy > r * r) continue
      if (BAYER4[y & 3][x & 3] >= density) continue
      points.push({ x, y })
    }
  }
  return points
}

/** Every tile index this meta references, across every frame. */
export function usedTiles(doc: MetaTileDoc): Set<number> {
  const used = new Set<number>()
  for (const frame of doc.frames) for (const tile of frame.tiles) used.add(tile)
  return used
}

export { metaCells }
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/shared/msx/meta-paint.test.ts src/shared/msx/tile.test.ts`
Expected: PASS, all of them.

- [ ] **Step 6: Commit**

```bash
git add src/shared/msx/meta-paint.ts src/shared/msx/meta-paint.test.ts src/shared/msx/quantize.ts src/shared/tile-editor.ts
git commit -m "feat(meta): copy-on-write paint engine with dedup, drop-on-conflict and ordered spray"
```

---

### Task 4: map placements

**Files:**
- Modify: `src/shared/msx/map.ts`
- Test: `src/shared/msx/map.test.ts`
- Modify: `src/shared/map-editor.ts`

**Interfaces:**
- Consumes: `MetaTileDoc` (type only).
- Produces: `MetaRef`; `MetaPlacement`; `MapDoc.metas`; `MapLayer.placements`; `addMetaRef(doc, ref)`; `removeMetaRef(doc, slot)`; `placeMeta(doc, layer, slot, x, y)`; `removePlacement(doc, layer, index)`; `setPlacementBaked(doc, layer, index, baked)`; `placementAt(doc, layer, x, y)`; `placementBytes(doc)`.

- [ ] **Step 1: Write the failing tests**

Append to `src/shared/msx/map.test.ts`:

```ts
describe('meta-tile placements', () => {
  const ref = { path: 'res/tree.meta-tiles.json', name: 'tree', width: 2, height: 3, frames: 4, flags: 1 }
  const base = () => addMetaRef(normalizeMap({ tileset: 't.tiles.json', width: 8, height: 8 }), ref)

  it('normalizes a map with no placements to empty lists, so old files are unchanged', () => {
    const doc = normalizeMap({ tileset: 't.tiles.json', width: 4, height: 4 })
    expect(doc.metas).toEqual([])
    expect(doc.layers[0].placements).toEqual([])
  })

  it('places a meta on a layer', () => {
    const doc = placeMeta(base(), 0, 0, 3, 4)
    expect(doc.layers[0].placements).toEqual([{ slot: 0, x: 3, y: 4 }])
  })

  it('refuses a placement outside the grid', () => {
    const doc = base()
    expect(placeMeta(doc, 0, 0, 99, 0)).toBe(doc)
  })

  it('refuses an unknown slot', () => {
    const doc = base()
    expect(placeMeta(doc, 0, 7, 0, 0)).toBe(doc)
  })

  it('placementAt finds the topmost placement covering a cell — z-order is list order', () => {
    let doc = placeMeta(base(), 0, 0, 0, 0)
    doc = placeMeta(doc, 0, 0, 1, 1)
    expect(placementAt(doc, 0, 1, 1)).toBe(1)
    expect(placementAt(doc, 0, 0, 0)).toBe(0)
    expect(placementAt(doc, 0, 6, 6)).toBeNull()
  })

  it('removeMetaRef renumbers the slots of surviving placements', () => {
    let doc = addMetaRef(base(), { ...ref, path: 'res/coin.meta-tiles.json', name: 'coin' })
    doc = placeMeta(doc, 0, 1, 0, 0)
    doc = removeMetaRef(doc, 0)
    expect(doc.metas).toHaveLength(1)
    expect(doc.layers[0].placements[0].slot).toBe(0)
  })

  it('removeMetaRef drops the placements that referenced it', () => {
    let doc = placeMeta(base(), 0, 0, 0, 0)
    doc = removeMetaRef(doc, 0)
    expect(doc.layers[0].placements).toEqual([])
  })

  it('setPlacementBaked flips the flag', () => {
    const doc = setPlacementBaked(placeMeta(base(), 0, 0, 1, 1), 0, 0, true)
    expect(doc.layers[0].placements[0].baked).toBe(true)
  })

  it('placementBytes packs slot, baked, x and y into three bytes each', () => {
    let doc = placeMeta(base(), 0, 0, 3, 4)
    doc = setPlacementBaked(doc, 0, 0, true)
    expect([...placementBytes(doc)]).toEqual([0x80, 3, 4])
  })

  it('refuses a 129th meta, because the slot byte only has seven bits', () => {
    let doc = normalizeMap({ tileset: 't.tiles.json', width: 4, height: 4 })
    for (let i = 0; i < 130; i++) doc = addMetaRef(doc, { ...ref, path: `m${i}.meta-tiles.json`, name: `m${i}` })
    expect(doc.metas).toHaveLength(128)
  })

  it('validateMap reports a placement that hangs off the grid', () => {
    const doc = { ...placeMeta(base(), 0, 0, 7, 7), width: 8, height: 8 }
    expect(validateMap(doc).join(' ')).toMatch(/extends past/)
  })

  it('placementBytes walks every layer in order', () => {
    let doc = addLayer(base(), 'over')
    doc = placeMeta(doc, 0, 0, 1, 1)
    doc = placeMeta(doc, 1, 0, 2, 2)
    expect([...placementBytes(doc)]).toEqual([0, 1, 1, 0, 2, 2])
  })
})
```

Extend the file's imports: `addMetaRef`, `normalizeMap`, `placeMeta`, `placementAt`, `placementBytes`, `removeMetaRef`, `setPlacementBaked` come from `./map`; **`addLayer` comes from `../map-editor`** — layer operations live in the editor module, not the model one.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/shared/msx/map.test.ts -t placements`
Expected: FAIL — the exports do not exist.

- [ ] **Step 3: Delete the set model from `map.ts`**

Add placement validation to `validateMap`, replacing what the meta branches
checked. A placement's *origin* is inside the grid — `placeMeta` and
`normalizePlacements` both enforce that — but its far edge need not be, and a
meta hanging off the right of the map writes into the next row of the name
table at runtime:

```ts
  for (const layer of doc.layers) {
    for (const p of layer.placements) {
      const ref = doc.metas[p.slot]
      if (!ref) continue
      if (p.x + ref.width > doc.width || p.y + ref.height > doc.height) {
        problems.push(`"${ref.name}" at ${p.x},${p.y} on layer "${layer.name}" extends past the map`)
      }
    }
  }
```

This is a warning, not something to clamp: cropping a placement silently is
worse than telling the user their tree is half off the level.

Remove: the `meta` field from `MapDoc` and its docblock; `normalizeMeta`; the `import { MAX_META_SIZE } from './meta-tile'`; `mapTileSize`'s meta branch (it becomes `return { width: doc.width, height: doc.height }` — keep the function, callers use it); the `metaTileset` validation branch and the sc3-meta branch in `validateMap`; `metaMapHelperC`; `patternMetaHelperC`; `bitmapMetaHelperC`; and the `if (doc.meta) return metaMapHelperC(...)` line in `mapHelperC`.

- [ ] **Step 4: Add placements**

In `src/shared/msx/map.ts`:

```ts
/**
 * A meta-tile this map places, mirrored from its own file.
 *
 * Mirrored for the reason `MapCell` is: the exporter renders one resource at a
 * time and never opens another file, so everything the emitted C needs — the
 * symbol to `extern`, the size to advance by, the frame count, the flags a
 * game tests — has to be in the document in front of it.
 */
export interface MetaRef {
  /** Project-relative path of the `.meta-tiles.json`. */
  path: string
  /** Its export symbol — what the emitted helper `extern`s. */
  name: string
  width: number
  height: number
  frames: number
  flags: number
}

/**
 * One meta-tile dropped on a layer.
 *
 * A placement is a **live reference**: the tiles stay in the meta's file, the
 * grid underneath holds tile 0, and the emitted C draws it at runtime — which
 * is what lets an animated meta animate where it stands.
 *
 * `baked` is the opposite bargain, for static scenery. Frame 0's tiles are
 * written into the grid as well, so the layer write already draws it and it
 * costs nothing per frame; the record is kept only so the editor can re-stamp
 * it when the meta changes, and so the game can still find it.
 */
export interface MetaPlacement {
  /** Index into `MapDoc.metas`. */
  slot: number
  /** Top-left corner in tiles, on the map's own grid. */
  x: number
  y: number
  baked?: boolean
}
```

Add `metas: MetaRef[]` to `MapDoc` and `placements: MetaPlacement[]` to `MapLayer`. In `normalizeMap`, default both to `[]` — every map written before this has neither, and an empty list is exactly "an ordinary tilemap", so nothing existing changes behaviour:

```ts
function normalizeMetaRefs(raw: unknown): MetaRef[] {
  if (!Array.isArray(raw)) return []
  return raw.map((entry) => {
    const ref = (typeof entry === 'object' && entry !== null ? entry : {}) as Partial<MetaRef>
    const at = (value: unknown, fallback: number): number =>
      Number.isFinite(Number(value)) && Number(value) >= 1 ? Number(value) | 0 : fallback
    return {
      path: String(ref.path ?? ''),
      name: String(ref.name ?? 'meta'),
      width: at(ref.width, 1),
      height: at(ref.height, 1),
      frames: at(ref.frames, 1),
      flags: (Number(ref.flags) || 0) & 0xff
    }
  })
}

function normalizePlacements(raw: unknown, doc: { width: number; height: number }, slots: number): MetaPlacement[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry) => {
      const p = (typeof entry === 'object' && entry !== null ? entry : {}) as Partial<MetaPlacement>
      return { slot: Number(p.slot) | 0, x: Number(p.x) | 0, y: Number(p.y) | 0, baked: p.baked === true }
    })
    // A placement whose slot or position is gone would draw at a random spot
    // from a table that no longer has that entry.
    .filter((p) => p.slot >= 0 && p.slot < slots && p.x >= 0 && p.y >= 0 && p.x < doc.width && p.y < doc.height)
    .map((p) => (p.baked ? p : { slot: p.slot, x: p.x, y: p.y }))
}
```

Then the operations:

```ts
/**
 * The most metas one map may place. `placementBytes` spends bit 7 of the slot
 * byte on `baked`, so a slot is seven bits; a 128th meta would silently alias
 * onto slot 0 with `baked` set. The 256-tile bank underneath could not feed
 * anything near this many anyway.
 */
export const MAX_MAP_METAS = 128

export function addMetaRef(doc: MapDoc, ref: MetaRef): MapDoc {
  if (doc.metas.length >= MAX_MAP_METAS) return doc
  const existing = doc.metas.findIndex((m) => m.path === ref.path)
  // Re-adding refreshes the mirror — the meta may have been resized or gained
  // a frame since this map last saw it.
  if (existing >= 0) {
    const metas = doc.metas.slice()
    metas[existing] = ref
    return { ...doc, metas }
  }
  return { ...doc, metas: [...doc.metas, ref] }
}

/**
 * Drops a meta from the map, with every placement that used it, and renumbers
 * the slots above it. This is a *local* renumber — `metas` is this map's own
 * list — so unlike a tileset reorder it needs no event and no other document
 * hears about it.
 */
export function removeMetaRef(doc: MapDoc, slot: number): MapDoc {
  if (!doc.metas[slot]) return doc
  return {
    ...doc,
    metas: doc.metas.filter((_, i) => i !== slot),
    layers: doc.layers.map((layer) => ({
      ...layer,
      placements: layer.placements
        .filter((p) => p.slot !== slot)
        .map((p) => (p.slot > slot ? { ...p, slot: p.slot - 1 } : p))
    }))
  }
}

export function placeMeta(doc: MapDoc, layerIndex: number, slot: number, x: number, y: number): MapDoc {
  const layer = doc.layers[layerIndex]
  if (!layer || !doc.metas[slot] || x < 0 || y < 0 || x >= doc.width || y >= doc.height) return doc
  const layers = doc.layers.slice()
  layers[layerIndex] = { ...layer, placements: [...layer.placements, { slot, x, y }] }
  return { ...doc, layers }
}

export function removePlacement(doc: MapDoc, layerIndex: number, index: number): MapDoc {
  const layer = doc.layers[layerIndex]
  if (!layer?.placements[index]) return doc
  const layers = doc.layers.slice()
  layers[layerIndex] = { ...layer, placements: layer.placements.filter((_, i) => i !== index) }
  return { ...doc, layers }
}

export function setPlacementBaked(doc: MapDoc, layerIndex: number, index: number, baked: boolean): MapDoc {
  const layer = doc.layers[layerIndex]
  const placement = layer?.placements[index]
  if (!placement || placement.baked === baked) return doc
  const placements = layer.placements.slice()
  placements[index] = baked ? { ...placement, baked: true } : { slot: placement.slot, x: placement.x, y: placement.y }
  const layers = doc.layers.slice()
  layers[layerIndex] = { ...layer, placements }
  return { ...doc, layers }
}

/**
 * The topmost placement covering a cell, or null. Later placements draw over
 * earlier ones, so the search runs backwards — what the user sees on top is
 * what a click should select.
 */
export function placementAt(doc: MapDoc, layerIndex: number, x: number, y: number): number | null {
  const layer = doc.layers[layerIndex]
  if (!layer) return null
  for (let i = layer.placements.length - 1; i >= 0; i--) {
    const p = layer.placements[i]
    const ref = doc.metas[p.slot]
    if (!ref) continue
    if (x >= p.x && y >= p.y && x < p.x + ref.width && y < p.y + ref.height) return i
  }
  return null
}

/**
 * The exported placement table: three bytes each, every layer in order.
 *
 * `baked` rides in bit 7 of the slot byte so a placement stays three bytes; a
 * map with 128 distinct meta-tiles is far past anything the 256-tile bank
 * beneath it could feed.
 */
export function placementBytes(doc: MapDoc): Uint8Array {
  const out: number[] = []
  for (const layer of doc.layers) {
    for (const p of layer.placements) {
      out.push((p.slot & 0x7f) | (p.baked ? 0x80 : 0), p.x & 0xff, p.y & 0xff)
    }
  }
  return Uint8Array.from(out)
}
```

- [ ] **Step 5: Update `map-editor.ts`**

`resizeMap` must drop placements that no longer fit, for the reason `normalizePlacements` filters them. In `src/shared/map-editor.ts`, after the layer data is resized, add:

```ts
    placements: layer.placements.filter((p) => p.x < width && p.y < height),
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/shared/msx/map.test.ts src/shared/map-editor.test.ts`
Expected: PASS. Existing map tests that asserted on `doc.meta` must be deleted, not adapted — that model is gone.

- [ ] **Step 7: Commit**

```bash
git add src/shared/msx/map.ts src/shared/msx/map.test.ts src/shared/map-editor.ts
git commit -m "feat(map): record placed meta-tiles; delete the meta-set map model"
```

---

### Task 5: export — tables, constants, helper C

**Files:**
- Modify: `src/shared/msx/meta-tile.ts` (constants + helpers)
- Modify: `src/shared/msx/map.ts` (placement helper)
- Modify: `src/shared/msx/resource.ts` (all four seams)
- Test: `src/shared/msx/meta-tile.test.ts`, `src/shared/msx/map.test.ts`, `src/shared/msx/resource.test.ts`

**Interfaces:**
- Consumes: `metaBytes`, `metaCells`, `placementBytes`, `MetaRef`.
- Produces: `metaConstants(doc, name)`; `metaHelperC(doc, name)`; `placementHelperC(doc, name)`; `mapConstants` gains the placement defines.

- [ ] **Step 1: Write the failing tests**

Append to `src/shared/msx/meta-tile.test.ts`, extending its import list with
`metaConstants` and `metaHelperC` — Task 2 rewrote that file and imported
neither:

```ts
describe('metaConstants', () => {
  it('states the geometry, the frame count and the flags', () => {
    const doc = { ...createMetaTileDoc('t.tiles.json', 2, 3), flags: 0x05 }
    const out = metaConstants(addFrame(doc, 0), 'tree')
    expect(out).toContain('#define TREE_META_W 2')
    expect(out).toContain('#define TREE_META_H 3')
    expect(out).toContain('#define TREE_FRAMES 2')
    expect(out).toContain('#define TREE_FLAGS 0x05')
  })
})

describe('metaHelperC', () => {
  it('draws a frame cell by cell, skipping the transparent tile', () => {
    const c = metaHelperC(createMetaTileDoc('t.tiles.json', 2, 2), 'tree')
    expect(c.header.join('\n')).toContain('void tree_Draw(u8 x, u8 y, u8 frame);')
    // A name table has no holes, so transparency can only be a skipped write.
    // Transparency is a *skipped* write, and the engine's own rectangle writer
    // is what does the writing — so a row becomes one call per opaque run.
    expect(c.source.join('\n')).toContain('while(run < TREE_META_W && src[run] != 0) ++run;')
    expect(c.source.join('\n')).toContain('VDP_WriteLayout_GM2(src + col, x + col, y + row, run - col, 1);')
  })

  it('offsets into the table by frame', () => {
    const c = metaHelperC(createMetaTileDoc('t.tiles.json', 2, 2), 'tree')
    expect(c.source.join('\n')).toContain('tree + ((u16)frame * 4)')
  })
})
```

Append to `src/shared/msx/map.test.ts`, adding `placementHelperC` to the
imports Task 4 established:

```ts
describe('placementHelperC', () => {
  const withMeta = () =>
    placeMeta(
      addMetaRef(normalizeMap({ tileset: 't.tiles.json', width: 8, height: 8 }), {
        path: 'res/tree.meta-tiles.json', name: 'tree', width: 2, height: 3, frames: 4, flags: 1
      }),
      0, 0, 1, 1
    )

  it('externs each placed meta and builds a table from them', () => {
    const c = placementHelperC(withMeta(), 'level')
    expect(c.source.join('\n')).toContain('extern const u8 tree[];')
    expect(c.source.join('\n')).toContain('void level_DrawPlacements(const u8* frames)')
  })

  it('skips baked placements, which the layer write already drew', () => {
    const c = placementHelperC(withMeta(), 'level')
    expect(c.source.join('\n')).toContain('if(slot & 0x80) continue;')
  })

  it('emits nothing when the map places no metas', () => {
    const c = placementHelperC(normalizeMap({ tileset: 't.tiles.json', width: 4, height: 4 }), 'level')
    expect(c.header).toEqual([])
    expect(c.source).toEqual([])
  })

})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/shared/msx/meta-tile.test.ts src/shared/msx/map.test.ts`
Expected: FAIL — `metaConstants`, `metaHelperC`, `placementHelperC` not exported.

- [ ] **Step 3: Implement the meta's constants and helper**

Append to `src/shared/msx/meta-tile.ts`:

```ts
/** `#define`s locating this meta in its exported table. */
export function metaConstants(doc: MetaTileDoc, name: string): string[] {
  const prefix = defineName(name)
  const out = [
    `#define ${prefix}_META_W ${doc.width}`,
    `#define ${prefix}_META_H ${doc.height}`,
    `#define ${prefix}_CELLS ${metaCells(doc)}`,
    `#define ${prefix}_FRAMES ${doc.frames.length}`,
    `#define ${prefix}_FLAGS 0x${doc.flags.toString(16).padStart(2, '0')}`
  ]
  if (doc.cell) {
    out.push(
      `#define ${prefix}_CELL_W ${doc.cell.width}`,
      `#define ${prefix}_CELL_H ${doc.cell.height}`,
      `#define ${prefix}_ATLAS_COLS ${doc.cell.cols}`
    )
  }
  return out
}

/**
 * The opt-in ready-made C: stamp one frame of this meta into the name table.
 *
 * Written cell by cell rather than with one `VDP_WriteLayout_GM2`, because a
 * meta is transparent where it holds tile 0 and a name table has no holes — the
 * only way to see through a cell is not to write it. A meta is a handful of
 * cells, so this is a handful of pokes.
 */
export function metaHelperC(doc: MetaTileDoc, name: string): HelperC {
  const prefix = defineName(name)
  if (doc.cell) return bitmapMetaHelperC(doc, name, prefix)

  const signature = `void ${name}_Draw(u8 x, u8 y, u8 frame)`
  return {
    header: [
      '',
      `// ── ${name}: a meta-tile ───────────────────────────────────────────────`,
      '//',
      `// Stamps frame \`frame\` at tile column/row (x, y). The meta is`,
      `// ${doc.width}×${doc.height} tiles${doc.frames.length > 1 ? ` and has ${doc.frames.length} frames` : ''}.`,
      '//',
      '// Cells holding tile 0 are skipped, so whatever is already on screen',
      '// shows through them. That is what makes a meta-tile transparent.',
      '//',
      '// Needs MSXgl\'s VDP module (#include "msxgl.h" before this header) built',
      '// with VDP_USE_MODE_G2 or VDP_USE_MODE_G3.',
      '//',
      '// Example:',
      `//   ${name}_Draw(10, 5, 0);`,
      `${signature};`
    ],
    source: [
      '',
      signature,
      '{',
      `\tconst u8* src = ${name} + ((u16)frame * ${prefix}_CELLS);`,
      `\tfor(u8 row = 0; row < ${prefix}_META_H; ++row)`,
      '\t{',
      '\t\tu8 col = 0;',
      `\t\twhile(col < ${prefix}_META_W)`,
      '\t\t{',
      '\t\t\tif(src[col] == 0) { ++col; continue; }',
      '\t\t\tu8 run = col;',
      `\t\t\twhile(run < ${prefix}_META_W && src[run] != 0) ++run;`,
      '\t\t\tVDP_WriteLayout_GM2(src + col, x + col, y + row, run - col, 1);',
      '\t\t\tcol = run;',
      '\t\t}',
      `\t\tsrc += ${prefix}_META_W;`,
      '\t}',
      '}'
    ]
  }
}
```

Keep the existing `bitmapMetaHelperC` but change its signature to `(doc: MetaTileDoc, name: string, prefix: string)`, drop the `example` parameter, and replace `((u16)meta * ${stride})` with `((u16)frame * ${prefix}_CELLS)` and the `u8 meta` parameter with `u8 frame`.

> **Why runs of `VDP_WriteLayout_GM2` rather than a poke per cell.** A poke per
> cell is the obvious shape, and it is wrong twice. `VDP_Poke_16K` takes
> `(value, dest)` — the reverse of what reads naturally — and it is 16K
> addressing only, so it cannot write a SCREEN 4 name table, which is a mode
> this feature targets. `VDP_WriteLayout_GM2` is the engine's own rectangle
> writer, it is what every other helper in this codebase emits, and splitting a
> row into opaque runs costs one call per run instead of one per cell. Its only
> requirement is `VDP_USE_MODE_G2` or `VDP_USE_MODE_G3`, which the header
> comment already states.

- [ ] **Step 4: Implement the map's placement helper**

Append to `src/shared/msx/map.ts`:

```ts
/**
 * The runtime side of placed meta-tiles: walk the placement table and draw each
 * live one.
 *
 * Baked placements are skipped — their tiles are already in the layer the map
 * just wrote, which is the whole point of baking them. They stay in the table
 * so the game can still find them, and so the editor can re-stamp them.
 */
export function placementHelperC(doc: MapDoc, name: string): HelperC {
  const placements = doc.layers.reduce((sum, layer) => sum + layer.placements.length, 0)
  if (!placements || !doc.metas.length) return { header: [], source: [] }

  const prefix = defineName(name)
  const signature = `void ${name}_DrawPlacements(const u8* frames)`
  return {
    header: [
      '',
      `// ── ${name}: placed meta-tiles ────────────────────────────────────────`,
      '//',
      `// Draws the ${placements} meta-tile${placements === 1 ? '' : 's'} this map places.`,
      '// `frames` is one byte per meta — frames[slot] is the frame that meta is',
      '// currently showing, so animating them is a matter of advancing that',
      '// array and calling this again.',
      '//',
      '// Baked placements are skipped: their tiles are already in the layer.',
      '//',
      '// Example:',
      `//   u8 frames[${prefix}_METAS] = { 0 };`,
      `//   ${name}_DrawPlacements(frames);`,
      `${signature};`
    ],
    source: [
      '',
      ...doc.metas.map((meta) => `extern const u8 ${meta.name}[];`),
      '',
      '// Mirrored from each meta-tile\'s own file, so this compiles without',
      '// including their headers.',
      `static const struct { const u8* tiles; u8 w; u8 h; u8 cells; } ${name}_Metas[${prefix}_METAS] = {`,
      ...doc.metas.map(
        (meta) => `\t{ ${meta.name}, ${meta.width}, ${meta.height}, ${meta.width * meta.height} },`
      ),
      '};',
      '',
      signature,
      '{',
      `\tconst u8* p = ${name}_Placements;`,
      `\tfor(u8 i = 0; i < ${prefix}_PLACEMENTS; ++i)`,
      '\t{',
      '\t\tu8 slot = *p++;',
      '\t\tu8 px = *p++;',
      '\t\tu8 py = *p++;',
      '\t\tif(slot & 0x80) continue;',
      `\t\tconst u8 w = ${name}_Metas[slot].w;`,
      `\t\tconst u8* src = ${name}_Metas[slot].tiles + ((u16)frames[slot] * ${name}_Metas[slot].cells);`,
      `\t\tfor(u8 row = 0; row < ${name}_Metas[slot].h; ++row)`,
      '\t\t{',
      '\t\t\tu8 col = 0;',
      '\t\t\twhile(col < w)',
      '\t\t\t{',
      '\t\t\t\tif(src[col] == 0) { ++col; continue; }',
      '\t\t\t\tu8 run = col;',
      '\t\t\t\twhile(run < w && src[run] != 0) ++run;',
      '\t\t\t\tVDP_WriteLayout_GM2(src + col, px + col, py + row, run - col, 1);',
      '\t\t\t\tcol = run;',
      '\t\t\t}',
      '\t\t\tsrc += w;',
      '\t\t}',
      '\t}',
      '}'
    ]
  }
}
```

There is no `mapConstants` function — a map's `#define`s are built inline in
`resourceConstants`, a **private** function in `resource.ts` (around line 662).
Edit it there: drop the `meta` destructuring and the meta `_TILE_W`/`_TILE_H`
branch, and add:

```ts
  if (doc.metas.length) {
    out.push(
      `#define ${prefix}_METAS ${doc.metas.length}`,
      `#define ${prefix}_PLACEMENTS ${doc.layers.reduce((sum, layer) => sum + layer.placements.length, 0)}`,
      // So a game can ask "is this one solid?" without including every meta's
      // header — the reason MetaRef mirrors flags at all.
      ...doc.metas.map((meta, index) => `#define ${prefix}_META_${defineName(meta.name)} ${index}`)
    )
  }
```

In `mapHelperC`, append `placementHelperC`'s lines to whatever the tile path returns.

Because `resourceConstants` is private, its behaviour is tested through
`resource.test.ts`'s existing `rendered()` helper rather than directly. Add
there:

```ts
it('counts the placements and names each placed meta', () => {
  const header = rendered(metaMap(), 'res/level.map.json', { ...defaultExport('g_Level'), helpers: true })
  expect(header).toContain('#define G_LEVEL_METAS 1')
  expect(header).toContain('#define G_LEVEL_PLACEMENTS 1')
  expect(header).toContain('#define G_LEVEL_META_TREE 0')
})
```

- [ ] **Step 5: Rewire `resource.ts`**

Four seams, all keyed on `isMetaKind(resource.kind)`:

1. **`resourceTables`** — replace the `metatiles`/`metabtiles` case:

```ts
    case 'metatiles':
    case 'metabtiles': {
      const { doc } = resource
      return [
        {
          suffix: '',
          bytes: metaBytes(doc),
          perLine: Math.min(16, metaCells(doc)),
          comment:
            `${doc.width}×${doc.height} tiles, ${doc.frames.length} frame${doc.frames.length === 1 ? '' : 's'} — ` +
            `tile indices row-major, ${metaCells(doc)} bytes per frame`
        }
      ]
    }
```

2. **`resourceTables`, the `map` case** — append the placement table when there is one:

```ts
      if (doc.metas.length && placementBytes(doc).length) {
        tables.push({
          suffix: '_Placements',
          bytes: placementBytes(doc),
          perLine: 3,
          comment: 'Placed meta-tiles: slot | baked<<7, x, y — three bytes each'
        })
      }
```

3. **notes** — replace the metatiles case:

```ts
    case 'metatiles':
    case 'metabtiles':
      notes.push(
        `Tileset: ${resource.doc.tileset}`,
        `Size: ${resource.doc.width}×${resource.doc.height} tiles`,
        `Frames: ${resource.doc.frames.length}`
      )
      if (resource.doc.flags) notes.push(`Flags: 0x${resource.doc.flags.toString(16).padStart(2, '0')}`)
      break
```

Add to the `map` notes: `if (doc.metas.length) notes.push(\`Meta-tiles: ${doc.metas.length}\`)`.

4. **helpers** — the meta branch loses its emptiness guard, because a meta always has a frame:

```ts
  if (isMetaKind(resource.kind)) return metaHelperC(resource.doc as MetaTileDoc, name)
```

Update every `MetaTilesDoc` type reference to `MetaTileDoc` and every `normalizeMetaTiles` call to `normalizeMetaTile` (the `parseResource` and `serializeResource` switches).

`src/shared/msx/resource.test.ts` still tests the set model and will not
compile. Three places:

- its `import { normalizeMetaTiles } from './meta-tile'` (line 5) → `normalizeMetaTile`;
- `describe('meta-tile resource')` (around line 515) — rewrite `metaSet()` as a
  one-meta fixture with `frames`, and replace the "one table at a fixed stride,
  with a define per named meta" test with one asserting the frame stride and
  `_FRAMES`/`_FLAGS`;
- the plain-map regression test (around line 469) asserts `expect(doc.meta).toBeNull()`
  — delete that line. Keep the rest of that test: it is the guard that a
  meta-tile change has not leaked into the path every existing project uses, and
  it matters more now than it did before.

- [ ] **Step 6: Run the whole suite**

Run: `npm run test && npm run check`
Expected: shared tests PASS. The renderer still references the deleted session API, so `typecheck:web` fails — Phase B fixes it. Confirm `typecheck:node` and every `src/shared` and `src/main` test is green before committing.

- [ ] **Step 7: Commit**

```bash
git add src/shared/msx/meta-tile.ts src/shared/msx/map.ts src/shared/msx/resource.ts src/shared/msx/*.test.ts
git commit -m "feat(export): meta-tile frame tables and map placement tables

Renderer typecheck is red until Phase B."
```

---

### Task 6: prove the emitted C on real hardware

**Files:**
- Create: `src/main/services/meta-build.test.ts`

Per `CLAUDE.md`, emitted C is never verified by reading it. This task is what catches a helper calling an MSXgl symbol that does not exist, or a `msxgl_config.h` default that leaves a module unresolved.

- [ ] **Step 1: Read the existing build test to copy its shape**

Run: `sed -n '1,80p' src/main/services/game-kit-build.test.ts`
Note how it locates the MSXgl checkout (`__fixtures__/msxgl.ts`), skips when missing, and puts scratch projects *beside* the checkout — never `/tmp`, because MSXgl renames `.rel` files across directories and `rename(2)` cannot cross filesystems.

- [ ] **Step 2: Write the test**

Create `src/main/services/meta-build.test.ts` modelled on `game-kit-build.test.ts`.
Reuse its scratch-project helper verbatim — do not write a second one. The
fixture it needs:

```ts
const tiles = normalizeTiles({ mode: 'sc2', count: 8, reserveTile0: true })

const meta = {
  ...createMetaTileDoc('res/tree.meta-tiles.json', 2, 3),
  frames: [{ tiles: [0, 1, 2, 3, 4, 5] }, { tiles: [0, 2, 1, 3, 5, 4] }],
  flags: 0x01,
  export: { ...defaultExport('tree'), helpers: true }
}

let map = addMetaRef(normalizeMap({ tileset: 'res/tiles.tiles.json', width: 32, height: 24 }), {
  path: 'res/tree.meta-tiles.json', name: 'tree', width: 2, height: 3, frames: 2, flags: 1
})
map = placeMeta(map, 0, 0, 4, 4)
map = placeMeta(map, 0, 0, 10, 8)
map = setPlacementBaked(map, 0, 1, true)
map = { ...map, export: { ...defaultExport('level'), helpers: true } }
```

The `main.c` the test writes:

```c
#include "msxgl.h"
#include "content/tiles.h"
#include "content/tree.h"
#include "content/level.h"

void main(void)
{
	u8 frames[G_LEVEL_METAS];
	frames[0] = 0;
	// GRAPHIC2, not "SCREEN2" — VDP_MODE_GRAPHIC2 is the name MSXgl uses, and it
	// is what demo_msx1/main.c:81 calls.
	VDP_SetMode(VDP_MODE_GRAPHIC2);
	VDP_LoadPattern_GM2(g_Tiles_Patterns, G_TILES_PATTERNS_SIZE / 8, 0);
	VDP_LoadColor_GM2(g_Tiles_Colors, G_TILES_COLORS_SIZE / 8, 0);
	g_Tree_Draw(10, 5, 0);
	g_Level_DrawPlacements(frames);
	while(1) { Halt(); }
}
```

Assertions:

```ts
expect(result.exitCode).toBe(0)
// An unresolved symbol is exactly the failure this test exists to catch: a
// helper calling an MSXgl function that does not exist under this config.
expect(result.output).not.toMatch(/\?ASlink-Warning-Undefined Global/)
expect(existsSync(join(project, 'out', 'meta_test.rom'))).toBe(true)
```

The symbol names come from each resource's `ExportBlock.name`, so the fixture
must set them to `g_Tiles`, `g_Tree` and `g_Level` for this `main.c` to link.
The table suffixes (`_Patterns`, `_Colors`) and the `_SIZE` defines follow the
convention `demo_msx1/main.c:88` and `demo_msx1/screens.c:64` use — these names
are grounded in working code, not memory. Ground any replacement the same way.

**There may be no MSXgl checkout on this machine**, in which case this test
skips and proves nothing. Check first:

```bash
node -e "console.log(require('fs').existsSync(require('os').homedir()+'/MSXgl/projects/template/template.c'))"
```

If it prints `false`, say so in the commit message rather than implying the
emitted C was verified. The helpers call only `VDP_WriteLayout_GM2`, which every
other emitted helper already uses and which `resource.test.ts` already asserts
on, so the residual risk is low — but low is not checked.

- [ ] **Step 3: Run it**

Run: `npx vitest run src/main/services/meta-build.test.ts`
Expected: PASS, or SKIP if no MSXgl checkout is present. ~40s.

If it fails on an unknown symbol, the helper C is wrong — fix `metaHelperC` / `placementHelperC` and re-run. Check the real names in the MSXgl clone (`grep -rn "VDP_Poke_16K\|g_ScreenLayout" <msxgl>/engine/src/`), not from memory.

- [ ] **Step 4: Boot the ROM**

```bash
OPENMSX_SYSTEM_DATA=<openmsx>/share <openmsx>/bin/openmsx \
  -machine C-BIOS_MSX2_EU -cart <rom> \
  -script <(echo 'after time 12 { screenshot -raw /tmp/meta.png; exit }')
```

C-BIOS needs ~10s before the cartridge runs. Look at the screenshot: the meta must appear at (10,5), the two placements at their coordinates, and the background must show through wherever the meta holds tile 0.

- [ ] **Step 5: Commit**

```bash
git add src/main/services/meta-build.test.ts
git commit -m "test(meta): compile and boot the emitted meta-tile and placement helpers"
```

---

## Phase B — the shared tileset store

### Task 7: `useTilesetStore`

**Files:**
- Create: `src/renderer/src/stores/tilesetStore.ts`
- Modify: `src/renderer/src/editors/tile/session.ts`

**Interfaces:**
- Produces:
  ```ts
  useTilesetStore(): {
    doc(path: string): TilesDoc | null
    load(path: string): Promise<TilesDoc>
    set(path: string, doc: TilesDoc, source: string): void
    save(path: string): Promise<void>
    isDirty(path: string): boolean
    release(path: string): void
    onExternalChange(path: string, source: string, fn: (doc: TilesDoc) => void): () => void
  }
  ```
  `source` is the id of whichever editor made the change (a tab path); a listener is never called for its own writes.

- [ ] **Step 1: Write the store**

Create `src/renderer/src/stores/tilesetStore.ts`:

```ts
/**
 * One `TilesDoc` per path, shared by every editor that draws with it.
 *
 * The meta-tile editor writes tiles into the tileset it references — that is
 * what "paint a meta in pixels" means when a meta owns no pixels. With a copy
 * per editor, the same `.tiles.json` open in a tile tab and two meta tabs would
 * be three documents, and whichever saved last would silently discard the other
 * two. So there is one document, here.
 *
 * Undo stays with the editors. Each keeps its own history of the snapshots *it*
 * made; when the store changes underneath it, it rebases — pushes the external
 * doc as its new present and drops its redo. That is safe precisely because
 * painting only ever *appends* tiles: two editors can disagree about which
 * tiles exist, never about what an existing tile looks like.
 *
 * Written in Pinia's **setup style**, unlike the option-style stores beside it.
 * The deviation is deliberate and confined to this file: the state here is a
 * keyed map plus a per-key listener registry, and the listeners are closures
 * that must not become reactive state — an option-style `state()` would either
 * expose them or need a module-level side table anyway. Follow the option style
 * for any store that does not have this shape.
 */

import { defineStore } from 'pinia'
import { ref } from 'vue'
import { normalizeTiles, type TilesDoc } from '../../../shared/msx/tile'
import { serializeResource } from '../../../shared/msx/resource'
import { useTabsStore } from './tabsStore'

type Listener = { source: string; fn: (doc: TilesDoc) => void }

export const useTilesetStore = defineStore('tileset', () => {
  const docs = ref(new Map<string, TilesDoc>())
  const dirty = ref(new Set<string>())
  const loading = new Map<string, Promise<TilesDoc>>()
  const listeners = new Map<string, Listener[]>()
  /** Per path, the reorder log that travels beside the document on disk. */
  const logs = new Map<string, TilesReorderEvent[]>()

  function doc(path: string): TilesDoc | null {
    return docs.value.get(path) ?? null
  }

  async function load(path: string): Promise<TilesDoc> {
    const held = docs.value.get(path)
    if (held) return held
    const inflight = loading.get(path)
    if (inflight) return inflight
    const promise = (async () => {
      const text = await window.api.invoke('fs:read', { path })
      const raw = (text.trim() ? JSON.parse(text) : {}) as { reorderLog?: TilesReorderEvent[] }
      const parsed = normalizeTiles(raw)
      logs.set(path, Array.isArray(raw.reorderLog) ? raw.reorderLog : [])
      docs.value.set(path, parsed)
      docs.value = new Map(docs.value)
      return parsed
    })().finally(() => loading.delete(path))
    loading.set(path, promise)
    return promise
  }

  /** Publishes a new doc. Every listener except `source`'s hears about it. */
  function set(path: string, next: TilesDoc, source: string): void {
    if (docs.value.get(path) === next) return
    docs.value.set(path, next)
    docs.value = new Map(docs.value)
    dirty.value.add(path)
    dirty.value = new Set(dirty.value)
    useTabsStore().setDirty(path, true)
    for (const listener of listeners.get(path) ?? []) {
      if (listener.source !== source) listener.fn(next)
    }
  }

  async function save(path: string): Promise<void> {
    const current = docs.value.get(path)
    if (!current) return
    // `reorderLog` is a *sibling key* of the document, not part of it — every
    // map and meta that draws with this tileset replays it on open to renumber
    // itself after a tile reorder. Serializing the doc alone silently deletes
    // it, and the damage only shows up the next time some other file opens.
    const saved: TilesDoc & { reorderLog?: TilesReorderEvent[] } = { ...current }
    const log = logs.get(path)
    if (log?.length) saved.reorderLog = log
    await window.api.invoke('fs:write', {
      path,
      content: serializeResource({ kind: 'tiles', doc: saved })
    })
    dirty.value.delete(path)
    dirty.value = new Set(dirty.value)
    useTabsStore().setDirty(path, false)
  }

  function isDirty(path: string): boolean {
    return dirty.value.has(path)
  }

  /** Dropped only when no tab holds it any more — `pruneTileSessions`'s job. */
  function release(path: string): void {
    if (dirty.value.has(path)) return
    docs.value.delete(path)
    docs.value = new Map(docs.value)
    listeners.delete(path)
    logs.delete(path)
  }

  /** Records a tile renumbering so it survives the save. Emitting it is the caller's job. */
  function appendReorder(path: string, event: TilesReorderEvent): void {
    logs.set(path, [...(logs.get(path) ?? []), event])
  }

  function reorderLog(path: string): TilesReorderEvent[] {
    return logs.get(path) ?? []
  }

  function onExternalChange(path: string, source: string, fn: (doc: TilesDoc) => void): () => void {
    const list = listeners.get(path) ?? []
    const entry = { source, fn }
    listeners.set(path, [...list, entry])
    return () => listeners.set(path, (listeners.get(path) ?? []).filter((l) => l !== entry))
  }

  return { doc, load, set, save, isDirty, release, onExternalChange, appendReorder, reorderLog }
})
```

- [ ] **Step 2: Move the tile session onto it**

In `src/renderer/src/editors/tile/session.ts`:

The session currently holds the document twice — `session.doc` and
`session.history` — and `session.doc` is read throughout the tile editor's
components. Do not try to delete it; turn it into a view onto the store, so
every existing call site keeps working:

```ts
// `doc` is no longer stored here. The store holds one per path, and this
// session is one of possibly several readers.
Object.defineProperty(session, 'doc', {
  get: () => useTilesetStore().doc(path) ?? createTilesDoc('sc2', 1)
})
```

Then:

- `load()` calls `useTilesetStore().load(path)` instead of reading and parsing
  itself, then `session.history = initHistory(doc)`. Its `session.reorderLog`
  read moves to the store — delete the local field and route the two call sites
  through `store.reorderLog(path)` / `store.appendReorder(path, event)`.
- `commit()` calls `useTilesetStore().set(session.path, doc, session.path)` after
  pushing history, and drops `session.doc = doc`.
- `saveSession()` calls `useTilesetStore().save(session.path)` and keeps only the
  `session.status = 'Saved'` line. The store handles the dirty flags and the
  `reorderLog` sibling key.
- `undo()`/`redo()` push the restored doc through `set()` as well, so the store
  follows. Note the tile editor imports `pushHistory` from
  `shared/tile-editor.ts` — a **different function** from the one in
  `shared/history.ts` of the same name, taking `(history, doc, label, remap?)`.
  Use the four-argument one here.
- `beginStroke`'s `session.strokeBase = session.doc` still works through the
  getter, and is still correct: a stroke's base is the doc as it was when the
  stroke began.
- In `tileSession()`, register the rebase:

```ts
  session.stopWatching = useTilesetStore().onExternalChange(path, path, (doc) => {
    // Another editor appended tiles. Adopt them as a new present rather than
    // merging: redo would otherwise replay onto a bank that has moved on.
    session.history = pushHistory(session.history, doc, 'Tiles added elsewhere')
  })
```

Add `stopWatching?: () => void` to `TileSession` and call it in `pruneTileSessions`, followed by `useTilesetStore().release(path)`.

- [ ] **Step 3: Verify by hand**

Run: `npm run check && npm run dev`
Open a `.tiles.json`, paint, undo, redo, save. Confirm the dirty dot appears and clears, and that nothing about the tile editor's behaviour has changed.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/stores/tilesetStore.ts src/renderer/src/editors/tile/session.ts
git commit -m "refactor(tiles): one shared TilesDoc per path in a Pinia store"
```

---

### Task 8: the meta session

**Files:**
- Modify: `src/renderer/src/editors/meta/session.ts` (rewrite)

**Interfaces:**
- Produces: `MetaSession` with `{ path, kind, history, doc, tilesetPath, frame, tool, color, brushRadius, density, onionSkin, playing, zoom, gridVisible, status, dropped }` — `kind` is `'metatiles' | 'metabtiles'`, from `resourceKindOf(path)`, and is what gates pixel painting to stage 1's modes; `paint(session, points)`; `setFrame`, `addFrame`, `removeFrame`, `reorderFrames`, `resize`, `setFlag`, `setTileset`, `compact(session)`, `saveSession`, `undo`, `redo`.

**Everything in the current session that goes:** `metaStride` (re-exported at
line 367), `addMetaFromTiles`, `renameMeta`, `removeMeta`, `reorderMetas`,
`resizeMetas`, `selectMeta`, `pickTile`, `paintCell`, `session.active`,
`session.brush`, `publishRemap`, and the `sheet()` accessor. `session.tileset` /
`bitmapTileset` / `atlas` go too — the store holds the doc now, and the session
holds only `tilesetPath`. Keep `onTilesReordered`, `replayPersistedReorders`,
`reorderLog` and `tilesetReorderSeen`: incoming tileset reorders still have to
be replayed, and that is unchanged.

- [ ] **Step 1: Rewrite the session**

Key points, following the existing file's structure:

- The doc is `History<MetaTileDoc>`, as before.
- The tileset comes from `useTilesetStore().load(doc.tileset)`; the session holds only the path.
- `paint(session, points)` is the core:

```ts
export function paint(session: MetaSession, points: Point[]): void {
  // Stage 1 paints pattern modes only. A `.meta-btiles.json` references a
  // bitmap tileset, which is not a TilesDoc and is not in this store at all —
  // its editor keeps stamping cells until stage 2.
  if (session.kind !== 'metatiles') return
  const store = useTilesetStore()
  const tiles = store.doc(session.tilesetPath)
  if (!tiles) return
  if (!tiles.reserveTile0) {
    session.status = 'This tileset does not reserve tile 0, so a meta cannot be transparent. Reserve it in the side panel.'
    return
  }
  const result = paintMeta(doc(session), tiles, session.frame, points, session.color)
  if (result.refused) {
    session.status = result.refused
    return
  }
  // Both documents move together, and both are marked dirty: a meta that
  // points at a tile the tileset has not saved yet is a broken file.
  if (result.tiles !== tiles) store.set(session.tilesetPath, result.tiles, session.path)
  commit(session, result.meta)
  session.dropped = result.dropped
  session.status = result.dropped ? `${result.dropped} pixels dropped: colour limit` : ''
}
```

- `saveSession` writes the meta **and** calls `store.save(session.tilesetPath)` if it is dirty. Saving one without the other leaves dangling indices.
- `compact(session)` is the one operation in this feature that **renumbers**, so
  it is the one that has to go through the full reorder seam — emitting the
  event is not enough, because a map that is not open hears nothing and would
  keep pointing at the old indices forever:

  ```ts
  const event: TilesReorderEvent = { path: session.tilesetPath, mapping, at: Date.now() }
  store.set(session.tilesetPath, compacted, session.path)
  store.appendReorder(session.tilesetPath, event)   // persisted: closed files replay on open
  emitTilesReordered(event)                          // live: open files renumber now
  ```

  Reachability is computed from what is *open*: this meta, every other open meta
  session, every open map session, and the tileset's own blocks. Guard it behind
  a confirm that names the count and says plainly that tiles used only by files
  which are not open will be removed. That is a real hazard and the user has to
  see it — the alternative, scanning the whole project, means reading every
  resource file on a button press, which is Task 13's follow-up, not this.
- `setTileset` reads the target, and if `reserveTile0` is false, offers the migration described in the spec: shift every index up by one, prepend `blankTileEntry`, set the flag, and publish the mapping on `emitTilesReordered` so open maps and metas renumber through the seam they already use.
- Keep the existing `onTilesReordered` subscription and `replayPersistedReorders`, changing `remapMetaTiles`'s doc type.

- [ ] **Step 2: Verify**

Run: `npm run check`
Expected: `typecheck:node` and `typecheck:web` both pass once `MetaTileEditorTab.vue` is stubbed to the new session API (Task 9 gives it a real UI; a compiling stub is enough here).

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/editors/meta/session.ts src/renderer/src/editors/meta/MetaTileEditorTab.vue
git commit -m "feat(meta): session over the shared tileset store, with paint and compact"
```

---

## Phase C — the meta-tile editor

### Task 9: the pixel canvas

**Files:**
- Create: `src/renderer/src/editors/meta/MetaCanvas.vue`
- Modify: `src/renderer/src/editors/meta/MetaTileEditorTab.vue`

- [ ] **Step 1: Build the canvas**

Model it on `src/renderer/src/editors/tile/TileCanvas.vue` — read that first; it already has the zoom, the grid overlay, the pointer-drag handling and the index-0 checkerboard at line 127.

Differences:
- It renders `meta.width * 8 × meta.height * 8` pixels, composed by looking each cell's tile up in the store's `TilesDoc` via `tilePixels`.
- A cell holding tile 0 draws the checkerboard, not tile 0's pixels.
- Tools: pencil, line, rect, fill, spray, picker. Pencil/line/rect/fill go through `toolPoints` from `tile-editor.ts`; spray calls `sprayPoints(point, session.brushRadius, session.density)` on every pointer move and paints the union.
- Fill flood-fills over the *composed* meta pixels, not one tile's. **`fillPoints` cannot do this as it stands**: it is hardcoded to one 8x8 tile — its `inTile(start)` guard and its `start.y * TILE_SIZE + start.x` indexing both assume `TILE_SIZE`. Generalise it first, in `src/shared/tile-editor.ts`, defaulting to today's behaviour so the tile editor's call sites are untouched:

```ts
export function fillPoints(
  pixels: ArrayLike<number>,
  start: Point,
  width = TILE_SIZE,
  height = TILE_SIZE
): Point[] {
```

Replace `inTile(start)` with an inline bounds test against `width`/`height`, and every `* TILE_SIZE` index with `* width`. Add a test to `tile-editor.test.ts`:

```ts
it('fills across a buffer wider than one tile', () => {
  const pixels = new Uint8Array(16 * 8)
  expect(fillPoints(pixels, { x: 0, y: 0 }, 16, 8)).toHaveLength(128)
})
```
- **Onion skin**: when `session.onionSkin` and `frame > 0`, draw frame `frame - 1` first at 30% alpha, then the current frame.

- [ ] **Step 2: Verify by hand**

Run: `npm run dev`. Create a `.tiles.json`, then a `.meta-tiles.json` pointing at it. Draw. Confirm:
- a stroke appears immediately and the tile count in the side panel grows;
- drawing the same shape in two cells grows the count by one, not two;
- erasing a cell completely returns it to the checkerboard;
- an sc2 stroke needing a third colour in a row is silently skipped and the status bar reports the count.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/editors/meta/MetaCanvas.vue src/renderer/src/editors/meta/MetaTileEditorTab.vue
git commit -m "feat(meta): pixel canvas with pencil, line, rect, fill, spray and onion skin"
```

---

### Task 10: frames and the side panel

**Files:**
- Create: `src/renderer/src/editors/meta/MetaFrameBar.vue`
- Create: `src/renderer/src/editors/meta/MetaSidePanel.vue`
- Modify: `src/renderer/src/editors/meta/MetaTileEditorTab.vue`

- [ ] **Step 1: The frame bar**

Model on `src/renderer/src/editors/sprite/SpriteAnimationBar.vue` — read it first. Same controls: a filmstrip of frame thumbnails, add / duplicate / delete / drag-reorder, a play toggle, an onion-skin checkbox, and a checkered-or-solid background select. Thumbnails compose from frame 0's tiles exactly as the canvas does.

- [ ] **Step 2: The side panel**

Model on `src/renderer/src/editors/tile/TileSidePanel.vue`. Sections:
- **Tileset** — the reference, a picker over `.tiles.json` resources, and the `reserveTile0` state with the migration button when it is off.
- **Size** — width and height in tiles, 1..16, calling `resize`.
- **Flags** — eight checkboxes, labelled the way the tile editor labels tile flags.
- **Palette** — MSX1's fixed 16, or the tileset's sc4 entries. In sc1, show only the current cell's group pair plus a "Change group pair" control.
- **Tiles** — "N of 256 used by this meta", and the **Compact unused tiles** button.
- **Export** — the standard `ExportBlock` editor, with the helpers checkbox.

- [ ] **Step 3: Verify by hand**

Run: `npm run dev`. Add frames, scrub, play, toggle onion skin, resize the meta and confirm art anchors top-left, set flags, and run Compact after some undo churn to confirm the count drops and open maps renumber.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/editors/meta/
git commit -m "feat(meta): frame bar with onion skin, and the side panel"
```

---

## Phase D — the map editor

### Task 11: the split sidebar

**Files:**
- Create: `src/renderer/src/editors/map/MapMetaPicker.vue`
- Modify: `src/renderer/src/editors/map/MapSidePanel.vue`
- Modify: `src/renderer/src/editors/map/session.ts`

- [ ] **Step 1: Drop the meta-set branches**

In `MapSidePanel.vue`: remove `metatiles`/`metabtiles` from `TILESET_KINDS`
(line 34), remove the `meta` computed (line 57) and every template branch that
reads it, and delete `chooseTileset`'s "switching to meta-tiles clears the map"
confirm (lines 45-53) — a map is always a tile map now.

In `map/session.ts`: delete `metaSet: MetaTilesDoc | null` (line 82), the
`meta` parameter threaded through `loadFromPath` (line 226) and its two
`parsed.doc as MetaTilesDoc` casts (lines 231, 437), `metaSizeOf`, and the
`spaceChanged` branch in `setTileset` (lines 388-396). A tileset change no
longer changes what a cell *means*, so it no longer clears the grid.

In `MapCanvas.vue`: delete `const meta = current.meta ?? { width: 1, height: 1 }`
(line 64) and the cell-size arithmetic that multiplies by it. A cell is one tile
again.

- [ ] **Step 2: The meta picker**

`MapMetaPicker.vue` lists every `.meta-tiles.json` whose `tileset` matches this
map's, with a frame-0 thumbnail and its name. Metas over another tileset are not
offered: their tile indices would mean nothing here.

**`ResourceEntry` is `{ path, kind, out }` and carries no `tileset`**
(`shared/ipc.ts:212`), so the store cannot answer this — each candidate file has
to be read. Do it once per map session, not per render:

```ts
/** Path -> its parsed doc, for every `.meta-tiles.json` over this map's tileset. */
async function loadCandidates(session: MapSession): Promise<Map<string, MetaTileDoc>> {
  const out = new Map<string, MetaTileDoc>()
  for (const entry of useResourcesStore().entries) {
    if (entry.kind !== 'metatiles') continue
    try {
      const parsed = normalizeMetaTile(JSON.parse(await window.api.invoke('fs:read', { path: entry.path })))
      // A meta over another tileset would paint indices into a bank that does
      // not have them; silently skipping is better than offering a trap.
      if (samePath(parsed.tileset, doc(session).tileset)) out.set(entry.path, parsed)
    } catch {
      // A malformed or half-written resource is not a reason to break the picker.
    }
  }
  return out
}
```

Refresh it when the resources store's `entries` changes and when the map's
tileset changes. `metabtiles` is deliberately excluded in stage 1 — a bitmap map
is stage 2.

Thumbnails need a renderer. `sheet.ts`'s `metaSheet` composed a *set* into one
sheet and is now dead — delete it along with `metaCacheBase`, `metaCacheSource`
and `metaCached`, and add:

```ts
/** One meta's frame 0, drawn from the tileset's own sheet. */
export function metaThumbnail(base: Sheet, meta: MetaTileDoc): HTMLCanvasElement
```

Selecting one sets `session.brush = { kind: 'meta', path }`. The session's brush becomes a union:

```ts
type MapBrush = { kind: 'tiles'; stamp: Stamp } | { kind: 'meta'; slot: number }
```

Picking a meta calls `addMetaRef` first (mirroring its name, size, frames and flags out of the file) and uses the returned slot.

- [ ] **Step 3: Lay them out**

In `MapSidePanel.vue`, the picker area becomes a vertical split: `MapPicker` on top, `MapMetaPicker` below, each scrolling independently, with a draggable divider.

- [ ] **Step 4: Verify and commit**

Run `npm run dev`, confirm the split appears and only same-tileset metas are listed.

```bash
git add src/renderer/src/editors/map/
git commit -m "feat(map): split sidebar — tiles above, placeable meta-tiles below"
```

---

### Task 12: placing, moving and baking

**Files:**
- Modify: `src/renderer/src/editors/map/MapCanvas.vue`
- Modify: `src/renderer/src/editors/map/session.ts`

- [ ] **Step 1: Draw placements**

After the layer's tiles, draw each placement's frame-0 tiles at its position, skipping tile 0 so the grid shows through. The selected placement gets an outline.

- [ ] **Step 2: Interact**

- Click with a meta brush → `placeMeta`.
- Click with no meta brush → `placementAt`; if it hits, select it, else fall through to the tile tools.
- Drag a selected placement → update its `x`/`y`, clamped to the grid.
- `Delete` → `removePlacement`.
- Context menu → **Bake** / **Unbake**. Baking calls `setPlacementBaked(true)` and writes frame 0's tiles into the layer with `applyStamp`; unbaking clears those cells back to tile 0.
- Painting a tile inside a **baked** placement drops its record — the receipt has stopped being true. Show a one-line status when it happens.

- [ ] **Step 3: Verify by hand**

Run `npm run dev`. Place a meta, drag it, bake it, paint over it, delete it. Then reopen the map and confirm the placements came back where you left them. Export and read the generated `.h`/`.c` to confirm the placement table matches.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/editors/map/
git commit -m "feat(map): place, move, bake and delete meta-tiles on the canvas"
```

---

## Phase E — the deliverables that are not code

### Task 13: guide, tutorial, spec, changelog

**Files:**
- Modify: `src/main/services/agent-guide.ts`
- Modify: `docs/tutorials/09-meta-tiles.md`
- Modify: `docs/index.md`, `docs/tutorials/README.md`, `docs/tutorials/03-tiles-and-maps.md`, `docs/resources.md`
- Modify: `src/renderer/src/components/ResourcesPanel.vue` (lines 44-45, 59-60)
- Modify: `specs/10-map-screen-editors.md`
- Modify: `CHANGELOG.md`
- Modify: `CLAUDE.md`

Per `CLAUDE.md`, `agent-guide.ts` is a deliverable, not a comment: it is the only thing an agent working inside a generated project knows about this IDE. This feature changes what the exporter emits, what a generated file contains, and how a resource is used from C, so it is not finished until the guide says so.

- [ ] **Step 1: `agent-guide.ts`**

Three places currently describe the set model, all of which are now wrong:

- **line 110** — the resource-kind list. `.meta-tiles.json` needs its one-line
  description changed from a set to a single meta.
- **lines 177-178** — "A **meta-tile set** … names those clumps once, and a map
  indexes them". This is the main section; rewrite it around the object model:
  one meta per file, its own size, `_FRAMES` frames, `_FLAGS`, and that a map
  *places* metas over an ordinary tile grid rather than indexing them instead
  of tiles.
- **line 546** — "A bitmap map drawn with a meta-tile set (`*.meta-btiles.json`)
  keeps that…". Stage 1 does not deliver bitmap meta placement, so this
  paragraph must say what is true today, not what the set model did.

The new material an agent needs: `_META_W`, `_META_H`, `_CELLS`, `_FRAMES`,
`_FLAGS`; `<name>_Draw(x, y, frame)` and that it skips tile 0; the map's
`_Placements` table, `_METAS`, `_PLACEMENTS` and `<name>_DrawPlacements(frames)`;
and that tile 0 is transparent when the tileset reserves it. Also check line
151's `VDP_Poke_16K(value, dest)` note is still accurate — it is, and it is the
reason the helpers do not use it.

- [ ] **Step 2: `docs/tutorials/09-meta-tiles.md`**

Rewrite for the object model, walking one meta from creation to placement: create the tileset with tile 0 reserved, create the meta, paint it, add a frame, place it on a map, bake the static one, export, and the C to draw and animate.

- [ ] **Step 3: the other four docs and the Resources panel**

`grep -rln "meta-tile" docs/ specs/` finds six files, not one. `docs/index.md`,
`docs/tutorials/README.md`, `docs/tutorials/03-tiles-and-maps.md` and
`docs/resources.md` all describe meta-tiles as a set; each needs its one or two
sentences rewritten for the object model.

`ResourcesPanel.vue` describes the kind in the UI itself:

```ts
metatiles: 'Groups of tiles a map indexes instead of tiles, so a big world costs less ROM.',
metabtiles: 'The same, over a bitmap tileset.',
```

Both are now wrong — a map does not index metas any more. Replace with something
that says what a meta is: one design bigger than a tile, with frames and flags,
that a map places.

- [ ] **Step 4: `specs/10-map-screen-editors.md`**

Replace the meta-set section with placements, and record the tileset store.

- [ ] **Step 5: `CLAUDE.md`**

Update the "Groups: the one idea in three editors" section — the meta-tile is now a fourth instance with a pixel-level editor, and the copy-on-write bridge is the thing that keeps "a group owns no pixels" true. Add one line about the tileset store under Architecture.

- [ ] **Step 6: `CHANGELOG.md`**

Confirm the `[Unreleased]` entries match what shipped. Correct anything that changed during implementation.

- [ ] **Step 7: Verify and commit**

Run: `npm run check && npm run test`

```bash
git add src/main/services/agent-guide.ts docs/ specs/ CLAUDE.md CHANGELOG.md
git commit -m "docs(meta): guide, tutorial and spec for meta-tiles as objects"
```

---

## Known correction to the spec

The spec's §3 says sc1 find-or-create "prefers a group whose pair already matches **and has a free slot**". There are no free slots mid-bank: every tile below `count` exists, so a tile can only be appended at `count`. Task 3 implements the accurate rule — reuse searches the whole bank, and creation appends at `count`, padding to the next group boundary when the current group serves a different pair. Fix the spec wording as part of Task 13, Step 3.
