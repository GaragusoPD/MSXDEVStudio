/**
 * SCREEN 3 (MULTICOLOR) — the one thing about this mode that no other mode
 * shares: where a block lives in VRAM, and the C that MSXgl does not ship.
 *
 * SCREEN 3 is 64×48 blocks of 4×4 dots, one of the fixed 16 colours each, two
 * blocks to a byte — **no colour clash**, which is what makes it the MSX1 mode
 * for chunky-pixel games. Its document is one palette index per block, which is
 * exactly `ScreenDoc` / `BitmapTilesDoc`, so those carry it; only the bytes and
 * the emitted C differ, and both live here.
 *
 * ## The two runtime shapes
 *
 * The name table decides which one a game is in, and it can only be in one:
 *
 * - **Framebuffer.** The name table holds a fixed boilerplate that makes the
 *   pattern table a linear 1536-byte bitmap. Full freedom, per-block plotting,
 *   software sprites, page flipping. A full upload is ~64 % of a 50 Hz frame, so
 *   the runtime uploads only the 8-byte strips that changed.
 * - **Name table.** The pattern table holds ≤256 tiles of 2×2 blocks and the
 *   name table *is* the map, written with `VDP_WriteLayout_GM2` exactly as in
 *   SCREEN 1/2 — 768 bytes for a whole screen, a couple of dozen for a scroll
 *   edge. This is the one that scrolls, and MSXgl's `scroll` module drives it
 *   unchanged.
 *
 * ## The address, and why it collapses
 *
 * The VDP reads a cell's pattern at `name * 8 + (cy & 3) * 2 + (by & 1)`, so
 * the canonical name table `NT[cx,cy] = (cy >> 2) * 32 + cx` turns the pattern
 * table into a bitmap whose byte for block *(x, y)* is
 *
 *     ((y & 0xF8) << 5) | ((x >> 1) << 3) | (y & 7)
 *
 * bijective onto 0..1535 (`sc3.test.ts` checks all 3072 blocks). Two facts fall
 * out of it and the whole runtime is built on them:
 *
 * - the low three bits are `y`, so **8 consecutive bytes are an 8×32-dot column
 *   strip** — the unit a dirty-rect upload works in, and there are exactly 192;
 * - `y & 1` picks the byte, so vertical motion is free at 4 dots while
 *   horizontal is byte-aligned at 8.
 */

import type { HelperC } from './emitC'

/** Blocks across. */
export const SC3_COLS = 64
/** Blocks down. */
export const SC3_ROWS = 48
/** Dots per side of one block. */
export const SC3_BLOCK_DOTS = 4
/** The framebuffer, two blocks per byte. */
export const SC3_VRAM_BYTES = (SC3_COLS * SC3_ROWS) / 2
/** 8 contiguous bytes each; the dirty-upload unit. */
export const SC3_STRIP_BYTES = 8
export const SC3_STRIPS = SC3_VRAM_BYTES / SC3_STRIP_BYTES
/** Name table, where `VDP_SetModeMultiColor` puts it. Shared by both pages. */
export const SC3_NT_ADDR = 0x0800
/**
 * The two pattern-table bases. R#4 selects it in 2 KB steps, the name table
 * holds indices rather than addresses, and 0x0800/0x1B00/0x3800 (NT/SAT/SPT)
 * fall outside both — so the whole framebuffer swaps with one register write.
 */
export const SC3_PAGE_ADDR = [0x0000, 0x1000] as const
/** Tiles are one name-table entry: 2×2 blocks, and nothing else can be. */
export const SC3_TILE_BLOCKS = 2
/** A pattern is 8 bytes, which is the tile's 2 repeated four times. */
export const SC3_PATTERN_BYTES = 8

/** The VRAM byte holding block `(x, y)`. `x & 1` picks the nibble: 0 = high = left. */
export function sc3Offset(x: number, y: number): number {
  return ((y & 0xf8) << 5) | ((x >> 1) << 3) | (y & 7)
}

/** Which of the 192 column strips block `(x, y)` falls in. `sc3Offset` of its top block is `strip * 8`. */
export function sc3Strip(x: number, y: number): number {
  return ((y >> 3) << 5) | (x >> 1)
}

/**
 * Row-major block indices → VRAM-order bytes.
 *
 * `width`/`height` are the source grid, so this also packs a fragment or a tile
 * — anything smaller than the screen writes into the top-left of the buffer and
 * the caller reads back the range it cares about. Out-of-range blocks are
 * ignored rather than throwing: a document larger than the mode is a validation
 * problem, not a packing one.
 */
export function sc3Pack(indices: ArrayLike<number>, width: number, height: number): Uint8Array {
  const out = new Uint8Array(SC3_VRAM_BYTES)
  for (let y = 0; y < height && y < SC3_ROWS; y++) {
    for (let x = 0; x < width && x < SC3_COLS; x++) {
      const value = indices[y * width + x] & 0x0f
      const at = sc3Offset(x, y)
      out[at] = x & 1 ? (out[at] & 0xf0) | value : (out[at] & 0x0f) | (value << 4)
    }
  }
  return out
}

/**
 * The 768 name-table bytes that make the pattern table a bitmap.
 *
 * Emitted as a loop rather than a table in the generated C — 768 bytes of ROM
 * against about twenty of code — so this exists for the tests and for anyone
 * who wants the bytes.
 */
export function sc3NameTable(): Uint8Array {
  const out = new Uint8Array(32 * 24)
  for (let row = 0; row < 24; row++) {
    for (let col = 0; col < 32; col++) out[row * 32 + col] = ((row >> 2) * 32 + col) & 0xff
  }
  return out
}

/**
 * Tiles → the pattern table, for the name-table shape.
 *
 * A tile is 2×2 blocks = 2 bytes, but a pattern is 8 and which 2 of them the
 * VDP reads depends on the screen row (`(cy & 3) * 2`). Repeating the pair four
 * times is what makes a tile look the same wherever it is placed — without it a
 * tile would render as three other tiles at three quarters of the rows.
 */
export function sc3PatternBytes(pixels: ArrayLike<number>, count: number): Uint8Array {
  const out = new Uint8Array(count * SC3_PATTERN_BYTES)
  for (let tile = 0; tile < count; tile++) {
    const base = tile * 4
    const top = ((pixels[base] & 0x0f) << 4) | (pixels[base + 1] & 0x0f)
    const bottom = ((pixels[base + 2] & 0x0f) << 4) | (pixels[base + 3] & 0x0f)
    for (let phase = 0; phase < 4; phase++) {
      out[tile * SC3_PATTERN_BYTES + phase * 2] = top
      out[tile * SC3_PATTERN_BYTES + phase * 2 + 1] = bottom
    }
  }
  return out
}

/** How many bytes one `width × height` block image takes, packed for the blitter. */
export function sc3LinearBytes(width: number, height: number): number {
  return Math.ceil(width / 2) * height
}

/**
 * One block image → blit data: row-major, `ceil(width / 2)` bytes per row, high
 * nibble first.
 *
 * Deliberately **not** `sc3Pack`. That order exists because the VDP reads it;
 * this data is read linearly by the blitter, which then writes to computed
 * addresses, so it is laid out for the reader. Widths are even by the time a
 * document gets here (`normalizeBitmapTiles`), so the stride divides cleanly and
 * a blit is a byte copy per source byte.
 *
 * `stride` overrides the source row length, for cutting a rectangle out of a
 * bigger image — which is what a fragment is.
 */
export function sc3LinearPack(
  pixels: ArrayLike<number>,
  x: number,
  y: number,
  width: number,
  height: number,
  stride: number
): Uint8Array {
  const bytes = Math.ceil(width / 2)
  const out = new Uint8Array(bytes * height)
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const value = (pixels[(y + row) * stride + x + col] ?? 0) & 0x0f
      const at = row * bytes + (col >> 1)
      out[at] = col & 1 ? (out[at] & 0xf0) | value : (out[at] & 0x0f) | (value << 4)
    }
  }
  return out
}

/** The whole tile bank as blit data, tiles end to end — what `_DrawTile` indexes. */
export function sc3TileBytes(pixels: ArrayLike<number>, count: number, width: number, height: number): Uint8Array {
  const each = sc3LinearBytes(width, height)
  const out = new Uint8Array(count * each)
  for (let tile = 0; tile < count; tile++) {
    // Every tile is its own image in `pixels`, so the source stride is the tile
    // width and the offset is a whole number of tiles.
    const slice = new Uint8Array(width * height)
    for (let i = 0; i < slice.length; i++) slice[i] = pixels[tile * width * height + i] ?? 0
    out.set(sc3LinearPack(slice, 0, 0, width, height, width), tile * each)
  }
  return out
}

// ── emitted C ───────────────────────────────────────────────────────────────

/** Uppercase C-identifier form, matching `emitC.ts`'s `defineName`. */
function prefixOf(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()
}

/**
 * The `#define`s every SCREEN 3 helper reads. Emitted by whichever resource
 * owns the screen, so the geometry is stated once in the header the game sees.
 */
export function sc3Constants(name: string, doubleBuffer: boolean): string[] {
  const prefix = prefixOf(name)
  return [
    `#define ${prefix}_W ${SC3_COLS}`,
    `#define ${prefix}_H ${SC3_ROWS}`,
    `#define ${prefix}_SIZE ${SC3_VRAM_BYTES}`,
    `#define ${prefix}_STRIPS ${SC3_STRIPS}`,
    `#define ${prefix}_NT 0x${SC3_NT_ADDR.toString(16).toUpperCase().padStart(4, '0')}`,
    `#define ${prefix}_PAGE0 0x${SC3_PAGE_ADDR[0].toString(16).toUpperCase().padStart(4, '0')}`,
    ...(doubleBuffer ? [`#define ${prefix}_PAGE1 0x${SC3_PAGE_ADDR[1].toString(16).toUpperCase().padStart(4, '0')}`] : [])
  ]
}

/**
 * The whole framebuffer runtime: mode setup, per-block access, software
 * sprites, and the dirty-strip upload — with or without the page flip.
 *
 * All of it calls MSXgl (`VDP_SetMode`, `VDP_WriteVRAM`, `VDP_SetPatternTable`,
 * `Mem_Copy`) and reimplements none of it. In particular the upload is
 * `VDP_WriteVRAM`, whose inner loop is hand-written `outi` assembly tuned to
 * the MSX1 29-cc VRAM floor — nothing written in C would be faster.
 *
 * The game owns the shadow buffer (`u8 buf[..._SIZE]`) rather than this
 * declaring one, so a game with two playfields can have two, and a game that
 * only draws a static picture can have none and call `_Draw()`.
 */
export function sc3ScreenHelperC(
  name: string,
  table: string,
  doubleBuffer: boolean,
  hasFragments: boolean
): HelperC {
  const prefix = prefixOf(name)
  const header: string[] = [
    '',
    `// ── ${name}: SCREEN 3, as a 64×48 framebuffer ─────────────────────────`,
    '//',
    '// The name table is boilerplate that makes the pattern table a bitmap, so',
    `// ${name}_InitScreen() must run before anything else here — MSXgl's`,
    '// VDP_SetModeMultiColor() sets the registers but writes no name table.',
    '//',
    '// Coordinates are blocks: 0..63 across, 0..47 down, each 4×4 dots. Every',
    '// drawing call takes the shadow buffer to work in, which you declare:',
    '//',
    `//   u8 g_Screen[${prefix}_SIZE];`,
    '//',
    '// Nothing reaches the screen until a flush. Horizontal positions and widths',
    '// must be even (a byte is two side-by-side blocks); vertical is free.',
    '//',
    '// Nothing here clips: a blit that runs off the right or bottom edge writes',
    '// past the buffer. Keep x + w within _W and y + h within _H — an off-screen',
    '// object is a `if(visible)` in your code, not a cost this pays every call.',
    '//',
    `// Needs msxgl.h included before this header, VDP_USE_MODE_MC TRUE, and`,
    '// MSXgl\'s "memory" library module for Mem_Copy/Mem_Set.',
    '//',
    '// Example, once per frame:',
    `//   ${name}_Restore(g_Screen, g_Under, g_X, g_Y, 4, 4);`,
    '//   /* move */',
    `//   ${name}_Save(g_Screen, g_Under, g_X, g_Y, 4, 4);`,
    `//   ${name}_BlitMasked(g_Screen, g_Hero, g_X, g_Y, 4, 4);`,
    `//   ${name}_Flush(g_Screen);`,
    '',
    `void ${name}_InitScreen(void);`,
    `void ${name}_Draw(void);`,
    `void ${name}_ToBuffer(u8* buf);`,
    `void ${name}_Clear(u8* buf, u8 colour);`,
    `void ${name}_Plot(u8* buf, u8 x, u8 y, u8 colour);`,
    `u8   ${name}_Get(const u8* buf, u8 x, u8 y);`,
    `void ${name}_FillRect(u8* buf, u8 x, u8 y, u8 w, u8 h, u8 colour);`,
    `void ${name}_Blit(u8* buf, const u8* src, u8 x, u8 y, u8 w, u8 h);`,
    `void ${name}_BlitMasked(u8* buf, const u8* src, u8 x, u8 y, u8 w, u8 h, u8 trans);`,
    `void ${name}_Save(const u8* buf, u8* save, u8 x, u8 y, u8 w, u8 h);`,
    `void ${name}_Restore(u8* buf, const u8* save, u8 x, u8 y, u8 w, u8 h);`,
    `void ${name}_Mark(u8 x, u8 y, u8 w, u8 h);`,
    `void ${name}_Upload(const u8* buf);`,
    `void ${name}_Flush(const u8* buf);`,
    `void ${name}_FlushAll(const u8* buf);`,
    ...(hasFragments
      ? [
          '',
          `// The same four operations by fragment number (${prefix}_<NAME>), which is`,
          `// what makes a fragment a software-sprite frame: the size comes out of`,
          `// ${name}_Rects, so nothing has to carry it around.`,
          `void ${name}_DrawFrame(u8* buf, u8 frame, u8 x, u8 y);`,
          `void ${name}_DrawFrameMasked(u8* buf, u8 frame, u8 x, u8 y, u8 trans);`,
          `void ${name}_SaveFrame(const u8* buf, u8* save, u8 frame, u8 x, u8 y);`,
          `void ${name}_RestoreFrame(u8* buf, const u8* save, u8 frame, u8 x, u8 y);`
        ]
      : [])
  ]

  if (doubleBuffer) {
    header.push(
      '',
      '// Double buffered: the two pages are two pattern tables and the flip is one',
      '// R#4 write, so nothing is copied. _Flush() uploads what changed, waits for',
      '// the interrupt and flips; call _Upload()/_Flip() separately if your loop',
      '// already has its own vertical-sync wait.',
      `void ${name}_Flip(void);`
    )
  }

  const source: string[] = [
    '',
    `u8 ${name}_Dirty[${prefix}_STRIPS];`,
    ...(doubleBuffer
      ? [
          '// Which page the next upload writes to; the other one is on screen.',
          `u8 ${name}_Back = 1;`
        ]
      : []),
    '',
    '// The byte holding block (x, y). Bits 2-0 are y, which is why eight',
    '// consecutive bytes are one 8×32-dot column strip.',
    `static u16 ${name}_Offset(u8 x, u8 y)`,
    '{',
    '\treturn ((u16)(y & 0xF8) << 5) | ((u16)(x >> 1) << 3) | (y & 7);',
    '}',
    '',
    `static void ${name}_Poke(u8* buf, u8 x, u8 y, u8 colour)`,
    '{',
    `\tu8* p = buf + ${name}_Offset(x, y);`,
    '\tif(x & 1)',
    '\t\t*p = (*p & 0xF0) | (colour & 0x0F);',
    '\telse',
    '\t\t*p = (*p & 0x0F) | (colour << 4);',
    '}',
    '',
    '// The name table: 32 pattern indices per row, the same 32 for four rows in a',
    '// row, because the VDP takes a different 2-byte slice of each pattern per row.',
    `void ${name}_InitScreen(void)`,
    '{',
    '\tu8 row[32];',
    '\tu8 y, i;',
    '\tVDP_SetMode(VDP_MODE_MULTICOLOR);',
    '\tfor(y = 0; y < 24; ++y)',
    '\t{',
    '\t\tu8 base = (y & 0xFC) << 3;',
    '\t\tfor(i = 0; i < 32; ++i)',
    '\t\t\trow[i] = base + i;',
    `\t\tVDP_WriteVRAM(row, ${prefix}_NT + ((u16)y << 5), 0, 32);`,
    '\t}',
    ...(doubleBuffer
      ? [
          `\tVDP_FillVRAM(0, ${prefix}_PAGE0, 0, ${prefix}_SIZE);`,
          `\tVDP_FillVRAM(0, ${prefix}_PAGE1, 0, ${prefix}_SIZE);`,
          `\tVDP_SetPatternTable(${prefix}_PAGE0);`,
          `\t${name}_Back = 1;`,
          '\t// _Flush() waits on Halt(), which never returns without this.',
          '\tVDP_EnableVBlank(TRUE);'
        ]
      : [`\tVDP_FillVRAM(0, ${prefix}_PAGE0, 0, ${prefix}_SIZE);`]),
    `\tMem_Set(0, ${name}_Dirty, ${prefix}_STRIPS);`,
    '}',
    '',
    '// The picture straight into VRAM, no shadow buffer involved — for a title',
    '// screen that never changes.',
    `void ${name}_Draw(void)`,
    '{',
    ...(doubleBuffer
      ? [
          `\tVDP_WriteVRAM(${table}, ${prefix}_PAGE0, 0, ${prefix}_SIZE);`,
          `\tVDP_WriteVRAM(${table}, ${prefix}_PAGE1, 0, ${prefix}_SIZE);`
        ]
      : [`\tVDP_WriteVRAM(${table}, ${prefix}_PAGE0, 0, ${prefix}_SIZE);`]),
    '}',
    '',
    `void ${name}_ToBuffer(u8* buf)`,
    '{',
    `\tMem_Copy(${table}, buf, ${prefix}_SIZE);`,
    `\t${name}_Mark(0, 0, ${prefix}_W, ${prefix}_H);`,
    '}',
    '',
    `void ${name}_Clear(u8* buf, u8 colour)`,
    '{',
    `\tMem_Set((colour << 4) | (colour & 0x0F), buf, ${prefix}_SIZE);`,
    `\t${name}_Mark(0, 0, ${prefix}_W, ${prefix}_H);`,
    '}',
    '',
    `void ${name}_Plot(u8* buf, u8 x, u8 y, u8 colour)`,
    '{',
    `\t${name}_Poke(buf, x, y, colour);`,
    `\t${name}_Mark(x, y, 1, 1);`,
    '}',
    '',
    '// What colour is already at this block — the collision test a chunky game',
    '// uses, since there is no tilemap to look anything up in.',
    `u8 ${name}_Get(const u8* buf, u8 x, u8 y)`,
    '{',
    `\tu8 v = buf[${name}_Offset(x, y)];`,
    '\treturn (x & 1) ? (v & 0x0F) : (v >> 4);',
    '}',
    '',
    `void ${name}_FillRect(u8* buf, u8 x, u8 y, u8 w, u8 h, u8 colour)`,
    '{',
    '\tu8 row, col;',
    '\tfor(row = 0; row < h; ++row)',
    '\t\tfor(col = 0; col < w; ++col)',
    `\t\t\t${name}_Poke(buf, x + col, y + row, colour);`,
    `\t${name}_Mark(x, y, w, h);`,
    '}',
    '',
    '// `src` is one frame: ceil(w/2) bytes per row, high nibble = left block.',
    '// Stepping one byte right in the source is eight bytes on in VRAM order,',
    '// which is why the inner loop shifts rather than increments.',
    `void ${name}_Blit(u8* buf, const u8* src, u8 x, u8 y, u8 w, u8 h)`,
    '{',
    '\tu8 stride = (w + 1) >> 1;',
    '\tu8 row, col;',
    '\tfor(row = 0; row < h; ++row)',
    '\t{',
    `\t\tu16 d = ${name}_Offset(x, y + row);`,
    '\t\tfor(col = 0; col < stride; ++col)',
    '\t\t\tbuf[d + ((u16)col << 3)] = *src++;',
    '\t}',
    `\t${name}_Mark(x, y, w, h);`,
    '}',
    '',
    '// The same, leaving blocks of colour `trans` alone — a sprite over a background.',
    `void ${name}_BlitMasked(u8* buf, const u8* src, u8 x, u8 y, u8 w, u8 h, u8 trans)`,
    '{',
    '\tu8 stride = (w + 1) >> 1;',
    '\tu8 pair = (trans << 4) | (trans & 0x0F);',
    '\tu8 row, col;',
    '\tfor(row = 0; row < h; ++row)',
    '\t{',
    `\t\tu16 d = ${name}_Offset(x, y + row);`,
    '\t\tfor(col = 0; col < stride; ++col)',
    '\t\t{',
    '\t\t\tu8 v = *src++;',
    '\t\t\tu8* p = buf + d + ((u16)col << 3);',
    '\t\t\tif(v == pair)',
    '\t\t\t\tcontinue;',
    '\t\t\tif((v >> 4) == trans)',
    '\t\t\t\t*p = (*p & 0xF0) | (v & 0x0F);',
    '\t\t\telse if((v & 0x0F) == trans)',
    '\t\t\t\t*p = (*p & 0x0F) | (v & 0xF0);',
    '\t\t\telse',
    '\t\t\t\t*p = v;',
    '\t\t}',
    '\t}',
    `\t${name}_Mark(x, y, w, h);`,
    '}',
    '',
    '// `save` holds ceil(w/2) * h bytes — the background a sprite is about to',
    '// cover, so the next frame can put it back without redrawing the world.',
    `void ${name}_Save(const u8* buf, u8* save, u8 x, u8 y, u8 w, u8 h)`,
    '{',
    '\tu8 stride = (w + 1) >> 1;',
    '\tu8 row, col;',
    '\tfor(row = 0; row < h; ++row)',
    '\t{',
    `\t\tu16 d = ${name}_Offset(x, y + row);`,
    '\t\tfor(col = 0; col < stride; ++col)',
    '\t\t\t*save++ = buf[d + ((u16)col << 3)];',
    '\t}',
    '}',
    '',
    `void ${name}_Restore(u8* buf, const u8* save, u8 x, u8 y, u8 w, u8 h)`,
    '{',
    `\t${name}_Blit(buf, save, x, y, w, h);`,
    '}',
    '',
    '// Flags every column strip the rectangle touches. Both page bits, because',
    '// both copies in VRAM are now out of date.',
    `void ${name}_Mark(u8 x, u8 y, u8 w, u8 h)`,
    '{',
    '\tu8 sx = x >> 1;',
    '\tu8 ex, sy, ey, cx, cy;',
    '\tif((w == 0) || (h == 0))',
    '\t\treturn;',
    '\tex = (u8)(x + w - 1) >> 1;',
    '\tsy = y >> 3;',
    '\tey = (u8)(y + h - 1) >> 3;',
    '\tfor(cy = sy; cy <= ey; ++cy)',
    '\t\tfor(cx = sx; cx <= ex; ++cx)',
    `\t\t\t${name}_Dirty[((u16)cy << 5) + cx] = 0x03;`,
    '}',
    '',
    `void ${name}_Upload(const u8* buf)`,
    '{',
    ...(doubleBuffer
      ? [
          `\tu8 mask = 1 << ${name}_Back;`,
          `\tu16 base = ${name}_Back ? ${prefix}_PAGE1 : ${prefix}_PAGE0;`
        ]
      : ['\tu8 mask = 0x03;', `\tu16 base = ${prefix}_PAGE0;`]),
    '\tu8 i;',
    `\tfor(i = 0; i < ${prefix}_STRIPS; ++i)`,
    '\t{',
    `\t\tif(${name}_Dirty[i] & mask)`,
    '\t\t{',
    '\t\t\tu16 off = (u16)i << 3;',
    '\t\t\tVDP_WriteVRAM(buf + off, base + off, 0, 8);',
    `\t\t\t${name}_Dirty[i] &= ~mask;`,
    '\t\t}',
    '\t}',
    '}',
    ...(doubleBuffer
      ? [
          '',
          '// One register write swaps the whole picture: the name table holds pattern',
          '// indices, so pointing R#4 at the other pattern table is the flip.',
          `void ${name}_Flip(void)`,
          '{',
          `\tVDP_SetPatternTable(${name}_Back ? ${prefix}_PAGE1 : ${prefix}_PAGE0);`,
          `\t${name}_Back ^= 1;`,
          '}'
        ]
      : []),
    '',
    `void ${name}_Flush(const u8* buf)`,
    '{',
    `\t${name}_Upload(buf);`,
    ...(doubleBuffer
      ? [
          '\t// Flip on the interrupt so the raster never shows half of each page.',
          '\tHalt();',
          `\t${name}_Flip();`
        ]
      : []),
    '}',
    '',
    '// Every strip, ignoring the flags — for a screen transition, where the whole',
    '// picture changed and walking 192 flags to discover that is wasted work.',
    `void ${name}_FlushAll(const u8* buf)`,
    '{',
    ...(doubleBuffer
      ? [
          `\tu8 mask = 1 << ${name}_Back;`,
          `\tu16 base = ${name}_Back ? ${prefix}_PAGE1 : ${prefix}_PAGE0;`
        ]
      : ['\tu8 mask = 0x03;', `\tu16 base = ${prefix}_PAGE0;`]),
    '\tu8 i;',
    `\tVDP_WriteVRAM(buf, base, 0, ${prefix}_SIZE);`,
    `\tfor(i = 0; i < ${prefix}_STRIPS; ++i)`,
    `\t\t${name}_Dirty[i] &= ~mask;`,
    ...(doubleBuffer ? ['\tHalt();', `\t${name}_Flip();`] : []),
    '}',
    ...(hasFragments
      ? [
          '',
          `// _Rects is offsetLo, offsetHi, width, height per fragment — the offset`,
          `// being where that frame's bytes start in ${name}_Strip.`,
          `static const u8* ${name}_Frame(u8 frame)`,
          '{',
          `\tconst u8* rect = ${name}_Rects + ((u16)frame << 2);`,
          `\treturn ${name}_Strip + (rect[0] | ((u16)rect[1] << 8));`,
          '}',
          '',
          `void ${name}_DrawFrame(u8* buf, u8 frame, u8 x, u8 y)`,
          '{',
          `\tconst u8* rect = ${name}_Rects + ((u16)frame << 2);`,
          `\t${name}_Blit(buf, ${name}_Frame(frame), x, y, rect[2], rect[3]);`,
          '}',
          '',
          `void ${name}_DrawFrameMasked(u8* buf, u8 frame, u8 x, u8 y, u8 trans)`,
          '{',
          `\tconst u8* rect = ${name}_Rects + ((u16)frame << 2);`,
          `\t${name}_BlitMasked(buf, ${name}_Frame(frame), x, y, rect[2], rect[3], trans);`,
          '}',
          '',
          `void ${name}_SaveFrame(const u8* buf, u8* save, u8 frame, u8 x, u8 y)`,
          '{',
          `\tconst u8* rect = ${name}_Rects + ((u16)frame << 2);`,
          `\t${name}_Save(buf, save, x, y, rect[2], rect[3]);`,
          '}',
          '',
          `void ${name}_RestoreFrame(u8* buf, const u8* save, u8 frame, u8 x, u8 y)`,
          '{',
          `\tconst u8* rect = ${name}_Rects + ((u16)frame << 2);`,
          `\t${name}_Restore(buf, save, x, y, rect[2], rect[3]);`,
          '}'
        ]
      : [])
  ]

  return { header, source }
}

/**
 * The tileset side. One table serves both runtime shapes, because for a 2×2 tile
 * they are the same bytes: a pattern is the tile's two bytes repeated four times,
 * so the blitter reads the first two of every eight and the VDP reads whichever
 * two the screen row calls for. A larger tile has no name-table shape at all and
 * gets the packed blit table instead.
 *
 * That is why `_Upload` appears only at 2×2 — not a policy, just what a name
 * entry can hold.
 *
 * The tileset emits its own copy of the address arithmetic rather than calling
 * the screen resource's: they are separate files, the exporter renders one at a
 * time and never opens the other, and a tileset may well be the only SCREEN 3
 * resource in a project.
 */
export function sc3TileHelperC(
  name: string,
  width: number,
  height: number,
  count: number,
  transparent: number | null
): HelperC {
  const nameTable = width === SC3_TILE_BLOCKS && height === SC3_TILE_BLOCKS
  // Bytes per row of a tile inside the table, and the step from one tile to the
  // next. At 2×2 the step is the 8-byte pattern, of which the blitter reads two.
  const rowBytes = nameTable ? 1 : Math.ceil(width / 2)
  const tileBytes = nameTable ? SC3_PATTERN_BYTES : rowBytes * height
  const table = nameTable ? `${name}_Patterns` : `${name}_Tiles`
  const header: string[] = [
    '',
    `// ── ${name}: SCREEN 3 tiles ───────────────────────────────────────────`,
    '//',
    `// ${count} tiles of ${width}×${height} blocks (${width * SC3_BLOCK_DOTS}×${height * SC3_BLOCK_DOTS} dots).`,
    '//',
    ...(nameTable
      ? [
          '// 2×2 blocks is exactly one name-table entry, so this set works both ways',
          `// off the one table: ${name}_Upload() loads ${table} into the pattern`,
          '// table and a map then draws through the VDP with VDP_WriteLayout_GM2 —',
          '// 768 bytes for a whole screen — or the blitters below draw tiles into a',
          '// shadow buffer for a chunky playfield. A game picks one; the name table',
          '// cannot be a map and the framebuffer boilerplate at the same time.',
          '//',
          '// A pattern is the tile\'s two bytes repeated four times. Without that it',
          '// would draw as three other tiles at three quarters of the screen rows.',
          '//'
        ]
      : [
          '// Bigger than a name-table entry, so these are blitted rather than drawn',
          '// through the VDP: the tiles go into a shadow buffer and the screen',
          '// resource\'s _Flush() puts them on screen.',
          '//'
        ]),
    '// `x` must be even — two blocks share a VRAM byte and this copies bytes.',
    '//',
    `// These do **not** mark the strips they touched: the screen resource owns`,
    '// the dirty flags and is a different header, which the exporter never opens.',
    `// Call its _Mark(x, y, ${width}, ${height}) after drawing, or the next _Flush()`,
    '// will not know anything changed.',
    '//',
    '// Needs msxgl.h included before this header.',
    '',
    ...(nameTable ? [`void ${name}_Upload(void);`] : []),
    `void ${name}_DrawTile(u8* buf, u8 tile, u8 x, u8 y);`,
    `void ${name}_DrawTileMasked(u8* buf, u8 tile, u8 x, u8 y);`
  ]

  const blit = (masked: boolean): string[] => [
    `\tconst u8* src = ${table} + ((u16)tile * ${tileBytes});`,
    '\tu8 row, col;',
    `\tfor(row = 0; row < ${height}; ++row)`,
    '\t{',
    `\t\tu16 d = ${name}_Offset(x, y + row);`,
    `\t\tfor(col = 0; col < ${rowBytes}; ++col)`,
    ...(masked
      ? [
          '\t\t{',
          '\t\t\tu8 v = *src++;',
          '\t\t\tu8* p = buf + d + ((u16)col << 3);',
          `\t\t\tif(v == 0x${((((transparent ?? 0) << 4) | (transparent ?? 0)) & 0xff).toString(16).toUpperCase().padStart(2, '0')})`,
          '\t\t\t\tcontinue;',
          `\t\t\tif((v >> 4) == ${transparent})`,
          '\t\t\t\t*p = (*p & 0xF0) | (v & 0x0F);',
          `\t\t\telse if((v & 0x0F) == ${transparent})`,
          '\t\t\t\t*p = (*p & 0x0F) | (v & 0xF0);',
          '\t\t\telse',
          '\t\t\t\t*p = v;',
          '\t\t}'
        ]
      : ['\t\t\tbuf[d + ((u16)col << 3)] = *src++;']),
    '\t}',
    ...(nameTable && height > 1 ? [] : [])
  ]

  const source: string[] = [
    '',
    `static u16 ${name}_Offset(u8 x, u8 y)`,
    '{',
    '\treturn ((u16)(y & 0xF8) << 5) | ((u16)(x >> 1) << 3) | (y & 7);',
    '}',
    ...(nameTable
      ? [
          '',
          `void ${name}_Upload(void)`,
          '{',
          `\tVDP_WriteVRAM(${table}, 0x0000, 0, ${count * SC3_PATTERN_BYTES});`,
          '}'
        ]
      : []),
    '',
    `void ${name}_DrawTile(u8* buf, u8 tile, u8 x, u8 y)`,
    '{',
    ...blit(false),
    '}',
    '',
    ...(transparent === null
      ? [
          `// This tileset has no transparent colour set, so this is ${name}_DrawTile.`,
          '// Pick one in the editor to get a real mask — that is what turns a tile',
          '// bank into a software-sprite sheet.'
        ]
      : [`// Blocks of colour ${transparent} are left alone, so a frame drawn with this`, '// shows the background through its gaps.']),
    `void ${name}_DrawTileMasked(u8* buf, u8 tile, u8 x, u8 y)`,
    '{',
    ...(transparent === null ? [`\t${name}_DrawTile(buf, tile, x, y);`] : blit(true)),
    '}'
  ]

  return { header, source }
}
