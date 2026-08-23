# Meta-tiles: designs bigger than a cell

The VDP's unit is an 8×8 cell. Almost nothing in a game is 8×8. A tree is
2×3 cells, a door is 2×3, a coin is 1×1 but has four poses, and every one of
them is something you think about as *one thing* while the hardware insists on
seeing twelve.

A **meta-tile** is that one thing, kept as a resource: its own size in tiles,
its own animation frames, its own gameplay flags. You paint it as a picture, and
you drop it on a map next to the tiles you painted by hand.

**MSXDEVStudio resources:** a `.meta-tiles.json` over a `.tiles.json`, and a
`.map.json` that places it · **Machine:** MSX1 and up (SCREEN 1, 2 or 4)

## A meta-tile owns no pixels

This is the part worth understanding before you draw anything, because it
explains everything else.

A meta-tile stores **tile indices**, not art — the same way a tileset's named
blocks do. The editor shows you a canvas and lets you draw on it, and every
stroke is resolved, immediately, into tiles:

1. Work out which 8×8 cell the pixel landed in.
2. Take that cell's current tile, apply the stroke to a copy of it.
3. Look for a tile in the bank that already looks exactly like that. If one
   exists, point the cell at it. If not, append it and point the cell there.

Three things follow, and they are the whole design:

- **Painting a meta grows the tileset.** That is not a side effect, it is the
  mechanism. Open the tile editor after drawing and you will see the tiles your
  strokes created.
- **Painting a meta can never damage a map.** Existing tiles are never edited in
  place and never renumbered, so a map drawn with tile 12 still has tile 12.
- **Identical cells cost one tile.** Draw a brick in two cells of the same meta
  and the bank grows by one, not two. Draw the same brick in a second meta
  tomorrow and it grows by nothing.

## Tile 0 is the hole

A name table has no transparency. Every cell holds a tile index and the VDP
draws it; there is no value meaning "nothing here". The only way to see through
a cell is for the game **not to write it**.

So meta-tiles reserve tile 0 for that. A tileset opts in — side panel →
**Reserve tile 0** — and after that:

- tile 0 is locked blank and drawn as a checkerboard, in the tile editor and in
  the meta editor both;
- a meta cell holding 0 is skipped when the meta is stamped, so the background
  shows through;
- the eraser is simply "paint colour 0": erase a whole cell and it resolves back
  to tile 0 through the same dedup as everything else.

If the tileset already uses tile 0 as artwork — a solid block, say — reserving
it has to shift every index up by one, and every map drawn with that tileset is
renumbered to match. The editor tells you and asks first. Reserving it on a
tileset you have just created is free, and new tilesets do it automatically.

## Drawing one

Create a `meta-tiles` resource from the Resources panel, point it at a tileset,
and set its size — 2×3 for a tree, say.

The tools are the tile editor's, plus one: **pencil**, **line**, **rectangle**,
**fill** and **spray**. Spray is an ordered dither rather than random scatter,
keyed to the canvas coordinates, so overlapping passes agree about the pixels
they share and a slow drag builds one clean texture instead of mottle. Its
density slider is the threshold.

**Erase** is the button beside them, and it is a *colour*, not a sixth tool — it
selects the transparent index. So it composes: erase with the pencil, erase a
straight line, erase with a spray of holes.

Fill crosses tile seams. You drew one shape, not four.

### Two colours per row, and which button picks which

SCREEN 2 and 4 hold two colours per 8×1 pixel row — an ink and a paper. SCREEN 1
holds two per *group of eight tiles*. That is the whole constraint, and the
mouse button is how you say which one you are setting:

- **Left button** paints with the current colour as that row's **ink**.
- **Right button** paints it as the row's **paper**.

Either one *recolours the row* — every pixel of that row already wearing that
role changes with it. That is not the editor being destructive; it is what a
two-colour row means. Pick a third colour and it replaces the ink (or the
paper), rather than being refused.

In SCREEN 1 the palette only offers the two colours the clicked cell's group
already spends, since a group of eight tiles shares one pair. To use a third,
change the pair explicitly in the side panel — it recolours all eight tiles, and
the editor says so before it does it.

### Frames

The strip along the bottom is the animation. **Duplicate** copies the current
frame, which is usually what you want — a walk cycle starts from a pose, not
from a blank canvas. **Onion skin** shows the previous frame underneath, faint,
so the next one can be lined up against it.

There is no per-frame duration. Timing is the game's decision, exactly as it is
for hardware sprites.

### What reaches the tileset, and when

A stroke is resolved **once, when you let go of the button** — not per pointer
sample. A drag that passed through forty intermediate shapes contributes only
the tiles its final shape needs, and counts as one undo step.

Redrawing still leaves tiles behind: paint a cell three different ways and the
first two versions are in the bank, referenced by nothing. **Saving reclaims
them automatically**, and the status bar says how many went. There is a
**Compact unused tiles** button in the side panel for doing it sooner.

Either way, only tiles *this editing session* created and no longer uses are
removed. That looks over-cautious until you consider the alternative: a tile
used solely by a map you do not happen to have open is indistinguishable, from
here, from an orphan, and removing it would silently change a level you were not
even looking at.

## Placing one on a map

Open a map over the same tileset. The left sidebar is now two pickers: **tiles
above, meta-tiles below**. Only metas drawn over *this* map's tileset appear —
one built over a different bank names tiles that mean something else here, and
placing it would paint garbage.

Pick one and click. Click a placed meta to select it, drag to move it, Delete to
remove it.

### Live or baked

Every placement is one of two things, and the difference is where the tiles are.

**Live** is the default. The grid under the meta holds tile 0, and the game
draws the meta from the placement table every time it draws the screen. It costs
a few writes per screen, it updates when you edit the meta, and it is the only
kind that can animate.

**Baked** — tick *Bake into the layer* — writes frame 0's tiles into the grid.
The ordinary layer write then draws it, so it costs **nothing** at runtime. It
cannot animate, and painting a tile inside it drops its record: the grid no
longer holds what the record claims, and a receipt that lies is worse than no
receipt.

Rule of thumb: bake the scenery, leave the things that move alone.

## Using it from C

A meta-tile exports one table, its frames end to end:

```c
#define G_TREE_META_W 2
#define G_TREE_META_H 3
#define G_TREE_CELLS  6      // tiles per frame — the table's stride
#define G_TREE_FRAMES 4
#define G_TREE_FLAGS  0x01   // your bits, your meaning
extern const u8 g_Tree[];

g_Tree_Draw(10, 5, 0);       // frame 0 at tile column 10, row 5
```

`_Draw` writes each row as runs of non-transparent cells rather than one
rectangle, because a cell holding tile 0 has to be skipped. For a solid meta
that is still one `VDP_WriteLayout_GM2` per row.

A map that places meta-tiles exports the placement table beside its layers:

```c
#define G_LEVEL_METAS        2
#define G_LEVEL_PLACEMENTS   12
#define G_LEVEL_META_G_TREE  0      // a name per meta
#define G_LEVEL_FLAGS_G_TREE 0x01   // mirrored, so you need no other header
extern const u8 g_Level_Placements[];   // slot | baked<<7, x, y

u8 frames[G_LEVEL_METAS] = { 0 };
g_Level_DrawLayer(g_Level_Background, 0, 0);   // the grid, one call
g_Level_DrawPlacements(frames);                // the live metas over it
```

To animate, advance `frames[slot]` and call `_DrawPlacements` again. Pace it
yourself — hold each pose for several frames from a counter in the VBlank loop,
rather than rewriting VRAM at 50/60 Hz:

```c
if(++tick >= 8)
{
	tick = 0;
	frames[G_LEVEL_META_G_COIN] = (frames[G_LEVEL_META_G_COIN] + 1) % G_COIN_FRAMES;
	g_Level_DrawPlacements(frames);
}
```

Baked placements are skipped by `_DrawPlacements`, so a level full of baked
scenery and three animated coins pays for three.

### Collision

Two independent sets of flags, and neither overrides the other:

- The **tileset's** `_Flags`, indexed by tile, for anything in the grid. This is
  what a walking character tests. Baked meta-tiles are in the grid, so their
  tiles answer here like any others.
- A **meta's** `_FLAGS`, for asking what the *object* is — is this one a door,
  is it a hazard — while walking the placement table. Mirrored into the map's
  own header so you do not need to include every meta's.

## Bitmap and multicolour modes

Everything above applies to a `.meta-btiles.json` over a `.btiles.json` — same
editor, same frames, same placement — with three differences the hardware
forces.

**Nothing gets dropped.** Every pixel in a bitmap mode carries its own colour,
so there is no two-per-row rule and no status-bar count. Draw what you like.

**A cell is whatever the tileset says.** A bitmap tile is 16×16, or 8×8, or
32×16. The canvas grid and the seams follow it rather than a fixed 8.

**Two kinds of see-through, and they compose.** A cell holding tile 0 is not
blitted at all, exactly as in pattern modes. On top of that, if the tileset
nominates **colour 0** as its transparent index, the emitted blit uses the
VDP's own transparency (`LMMM` with `VDP_OP_TIMP`) and the colour-0 pixels
inside a cell show the background too — so a tree can have a real outline
instead of a square one.

Only colour 0. `VDP_OP_TIMP` is hardwired to it on the V9938; a tileset that
nominates any other index gets an opaque `HMMM` and a header comment saying
why. The side panel tells you which you are getting.

### SCREEN 3

Multicolour splits, because an MSX1 has no command engine.

- A **2×2** SCREEN 3 tileset makes its map a name-table map — the VDP draws it,
  exactly as in SCREEN 1/2 — so meta-tiles place there and work unchanged.
- **Any other SCREEN 3 tile size** blits into a shadow buffer, and there is no
  blitter. Placing meta-tiles on such a map is refused in the Problems panel
  rather than exported as `VDP_CommandHMMM` that links and does nothing.

Whole-cell transparency still works on SCREEN 3; per-pixel does not, for the
same reason.

---

Next: [SCREEN 3, chunky graphics](10-screen3-chunky.md) · Back: [Tiles and maps](03-tiles-and-maps.md)
