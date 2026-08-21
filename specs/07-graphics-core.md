# Spec 07 — Graphics Core & Asset Pipeline

**Phase:** 3 (first, before 08–10) · **Depends on:** 01, 03 · **Suggested model:**
Opus 5

## Goal

The shared foundation the graphics editors (Specs 08–10) build on: MSX color/mode
math, constraint logic, image quantization, and export of editor resources into the
files MSXgl projects consume — plus a cross-platform image-conversion pipeline using
the **bundled MSXimg** binary (MSXgl ships Linux + Windows builds in
`tools/MSXtk/bin/`), replacing MSXgl's Windows-only `build_data.bat` workflow.

## A. `src/shared/msx/` — pure TypeScript, zero Electron/DOM deps, Vitest-covered

- `palette.ts` — TMS9918A fixed 16-color palette (use the common openMSX RGB
  values), V9938 GRB333 (512-color) encode/decode, nearest-color search (weighted
  RGB distance).
- `modes.ts` — one table for sc0–sc8 (+10/12 metadata): resolution, color model,
  tile/bitmap kind, sprite mode, constraint descriptor. Single source of truth
  consumed by all editors. `BITMAP_MODES` is the *index-per-pixel* set rather
  than the V9938 set: **sc3 is in it**, because a multicolor document is one
  palette index per 4×4 block and that is the same shape sc5–8 have.
- `sc3.ts` — everything SCREEN 3 does not share with any other mode: the VRAM
  address of a block (`((y & 0xF8) << 5) | ((x >> 1) << 3) | (y & 7)`, the closed
  form of the name-table indirection), the name-table boilerplate that makes the
  pattern table a framebuffer, the row-agnostic 8-byte pattern a 2×2 tile packs
  into, and the emitted C — MSXgl ships none of it. See `msxgl-notes.md`.
- `tile.ts` — hardware byte layouts (pattern/color per row for sc2/sc4, group
  colors for sc1), `paintPixel` conflict logic (Spec 08), validators.
- `sprite.ts` — mode 1/2 layouts, EC/CC/IC bit handling, OR-color composite
  (Spec 09).
- `quantize.ts` — RGBA image → indexed: fixed or optimized 16-entry palette
  (median cut), dithering none/bayer4/floyd, and **constraint-fit** passes:
  per-8×1-row 2-color reduction (sc2 tiles) and ≤16/≤4-color screen fits (sc5/sc6).
  Reports a lossiness summary (rows altered, colors merged) for import dialogs.
- `emitC.ts` / `emitBin.ts` — emit MSXgl-style C headers
  (`const unsigned char g_<Name>[] = { … };` with per-byte `/* ######.. */` art
  comments and optional `#define <NAME>_SIZE` etc., mirroring MSXimg output
  conventions — see any `projects/samples/content/*.h`) and raw `.bin`.

## B. Resource export (editors → project `content/`)

Every editor file (`*.tiles.json`, `*.sprites.json`, `*.map.json`, `*.screen.json`)
carries an `export` block: `{ name: "g_MyTiles", format: "c" | "bin",
out: "content/mytiles.h" }`, plus the opt-in `helpers`, `compress` and
`doubleBuffer` switches (the last is SCREEN 3's page flip; see Spec 10). `ResourceService` (main) exposes
`resources:exportOne` / `resources:exportAll`; Spec 04 calls exportAll before every
build (skip when source mtime ≤ output mtime). Exports are deterministic (stable
byte output for identical input — no timestamps in generated files).

## C. imgRules — MSXimg batch conversions

For conversions the in-app editors don't author (full-screen sc5/sc8 images, YJK,
compressed data, fonts), `.msxproj` `resources.imgRules` holds declarative rules:

```jsonc
{ "input": "assets/title.png", "out": "content/title.h",
  "args": ["-mode", "bmp", "-bpc", "4", "-pal", "custom", "-dither", "bayer4",
            "-compress", "pletter", "-name", "g_Title"] }
```

Executed with `<msxglPath>/tools/MSXtk/bin/MSXimg(.exe)` (spawn, cwd = project
root) as part of the pre-build resource step, again mtime-skipped. UI: a simple
table in Project Settings (input / output / raw args string) — no arg builder GUI
in v1; link to the CLI help text that ships at `tools/MSXtk/bin/MSXimg.txt`.

## D. Import dialogs (shared UI component)

One "Import image" flow used by Specs 08–10: pick PNG → choose mode/palette/dither
options → live before/after preview (renders via `quantize.ts` in a worker) →
lossiness report → create/merge into the target editor file.

## Acceptance

- Vitest: GRB333 round-trip; quantize of a reference PNG to sc5 yields ≤16 colors
  all inside the 512 space; sc2 constraint-fit output passes `tile.ts` validators;
  emitted C header for a fixture tileset is byte-stable across runs.
- An imgRule converts a PNG on Linux and Windows using the bundled MSXimg, and the
  generated header compiles inside a template project (`#include` + build passes).
- Export skip logic: second exportAll with nothing dirty runs zero conversions.
