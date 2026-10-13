# Meta-tiles as attached entities, and maps indexed by them — design

**Date:** 2026-10-13
**Status:** proposed, awaiting approval. Nothing here is implemented.
**Builds on:** `2026-10-13-tile-animations-design.md` (attached animations).

## Why

Pablo, 2026-10-13: *"When we create a screen using meta tiles, it is an indexed
screen/map. No point on using meta tiles if we store the screen/map tile by
tile anyway. When using animated meta tiles, these screens/maps have to also
work."* And, deciding the open questions:

1. **Meta-tiles are not forced to one size per layer.** *"Each meta tile is an
   independent entity that can be attached to a tile set, and used in
   different places. Same concept as we used for the animated frames."*
2. **Animated meta-tiles follow the same idea as animated tiles** — pattern
   swap, every copy in step, no per-copy cost.
3. **Tile modes (SCREEN 1/2/4) first, then SCREEN 3** name-table maps.

Today a map cannot be indexed by meta-tiles at all. The set model that did it
was removed for *placements* — `{meta, x, y}` records drawn over an ordinary
tile-by-tile grid — so a screen built from meta-tiles stores the full 768-byte
grid **and** 3 bytes a meta. `docs/resources.md` still describes the removed
model (`_DrawView`, `_ExpandToRAM`, "layers as meta indices"); it is wrong
today and is rewritten with this work.

## The idea in one paragraph

A meta-tile becomes what an animated tile already is — a resource that **owns
its pixels** and is **attached** to tilesets — plus a footprint (which cells
are see-through) and eight gameplay flags. Attaching resolves its art into
tile numbers in that tileset: a still meta's cells are found-or-created there
(shared with any identical art), an animated meta gets a **window** that the
tileset's `_Animate()` drives, exactly like an attached animation. A map layer
can then be **indexed**: one byte per meta-tile, any mix of sizes, decoded at
runtime into the tile map the game already keeps in RAM. Animation needs no
help from the map at all — an expanded animated meta is window tile numbers,
and the pattern swap moves every copy.

## 1. The meta-tile owns its pixels (`*.meta-tiles.json` version 3)

```ts
interface MetaTileDoc {            // version 3
  version: 3
  mode: TileMode                   // poses stored as tile bytes, as TileAnimDoc
  width: number; height: number    // in tiles — any size, per meta
  /** Cells that are see-through in every frame: never written when drawn. */
  holes: boolean[]                 // width*height
  frames: { tiles: TileEntry[]; duration: number }[]   // as TileAnimDoc
  loop: AnimLoop
  flags: number                    // eight gameplay bits, what the object *means*
  pair: number                     // sc1 only, as TileAnimDoc
  export: ExportBlock | null
}
```

It no longer names a tileset. That is the change that makes it an independent
entity: the same tree can be attached to the level tileset and the title
tileset, and detaching it from one leaves the file, and the other, untouched.

- **The editor paints the meta's own pixels** — the animation editor's canvas
  and pose strip, plus the holes mask and the flag squares. The copy-on-write
  machinery that resolved strokes into a tileset (`paintMeta`) moves to attach
  time.
- **A meta with one frame is still; with more, animated.** There is no separate
  "animated meta" kind, and an attached animation (`*.anim-tiles.json`) is
  exactly a meta with no holes and no flags. Merging the two kinds is the
  obvious next step and is listed under *Decisions* — this design does not
  require it, because both attach through the same machinery (§2).
- **Migration (version 2 → 3):** a version-2 meta names its tileset and holds
  tile indices. Opening one reads that tileset, copies each referenced tile's
  art into the meta, and attaches it to that tileset *at the same indices* —
  so nothing in the tileset renumbers and every map keeps drawing what it drew.
  A version-2 meta with several frames stored *different tiles per frame*
  (name-table animation); migrating it gives it a window and copies the frames'
  art in as poses, after a confirm that says so.

## 2. Attaching a meta to a tileset

`TilesDoc` gains `metas: MetaBinding[]` beside `animations`:

```ts
interface MetaBinding {
  path: string
  /** The tile each cell shows in this tileset; -1 for a hole. */
  cells: number[]
  /** Set for an animated meta: `cells` is then its window, consecutive. */
  window: { slot: number; bank: number | null } | null
  // Mirrored for the exporter, refreshed through one `metaBindingFrom`:
  name: string; width: number; height: number; frames: number
  flags: number; colorsVary: boolean; loop: AnimLoop
}
```

- **Still meta:** each cell's art is found-or-created in the tileset, sharing a
  tile with any identical art already there (the windows excluded — §5 of the
  animation design). Re-attaching after editing the meta re-resolves; the old
  tiles become unused and *Remove unused tiles* reclaims them.
- **Animated meta:** a window of `width × height` consecutive slots holding
  frame 0, played by the same `_Animate()` as attached animations. The runtime
  tables simply list both kinds.
- **The binding is derived data**, refreshed from the meta's file by the tile
  editor on load and by the exporter before every export (the rule
  `exportDependencies` already enforces for mirrors).
- **Detach** removes the binding. A still meta's tiles stay as ordinary art; an
  animated one's window keeps frame 0.

The tileset's export gains the meta table every map's expander reads:

```c
#define G_TILES_METAS            3
#define G_TILES_META_TREE        1          // index a map layer stores
extern const u8 g_Tiles_MetaInfo[];         // per meta: w, h, flags, offset (u16)
extern const u8 g_Tiles_MetaCells[];        // all metas' cell tiles, end to end; 0xFF = hole
```

Data, emitted with or without *Export ready-made C* — a game can expand a layer
by hand from it.

## 3. Indexed map layers

A map layer gets `indexed: true`. Its content is meta-tiles at cell positions —
the placement records it already has — with one rule added: **on an indexed
layer, meta-tiles do not overlap.** Anything that must overlap goes on another
layer, or stays a free placement on an ordinary one.

**Encoding, one byte per meta-tile, any mix of sizes.** Walk the layer's cells
in reading order; at each cell no earlier meta covers, write the index of the
meta whose top-left is there, or `0` (*empty*, a 1×1 nothing) when none is.

```
decode: for each cell in reading order:
          if covered: skip
          m = next byte
          mark m's w×h cells from here as covered, write its tiles
```

It is unambiguous because a meta's top-left is the earliest of its cells in
reading order, so the decoder always meets it before any other cell it covers.
A 32×24 screen of 2×2 metas is 192 bytes; a wall of 4×1 bricks with 1×1 trim is
what it is. Runs of empty (`0`) are what RLEp packs best, and the layer is
RLEp-compressible like any other.

**Runtime.** The stream is decoded once into the tile map the game keeps in
RAM — the shape `demo_msx1` already has (`g_Map`, unpacked at startup and
written as coins are taken). Drawing, scrolling and tile-flag collision then
work on that buffer exactly as they do today.

```c
u8 g_Map[G_LEVEL_W * G_LEVEL_H];
g_Level_Expand(g_Level_Terrain, g_Map, NULL);      // tiles; NULL: no meta map
g_Level_DrawLayer(g_Map, 0, 0);                    // as before, from RAM

u8 g_Objects[G_LEVEL_W * G_LEVEL_H];               // optional: which meta covers a cell
g_Level_Expand(g_Level_Terrain, g_Map, g_Objects);
if(g_Tiles_MetaInfo[g_Objects[at] * 5 + 2] & FLAG_SOLID) ...   // collide by object
```

The cost is RAM: `W × H` bytes for the tiles (and the same again for the
optional meta map). The editor shows it. A world too big to keep in RAM is a
known limit of this first version; the way past it — a per-row index so a view
can be decoded without expanding the whole layer — is listed under *Later*.

**Holes** are the see-through cells: on an indexed layer over another layer, a
hole leaves the lower layer's tile in the buffer, which is what the per-cell
compose rule in `demo_msx1` does by hand today.

## 4. Animated meta-tiles, on any map

No new mechanism. An animated meta's cells are its window's tile numbers, so:

- **indexed layers** expand window numbers into the RAM map and the name
  table — every copy animates, on screen or scrolled in later;
- **placements**, live or baked, draw the same numbers;
- `_Animate()`, `_AnimSetActive()`, `_AnimRestart()` and `_AnimGetFrame()` work
  on attached metas exactly as on attached animations, indexed in the same
  `G_TILES_ANIM_*` list.

**Independent copies** — two torches out of phase — are two attachments of the
same meta (*Attach again* gives a second window and a second name). That
replaces the per-copy frames `_DrawPlacements(frames)` offered, which cost a
name-table write per copy per step and stopped at the edge of the screen.

## 5. SCREEN 3 (phase 3)

The same design over a SCREEN 3 bitmap tileset in name-table form (`.btiles.json`
at `sc3`, 2×2 blocks): metas own 4×4-dot blocks, attach to the btiles set,
windows swap 8 pattern bytes per tile (no colour table), and indexed layers
expand into the name table exactly as above. SCREEN 5–8 bitmap maps are not in
scope — they have no pattern table to swap (see the animation design).

## Interactions

- **Tile reorders/deletes** renumber `MetaBinding.cells` and windows through the
  same seam as everything else.
- **Meta order in a tileset** is what an indexed layer stores. Detaching or
  reordering a meta renumbers layers in every map on that tileset, through a
  meta reorder log beside the tile one (the seam the maps already replay).
- **Compaction** keeps every attached meta's cells and windows.
- **Banked tilesets:** a still meta resolves into the shared region (one index,
  one picture, every bank — what placements rely on today); an animated meta's
  window must be common-set, as for animations in metas.
- **The export skip** already re-exports a tileset when an attached file
  changed; a map's dependencies grow to include its tileset (its expander reads
  the tileset's meta table).

## Testing

As the animation work: pure modules first (encoding round-trips for mixed sizes
and holes, migration of version-2 files at unchanged indices, binding remap),
the export path rendered from files alone, session tests for attach/detach and
the indexed-layer brush, real MSXgl builds of `_Expand` in every mode, and an
openMSX boot of an indexed, scrolling screen of mixed-size animated metas —
VRAM sampled to show the copies animating and the scrolled-in ones too.

## Phases

1. **Meta v3 + attachment** — the format, migration, the editor, `MetaBinding`,
   the tileset's meta table; placements keep working on top.
2. **Indexed layers** — the encoding, the map editor's indexed-layer brush and
   its no-overlap rule, `_Expand`, the RAM readout, docs rewritten.
3. **SCREEN 3.**

## Decisions for Pablo

1. **Merge `*.anim-tiles.json` into meta-tiles?** An animation becomes a meta
   with no holes and no flags; the files keep loading. Recommended — one entity,
   one editor, one attach panel — but it can wait until phase 1 lands.
2. **Per-copy frames on placements** (`_DrawPlacements(frames)`) are replaced by
   attaching a meta twice. Retire them, or keep them for existing projects?
   Recommended: keep exporting them for version-2 placements until migrated,
   then retire.
3. **RAM expansion** as the first runtime (§3): fine for screens and
   screen-pair levels like the demo's, limiting for long scrolling worlds.
   Acceptable for phase 2?

## Later

- A per-row index for indexed layers, so a view decodes without expanding the
  whole layer into RAM.
- SCREEN 5–8: animated cells by re-blitting visible copies — a different
  mechanism, its own design.
