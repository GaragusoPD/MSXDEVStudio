/**
 * The editor file formats as one family: what they're called on disk,
 * how they're parsed, and how each one turns into the tables `emitC` writes
 * into a project's `content/`.
 *
 * `ResourceService` (main) is a thin wrapper around this module — all the
 * layout knowledge lives here so the editors and the exporter can never
 * disagree about what a `.tiles.json` becomes.
 */

import {
  bitmapBlockBytes,
  bitmapBlockOffsets,
  sc3NameTableCapable,
  sc3TableSuffix,
  bitmapTileBytes,
  bitmapTileHelperC,
  normalizeBitmapTiles,
  sheetCols,
  sheetPixels,
  validateBitmapTiles,
  type BitmapTilesDoc
} from './bitmap-tile'
import { defineName, emitBin, emitC, type EmitTable, type HelperC } from './emitC'
import {
  normalizeMap,
  mapExport,
  mapHelperC,
  placementBytes,
  placementCount,
  placementHelperC,
  validateMap,
  type MapDoc
} from './map'
import {
  metaBytes,
  metaCells,
  metaConstants,
  metaHelperC,
  normalizeMetaTile,
  validateMetaTile,
  type MetaTileDoc
} from './meta-tile'
import { MODES } from './modes'
import { sc3Constants, sc3LinearBytes } from './sc3'
import {
  normalizeSwSprites,
  swSpriteConstants,
  swSpriteHelperC,
  swSpriteInfoBytes,
  swSpriteLayout,
  validateSwSprites,
  type SwSpritesDoc
} from './swsprite'
import {
  fragmentRectBytes,
  fragmentStrip,
  fragmentStripBytes,
  palettePairBytes,
  normalizeScreen,
  screenDataExport,
  isScreenWorld,
  screenHelperC,
  screenTableSuffix,
  screenWorldHelperC,
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
  /**
   * SCREEN 3 only: emit the double-buffered runtime.
   *
   * MULTICOLOR has two pattern tables' worth of spare VRAM and R#4 picks between
   * them in 2 KB steps, while the name table holds *indices* — so the whole
   * picture swaps with one register write and nothing is copied. The cost is
   * 192 bytes of RAM for the per-page dirty flags and 2 KB of otherwise-idle
   * VRAM; the gain is that a moving software sprite never shows half-drawn.
   *
   * Off by default, and ignored by every other mode, so nothing an existing
   * project exports changes.
   */
  doubleBuffer?: boolean
}

export type ResourceKind =
  | 'tiles'
  | 'btiles'
  | 'metatiles'
  | 'metabtiles'
  | 'sprites'
  | 'swsprites'
  | 'map'
  | 'screen'
  | 'sfx'

/**
 * Where new resources are created. Nothing *requires* them to live here — the
 * project is walked recursively, so a resource anywhere still gets found and
 * exported — but a project root fills up fast with a tileset, its maps, its
 * sprite sheets and their sources all in it.
 */
export const RESOURCE_DIR = 'res'

/**
 * The hyphen in the meta suffixes is load-bearing, not a style choice:
 * `resourceKindOf` matches by `endsWith`, so `.meta.tiles.json` would resolve to
 * `tiles` and silently open the wrong editor on a file it cannot read.
 * `foo.meta-tiles.json` does not end with `.tiles.json`.
 */
export const RESOURCE_SUFFIXES: Readonly<Record<ResourceKind, string>> = {
  tiles: '.tiles.json',
  btiles: '.btiles.json',
  metatiles: '.meta-tiles.json',
  metabtiles: '.meta-btiles.json',
  sprites: '.sprites.json',
  // Listed before `sprites` for the same reason the meta suffixes are hyphenated:
  // `resourceKindOf` matches by `endsWith` over this record's insertion order.
  swsprites: '.swsprites.json',
  map: '.map.json',
  screen: '.screen.json',
  sfx: '.sfx.json'
}

/** True for the two meta-tile-set suffixes — the kinds a meta map may reference. */
export function isMetaKind(kind: ResourceKind | null): boolean {
  return kind === 'metatiles' || kind === 'metabtiles'
}

export type ResourceDoc =
  | { kind: 'tiles'; doc: TilesDoc }
  | { kind: 'btiles'; doc: BitmapTilesDoc }
  | { kind: 'metatiles'; doc: MetaTileDoc }
  | { kind: 'metabtiles'; doc: MetaTileDoc }
  | { kind: 'sprites'; doc: SpritesDoc }
  | { kind: 'swsprites'; doc: SwSpritesDoc }
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

/**
 * The default export for a resource, named after the file *and its kind*:
 * `intro.tiles.json` → `g_IntroTiles` in `content/intro_tiles.h`.
 *
 * The kind is in the name because a tileset and a map of the same subject are
 * the normal case — `intro.tiles.json` beside `intro.map.json` — and without it
 * both default to `g_Intro` in `content/intro.h`, where whichever exports last
 * silently overwrites the other.
 */
export function defaultExport(path: string): ExportBlock {
  const kind = resourceKindOf(path)
  const stem = resourceBaseName(path)
  // `tiles.tiles.json` is already saying it: don't make that `g_TilesTiles`.
  const base = !kind || stem === kind || stem.endsWith(`_${kind}`) ? stem : `${stem}_${kind}`
  return { name: defaultTableName(base), format: 'c', out: `content/${base}.h` }
}

export function parseResource(path: string, text: string): ResourceDoc {
  const kind = resourceKindOf(path)
  if (!kind) throw new Error(`Not an MSXDEVStudio resource: ${path}`)
  const raw = JSON.parse(text) as unknown
  switch (kind) {
    case 'tiles':
      return { kind, doc: normalizeTiles(raw) }
    case 'btiles':
      return { kind, doc: normalizeBitmapTiles(raw) }
    case 'metatiles':
    case 'metabtiles':
      return { kind, doc: normalizeMetaTile(raw) }
    case 'sprites':
      return { kind, doc: normalizeSprites(raw) }
    case 'swsprites':
      return { kind, doc: normalizeSwSprites(raw) }
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
    case 'btiles':
      return validateBitmapTiles(resource.doc)
    case 'metatiles':
    case 'metabtiles':
      return validateMetaTile(resource.doc)
    case 'sprites':
      return validateSprites(resource.doc)
    case 'swsprites':
      return validateSwSprites(resource.doc)
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

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * The tables one resource exports, in MSXgl's expected order.
 *
 * - tiles → `_Patterns`, `_Colors` (+ `_Palette` on sc4)
 * - sprites → `_Patterns`, `_Colors` (+ `_Palette` in mode 2)
 * - map → one table per layer, named after the layer (RLEp-packed when asked)
 * - screen → `_Palette` (when the mode has one), the bitmap, then `_Strip` and
 *   `_Rects` for its fragments — minus the bitmap when the fragments *are* it
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
    case 'btiles': {
      const { doc } = resource
      const sheet = sheetPixels(doc)
      // Palette first, exactly as a screen emits it: a `bin` export is read by
      // offset, and every blob in a project should start the same way.
      const tables: EmitTable[] = []
      if (doc.palette) {
        tables.push({ suffix: '_Palette', bytes: palettePairBytes(doc.palette), perLine: 2, comment: 'Palette (V9938 GRB333)' })
      }
      tables.push({
        suffix: sc3TableSuffix(doc),
        bytes: bitmapTileBytes(doc),
        comment:
          doc.mode === 'sc3'
            ? sc3NameTableCapable(doc)
              ? `${doc.count} tiles of 2×2 blocks — one name-table entry each, so the two bytes are repeated ` +
                'four times to make an 8-byte pattern that draws the same at every screen row. Upload it to ' +
                'the pattern table and draw maps with VDP_WriteLayout_GM2, or blit tiles from it.'
              : `${doc.count} tiles of ${doc.width}×${doc.height} blocks, ${Math.ceil(doc.width / 2) * doc.height} bytes each — blitted by the CPU ` +
                'into a shadow buffer; there is no command engine on an MSX1.'
            : `${doc.count} tiles of ${doc.width}×${doc.height}, as one ${sheet.width}×${sheet.height} sheet ` +
              `${sheetCols(doc)} across — upload it whole, then blit a tile at a time`
      })
      // Same rule as pattern tiles: only worth the ROM once a tile carries a bit.
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
          bytes: bitmapBlockBytes(doc),
          perLine: Math.min(16, Math.max(...doc.blocks.map((block) => block.width))),
          comment: `Multi-tile blocks — tile indices row-major: ${doc.blocks
            .map((block) => `${block.name} ${block.width}×${block.height}`)
            .join(', ')}`
        })
      }
      return tables
    }
    case 'metatiles':
    case 'metabtiles': {
      const { doc } = resource
      // One table, no suffix: a meta-tile is nothing but its frames, so
      // `g_Tree[]` reads better than `g_Tree_Frames[]`.
      return [
        {
          suffix: '',
          bytes: metaBytes(doc),
          perLine: Math.min(16, metaCells(doc)),
          comment:
            `${doc.width}×${doc.height} tiles, ${doc.frames.length} frame${doc.frames.length === 1 ? '' : 's'} — ` +
            `tile indices row-major, ${metaCells(doc)} bytes per frame`
        }
      ]
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
    case 'map': {
      const tables: EmitTable[] = mapExport(resource.doc, compress).layers.map(({ bytes, unpacked }, index) => {
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
      // Uncompressed on purpose, unlike the layers: a placement table is three
      // bytes an entry and the game indexes into it directly.
      if (placementCount(resource.doc)) {
        tables.push({
          suffix: '_Placements',
          bytes: placementBytes(resource.doc),
          perLine: 3,
          comment: 'Placed meta-tiles: slot | baked<<7, x, y — three bytes each, every layer in order'
        })
      }
      return tables
    }
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
      const stripBytes = doc.fragments.length ? fragmentStripBytes(doc) : null

      // A sheet whose fragments tile the whole picture — a HUD strip, the frames
      // of a software sprite — otherwise emits those pixels twice: once as the
      // picture, once as the strip. Nothing reads the picture in that case, so
      // it goes. `_Strip` is what `_Upload` uploads and what `_Rects` indexes,
      // and it is the one the helpers name.
      //
      // This is worth real ROM rather than a few bytes. In MSXDEVStudio's own
      // MSX2 demo the boss, HUD and mist sheets carried five kilobytes of exact
      // duplicate between them, inside the 32 KB the code shares — enough, in
      // the end, to push live functions into the ROM-paging window and hang the
      // machine.
      //
      // Byte equality is the test, not "do the fragments cover the image": it is
      // the thing that actually matters, and it cannot be fooled by fragments
      // that tile the picture in a different order from the strip.
      const pictureIsStrip = stripBytes !== null && !geometry && sameBytes(stripBytes, picture.bytes)

      // A packed picture is never the strip, and always keeps `_Data`: `_Bands`
      // indexes it and `_Unpack` reads it by that name.
      if (!pictureIsStrip) {
        tables.push({
          // A compressed picture always takes `_Data`, because `_Bands` sits next
          // to it and a bare `g_Title` reading as "the packed one" helps nobody.
          // `screenTableSuffix` is the same decision, and it is what the emitted
          // helpers name — the two disagreeing is an undefined symbol.
          suffix: screenTableSuffix(doc, compress),
          bytes: picture.bytes,
          unpacked: picture.unpacked,
          perLine: geometry ? 16 : undefined,
          comment: geometry
            ? `${MODES[doc.mode].label} bitmap ${pixels.width}×${pixels.height} — RLEp in ${geometry.count} bands of ` +
              `${geometry.rows} lines, ${picture.unpacked} → ${picture.bytes.length} bytes. Unpack a band at a time ` +
              'with MSXgl\'s RLEp_UnpackToRAM.'
            : `${MODES[doc.mode].label} bitmap ${pixels.width}×${pixels.height}`
        })
      }
      if (picture.offsets && geometry) {
        tables.push({
          suffix: '_Bands',
          bytes: picture.offsets,
          perLine: 2,
          comment: `Where each band starts in _Data — u16 little-endian, ${geometry.count} of them`
        })
      }
      if (stripBytes) {
        const strip = fragmentStrip(doc)
        tables.push({
          suffix: '_Strip',
          bytes: stripBytes,
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
    case 'swsprites': {
      const { doc } = resource
      const layout = swSpriteLayout(doc)
      const tables: EmitTable[] = []
      if (doc.palette) {
        tables.push({ suffix: '_Palette', bytes: palettePairBytes(doc.palette), perLine: 2, comment: 'Palette (V9938 GRB333)' })
      }
      tables.push({
        suffix: '_Data',
        bytes: layout.bytes,
        comment: layout.sheet
          ? `${doc.sprites.length} sprites, every frame side by side as one ${layout.sheet.width}×${layout.sheet.height} ` +
            'image — upload it once with HMMC, then each draw is one LMMM out of it'
          : `${doc.sprites.length} sprites, frames end to end: ${doc.sprites
              .map((character) => `${character.name} ${character.width}×${character.height}×${character.frames}`)
              .join(', ')}`
      })
      tables.push({
        suffix: '_Info',
        bytes: swSpriteInfoBytes(doc),
        perLine: 5,
        comment: 'Per sprite: offsetLo, offsetHi, width, height, frames — what the helpers index'
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
    case 'btiles': {
      const sheet = sheetPixels(resource.doc)
      notes.push(
        `Mode: ${MODES[resource.doc.mode].label}`,
        `Tiles: ${resource.doc.count} of ${resource.doc.width}×${resource.doc.height}`,
        `Sheet: ${sheet.width}×${sheet.height}, ${sheetCols(resource.doc)} tiles across`
      )
      if (resource.doc.blocks.length) {
        notes.push(
          `Blocks: ${resource.doc.blocks.map((block) => `${block.name} ${block.width}×${block.height}`).join(', ')}`
        )
      }
      if (resource.doc.flags.some((value) => value !== 0)) {
        notes.push(`Flagged tiles: ${resource.doc.flags.filter((value) => value !== 0).length}`)
      }
      break
    }
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
      if (resource.doc.metas.length) {
        notes.push(
          `Meta-tiles: ${resource.doc.metas.map((meta) => meta.name).join(', ')}`,
          `Placements: ${placementCount(resource.doc)}`
        )
      }
      if (resource.doc.cell) {
        notes.push(
          `Cell: ${resource.doc.cell.width}×${resource.doc.cell.height} dots, ` +
            `atlas ${resource.doc.cell.cols} cells per row (bitmap mode — cells are copied, not indexed)`
        )
      }
      break
    case 'metatiles':
    case 'metabtiles':
      notes.push(
        `Tileset: ${resource.doc.tileset}`,
        `Size: ${resource.doc.width}×${resource.doc.height} tiles (${metaCells(resource.doc)} bytes per frame)`,
        `Frames: ${resource.doc.frames.length}`
      )
      if (resource.doc.flags) notes.push(`Flags: 0x${resource.doc.flags.toString(16).padStart(2, '0')}`)
      if (resource.doc.cell) {
        notes.push(
          `Cell: ${resource.doc.cell.width}×${resource.doc.cell.height} dots, ` +
            `atlas ${resource.doc.cell.cols} cells per row (bitmap mode)`
        )
      }
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
function resourceConstants(
  resource: ResourceDoc,
  name: string,
  compress?: ExportBlock['compress'],
  doubleBuffer = false
): string[] {
  const prefix = defineName(name)
  if (resource.kind === 'screen') {
    const { doc } = resource
    const geometry = screenDataExport(doc, compress).geometry
    // Every picture carries its size, packed or not: anything that blits one
    // has to tell the VDP how big it is, and an atlas is read as a grid of that
    // size. `screenPixels` cannot be null here — `resourceTables` already threw.
    const pixels = screenPixels(doc)
    const banded = [
      `#define ${prefix}_W ${pixels?.width ?? 0}`,
      `#define ${prefix}_H ${pixels?.height ?? 0}`,
      ...(geometry
        ? [
            `#define ${prefix}_STRIDE ${geometry.stride}`,
            `#define ${prefix}_BANDS ${geometry.count}`,
            `#define ${prefix}_BAND_ROWS ${geometry.rows}`,
            `#define ${prefix}_BAND_BYTES ${geometry.bufferBytes}`
          ]
        : [])
    ]
    // sc3's frames are packed one after another in ROM rather than side by side
    // in VRAM, so the strip geometry means nothing there; what a game needs
    // instead is how big a save buffer has to be, and the page addresses.
    if (doc.mode === 'sc3') {
      const sizes = doc.fragments.map((fragment) => sc3LinearBytes(fragment.width, fragment.height))
      return [
        ...banded,
        // `banded` already stated _W/_H, from the converted image rather than
        // from the mode — and an imported picture smaller than the screen makes
        // those two different numbers, so taking both would be a contradictory
        // redefinition rather than a harmless repeat.
        // `banded` already stated _W/_H — the *picture's* size, which may be a
        // world larger than the display. `sc3Constants` states the display's,
        // under its own names, so the two never mean the same thing.
        ...sc3Constants(name, doubleBuffer, pixels?.width ?? 0),
        ...(doc.fragments.length
          ? [
              `#define ${prefix}_FRAMES ${doc.fragments.length}`,
              // One buffer big enough for the largest frame serves any of them.
              `#define ${prefix}_SAVE_BYTES ${Math.max(0, ...sizes)}`,
              ...doc.fragments.map((fragment, index) => `#define ${prefix}_${defineName(fragment.name)} ${index}`)
            ]
          : [])
      ]
    }
    // A world's helper needs the display's size and the picture's row stride;
    // `banded` only states the latter when the picture is compressed.
    const worldDefines = isScreenWorld(doc)
      ? [
          `#define ${prefix}_VIEW_W ${MODES[doc.mode].width}`,
          `#define ${prefix}_VIEW_H ${MODES[doc.mode].height}`,
          `#define ${prefix}_PPB ${MODES[doc.mode].pixelsPerByte}`,
          ...(geometry ? [] : [`#define ${prefix}_STRIDE ${Math.ceil((pixels?.width ?? 0) / MODES[doc.mode].pixelsPerByte)}`])
        ]
      : []
    if (!doc.fragments.length) return [...banded, ...worldDefines]
    const strip = fragmentStrip(doc)
    return [
      ...banded,
      ...worldDefines,
      `#define ${prefix}_STRIP_W ${strip.width}`,
      `#define ${prefix}_STRIP_H ${strip.height}`,
      // Backgrounds are saved side by side under the strip; the widest frame
      // plus the HMMM byte-alignment margin is how far apart they have to sit.
      `#define ${prefix}_BACKUP_PITCH ${Math.max(0, ...doc.fragments.map((fragment) => fragment.width)) + 4}`,
      ...doc.fragments.map((fragment, index) => `#define ${prefix}_${defineName(fragment.name)} ${index}`)
    ]
  }
  if (resource.kind === 'swsprites') return swSpriteConstants(resource.doc, name)
  if (resource.kind === 'map') {
    // The helper C needs the map's shape, and so does anything that walks a layer.
    const { cell, metas } = resource.doc
    return [
      `#define ${prefix}_W ${resource.doc.width}`,
      `#define ${prefix}_H ${resource.doc.height}`,
      // The placement table's shape, and a name per meta so game code says
      // `LEVEL_META_TREE` rather than 2. `_FLAGS_` is mirrored here so a game
      // walking the placements can ask "is this one solid?" without including
      // every meta's own header.
      ...(metas.length
        ? [
            `#define ${prefix}_METAS ${metas.length}`,
            `#define ${prefix}_PLACEMENTS ${placementCount(resource.doc)}`,
            ...metas.map((meta, index) => `#define ${prefix}_META_${defineName(meta.name)} ${index}`),
            ...metas.map((meta) => `#define ${prefix}_FLAGS_${defineName(meta.name)} 0x${meta.flags.toString(16).padStart(2, '0')}`)
          ]
        : []),
      // A bitmap-mode map also needs what a cell *is*, since nothing else knows.
      ...(cell
        ? [
            `#define ${prefix}_CELL_W ${cell.width}`,
            `#define ${prefix}_CELL_H ${cell.height}`,
            `#define ${prefix}_ATLAS_COLS ${cell.cols}`
          ]
        : []),
      // Only when the map names one — there is no index that can be assumed to
      // mean empty, so its absence has to stay visible in the header too.
      ...(resource.doc.transparent !== null ? [`#define ${prefix}_TRANSPARENT ${resource.doc.transparent}`] : [])
    ]
  }
  if (resource.kind === 'btiles') {
    const { doc } = resource
    const sheet = sheetPixels(doc)
    const offsets = bitmapBlockOffsets(doc)
    return [
      `#define ${prefix}_COUNT ${doc.count}`,
      `#define ${prefix}_TILE_W ${doc.width}`,
      `#define ${prefix}_TILE_H ${doc.height}`,
      // sc3 has no VRAM sheet to park — its tiles are read out of ROM, or loaded
      // into the pattern table — so what it states is the stride the blitter
      // steps by, and the colour a masked blit leaves alone.
      ...(doc.mode === 'sc3'
        ? [
            `#define ${prefix}_TILE_BYTES ${sc3NameTableCapable(doc) ? 8 : Math.ceil(doc.width / 2) * doc.height}`,
            ...(doc.transparent !== null ? [`#define ${prefix}_TRANSPARENT ${doc.transparent}`] : [])
          ]
        : [
            `#define ${prefix}_COLS ${sheetCols(doc)}`,
            `#define ${prefix}_SHEET_W ${sheet.width}`,
            `#define ${prefix}_SHEET_H ${sheet.height}`
          ]),
      ...doc.blocks.flatMap((block, index) => {
        const id = `${prefix}_${defineName(block.name)}`
        return [
          `#define ${id}_BASE ${offsets[index]}`,
          `#define ${id}_W ${block.width}`,
          `#define ${id}_H ${block.height}`
        ]
      })
    ]
  }
  if (isMetaKind(resource.kind)) return metaConstants(resource.doc as MetaTileDoc, name)
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

const NO_CODE: HelperC = { header: [], source: [] }

const joinHelpers = (...parts: HelperC[]): HelperC => ({
  header: parts.flatMap((part) => part.header),
  source: parts.flatMap((part) => part.source)
})

/** The opt-in ready-made C for this resource; empty when the kind has none (yet). */
function resourceCode(
  resource: ResourceDoc,
  name: string,
  compress?: ExportBlock['compress'],
  doubleBuffer = false
): HelperC {
  if (resource.kind === 'map') {
    const first = resource.doc.layers[0]
    if (!first) return NO_CODE
    const layers = mapHelperC(
      resource.doc,
      name,
      mapExport(resource.doc, compress).compressed,
      `${name}_${pascal(first.name)}`
    )
    // The placement runtime is additive: a map that places nothing gets exactly
    // the C it always did.
    const placed = placementHelperC(resource.doc, name)
    return { header: [...layers.header, ...placed.header], source: [...layers.source, ...placed.source] }
  }
  if (resource.kind === 'screen') {
    const banded = screenDataExport(resource.doc, compress).geometry
      ? screenUnpackC(name, resource.doc.mode, `${name}${screenTableSuffix(resource.doc, compress)}`)
      : NO_CODE
    // In a bitmap mode these helpers *are* the software sprites, so a screen with
    // no fragments has nothing to emit. sc3's are the mode itself — the name-table
    // boilerplate, the flush — and a picture with no fragments still needs them.
    const table = `${name}${screenTableSuffix(resource.doc, compress)}`
    if (resource.doc.mode === 'sc3') {
      return joinHelpers(screenHelperC(resource.doc, name, doubleBuffer, table), banded)
    }
    // A world is scrolled rather than shown, so it needs the window helper
    // whether or not anything was cut out of it as a sprite frame.
    const world = isScreenWorld(resource.doc) ? screenWorldHelperC(resource.doc, name, table) : NO_CODE
    const sprites = resource.doc.fragments.length ? screenHelperC(resource.doc, name) : NO_CODE
    return joinHelpers(joinHelpers(banded, world), sprites)
  }
  if (resource.kind === 'swsprites') {
    return resource.doc.sprites.length ? swSpriteHelperC(resource.doc, name) : NO_CODE
  }
  // No emptiness guard, unlike a tileset's blocks: a meta always has a frame,
  // so there is always something to draw.
  if (isMetaKind(resource.kind)) return metaHelperC(resource.doc as MetaTileDoc, name)
  if (resource.kind === 'tiles') return resource.doc.blocks.length ? tileHelperC(resource.doc, name) : NO_CODE
  // Unlike pattern tiles, this is worth emitting with no blocks at all: the
  // upload and the single-tile blit are the whole reason a bitmap tileset can
  // be drawn without the game knowing how the sheet is laid out.
  if (resource.kind === 'btiles') return bitmapTileHelperC(resource.doc, name)
  if (resource.kind !== 'sprites' || !hasSpriteGroups(resource.doc)) return NO_CODE
  return spriteHelperC(resource.doc, name)
}

/** `content/tiles.h` → `content/tiles.c`; the data half of a C export. */
export function sourcePathFor(headerPath: string): string {
  return headerPath.replace(/\.[^./\\]*$/, '') + '.c'
}

/**
 * Renders a resource into the bytes its `export` block asks for. `sourceName`
 * is the project-relative path of the editor file; it appears in the header
 * comment (never an absolute path — that would break byte-stability across
 * machines).
 */
/** The `format: 'bin'` export: one raw blob, no declarations to split out. */
export function renderResourceBin(resource: ResourceDoc, block: ExportBlock): Uint8Array {
  return emitBin(resourceTables(resource, block.compress))
}

/**
 * Renders a resource into the files its `export` block asks for: a header of
 * declarations and a source of definitions, or one raw blob for `format: 'bin'`.
 *
 * `sourceName` is the project-relative path of the editor file; it appears in
 * the header comment (never an absolute path — that would break byte-stability
 * across machines).
 */
export function renderResourceFiles(
  resource: ResourceDoc,
  sourceName: string,
  block: ExportBlock
): { header?: string; source?: string; bin?: Uint8Array } {
  const tables = resourceTables(resource, block.compress)
  if (block.format === 'bin') return { bin: emitBin(tables) }
  const name = block.name || defaultTableName(resourceBaseName(sourceName))
  const { header, source } = emitC({
    name,
    headerFile: block.out.split('/').pop(),
    tables,
    notes: resourceNotes(resource, sourceName, block),
    defines: true,
    constants: resourceConstants(resource, name, block.compress, block.doubleBuffer === true),
    code: block.helpers ? resourceCode(resource, name, block.compress, block.doubleBuffer === true) : undefined
  })
  return { header, source }
}
