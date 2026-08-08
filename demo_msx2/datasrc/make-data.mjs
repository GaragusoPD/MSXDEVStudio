#!/usr/bin/env node
// Writes the three resources that are data rather than pictures:
//
//   res/stage.map.json    the canyon, 16 × 160 cells over the atlas
//   res/fleet.sprites.json  the ship, its shot and the drones (sprite mode 2)
//   res/sfx.sfx.json      the ayFX bank
//
//   node datasrc/make-data.mjs
//
// These are MSXStudio's own editor formats, so everything written here opens
// in the editors and can be redrawn by hand — generating them is a way to get
// a first draft quickly, not a parallel pipeline. The `.screen.json` files are
// the exception: those cache a conversion, so they come from importing the
// PNGs in the screen editor.

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rng } from './draw.mjs'
import { GRB } from './palette.mjs'

const RES = join(dirname(fileURLToPath(import.meta.url)), '..', 'res')
mkdirSync(RES, { recursive: true })

// Which resources to write. `node make-data.mjs stage` regenerates the map
// alone — and that matters, because every one of these is editable in
// MSXStudio afterwards. A blanket run puts the generated version back over the
// top of whatever was done in the editor, which is exactly how a hand-drawn
// sprite sheet gets lost.
const only = process.argv.slice(2)
const wanted = (name) => only.length === 0 || only.includes(name.replace(/\..*$/, ''))

const write = (name, value) => {
  if (!wanted(name)) return
  writeFileSync(join(RES, name), `${JSON.stringify(value, null, 2)}\n`)
  console.log(name)
}

// ── the canyon ──────────────────────────────────────────────────────────────

const COLS = 16
const ROWS = 160

// Atlas cell numbers. These must match the order in make-art.mjs — the index
// of a cell there is the byte stored here.
const FLOOR = [0, 1, 2]
const CRACKED = [3, 4]
const VEIN = { ns: 5, ew: 6, cross: 7, se: 8, sw: 9, ne: 10, nw: 11 }
const DECOR = [12, 13, 14, 15]
const PIT = { '': 32, n: 33, s: 34, w: 35, e: 36, nw: 37, ne: 38, sw: 39, se: 40 }
const PAD = 41

/** Wall cells by which sides face open ground; see the atlas order. */
// Two cells for the wall's interior rather than one: it is the tile the map
// lays down by the hundred, and a single one of anything repeats visibly.
const WALL_PLAIN = [16, 17, 42, 43, 44, 45, 46, 47]
const WALL = {
  '': 16,
  n: 18,
  s: 19,
  w: 20,
  e: 21,
  nw: 22,
  ne: 23,
  sw: 24,
  se: 25,
  ns: 26,
  ew: 27,
  nsw: 28,
  nse: 29,
  new: 30,
  sew: 31
}

const random = rng(0x9a17)
const pick = (list) => list[Math.floor(random() * list.length) % list.length]

/**
 * The canyon's shape first, as a grid of what each cell *is* — wall, floor or
 * pit — because which artwork a cell gets depends on its neighbours, and that
 * question can only be answered once every neighbour exists.
 */
const KIND = Array.from({ length: ROWS }, () => new Array(COLS).fill('floor'))

let left = 2
let right = COLS - 3
for (let y = ROWS - 1; y >= 0; y--) {
  // Six cells of open sky in sixteen, wandering left and right as it climbs —
  // the walls take two thirds of the screen, which is the proportion the
  // concept art holds and the reason the canyon feels like a slot rather than a
  // field with edges. The two bounds move together, so the gap keeps its width
  // and meanders; the clamps are what close it further at the extremes.
  const squeeze = Math.sin(y / 13) + Math.sin(y / 31)
  left = Math.max(2, Math.min(7, Math.round(5 + squeeze)))
  right = COLS - 1 - Math.max(2, Math.min(7, Math.round(5 - squeeze)))
  for (let x = 0; x < COLS; x++) if (x < left || x > right) KIND[y][x] = 'wall'
}

// The landing pad the stage starts on, and clear air around it.
for (let y = ROWS - 6; y < ROWS - 2; y++) for (let x = 5; x < 11; x++) KIND[y][x] = 'floor'

// A handful of pits, always inside the open channel so they read as hazards
// rather than as part of the wall.
for (let n = 0; n < 14; n++) {
  const y = 8 + Math.floor(random() * (ROWS - 30))
  const x = 3 + Math.floor(random() * (COLS - 7))
  const w = 2 + Math.floor(random() * 2)
  const h = 2 + Math.floor(random() * 2)
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      if (KIND[y + dy]?.[x + dx] === 'floor') KIND[y + dy][x + dx] = 'pit'
    }
  }
}

const kindAt = (x, y) => KIND[y]?.[x] ?? 'wall'

/** Which sides of (x, y) face something other than `self`, as 'nsew' in that order. */
function openSides(x, y, self) {
  let sides = ''
  if (kindAt(x, y - 1) !== self) sides += 'n'
  if (kindAt(x, y + 1) !== self) sides += 's'
  if (kindAt(x + 1, y) !== self) sides += 'e'
  if (kindAt(x - 1, y) !== self) sides += 'w'
  return sides
}

/** Sides come out in 'nsew' order; the tables are keyed the way they read. */
const lookup = (table, sides) => table[sides] ?? table[[...sides].sort().join('')] ?? table['']

const cells = []
for (let y = 0; y < ROWS; y++) {
  for (let x = 0; x < COLS; x++) {
    const kind = KIND[y][x]
    if (kind === 'wall') {
      // The interior — no side facing the gap — is the tile the map lays down by
      // the hundred, so it alternates between the two plain cells. One of
      // anything, repeated over a third of the screen, reads as a checkerboard.
      const sides = openSides(x, y, 'wall')
      cells.push(sides ? lookup(WALL, sides) : pick(WALL_PLAIN))
    }
    else if (kind === 'pit') cells.push(lookup(PIT, openSides(x, y, 'pit')))
    else cells.push(random() < 0.12 ? pick(CRACKED) : pick(FLOOR))
  }
}

/**
 * The vein river, laid over the floor last so it can turn wherever it likes
 * without the floor generator having to know about it. It only ever runs on
 * open ground: a vein through a wall would look like a mistake.
 */
let veinX = 8
for (let y = ROWS - 1; y >= 0; y--) {
  const set = (x, yy, cell) => {
    if (KIND[yy]?.[x] === 'floor') cells[yy * COLS + x] = cell
  }
  // A jog every so often, drawn as the two corners that connect the columns.
  if (y % 11 === 0 && y > 2) {
    const step = random() < 0.5 ? -1 : 1
    const next = Math.max(2, Math.min(COLS - 3, veinX + step))
    if (next !== veinX) {
      set(veinX, y, step > 0 ? VEIN.ne : VEIN.nw)
      set(next, y, step > 0 ? VEIN.sw : VEIN.se)
      veinX = next
      continue
    }
  }
  set(veinX, y, VEIN.ns)
}

// Decoration, sparse, and never on the vein or a hazard.
for (let n = 0; n < 70; n++) {
  const y = Math.floor(random() * ROWS)
  const x = Math.floor(random() * COLS)
  if (KIND[y][x] !== 'floor') continue
  const at = y * COLS + x
  if (cells[at] >= 5 && cells[at] <= 11) continue
  cells[at] = pick(DECOR)
}

// The pad, under where the ship starts.
for (let dy = 0; dy < 1; dy++) cells[(ROWS - 4 + dy) * COLS + 7] = PAD

write('stage.map.json', {
  version: 1,
  tileset: 'res/canyon.btiles.json',
  width: COLS,
  height: ROWS,
  cell: { width: 16, height: 16, cols: 16 },
  layers: [{ name: 'terrain', kind: 'tiles', data: cells, visible: true }],
  export: { name: 'g_Stage', format: 'c', out: 'content/stage.h', helpers: true }
})

// ── the sprites ─────────────────────────────────────────────────────────────

/**
 * Byte index and bit for a pixel in the VDP's 16×16 layout: four 8×8
 * quadrants, top-left, bottom-left, top-right, bottom-right. Same rule as
 * `patternBit` in the app's `msx/sprite.ts` — written out here so this script
 * stays standalone.
 */
function pattern(rows) {
  const bytes = new Array(32).fill(0)
  rows.forEach((row, y) => {
    ;[...row].forEach((char, x) => {
      if (char !== '#') return
      const quadrant = (x < 8 ? 0 : 2) + (y < 8 ? 0 : 1)
      bytes[quadrant * 8 + (y & 7)] |= 0x80 >> (x & 7)
    })
  })
  return bytes
}

const CC = 0x40

/**
 * A mode-2 plane. `colors` is one palette index per line — that is the whole
 * point of sprite mode 2, and why a 16-line ship can be a gradient without
 * costing a second sprite.
 */
function plane(rows, colors, cc = false) {
  return {
    pattern: pattern(rows),
    color: colors[0] & 15,
    ec: false,
    lineColors: colors.map((value) => (cc ? (value & 15) | CC : value & 15)),
    cc,
    cx: 0,
    cy: 0
  }
}

/** 16 identical entries, for a plane that is one colour top to bottom. */
const flat = (color) => new Array(16).fill(color)

/** `[[fromLine, color], …]`, filled downwards — how the ship's gradient is written. */
function ramp(stops) {
  const out = new Array(16).fill(0)
  let color = 0
  for (let y = 0; y < 16; y++) {
    const stop = stops.find(([line]) => line === y)
    if (stop) color = stop[1]
    out[y] = color
  }
  return out
}

const SHIP_HULL = [
  '.......##.......',
  '.......##.......',
  '......####......',
  '......####......',
  '.....######.....',
  '.....######.....',
  '....########....',
  '...##########...',
  '..############..',
  '.##############.',
  '.##############.',
  '.###..####..###.',
  '.##....##....##.',
  '.......##.......',
  '......#..#......',
  '......#..#......'
]

const SHIP_BANK_L = [
  '......##........',
  '......##........',
  '.....####.......',
  '.....####.......',
  '....######......',
  '....######......',
  '...########.....',
  '..##########....',
  '.############...',
  '##############..',
  '##############..',
  '###..####..###..',
  '##....##....##..',
  '......##........',
  '.....#..#.......',
  '.....#..#.......'
]

const SHIP_BANK_R = SHIP_BANK_L.map((row) => [...row].reverse().join(''))

/**
 * The second plane: canopy and exhaust only. Its colours are chosen so that
 * `plane0 | plane1` lands on the palette entry the art wants — that is what
 * the CC bit does, and it is cheaper than a third sprite.
 *
 *   canopy: hull 3 (violet) | 12 (pale cyan) = 15 (white)
 *   exhaust: hull 8 (vein A) | 2 (dark violet) = 10 (vein C, the hottest)
 */
const SHIP_GLOW = [
  '................',
  '................',
  '................',
  '................',
  '.....######.....',
  '.....######.....',
  '.....######.....',
  '......####......',
  '................',
  '................',
  '................',
  '................',
  '................',
  '.......##.......',
  '......#..#......',
  '......#..#......'
]

const SHIP_GLOW_L = SHIP_GLOW.map((row) => row.slice(1) + '.')
const SHIP_GLOW_R = SHIP_GLOW.map((row) => '.' + row.slice(0, 15))

const HULL_COLORS = ramp([
  [0, 12], // nose, pale cyan
  [2, 4], //  pale violet
  [4, 3], //  violet body — the canopy ORs over this
  [11, 2], // dark violet underside
  [13, 8] //  vein A, so the exhaust plane ORs up to vein C
])

const GLOW_COLORS = ramp([
  [0, 0],
  [4, 12], // canopy
  [8, 0],
  [13, 2] // exhaust
])

const SHOT = [
  '................',
  '................',
  '................',
  '.......##.......',
  '......####......',
  '......####......',
  '......####......',
  '.......##.......',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................'
]

const DRONE_A = [
  '................',
  '................',
  '.....######.....',
  '....########....',
  '...##########...',
  '..####....####..',
  '.###..####..###.',
  '.##..######..##.',
  '.##..######..##.',
  '.###..####..###.',
  '..####....####..',
  '...##########...',
  '....########....',
  '.....######.....',
  '................',
  '................'
]

const DRONE_B = [
  '................',
  '..##........##..',
  '..###.####.###..',
  '...##########...',
  '..############..',
  '.####......####.',
  '.###..####..###.',
  '.##..######..##.',
  '.##..######..##.',
  '.###..####..###.',
  '.####......####.',
  '..############..',
  '...##########...',
  '..###.####.###..',
  '..##........##..',
  '................'
]

const DRONE_COLORS = ramp([
  [0, 14], // crimson rim
  [4, 15], // white core band
  [6, 14],
  [10, 5] // dark rust underside
])

// ── the HUD ─────────────────────────────────────────────────────────────────
//
// Drawn with hardware sprites, because they are the only thing on this screen
// that holds still: R#23 scrolls the bitmap under everything, so a HUD painted
// into the picture would have to be re-blitted every single frame. Sprites only
// need their Y adjusted, which is one addition.

const character = (name, frames) => ({ name, cols: 1, rows: 1, frames })

write('fleet.sprites.json', {
  version: 1,
  mode: 2,
  size: 16,
  palette: GRB,
  sprites: [
    character('ship_left', [{ layers: [plane(SHIP_BANK_L, HULL_COLORS), plane(SHIP_GLOW_L, GLOW_COLORS, true)] }]),
    character('ship', [{ layers: [plane(SHIP_HULL, HULL_COLORS), plane(SHIP_GLOW, GLOW_COLORS, true)] }]),
    character('ship_right', [{ layers: [plane(SHIP_BANK_R, HULL_COLORS), plane(SHIP_GLOW_R, GLOW_COLORS, true)] }]),
    character('shot', [{ layers: [plane(SHOT, flat(10))] }]),
    character('drone', [{ layers: [plane(DRONE_A, DRONE_COLORS)] }, { layers: [plane(DRONE_B, DRONE_COLORS)] }])
  ],
  export: { name: 'g_Fleet', format: 'c', out: 'content/fleet.h', helpers: true }
})

// ── the sound ───────────────────────────────────────────────────────────────

/** `frames` from a shape: tone slides one way, volume decays. */
function effect(name, { tone, toneStep = 0, noise = 0, length, volume = 14, decay = 1 }) {
  const frames = []
  for (let i = 0; i < length; i++) {
    const level = Math.max(0, Math.round(volume - i * decay))
    frames.push({
      toneOn: tone > 0,
      tone: Math.max(1, Math.round(tone + toneStep * i)),
      noiseOn: noise > 0,
      noise: Math.max(0, Math.round(noise)),
      volume: level
    })
    if (level === 0) break
  }
  return { name, frames }
}

write('sfx.sfx.json', {
  version: 1,
  rate: 50,
  effects: [
    // 0: the ship's gun — a short downward chirp.
    effect('shoot', { tone: 180, toneStep: 26, length: 8, volume: 13, decay: 1.6 }),
    // 1: a drone dying — noise, fading.
    effect('boom', { tone: 0, noise: 18, length: 14, volume: 15, decay: 1.1 }),
    // 2: the ship dying — lower, longer, with tone under the noise.
    effect('crash', { tone: 900, toneStep: 90, noise: 26, length: 22, volume: 15, decay: 0.7 }),
    // 3: a hit on the boss — bright and very short, so a stream of them reads as damage.
    effect('hit', { tone: 90, toneStep: -6, length: 5, volume: 12, decay: 2.4 }),
    // 4: the boss dying — the longest sound in the bank, and the only one that matters.
    effect('victory', { tone: 1200, toneStep: -70, noise: 12, length: 30, volume: 15, decay: 0.5 })
  ],
  export: { name: 'g_Sfx', format: 'c', out: 'content/sfx.h' }
})
