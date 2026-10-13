# Animated tiles as their own resource — design

**Date:** 2026-10-13
**Status:** proposed, awaiting approval. Nothing here is implemented.
**Scope:** a new resource kind, `*.anim-tiles.json`, that owns an animation's
poses and timing, and is *attached* to the things that show it — a tileset
first, then maps, then bitmap screens. Plus the generated C that plays it, and
the MSX1 demo moved onto it as the proof.

## Why

Pablo asked on 2026-10-13 for "more freedom to handle animated tiles … like
their own entities, that I can attach or remove from tilesets, screens and
maps."

Today there is no such thing as an animation in the project. There are two
half-mechanisms, and both bury the animation inside something else:

- **A tileset block used as a pose strip.** `demo_msx1` keeps its spinning coin
  as a 4×1 block `coin_spin` (tiles 32–35) and a hand-written `SpinCoins()`
  that copies the current pose's pattern over tile 6 every ten frames. The IDE
  knows nothing about it: the block is a convention, the timing lives in a
  `#define`, the pose tiles occupy four of the tileset's 256 slots although only
  one of them is ever on screen, and every game re-writes the same twenty lines
  of C — which is how the agent guide's version of those lines came to copy
  the pattern and forget the colours (fixed alongside this design).
- **Meta-tile frames.** An animated meta-tile is bound to one tileset by path
  and animates only where a map places it, by rewriting the name table per copy
  (`_DrawPlacements`).

What a separate resource buys:

- **Reuse.** Water, a torch, a coin: drawn once, attached to as many tilesets
  and maps as use it.
- **Choice per place.** A title screen can run its torches while a level drawn
  with the same tileset holds them still — by attaching, not by editing C.
- **Cheaper tilesets.** The poses live in ROM, in the animation's own table.
  The tileset holds *one* window of slots that shows the current pose, not
  every pose. The demo gets four slots back.
- **Generated runtime.** One `_Animate()` call per frame runs every attached
  animation at its own pace, writing VRAM only on the frames a pose changes.

## How animation reaches the screen, and what it costs

SCREEN 1/2/4 keep two lists in VRAM: the **pattern table** (the drawings) and
the **name table** (which drawing each of the 32×24 cells shows). An animation
changes one of them:

| | Rewrite the drawing (*swap*) | Re-point the cells (*per copy*) |
|---|---|---|
| Per step | 8 pattern bytes per cell of the window, ×3 banks in SCREEN 2/4 (24 B); +24 B when the poses differ in colour | 1 name-table byte per cell **per copy on screen**, plus a call per row run |
| Grows with copies | No — 1 coin or 500 cost the same | Yes |
| Off-screen copies | Animate for free | Must be redrawn when scrolled in |
| VRAM slots | One window | Every pose resident |
| Copies | All in step | Each its own phase; can stop individually |

A 50 Hz frame is ~71,600 T-states and an MSX1 VRAM byte costs ~30, so a 1×1
swap is about 1–2 % of one frame, and only on frames where a pose changes.
**Swap is the default.** Per-copy stays available for what must be independent
— and it already exists as animated meta-tiles.

In the bitmap modes (SCREEN 5+) neither applies: a cell is pixels, so a copy is
re-blitted (`HMMM`) by the command engine. On MSX2, palette cycling recolours
everything drawn in one index for two bytes.

## What this is not

- **Not a replacement for meta-tiles.** A meta is a *design* — a tree, a house —
  that may have frames. An animation is a *behaviour* on tile slots. A meta cell
  that points at an animated slot animates for free, because swap is global.
- **Not a change to any existing export.** A tileset with nothing attached
  exports byte-for-byte what it does today; `demo-exports.test.ts` keeps
  asserting that for `demo_msx2`.
- **Not a timeline editor.** Durations are per pose, in frames (VBlanks). The
  game decides when to call `_Animate()`, and can stop calling it.

## The resource: `*.anim-tiles.json`

The hyphen is load-bearing for the reason the meta suffixes have one:
`resourceKindOf` matches by `endsWith`, and `.anim-tiles.json` does not end in
`.tiles.json`.

```ts
interface TileAnimDoc {
  version: 1
  /** 'sc2' and 'sc4' share a byte format; 'sc1' carries no colours (see below). */
  mode: TileMode
  /** The window, in tiles. 1×1 for a coin, 2×2 for a torch. Capped at 16 cells. */
  width: number
  height: number
  /** frames[0] is the resting pose — what a static render shows. 1–255 frames. */
  frames: { tiles: TileEntry[]; duration: number }[]   // duration: 1–255 frames
  loop: 'loop' | 'pingpong' | 'once'
  export: ExportBlock | null
}
```

**It owns its pixels.** Unlike a meta, it does not reference a tileset: the
poses are `TileEntry`s inside the file, exactly the bytes a tileset stores. That
is what makes it attachable to any compatible tileset and detachable without
losing art.

**SCREEN 1:** a tile has no colours of its own — eight tiles share one byte — so
an sc1 animation stores patterns only, and is drawn and previewed in the pair of
the group its window lands in. Attaching checks that the window does not
straddle two groups with different pairs.

**The cap of 16 cells** keeps one step affordable: a 4×4 window is
16 × 16 B × 3 = 768 B, about a third of a frame. The editor shows the cost per
step as it is resized.

### Its own export

Data, always (it is a table, not helper C):

```c
#define G_COIN_W        1
#define G_COIN_H        1
#define G_COIN_CELLS    1
#define G_COIN_FRAMES   4
extern const u8 g_Coin_Patterns[];    // FRAMES × CELLS × 8, pose after pose
extern const u8 g_Coin_Colors[];      // same shape; absent for sc1
extern const u8 g_Coin_Durations[];   // FRAMES bytes
```

## Attaching

An attachment is a **binding** stored on the thing that shows the animation —
the same shape as a map listing the metas it places. The animation file never
learns where it is used; the targets do.

### To a tileset (phase 1)

```ts
// TilesDoc gains:
animations: TileAnimBinding[]

interface TileAnimBinding {
  path: string          // the .anim-tiles.json
  slot: number          // first tile of the window; the window is slot … slot+cells-1
  bank: number | null   // null: every bank (unbanked, or the shared region). 0-2: one bank's own art.
  // Mirrored from the animation, refreshed by the exporter (see "Mirrors"):
  name: string; width: number; height: number; frames: number; colorsVary: boolean; loop: …
}
```

- **The window is consecutive slots**, so a step is one `VDP_LoadPattern_GM2`
  with `count = cells`, not one per cell. Attaching also names a block over the
  window (the animation's name), so a 2×2 torch is one stamp in the map picker.
- **The window's static art is frame 0.** Maps, exports and editors that do not
  play animations show frame 0, so nothing renders garbage. The slots are
  *derived data*: the tile editor shows them locked with an "animated" badge and
  sends the user to the animation to edit them.
- **Detaching** leaves frame 0 in the slots as ordinary art and removes the
  block. Nothing is lost and no map changes.
- **Where:** default to the selected tiles in the tile editor; "Attach as new"
  appends a window at the end of the set.

### To a map (phase 2)

Two separate needs, kept separate:

1. **Scope.** `MapDoc.animations: string[]` names which of its tileset's
   animations run while this map is shown. The map's header gets its own
   `_Animate()` stepping only those; the rest hold at frame 0. A title screen
   lists its torches, a level does not.
2. **Per-copy instances.** For things that must animate independently. This
   **reuses animated meta-tiles** rather than adding a second placement system
   (see *Open questions*).

### To a bitmap screen (phase 3)

A `.screen.json` or a bitmap map has no pattern table, so an attachment is an
*instance*: the animation's poses are uploaded to a strip in spare VRAM and
each instance is an `HMMM` per step. Same resource, different runtime. MSX2
palette cycling is a separate, smaller kind and is not part of this design.

## The generated runtime (phase 1)

In the tileset's header, with *Export ready-made C* on:

```c
#define G_TILES_ANIMS          1
#define G_TILES_ANIM_COIN      0    // index for _AnimSetActive
#define G_TILES_ANIM_COIN_SLOT 6

void g_Tiles_AnimReset(void);                   // all to frame 0, timers cleared
void g_Tiles_Animate(void);                     // once per frame; VRAM only when a pose changes
void g_Tiles_AnimSetActive(u8 anim, bool on);   // hold one where it is
```

- **State is RAM, and RAM is not zeroed on a ROM target.** `_AnimReset()` must
  be called after the tileset is loaded, and the agent guide says so beside the
  existing "zero your `frames` array" rule. The helper also clamps a phase past
  `FRAMES` back to 0, as `_DrawPlacements` does.
- **What a step writes** is decided at export, per binding:
  - pattern bytes always; **colour bytes only when the poses' colours differ**
    (`colorsVary`). That is not just half the cost: a colour write mirrors into
    all three thirds, and the demo deliberately recolours the coin's top-third
    entry for its HUD — copying colours every step would undo that;
  - `VDP_LoadPattern_GM2`/`VDP_LoadColor_GM2` for `bank: null`;
    `VDP_LoadBankPattern_GM2`/`VDP_LoadBankColor_GM2` for a bank's own art;
  - SCREEN 1: one `VDP_WriteVRAM_16K` (MSX1) / `VDP_WriteVRAM` (MSX2) of the
    patterns into the single pattern table.
- **Emitted C calls MSXgl, never a reimplementation** — those four loaders are
  its own API.

## Mirrors and export order

`shared/` cannot open a second file, so a binding mirrors what the tileset's C
needs (symbol, size, frame count, `colorsVary`, loop) — and frame 0, which is
the window's art. Per the rule in CLAUDE.md, the mirror is refreshed by
`main/services/resources.ts` before every export, and by the tileset editor on
load, through **one** `animRefFrom` both use.

**The export skip has to learn about dependencies.** `exportResourceFile` skips
a resource whose file is older than its header, comparing only that one file.
A tileset whose header now depends on an animation would not be re-exported
when only the animation changed. `upToDate` must take the mtimes of the files a
resource mirrors. *The same gap exists today for maps and the metas they mirror*
— edit a meta's frame count, leave the map untouched, and the map's header
keeps the old count. Fixed together, since it is one change.

## How it meets the rest of the app

- **Reorder / delete in the tile editor** renumber a binding's `slot` through
  the existing remap seam (`applyTileMapping` grows a case). Deleting a tile
  inside a window asks, then detaches.
- **Remove unused / Recalculate** (`tile-compact.ts`) always keep a window,
  like a block — attached means wanted, even before any map uses it.
- **Banked promotion and rebuild** renumber every tile, so `repackBlocker`
  refuses while animations are attached, naming them. Re-attaching afterwards
  is one click.
- **`reserveTile0`'s shift** moves windows with everything else.
- **Software sprites reserve patterns 192–255** in pattern modes; a window there
  gets a validation warning, not a silent overlap.
- **Editors play animations.** The tile grid, map canvas and meta canvas run the
  attached animations with a toggle. That needs one shared clock in the
  renderer, and the existing sheet cache is keyed on document identity, so the
  playing pose is drawn over the cached sheet rather than invalidating it.

## Editors

- **Animation editor** (new tab): a frame strip with durations, a W×H canvas
  per frame painting through the same `paintPixel`/`applyStroke` path the tile
  editor uses (so the two-colours-per-row rule is the tile editor's own answer),
  loop mode, a preview, the cost-per-step readout, and **Attached to**: every
  tileset and map binding it, each with Detach.
- **Tile editor**: an *Animations* panel — attach, detach, jump to the
  animation — and the badge on window slots.
- **Map editor**: phase 2's scope checklist.
- **Resources panel / tile editor**: **Extract animation from block** turns a
  pose strip into an animation file, attaches it at the slot the map cells
  already use, and offers to delete the now-unused pose tiles. That is the
  migration path for every existing project, the demo included.

## Moving `demo_msx1` onto it

The demo is the acceptance test: it already animates the right way, by hand.

Today: block `coin_spin` = tiles 32–35, tile 6 is the coin cells point at,
`SpinCoins()` in `view.c` with `g_CoinPhase`/`g_CoinTick`, `COIN_POSES`/
`COIN_RATE 10` in `demo.h`.

1. **Extract** `coin_spin` → `res/coin.anim-tiles.json`: 1×1, four poses, ten
   frames each, loop. Attach to `tiles.tiles.json` at slot 6.
2. **Delete tiles 32–35 and the block.** The tileset goes from 68 tiles to 64;
   the maps renumber through the seam. **One trap:** `demo.h` hard-codes
   `T_TRANS 39`, which becomes 35. Rather than edit the literal, name it — a 1×1
   block `trans`, read as `g_Tiles_Blocks[G_TILES_TRANS_BASE]` — so the demo's
   own rule ("re-ordering the tileset is supposed to be safe") finally holds for
   that tile too. `T_COIN 6` and `T_DIGIT_0 16` sit below the gap.
3. **C:** delete `SpinCoins()`, `g_CoinPhase`, `g_CoinTick`, `COIN_POSES`,
   `COIN_RATE`. `InitGame()` calls `g_Tiles_AnimReset()` after loading the
   tiles; the main loop calls `g_Tiles_Animate()` where `SpinCoins()` was.
4. **The HUD coin must still be right.** All four poses share `0xB5`, so
   `colorsVary` is false and the step copies patterns only — the top-third
   recolouring in `InitGame()` survives. A test asserts that the demo's
   generated `_Animate()` contains no colour write.
5. **Docs:** the demo's `README.md`, `CLAUDE.md` and `AGENTS.md` (identical) move
   from "how `SpinCoins()` works" to "how the coin is attached", keeping the
   swap-vs-per-copy explanation.
6. **Verify on the real thing** (CLAUDE.md's procedure): build against MSXgl,
   boot in openMSX on C-BIOS, screenshot twice ~0.5 s apart — the coin must
   change pose and the HUD coin must keep its black paper. Same VRAM traffic as
   today (24 bytes per step), four tiles and ~40 lines of C fewer.

## Testing

- **`shared/msx/tile-anim.ts`** (pure): normalize/validate, `colorsVary`, the
  data tables, the helper C per mode and bank kind, binding remap on reorder,
  window validation (fits, not straddling sc1 groups, sprite-range warning).
- **Export path, rendered from files without opening an editor** (CLAUDE.md's
  "test the layer the failure happens in"): a tileset with a binding exports the
  mirrored frame 0 and `_Animate()`; touching only the animation re-exports the
  tileset (the mtime fix); an unbound tileset is byte-identical to today.
- **Sessions**: attach/detach, locked slots, Extract-from-block, the reorder and
  compaction interactions.
- **Real compile**: a `game-kit-build.test.ts`-style case builds a project that
  calls `_AnimReset`/`_Animate` against real MSXgl, once per write path
  (GM2 mirror, bank-own, sc1), and the demo ROM is booted in openMSX. Both need
  an MSXgl checkout, which the cloud container does not have.

## Deliverables beyond the code

- `agent-guide.ts`: the *Animated tiles* section leads with attach + `_Animate()`
  and keeps the manual pose-copy (now with its colours) as the fallback.
- `specs/08-tile-editor.md` (Animations panel), `specs/10-map-screen-editors.md`
  (phase 2), the resource list wherever kinds are enumerated, `CHANGELOG.md`.

## Phases

1. **Core** — the resource, its editor, tileset attachment, the export and
   mirror (with the dependency-mtime fix), `_Animate()`, Extract-from-block,
   the guide, and the demo migration.
2. **Maps** — scope lists and per-map `_Animate()`; per-copy via metas.
3. **Bitmap screens** — instance blits for `.screen.json` and bitmap maps.

## Open questions

1. **Per-copy animation:** reuse animated meta-tiles (recommended — they are
   already exactly that, with placements, frames and a runtime), or a second
   placement system specific to animations?
2. **"Screens"**: tiled screens (a tileset + a map, painted in the map editor)
   are covered by phases 1–2. Is phase 3, the bitmap `.screen.json`, wanted too?
3. **One `_Animate()` per tileset** (recommended: a game shows one tileset at a
   time), or a single project-wide `Anim_Update()`?
4. **The demo**: delete the four pose tiles and introduce the `trans` block as
   above (recommended), or keep the tileset numbering and only swap the C?
