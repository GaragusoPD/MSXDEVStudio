# Spec 09 — Sprite Editor

**Phase:** 3 · **Depends on:** 01, 05, 07 · **Suggested model:** Sonnet 5 (Opus 5 for
the mode-2 OR-color layer logic if split)

## Goal

Edit hardware sprites for both VDP sprite modes, including the classic multi-layer
tricks (layered single-color sprites composed into multicolor characters), with
animation frames and live preview.

## Hardware rules the editor enforces

- **Mode 1 (MSX1, screens 1–3):** 8×8 or 16×16, 1 color per sprite plane, 32 sprites,
  4 visible per scanline.
- **Mode 2 (MSX2+, screens 4–12 except 0):** 1 color *per line* per sprite, 8 visible
  per scanline, and OR-color: two overlapping sprites with CC bit set blend colors
  (color indices OR'd) — the standard way to get 3+ color characters from 2 planes.

## File format

`*.sprites.json` (types in `src/shared/msx/sprite.ts`):

```jsonc
{
  "version": 1,
  "mode": 2,                    // 1 | 2
  "size": 16,                   // 8 | 16
  "palette": null,              // as in Spec 08
  "sprites": [                  // a logical "character" = 1..4 layers
    {
      "name": "player_walk",
      "layers": [               // each layer = one hardware sprite plane
        { "pattern": [32 bytes],           // 16x16 = 32 bytes
          "color": 6,                      // mode 1: single color
          "lineColors": [16 bytes],        // mode 2: color per line (with EC/CC/IC bits)
          "cc": false }                    // mode 2: OR-blend with layer below
      ],
      "frames": [ { "layers": [ …same shape… ] } ]   // animation frames; frame 0 = the above
    }
  ]
}
```

## Editor UI

- **Sprite list** (left): logical sprites with composed thumbnails; add/duplicate/delete.
- **Canvas** (center): paint the *composite*; the editor decomposes strokes onto the
  active layer (layer picker like image-editor layers, max 4, each showing its
  color/line-colors). Mode 2 with CC: composite preview computes OR-blended colors
  exactly as the VDP would — this blend function lives in `src/shared/msx/sprite.ts`
  with unit tests. Tools: pencil, erase, line, fill, mirror/shift; undo/redo.
- **Right panel:** per-layer color controls (single color picker for mode 1; 16-entry
  line-color strip for mode 2 with EC/CC bits), size toggle, mode toggle (warns on
  data loss when going 2→1).
- **Animation bar** (bottom): frames as filmstrip, add/clone/reorder, play at
  configurable frame rate against a checkered or solid background; onion-skin
  previous frame.
- **Scanline budget hint:** static warning strip when >4 (mode 1) / >8 (mode 2)
  layers would share a scanline if placed at the same Y — informational only.

## Import/Export

- Import PNG strip → frames (via Spec 07 quantizer, mapping colors to layers is
  manual: user assigns which palette entries land on which layer).
- Export via Spec 07: pattern tables + color data in MSXgl's expected layout.

## Acceptance

- Unit tests: OR-color composite for known 2-layer fixtures matches hand-computed
  colors; mode 1↔2 conversion preserves patterns.
- Draw on composite → correct layer receives pixels; preview equals VDP semantics.
- Animation playback works; export re-imports losslessly (round-trip test).
