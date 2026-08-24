# Changelog

All notable changes to MSXDEVStudio are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Meta-tiles as authored objects

Design approved 2026-08-24 —
[`docs/superpowers/specs/2026-08-24-meta-tiles-design.md`](docs/superpowers/specs/2026-08-24-meta-tiles-design.md).
Stage 1 covers the pattern-mode tiled screens (SCREEN 1 / 2 / 4) and the map
editor; bitmap and multicolour modes follow in stage 2.

#### Added

- **One meta-tile per file.** `*.meta-tiles.json` is now a single meta-tile with
  its own size in tiles, its own animation frames, and its own eight gameplay
  flag bits — rather than a set of identically-sized metas.
- **Direct pixel editing** in the meta-tile editor: pencil, line, rectangle,
  fill, spray (a deterministic Bayer dither with a density slider), erase and
  colour picker, over the fixed MSX1 palette or the tileset's SCREEN 4 palette.
- **Animation with onion skin** — a frame filmstrip, playback, and a
  previous-frame ghost, in the manner of the sprite editor.
- **Meta-tile placements on maps.** A map records hand-painted tiles *and*
  placed meta-tiles. Placements are live references by default, so editing a
  meta updates every map that placed it; a per-placement **Bake** flag writes
  frame 0 into the tile grid instead, for static scenery that should cost
  nothing at runtime.
- **A split map sidebar** — tiles from the tileset above, meta-tiles below.
- **`reserveTile0`**, an opt-in flag on `*.tiles.json`. When set, tile 0 is
  locked blank, renders as a checkerboard, and is skipped when a meta is drawn,
  which is what makes meta-tile transparency possible. Off for every existing
  tileset, so no project changes behaviour without being migrated deliberately.
- **Exported C for both** — a meta's frame table with `_META_W` / `_META_H` /
  `_CELLS` / `_FRAMES` / `_FLAGS` and an opt-in `_Draw(x, y, frame)`; a map's
  placement table with `_METAS`, `_PLACEMENTS`, a `#define` per meta and its
  mirrored flags, and an opt-in `_DrawPlacements(frames)`. Both write each row
  as runs of non-transparent cells through MSXgl's own `VDP_WriteLayout_GM2`,
  because a transparent cell is a *skipped* write.
- **`fillPoints` takes a width and height**, so the meta canvas can flood a
  picture rather than a single 8×8 cell. Defaults to today's behaviour.

### Meta-tiles in bitmap and multicolour modes (stage 2)

#### Added

- **Bitmap meta-tiles are painted and placed like pattern ones.** A
  `*.meta-btiles.json` over a `*.btiles.json` gets the same canvas, frames,
  onion skin and map placement. No pixel is ever dropped — a bitmap mode has no
  per-row colour limit — and the cell grid follows the tileset's own tile size
  rather than a fixed 8×8.
- **Two kinds of transparency, which compose.** A cell holding tile 0 is not
  blitted (`reserveTile0` now exists on `*.btiles.json` too); and where the
  tileset nominates **colour 0** as transparent, cells blit through `LMMM` with
  `VDP_OP_TIMP` so colour-0 pixels inside a cell show through as well. Only
  colour 0 — the V9938 hardwires TIMP to it — and any other index gets an opaque
  `HMMM` with a header comment explaining why.
- **`MetaRef.masked`**, mirrored onto the map so its placement runtime can pick
  the blit per meta; one map may place both kinds.

#### Changed

- SCREEN 3 splits by tile size. Its 2×2 form is a name-table map, so meta-tiles
  place there through the pattern path unchanged. Any other sc3 tile size blits
  and an MSX1 has no command engine, so placements on those maps are reported in
  the Problems panel instead of exported as V9938 calls that link and do nothing.

### Tile editor

#### Changed

- **Left click paints the row's ink with the selected colour, right click its
  paper** — the same model as the meta-tile editor. The buttons used to assign a
  pixel to whichever colours the row *already* held, ignoring the palette
  entirely, so choosing a colour and drawing appeared to do nothing. A role
  always has somewhere to go, so a third colour now replaces one of the two
  rather than raising a conflict popover per pixel.

#### Fixed

- **Deleting a multi-tile selection** removes every tile in it, behind a single
  confirmation and as one undo step. It deleted only the active tile before, one
  prompt at a time. Removal is ordered highest-first and the per-step mappings
  compose into one, because each removal renumbers the tiles above it — so the
  maps and blocks drawn with the tileset replay a single renumbering rather than
  one per tile.

## Stage 1

#### Changed

- A stroke resolves against the tileset **once, on release**, rather than per
  pointer sample — a drag no longer mints a tile for every intermediate shape it
  passed through — and counts as one undo step.
- **Saving reclaims** the tiles the session created and stopped using, so
  experiments do not reach the file. The Compact button does it on demand.
- Painting a meta-tile now writes tiles into the referenced `*.tiles.json`
  **copy-on-write**: the edited pattern is deduplicated against the bank and
  appended only if new. Existing tiles are never modified in place and existing
  indices never shift, so painting a meta cannot corrupt a map. A manual
  **Compact unused tiles** command reclaims tiles left orphaned by undo.
- The tileset is held in a single Pinia store keyed by path, shared by the tile
  editor and every meta-tile editor, so the same `*.tiles.json` open in two tabs
  is one document rather than two copies that overwrite each other.
- SCREEN 1 meta-tiles constrain the palette to the two colours in force for the
  current tile's group, with an explicit command to change that group's pair.

#### Removed

- The meta-tile **set** model, one release old and unused by any project: a map
  is no longer "all tiles or all metas". `MapDoc.meta` and the meta-map
  expansion helpers (`_ExpandRow`, `_ExpandToRAM`, the meta `_DrawView` and
  `_DrawRow`) are gone, replaced by the placement table above.

## [0.1.1]

Initial versions. Changes before this changelog existed are in the git history.
