# Importing sprite sheets and tilesets — design

**Date:** 2026-10-14
**Status:** implemented, both phases (0.2.4) — see *As built*.
**Scope:** one importer for the asset sheets people buy or download (itch.io
packs and the like) — a PNG of tiles or animation frames on a grid — that cuts
it into cells, takes a transparent colour, and sends the cells you pick to a
resource: a tileset, a map, an animated tile, a meta-tile, or a sprite.

## As built

- **The grid guess** takes, in order: a common cell size whose every boundary
  falls on empty lines (frames edge to edge on a transparent background); a
  period whose gaps all fall on empty lines and fill the sheet exactly,
  preferring the one with something in the most cells, then more gaps, equal
  margins at both ends and figures centred in their cells — on a transparent
  background the space beside a narrow figure passes for a gutter otherwise;
  a strip of square frames; the commonest tile size. Each stays a field.
- **A meta-tile's trim snaps to whole tiles** of the sheet's grid; a sprite's
  is to the dot. Trimming a 16×16 coin to its 9×9 content and padding back to
  tiles moved it off the grid it was drawn on and made a see-through cell of a
  tile the coin covered.
- **An untouched destination is replaced, not appended to**: a new file's
  blank pose or blank sprite is a placeholder, not art. Its flags and export
  settings are kept.
- **Adding poses to a meta-tile** keeps a cell see-through only if the new
  poses leave it empty too. SCREEN 1 poses joining a file take its ink and
  paper.
- **The dialog stays open** after an import and the editors' own status lines
  report it, so a sheet's rows can go to several places in one sitting.
- Verified: pure tests of the cutting and every destination (sprite frames
  against the VDP composite, 20 random figures); the wiring against stubbed
  files; the real app, each destination driven through the dialog; and an
  imported mode-2 metasprite built with the real MSXgl and booted in openMSX,
  where every dot of each frame matches the editor's composite.

## Why

Pablo, 2026-10-14: *"import an image that has a spritesheet or tileset (like
pngs you buy in game assets on itch.io). We should be able to import those,
select the transparent color, and to select the source, if to a map or an
animated tile (also megatile) or animated sprite, etc."*

Today every importer reads an image as **one picture**:

- the tile editor packs the whole picture into 8×8 tiles, the bitmap tile
  editor slices it at its own tile size, the map floats it, the screen pastes
  it — all from (0,0), with no gap between cells;
- the sprite importer takes a single row of frames at the document's sprite
  size and nothing else;
- transparency is alpha only — a sheet drawn on a magenta or teal background
  has no transparent pixels as far as the importer is concerned;
- `fitToMode` shrinks anything larger than a screen before converting it, so a
  512-pixel-wide sheet arrives at half size, its pixel art smeared.

A sheet is different from a picture. It is a **grid of cells** — often with a
margin and a gap between cells, often drawn at 2× or 3× — and what you want
from it is usually *some* of those cells, in order: the eight frames of a walk
cycle, the four poses of a torch, the twenty ground tiles in the top-left.

## The importer

One dialog, `SheetImportDialog`, opened from the Resources panel (*Import
sheet…*) and from the editors that can take cells (the tile, map, pose and
sprite editors), which open it with themselves as the destination.

1. **The sheet**, shown at a zoom you choose, with the grid drawn over it.
2. **The grid**: cell width × height, the margin before the first cell
   (offset x/y), the gap between cells (spacing x/y), and the **pixel scale** —
   how many sheet pixels make one MSX dot, for art drawn at 2× or 3×.
   *Guess* proposes all of them from the image: the scale from the common
   divisor of every run of equal pixels, the transparent colour from alpha or
   the corners, and the cell size and gaps from rows and columns that are
   entirely transparent at a regular interval.
3. **The transparent colour**: the image's alpha (always honoured), plus one
   **key colour** picked with an eyedropper on the sheet — or none. Keyed
   pixels become index 0 exactly as transparent PNG pixels do today, so every
   existing converter already knows what to do with them.
4. **The cells**: click a cell, shift-click to extend in reading order,
   ctrl-click to toggle, drag a rectangle. The order is reading order — it is
   the order sheets are drawn in. *Skip empty cells* (on by default) drops
   cells with nothing in them, the usual ragged end of an animation row.
5. **The destination**, and a preview of what it will get, converted, with the
   loss report the image importer already has.

Conversion runs once, on a strip of the selected cells side by side, through
the existing quantizer and worker — one palette for the whole selection, and
the mode's colour rules applied cell by cell because every cell is a multiple
of 8 wide. No shrinking: the sheet is cut at its own scale.

## Destinations

Each is a pure function in `shared/` from converted cells to the resource, so
the rules are tested without a DOM, and a renderer module applies the result —
to a new file, or to an existing one through its editor so the change is one
undo step there.

| Destination | What a cell becomes | Transparent pixels |
|---|---|---|
| **Tileset** (`.tiles.json`) | Its 8×8 tiles, deduplicated against the tileset; optionally a named **block** per cell, so a 16×16 tile is one stamp on a map. New tilesets can also get a map laying the selection out as on the sheet. | Colour 0 (the backdrop); an all-transparent tile is tile 0 when it is reserved. |
| **Map** | The selection, laid out as on the sheet, floats over the open map exactly like an imported picture; its tiles are found or made in the map's tileset where it is dropped. | See-through: the map underneath shows. |
| **Animated tile** (`.anim-tiles.json`) | One pose per cell; cell size = the window, up to 16 tiles. | Colour 0. |
| **Meta-tile** (`.meta-tiles.json`) | One pose per cell, up to 16×16 tiles. | An 8×8 cell transparent in every pose is a **see-through cell**; other transparent pixels are colour 0. |
| **Sprite** (`.sprites.json`) | One frame per cell of a new character; a cell larger than the sprite size becomes a metasprite grid (up to 4×4). | Sprite colour 0 — transparent on the VDP. |

Rows: for the animated destinations (animated tile, meta-tile, sprite),
**one per row** (on by default when the selection spans several rows) makes
each row of the selection its own animation — idle, walk and jump from one
character sheet in one import, named after the file plus the row.

**Trim** (sprites and meta-tiles, on by default): cut every frame to the one
box that holds the content of *all* of them, so a 20×24 character in 32×32
cells costs a 2×2 metasprite only where it must, and the frames stay aligned.

### Sprites: colours into planes

A hardware sprite plane has one colour — per sprite in mode 1, per line in
mode 2. A character drawn in several colours is therefore several planes
stacked on one cell (the editor's layers), and the importer does the split:

- **Mode 1**: per frame and cell, the most-used colours each get a plane, up to
  *max planes* (default 3); any colour left over goes to the nearest kept one.
- **Mode 2**: the same, **per line** — each line hands its own colours to the
  planes, so a figure with six colours, never more than two on one line, costs
  two planes, not six.
- Every frame of a character gets the same number of planes (the export's
  `_PLANES` is per character), padding with empty ones.
- The report says how many sprites one line of the character shows, against
  the hardware's 4 (MSX1) or 8 (MSX2) per line.

The OR-colour trick (CC: three colours from two planes) is left to the editor.

## Decisions taken by default

Proposed defaults, cheap to change; none was confirmed.

1. **"To a map" means placing the selection on a map**, as a floating picture.
   A *new* tileset can additionally lay the selection out as a new map, which
   covers the other reading.
2. **A big cell in a pattern tileset is its tiles plus a named block** (block
   per cell is a checkbox, on). A meta-tile per cell is not offered: it would be
   one file per cell.
3. **Colour split for sprites is automatic**, with *max planes* as the control;
   the manual colour-to-plane table of today's sprite importer stays where it
   is.
4. **Reading order, not click order**, for frames.

## Phases

1. **Pattern modes and hardware sprites**: the dialog, the grid and key, and
   the destinations above.
2. **MSX2**: bitmap tilesets (a cell cut into tiles of the tileset's size, a
   new tileset taking the cell's), bitmap meta-tiles (frames whose tiles go into
   the bitmap tileset the meta is drawn with), software sprites in any of their
   modes (frames padded to the mode's step), and placing cells on a screen —
   which replaced *screen fragments*: a software-sprite sheet is what fragments
   were for, and it now has an importer.

### Phase 2, as built

- **A palette is shared, not replaced.** Into a file with a palette, the
  conversion keeps every entry its pixels use and gives the sheet's colours
  the entries nothing uses (`unusedEntries`, the screen import's rule), so a
  second sheet never recolours the first.
- **"MSX1 colours" is written out.** The quantizer returns no palette for the
  fixed MSX1 colours; a V9938 file still has to hold them, or a new tileset or
  sprite sheet comes out sixteen blacks. Found in the app run, not by a test.
- **Keyed dots are index 0 in every mode**, SCREEN 8 included, whose 0 is
  otherwise black; a screen's float is told so explicitly.
- **Verified** as phase 1 was, and on the emulator: an imported SCREEN 5
  software sprite built with the real MSXgl, its palette loaded with
  non-default colours, matches the source in every dot and every colour.
- **Found on the way:** the agent guide, `resources.md` and two tutorials loaded
  a 16-entry `_Palette` with `VDP_SetPalette(table)`, which under the
  template's `VDP_USE_PALETTE16 FALSE` writes entries 0–14 into colours 1–15 —
  every colour one off. They now pass `table + 2`.
