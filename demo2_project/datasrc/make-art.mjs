#!/usr/bin/env node
// Draws every source PNG this demo converts, from nothing but code.
//
//   node datasrc/make-art.mjs
//
// The PNGs are the *input* to MSXStudio's screen editor, not the assets: open
// each one there, import it with the palette locked to `datasrc/palette.mjs`,
// and the editor produces the `.screen.json` the build actually reads. Keeping
// the art generated rather than hand-painted means the whole look can be
// retuned by changing a constant here — and it is why a demo about parallax
// does not ship a folder of binary art nobody can edit.
//
// Four images come out:
//   atlas.png    256×48  — 48 cells of 16×16, the canyon tilemap's cells
//   mist.png     144×24  — the near parallax layer, cut into 3 fragments
//   boss.png     136×40  — the boss, cut into 2 frames
//   title.png    256×212 — the title screen, text baked in
//   credits.png  256×212 — the credits screen, likewise

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import { VEIN_CYCLE } from './palette.mjs'
import { art, blit, canvas, fillRect, get, hLine, put, rng, stamp, text, textCentered, toRgba, vLine } from './draw.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = HERE

// Palette indices, named. Everything below reads these rather than numbers.
const TRANSPARENT = 0
const BLACK = 1
const ROCK_DARK = 2
const ROCK = 3
const ROCK_LIT = 4
const FLOOR_DARK = 5
const FLOOR = 6
const FLOOR_LIT = 7
const VEIN_A = 8
const VEIN_B = 9
const VEIN_C = 10
const MIST = 11
const MIST_LIT = 12
const GREEN = 13
const CRIMSON = 14
const WHITE = 15

const CELL = 16

// The near parallax layer is redrawn every time it moves, and a VDP blit costs
// roughly 1.5 µs a byte with the display on — so its size *is* its frame budget.
// 48×16 dots is about 1.2 KB of VRAM traffic per move, under two milliseconds.
const MIST_H = 16
const MIST_WIDTHS = [48, 32, 40]

// ── the canyon atlas ────────────────────────────────────────────────────────

/** Speckled ground: three shades of dust with the odd dark pebble. */
function floorCell(seed) {
  const cell = canvas(CELL, CELL, FLOOR)
  const random = rng(seed)
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      const roll = random()
      if (roll < 0.09) put(cell, x, y, FLOOR_DARK)
      else if (roll < 0.13) put(cell, x, y, FLOOR_LIT)
      else if (roll < 0.135) put(cell, x, y, BLACK)
    }
  }
  return cell
}

/** Ground split by a fault line — the dark cracks that break up a plain floor. */
function crackedCell(seed) {
  const cell = floorCell(seed)
  const random = rng(seed ^ 0x5bd1)
  let x = 2 + Math.floor(random() * 4)
  for (let y = 0; y < CELL; y++) {
    put(cell, x, y, BLACK)
    put(cell, x + 1, y, FLOOR_DARK)
    if (random() < 0.45) x += random() < 0.5 ? 1 : -1
    x = Math.max(1, Math.min(CELL - 3, x))
  }
  return cell
}

/**
 * A glowing vein, drawn as a three-shade ramp so the game's palette rotation
 * makes it appear to flow. `sides` names which cell edges the vein reaches:
 * 'n', 's', 'e', 'w'. Everything else is ground.
 */
function veinCell(seed, sides) {
  const cell = floorCell(seed)
  const mid = CELL / 2
  const arm = (dx, dy) => {
    for (let step = 0; step <= mid; step++) {
      const x = mid + dx * step
      const y = mid + dy * step
      // Three parallel shades across the vein, so a rotation reads as motion
      // along it rather than a flat flash.
      for (let offset = -2; offset <= 1; offset++) {
        const shade = offset === -2 || offset === 1 ? VEIN_A : offset === -1 ? VEIN_B : VEIN_C
        put(cell, x + (dy ? offset : 0), y + (dx ? offset : 0), shade)
      }
    }
  }
  if (sides.includes('n')) arm(0, -1)
  if (sides.includes('s')) arm(0, 1)
  if (sides.includes('w')) arm(-1, 0)
  if (sides.includes('e')) arm(1, 0)
  return cell
}

/**
 * Canyon wall. `open` names the sides that face open ground, and those get a
 * lit rim: the light in this canyon comes from the veins below, so a wall edge
 * is bright where it overhangs the floor and dark inside.
 */
function wallCell(seed, open = '') {
  const cell = canvas(CELL, CELL, ROCK)
  const random = rng(seed)
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      const roll = random()
      if (roll < 0.13) put(cell, x, y, ROCK_DARK)
      else if (roll < 0.17) put(cell, x, y, ROCK_LIT)
    }
  }
  if (open.includes('n')) {
    hLine(cell, 0, 0, CELL, ROCK_LIT)
    hLine(cell, 0, 1, CELL, ROCK)
  }
  if (open.includes('s')) {
    hLine(cell, 0, CELL - 1, CELL, BLACK)
    hLine(cell, 0, CELL - 2, CELL, ROCK_DARK)
  }
  if (open.includes('w')) {
    vLine(cell, 0, 0, CELL, ROCK_LIT)
    vLine(cell, 1, 0, CELL, ROCK)
  }
  if (open.includes('e')) {
    vLine(cell, CELL - 1, 0, CELL, ROCK_LIT)
    vLine(cell, CELL - 2, 0, CELL, ROCK)
  }
  return cell
}

/** A hand-drawn cell, where procedural noise would only get in the way. */
const CRYSTALS = art([
  '6666666666666666',
  '666666dd66666666',
  '66666dcd66666666',
  '66666dcd6666dd66',
  '6665dccd666dcd66',
  '666dccdd66dccd66',
  '666dcd6d66dccd66',
  '66dccd66666dcd66',
  '66dccd6dd66ddd66',
  '66dcddccd66d6666',
  '665ddccdd6666666',
  '66655dddd6666666',
  '6665556666666666',
  '6666666666666666',
  '6666666665666666',
  '6666666666666666'
])

const BONES = art([
  '6666666666666666',
  '6666111116666666',
  '6661777716666666',
  '6617777771666666',
  '6617111171666666',
  '6617777771666666',
  '6661777716666666',
  '6666171666666666',
  '6666177166666666',
  '6661777716666666',
  '6617716771666666',
  '6617666671666666',
  '6661766716666666',
  '6666177166666666',
  '6666666666666666',
  '6666666666666666'
])

const PAD = art([
  'cccccccccccccccc',
  'c66666666666666c',
  'c6c6666666666c6c',
  'c66c66666666c66c',
  'c666cccccccc666c',
  'c666c666666c666c',
  'c666c666666c666c',
  'c666c666666c666c',
  'c666c666666c666c',
  'c666c666666c666c',
  'c666cccccccc666c',
  'c66c66666666c66c',
  'c6c6666666666c6c',
  'c66666666666666c',
  'cccccccccccccccc',
  '6666666666666666'
])

const FLORA = art([
  '66666666666666d6',
  '666d6666666666d6',
  '66d6d66666666dd6',
  '66d6d666666ddd66',
  '6dd6dd66666d6d66',
  '6d666d666d6d6d66',
  '6d666d66d6d6d666',
  '66d6d666d6dd6666',
  '666d66666dd66666',
  '6666d6666d666666',
  '66666d666d666666',
  '666666dddd666666',
  '6666666dd6666666',
  '6666655dd5566666',
  '6666655555566666',
  '6666666666666666'
])

const RUBBLE = art([
  '6666666666666666',
  '6666666666666666',
  '6666555166666666',
  '6666577166666666',
  '6666551166665566',
  '6666666666657716',
  '6666666666655116',
  '6655166666666666',
  '6577166666655566',
  '6551166666577166',
  '6666666666551166',
  '6666666666666666',
  '6666557166666666',
  '6666551166666666',
  '6666666666666666',
  '6666666666666666'
])

/** Solid black, for the pits the ship must not fly over. */
function pitCell(open = '') {
  const cell = canvas(CELL, CELL, BLACK)
  if (open.includes('n')) hLine(cell, 0, 0, CELL, FLOOR_DARK)
  if (open.includes('s')) hLine(cell, 0, CELL - 1, CELL, FLOOR_DARK)
  if (open.includes('w')) vLine(cell, 0, 0, CELL, FLOOR_DARK)
  if (open.includes('e')) vLine(cell, CELL - 1, 0, CELL, FLOOR_DARK)
  return cell
}

/**
 * The atlas, as a flat list. The index of a cell here is the byte the tilemap
 * stores and the number the game's `#define`s name, so **this order is the
 * contract** — inserting a cell renumbers everything after it.
 */
const ATLAS_CELLS = [
  /*  0 */ floorCell(0x1001),
  /*  1 */ floorCell(0x1002),
  /*  2 */ floorCell(0x1003),
  /*  3 */ crackedCell(0x1004),
  /*  4 */ crackedCell(0x1005),
  /*  5 */ veinCell(0x1006, 'ns'),
  /*  6 */ veinCell(0x1007, 'ew'),
  /*  7 */ veinCell(0x1008, 'nsew'),
  /*  8 */ veinCell(0x1009, 'se'),
  /*  9 */ veinCell(0x100a, 'sw'),
  /* 10 */ veinCell(0x100b, 'ne'),
  /* 11 */ veinCell(0x100c, 'nw'),
  /* 12 */ CRYSTALS,
  /* 13 */ BONES,
  /* 14 */ FLORA,
  /* 15 */ RUBBLE,

  /* 16 */ wallCell(0x2001),
  /* 17 */ wallCell(0x2002),
  /* 18 */ wallCell(0x2003, 'n'),
  /* 19 */ wallCell(0x2004, 's'),
  /* 20 */ wallCell(0x2005, 'w'),
  /* 21 */ wallCell(0x2006, 'e'),
  /* 22 */ wallCell(0x2007, 'nw'),
  /* 23 */ wallCell(0x2008, 'ne'),
  /* 24 */ wallCell(0x2009, 'sw'),
  /* 25 */ wallCell(0x200a, 'se'),
  /* 26 */ wallCell(0x200b, 'ns'),
  /* 27 */ wallCell(0x200c, 'ew'),
  /* 28 */ wallCell(0x200d, 'nsw'),
  /* 29 */ wallCell(0x200e, 'nse'),
  /* 30 */ wallCell(0x200f, 'nwe'),
  /* 31 */ wallCell(0x2010, 'swe'),

  /* 32 */ pitCell(),
  /* 33 */ pitCell('n'),
  /* 34 */ pitCell('s'),
  /* 35 */ pitCell('w'),
  /* 36 */ pitCell('e'),
  /* 37 */ pitCell('nw'),
  /* 38 */ pitCell('ne'),
  /* 39 */ pitCell('sw'),
  /* 40 */ pitCell('se'),
  /* 41 */ PAD,
  /* 42 */ floorCell(0x3001),
  /* 43 */ crackedCell(0x3002),
  /* 44 */ veinCell(0x3003, 'n'),
  /* 45 */ veinCell(0x3004, 's'),
  /* 46 */ veinCell(0x3005, 'w'),
  /* 47 */ veinCell(0x3006, 'e')
]

const ATLAS_COLS = 16

function buildAtlas() {
  const rows = Math.ceil(ATLAS_CELLS.length / ATLAS_COLS)
  const sheet = canvas(ATLAS_COLS * CELL, rows * CELL)
  ATLAS_CELLS.forEach((cell, index) => {
    stamp(sheet, cell, (index % ATLAS_COLS) * CELL, Math.floor(index / ATLAS_COLS) * CELL)
  })
  return sheet
}

// ── the near parallax layer ─────────────────────────────────────────────────

/**
 * A wisp of mist: soft, wide and mostly holes, because it is drawn *over* the
 * canyon and has to read as being in front of it rather than painted on it.
 * Index 0 is transparent, which is what the software-sprite blit honours.
 */
function mistCell(width, seed) {
  const cell = canvas(width, MIST_H)
  const random = rng(seed)
  const centre = MIST_H / 2
  for (let x = 0; x < width; x++) {
    // A soft envelope: thick in the middle of the wisp, feathered at the ends.
    const along = x / (width - 1)
    const envelope = Math.sin(along * Math.PI) ** 0.7
    const half = Math.round(envelope * (3 + random() * 2.4))
    for (let dy = -half; dy <= half; dy++) {
      const edge = Math.abs(dy) >= half - 1
      if (random() < (edge ? 0.35 : 0.82)) put(cell, x, centre + dy, edge ? MIST : MIST_LIT)
    }
  }
  return cell
}

function buildMist() {
  const widths = MIST_WIDTHS
  const sheet = canvas(
    widths.reduce((total, width) => total + width, 0),
    MIST_H
  )
  let x = 0
  widths.forEach((width, index) => {
    stamp(sheet, mistCell(width, 0x4000 + index), x, 0)
    x += width
  })
  return { sheet, widths }
}

// ── the boss ────────────────────────────────────────────────────────────────

/**
 * Too big for hardware sprites: 68 dots across is five 16-wide sprites on the
 * same line, and the VDP draws four. So the boss is blitted into the picture
 * instead, which costs a background save and restore but has no per-line limit
 * at all — the point the demo is making.
 */
function bossFrame(phase) {
  const width = 68
  const height = 40
  const frame = canvas(width, height)
  const cx = width / 2
  // Hull: a broad wedge.
  for (let y = 0; y < 26; y++) {
    const half = Math.round(6 + y * 1.05)
    for (let x = -half; x <= half; x++) {
      const edge = Math.abs(x) >= half - 1
      put(frame, cx + x, y + 4, edge ? ROCK_DARK : ROCK)
    }
  }
  // Lit upper edge, so it reads as metal rather than a blob.
  for (let x = -6; x <= 6; x++) put(frame, cx + x, 4, ROCK_LIT)
  // Wings, which flex between the two frames.
  const droop = phase ? 3 : 0
  for (let step = 0; step < 16; step++) {
    const y = 12 + Math.round(step * 0.7) + droop
    for (let t = 0; t < 4; t++) {
      put(frame, 2 + step, y + t, t === 0 ? ROCK_LIT : ROCK_DARK)
      put(frame, width - 3 - step, y + t, t === 0 ? ROCK_LIT : ROCK_DARK)
    }
  }
  // The eye: crimson, and the thing the player is meant to shoot.
  const glow = phase ? VEIN_C : CRIMSON
  for (let y = -4; y <= 4; y++) {
    for (let x = -6; x <= 6; x++) {
      if (x * x * 0.4 + y * y > 16) continue
      put(frame, cx + x, 20 + y, Math.abs(x) + Math.abs(y) < 5 ? WHITE : glow)
    }
  }
  // Thrusters.
  for (const side of [-1, 1]) {
    for (let y = 0; y < 5; y++) {
      put(frame, cx + side * 20, 30 + y, y < 2 ? VEIN_C : VEIN_A)
      put(frame, cx + side * 20 + side, 30 + y, VEIN_B)
    }
  }
  return frame
}

function buildBoss() {
  const frames = [bossFrame(0), bossFrame(1)]
  const sheet = canvas(frames[0].width * 2, frames[0].height)
  frames.forEach((frame, index) => stamp(sheet, frame, index * frame.width, 0))
  return { sheet, width: frames[0].width, height: frames[0].height }
}

// ── the HUD ─────────────────────────────────────────────────────────────────

/**
 * The HUD is bitmap graphics, not sprites: it is blitted over the canyon every
 * frame and restored the next, exactly like the boss. Being bitmap means it has
 * no per-line colour limit, so a black panel can hold a coloured bar and a white
 * number on the same rows — which a mode-2 sprite cannot do without a second
 * plane behind it.
 *
 * Its pieces are cut side by side into one strip, because that is what a single
 * HMMC can upload and what `_Draw` indexes into.
 */
const HUD_H = 16
const HUD_BAR_W = 40
const HUD_LIFE_W = 16

/** The panel every HUD piece is drawn on: near-black, with a lit top edge. */
function hudPanel(width) {
  const panel = canvas(width, HUD_H, BLACK)
  hLine(panel, 0, 0, width, ROCK_DARK)
  hLine(panel, 0, HUD_H - 1, width, ROCK_DARK)
  return panel
}

/** The energy bar at `level` of three. The last block left is red, not short. */
function hudBar(level) {
  const panel = hudPanel(HUD_BAR_W)
  for (let i = 0; i < 3; i++) {
    const lit = i < level
    const color = !lit ? ROCK_DARK : level === 1 ? CRIMSON : MIST_LIT
    fillRect(panel, 3 + i * 12, 5, 10, 6, color)
    if (lit) hLine(panel, 3 + i * 12, 5, 10, WHITE)
  }
  return panel
}

/** The life count, as a number on its own panel — the piece that sits beside the bar. */
function hudLife(count) {
  const panel = hudPanel(HUD_LIFE_W)
  text(panel, 5, 4, String(count), WHITE)
  return panel
}

function buildHud() {
  const pieces = [hudBar(3), hudBar(2), hudBar(1), hudBar(0), hudLife(0), hudLife(1), hudLife(2), hudLife(3)]
  const sheet = canvas(
    pieces.reduce((total, piece) => total + piece.width, 0),
    HUD_H
  )
  let x = 0
  for (const piece of pieces) {
    stamp(sheet, piece, x, 0)
    x += piece.width
  }
  return { sheet, width: x }
}

// ── the full-screen pictures ────────────────────────────────────────────────

const SCREEN_W = 256
const SCREEN_H = 212

/**
 * The canyon seen from above, which is what both full-screen pictures share:
 * two rock walls closing in from the sides and a glowing river of veins
 * running between them.
 */
function canyonVista(seed) {
  const picture = canvas(SCREEN_W, SCREEN_H, FLOOR)
  const random = rng(seed)

  for (let y = 0; y < SCREEN_H; y++) {
    for (let x = 0; x < SCREEN_W; x++) {
      const roll = random()
      if (roll < 0.14) put(picture, x, y, FLOOR_DARK)
      else if (roll < 0.22) put(picture, x, y, FLOOR_LIT)
    }
  }

  // Walls: a jagged edge walking down each side.
  let left = 40
  let right = SCREEN_W - 40
  for (let y = 0; y < SCREEN_H; y++) {
    left += Math.round((random() - 0.5) * 3)
    right += Math.round((random() - 0.5) * 3)
    left = Math.max(8, Math.min(76, left))
    right = Math.max(SCREEN_W - 76, Math.min(SCREEN_W - 8, right))
    for (let x = 0; x < left; x++) put(picture, x, y, random() < 0.25 ? ROCK_DARK : ROCK)
    for (let x = right; x < SCREEN_W; x++) put(picture, x, y, random() < 0.25 ? ROCK_DARK : ROCK)
    put(picture, left, y, ROCK_LIT)
    put(picture, right - 1, y, ROCK_LIT)
  }

  // The vein river, wandering down the middle.
  let river = SCREEN_W / 2
  for (let y = 0; y < SCREEN_H; y++) {
    river += Math.round((random() - 0.5) * 2.4)
    river = Math.max(96, Math.min(SCREEN_W - 96, river))
    const width = 5 + Math.round(Math.sin(y / 17) * 2)
    for (let x = -width; x <= width; x++) {
      const distance = Math.abs(x) / width
      put(picture, river + x, y, distance > 0.75 ? VEIN_A : distance > 0.4 ? VEIN_B : VEIN_C)
    }
  }
  return picture
}

/** A panel behind text, so the lettering reads over busy art without a second picture. */
function panel(picture, x, y, w, h) {
  fillRect(picture, x, y, w, h, BLACK)
  hLine(picture, x, y, w, ROCK_DARK)
  hLine(picture, x, y + h - 1, w, ROCK_DARK)
  vLine(picture, x, y, h, ROCK_DARK)
  vLine(picture, x + w - 1, y, h, ROCK_DARK)
}

function buildTitle() {
  const picture = canyonVista(0x7101)

  panel(picture, 16, 26, SCREEN_W - 32, 54)
  textCentered(picture, 36, 'CANYON', VEIN_C, SCREEN_W, BLACK)
  textCentered(picture, 36, 'CANYON', VEIN_C, SCREEN_W, BLACK)
  textCentered(picture, 58, 'RUNNER', MIST_LIT, SCREEN_W, BLACK)

  panel(picture, 40, 104, SCREEN_W - 80, 30)
  textCentered(picture, 110, 'ARROWS FLY', WHITE, SCREEN_W)
  textCentered(picture, 122, 'SPACE FIRES', WHITE, SCREEN_W)

  panel(picture, 8, 154, SCREEN_W - 16, 46)
  textCentered(picture, 160, 'AN MSXSTUDIO DEMO', MIST_LIT, SCREEN_W)
  textCentered(picture, 174, 'BUILT WITH MSXGL BY AOINEKO', MIST, SCREEN_W)
  textCentered(picture, 186, 'PRESS SPACE', VEIN_C, SCREEN_W)
  return picture
}

function buildCredits() {
  const picture = canyonVista(0x7202)

  panel(picture, 8, 12, SCREEN_W - 16, 188)
  textCentered(picture, 20, 'CANYON RUNNER', VEIN_C, SCREEN_W)
  textCentered(picture, 34, 'A DEMO FOR MSXSTUDIO', MIST_LIT, SCREEN_W)

  const lines = [
    ['', 0],
    ['MSXSTUDIO', VEIN_B],
    ['BY P.D. GARAGUSO', WHITE],
    ['', 0],
    ['MSXGL AND MSXTK', VEIN_B],
    ['BY GUILLAUME AOINEKO', WHITE],
    ['BLANCHARD - CC BY-SA 4.0', WHITE],
    ['', 0],
    ['AYFX FORMAT BY SHIRU', WHITE],
    ['SDCC - OPENMSX - WEBMSX', WHITE],
    ['', 0],
    ['NONE OF THEM ENDORSE', MIST],
    ['THIS DEMO', MIST],
    ['', 0],
    ['PRESS SPACE', VEIN_C]
  ]
  lines.forEach(([line, color], index) => {
    if (line) textCentered(picture, 54 + index * 10, line, color, SCREEN_W)
  })
  return picture
}

// ── the ending panels ───────────────────────────────────────────────────────
//
// Two messages the game puts up over the frozen picture: one for the boss going
// down, one for the last life going. They are a strip rather than two more
// full-screen pictures because a SCREEN 5 picture is 27 KB and the ROM has room
// for one more, not two — and a panel over the canyon reads better anyway.

const MSG_W = 96
const MSG_H = 18

/** One message panel: the same near-black slab the HUD uses, with a rule top and bottom. */
function messagePanel(headline) {
  const panel = canvas(MSG_W, MSG_H, BLACK)
  hLine(panel, 0, 0, MSG_W, ROCK_LIT)
  hLine(panel, 0, MSG_H - 1, MSG_W, ROCK_LIT)
  textCentered(panel, 2, headline, WHITE, MSG_W)
  textCentered(panel, 10, 'PRESS SPACE', MIST_LIT, MSG_W)
  return panel
}

function buildEndings() {
  const pieces = [messagePanel('VICTORY'), messagePanel('GAME OVER')]
  const sheet = canvas(MSG_W * pieces.length, MSG_H)
  pieces.forEach((piece, i) => stamp(sheet, piece, i * MSG_W, 0))
  return sheet
}

// ── output ──────────────────────────────────────────────────────────────────

function save(name, target) {
  const png = new PNG({ width: target.width, height: target.height })
  png.data = toRgba(target)
  const file = join(OUT, name)
  writeFileSync(file, PNG.sync.write(png))
  console.log(`${name.padEnd(14)} ${target.width}×${target.height}`)
}

mkdirSync(OUT, { recursive: true })

const atlas = buildAtlas()
save('atlas.png', atlas)

const mist = buildMist()
save('mist.png', mist.sheet)

const boss = buildBoss()
save('boss.png', boss.sheet)

const hud = buildHud()
save('hud.png', hud.sheet)

const endings = buildEndings()
save('endings.png', endings)

save('title.png', buildTitle())
save('credits.png', buildCredits())

console.log(`\natlas: ${ATLAS_CELLS.length} cells of ${CELL}×${CELL}, ${ATLAS_COLS} per row`)
console.log(`mist fragments: ${mist.widths.join(', ')} wide`)
console.log(`boss frames: 2 × ${boss.width}×${boss.height}`)
console.log(`hud strip: ${hud.width}×${HUD_H} (4 bar states + 4 life counts)`)
console.log(`endings strip: ${endings.width}×${MSG_H} (victory, game over)`)
console.log(`vein cycle: palette entries ${VEIN_CYCLE.join(', ')}`)
