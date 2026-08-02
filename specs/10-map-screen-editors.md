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

## B. Bitmap screen editor (`*.screen.json` = import settings + retouch strokes)

For screens 5, 6, 7, 8 (and 10/12 YJK as import-only). Source of truth is a source
image + conversion settings, not a hand-painted document:

```jsonc
{
  "version": 1,
  "mode": "sc5",
  "source": "./title.png",          // original art
  "convert": { "dither": "none|bayer|floyd", "paletteLock": null },  // Spec 07 options
  "retouch": [ …stroke list applied post-conversion… ]
}
```

UI: side-by-side (or toggle) original vs converted preview at real MSX resolution
and aspect; palette panel (editable GRB333 for sc5/6/7, fixed for sc8, YJK preview
for sc10/12); pencil/fill retouch on the converted indexed image; re-running the
conversion re-applies retouch strokes on top. Export via Spec 07 (bin for
`VDP_CommandHMMC`-style blits or the MSXgl image format — Spec 07 decides).

## Acceptance

- Build a 3-screen-wide scrolling map from a real tileset, export, byte-level check
  of one known cell.
- Tileset reorder round-trip keeps map visually identical.
- Import a 24-bit PNG → sc5 conversion produces ≤16-color 256×212 output whose
  palette validates against the 512-color space; retouch survives reconversion.
- Undo/redo across stamp/fill/layer ops.
