# Tiled-mode screen editor — design

**Date:** 2026-09-03
**Status:** approved in brainstorming, not yet implemented.
**Scope:** pixel painting on a SCREEN 1/2/4 map — touching up an imported
screen, editing part of a hand-built map, and drawing one from scratch. Bitmap
modes (SCREEN 5 and up) already have this and are unchanged.

## Why

MSXDEVStudio can paint pixels in three places and none of them is a screen.
The tile editor paints one tile, or a marquee of tiles read as one image. The
meta-tile editor paints a design a few tiles across, resolving each stroke into
the tileset copy-on-write. The bitmap screen editor paints a whole SCREEN 5
picture. A SCREEN 1/2/4 screen — the one the hardware is actually built around —
can only be **stamped**: `MapTool` is `'stamp' | 'fill' | 'rect' | 'erase'`,
every one of them cell-level.

So the only way to get art onto a tiled screen today is to draw it elsewhere and
import it. Pablo asked for the missing half on 2026-09-02, and again on
2026-09-03 after the banking work landed: *"edit directly a screen in tiled
mode? like an imported image, or a map — switching from stamping tiles to
editing."* Plus, added during this brainstorm: **create one from scratch**, not
only retouch.

The mechanism already exists. `meta-paint.ts` *is* "paint pixels, obey the tile
limits, resolve copy-on-write into the bank". It is simply pointed at a meta
instead of a map.

## What this is not

- **Not a new document type.** A tiled screen already has one: a tileset plus a
  map. `.screen.json` stays bitmap-only — its `isBitmapMode` guard is correct,
  since SCREEN 5 has no name table and SCREEN 1/2/4 do. A third document meaning
  what a map already means would need its own exporter, compression path and
  agent-guide section for nothing.
- **Not a second editor.** Painting joins the map editor rather than opening
  beside it. Two editors over the same two files could both be open on the same
  map, and every fix would have to land twice — which is exactly why
  `tilesetStore` exists.
- **Not a change to the export.** A painted screen exports as tileset + map,
  byte for byte the same as a stamped one. This feature emits no new C.
- **Not the importer.** The importer seeds a screen; it never edits one. Using
  it as the edit loop would re-derive the whole bank per stroke, renumbering
  every tile and invalidating every other map on that tileset. Banked promotion
  below does call `packBankedTiles` — but exactly once, at a moment the user
  chose, which is the opposite of an edit loop.

## The core: `paintGrid`

`paintMeta` touches its meta in exactly four ways — it reads `width` and
`height`, reads the current tile at `frames[frame].tiles[key]`, and writes
through `setFrameTile`. That is a grid interface,
and `MapLayer.data` over `MapDoc.width`/`height` satisfies it identically.

Extract the core; keep `paintMeta` as a wrapper over it.

```ts
paintGrid(
  grid: { width: number; height: number; tiles: number[] },
  tiles: TilesDoc,
  points: readonly Point[],
  color: number,
  role?: 'fg' | 'bg',
  options?: { write: 'fork' | 'edit'; bankOf?: (cellRow: number) => number }
): { grid; tiles; added: number[]; dropped: number; refused?: string }
```

`paintMeta` calls it with `write: 'fork'` and no `bankOf`, which is what it does
today — so the meta editor's behaviour is provably unchanged, and that is
testable as a pure refactor before any new UI exists.

### `write: 'fork' | 'edit'` — chosen per stroke

| Mode | What it does | Cost | Reach |
|---|---|---|---|
| `fork` | Derive the new art, find-or-create it in the bank, repoint this one cell. Today's `paintMeta` behaviour. | One tile per distinct new cell; can refuse when the bank is full. | This cell only. |
| `edit` | Rewrite the tile's own pixels at its current index. No allocation. | Zero. Always works, even on a full tileset. | **Every cell and every map using that tile.** |

A sidebar toggle picks the mode. Both are legitimate and neither is a safe
default: `fork` is what keeps a shared tileset uncorrupted, `edit` is what makes
"recolour every brick at once" possible and what lets a full imported screen be
touched up at all. Making it explicit and per-stroke is the decision; an
implicit rule ("fork only if actually shared") was rejected as unpredictable —
the same gesture would behave differently in two places.

### `bankOf` — bank-local allocation

`findOrCreateTile` allocates into the **shared** region on a banked tileset, so
one index means one picture in every bank. Meta-tiles need that: it is what lets
`_DrawPlacements` stay bank-unaware.

A screen does not. Painting row 3 needs art in bank 0 only, and a shared slot
costs a slot in *all three* banks — the scarcest resource on the tileset. So
painting gets a **second allocator** beside the existing one, searching and
allocating in `bankTiles[bank]` for the row's own bank. `bankOf` takes the
**cell** row (`Math.floor(point.y / TILE_SIZE)`), not the pixel row — the map
editor passes `bankForRow` (already in `map.ts`), wrapped by `SCREEN_ROWS` the
way `bankSheetOffset` is, so a taller-than-24-row map in progress cannot index
a bank that does not exist. `findOrCreateTile` is not changed.

When the row's bank is full, the stroke is **refused, naming the bank** —
matching `paintMeta`'s existing whole-stroke refusal, and never silently
spending shared budget as a fallback. A half-drawn stroke is worse than none.

## The editor surface

Both tool vocabularies already exist. Paint mode reuses `TileTool` wholesale —
`'pencil' | 'line' | 'rect' | 'fill' | 'spray'`, the same set the tile and meta
editors use, with the same `applyStroke`/`linePoints`/`rectPoints` machinery and
the same right-drag-is-background role convention. No new tools are invented.

A toolbar toggle — **Tiles | Paint** — selects which set is live, rather than
flattening pixel tools into `MapTool` beside cell tools. Half a list operating
on cells and half on dots reads as one list where every item behaves subtly
differently.

`MapSession` gains `mode`, `paintTool`, `paintColor`, and the `write` toggle.
The canvas keeps its zoom; in paint mode the hit test resolves to a dot instead
of a cell.

**Layer target:** the active layer, whichever it is — one selection rule shared
with the stamp tool. Accepted consequence: painting into an empty overlay cell
forks tile 0 into real art and that cell stops being transparent.

**Budget readout** in the sidebar: `tiles: 137/256`, or per-bank
`bank 0: 212/256` when banked, reusing `bankBudgetLabel`. On this hardware that
number decides whether a drawing is possible at all.

**Component split:** `MapCanvas.vue` is already the largest file in its
directory and this adds a second input path. The paint path becomes its own
component as part of this work — in scope, not a follow-up.

## Undo

The meta editor's history is `History<MetaTileDoc>` — the tileset is not in it.
Undo reverts cell references and leaves new tiles as orphans, which CLAUDE.md
documents as a deliberate cost that Compact reclaims. That is sound *because
copy-on-write only appends*: undo can leak art, never lose it.

**`edit` mode breaks that invariant.** It changes pixels in place and may not
touch the grid at all, so a `History<MapDoc>` undo would revert nothing and the
change would be permanent. Silently unundoable painting is the worst available
outcome.

Map history entries therefore carry the inverse, following the pattern
tile-editor entries already use for `remap`:

```ts
{ doc: MapDoc, tileEdits?: { index: number; before: TileEntry }[] }
```

- A `fork` stroke records nothing new — existing orphan behaviour, unchanged.
- An `edit` stroke records the entries it overwrote; undo restores them into the
  tileset store. A handful of tiles per stroke.

Two constraints, both matching what is already there:

- The map writes the tileset **through `useTilesetStore()`**, never a local copy
  — the reason that store exists.
- Painting rebases on external change the way the map already replays
  `tilesetReorderSeen`. Safe because fork appends and edit's inverse is recorded.

**Named consequence:** undoing an `edit` stroke restores that tile for every map
using it, symmetric with the stroke itself. Undo is as wide-reaching as the
paint was.

## Creating a screen from scratch

**New tiled screen** scaffolds a `.tiles.json` + `.map.json` pair (32×24, the
map referencing the tileset) and opens the map in paint mode.

### Hitting the 256-tile ceiling

An unbanked tileset caps at 256. The stroke that would exceed it stops and asks,
**once**:

> This screen is out of tiles. Switch to banked (three banks of 256)?

Accepting **re-uses the importer rather than inventing a redistributor**: the
screen is already fully described by tileset + map, so it is rendered to a
256×192 bitmap and handed to `packBankedTiles` — already tested, already
ROM-verified, already correct about bank-relative layout and the shared region.
Promotion is "render, repack, rewrite both files."

Two limits fall out, both stated rather than worked around:

- Promotion requires exactly 32×24, since `packBankedTiles` needs 256×192 and
  `validateMap` refuses a banked map that is not 24 rows. A taller map that hits
  256 gets the refusal with that as the reason, not the offer.
- Repacking renumbers, so **any other map on that tileset is affected** and the
  prompt must say so. This is the one moment renumbering is legal — precisely
  because the tileset is still unbanked. Once banked, Task 9's rule forbids it.

**The triggering stroke is discarded, not replayed.** Promotion renumbers every
tile, so the stroke's own cell indices are stale by the time it completes; asking
the user to draw it again on a screen that now has room is honest, and re-applying
it against a repacked tileset is a correctness problem for one saved gesture.
Declining leaves painting refused, as it is today.

## SCREEN 1

No special handling. `findOrCreateTile` already enforces the group-pair rule and
`paintPixel` already decides against a scratch one-tile doc. Painting sc1 across
a whole screen is heavily constrained — eight tiles share one colour pair — but
it is constrained *correctly*, and the budget readout tells the truth about it.

## Testing

Following CLAUDE.md's rule that the test goes in the layer the failure happens in:

- **`paintGrid` and the bank allocator** are dependency-free: real vitest
  coverage, including a refactor proof that `paintMeta` is unchanged through the
  wrapper.
- **`map/session.ts`** is vitest-covered by CLAUDE.md's own exception: mode
  switching, the `edit`/`fork` toggle, undo of an `edit` stroke, bank-local
  allocation, the full-bank refusal, and the promotion refusal on a non-24-row
  map all get session tests.
- **The canvas component is not covered** and therefore stays a dumb consumer —
  every offset and hit test computed in `session.ts`. This is the discipline
  Task 10 of the banking branch needed and got.
- Fixtures use banks at **different lengths** and a non-zero `sharedTiles`.
  Uniform fixtures let four defects through on the banking branch.

## Deliverables beyond the code

- `specs/10-map-screen-editors.md` — the paint mode, the two write modes, the
  promotion prompt.
- `CHANGELOG.md`.
- `agent-guide.ts` needs **nothing**: the emitted C, the file names and the way
  a resource is used from C are all unchanged. Worth stating explicitly, since
  CLAUDE.md makes the guide a deliverable whenever any of those change.

## Out of scope

- Bitmap-mode maps. They have the screen editor already.
- Painting placed meta-tiles through the map canvas — a meta is edited in its
  own editor, which is where its frames and flags live.
- Any change to `findOrCreateTile`'s shared-region behaviour, which meta-tiles
  depend on.
- Promotion for maps that are not 32×24.

## Assumptions

- A screen is any tile-mode map; 32×24 matters only for banked promotion.
- The per-stroke `write` toggle is UI state, not saved in the document.
- `mode` and `paintTool` are session state, not history entries — matching
  `session.bank` in the tile editor.
