# SCREEN 2/4 pattern banks — design

**Date:** 2026-09-03
**Status:** approved in brainstorming, not yet implemented.
**Scope:** SCREEN 2 and SCREEN 4 tilesets, the maps drawn with them, the
meta-tiles placed on those maps, and the image importer. SCREEN 1 is explicitly
out — it has one pattern table, not three.

## Why

The hardware has three pattern banks and MSXDEVStudio models one.

A SCREEN 2 (and SCREEN 4) pattern table is 6144 bytes — **768 patterns**, in
three banks of 256. Bank 0 serves screen rows 0–7, bank 1 rows 8–15, bank 2 rows
16–23. The colour table is the same shape, so a bank is a full 256 tiles of art,
not just patterns. A name-table byte is an index **within its row's bank**, so
the same byte means three different pictures depending on where it sits.

`MAX_TILES = 256` flattens all of that to one bank, which has a concrete
consequence: **a full-screen 32×24 image cannot be represented.** Converting one
fills the bank partway down and stops. Pablo hit this on 2026-09-03 — a title
screen imported into `w3d` produced a 768-cell map with 258 non-empty cells, art
ending at row 11 of 24, against a tileset pinned at `count: 256`. The importer
reported it, quietly, and wrote the half picture anyway.

## What this is not

Most games deliberately want the *current* behaviour: one 256-tile bank
replicated into all three sections, so any tile can be drawn anywhere. That is
what MSXgl's `VDP_LoadPattern_GM2` does — its own header says it loads "in all 3
screen sections" — and it is right for a platformer whose tiles move around the
screen. Banking is for pictures that fill the screen, not for tilesets in
general. So nothing here changes what an existing tileset means or how it
exports.

## The model

Two allocators in every bank, growing toward each other.

| Region | Grows | Mirrored across banks? | Holds |
|---|---|---|---|
| **Unique** | up from index 0, independently per bank | no | that third's own artwork — what a converted image fills |
| **Shared** | down from index 255 | yes — identical in all three | tiles that must mean the same picture anywhere on screen: meta-tiles |

They meet in the middle. There is no declared boundary, no reserved region, and
no setting to get wrong: a screen that is mostly picture and one that is mostly
objects both work. **Full** is when the two would collide in any one bank.

- Shared tile *k* is at hardware index **255 − k**.
- Unique tile *j* of bank *i* is at hardware index **j**.
- Constraint, per bank: `Uᵢ + S ≤ 256`.
- Total distinct art: `S + U₀ + U₁ + U₂` — 768 when nothing is shared, 256 when
  everything is.

### Why the indices count from opposite ends

Both ends must be **stable under growth**, or editing a screen invalidates it.

Adding a unique tile appends at `Uᵢ`, so no existing unique index moves. Adding a
shared tile takes `255 − S`, so no existing shared index moves either. Had shared
tiles been numbered upward from the region's start, every addition would shift
all of them and renumber every map drawn with that tileset — the Spec 10 remap
seam would fire on every new meta tile, which is not a cost worth paying for a
tidier-looking array.

### Storage, and why there is no migration

`TilesDoc.tiles` keeps exactly its present meaning: **the shared set**. A new
field holds the per-bank uniques.

```ts
interface TilesDoc {
  // …unchanged…
  /**
   * Per-bank artwork for SCREEN 2/4's three pattern banks, `[bank0, bank1,
   * bank2]`, each growing from index 0. Empty in every file that predates this
   * and in every tileset that does not need banking — which is most of them,
   * because a game that draws the same tile at any screen height wants one bank
   * replicated, not three distinct ones.
   */
  bankTiles: TileEntry[][]
}
```

An existing tileset normalizes to `bankTiles: [[], [], []]`, so all three banks
show only the shared set — every tile identical in every bank, which is what the
file already meant and what `VDP_LoadPattern_GM2` already does. **No file
changes, no version bump, no remap event.**

`banked` is therefore a derived question, not a stored flag:
`bankTiles.some((b) => b.length > 0)`.

### Resolving an index

One function, used by the editors, the map renderer and the exporter, so they
cannot disagree:

```ts
/** The art a name-table byte means, for a cell in the given bank. */
export function bankTileAt(doc: TilesDoc, bank: number, index: number): TileEntry
```

`index >= 256 - doc.tiles.length` → shared tile `255 - index`; otherwise
`bankTiles[bank][index]`. Out of range is the blank tile, matching what
`tilePixels` already does for a reference past the end of the bank.

## Maps

A map cell stores the **hardware byte** — bank-relative, 0–255 — and the bank
comes from the row: `bank = row >> 3`. The layer data *is* the name table, so
export stays a copy and `_DrawLayer` is untouched.

**A banked tileset requires a map exactly 24 rows tall.** Any width: banks are
chosen by row, so horizontal scrolling is unaffected and a 128×24 playfield is
fine. Vertical scrolling is not — row 24 has no bank. The map editor states the
pairing when a banked tileset is selected, and `validateMap` refuses the
combination rather than exporting art that lands in the wrong third.

Consequence the editor must show honestly: the same byte renders as different art
in different thirds, so the tile picker and the grid render **per row**, and
copying a region across a third boundary changes its appearance. That is true of
the hardware; the editor's job is to not hide it.

## Meta-tiles

Meta-tiles allocate from the **shared** region, so a meta's tile index means one
picture anywhere on screen.

This is what keeps the emitted C unchanged. A live placement is drawn at runtime
by `_DrawPlacements`, which writes name-table bytes without knowing the
destination row's bank; because a shared index resolves identically in all three
banks, it does not need to. **`metaHelperC`, `placementHelperC` and
`MapDoc.metas` are untouched by this feature** — no per-bank tables, no bank
selection, no change to a code path CLAUDE.md requires be verified by booting a
ROM.

The cost is bank space: a shared tile occupies its slot in all three banks, so a
6-tile meta costs 6 of the 256 in every bank rather than 6 of 768. That is the
right trade — it buys animated, movable metas on a banked screen for no runtime
complexity at all — but it must be *visible*, which is what the budget readout
below is for.

`meta-paint.ts`'s copy-on-write find-or-create allocates from the shared end.
Its existing guarantees hold unchanged: append-only, so no existing index moves;
dedup is the "find" half; a stroke that cannot allocate refuses whole.

## Export

Data tables gain per-bank sections; the shared set is emitted once and loaded
three times.

```c
#define G_TITLE_SHARED       48      // shared tiles, at indices 208..255
#define G_TITLE_BANK0_TILES  180
#define G_TITLE_BANK1_TILES  204
#define G_TITLE_BANK2_TILES  160

extern const u8 g_Title_Patterns[];        // shared, 48 tiles
extern const u8 g_Title_Bank0_Patterns[];  // bank 0's own, from index 0
// …Bank1, Bank2, and the matching _Colors for each…

// opt-in helper
void g_Title_Load(void);
```

`_Load` is six `VDP_LoadBankPattern_GM2` / `VDP_LoadBankColor_GM2` calls per bank
— MSXgl already provides both, taking `(src, count, bank, offset)`, so nothing is
reimplemented. The shared set loads at offset `256 - SHARED` in each of the three
banks; each bank's uniques load at offset 0.

An unbanked tileset emits exactly what it emits today, including the single
`VDP_LoadPattern_GM2` form. The banked tables appear only when `bankTiles` is
non-empty.

## The importer

Converting an image into a banked tileset fills the **unique** region of each
bank, 256 per third, from index 0 up — which is what makes a full-screen picture
fit. Shared tiles are never touched, so importing into a tileset that already
backs meta-tiles does not destroy them.

The bank budget is per third, so the honest failure is per third too: "bank 1 is
full — 34 cells in rows 8–15 could not be placed", not one number for the whole
screen. Two fixes shipped on 2026-09-03 exist because this kind of message was
written to a place nobody looks; this one goes in the dialog's own result area,
where the user is already looking after pressing the button.

## Editor UI

- **Tile editor.** One grid with a bank selector (Bank 1 / 2 / 3) showing that
  bank's uniques from index 0, with the shared tiles pinned at the end of the
  same grid and marked as shared. The grid therefore shows exactly what the
  hardware shows for that third — the same thing the map editor renders — rather
  than a fourth abstract view the user has to reconcile.
- **Budget readout**, per bank: `bank 1: 180 + 48 shared = 228 / 256`. The
  meta-tile editor's existing `tiles: N/256` line becomes bank-aware for the same
  reason it exists: on this hardware that number decides whether the next stroke
  is possible.
- `reserveTile0` reserves index 0 **in every bank**, since each bank has its own
  index 0 and a map cell holding 0 must be blank whichever third it is in.

## Testing

| File | Covers |
|---|---|
| `src/shared/msx/tile.test.ts` | `bankTileAt` resolution at both ends and out of range; the per-bank `Uᵢ + S ≤ 256` constraint; that appending at either end moves no existing index; that a file without `bankTiles` normalizes to today's behaviour byte for byte |
| `src/shared/msx/map.test.ts` | `bank = row >> 3`; `validateMap` refusing a banked tileset on a map that is not 24 rows tall |
| `src/shared/msx/meta-paint.test.ts` | allocation from the shared end; refusal when shared would collide with the fullest bank |
| `src/shared/msx/resource.test.ts` | the per-bank tables, the `_SHARED`/`_BANKn_TILES` defines, and that an unbanked tileset's output is unchanged |
| `src/main/services/meta-build.test.ts` | a banked title screen compiled against real MSXgl and **booted under openMSX**, screenshotting all three thirds — the only check that catches a wrong bank offset, which compiles perfectly and draws garbage |

The ROM boot is not optional here. A bank offset error is invisible to every
other test: the data is right, the tables are right, and the picture is wrong.

## Deliverables beyond the code

- `src/main/services/agent-guide.ts` — banked tilesets, the `_Load` helper, and
  the 24-row map rule. Per CLAUDE.md the guide is a deliverable, and this changes
  what the exporter emits and how a resource is used from C.
- `specs/10-map-screen-editors.md` — the bank selector and the map-height rule.
- `CHANGELOG.md`.

## Out of scope

- **SCREEN 1.** One pattern table of 256, no banks.
- **The MSX2 fourth bank** reachable by vertical scrolling, which
  `VDP_LoadBankPattern_GM2` mentions. Three banks is the whole screen; the fourth
  is a scrolling technique and belongs with vertical scrolling, if ever.
- **GRAPHIC 3 mirror modes** (`VDP_MODE_GRAPHIC3_MIRROR_*`), which replicate
  banks in patterns like `0 1 0 1`. Interesting, and orthogonal to this.
- Vertical scrolling with a banked tileset. Ruled out above, deliberately.

## Assumptions

Stated so a review catches them if any is wrong.

1. Bank *n* serves screen rows `8n … 8n+7`, and a name-table byte indexes within
   that bank. Confirmed against MSXgl's `VDP_LoadBankPattern_GM2`, which computes
   `g_ScreenPatternLow + (bank * 0x800) + (offset * 8)`.
2. SCREEN 4 (GRAPHIC 3) has SCREEN 2's table layout — MSXgl describes it as
   "GRAPHIC 2 which can use sprite mode 2".
3. Both the pattern table and the colour table are banked, so a bank is 256 whole
   tiles rather than 256 patterns sharing one colour table.
4. No existing project in this repository or its demos uses a banked tileset,
   because none can — so there is no migration to write and no file to convert.
