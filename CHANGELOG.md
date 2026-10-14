# Changelog

All notable changes to MSXDEVStudio are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Select, move, cut, copy, paste and delete in the screen and map editors.**
  A new Select tool drags a rectangle — by the dot on a screen, by the cell on
  a map — and dragging inside it moves it (Ctrl+drag copies). What you move or
  paste floats over the picture until you place it: drag it as often as you
  like, nudge it with the arrow keys (Shift: 8), press Enter or click outside
  it to put it down as one undo step, or Esc (or Ctrl+Z) to take it back.
  Ctrl+X/C/V, Delete and Ctrl+A work as expected; on a map a move carries the
  meta-tiles placed inside the selection with it.
- **An imported image floats until you place it**, in both editors, instead of
  landing at the top-left corner. Its see-through pixels leave what is under
  them alone. On a map the tiles are only found or made once it is dropped, so
  the tile budget and the offer to bank are worked out for where it actually
  goes.

### Changed

- **Importing an image into a screen pastes it onto the screen** rather than
  replacing the screen with it. The screen keeps its size, its mode and what is
  already drawn; the dialog converts to *This screen's palette* by default when
  there is art on it. A screen converted from a source image becomes a drawing
  when you place an import on it, since the result is no longer something the
  source converts to.
- The screen editor's old "cut" tool, which names a fragment, is now called
  **Fragment**, so it is not confused with Cut.

## [0.2.3] - 2026-10-14

### Fixed

- **The app crashed on start under Wayland** on KDE with the NVIDIA driver:
  Electron 43 segfaults the moment it creates a window, before any of the app's
  code runs. Upgraded to Electron 44, which opens a native Wayland window on
  the same machine — no `--ozone-platform=x11` needed.

## [0.2.2] - 2026-10-13

### Meta-tiles: overlap, removal, one model

#### Added

- **Overlapping meta-tiles on indexed layers.** They stack as placed, later on
  top, and a see-through cell shows the one underneath; a click picks the top
  one. The layer still costs one byte per meta-tile: a meta that starts inside
  another, or that reading order would draw underneath, is an overlay record
  (slot + 1, x, y — two bytes per coordinate past 256) after the stream, which
  `_Expand()` draws last. Built by the real MSXgl and booted in openMSX: the
  expanded name table matches the editor's to the cell.
- **Removing a meta-tile from a tileset**, from the tile editor's *Meta-tiles*
  list or from the meta-tile's own *Attached to* list. A map cannot place a
  meta its tileset does not have, so every map drawn with the tileset follows:
  after a confirm naming them, an open map drops it as one undoable edit and a
  closed one is rewritten. Its tiles stay in the tileset as art, and a baked
  copy leaves its cells in the grid. From the meta's editor the tileset is
  saved straight away — with every open map that had nothing else unsaved, so
  the files the build reads agree — unless it already had unsaved edits of its
  own.

#### Changed

- **One kind of pattern meta-tile.** A `.meta-tiles.json` is always the kind
  that owns its pixels and is attached to tilesets; the older kind made of one
  tileset's tile numbers is gone, with its editor path, the *Make it
  independent* conversion and placing an attached animation inside a meta. A
  file from before opens as a blank meta at its own size.
- **A pattern map's `_DrawPlacements()` takes no frames array.** Every live
  placement draws from the map's own `_MetaCells`, and an animated meta-tile
  animates in place through the tileset's `_Animate()`. Bitmap and SCREEN 3
  maps keep `_DrawPlacements(frames, …)`: a `.meta-btiles.json` still redraws
  its frames per copy.
- The meta-tile editor is the `.meta-btiles.json` editor only.

## [0.2.1] - 2026-10-13

### Meta-tiles as their own entities, and maps indexed by them

A meta-tile now owns its pixels, the way an animation does, and is attached to
tilesets rather than made of one tileset's tiles. Maps built from meta-tiles can
store them one byte each.

#### Added

- **Meta-tiles that own their pixels** (`.meta-tiles.json` version 3, what the
  Resources panel now creates). Poses, see-through cells and eight flags live in
  the file, edited with the animation editor's canvas and pose strip plus a
  see-through tool and flag squares, at any size up to 16×16 tiles. One pose is
  a still meta; more, and it animates.
- **Attaching** a meta-tile to a tileset (the tile editor's *Meta-tiles* panel,
  or placing it on a map) gives it tiles there: still cells share any identical
  art, see-through cells are skipped, and the cells that change between poses
  get a window the tileset's `_Animate()` rewrites — every copy animates in
  step, on screen or not, for nothing per copy, and only what moves costs VRAM
  writes. The same meta can be attached to several tilesets.
- The tileset's header states what is attached: `G_<TILESET>_METAS`,
  `G_<TILESET>_META_<NAME>`, `_MetaInfo` and `_MetaCells`, and with helpers on,
  `_DrawMeta(meta, x, y)`. An animated meta is an animation there too, with its
  own `_ANIM_<NAME>` for `_AnimSetActive`/`_AnimRestart`/`_AnimGetFrame`.
- **Indexed layers.** A map layer can be indexed: meta-tiles only, any mix of
  sizes, never overlapping, exported as one byte per meta-tile in reading order
  — a screen of 2×2 metas is 192 bytes instead of 768. With helpers on,
  `_Expand(layer, tiles, objects)` writes it into a tile map in RAM over
  whatever is there (so layers compose), and optionally which object covers
  each cell. Animated meta-tiles keep animating, including ones a scrolling view
  reaches later. Booted in openMSX: a 64-wide level of mixed-size metas, both
  torches animating before and after the view scrolls.
- **Make it independent** converts an older meta-tile in place: its art is
  copied into the file and it stays attached to its tileset at the same tiles,
  so every map keeps drawing what it drew.

#### Changed

- A map that places meta-tiles now re-exports when its tileset changes, since a
  meta's tiles are resolved there.
- An attached meta-tile's tiles are kept by *Remove unused tiles*, and never
  merged into look-alikes.
- `docs/resources.md` no longer describes the meta-tile *set* model, which was
  removed before 0.1.

### Added

- **`g_Tiles_AnimRestart(anim)`** starts one animation over from its first
  pose — shown at once — leaving the others where they are. It is what replays
  a play-once animation (a door, a chest) when its event comes round again;
  `_AnimReset()` still restarts them all.
- **`g_Tiles_AnimGetFrame(anim)`** reads which pose an animation is showing, so
  the game can time a sound or a hitbox to it, and the tileset header gains
  `G_<TILESET>_ANIM_<NAME>_FRAMES` to compare it with. Booted in openMSX: a
  restarted play-once door replays 0 → 1 → 2 while a looping coin keeps its
  phase, and both reads match the pattern in VRAM.

## [0.2.0] - 2026-10-13

### Animated tiles

An animation is now a resource of its own — `*.anim-tiles.json` — that you
attach to a tileset instead of building out of a block and hand-written C.

#### Added

- **The animation editor.** Paint each pose (the tile editor's own colour
  rules), set how many frames each is held, loop / ping-pong / play-once, and
  watch a preview that steps exactly as the game will. It shows what a step
  costs in VRAM and which tilesets it is attached to.
- **Attach and detach, in the tile editor's Animations panel.** Select the tile
  your map cells use and attach: that tile shows the first pose and every cell
  drawing it animates. The other poses live in the animation, not in the
  tileset, so they no longer cost tileset slots. Detaching leaves the first
  pose behind as an ordinary tile. Animated tiles are marked in the grid and
  refuse edits there — edit the animation instead.
- **Make animation from a block**, for projects that animated by hand: select
  the block of poses, say how big a pose is and how long it is held, and the
  animation file is written and attached at the tile you type.
- **`g_Tiles_AnimReset()` / `g_Tiles_Animate()` / `g_Tiles_AnimSetActive()`**,
  generated for a tileset with animations attached and *Export ready-made C*
  on. A step writes VRAM only when a pose changes; it copies colours only when
  the poses differ in colour (so per-third recolouring survives), writes only
  its own bank for a bank's own tiles, and handles SCREEN 1's single pattern
  table. Each write path is built against the real MSXgl in the test suite.
- **Animated meta-tiles, through an animation.** The meta editor's *Animated
  tiles* section points cells at an attached animation, in every frame. Every
  copy of the meta then animates with the tileset's `_Animate()` — baked
  placements included — at no cost per copy; the meta's own frames still
  animate each copy separately. Booted in openMSX, a live and a baked placement
  both show the animation's tiles while their patterns change.
- **`demo_msx1` uses it.** The coin spin is `res/coin.anim-tiles.json` attached
  at tile 6; `SpinCoins()` and its timers are gone, the four pose tiles are
  freed (68 → 64), and `T_TRANS` is read from a `trans` block instead of the
  literal 39. Booted in openMSX, the coin's VRAM and the screen are identical
  to the old build, frame for frame.

#### Fixed

- **A map's header kept a meta-tile's old size or frame count** when only the
  meta had changed: the export skip compared the map's own file and nothing
  else. It now checks every file a resource mirrors.
- **Painting could adopt an animated tile as still art**, and the map's *Edit
  tile* mode could rewrite one in place (lost at the next export). Every
  allocator now skips animation windows, and painting over an animated cell
  gives it a still tile of its own, saying so.

### Fixed

- **The agent guide's tile-animation example copied the pattern but not the
  colours.** In SCREEN 2/4 a tile's colours live in their own table, so a pose
  in different colours showed its shape in the previous pose's colours. The
  example now copies both (`VDP_LoadColor_GM2`, and `VDP_LoadBankColor_GM2` on a
  banked tileset), says when the colour copy can be skipped and what it
  overwrites, and covers SCREEN 1, which has one pattern table and no per-tile
  colours. New projects pick this up in their generated `CLAUDE.md`/`AGENTS.md`;
  `demo_msx1` notes why its own coin spin copies patterns only.

## [0.1.2] - 2026-10-13

### Painting a tiled screen

A SCREEN 1/2/4 screen — a tileset plus a map — can now be painted in pixels,
not only stamped in cells: touching up an imported picture, editing part of
a hand-built map, or drawing one from scratch. No new document type and no
change to the export: a painted screen is still a `*.tiles.json` and a
`*.map.json`, emitted exactly as before.

#### Added

- **Paint mode in the map editor.** A *Tiles | Paint* toggle switches the
  map canvas to the tile editor's tools — pencil, line, rect, fill, spray —
  at dot resolution, left button for the row's ink and right for its paper.
  One drag is one undo step. Offered wherever the map draws from a pattern
  tileset; bitmap maps keep the screen editor.
- **Two ways to write, chosen per stroke.** *Fork tile* gives the stroke its
  own tiles (found-or-created in the tileset, one per changed cell) and
  leaves every other cell showing the old tile alone. *Edit tile* rewrites
  the tile in place, costs nothing and never runs out of tiles.
- **Bank-aware painting.** On a banked tileset a stroke reads from and
  allocates into the bank its row is drawn in, never the shared meta-tile
  region; a full bank refuses the whole stroke and names the bank. The
  sidebar shows the same budget readout the tile editor does.
- **New tiled screen…** (File menu, Resources panel) scaffolds a SCREEN 2
  tileset with tile 0 reserved and a 32×24 map over it, and opens the map
  ready to paint.
- **Switch to banked, once, at the 256-tile ceiling.** When a fork stroke on
  an unbanked 32×24 screen finds no slot left, the editor offers to repack
  the screen into three banks of 256. It refuses — and says why — on a map
  that is not 32×24, one with more than one layer, one that places
  meta-tiles, or a SCREEN 1 tileset. Declining is remembered for the session.
- **Remove unused tiles, and Recalculate.** The paint sidebar's *Tiles*
  section deletes the tiles nothing in the project draws with (every map and
  meta-tile over the tileset is checked, open or closed) and, with
  *Recalculate tiles*, merges tiles that draw the same pixels. Nothing on
  screen changes; other files drawn with the tileset are renumbered to match.
  On a banked screen the one button is *Rebuild banks*, which repacks the
  three banks from what the screen shows.
- **Import image… onto a tiled screen.** Converts a picture to the tileset's
  mode and places it on the active layer, reusing tiles the tileset already
  has. When it does not fit, it frees the tiles only the replaced cells used,
  and failing that offers to switch a 32×24 screen to banked.

#### Two things worth knowing before you use them

- **An *Edit tile* stroke changes that tile everywhere.** Every cell of
  every map and meta-tile drawn with the tileset that references the tile
  shows the new art — that is what makes "recolour every brick at once"
  possible, and it is also why *Fork tile* exists. Undo is as wide-reaching
  as the stroke was, and it is careful: a tile another editor has changed
  since is left alone rather than overwritten, and the status line says how
  many were skipped.
- **Switching to banked renumbers the tileset.** Every tile gets a new
  number, the tileset's named blocks and tile flags are cleared, and any
  *other* map or meta-tile drawn with that tileset shows wrong art until it
  is repainted — their files are not touched and nothing renumbers them for
  you. The stroke that hit the limit is not kept; draw it again afterwards.
  The prompt says all of this before you accept, and a tile-editor tab open
  on the same tileset starts its undo history over at that point so it
  cannot undo the switch out from under the map.
- **Removing or merging tiles restarts the map's undo history.** It
  renumbers the tileset, and the files that followed the renumbering cannot
  be taken back with it. The editor asks first. An image import is still an
  ordinary undo step, even when it had to free tiles to fit.

### SCREEN 2/4 tile banks

SCREEN 2 and SCREEN 4 have three 256-tile pattern banks, not one — a tileset
can now give each bank its own art at some of its indices, so a name-table
byte means different art in different thirds of the screen and a full
256×192 picture can use up to 768 distinct tiles instead of 256.

#### Added

- **Per-bank overrides on `*.tiles.json`.** The tile editor's new **Banks**
  panel is a tab per bank plus a budget readout ("bank 1: 180 + 48 shared =
  228 / 256") that spells out the arithmetic — a bank's own overrides and the
  shared meta-tile reservation both eat the same 256-tile ceiling — before a
  stroke hits it.
- **Importing a full 256×192 screen** now fills all three banks (deduping
  within each one, the way the unbanked path already dedupes within its
  single bank) and reports which bank, if any, ran out of room.
- **Export** adds `_Bank<n>_Patterns`/`_Bank<n>_Colors` for each bank that
  overrides anything (a bank with no art of its own emits no table),
  `_Shared_Patterns`/`_Shared_Colors` for the meta-tile region, and, with
  *Export ready-made C* on, a generated `_Load()`. **A banked tileset must
  never be loaded with `VDP_LoadPattern_GM2`/`VDP_LoadColor_GM2`** — those
  mirror into all three banks and are only correct for a tileset that isn't
  banked; call `_Load()` where it exists, or the same per-bank
  `VDP_LoadBankPattern_GM2`/`VDP_LoadBankColor_GM2` calls by hand where
  helpers are off.
- **A map against a banked tileset must be exactly 24 rows tall** (width is
  free); export refuses a taller one rather than drawing a bottom strip with
  no bank to read from.

#### Changed

- **A banked tileset's common tiles never renumber.** Deleting or reordering
  a common tile, and reserving tile 0 for meta-tile transparency, are refused
  once any bank has an override — a bank's own art is indexed by hardware
  position and does not follow a common-range renumber — and the meta
  editor's Compact reclaims only shared orphans there. This is the one
  restriction users of the feature will actually hit.
- **Known gap: software sprites and banked tilesets can collide.** A software
  sprite in SCREEN 1/2/4 reserves patterns 192–255 in every bank (its loader
  also uses `VDP_LoadPattern_GM2`, which mirrors). The shared meta-tile
  region is allocated from 255 down, so any banked tileset that has one
  overlaps that reservation the moment it's non-empty; a bank's own overrides
  collide too once they pass index 192. The budget readout does not warn
  about this yet, and there is no export-time validation for it — projects
  mixing the two should keep bank art and the shared region under index 192
  until that lands.

**Every tileset created before this release is untouched**: banking is
opt-in per index from the editor, `bankTiles` stays empty and export keeps
emitting exactly the tables it always did until a bank gets its first
override. Most projects will never see a bank at all.

### Fixed

- **Reserving tile 0 on a full tileset no longer loses a tile.** Shifting a
  256-tile bank up by one dropped the last tile's art and merged the two highest
  indices onto one. It now refuses and says why, as the bitmap path already did.
  `demo_msx1/res/intro.tiles.json` is a real 256-tile bank, so this was
  reachable.
- **A newly reserved tile 0 is blank.** The migration prepended a copy of the art
  it displaced, so until the next reload the in-memory bank held art in the index
  the canvas and the emitted `_Draw` both skip. Exported data was never affected —
  the export path normalizes on read.
- **Importing an image now keeps the picture, not just the tiles.** The
  conversion always computed which tile goes in which cell, then discarded it,
  so a SCREEN 1/2/4 import produced a tileset that could not be rearranged back
  into the image. Both import routes — the Import-image dialog and the tile
  editor's own import — now write a `.map.json` beside the tileset. Neither
  clobbers an existing one without saying so: the tile editor's import, a
  side effect of editing an already-open file, never overwrites one; the
  dialog's explicit "save as" asks first, since refusing outright would block
  the normal import-adjust-reimport workflow. A picture needing more than 256
  unique cells says how many it could not place.

### Any text file opens

- **Text is the editor's default, not an allowlist.** Shell scripts, batch
  files, `.txt`, `.yml`, `.ini`, `.gitignore`, `Makefile`, files with no
  extension — all of these used to land on "No editor registered for this file
  type yet", because the text editor was registered against seven hardcoded
  extensions. A specific editor still wins where one exists; everything that is
  not a known binary kind now opens as text.
- Only genuinely binary types (`.rom`, `.png`, `.wav`, `.exe`, archives, fonts)
  get nothing, and they say so instead of showing mojibake.
- Syntax highlighting added for shell, batch, PowerShell, YAML, TOML/INI, XML,
  HTML, CSS, JS/TS, Python and SQL. Missing from that list is not a gate — an
  unknown extension is `plaintext` and still opens.

### Application preferences

- **Preferences dialog** (File → Preferences…) for the editor and terminal font
  family and size. Changes apply to open editors and live terminals
  immediately, and persist with the rest of the application state.
- Font families are read from the system (`fc-list`, `system_profiler`,
  PowerShell). The control is a text field with those as suggestions, so a
  machine that cannot enumerate them is still fully usable — and a family blank
  means the theme's own rather than a pinned name that may not exist on the next
  machine.
- Built around a section list rather than one long form, so a future page of
  options is one entry plus one group on `Preferences`.
- Preferences are stored with the application (`state.json` in the user data
  directory), not with the project, so they follow the machine rather than the
  code. **Save** and **Cancel** say which is which: edits preview live and are
  written as you make them, and Cancel — like Escape or clicking away — puts
  back what you had when you opened the dialog.

### Editors follow files changed outside the app

- An open editor now picks up edits made by something else — an agent working in
  the project, a `git checkout`, another tool. Wired for Monaco buffers and the
  shared tileset store.
- The app's own saves come back through the same watcher, so each document
  compares the incoming text against what it holds; identical means it was us.
  A content check rather than suppressing events around a save, which would be a
  race an agent writing mid-save falls straight through.
- **Unsaved work is never discarded.** A dirty buffer declines the reload and its
  tab dot turns red: the file and the buffer have diverged, and only the user can
  say which wins. Saving resolves it.
- Every resource editor is now covered — maps, meta-tiles, sprites, software
  sprites, screens, SFX, and both tileset kinds — not just text buffers. Each
  reuses its own `load()`, so a reloaded file gets the same fix-ups it would on
  open: a map re-reads its tileset, a screen its source image.

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
