# Meta-tiles as authored objects — design

**Date:** 2026-08-24
**Status:** implemented on `dev02`, merged to `main` at `80a3910`. Three
deviations from this document are recorded at the end, under *Deviations during
implementation*; stage 2 has since superseded the first.
**Scope:** stage 1 — pattern-mode tiled screens (SCREEN 1 / 2 / 4) and the map editor.
Bitmap and multicolour modes are stage 2 and are named here only where the data
model has to leave room for them.

## Why

The meta-tile resource shipped one commit ago (`574ad39`) as a **compression
scheme**: a `.meta-tiles.json` held a *set* of same-sized metas, and a map was
either all plain tiles or all meta indices. A 32×24 screen built from 2×2 metas
is 192 bytes instead of 768.

That is not what the feature is wanted for. What is wanted is a meta-tile as an
**authored object** — a tree, a door, a spinning coin — with its own size, its
own animation frames, its own gameplay flags, painted in pixels rather than
assembled from a tile picker, and *placed* on a map alongside ordinary
hand-painted tiles rather than replacing them.

The two models cannot coexist usefully, and no `.meta-*tiles.json` file exists
anywhere in this repository or its demos, so the set model is deleted rather
than kept alongside.

## Decisions

Every one of these was chosen explicitly; none is a default.

| # | Decision | Chosen |
|---|---|---|
| 1 | What a map stores when a meta is placed | **Placement list (live reference)**, with a per-placement `baked` flag for the stamp-and-record behaviour |
| 2 | Where pixels become tiles | **Copy-on-write into the shared `.tiles.json`**, append-only, find-or-create dedup on every stroke |
| 3 | Tile 0 as transparency | **Per-tileset opt-in** `reserveTile0` flag — existing tilesets untouched |
| 4 | SCREEN 1 | **Supported**, with the palette constrained to the tile's colour group |
| 5 | Concurrent access to the tileset | **A Pinia store** holding one doc shared by every editor |
| 6 | Meta gameplay flags | **Yes** — 8 bits per meta, the shape `TilesDoc.flags` uses per tile |

### On decision 3

`reserveTile0` is per-tileset because tile 0 is real, load-bearing art in this
repository's own demos:

- `demo_msx1/res/tiles.tiles.json` — tile 0 is a solid filled block (`pattern` =
  `FF × 8`, colour `0x54`)
- `demo_msx1/res/background.map.json` — draws it **274 times**
- `demo_msx1/res/intro.tiles.json` — tile 0 is a shape, not blank

Reserving tile 0 project-wide would mean shifting every tile index up by one in
those tilesets, in every map that draws them, and in any hand-written `.c` that
names a tile number — a migration with real breakage risk, for a guarantee that
only the meta editor needs.

## 1. Data model

### `*.meta-tiles.json` — one meta-tile per file

```ts
interface MetaTileDoc {
  version: 2
  /** Project-relative path of the `.tiles.json` whose tiles this meta references. */
  tileset: string
  /** This meta's own size, in tiles. Every frame is exactly this. */
  width: number
  height: number
  /** Animation frames; `frames[0]` is the resting pose, as in `SpritesDoc`. */
  frames: { tiles: number[] }[]     // width * height indices each, row-major
  /** Eight gameplay bits for the whole meta — `TilesDoc.flags`, one byte. */
  flags: number
  export: ExportBlock | null
}
```

- **Version 2.** `normalizeMetaTile` reads a version-1 set as its first meta and
  discards the rest. This costs one branch and means a file written by the
  previous commit still opens.
- **No per-frame duration.** `SpritesDoc` has none either; animation timing is
  the game's decision, and a duration table nothing reads is dead data.
- **The meta still owns no pixels.** It holds tile indices, exactly as it did,
  which is what keeps the CLAUDE.md invariant ("a named group that owns no
  pixels, only references to something that does") true after this change. The
  pixel canvas is a *view* that resolves to indices on every stroke.
- `*.meta-btiles.json` takes the identical shape now. Its editor keeps today's
  cell-stamping interaction until stage 2 brings pixel painting to bitmap modes.

### `TilesDoc` gains one field

```ts
reserveTile0: boolean
```

`false` in every file that predates this, `true` for newly created tilesets.
When `true`:

- the tile editor locks tile 0 to all-blank — `pattern` all `0x00`, `color` all
  `0x00`, rather than the `0xf1` white-on-black `normalizeTiles` gives other
  blank tiles, so it renders through `TileCanvas.vue:127`'s existing "palette
  index 0 is the MSX's transparent entry" checker with no new drawing code;
- a meta cell holding 0 is skipped when the meta is drawn;
- painting a meta cell blank resolves to tile 0, so the eraser is just "paint
  palette index 0".

  This last one needed one explicit branch, contrary to what this document
  first claimed. `paintPixel` has no reason to express an erased row the way
  `blankTileEntry` does: it leaves whatever FG/BG pair the row was carrying, so
  a fully-erased cell comes out as pattern `0x00` with colour `0x01` rather
  than colour `0x00`. Identical on screen, different to the dedup — so without
  canonicalising an all-index-0 cell, the eraser mints a fresh near-duplicate
  tile on every stroke. `meta-paint.ts`'s `canonical()` is that branch.

Pointing a meta at a tileset without the flag prompts once:

> `res/tiles.tiles.json` uses tile 0 as artwork. Meta-tiles need it for
> transparency. Reserve it? This shifts 274 cells in 2 maps.
> **[ Reserve and migrate ] [ Cancel ]**

Migration shifts every index up by one and publishes it on the existing
`TilesReorderEvent` seam, so open maps and metas renumber the way they
already do after a tile reorder. Declining leaves the meta drawable, not
read-only — see deviation 3. A cell holding tile 0 is skipped either
way: `MetaCanvas.vue` draws the checkerboard through it and the emitted
`_Draw` does not write it. What the flag buys is that tile 0 is *blank*,
so the cell a meta skips is also blank for everything else drawing from
that tileset — a map's own grid included.

### What is deleted

The set model goes entirely: `MapDoc.meta`, and in `map.ts` the three helpers
built on it — `metaMapHelperC`, `patternMetaHelperC` and `map.ts`'s own
`bitmapMetaHelperC` — plus the `metaTileset` validation branch and the
"switching to meta-tiles clears the map" confirm in `MapSidePanel.vue`.
`MapDoc.tileset` goes back to always naming a tileset.

`meta-tile.ts` keeps its *own* `bitmapMetaHelperC` (a different function that
happens to share the name): it draws one meta out of a bitmap atlas, which is
still what `.meta-btiles.json` needs. It is adapted from "meta `n` of a set" to
"this file's meta, frame `f`".

The set-shaped API in `meta-tile.ts` goes with the model — `metaStride`,
`metaBytes`, `addMeta`, `removeMeta`, `reorderMetas`, `resizeMetas`,
`MAX_METAS`, and `metaConstants`' `_COUNT` define. Their one-meta replacements
are named in §5.

## 2. Maps record placements

```ts
/**
 * Mirrored from the meta file, for the same reason `MapCell` is mirrored: the
 * exporter renders one resource at a time and never opens another file, so
 * everything the emitted C needs has to be in the document in front of it.
 */
interface MetaRef {
  path: string
  /** Export symbol of that meta's table — what the emitted C `extern`s. */
  name: string
  width: number
  height: number
  frames: number
  flags: number
}

interface MetaPlacement {
  /** Index into `MapDoc.metas`. */
  slot: number
  /** Top-left corner, in tiles, on the map's own grid. */
  x: number
  y: number
  /** Frame 0's tiles are also written into this layer's grid. */
  baked?: boolean
}

MapDoc.metas: MetaRef[]
MapLayer.placements: MetaPlacement[]
```

The tile grid is untouched — it is still `width * height` tile indices, still
exported as one table, still drawn by one `VDP_WriteLayout_GM2`. Placements sit
beside it.

- **Z-order is list order.** Later placements draw over earlier ones. Overlap is
  allowed; the editor does not police it.
- **Non-baked**: the grid under the placement holds tile 0, so the meta draws
  over a hole. The emitted C draws it at runtime, and it can animate.
- **Baked**: frame 0's tiles are written into the grid *and* the record is kept.
  A static baked meta costs nothing at runtime — the layer write already drew
  it. `Bake` / `Unbake` are context-menu commands on a selected placement.
  Re-editing a baked meta marks its placements stale and offers a re-stamp.
- Select, drag, and delete operate on a placement as a unit. Hand-painting a
  tile inside a **baked** placement drops its record (the receipt is no longer
  true); inside a non-baked one it paints the grid underneath, which is visible
  only where the meta is transparent.
- Removing an entry from `MapDoc.metas` renumbers the `slot` of every placement
  in the file. This is a **local** renumber, not a cross-file one — `metas` is
  the map's own list — so it needs no `TilesReorderEvent` and no other document
  hears about it.
- `MetaRef.flags` is mirrored so the map's export can emit a flags-by-slot table:
  a game walking `level_placements[]` can test "is this one solid?" without
  including every meta's header.

## 3. Painting: copy-on-write into the bank

A new pure module, `src/shared/msx/meta-paint.ts`, with one entry point:

```ts
paintMeta(
  meta: MetaTileDoc,
  tiles: TilesDoc,
  frame: number,
  points: readonly Point[],
  color: number
): {
  meta: MetaTileDoc
  tiles: TilesDoc
  /** Tile indices appended by this stroke — what Compact would reclaim. */
  added: number[]
  /** Pixels the hardware colour limit refused. */
  dropped: number
  /** Set when the whole stroke was rejected; nothing changed. */
  refused?: string
}
```

Per cell touched by the stroke:

1. Decode the cell's current tile with `tilePixels` → 64 palette indices.
2. Apply the stroke's points that land in that cell, **testing each one first**:
   count the distinct colours the point's own 8×1 row would hold once it is
   applied (in sc1, the distinct colours across all 8 tiles of the group). More
   than two means the hardware cannot show it — skip that point and increment
   `dropped`. Testing the resulting colour *set* rather than the stored
   `FG<<4|BG` byte is what makes a row that currently uses only one of its pair
   accept a second colour, which is the common case when drawing onto blank
   tiles.
3. `tileFromPixels` → `{ pattern, color }`. Because step 2 already guaranteed
   at most two colours per row, its `lossyRows` is always empty here; the
   reduction path only runs for imports.
4. **Find-or-create** in the bank, keyed on `pattern|color` — the same key
   `packTiles` already uses for its dedup option.
5. Repoint `frames[frame].tiles[cell]` at the result.

`tilePixels`, `tileFromPixels` and the dedup key already exist. The parse step
is a reuse, not new machinery; what is new is find-or-create and the sc1 group
allocator.

### Rules

- **Append-only.** A tile is never edited in place and never removed by
  painting, so no existing index ever shifts and no map can be invalidated by
  drawing a meta. This is what makes copy-on-write safe without a refcount
  nobody can compute across closed files.
- **Dedup is continuous and free** — it is the "find" half of step 4.
- **Undo leaves orphans.** Undo repoints the cell; the appended tile stays in
  the bank. A manual **Compact unused tiles** command reclaims tiles referenced
  by nothing currently open and publishes a `TilesReorderEvent`. It is never
  automatic: reachability across maps, blocks and metas that are not open is
  unknowable.
- **Colour limits drop pixels, they do not refuse strokes.** A pixel that would
  need a third colour in its sc2/sc4 row, or in its sc1 group, is dropped and
  counted, and the count is reported in the status bar —
  `12 pixels dropped: row colour limit` — matching the image importer's
  `lossyRows` convention. One rule for every tool, and no modal interrupting a
  drag.
- **A 257th tile refuses the whole stroke**, with a status message. A partial
  stroke would leave the meta half-drawn against a full bank; there is no
  honest alternative.

### SCREEN 1

sc1 shares one FG/BG pair across each group of 8 tiles, so free painting is
mostly illegal. Two mechanisms make it workable:

- While painting, the palette offers only the two colours in force for the
  current cell's group, plus an explicit **Change group pair**, which recolours
  all 8 tiles in that group and says so.
- Find-or-create prefers a group whose pair already matches and has a free slot;
  if none does, it opens the next group and sets its pair. This wastes slots in
  a bank that is only 256 tiles, which is the accepted cost of sc1 support.

### Spray

A new `TileTool` value, `'spray'`. Points are the pixels of a brush disc where
`bayer4[y % 4][x % 4] < density`, reusing the matrix already in `quantize.ts`.
Deterministic rather than random, so it is testable and so the same drag twice
gives the same art. Density is a slider; without one, dither is a single fixed
pattern.

## 4. The shared tileset store

The meta editor writes into the tileset, so two in-memory copies of the same
`.tiles.json` cannot be allowed to exist.

`src/renderer/src/stores/tilesetStore.ts` — a Pinia store keyed by
project-relative path, holding one `TilesDoc`, one dirty flag, and the save
action. The tile-editor session and every meta session read and write through
it; edits made in one tab are visible in the other immediately.

Undo stays per editor. Each editor's history holds the tileset snapshots *it*
made; when the store's doc changes from outside that editor, the editor rebases
— it pushes the external doc as its new present and clears its redo. This is the
same "adopt the external change" behaviour the `onTilesReordered` bus already
implements, and because painting only ever appends, the two editors can never
disagree about the content of an existing tile.

This is the largest single piece of refactor in the feature: the tile-editor
session's ownership of its doc and its save path both move into the store.

## 5. Export

Emitted C calls MSXgl's own API, and helper C stays gated on
`ExportBlock.helpers` so a data-only header never references the engine.

### The meta

```c
#define TREE_META_W  2
#define TREE_META_H  3
#define TREE_FRAMES  4
#define TREE_FLAGS   0x01
extern const u8 tree[];                  // FRAMES * META_W * META_H tile indices

// opt-in helper — skips cells holding tile 0, so the background shows through
void tree_Draw(u8 x, u8 y, u8 frame);
```

`_Draw` is a per-cell loop rather than one `VDP_WriteLayout_GM2`, because a name
table has no holes: transparency can only mean "skip the write". Metas are
small, so this is a handful of writes.

### The map

```c
#define LEVEL_PLACEMENTS 12
extern const u8 level_placements[];      // slot | baked << 7, x, y — 3 bytes each

// opt-in helper — skips baked entries, which the layer write already drew
void level_DrawPlacements(const u8* frames);   // frames[slot] = that meta's current frame
```

The helper source `extern`s each referenced meta's symbol and builds a local
pointer table from `MapDoc.metas`. `baked` rides in bit 7 of the slot byte so a
placement stays three bytes.

Per CLAUDE.md, the emitted C is verified by building a scratch project against
the real MSXgl checkout and booting the ROM under openMSX — not by reading it.

## 6. Testing

| File | Covers |
|---|---|
| `src/shared/msx/meta-paint.test.ts` *(new)* | find-or-create dedup, append, 256-tile refusal, tile-0 erase resolving to 0, sc1 group allocation and pair changes, dropped-pixel counts, spray determinism |
| `src/shared/msx/meta-tile.test.ts` | v1→v2 normalize, frames, flags, constants, `_Draw` emission |
| `src/shared/msx/map.test.ts` | placement normalize, baked bit packing, `metas` slot remap, placement table export |
| `src/shared/msx/tile.test.ts` | `reserveTile0` normalize and the tile-0 lock |
| a build test | one scratch project per emitted helper, compiled and booted under openMSX |

Renderer correctness rides on the shared modules, as it does everywhere else.

## 7. Deliverables beyond the code

Per CLAUDE.md, `agent-guide.ts` is a deliverable: this feature changes what the
exporter emits, what a generated file is called, and how a resource is used from
C, so it is not finished until the guide says so.

- `src/main/services/agent-guide.ts` — the meta-tile section, the new headers,
  the placement table
- `docs/tutorials/09-meta-tiles.md` — rewritten for the object model
- `specs/10-map-screen-editors.md` — placements, the tileset store
- `CHANGELOG.md` — an entry under `[Unreleased]`

## Assumptions

Stated so a review catches them if any is wrong.

1. **Stage 1 is the map editor only.** `.screen.json` is a bitmap-mode picture
   (SCREEN 3/5/6/7/8) and there is no screen editor for SCREEN 1/2/4, so "when
   I'm working on a screen or a map" has no separate stage-1 target.
2. The map sidebar's lower half lists every `.meta-tiles.json` in the project
   that references the **same tileset** as the map. Metas over other tilesets are
   not offered, because their indices would mean nothing here.
3. Meta thumbnails render frame 0.
4. A meta's flags are independent of the tile flags underneath it. A game
   reading the grid uses tile flags; a game walking the placement table uses meta
   flags. Neither overrides the other.
5. Meta size is capped at `MAX_META_SIZE` (16) per axis, as today.
6. Placements are stored per layer, so a meta belongs to a layer and hides or
   shows with it.

## Deviations during implementation

All three are defensible and none was a silent choice, but this document said
otherwise and the record should agree with the code.

1. **`.meta-btiles.json` lost its cell-stamping editor.** §1 said it would keep
   today's interaction until stage 2. The rewrite replaced the editor wholesale,
   so a bitmap meta was briefly view-only.

   **Superseded.** Stage 2 shipped: a bitmap meta is authored with the same
   pixel tools, reserves tile 0 through `reserveBitmapTile0`, and is placed on a
   map like any other, drawn by `bitmapPlacementHelperC` over the VDP command
   engine. See the *Meta-tiles in bitmap and multicolour modes (stage 2)*
   entry in `CHANGELOG.md`.

2. **Erase is a colour, not a tool.** §4 listed it among the tools. It ships as a
   toolbar button that selects the transparent index, which composes with every
   tool rather than being a sixth one — erase with the pencil, with a line, with
   a spray of holes.

3. **Painting is not gated on `reserveTile0`.** §1 said declining the migration
   leaves the meta read-only. It does not: the flag buys *transparency*, not the
   right to draw. Refusing strokes made every pre-existing tileset — which is all
   of them, the flag being off by default — look like a broken editor. Covered by
   `session.test.ts`'s *draws even when the tileset has not reserved tile 0*.

## Out of scope for stage 1

- Pixel painting for bitmap and multicolour modes (`.meta-btiles.json`,
  `.screen.json`) — stage 2, and the reason `MetaTileDoc` is shared between both
  suffixes now.
- Automatic garbage collection of orphaned tiles.
- Per-frame durations, or any animation runtime beyond `frames[slot]`.
- Rotating or mirroring a placement.
