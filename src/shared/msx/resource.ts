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
import { normalizeMap, mapExport, mapHelperC, validateMap, type MapDoc } from './map'
import { MODES } from './modes'
import {
  fragmentRectBytes,
  fragmentStrip,
  fragmentStripBytes,
  palettePairBytes,
  normalizeScreen,
  screenDataExport,
  screenHelperC,
  screenPixels,
  screenUnpackC,
  validateScreen,
  type ScreenDoc
} from './screen'
import { encodeAyfxBank, normalizeSfx, validateSfx, type SfxDoc } from './sfx'
import {
  hasMetasprite,
  hasSpriteGroups,
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
import {
  blockBytes,
  blockPlacements,
  normalizeTiles,
  tileColorBytes,
  tileHelperC,
  tilePatternBytes,
  validateTiles,
  type TilesDoc
} from './tile'

/** Every editor file carries one of these; null means "not exported". */
export interface ExportBlock {
  /** C table base name, MSXgl convention: `g_MyTiles`. */
  name: string
  format: 'c' | 'bin'
  /** Project-relative output path, e.g. `content/mytiles.h`. */
  out: string
  /**
   * Append the ready-made C for this resource (sprites: the group placer).
   * Off by default — it calls into MSXgl, so a header carrying it must be
   * included after `msxgl.h`. Ignored by the `bin` format.
   */
  helpers?: boolean
  /**
   * Compress the bulk table with MSXgl's RLEp — a map's layers, or a screen's
   * bitmap (in bands; see `screen.ts`). The game has to unpack before use, so
   * this is off by default and the `helpers` C is what knows how. Both decline
   * it when packing wouldn't shrink the data.
   */
  compress?: 'rlep'
}

export type ResourceKind = 'tiles' | 'sprites' | 'map' | 'screen' | 'sfx'

/**
 * Where new resources are created. Nothing *requires* them to live here — the
 * project is walked recursively, so a resource anywhere still gets found and
 * exported — but a project root fills up fast with a tileset, its maps, its
 * sprite sheets and their sources all in it.
 */
export const RESOURCE_DIR = 'res'

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
 * - map → one table per layer, named after the layer (RLEp-packed when asked)
 * - screen → `_Palette` (when the mode has one) then the packed bitmap
 */
export function resourceTables(resource: ResourceDoc, compress?: ExportBlock['compress']): EmitTable[] {
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
      if (doc.blocks.length) {
        tables.push({
          suffix: '_Blocks',
          bytes: blockBytes(doc),
          perLine: Math.min(16, Math.max(...doc.blocks.map((block) => block.width))),
          comment: `Multi-tile blocks — tile indices row-major: ${doc.blocks
            .map((block) => `${block.name} ${block.width}×${block.height}`)
            .join(', ')}`
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
      // Only a character drawn by several hardware sprites needs placement data.
      if (hasSpriteGroups(doc)) {
        tables.push({
          suffix: '_Layout',
          bytes: spriteLayoutBytes(doc),
          perLine: 2,
          comment: 'Sprite group layout — dx, dy per plane, in pattern order (0, 0 for stacked planes)'
        })
      }
      return tables
    }
    case 'map':
      return mapExport(resource.doc, compress).layers.map(({ bytes, unpacked }, index) => {
        const layer = resource.doc.layers[index]
        const size = `${resource.doc.width}×${resource.doc.height}`
        return {
          suffix: `_${pascal(layer.name)}`,
          bytes,
          unpacked,
          perLine: unpacked === undefined ? Math.min(32, resource.doc.width) : 16,
          comment:
            unpacked === undefined
              ? `Names layer "${layer.name}" (${size})`
              : `Names layer "${layer.name}" (${size}) — RLEp, ${unpacked} → ${bytes.length} bytes. ` +
                'Unpack with MSXgl\'s RLEp_UnpackToRAM before writing it to VRAM.'
        }
      })
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
      const picture = screenDataExport(doc, compress)
      const geometry = picture.geometry
      tables.push({
        // A compressed picture always takes `_Data`, because `_Bands` sits next
        // to it and a bare `g_Title` reading as "the packed one" helps nobody.
        suffix: tables.length || geometry ? '_Data' : '',
        bytes: picture.bytes,
        unpacked: picture.unpacked,
        perLine: geometry ? 16 : undefined,
        comment: geometry
          ? `${MODES[doc.mode].label} bitmap ${pixels.width}×${pixels.height} — RLEp in ${geometry.count} bands of ` +
            `${geometry.rows} lines, ${picture.unpacked} → ${picture.bytes.length} bytes. Unpack a band at a time ` +
            'with MSXgl\'s RLEp_UnpackToRAM.'
          : `${MODES[doc.mode].label} bitmap ${pixels.width}×${pixels.height}`
      })
      if (picture.offsets && geometry) {
        tables.push({
          suffix: '_Bands',
          bytes: picture.offsets,
          perLine: 2,
          comment: `Where each band starts in _Data — u16 little-endian, ${geometry.count} of them`
        })
      }
      if (doc.fragments.length) {
        const strip = fragmentStrip(doc)
        tables.push({
          suffix: '_Strip',
          bytes: fragmentStripBytes(doc),
          comment: `Fragments as one ${strip.width}×${strip.height} image: ${doc.fragments
            .map((fragment) => `${fragment.name} ${fragment.width}×${fragment.height}`)
            .join(', ')}`
        })
        tables.push({
          suffix: '_Rects',
          bytes: fragmentRectBytes(doc),
          perLine: 4,
          comment: 'Fragment rectangles inside the strip — xLo, xHi, width, height'
        })
      }
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
function resourceNotes(resource: ResourceDoc, sourceName: string, block: ExportBlock): string[] {
  const notes = [`Source: ${sourceName}`]
  // Only what actually happened: asking for RLEp and getting it are different
  // things when packing would have made the tables bigger.
  if (block.compress === 'rlep' && (resource.kind === 'map' || resource.kind === 'screen')) {
    notes.push(
      compressionApplied(resource, block.compress)
        ? 'Compression: RLEp (MSXgl "compress" module — unpack with RLEp_UnpackToRAM)'
        : 'Compression: RLEp asked for, but packing gained nothing here — the tables are raw'
    )
  }
  switch (resource.kind) {
    case 'tiles':
      notes.push(`Mode: ${MODES[resource.doc.mode].label}`, `Tiles: ${resource.doc.count}`)
      if (resource.doc.blocks.length) {
        notes.push(`Blocks: ${resource.doc.blocks.map((block) => `${block.name} ${block.width}×${block.height}`).join(', ')}`)
      }
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
      if (resource.doc.fragments.length) {
        notes.push(
          `Fragments: ${resource.doc.fragments.map((fragment) => `${fragment.name} ${fragment.width}×${fragment.height}`).join(', ')}`
        )
      }
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
 * Whether the requested compression was actually taken. Both kinds that support
 * it can decline, so nothing may assume that asking is the same as getting.
 */
export function compressionApplied(resource: ResourceDoc, compress: ExportBlock['compress']): boolean {
  if (compress !== 'rlep') return false
  if (resource.kind === 'map') return mapExport(resource.doc, compress).compressed
  if (resource.kind === 'screen') return screenDataExport(resource.doc, compress).geometry !== undefined
  return false
}

/**
 * Where each character starts in the flat plane order, so game code can place
 * one character out of a sheet: `..._BASE + frame * ..._PLANES`.
 */
function resourceConstants(resource: ResourceDoc, name: string, compress?: ExportBlock['compress']): string[] {
  const prefix = defineName(name)
  if (resource.kind === 'screen') {
    const { doc } = resource
    const geometry = screenDataExport(doc, compress).geometry
    const banded = geometry
      ? [
          `#define ${prefix}_W ${geometry.width}`,
          `#define ${prefix}_H ${geometry.height}`,
          `#define ${prefix}_STRIDE ${geometry.stride}`,
          `#define ${prefix}_BANDS ${geometry.count}`,
          `#define ${prefix}_BAND_ROWS ${geometry.rows}`,
          `#define ${prefix}_BAND_BYTES ${geometry.bufferBytes}`
        ]
      : []
    if (!doc.fragments.length) return banded
    const strip = fragmentStrip(doc)
    return [
      ...banded,
      `#define ${prefix}_STRIP_W ${strip.width}`,
      `#define ${prefix}_STRIP_H ${strip.height}`,
      // Backgrounds are saved side by side under the strip; the widest frame
      // plus the HMMM byte-alignment margin is how far apart they have to sit.
      `#define ${prefix}_BACKUP_PITCH ${Math.max(0, ...doc.fragments.map((fragment) => fragment.width)) + 4}`,
      ...doc.fragments.map((fragment, index) => `#define ${prefix}_${defineName(fragment.name)} ${index}`)
    ]
  }
  if (resource.kind === 'map') {
    // The helper C needs the map's shape, and so does anything that walks a layer.
    return [`#define ${prefix}_W ${resource.doc.width}`, `#define ${prefix}_H ${resource.doc.height}`]
  }
  if (resource.kind === 'tiles') {
    return blockPlacements(resource.doc).flatMap((placement) => {
      const id = `${prefix}_${defineName(placement.name)}`
      return [
        `#define ${id}_BASE ${placement.base}`,
        `#define ${id}_W ${placement.width}`,
        `#define ${id}_H ${placement.height}`
      ]
    })
  }
  if (resource.kind !== 'sprites' || !hasSpriteGroups(resource.doc)) return []
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
function resourceCode(resource: ResourceDoc, name: string, compress?: ExportBlock['compress']): string[] {
  if (resource.kind === 'map') {
    const first = resource.doc.layers[0]
    if (!first) return []
    return mapHelperC(resource.doc, name, mapExport(resource.doc, compress).compressed, `${name}_${pascal(first.name)}`)
  }
  if (resource.kind === 'screen') {
    const banded = screenDataExport(resource.doc, compress).geometry ? screenUnpackC(name) : []
    return resource.doc.fragments.length ? [...banded, ...screenHelperC(resource.doc, name)] : banded
  }
  if (resource.kind === 'tiles') return resource.doc.blocks.length ? tileHelperC(resource.doc, name) : []
  if (resource.kind !== 'sprites' || !hasSpriteGroups(resource.doc)) return []
  return spriteHelperC(resource.doc, name)
}

/**
 * Renders a resource into the bytes its `export` block asks for. `sourceName`
 * is the project-relative path of the editor file; it appears in the header
 * comment (never an absolute path — that would break byte-stability across
 * machines).
 */
export function renderResource(resource: ResourceDoc, sourceName: string, block: ExportBlock): Uint8Array {
  const tables = resourceTables(resource, block.compress)
  if (block.format === 'bin') return emitBin(tables)
  const name = block.name || defaultTableName(resourceBaseName(sourceName))
  const text = emitCHeader({
    name,
    tables,
    notes: resourceNotes(resource, sourceName, block),
    defines: true,
    constants: resourceConstants(resource, name, block.compress),
    code: block.helpers ? resourceCode(resource, name, block.compress) : []
  })
  return new TextEncoder().encode(text)
}
