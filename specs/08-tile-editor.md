# Spec 08 — Tile Editor

**Phase:** 3 · **Depends on:** 01, 05, 07 · **Suggested model:** Opus 5 (constraint
logic is subtle; UI parts fine for Sonnet 5)

## Goal

Create and edit MSX pattern-mode tilesets with the hardware's color constraints
enforced live — the editor makes illegal tiles impossible, which is the whole point
of this app vs. a generic pixel editor.

## File format

`*.tiles.json`, registered in the editor registry (Spec 05). Stored faithful to
hardware so export is trivial (types + validation live in `src/shared/msx/`, Spec 07):

```jsonc
{
  "version": 1,
  "mode": "sc2",              // "sc1" | "sc2" | "sc4" (sc4 = sc2 constraints, sprite mode differs elsewhere)
  "palette": null,             // MSX1 modes: null (fixed TMS9918); MSX2: 16 GRB333 entries
  "count": 256,                // up to 256 tiles per bank
  "tiles": [                   // per tile: hardware bytes, not freeform pixels
    { "pattern": [8 bytes], "color": [8 bytes] }   // color byte = FG<<4 | BG per row (sc2/sc4)
  ]
}
```

SC1 difference: one color byte per *group of 8 tiles*, not per row — the format field
becomes `"groupColors": [32 bytes]` and per-tile `color` is absent. The editor
switches behavior on `mode`.

## Editor UI (opens as an editor tab)

Three-pane layout:

- **Tileset grid** (left): all tiles, 16 per row, zoomable, shows index + hex.
  Select one or marquee-select several. Drag to reorder (updates indices; warn that
  maps referencing this set are remapped — Spec 10 owns the remap).
- **Canvas** (center): selected tile at large zoom (pixel grid), tools: pencil,
  line, rect, fill, FG/BG swap per row, shift/mirror/rotate tile, undo/redo
  (plain command stack, per-file).
- **Palette + row colors** (right): 16-color palette (fixed MSX1 or editable GRB333
  picker for MSX2 — the picker snaps to the 512-color space and shows the snapped
  result). For sc2/sc4: an 8-row strip showing each row's FG/BG pair.

**Constraint enforcement (the core requirement):** painting with a 3rd color on an
8×1 row (sc2/sc4) triggers a resolution popover on the row: replace row FG, replace
row BG, or cancel — never silently corrupt. Same logic for SC1 at group granularity.
This logic lives in `src/shared/msx/tile.ts` as pure functions
(`paintPixel(tile, x, y, colorIndex) → {ok} | {conflict: …}`) with unit tests —
UI is a thin shell over it.

## Extras (small, in scope)

- Import: PNG → tileset via Spec 07's converter (quantize + per-row constraint fit,
  report lossy rows). Dedup identical tiles on import (option).
- Live preview strip: current tileset laid out as a sample 32×24 screen using an
  attached map file if one references this set (read-only glimpse, full editing in
  Spec 10).
- Export: delegates entirely to Spec 07 (`C header / bin` in MSXgl layout).

## Acceptance

- Unit tests: `paintPixel` covers all conflict branches for sc2 and sc1 modes.
- Draw a 3-color row → popover appears; both resolutions produce valid hardware bytes.
- Round-trip: import PNG of an existing MSX game screenshot → export → bytes comply
  with mode constraints (validator from Spec 07 passes).
- Undo/redo across paint/reorder/palette operations is consistent.
