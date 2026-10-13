/**
 * `*.anim-tiles.json`: an animated tile, as a resource of its own.
 *
 * Unlike a meta-tile — "a named group that owns no pixels" — an animation
 * **owns its poses**: each frame is the hardware bytes of `width × height`
 * tiles, stored in the file. That is the whole point of making it a resource:
 * it references no tileset, so it can be attached to any compatible one and
 * detached again without losing art.
 *
 * Attaching (`TileAnimBinding` in `tile.ts`) gives it a *window* of consecutive
 * slots in a tileset. The window statically holds frame 0; at runtime the
 * tileset's generated `_Animate()` copies each pose's bytes over the window.
 * Every cell showing those slots animates at once, on screen or not, and no
 * name-table byte is written — the cheap way, on this hardware (see the design,
 * `docs/superpowers/specs/2026-10-13-tile-animations-design.md`). Copies that
 * must animate independently are animated meta-tiles, not this.
 *
 * Why a hyphen in the suffix: `resourceKindOf` matches by `endsWith`, and
 * `.anim-tiles.json` must not resolve to `.tiles.json`.
 */

import { defineName, type EmitTable, type HelperC } from './emitC'
import { isTileMode, type TileMode } from './modes'
import type { ExportBlock } from './resource'
import {
  ANIM_LOOPS,
  animCells,
  blankTileEntry,
  normalizeTiles,
  SC1_GROUP,
  TILE_SIZE,
  type AnimLoop,
  type TileAnimBinding,
  type TileBlock,
  type TileEntry,
  type TilesDoc
} from './tile'

/**
 * Cells in one window. One step copies `cells × 16` bytes into each of three
 * banks, so 16 cells is 768 bytes — about a third of an MSX1 frame. Past that
 * an animation stops being a tile and wants to be a sprite.
 */
export const MAX_ANIM_CELLS = 16
/** Frames per animation; the generated C counts them in a byte. */
export const MAX_ANIM_FRAMES = 255
/** A pose is held for 1-255 frames (VBlanks). */
export const MAX_ANIM_DURATION = 255
/** Eight frames a pose: slow enough to read as motion rather than flicker. */
export const DEFAULT_ANIM_DURATION = 8

export interface TileAnimFrame {
  /** `width * height` tiles, row-major — the window's cells in this pose. */
  tiles: TileEntry[]
  /** How many frames (VBlanks) this pose is held. */
  duration: number
}

export interface TileAnimDoc {
  version: 1
  /**
   * The byte format the poses are stored in. sc2 and sc4 share one (8 pattern +
   * 8 colour bytes a tile) and attach to either; sc1 stores patterns only and
   * attaches to sc1 alone.
   */
  mode: TileMode
  /** The window, in tiles. */
  width: number
  height: number
  /**
   * SCREEN 1 only: the ink/paper pair the poses are drawn and previewed in. On
   * the hardware the colour belongs to the *slot's* group of eight, not to the
   * tile, so this is what the art was drawn for — attaching checks the window's
   * group agrees. Ignored in the other modes, where colour travels per row.
   */
  pair: number
  /** `frames[0]` is the resting pose — what a static render shows. Never empty. */
  frames: TileAnimFrame[]
  loop: AnimLoop
  export: ExportBlock | null
}

/** Tiles in one pose — the stride of the exported tables, in tiles. */
export function animDocCells(doc: TileAnimDoc): number {
  return doc.width * doc.height
}

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = Math.round(Number(value))
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
}

const byte = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? (value | 0) & 0xff : 0)

function decodeEntry(raw: unknown, mode: TileMode): TileEntry {
  const entry = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<TileEntry>
  const pattern: number[] = []
  const color: number[] = []
  for (let y = 0; y < TILE_SIZE; y++) {
    pattern.push(byte(entry.pattern?.[y]))
    // White on black for a fresh pose, as a fresh tileset decodes.
    if (mode !== 'sc1') color.push(entry.color?.[y] === undefined ? 0xf1 : byte(entry.color[y]))
  }
  return { pattern, color }
}

/** Fills in everything a hand-edited or older file is missing; never throws. */
export function normalizeTileAnim(raw: unknown): TileAnimDoc {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const mode: TileMode = isTileMode(String(input.mode)) ? (input.mode as TileMode) : 'sc2'
  const width = clampInt(input.width, 1, MAX_ANIM_CELLS, 1)
  const height = clampInt(input.height, 1, Math.floor(MAX_ANIM_CELLS / width), 1)
  const cells = width * height
  const rawFrames = Array.isArray(input.frames) && input.frames.length ? (input.frames as unknown[]) : [{}]
  const frames: TileAnimFrame[] = rawFrames.slice(0, MAX_ANIM_FRAMES).map((frame) => {
    const f = (typeof frame === 'object' && frame !== null ? frame : {}) as { tiles?: unknown[]; duration?: unknown }
    return {
      // Resized to the document's own geometry: the exported table is read at
      // a fixed stride, so one odd frame would shift every frame after it.
      tiles: Array.from({ length: cells }, (_, i) => decodeEntry(f.tiles?.[i], mode)),
      duration: clampInt(f.duration, 1, MAX_ANIM_DURATION, DEFAULT_ANIM_DURATION)
    }
  })
  return {
    version: 1,
    mode,
    width,
    height,
    pair: input.pair === undefined ? 0xf1 : byte(input.pair),
    frames,
    loop: ANIM_LOOPS.includes(input.loop as AnimLoop) ? (input.loop as AnimLoop) : 'loop',
    export: (input.export as ExportBlock | undefined) ?? null
  }
}

export function createTileAnimDoc(mode: TileMode = 'sc2', width = 1, height = 1): TileAnimDoc {
  return normalizeTileAnim({ mode, width, height })
}

export function validateTileAnim(doc: TileAnimDoc): string[] {
  const problems: string[] = []
  const cells = animDocCells(doc)
  if (cells > MAX_ANIM_CELLS) problems.push(`${doc.width}×${doc.height} is ${cells} tiles; an animation window holds at most ${MAX_ANIM_CELLS}`)
  if (!doc.frames.length) problems.push('An animation needs at least one frame')
  if (doc.frames.length > MAX_ANIM_FRAMES) problems.push(`${doc.frames.length} frames; at most ${MAX_ANIM_FRAMES}`)
  doc.frames.forEach((frame, index) => {
    if (frame.tiles.length !== cells) problems.push(`Frame ${index}: ${frame.tiles.length} tiles, expected ${cells}`)
    if (frame.duration < 1 || frame.duration > MAX_ANIM_DURATION) problems.push(`Frame ${index}: duration ${frame.duration} outside 1..${MAX_ANIM_DURATION}`)
  })
  return problems
}

/**
 * True when some pose's colour bytes differ from frame 0's.
 *
 * Decides whether a step copies colours at all. Not only to halve the cost: a
 * colour write mirrors into all three thirds of the colour table, and a game
 * may have recoloured one third on purpose (`demo_msx1`'s HUD coin). When the
 * poses agree, copying the colours would undo that every step for nothing.
 */
export function colorsVary(doc: TileAnimDoc): boolean {
  if (doc.mode === 'sc1') return false
  const first = doc.frames[0]?.tiles ?? []
  return doc.frames.some((frame) =>
    frame.tiles.some((tile, cell) => tile.color.some((value, y) => value !== first[cell]?.color[y]))
  )
}

/** Whether poses stored for `animMode` can be shown by a tileset in `tilesetMode`. */
export function animModesCompatible(animMode: TileMode, tilesetMode: TileMode): boolean {
  return animMode === 'sc1' ? tilesetMode === 'sc1' : tilesetMode !== 'sc1'
}

/** The animation's own name from its path — `res/coin.anim-tiles.json` → `coin`. */
export function animBaseName(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? path
  return file.replace(/\.anim-tiles\.json$/i, '')
}

/**
 * The mirror of an animation, for a tileset that shows it. Pure, and the only
 * builder: the tile editor (on attach and on load) and the exporter (before
 * every render) both call this, so they cannot disagree about the one field
 * that has to name a real C symbol — the bug `metaRefFrom` exists to prevent.
 */
export function animRefFrom(
  path: string,
  anim: TileAnimDoc,
  fallbackName: string,
  where: { slot: number; bank: number | null }
): TileAnimBinding {
  return {
    path,
    slot: where.slot,
    bank: where.bank,
    name: anim.export?.name || fallbackName,
    width: anim.width,
    height: anim.height,
    frames: anim.frames.length,
    colorsVary: colorsVary(anim),
    loop: anim.loop
  }
}

/**
 * Writes pose `frame` of `anim` into the binding's window. Returns the same
 * document when the window already holds it, so a refresh that changes nothing
 * does not look like an edit.
 *
 * A common-set window writes `tiles`; a bank window writes that bank's own
 * overrides — the art the window actually shows. sc1 colours belong to the
 * slot's group and are left alone.
 */
export function withAnimFrame(tiles: TilesDoc, binding: TileAnimBinding, anim: TileAnimDoc, frame = 0): TilesDoc {
  const pose = anim.frames[frame] ?? anim.frames[0]
  if (!pose) return tiles
  const cells = Math.min(animCells(binding), pose.tiles.length)
  const same = (a: TileEntry | undefined, b: TileEntry): boolean =>
    !!a && a.pattern.every((v, i) => v === b.pattern[i]) && a.color.every((v, i) => v === b.color[i])
  const fit = (entry: TileEntry): TileEntry =>
    tiles.mode === 'sc1' ? { pattern: entry.pattern.slice(), color: [] } : { pattern: entry.pattern.slice(), color: entry.color.length ? entry.color.slice() : new Array(TILE_SIZE).fill(0xf1) }

  if (binding.bank === null) {
    let changed = false
    const next = tiles.tiles.slice()
    for (let i = 0; i < cells; i++) {
      const entry = fit(pose.tiles[i])
      if (same(next[binding.slot + i], entry)) continue
      next[binding.slot + i] = entry
      changed = true
    }
    return changed ? { ...tiles, tiles: next } : tiles
  }
  const own = (tiles.bankTiles[binding.bank] ?? []).slice()
  let changed = false
  for (let i = 0; i < cells; i++) {
    const entry = fit(pose.tiles[i])
    if (same(own[binding.slot + i], entry)) continue
    own[binding.slot + i] = entry
    changed = true
  }
  if (!changed) return tiles
  const bankTiles = tiles.bankTiles.slice()
  bankTiles[binding.bank] = own
  return { ...tiles, bankTiles }
}

/**
 * Attaches `anim` to `tiles` at `slot`: the binding, frame 0 written into the
 * window, and a block over the window named after the file — so a 2×2 torch is one
 * stamp in the map picker, and a game can find the window as
 * `_BASE`/`_W`/`_H` like any other block.
 *
 * A common-set window that runs past `count` grows the set to hold it, the way
 * appending tiles does. Re-attaching the same file moves it.
 */
export function attachAnimation(
  tiles: TilesDoc,
  path: string,
  anim: TileAnimDoc,
  where: { slot: number; bank: number | null; name: string }
): TilesDoc {
  const blockName = animBaseName(path)
  const base = detachAnimation(tiles, path)
  const binding = animRefFrom(path, anim, where.name, where)
  const cells = animCells(binding)
  let doc = base
  if (binding.bank === null && binding.slot + cells > doc.count) {
    doc = normalizeTiles({ ...doc, count: binding.slot + cells, animations: doc.animations })
  }
  doc = withAnimFrame({ ...doc, animations: [...doc.animations, binding] }, binding, anim)
  const block: TileBlock = {
    name: blockName,
    width: binding.width,
    height: binding.height,
    tiles: Array.from({ length: cells }, (_, i) => binding.slot + i)
  }
  return { ...doc, blocks: [...doc.blocks.filter((b) => b.name !== blockName), block] }
}

/**
 * Detaches the animation at `path`. The window keeps the pose it holds as
 * ordinary art — nothing is lost and no map changes — and the block attaching
 * made over it goes, since it named an animation that is no longer there.
 */
export function detachAnimation(tiles: TilesDoc, path: string): TilesDoc {
  const binding = tiles.animations.find((b) => b.path === path)
  if (!binding) return tiles
  const window = Array.from({ length: animCells(binding) }, (_, i) => binding.slot + i)
  const isWindowBlock = (block: TileBlock): boolean =>
    block.name === animBaseName(path) && block.tiles.length === window.length && block.tiles.every((t, i) => t === window[i])
  return {
    ...tiles,
    animations: tiles.animations.filter((b) => b.path !== path),
    blocks: tiles.blocks.filter((block) => !isWindowBlock(block))
  }
}

/**
 * Turns a tileset block used as a pose strip into an animation: the block is
 * read in reading order as `frameWidth × frameHeight` poses. A 4×1 block of a
 * spinning coin is four 1×1 poses; a 4×2 block of a 2×2 torch is two.
 *
 * Null when the block does not divide into whole poses.
 */
export function animationFromBlock(
  tiles: TilesDoc,
  block: TileBlock,
  frameWidth: number,
  frameHeight: number,
  duration = DEFAULT_ANIM_DURATION
): TileAnimDoc | null {
  if (frameWidth < 1 || frameHeight < 1 || frameWidth * frameHeight > MAX_ANIM_CELLS) return null
  if (block.width % frameWidth !== 0 || block.height % frameHeight !== 0) return null
  const across = block.width / frameWidth
  const down = block.height / frameHeight
  const frames: TileAnimFrame[] = []
  for (let fy = 0; fy < down; fy++) {
    for (let fx = 0; fx < across; fx++) {
      const cells: TileEntry[] = []
      for (let y = 0; y < frameHeight; y++) {
        for (let x = 0; x < frameWidth; x++) {
          const index = block.tiles[(fy * frameHeight + y) * block.width + fx * frameWidth + x] ?? 0
          const entry = tiles.tiles[index] ?? blankTileEntry(tiles.mode)
          cells.push({ pattern: entry.pattern.slice(), color: entry.color.slice() })
        }
      }
      frames.push({ tiles: cells, duration })
    }
  }
  const pair = tiles.mode === 'sc1' ? (tiles.groupColors[(block.tiles[0] ?? 0) >> 3] ?? 0xf1) : 0xf1
  return normalizeTileAnim({ mode: tiles.mode, width: frameWidth, height: frameHeight, pair, frames, loop: 'loop' })
}

/**
 * One pose as a tiny tileset of `cells` tiles — what the editor paints with the
 * tile editor's own stroke functions and draws with `tilePixels`, so the
 * two-colours-per-row rule is the tile editor's answer, not a second copy.
 */
export function frameTiles(doc: TileAnimDoc, frame: number): TilesDoc {
  const pose = doc.frames[frame] ?? doc.frames[0]
  const cells = animDocCells(doc)
  return normalizeTiles({
    mode: doc.mode,
    count: cells,
    tiles: pose.tiles,
    groupColors: doc.mode === 'sc1' ? new Array(Math.ceil(cells / SC1_GROUP)).fill(doc.pair) : []
  })
}

/** Writes a painted pose back from its scratch tileset (`frameTiles`). */
export function withFrameTiles(doc: TileAnimDoc, frame: number, painted: TilesDoc): TileAnimDoc {
  if (!doc.frames[frame]) return doc
  const frames = doc.frames.slice()
  frames[frame] = {
    ...frames[frame],
    tiles: Array.from({ length: animDocCells(doc) }, (_, i) => {
      const entry = painted.tiles[i] ?? blankTileEntry(doc.mode)
      return { pattern: entry.pattern.slice(), color: entry.color.slice() }
    })
  }
  // sc1 keeps its pair on the document, not per tile.
  const pair = doc.mode === 'sc1' ? (painted.groupColors[0] ?? doc.pair) : doc.pair
  return { ...doc, frames, pair }
}

// ── export ───────────────────────────────────────────────────────────────────

/**
 * The animation's own tables: every pose's patterns end to end, their colours
 * (not in sc1, which has none per tile), and one duration byte per pose. Data,
 * so it is there whether or not anything generates C over it.
 */
export function tileAnimTables(doc: TileAnimDoc): EmitTable[] {
  const patterns: number[] = []
  const colors: number[] = []
  for (const frame of doc.frames) {
    for (const tile of frame.tiles) {
      patterns.push(...tile.pattern)
      if (doc.mode !== 'sc1') colors.push(...tile.color)
    }
  }
  const tables: EmitTable[] = [
    { suffix: '_Patterns', bytes: Uint8Array.from(patterns), art: true, comment: `Poses, ${animDocCells(doc)} tile(s) each, end to end` }
  ]
  if (doc.mode !== 'sc1') tables.push({ suffix: '_Colors', bytes: Uint8Array.from(colors), comment: 'Pose colours, same layout' })
  tables.push({
    suffix: '_Durations',
    bytes: Uint8Array.from(doc.frames.map((frame) => frame.duration)),
    perLine: 16,
    comment: 'Frames (VBlanks) each pose is held'
  })
  return tables
}

export function tileAnimConstants(doc: TileAnimDoc, name: string): string[] {
  const prefix = defineName(name)
  return [
    `#define ${prefix}_W ${doc.width}`,
    `#define ${prefix}_H ${doc.height}`,
    `#define ${prefix}_CELLS ${animDocCells(doc)}`,
    `#define ${prefix}_FRAMES ${doc.frames.length}`
  ]
}

/** The `#define`s a tileset states about what is attached to it. Data: emitted with or without helper C. */
export function tilesetAnimConstants(doc: TilesDoc, name: string): string[] {
  if (!doc.animations.length) return []
  const prefix = defineName(name)
  return [
    `#define ${prefix}_ANIMS ${doc.animations.length}`,
    ...doc.animations.flatMap((binding, index) => {
      const id = `${prefix}_ANIM_${defineName(animBaseName(binding.path))}`
      return [`#define ${id} ${index}`, `#define ${id}_SLOT ${binding.slot}`]
    })
  ]
}

const LOOP_CODE: Record<AnimLoop, number> = { loop: 0, pingpong: 1, once: 2 }

/** The VRAM writes that show pose `frame` of one binding, as C statements. */
function showStatements(doc: TilesDoc, binding: TileAnimBinding): string[] {
  const cells = animCells(binding)
  const stride = cells * TILE_SIZE
  const patterns = `${binding.name}_Patterns + (u16)frame * ${stride}`
  const colors = `${binding.name}_Colors + (u16)frame * ${stride}`
  if (doc.mode === 'sc1') {
    // SCREEN 1 has one pattern table. The _GM2 loaders address three banks
    // 2 KB apart and only exist with VDP_USE_MODE_G2/G3, so this writes the
    // table directly — the same call MSXgl's own bank loader makes.
    return [`\t\tVDP_WriteVRAM(${patterns}, g_ScreenPatternLow + ${binding.slot * TILE_SIZE}, g_ScreenPatternHigh, ${stride});`]
  }
  if (binding.bank === null) {
    return [
      `\t\tVDP_LoadPattern_GM2(${patterns}, ${cells}, ${binding.slot});`,
      ...(binding.colorsVary ? [`\t\tVDP_LoadColor_GM2(${colors}, ${cells}, ${binding.slot});`] : [])
    ]
  }
  return [
    `\t\tVDP_LoadBankPattern_GM2(${patterns}, ${cells}, ${binding.bank}, ${binding.slot});`,
    ...(binding.colorsVary ? [`\t\tVDP_LoadBankColor_GM2(${colors}, ${cells}, ${binding.bank}, ${binding.slot});`] : [])
  ]
}

/**
 * The ready-made C that plays a tileset's attached animations.
 *
 * One `_Animate()` per tileset, called once per frame: each animation counts
 * its own pose's duration and, only on the frame a pose changes, copies the new
 * pose over its window. Calls MSXgl's own loaders, never a reimplementation.
 *
 * The state is RAM, and **RAM is not cleared at boot on a ROM target** — so
 * `_AnimReset()` must run before the first `_Animate()`, and `_Animate()` also
 * clamps a frame index it does not recognise back to 0, so a forgotten reset
 * shows the wrong pose rather than bytes from past the end of a table.
 */
export function tileAnimHelperC(doc: TilesDoc, name: string): HelperC {
  if (!doc.animations.length) return { header: [], source: [] }
  const prefix = defineName(name)
  const count = `${prefix}_ANIMS`
  const externs = [
    ...new Set(
      doc.animations.flatMap((binding) => [
        `extern const u8 ${binding.name}_Patterns[];`,
        `extern const u8 ${binding.name}_Durations[];`,
        ...(binding.colorsVary && doc.mode !== 'sc1' ? [`extern const u8 ${binding.name}_Colors[];`] : [])
      ])
    )
  ]
  const where = (binding: TileAnimBinding): string => {
    const last = binding.slot + animCells(binding) - 1
    const tiles = last === binding.slot ? `tile ${binding.slot}` : `tiles ${binding.slot}-${last}`
    return binding.bank === null ? `${tiles}, every bank` : `${tiles}, bank ${binding.bank + 1}`
  }
  return {
    header: [
      '',
      `// ── ${name}: attached animations ─────────────────────────────────────`,
      '//',
      `// Plays the ${doc.animations.length} animation${doc.animations.length === 1 ? '' : 's'} attached to this tileset by rewriting their`,
      "// tiles' patterns in VRAM: every cell showing them animates, on screen or",
      '// not, and no name-table byte is written.',
      '//',
      '// Call _AnimReset() once the tileset is in VRAM — it also shows every',
      '// first pose — then _Animate() once per frame (after Halt(), say). RAM is',
      '// not cleared at boot on a ROM target, so do not skip the reset.',
      '//',
      '// Example:',
      `//   ${name}_AnimReset();`,
      '//   while(1)',
      '//   {',
      '//       Halt();',
      `//       ${name}_Animate();`,
      '//       ...',
      '//   }',
      `void ${name}_AnimReset(void);`,
      `void ${name}_Animate(void);`,
      '',
      `// Holds an animation on the pose it shows (on = FALSE) or lets it run`,
      `// again. \`anim\` is one of the ${prefix}_ANIM_* indices.`,
      `void ${name}_AnimSetActive(u8 anim, bool on);`
    ],
    source: [
      '',
      ...externs,
      '',
      `static const u8* const ${name}_AnimDurations[${count}] = { ${doc.animations.map((b) => `${b.name}_Durations`).join(', ')} };`,
      `static const u8 ${name}_AnimLength[${count}] = { ${doc.animations.map((b) => b.frames).join(', ')} };`,
      `// 0 loop, 1 ping-pong, 2 once (holds the last pose).`,
      `static const u8 ${name}_AnimLoop[${count}] = { ${doc.animations.map((b) => LOOP_CODE[b.loop]).join(', ')} };`,
      `static u8 ${name}_AnimFrame[${count}];`,
      `static u8 ${name}_AnimTick[${count}];`,
      `// Bit 0: playing. Bit 1: running backwards (ping-pong).`,
      `static u8 ${name}_AnimState[${count}];`,
      '',
      `static void ${name}_AnimShow(u8 anim, u8 frame)`,
      '{',
      '\tswitch(anim)',
      '\t{',
      ...doc.animations.flatMap((binding, index) => [
        `\tcase ${index}: // ${binding.name} → ${where(binding)}`,
        ...showStatements(doc, binding),
        '\t\tbreak;'
      ]),
      '\t}',
      '}',
      '',
      `void ${name}_AnimReset(void)`,
      '{',
      `\tfor(u8 i = 0; i < ${count}; ++i)`,
      '\t{',
      `\t\t${name}_AnimFrame[i] = 0;`,
      `\t\t${name}_AnimTick[i] = 0;`,
      `\t\t${name}_AnimState[i] = 1;`,
      `\t\t${name}_AnimShow(i, 0);`,
      '\t}',
      '}',
      '',
      `void ${name}_Animate(void)`,
      '{',
      `\tfor(u8 i = 0; i < ${count}; ++i)`,
      '\t{',
      `\t\tu8 state = ${name}_AnimState[i];`,
      '\t\tif(!(state & 1)) continue;',
      `\t\tconst u8 last = ${name}_AnimLength[i] - 1;`,
      `\t\tu8 f = ${name}_AnimFrame[i];`,
      '\t\t// Clamped: a frame index past the end means _AnimReset() never ran.',
      '\t\tif(f > last) f = 0;',
      `\t\tif(++${name}_AnimTick[i] < ${name}_AnimDurations[i][f]) continue;`,
      `\t\t${name}_AnimTick[i] = 0;`,
      `\t\tif(${name}_AnimLoop[i] == 1)`,
      '\t\t{',
      '\t\t\tif(state & 2) { if(f == 0) { state &= ~2; if(last) f = 1; } else --f; }',
      '\t\t\telse { if(f >= last) { state |= 2; if(last) f = last - 1; } else ++f; }',
      '\t\t}',
      '\t\telse if(f < last) ++f;',
      `\t\telse if(${name}_AnimLoop[i] == 2) { ${name}_AnimState[i] = state & ~1; continue; }`,
      '\t\telse f = 0;',
      `\t\t${name}_AnimState[i] = state;`,
      `\t\t${name}_AnimFrame[i] = f;`,
      `\t\t${name}_AnimShow(i, f);`,
      '\t}',
      '}',
      '',
      `void ${name}_AnimSetActive(u8 anim, bool on)`,
      '{',
      `\tif(anim >= ${count}) return;`,
      `\tif(on) ${name}_AnimState[anim] |= 1;`,
      `\telse ${name}_AnimState[anim] &= ~1;`,
      '}'
    ]
  }
}
