# Spec 10 — Map & Screen Editors

**Phase:** 4 · **Depends on:** 01, 05, 07, 08 · **Suggested model:** Sonnet 5

## Goal

Two editors: a **tilemap editor** (pattern modes — place tiles from a Spec 08
tileset into maps/screens) and a **bitmap screen editor** (MSX2 bitmap modes —
import/convert full-screen images with light retouching).

## A. Tilemap editor (`*.map.json`)

```jsonc
{
  "version": 1,
  "tileset": "./main.tiles.json",   // project-relative
  "width": 32, "height": 24,        // any size; 32×24 = one screen, larger = scrollable world
  "layers": [
    { "name": "background", "data": [width*height tile indices] },
    { "name": "collision", "kind": "flags", "data": [bitflags] }   // optional flag layer
  ],
  "tileMeta": { "12": { "flags": ["solid"] } }   // per-tile-index flags palette
}
```

UI:
- **Tile picker** (left): the referenced tileset rendered with its real palette;
  click/marquee to pick a stamp (multi-tile stamps supported).
- **Map canvas** (center): zoom/pan, grid toggle, stamp/fill/rect/erase tools,
  rectangular select + copy/paste, undo/redo. A screen-size (32×24) outline overlay
  helps design multi-screen worlds. Layer visibility toggles.
- **Flags mode:** paint collision/meta flags per cell from `tileMeta`-defined flags.
- Tileset changes (Spec 08 reorder) push a `tilesetReordered` mapping the map editor
  applies to open + on-disk maps that reference the file (single confirm dialog).

Export via Spec 07: raw tile-index binary per layer (+ optional RLE variant if the
MSXgl side supports one — decided in Spec 07), flags as a separate C table.

### Banked tilesets (SCREEN 2/4)

SCREEN 2 and SCREEN 4 hold three 256-tile pattern banks rather than one, one
per third of the screen — bank 0 for name-table rows 0–7, bank 1 for 8–15,
bank 2 for 16–23, `bankForRow(row) = row >> 3`. A `TilesDoc` may override the
common set per bank (`bankTiles[b][i]`, falling back to `tiles[i]` where a
bank has nothing of its own — `bankTileAt`), so up to 768 distinct tiles can
be on screen at once instead of 256, at the cost of a name-table byte no
longer meaning the same art everywhere: cell value 12 can be a rock in bank
0's rows and a cloud in bank 2's.

**A map drawn against a banked tileset must be exactly `SCREEN_ROWS` (24)
rows.** Row 24 has no bank to read from, so `validateMap(doc, { banked: true
})` refuses a taller one rather than exporting a bottom strip with nothing
honest to show. Width is unconstrained — banks are chosen by row, not column,
so horizontal scrolling still works.

The tile editor (Spec 08) exposes this as a **bank selector** — a tab per
bank (`session.bank`, `setBank`) that switches the grid and canvas to that
bank's own view (`bankTileAt`) — and a **budget readout** per bank
(`bankBudgetLabel`, driven by `bankCapacityLeft`) spelling out the arithmetic
before a stroke hits the wall: a bank's own overrides plus the shared
meta-tile reservation both cost every bank the same 256-tile ceiling. Most
tilesets are never banked; the selector and readout only appear once a bank
has at least one override.

**A banked tileset's common range never renumbers.** Deleting or reordering a
common tile, and the meta editor's reserve-tile-0 migration, are refused on a
banked tileset; the meta editor's Compact there reclaims only shared orphans.
The reason: a map cell resolves through `bankTiles[bank][v] ?? tiles[v]`, so a
cell backed by a bank override does not follow a common-range renumber, and
the replay path (`TilesReorderEvent`) cannot tell which cells those were at
the time the reorder was logged.

Export (Spec 07/09): the common tables as always, plus `_Bank<n>_Patterns` /
`_Bank<n>_Colors` for each bank that actually overrides something (a bank with
no art of its own emits no table), `_Shared_Patterns`/`_Shared_Colors` for the
meta-tile region when one exists, `#define`s counting each (`_BANK<n>_TILES`,
`_SHARED_TILES`), and a generated `_Load()` that puts all of it in the right
place — the one thing that must be called instead of `VDP_LoadPattern_GM2`/
`VDP_LoadColor_GM2`, which mirror into all three banks and are only correct
for an unbanked tileset.

Importing a full 256×192 screen (`packBankedTiles`) fills all three banks at
once, deduping within each bank the way the unbanked importer dedupes within
one, and reports which bank (if any) ran out of room rather than silently
dropping cells.

Existing tilesets are untouched: `bankTiles` is empty and `sharedTiles` is 0
in every file written before banking existed, `isBanked` is false, and export
keeps emitting exactly the tables it always did.

## B. Screen editor (`*.screen.json` = import settings + retouch strokes, or a drawing)

For screens 5, 6, 7, 8 (and 10/12 YJK as import-only), **and SCREEN 3**, whose
64×48 grid of 4×4 blocks is the same index-per-pixel document at a different
scale. Source of truth is a source image + conversion settings — *unless there is
no source*, in which case the document is a drawing and strokes commit straight
into `converted.indices` rather than growing a `retouch` triple list. Tools are
`bitmap-tile-editor.ts`'s `bitmapToolPoints` (pencil / line / rect / fill), plus
eyedropper and the fragment cut.

```jsonc
{
  "version": 1,
  "mode": "sc5",
  "source": "./title.png",          // original art
  "convert": { "dither": "none|bayer|floyd", "paletteLock": null },  // Spec 07 options
  "retouch": [ …stroke list applied post-conversion… ]
}
```

### Any size: a screen is a map with different W×H

`ScreenDoc` carries its own `width`/`height`, defaulting to the mode's screen
size and allowed to exceed it. Past one screenful the document is a **world**:

- packed **linearly** (rows in order) rather than in the VDP's byte order, since
  it is read a window at a time rather than uploaded whole;
- exported with `_VIEW_W`/`_VIEW_H` (the display) beside `_W`/`_H` (the picture)
  and `_STRIDE`;
- given `_DrawWindow()` — into the shadow buffer in SCREEN 3, one `HMMC` per
  line out of ROM in the bitmap modes, where `_DrawRow()` is what a scroller
  actually calls.

Files written before the field default their size from the conversion they
cached, so nothing existing is cropped or padded. A one-screenful picture
exports byte-identically to before.

This is what "edit the pixels directly over a W×H area" means: the map editor
still owns *tile* worlds, which stay far cheaper in ROM when the art repeats.

### SCREEN 3

Two runtime shapes, and the arithmetic picks between them: a 50 Hz frame is
~71,600 T-states at ~30 cc per VRAM byte, so the 1536-byte framebuffer is ~64 %
of a frame and the 768-byte name table ~32 %.

- **Framebuffer** (`*.screen.json` at sc3) — the name table is boilerplate, the
  pattern table is the picture. Drawn into a RAM shadow; only the 8-byte column
  strips that changed are uploaded. `ExportBlock.doubleBuffer` adds the page
  flip: two pattern tables, one `VDP_SetPatternTable()`, no copy.
- **Name table** (`*.btiles.json` at sc3, 2×2 blocks, plus a map) — one tile is
  one name entry, so the map draws with `VDP_WriteLayout_GM2` exactly as SCREEN
  1/2 and MSXgl's `scroll` module drives it. `MapCell.sc3` is the mirrored flag
  that routes the export; `cell` stays set so the editors are unchanged.

A sc3 `*.btiles.json` is also the **software-sprite sheet**: tiles are frames, a
1×N block is an animation (the idiom `agent-guide.ts` already documents), and
`transparent` gives the masked blit.

UI: side-by-side (or toggle) original vs converted preview at real MSX resolution
and aspect; palette panel (editable GRB333 for sc5/6/7, fixed for sc8, YJK preview
for sc10/12); pencil/fill retouch on the converted indexed image; re-running the
conversion re-applies retouch strokes on top. Export via Spec 07 (bin for
`VDP_CommandHMMC`-style blits or the MSXgl image format — Spec 07 decides).

## C. Meta-tiles (`*.meta-tiles.json`, `*.meta-btiles.json`) — rewritten after A

**One meta-tile per file**: a design several cells across — a tree, a door, a
coin — with its own size in tiles, its own animation frames and its own eight
gameplay flag bits. Not a compression scheme; an *object* a level places.

This replaces the meta-tile *set* model (one commit, no project ever held a
file in that format), where a map indexed metas **instead of** tiles.

```jsonc
{
  "version": 2,
  "tileset": "res/main.tiles.json",  // the .tiles.json / .btiles.json it references
  "width": 2, "height": 3,           // this meta's own size, in tiles
  "cell": { "width": 16, "height": 16, "cols": 16 },  // bitmap only, mirrored from the tileset
  "frames": [ { "tiles": [1,2,3,4,5,6] } ],           // frames[0] is the resting pose
  "flags": 1                                          // eight bits, as TilesDoc.flags per tile
}
```

A meta owns no pixels — it holds tile indices, as `TileBlock` does. The editor
presents a canvas and resolves every stroke through `meta-paint.ts`:
**copy-on-write** into the referenced tileset. A stroke derives what the touched
cell would now look like, finds-or-creates that tile in the bank, and repoints
the cell. The bank is append-only, so no existing index ever shifts and painting
a meta cannot change a map. Orphans left by undo are reclaimed by an explicit
Compact, which only removes tiles the session itself created — reachability
across closed files is not knowable.

`TilesDoc` gains `reserveTile0`. When set, tile 0 is locked all-blank (pattern
and colour both zero, so it renders through the canvas's existing index-0
checkerboard) and a meta cell holding 0 is *skipped* when drawn. That skipped
write is the only transparency a name table has. Off in every pre-existing file:
tile 0 is real art in `demo_msx1`, drawn 274 times.

The hyphen in the suffixes is load-bearing: `resourceKindOf` matches by
`endsWith` over `RESOURCE_SUFFIXES`, so `.meta.tiles.json` would resolve to
`tiles` and open the wrong editor.

**Maps place metas rather than indexing them.** `MapDoc` gains `metas: MetaRef[]`
— path, export symbol, size, frame count, flags, mirrored for the reason `cell`
is mirrored — and `MapLayer` gains `placements: {slot, x, y, baked?}[]`. The grid
stays a grid of tile indices and exports exactly what it always did. A *live*
placement leaves tile 0 under it and is drawn at runtime; a *baked* one has
frame 0 written into the grid and is skipped, at the cost of not animating.
`baked` rides in bit 7 of the slot byte, which is why `MAX_MAP_METAS` is 128.

One reorder seam remains, running one way: a meta replays its tileset's log. It
publishes none — there are no metas-within-a-set to renumber, and a map's own
`metas` list is local to it.

**The tileset store.** Painting a meta writes into another document, so the same
`.tiles.json` cannot be a separate copy per editor. `renderer/stores/tilesetStore.ts`
holds one per path, shared by the tile editor and every meta editor; undo stays
per editor and rebases when the store changes underneath it, which is safe only
because painting appends and never edits in place.

Export: a meta emits one table of its frames end to end, plus `_META_W`/`_META_H`/
`_CELLS`/`_FRAMES`/`_FLAGS`, and (helpers on) `_Draw(x, y, frame)` — written as
runs of non-transparent cells, since a transparent cell is a skipped write. A map
emits its layers as before, plus `_Placements` (three bytes each) with `_METAS`,
`_PLACEMENTS`, a `#define` per meta and its mirrored flags, and (helpers on)
`_DrawPlacements(frames)`, which `extern`s each meta's symbol and skips the baked
entries.

**Stage 2** brings pixel painting and placement to the bitmap and multicolour
modes. Until then `.meta-btiles.json` shares the document shape and exports a
`_Draw` that blits out of the atlas, but has no pixel editor and no map
placement.

## Acceptance

- Build a 3-screen-wide scrolling map from a real tileset, export, byte-level check
  of one known cell.
- Tileset reorder round-trip keeps map visually identical.
- Import a 24-bit PNG → sc5 conversion produces ≤16-color 256×212 output whose
  palette validates against the 512-color space; retouch survives reconversion.
- Undo/redo across stamp/fill/layer ops.
- A painted meta-tile placed on a map builds and boots, drawing over the grid
  where it is opaque and showing the grid through where it holds tile 0.
- A map that places nothing exports byte-identical output to before section C
  existed.
- Painting the same 8×8 in two cells grows the tileset by one tile, not two, and
  never alters a tile another resource already references.
