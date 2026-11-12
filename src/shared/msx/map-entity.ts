/**
 * Entities on a map: the things a level *contains* rather than the art it is
 * drawn with — an enemy's spawn point, a chest, a key, a locked door, an NPC.
 *
 * An entity is a typed marker on one cell. It owns no pixels and the VDP never
 * sees it: the game reads the table and decides what each one becomes. That
 * is the difference from a meta-tile placement, which *is* art.
 *
 * The type is a **name**, not a number. A number means nothing in the editor,
 * and it would have to be renumbered by hand every time a type is added in the
 * middle; a name survives that. Numbers are assigned at export:
 *
 * - a map exports its own entities with ids local to that map (its types in
 *   sorted order, from 1), which is all a one-level game needs;
 * - a world (`world.ts`) assigns ids from its own declared list, the same for
 *   every room, which is what a game that walks between rooms needs.
 *
 * Ids start at 1 so that 0 stays free for the game to mean "nothing here".
 */

/** One marker. `x`/`y` are in tiles, on the map's own grid. */
export interface MapEntity {
  /** C-identifier-shaped type name — `chest`, `enemy_bat`. */
  type: string
  x: number
  y: number
  /** One byte the game interprets per type: which key, which enemy variant, how much gold. */
  param: number
}

/** Bytes per entity in every exported table: type, x, y, param. */
export const ENTITY_BYTES = 4

/** A byte is the id, and 0 is reserved, so this many types fit. */
export const MAX_ENTITY_TYPES = 255

/** A count byte heads each room's list in a world, so a map can hold this many. */
export const MAX_MAP_ENTITIES = 255

const TYPE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Whether `name` can be a type: it becomes the tail of a `#define`, so it has to be an identifier. */
export function isEntityTypeName(name: string): boolean {
  return TYPE_NAME.test(name)
}

/** What a typed-in name becomes: identifier characters only, never empty. */
export function cleanEntityTypeName(name: string): string {
  const cleaned = String(name ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!cleaned) return 'entity'
  return /^[0-9]/.test(cleaned) ? `e_${cleaned}` : cleaned
}

/**
 * Reads a map's `entities` key. Absent in every map written before entities
 * existed, which comes back as an empty list — and an empty list is not written
 * back (`normalizeMap`), so those files round-trip unchanged.
 *
 * An entity whose cell is off the grid is dropped, the rule placements follow:
 * it has nowhere to be, and keeping it would export a coordinate the game reads
 * as a real cell.
 */
export function normalizeEntities(raw: unknown, width: number, height: number): MapEntity[] {
  if (!Array.isArray(raw)) return []
  const out: MapEntity[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Partial<MapEntity>
    const x = Number(e.x) | 0
    const y = Number(e.y) | 0
    if (x < 0 || y < 0 || x >= width || y >= height) continue
    out.push({ type: cleanEntityTypeName(String(e.type ?? '')), x, y, param: (Number(e.param) || 0) & 0xff })
    if (out.length === MAX_MAP_ENTITIES) break
  }
  return out
}

/** The entity types a list uses, sorted — what a map's own export numbers from 1. */
export function entityTypesOf(entities: readonly MapEntity[]): string[] {
  return [...new Set(entities.map((entity) => entity.type))].sort()
}

/** The topmost entity on a cell (the last one added wins, as it is drawn last), or null. */
export function entityIndexAt(entities: readonly MapEntity[], x: number, y: number): number | null {
  for (let i = entities.length - 1; i >= 0; i--) {
    if (entities[i].x === x && entities[i].y === y) return i
  }
  return null
}

/**
 * The table: four bytes an entity — type id, x, y, param — in list order.
 * `ids` maps a type name to its id; a type it lacks is a caller's bug, and is
 * written as 0 rather than thrown, because validation is where that is reported.
 */
export function entityBytes(entities: readonly MapEntity[], ids: ReadonlyMap<string, number>): Uint8Array {
  const out = new Uint8Array(entities.length * ENTITY_BYTES)
  entities.forEach((entity, index) => {
    out.set([ids.get(entity.type) ?? 0, entity.x & 0xff, entity.y & 0xff, entity.param & 0xff], index * ENTITY_BYTES)
  })
  return out
}

/** Ids from 1, in the order given. */
export function entityIds(types: readonly string[]): Map<string, number> {
  return new Map(types.map((type, index) => [type, index + 1]))
}

/**
 * What stops a list from exporting. The coordinate check is for the world's
 * sake as much as the map's: a coordinate is one byte, and a scrolling map can
 * be wider than 255 tiles.
 */
export function entityProblems(entities: readonly MapEntity[], where = ''): string[] {
  const problems: string[] = []
  const prefix = where ? `${where}: ` : ''
  if (entities.length > MAX_MAP_ENTITIES) problems.push(`${prefix}${entities.length} entities — at most ${MAX_MAP_ENTITIES} fit`)
  const types = entityTypesOf(entities)
  if (types.length > MAX_ENTITY_TYPES) problems.push(`${prefix}${types.length} entity types — at most ${MAX_ENTITY_TYPES} fit`)
  for (const type of types) {
    if (!isEntityTypeName(type)) problems.push(`${prefix}entity type "${type}" is not a C identifier`)
  }
  for (const entity of entities) {
    if (entity.x > 255 || entity.y > 255) {
      problems.push(`${prefix}entity "${entity.type}" at ${entity.x},${entity.y} — coordinates are one byte, so at most 255`)
    }
  }
  return problems
}

// ---- Editing: each returns a new list, so they slot into a map's undo history.

export function addEntity(entities: readonly MapEntity[], entity: MapEntity): MapEntity[] {
  if (entities.length >= MAX_MAP_ENTITIES) return [...entities]
  return [...entities, { ...entity, type: cleanEntityTypeName(entity.type), param: entity.param & 0xff }]
}

export function updateEntity(entities: readonly MapEntity[], index: number, patch: Partial<MapEntity>): MapEntity[] {
  return entities.map((entity, i) => {
    if (i !== index) return entity
    const next = { ...entity, ...patch }
    return { ...next, type: cleanEntityTypeName(next.type), param: (Number(next.param) || 0) & 0xff }
  })
}

export function removeEntity(entities: readonly MapEntity[], index: number): MapEntity[] {
  return entities.filter((_, i) => i !== index)
}

/** Keeps the entities still on a `width × height` grid — a resize, or a slice. */
export function entitiesWithin(entities: readonly MapEntity[], width: number, height: number): MapEntity[] {
  return entities.filter((entity) => entity.x < width && entity.y < height)
}
