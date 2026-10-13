# Meta-tiles: designs bigger than a cell

The VDP's unit is an 8×8 cell. Almost nothing in a game is 8×8. A tree is
2×3 cells, a door is 2×3, a torch is 2×3 with a flame that flickers, and every
one of them is something you think about as *one thing* while the hardware
insists on seeing six.

A **meta-tile** is that one thing, kept as a resource: its own art, its own
poses, the cells it leaves see-through, its own gameplay flags. You draw it once,
attach it to the tilesets that should have it, and build levels out of it —
dropped next to tiles you painted by hand, or as whole layers made of nothing
else, at one byte per meta-tile.

**MSXDEVStudio resources:** a `.meta-tiles.json`, a `.tiles.json` it is attached
to, and a `.map.json` that places it · **Machine:** MSX1 and up (SCREEN 1, 2 or 4)

## A meta-tile owns its pixels, and is attached to tilesets

A meta-tile stores its art — every pose, as tile bytes — in its own file, and
names no tileset. That is what makes it an independent thing: the same tree can
be used with the level's tileset and the title screen's, and editing it is
editing one file.

A name table cannot show art, only tile numbers. So a meta-tile is **attached**
to a tileset, and attaching gives it numbers there:

- A cell that looks the same in every pose becomes an ordinary tile — and if the
  tileset already has a tile that looks exactly like it, that one, so two metas
  with the same brick cost one tile.
- A **see-through** cell gets nothing: it is never written when the meta is
  drawn (below).
- The cells that **change between poses** get a *window*: a few consecutive tiles
  the tileset's `_Animate()` rewrites with each pose in turn, exactly as an
  attached animation's (see *Animated tiles* in [Resources](../resources.md)). Every copy of the meta
  animates in step, on screen or not, and costs nothing per copy — and only the
  cells that move are rewritten, so a house with a smoking chimney rewrites the
  chimney, not the house.

Edit the meta later and every tileset it is attached to follows: tiles that
still show the right art are kept, what changed is added, and nothing else drawn
with the tileset moves.

## See-through cells

A name table has no transparency. Every cell holds a tile number and the VDP
draws it; there is no value meaning "nothing here". The only way to see through
a cell is for the game **not to write it**.

So a meta-tile marks the cells it should not write. In the editor, the hatched
**see-through** button turns clicks into toggles: click a cell and it is drawn
hatched, and from then on it is skipped in every pose — whatever is already on
screen, or on the layer underneath, shows there. The cell's art stays in the
file, so toggling it back loses nothing.

## Drawing one

Create a `meta-tiles` resource from the Resources panel in the mode your tileset
uses — SCREEN 2 and 4 store the same bytes, so either attaches to either — and
set its size in the side panel: 2×3 for a tree, say, up to 16×16.

The tools are the tile editor's: **pencil**, **line**, **rectangle** and
**fill**. Fill crosses tile seams; you drew one shape, not six.

### Two colours per row, and which button picks which

SCREEN 2 and 4 hold two colours per 8×1 pixel row — an ink and a paper. That is
the whole constraint, and the mouse button is how you say which one you are
setting:

- **Left button** paints with the current colour as that row's **ink**.
- **Right button** paints it as the row's **paper**.

Either one *recolours the row* — every pixel of that row already wearing that
role changes with it. That is not the editor being destructive; it is what a
two-colour row means. Pick a third colour and it replaces the ink (or the
paper), rather than being refused.

SCREEN 1 holds one pair per group of eight tiles, so a SCREEN 1 meta is drawn in
one pair, chosen in the side panel; attaching it puts its tiles in a group of
that pair.

### Poses

The strip along the bottom is the animation. **Duplicate** copies the current
pose, which is usually what you want — a flicker starts from a flame, not from a
blank canvas. Each pose has its own duration in frames (VBlanks: 50 a second on
a European MSX, 60 on a Japanese one), and the side panel picks **loop**,
**ping-pong** or **play once**, with a preview that steps exactly as the
generated code will.

The side panel also says what animating costs: how many tiles change between
poses — the size of the window each tileset gives the meta — and how many bytes
of VRAM one pose change writes.

### Flags

Eight squares in the side panel: what the meta *means* to your game — solid, a
door, a hazard — independent of the flags on the tiles it is drawn with.

## Attaching it

Two ways, and they do the same thing:

- In the **tile editor**, the side panel's *Meta-tiles* section: pick the meta,
  press **Attach**. The status line says which tiles move, if any.
- On a **map**, just place it (below): a meta that is not attached to the map's
  tileset yet is attached when you pick it.

Detaching leaves its tiles in the tileset as ordinary art, so nothing already
drawn with them changes.

## Placing one on a map

Open a map. The left sidebar is two pickers: **tiles above, meta-tiles below**.
Every meta-tile in the tileset's mode is offered; a dashed one is not attached
yet, and picking it attaches it.

Pick one and click. Click a placed meta to select it, drag to move it, Delete to
remove it.

### Live or baked

Every placement on an ordinary layer is one of two things, and the difference is
where the tiles are.

**Live** is the default. The grid under the meta holds tile 0, and the game
draws the meta from the placement table every time it draws the screen.

**Baked** — tick *Bake into the layer* — writes the meta's tiles into the grid.
The ordinary layer write then draws it, so it costs **nothing** at runtime.
Painting a tile inside it drops its record: the grid no longer holds what the
record claims.

An animated meta animates either way: its moving cells are window tiles, and it
is the tiles' *art* that `_Animate()` changes, not the grid.

## Indexed layers: a level made of meta-tiles

A level built from meta-tiles should not store every cell. Click a layer's
**tiles** label in the map's side panel and it becomes **indexed**: a layer of
meta-tiles and nothing else.

- Meta-tiles sit side by side, in any mix of sizes. They cannot overlap — put
  anything that overlaps on another layer.
- Painting tiles on an indexed layer is refused; its grid is not exported at all.
- It exports **one byte per meta-tile**. A screen of 2×2 blocks is 192 bytes
  instead of 768, and a long wall of 4×1 bricks is a quarter of that again. The
  side panel shows the count against what a tile layer would cost.

The game expands it once into a tile map in RAM, and from there it is any map:
drawn with the same layout write, read for collision, rewritten when something
is collected. That RAM is the price — the map's width × height in bytes — and
the side panel says it too.

## Using it from C

The tileset a meta is attached to exports where its tiles are, by name, and with
*Export ready-made C* ticked, draws it:

```c
#define G_TILES_METAS        3
#define G_TILES_META_TREE    0
#define G_TILES_META_TORCH   1

g_Tiles_DrawMeta(G_TILES_META_TORCH, 10, 5);   // top-left at column 10, row 5
```

An animated meta is played by the tileset's own animation player — reset once
the tiles are in VRAM, step it every frame — and has an index of its own there:

```c
g_Tiles_AnimReset();
while(1)
{
	Halt();
	g_Tiles_Animate();
	...
}
g_Tiles_AnimSetActive(G_TILES_ANIM_TORCH, FALSE);   // snuff that one torch type
```

A map that places meta-tiles on an ordinary layer exports the placement table
beside its layers:

```c
#define G_LEVEL_METAS        2
#define G_LEVEL_PLACEMENTS   12
#define G_LEVEL_META_G_TREE  0      // a name per meta
#define G_LEVEL_FLAGS_G_TREE 0x01   // mirrored, so you need no other header

u8 frames[G_LEVEL_METAS] = { 0 };
g_Level_DrawLayer(g_Level_Background, 0, 0);   // the grid, one call
g_Level_DrawPlacements(frames);                // the live metas over it
```

(`frames` is for older meta-tiles, whose frames are redrawn per copy; a meta
that owns its pixels animates in place and ignores it.)

An indexed layer is expanded first, over whatever is under it:

```c
u8 g_Map[G_LEVEL_W * G_LEVEL_H];       // RAM is not cleared at boot:
u8 g_Objects[G_LEVEL_W * G_LEVEL_H];   // fill both before expanding

for(u16 i = 0; i < G_LEVEL_W * G_LEVEL_H; ++i)
{
	g_Map[i] = g_Level_Background[i];   // the layer underneath
	g_Objects[i] = 0;
}
g_Level_Expand(g_Level_Terrain, g_Map, g_Objects);
VDP_WriteLayout_GM2(g_Map, 0, 0, G_LEVEL_W, G_LEVEL_H);
```

See-through and empty cells keep what was in `g_Map`, which is how layers
compose. For a map wider than the screen, draw the view a row at a time from the
buffer:

```c
for(u8 row = 0; row < 24; ++row)
	VDP_WriteVRAM(g_Map + row * G_LEVEL_W + scroll, g_ScreenLayoutLow + row * 32, g_ScreenLayoutHigh, 32);
```

A torch that scrolls into view is already animating: its tiles are the window's.

### Collision

Two independent sets of flags, and neither overrides the other:

- The **tileset's** `_Flags`, indexed by tile, for anything in the grid or the
  expanded map. This is what a walking character tests.
- A **meta's** flags, for asking what the *object* is. On an indexed layer,
  `g_Objects[i]` is the slot + 1 of the meta covering cell `i` (0 for none), and
  `g_Level_MetaInfo[(g_Objects[i] - 1) * 3 + 2]` is its flags. For placements,
  the map's own header mirrors them as `G_LEVEL_FLAGS_<NAME>`.

## Older meta-tiles, and bitmap ones

Before meta-tiles owned their pixels, one was made of a single tileset's tiles:
it stored tile numbers, and its editor resolved every stroke into that tileset
as you painted. Such a `.meta-tiles.json` still opens in that editor — with its
spray tool, onion skin and **Compact unused tiles** — and still exports exactly
what it did:

```c
#define G_TREE_META_W 2
#define G_TREE_META_H 3
#define G_TREE_CELLS  6      // tiles per frame — the table's stride
#define G_TREE_FRAMES 4
#define G_TREE_FLAGS  0x01
extern const u8 g_Tree[];

g_Tree_Draw(10, 5, 0);       // frame 0 at tile column 10, row 5
```

Its frames are redrawn per copy through `_DrawPlacements(frames)`, and its
see-through cells are the ones holding tile 0, which the tileset must reserve. It
cannot go on an indexed layer. **Make it independent**, in the banner above its
canvas, copies its art into the file and attaches it to the same tileset **at
the same tiles** — every map that placed it keeps drawing exactly what it drew.

### Bitmap and multicolour modes

A `.meta-btiles.json` over a `.btiles.json` is always this older kind — same
editor, same frames, same placement — with three differences the hardware forces.

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
