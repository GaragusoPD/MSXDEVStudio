/**
 * The editor file formats as one family: what they're called on disk,
 * how they're parsed, and how each one turns into the tables `emitC` writes
 * into a project's `content/`.
 *
 * `ResourceService` (main) is a thin wrapper around this module — all the
 * layout knowledge lives here so the editors and the exporter can never
 * disagree about what a `.tiles.json` becomes.
 */

import { defineName, emitBin, emitCHeader, type EmitTable } from './emitC'
import { normalizeMap, mapLayerBytes, validateMap, type MapDoc } from './map'
import { MODES } from './modes'
import { palettePairBytes, normalizeScreen, packBitmap, screenPixels, validateScreen, type ScreenDoc } from './screen'
import { encodeAyfxBank, normalizeSfx, validateSfx, type SfxDoc } from './sfx'
import {
  hasMetasprite,
  normalizeSprites,
  serializeSprites,
  spriteColorBytes,
  spriteHelperC,
  spriteLayoutBytes,
  spritePatternBytes,
  spritePlacements,
  validateSprites,
  type SpritesDoc
} from './sprite'
import { normalizeTiles, tileColorBytes, tilePatternBytes, validateTiles, type TilesDoc } from './tile'

/** Every editor file carries one of these; null means "not exported". */
export interface ExportBlock {
  /** C table base name, MSXgl convention: `g_MyTiles`. */
  name: string
  format: 'c' | 'bin'
  /** Project-relative output path, e.g. `content/mytiles.h`. */
  out: string
  /**
   * Append the ready-made C for this resource (sprites: the metasprite
   * placer). Off by default — it calls into MSXgl, so a header carrying it
   * must be included after `msxgl.h`. Ignored by the `bin` format.
   */
  helpers?: boolean
}

export type ResourceKind = 'tiles' | 'sprites' | 'map' | 'screen' | 'sfx'

export const RESOURCE_SUFFIXES: Readonly<Record<ResourceKind, string>> = {
  tiles: '.tiles.json',
  sprites: '.sprites.json',
  map: '.map.json',
  screen: '.screen.json',
  sfx: '.sfx.json'
}

export type ResourceDoc =
  | { kind: 'tiles'; doc: TilesDoc }
  | { kind: 'sprites'; doc: SpritesDoc }
  | { kind: 'map'; doc: MapDoc }
  | { kind: 'screen'; doc: ScreenDoc }
  | { kind: 'sfx'; doc: SfxDoc }

/** Which editor owns this path, by suffix. Null for anything else. */
export function resourceKindOf(path: string): ResourceKind | null {
  const lower = path.toLowerCase()
  for (const [kind, suffix] of Object.entries(RESOURCE_SUFFIXES)) {
    if (lower.endsWith(suffix)) return kind as ResourceKind
  }
  return null
}

/** Basename without the resource suffix — `art/hero.tiles.json` → `hero`. */
export function resourceBaseName(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? path
  const kind = resourceKindOf(file)
  return kind ? file.slice(0, -RESOURCE_SUFFIXES[kind].length) : file.replace(/\.[^.]*$/, '')
}

/** `hero` → `g_Hero`; `player_walk` → `g_PlayerWalk`. */
export function defaultTableName(base: string): string {
  const parts = base.split(/[^A-Za-z0-9]+/).filter(Boolean)
  const pascal = parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('')
  return `g_${pascal || 'Resource'}`
}

export function defaultExport(path: string): ExportBlock {
  const base = resourceBaseName(path)
  return { name: defaultTableName(base), format: 'c', out: `content/${base}.h` }
}

export function parseResource(path: string, text: string): ResourceDoc {
  const kind = resourceKindOf(path)
  if (!kind) throw new Error(`Not an MSXStudio resource: ${path}`)
  const raw = JSON.parse(text) as unknown
  switch (kind) {
    case 'tiles':
      return { kind, doc: normalizeTiles(raw) }
    case 'sprites':
      return { kind, doc: normalizeSprites(raw) }
    case 'map':
      return { kind, doc: normalizeMap(raw) }
    case 'screen':
      return { kind, doc: normalizeScreen(raw) }
    case 'sfx':
      return { kind, doc: normalizeSfx(raw) }
  }
}

export function serializeResource(resource: ResourceDoc): string {
  const value = resource.kind === 'sprites' ? serializeSprites(resource.doc) : resource.doc
  return `${JSON.stringify(value, null, 2)}\n`
}

export function validateResource(resource: ResourceDoc): string[] {
  switch (resource.kind) {
    case 'tiles':
      return validateTiles(resource.doc)
    case 'sprites':
      return validateSprites(resource.doc)
    case 'map':
      return validateMap(resource.doc)
    case 'screen':
      return validateScreen(resource.doc)
    case 'sfx':
      return validateSfx(resource.doc)
  }
}

function pascal(name: string): string {
  return (
    name
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('') || 'Layer'
  )
}

/**
 * The tables one resource exports, in MSXgl's expected order.
 *
 * - tiles → `_Patterns`, `_Colors` (+ `_Palette` on sc4)
 * - sprites → `_Patterns`, `_Colors` (+ `_Palette` in mode 2)
 * - map → one table per layer, named after the layer
 * - screen → `_Palette` (when the mode has one) then the packed bitmap
 */
export function resourceTables(resource: ResourceDoc): EmitTable[] {
  switch (resource.kind) {
    case 'tiles': {
      const { doc } = resource
      const tables: EmitTable[] = [
        { suffix: '_Patterns', bytes: tilePatternBytes(doc), art: true, comment: 'Patterns Table' },
        { suffix: '_Colors', bytes: tileColorBytes(doc), comment: 'Colors Table' }
      ]
      if (doc.palette) {
        tables.push({ suffix: '_Palette', bytes: palettePairBytes(doc.palette), perLine: 2, comment: 'Palette (V9938 GRB333)' })
      }
      // Only worth the ROM space once a tile actually carries a bit.
      if (doc.flags.some((value) => value !== 0)) {
        tables.push({
          suffix: '_Flags',
          bytes: Uint8Array.from(doc.flags),
          comment: 'Gameplay flags, one byte per tile (bit 0 = flag 1)'
        })
      }
      return tables
    }
    case 'sprites': {
      const { doc } = resource
      const tables: EmitTable[] = [
        { suffix: '_Patterns', bytes: spritePatternBytes(doc), art: true, comment: 'Sprite Patterns Table' },
        { suffix: '_Colors', bytes: spriteColorBytes(doc), comment: 'Sprite Colors Table' }
      ]
      if (doc.palette) {
        tables.push({ suffix: '_Palette', bytes: palettePairBytes(doc.palette), perLine: 2, comment: 'Palette (V9938 GRB333)' })
      }
      // Only a character spanning several hardware sprites needs placement data.
      if (hasMetasprite(doc)) {
        tables.push({
          suffix: '_Layout',
          bytes: spriteLayoutBytes(doc),
          perLine: 2,
          comment: 'Metasprite layout — dx, dy per plane, in pattern order'
        })
      }
      return tables
    }
    case 'map':
      return resource.doc.layers.map((layer) => ({
        suffix: `_${pascal(layer.name)}`,
        bytes: mapLayerBytes(layer),
        perLine: Math.min(32, resource.doc.width),
        comment: `Names layer "${layer.name}" (${resource.doc.width}×${resource.doc.height})`
      }))
    case 'screen': {
      const { doc } = resource
      const pixels = screenPixels(doc)
      if (!pixels) {
        throw new Error(
          `${doc.source || 'screen'}: no converted image cached — open the screen editor and run the conversion once.`
        )
      }
      const tables: EmitTable[] = []
      if (doc.converted?.palette) {
        tables.push({
          suffix: '_Palette',
          bytes: palettePairBytes(doc.converted.palette),
          perLine: 2,
          comment: 'Palette (V9938 GRB333)'
        })
      }
      tables.push({
        suffix: tables.length ? '_Data' : '',
        bytes: packBitmap(pixels.indices, pixels.width, pixels.height, doc.mode),
        comment: `${MODES[doc.mode].label} bitmap ${pixels.width}×${pixels.height}`
      })
      return tables
    }
    // One table: the whole ayFX bank, exactly the bytes `ayFX_InitBank` wants a pointer to.
    case 'sfx':
      return [
        {
          suffix: '',
          bytes: encodeAyfxBank(resource.doc.effects),
          comment: `ayFX bank — ${resource.doc.effects.length} effect(s): ${resource.doc.effects.map((e) => e.name).join(', ')}`
        }
      ]
  }
}

/** Human-readable generation parameters for the header's comment block. */
function resourceNotes(resource: ResourceDoc, sourceName: string): string[] {
  const notes = [`Source: ${sourceName}`]
  switch (resource.kind) {
    case 'tiles':
      notes.push(`Mode: ${MODES[resource.doc.mode].label}`, `Tiles: ${resource.doc.count}`)
      if (resource.doc.flags.some((value) => value !== 0)) {
        notes.push(`Flagged tiles: ${resource.doc.flags.filter((value) => value !== 0).length}`)
      }
      break
    case 'sprites':
      notes.push(
        `Sprite mode: ${resource.doc.mode}`,
        `Size: ${resource.doc.size}×${resource.doc.size}`,
        `Characters: ${resource.doc.sprites.length}`
      )
      if (hasMetasprite(resource.doc)) {
        notes.push(
          `Metasprites: ${resource.doc.sprites
            .filter((sprite) => sprite.cols * sprite.rows > 1)
            .map((sprite) => `${sprite.name} ${sprite.cols}×${sprite.rows}`)
            .join(', ')}`
        )
      }
      break
    case 'map':
      notes.push(
        `Tileset: ${resource.doc.tileset}`,
        `Size: ${resource.doc.width}×${resource.doc.height}`,
        `Layers: ${resource.doc.layers.map((layer) => layer.name).join(', ')}`
      )
      break
    case 'screen':
      notes.push(`Mode: ${MODES[resource.doc.mode].label}`, `Dither: ${resource.doc.convert.dither}`)
      break
    case 'sfx':
      notes.push(
        'Format: ayFX bank (play with MSXgl LibModules "ayfx/ayfx_player")',
        `Effects: ${resource.doc.effects.map((effect, index) => `${index}=${effect.name}`).join(', ')}`,
        `Replay rate: ${resource.doc.rate} Hz`
      )
      break
  }
  return notes
}

/**
 * Where each character starts in the flat plane order, so game code can place
 * one character out of a sheet: `..._BASE + frame * ..._PLANES`.
 */
function resourceConstants(resource: ResourceDoc, name: string): string[] {
  if (resource.kind !== 'sprites' || !hasMetasprite(resource.doc)) return []
  const prefix = defineName(name)
  return spritePlacements(resource.doc).flatMap((placement) => {
    const id = `${prefix}_${defineName(placement.name)}`
    return [
      `#define ${id}_BASE ${placement.base}`,
      `#define ${id}_PLANES ${placement.planes}`,
      `#define ${id}_FRAMES ${placement.frames}`
    ]
  })
}

/** The opt-in ready-made C for this resource; empty when the kind has none (yet). */
function resourceCode(resource: ResourceDoc, name: string): string[] {
  if (resource.kind !== 'sprites' || !hasMetasprite(resource.doc)) return []
  return spriteHelperC(resource.doc, name)
}

/**
 * Renders a resource into the bytes its `export` block asks for. `sourceName`
 * is the project-relative path of the editor file; it appears in the header
 * comment (never an absolute path — that would break byte-stability across
 * machines).
 */
export function renderResource(resource: ResourceDoc, sourceName: string, block: ExportBlock): Uint8Array {
  const tables = resourceTables(resource)
  if (block.format === 'bin') return emitBin(tables)
  const name = block.name || defaultTableName(resourceBaseName(sourceName))
  const text = emitCHeader({
    name,
    tables,
    notes: resourceNotes(resource, sourceName),
    defines: true,
    constants: resourceConstants(resource, name),
    code: block.helpers ? resourceCode(resource, name) : []
  })
  return new TextEncoder().encode(text)
}
