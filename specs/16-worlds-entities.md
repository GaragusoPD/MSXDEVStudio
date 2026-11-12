# Spec 16 — Worlds, Entities, Slicing

**Phase:** 5 · **Depends on:** 07, 10

## Goal

The pieces a flip-screen game — a Zelda-style overworld with dungeons, a
metroidvania — needs on top of Spec 10's maps: **what a level contains**
(entities), **how rooms connect** (a world), and a way to **design one big map
and ship it as rooms** (slicing).

Why rooms rather than one big map: on a 16 KB MSX1 an 8×8-screen map is 49 KB
of name table and cannot be unpacked to draw a piece of it; a banked SCREEN 2
tileset only works 24 rows tall (Spec 10). A room unpacks into 768 bytes, gets
all three banks to itself, and packs into ROM on its own.

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
  "roomWidth": 32, "roomHeight": 22, "top": 2,   // rooms drawn from row 2: a HUD above
  "layer": "",                                     // which layer is the name table; "" = first
  "cells": ["res/over_r0_c0.map.json", null, …],   // cols*rows, row-major; null = wall
  "entityTypes": ["chest", "bat"],                 // ids 1, 2 — append-only in the editor
  "doors": [ { "room": 9, "x": 5, "y": 10, "to": 40, "toX": 16, "toY": 20 } ],  // grid cells
  "export": { … }
}
```

- **Room ids** count non-empty cells in reading order (`roomIds`); `0xFF` is
  "none" everywhere, so 255 rooms fit.
- **Neighbours are implicit**: the room in the adjacent cell, N/E/S/W. Regions
  separated by an empty cell are not connected — an overworld and its dungeons
  share a grid. **Doors** cover the rest; they reference grid cells and export
  room ids. Emptying a cell drops its doors; moving a room moves them.
- `shared/` cannot open files, so everything takes `LoadedRoom`s
  (`{ doc, banked }`): `ResourceDoc` gains `{ kind: 'world'; doc; rooms? }`,
  filled by `loadWorldRooms` in `main/services/resources.ts` (reorder log
  replayed per room, banked read from its tileset) and by the world editor's
  session. The loaded rooms are never serialised.
- **Validation** (`validateWorld`, used by both the build and the editor's
  problems list): rooms readable and exactly `roomWidth × roomHeight`;
  name-table maps only (pattern modes, or SCREEN 3 over 2×2 tiles); the chosen
  layer exists, is not indexed, and has no live (unbaked) placements; a banked
  room only with `top` 0 and 24 rows; `top + roomHeight ≤ 24`; every entity
  type declared; doors in and to rooms, inside the room size.
- **Export** embeds the rooms (`worldExport`, the single compression decision —
  all rooms pack or none, since one `_DrawRoom` serves all):
  `_Grid`, `_Neighbours`, `_RoomTileset`, `_RoomOffsets` + `_Rooms`,
  `_EntityOffsets` + `_Entities` (count-prefixed per room), `_Doors` (only with
  doors). A map in several cells is stored once. Offsets are 16-bit; more data
  than that fails the export. Defines: geometry, `_NONE`, directions, a
  `_ROOM_<FILE>` per map, a `_TILESET_<FILE>` per tileset, `_ENT_<TYPE>` per
  type, `_COMPRESSED` when packed.
- **Ready-made C** (`worldHelperC`): `_RoomAt`, `_Neighbour`, `_TilesetOf`,
  `_RoomData`, `_RoomEntities`, `_DoorAt`, `_DrawRoom` (`RLEp_UnpackToRAM` into a
  caller buffer when packed, then `VDP_WriteLayout_GM2` at row `_TOP`). It never
  loads a tileset. Verified by `world-build.test.ts` against real MSXgl, and by
  booting the ROM in openMSX and reading the name table back.
- **Dependencies**: a world is stale when any room or any room's tileset is newer
  than its header (`exportDependencies`).
- Editor (`editors/world`): the grid with room thumbnails and connection bars;
  click selects, double-click opens the room or makes a new one (world's room
  size, a neighbour's tileset, no export block), drag swaps; side panel for
  doors, grid/room geometry, entity types (with "add the types the rooms use"),
  problems, export. Re-reads rooms on `fs:changed` for a room or its tileset.

## C. Slice into rooms (`sliceMap`, map editor toolbar)

- Cuts a map into `roomWidth × roomHeight` rooms (default one screen), padding
  the edge rooms with tile 0. Each room keeps the tileset, cell geometry and
  meta table; a placement goes to the room its corner is in, and one that
  would cross a room edge is dropped with a warning; entities go to the room
  they stand in. No room gets an export block.
- Writes `res/<map>_r<row>_c<col>.map.json` (with the source's
  `tilesetReorderSeen`) and `res/<map>.world.json` (declaring the map's entity
  types), refuses if any target exists, optionally skips empty rooms, opens
  the world. The source map is not modified.
