# Spec 16 — Worlds, Entities, Slicing

**Phase:** 5 · **Depends on:** 07, 10

## Goal

The pieces a flip-screen game — a Zelda-style overworld with dungeons, a
metroidvania — needs on top of Spec 10's maps: **what a level contains**
(entities), **how rooms connect** (a world), and a way to **design one big map
and ship it as rooms** (slicing).

Why rooms rather than one big map: on a 16 KB MSX1 an 8×8-screen map is 49 KB
of name table and cannot be unpacked to draw a piece of it; a banked SCREEN 2
tileset only works 24 rows tall (Spec 10). A room is a map of its own: it
unpacks on its own, gets all three banks to itself, and packs into ROM on its
own.

## A. Entities (`MapDoc.entities`, `shared/msx/map-entity.ts`)

```jsonc
"entities": [ { "type": "chest", "x": 4, "y": 9, "param": 3 } ]
```

- A typed marker on one cell. `type` is a C-identifier name (cleaned on the way
  in), `param` one byte the game interprets. Not art — never drawn by the VDP.
- **Absent when empty**, so every pre-existing map round-trips unchanged and
  exports exactly what it did.
- Names, not numbers, in the file: numbers are assigned at export. A map's own
  export numbers its types in sorted order from 1 (`_ENT_<TYPE>`); a world
  numbers them from its declared list. 0 is left for the game's "nothing".
- Export: `_Entities` (type, x, y, param — 4 bytes each), `_ENTITIES`,
  `_ENTITY_BYTES`. Coordinates are bytes: an entity past 255 fails validation.
- Off-grid entities are dropped on load and on resize, as placements are.
- Map editor: an `entity` `MapTool` (flag icon). Click drops one with the side
  panel's type/param, click on one selects it, drag moves it, Delete removes
  it. Markers are drawn over everything, dimmed when another tool is live.

## B. Worlds (`*.world.json`, `shared/msx/world.ts`)

```jsonc
{
  "version": 1,
  "cols": 8, "rows": 8,
  "cells": ["res/over_r0_c0.map.json", null, …],   // cols*rows, row-major; null = wall
  "entityTypes": ["chest", "bat"],                 // ids 1, 2 — append-only in the editor
  "doors": [ { "room": 9, "x": 5, "y": 10, "to": 40, "toX": 16, "toY": 20 } ],  // grid cells
  "export": { … }
}
```

- **A room is an ordinary map that draws itself**, through its own export:
  its layers, live and animated meta-tiles, banked tileset, compression. Rooms
  need not share a size. The world is navigation only and never restricts what
  a room contains. A project may hold any number of worlds.
- **Room ids** count non-empty cells in reading order (`roomIds`); `0xFF` is
  "none" everywhere, so 255 rooms fit.
- **Neighbours are implicit**: the room in the adjacent cell, N/E/S/W. Regions
  separated by an empty cell are not connected. **Doors** cover the rest; they
  reference grid cells and export room ids. Emptying a cell drops its doors;
  moving a room moves them.
- `shared/` cannot open files, so everything takes `LoadedRoom`s
  (`{ doc, banked, tileset }`, the tileset as a `LoadedTileset`: export name,
  header, helpers, mode, count, banked, animated — `loadedTileset`).
  `ResourceDoc` gains `{ kind: 'world'; doc; rooms? }`, filled by
  `loadWorldRooms` in `main/services/resources.ts` (reorder log replayed per
  room) and by the world editor's session. The loaded rooms are never serialised.
- **Validation** (`validateWorld`, used by both the build and the editor's
  problems list): rooms readable; at most 255 tiles a side; entity types
  declared; doors in and to rooms, each coordinate inside *its own* room.
- **Export** (`worldTables`): `_Grid`, `_Neighbours`, `_RoomSize`,
  `_RoomTileset`, `_EntityOffsets` + `_Entities` (count-prefixed, world ids),
  `_Doors` (only with doors). No tile data. Defines: `_NONE`, directions, a
  `_ROOM_<FILE>` per map, a `_TILESET_<FILE>` per tileset, `_ENT_<TYPE>`,
  `_BUFFER_BYTES`.
- **Ready-made C** (`worldHelperC`): lookups (`_RoomAt`, `_Neighbour`,
  `_RoomW`/`_RoomH`, `_TilesetOf`, `_RoomEntities`, `_DoorAt`) and dispatchers
  to the rooms' and tilesets' **own** exported helpers, `#include`d relative
  to the world's header (`includePath`):
  - `_LoadTileset(id)` — a banked tileset's `_Load()`, else
    `VDP_LoadPattern_GM2`/`VDP_LoadColor_GM2`; then `_AnimReset()` if it animates.
  - `_Animate(id)` — the tileset's `_Animate()`; emitted when one animates.
  - `_DrawRoom(room, buffer)` — the room's `_DrawLayer` (first tile layer,
    unpacking into `buffer` when packed) and `_DrawPlacements`, at 0,0, through
    one static function per map (SDCC miscompiles constant arguments inlined
    into `case 0:`). Returns FALSE for a room it cannot draw in one call
    (`roomDraw`: no C export, no ready-made C, bitmap mode, bigger than 32×24,
    an indexed layer); the editor lists those (`worldNotices`).
  Verified by `world-build.test.ts` against real MSXgl, and by booting the ROMs
  in openMSX: a live torch in the name table with its flame's pattern changing,
  a packed 22-row room, a banked room with each bank's own colour.
- **Dependencies**: a world is stale when any room or any room's tileset is newer
  than its header (`exportDependencies`).
- Editor (`editors/world`): the grid with room thumbnails (fitted, sizes shown)
  and connection bars; click selects, double-click opens the room or makes a
  new one-screen room (a neighbour's tileset, its own export with helpers) and
  opens it; drag swaps; a **library** of every project map with previews, drag
  onto a cell or click into the selected one; **Import map files…** copies
  `.map.json` files into `res/` (renamed past existing names, export renamed
  after the new file); side panel for doors, grid size, entity types, *Left to
  your code*, problems, export. Re-reads rooms on `fs:changed` for a room or
  its tileset, and the library's previews for any other map.

## C. Slice into rooms (`sliceMap`, map editor toolbar)

- Cuts a map into `roomWidth × roomHeight` rooms (default one screen); the last
  column and row are as big as what is left. Each room keeps the tileset, cell
  geometry, layers and meta table; a placement goes to the room its corner is
  in, and one that would cross a room edge is dropped with a warning; entities
  go to the room they stand in. Each room gets its own export (ready-made C on,
  the source's compression).
- Writes `res/<map>_r<row>_c<col>.map.json` (with the source's
  `tilesetReorderSeen`) and `res/<map>.world.json` (declaring the map's entity
  types), refuses if any target exists, optionally skips empty rooms, opens
  the world. The source map is not modified.
