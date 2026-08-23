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
  `_FRAMES` / `_FLAGS` and an opt-in `_Draw(x, y, frame)`; a map's placement
  table with an opt-in `_DrawPlacements(frames)`.

#### Changed

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
