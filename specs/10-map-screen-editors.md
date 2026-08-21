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

## C. Meta-tile sets (`*.meta-tiles.json`, `*.meta-btiles.json`) — added after A

Same-sized groups of tiles that a map may index **instead of** indexing tiles: a
32×24 screen of 2×2 metas is 192 bytes rather than 768, before RLEp. Purely
additive — a map that names a plain tileset is unchanged in model, editor and
export.

```jsonc
{
  "version": 1,
  "tileset": "res/main.tiles.json",  // the .tiles.json / .btiles.json being grouped
  "width": 2, "height": 2,           // every meta is exactly this, in tiles
  "cell": { "width": 16, "height": 16, "cols": 16 },  // bitmap sets only, mirrored from the tileset
  "metas": [ { "name": "ground", "width": 2, "height": 2, "tiles": [1,2,3,4] } ]
}
```

A meta is a `TileBlock` verbatim, so `blockPixels` and the marquee machinery are
reused as they are. `MapDoc` gains `meta: {width,height} | null`, mirrored from
the set for the same reason `cell` is mirrored — the exporter renders one
resource at a time and never opens another file. A meta map's `width`/`height`
count metas; `_TILE_W`/`_TILE_H` carry the size in tiles.

The hyphen in the suffixes is load-bearing: `resourceKindOf` matches by
`endsWith` over `RESOURCE_SUFFIXES`, so `.meta.tiles.json` would resolve to
`tiles` and open the wrong editor.

Two reorder seams meet and cannot cross, because a document only ever replays the
log of the file it *references*: a set replays its tileset's (renumbering the
tiles inside its metas), a meta map replays the set's (renumbering its cells), a
plain map replays its tileset's as before.

Export: the set emits one table at a fixed stride plus `_META_W`/`_META_H`/
`_COUNT` and a `#define` per named meta, and (helpers on) `_DrawMeta`. The map
emits `_ExpandRow`, `_ExpandToRAM` and — pattern modes — `_DrawView`, or the
`metas`-taking `_DrawRow`/`_DrawRowOver` in bitmap modes. It emits **no**
`_DrawLayer`: the layer holds meta indices, and writing them into the name table
would draw whichever tiles share those numbers.

## Acceptance

- Build a 3-screen-wide scrolling map from a real tileset, export, byte-level check
  of one known cell.
- Tileset reorder round-trip keeps map visually identical.
- Import a 24-bit PNG → sc5 conversion produces ≤16-color 256×212 output whose
  palette validates against the 512-color space; retouch survives reconversion.
- Undo/redo across stamp/fill/layer ops.
- A meta map builds and boots showing the same picture as the tile map it was
  converted from, and a map with no meta set exports byte-identical output to
  before section C existed.
