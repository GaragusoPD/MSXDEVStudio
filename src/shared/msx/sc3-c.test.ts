import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { normalizeBitmapTiles } from './bitmap-tile'
import { renderResourceFiles } from './resource'
import { blankConverted, encodeIndices, decodeIndices, normalizeScreen } from './screen'
import { sc3Offset, SC3_COLS, SC3_ROWS, SC3_VRAM_BYTES } from './sc3'
import { normalizeSwSprites, setSwFramePixels } from './swsprite'

/**
 * Compiles the **emitted C itself** with the host compiler and runs it.
 *
 * The MSX side of these helpers is a handful of MSXgl calls; everything else is
 * address arithmetic over a plain byte buffer, and that arithmetic is where a
 * mistake would be invisible — a wrong shift in `_Blit` still compiles, still
 * links, and draws a mess only once a real machine boots. `game-kit-build.test.ts`
 * proves the C compiles and links for a Z80; this proves it *computes the right
 * addresses*, by running it against the same `sc3Pack` the exporter uses.
 *
 * What it does not cover: anything behind the stubs — `VDP_WriteVRAM`, the page
 * flip, `Halt()`. Those need an emulator, and the openMSX screenshot pass in the
 * plan is what checks them.
 *
 * Skipped when there is no `cc`, the same way the MSXgl suites skip without a
 * checkout.
 */
function hasCompiler(): boolean {
  try {
    execFileSync('cc', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Enough of MSXgl to compile the helpers on a desktop. The VRAM calls record
 * what they were asked to write instead of writing it, which is what lets the
 * test assert on the *upload* as well as on the buffer.
 */
const STUB = `
#include <stdio.h>
#include <string.h>
typedef unsigned char u8;
typedef signed char i8;
typedef unsigned short u16;
typedef unsigned short UX;
typedef unsigned short UY;
typedef unsigned char bool;
#define TRUE 1
#define FALSE 0
#define NULL 0
#define VDP_MODE_MULTICOLOR 1
#define COLOR_MERGE(a, b) (u8)(((a) & 0x0F) << 4 | ((b) & 0x0F))

/* The emulated VRAM the stubs write into, so an upload can be checked. */
static u8 g_Vram[0x4000];
static u16 g_PatternBase = 0;
static int g_Uploads = 0;

static void VDP_SetMode(u8 mode) { (void)mode; }
static void VDP_EnableVBlank(bool on) { (void)on; }
static void Halt(void) {}
static void VDP_SetPatternTable(u16 addr) { g_PatternBase = addr; }
static void VDP_WriteVRAM(const u8* src, u16 low, u8 high, u16 count)
{
	(void)high;
	memcpy(g_Vram + low, src, count);
	g_Uploads++;
}
static void VDP_FillVRAM(u8 value, u16 low, u8 high, u16 count)
{
	(void)high;
	memset(g_Vram + low, value, count);
}
static void Mem_Copy(const void* src, void* dest, u16 size) { memcpy(dest, src, size); }
static void Mem_Set(u8 value, void* dest, u16 size) { memset(dest, value, size); }

/* The V9938 blitter, recorded rather than performed — enough to compile and run
   the bitmap-mode helpers, which is what catches a table symbol that does not
   exist. */
#define VDP_OP_TIMP 0
static int g_Commands = 0;
static const u8* g_LastSrc = 0;
static void VDP_CommandHMMC(const u8* src, UX x, UY y, u16 w, u16 h)
{
	(void)x; (void)y; (void)w; (void)h;
	g_LastSrc = src;
	g_Commands++;
}
static void VDP_CommandHMMM(UX sx, UY sy, UX dx, UY dy, u16 w, u16 h)
{
	(void)sx; (void)sy; (void)dx; (void)dy; (void)w; (void)h;
	g_Commands++;
}
static void VDP_CommandLMMM(UX sx, UY sy, UX dx, UY dy, u16 w, u16 h, u8 op)
{
	(void)sx; (void)sy; (void)dx; (void)dy; (void)w; (void)h; (void)op;
	g_Commands++;
}

/* MSXgl's compress module. Only needs to link — these cases assert that the
   unpack helper names a table that exists, not that RLEp works. */
static u16 RLEp_UnpackToRAM(const u8* src, u8* dest) { (void)src; (void)dest; return 0; }
`


function compileAndRun(sources: string[], main: string, dir: string): string {
  const path = join(dir, 'probe.c')
  writeFileSync(path, `${STUB}\n${sources.join('\n')}\n${main}\n`, 'utf-8')
  const binary = join(dir, 'probe')
  // -w: the emitted C is written for SDCC, and the host compiler's opinions
  // about unused statics are not what this test is asking about.
  execFileSync('cc', ['-w', '-std=c99', path, '-o', binary])
  return execFileSync(binary, { encoding: 'utf-8' })
}

/** The screen resource's helpers, with the picture table it refers to. */
function screenSource(pixels: Uint8Array, doubleBuffer: boolean): string {
  const base = normalizeScreen({ mode: 'sc3' })
  const converted = blankConverted('sc3')
  const doc = { ...base, converted: { ...converted, indices: encodeIndices(pixels) } }
  const files = renderResourceFiles({ kind: 'screen', doc }, 'res/play.screen.json', {
    name: 'g_Play',
    format: 'c',
    out: 'content/play.h',
    helpers: true,
    doubleBuffer
  })
  // The header declares and defines the tables; the source defines the helpers.
  // Stripping the include and the pragma is all it takes to paste them together.
  return `${strip(files.header ?? '')}\n${strip(files.source ?? '')}`
}

function strip(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.startsWith('#include') && !line.startsWith('#pragma'))
    .join('\n')
}

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe.runIf(hasCompiler())('the emitted SCREEN 3 C, compiled and run', () => {
  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), 'sc3-c-'))
    dirs.push(dir)
    return dir
  }

  it('plots and reads back the block the exporter would have packed', () => {
    const pixels = new Uint8Array(SC3_COLS * SC3_ROWS)
    const out = compileAndRun(
      [screenSource(pixels, false)],
      `int main(void)
{
	static u8 buf[G_PLAY_SIZE];
	g_Play_Plot(buf, 5, 9, 12);
	g_Play_Plot(buf, 4, 9, 3);
	printf("%d %d %d %d\\n",
		(int)g_Play_Get(buf, 5, 9), (int)g_Play_Get(buf, 4, 9),
		(int)buf[${sc3Offset(4, 9)}], (int)g_Play_Get(buf, 6, 9));
	return 0;
}`,
      scratch()
    )
    // Left block in the high nibble, right in the low, and the byte at the
    // address `sc3Offset` names is the one that changed.
    expect(out.trim()).toBe('12 3 60 0')
  })

  it('blits, saves and restores over the same addresses', () => {
    const pixels = new Uint8Array(SC3_COLS * SC3_ROWS)
    const out = compileAndRun(
      [screenSource(pixels, false)],
      `int main(void)
{
	static u8 buf[G_PLAY_SIZE];
	static u8 under[2 * 4];
	/* A 4x4-block frame: 2 bytes a row, 4 rows. */
	static const u8 frame[8] = { 0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC, 0xDE, 0xF1 };
	int i, dirty = 0;
	g_Play_FillRect(buf, 0, 0, ${SC3_COLS}, ${SC3_ROWS}, 7);
	g_Play_Save(buf, under, 8, 6, 4, 4);
	g_Play_Blit(buf, frame, 8, 6, 4, 4);
	printf("%d %d ", (int)g_Play_Get(buf, 8, 6), (int)g_Play_Get(buf, 9, 6));
	g_Play_Restore(buf, under, 8, 6, 4, 4);
	/* Every block is back to the fill, everywhere. */
	for (i = 0; i < G_PLAY_SIZE; ++i)
		if (buf[i] != 0x77) dirty++;
	printf("%d\\n", dirty);
	return 0;
}`,
      scratch()
    )
    // 0x12 is blocks 1 and 2 side by side, and the restore leaves nothing behind.
    expect(out.trim()).toBe('1 2 0')
  })

  it('uploads only the strips that changed, and the whole picture on FlushAll', () => {
    const pixels = new Uint8Array(SC3_COLS * SC3_ROWS)
    const out = compileAndRun(
      [screenSource(pixels, false)],
      `int main(void)
{
	static u8 buf[G_PLAY_SIZE];
	g_Play_InitScreen();
	g_Play_Plot(buf, 0, 0, 5);
	g_Play_Plot(buf, 62, 40, 6);
	g_Uploads = 0;
	g_Play_Upload(buf);
	/* Two blocks, two strips — not 192, and not one big write. */
	printf("%d ", g_Uploads);
	printf("%d ", (int)g_Vram[0]);
	printf("%d ", (int)g_Vram[${sc3Offset(62, 40)}]);
	g_Uploads = 0;
	g_Play_Upload(buf);
	printf("%d\\n", g_Uploads);
	return 0;
}`,
      scratch()
    )
    const [strips, first, second, again] = out.trim().split(' ')
    expect(strips).toBe('2')
    expect(Number(first)).toBe(0x50)
    expect(Number(second)).toBe(0x60)
    // Nothing changed since, so the flags are clear and nothing is re-sent.
    expect(again).toBe('0')
  })

  it('keeps the two pages in step, each getting every change once', () => {
    const pixels = new Uint8Array(SC3_COLS * SC3_ROWS)
    const out = compileAndRun(
      [screenSource(pixels, true)],
      `int main(void)
{
	static u8 buf[G_PLAY_SIZE];
	g_Play_InitScreen();
	g_Play_Plot(buf, 2, 3, 9);
	g_Play_Flush(buf);   /* writes the back page, then shows it */
	printf("%d %d %d ",
		(int)g_Vram[G_PLAY_PAGE1 + ${sc3Offset(2, 3)}],
		(int)g_Vram[G_PLAY_PAGE0 + ${sc3Offset(2, 3)}],
		(int)g_PatternBase);
	g_Play_Flush(buf);   /* the other page still owes the same change */
	printf("%d %d ", (int)g_Vram[G_PLAY_PAGE0 + ${sc3Offset(2, 3)}], (int)g_PatternBase);
	g_Uploads = 0;
	g_Play_Flush(buf);   /* both pages are current now */
	printf("%d\\n", g_Uploads);
	return 0;
}`,
      scratch()
    )
    const [onPage1, onPage0, shown, caughtUp, shownAgain, uploads] = out.trim().split(' ')
    // One flush reaches one page and displays it; the other still owes the
    // change, which is the whole reason the dirty flags carry a bit per page.
    expect([onPage1, onPage0, shown]).toEqual(['144', '0', '4096'])
    expect([caughtUp, shownAgain]).toEqual(['144', '0'])
    // Both pages current: a third flush sends nothing.
    expect(uploads).toBe('0')
  })

  it('writes a name table whose patterns land where sc3Offset says', () => {
    const pixels = new Uint8Array(SC3_COLS * SC3_ROWS)
    const out = compileAndRun(
      [screenSource(pixels, false)],
      `int main(void)
{
	int row;
	g_Play_InitScreen();
	for (row = 0; row < 24; ++row)
		printf("%d,", (int)g_Vram[G_PLAY_NT + row * 32 + 31]);
	printf("\\n");
	return 0;
}`,
      scratch()
    )
    // Six groups of four rows: 31, 63, 95, 127, 159, 191.
    expect(out.trim()).toBe(
      [31, 31, 31, 31, 63, 63, 63, 63, 95, 95, 95, 95, 127, 127, 127, 127, 159, 159, 159, 159, 191, 191, 191, 191].join(',') +
        ','
    )
  })

  it('blits a tile out of the exported bank at the address the packer used', () => {
    const doc = normalizeBitmapTiles({ mode: 'sc3', width: 4, height: 4, count: 3, transparent: 0 })
    const pixels = decodeIndices(doc.pixels)
    // Tile 2, top-left block only, so a wrong stride shows up as a wrong address.
    pixels[2 * 16] = 11
    pixels[2 * 16 + 3] = 13
    const tiles = renderResourceFiles(
      { kind: 'btiles', doc: { ...doc, pixels: encodeIndices(pixels) } },
      'res/hero.btiles.json',
      { name: 'g_Hero', format: 'c', out: 'content/hero.h', helpers: true }
    )
    const screenPixels = new Uint8Array(SC3_COLS * SC3_ROWS)
    const out = compileAndRun(
      [screenSource(screenPixels, false), strip(tiles.header ?? ''), strip(tiles.source ?? '')],
      `int main(void)
{
	static u8 buf[G_PLAY_SIZE];
	int i, touched = 0;
	g_Play_FillRect(buf, 0, 0, ${SC3_COLS}, ${SC3_ROWS}, 4);
	g_Hero_DrawTileMasked(buf, 2, 10, 12);
	printf("%d %d %d ",
		(int)g_Play_Get(buf, 10, 12), (int)g_Play_Get(buf, 13, 12), (int)g_Play_Get(buf, 11, 12));
	/* Transparent (0) blocks left the fill alone, so only two changed. */
	for (i = 0; i < G_PLAY_SIZE; ++i)
		if (buf[i] != 0x44) touched++;
	printf("%d\\n", touched);
	return 0;
}`,
      scratch()
    )
    const [left, right, gap, touched] = out.trim().split(' ')
    expect([left, right, gap]).toEqual(['11', '13', '4'])
    // Two changed blocks, in two different bytes of the same row.
    expect(touched).toBe('2')
  })
  it('leaves the dirty flags to the caller, which is why the stub marks after a tile blit', () => {
    const doc = normalizeBitmapTiles({ mode: 'sc3', width: 4, height: 4, count: 2, transparent: 0 })
    const pixels = decodeIndices(doc.pixels)
    pixels.fill(6, 16, 32) // tile 1, solid
    const tiles = renderResourceFiles(
      { kind: 'btiles', doc: { ...doc, pixels: encodeIndices(pixels) } },
      'res/hero.btiles.json',
      { name: 'g_Hero', format: 'c', out: 'content/hero.h', helpers: true }
    )
    const out = compileAndRun(
      [screenSource(new Uint8Array(SC3_COLS * SC3_ROWS), false), strip(tiles.header ?? ''), strip(tiles.source ?? '')],
      `int main(void)
{
	static u8 buf[G_PLAY_SIZE];
	g_Play_InitScreen();
	g_Hero_DrawTile(buf, 1, 20, 8);
	g_Uploads = 0;
	g_Play_Upload(buf);
	printf("%d ", g_Uploads);          /* nothing marked, nothing sent */
	g_Play_Mark(20, 8, 4, 4);
	g_Uploads = 0;
	g_Play_Upload(buf);
	printf("%d %d\\n", g_Uploads, (int)g_Vram[${sc3Offset(20, 8)}]);
	return 0;
}`,
      scratch()
    )
    // Two byte-columns wide, one strip row: two strips, and only after _Mark.
    expect(out.trim()).toBe('0 2 102')
  })
  it('draws a software sprite of its own size, masking the transparent index', () => {
    // Two characters with *different* sizes in one sheet — the thing a tileset
    // cannot express, and the reason this resource exists.
    let doc = normalizeSwSprites({
      mode: 'sc3',
      transparent: 0,
      sprites: [
        { name: 'hero', width: 4, height: 4, frames: 2 },
        { name: 'bullet', width: 2, height: 2, frames: 1 }
      ]
    })
    const hero = new Uint8Array(16).fill(7)
    hero[0] = 0 // one transparent corner, so the mask is observable
    doc = setSwFramePixels(doc, 0, 0, hero)
    doc = setSwFramePixels(doc, 1, 0, new Uint8Array(4).fill(12))
    const files = renderResourceFiles({ kind: 'swsprites', doc }, 'res/hero.swsprites.json', {
      name: 'g_Sw',
      format: 'c',
      out: 'content/sw.h',
      helpers: true
    })
    const out = compileAndRun(
      [screenSource(new Uint8Array(SC3_COLS * SC3_ROWS), false), strip(files.header ?? ''), strip(files.source ?? '')],
      `int main(void)
{
	static u8 buf[G_PLAY_SIZE];
	static u8 under[G_SW_SAVE_BYTES];
	g_Play_FillRect(buf, 0, 0, ${SC3_COLS}, ${SC3_ROWS}, 3);
	g_Sw_Save(buf, under, G_SW_HERO, 10, 8);
	g_Sw_Draw(buf, G_SW_HERO, 0, 10, 8);
	printf("%d %d %d %d ",
		(int)g_Play_Get(buf, 10, 8),   /* transparent — the fill shows through */
		(int)g_Play_Get(buf, 11, 8),   /* the sprite */
		(int)g_Sw_Width(G_SW_HERO),
		(int)g_Sw_Width(G_SW_BULLET));
	/* The smaller character draws at its own size, out of the same table. */
	g_Sw_Draw(buf, G_SW_BULLET, 0, 20, 20);
	printf("%d %d ", (int)g_Play_Get(buf, 20, 20), (int)g_Play_Get(buf, 22, 20));
	g_Sw_Restore(buf, under, G_SW_HERO, 10, 8);
	printf("%d\\n", (int)g_Play_Get(buf, 11, 8));
	return 0;
}`,
      scratch()
    )
    // fill shows through the hole, 7 where the sprite is, 4 and 2 wide,
    // the bullet's own 12 then fill beside it, and the restore puts 3 back.
    expect(out.trim()).toBe('3 7 4 2 12 3 3')
  })
  it('windows a world into the buffer, taking the right row out of the right place', () => {
    // A 128x96-block world: twice the display each way.
    const base = normalizeScreen({ mode: 'sc3', width: 128, height: 96 })
    const converted = blankConverted('sc3', 128, 96)
    const indices = decodeIndices(converted.indices)
    // Mark one block well inside the second screenful, so a wrong stride or a
    // wrong start lands somewhere visibly different.
    indices[60 * 128 + 70] = 9
    const doc = { ...base, converted: { ...converted, indices: encodeIndices(indices) } }
    const files = renderResourceFiles({ kind: 'screen', doc }, 'res/world.screen.json', {
      name: 'g_World',
      format: 'c',
      out: 'content/world.h',
      helpers: true
    })
    const out = compileAndRun(
      [strip(files.header ?? ''), strip(files.source ?? '')],
      `int main(void)
{
	static u8 buf[G_WORLD_SIZE];
	g_World_InitScreen();
	/* Camera at (64, 48) puts world (70, 60) at view (6, 12). */
	g_World_DrawWindow(buf, 64, 48);
	printf("%d %d %d\\n",
		(int)g_World_Get(buf, 6, 12),
		(int)g_World_Get(buf, 7, 12),
		(int)G_WORLD_STRIDE);
	return 0;
}`,
      scratch()
    )
    expect(out.trim()).toBe('9 0 64')
  })
  it('names the picture table the exporter actually emitted, in every combination', () => {
    // The suffix is `_Data` only when something else shares the file. Three cases
    // where a helper guessing the wrong one is an undefined symbol, and the only
    // way to see it is to compile.
    const cases: { label: string; doc: ReturnType<typeof normalizeScreen>; compress?: 'rlep' }[] = [
      {
        // sc8: no palette table, so the picture is the bare base name.
        label: 'sc8 world',
        doc: worldDoc('sc8', 320, 256)
      },
      {
        // sc5 world: a palette table exists, so the picture is `_Data`.
        label: 'sc5 world',
        doc: worldDoc('sc5', 320, 256)
      },
      {
        // sc3 compressed: band offsets sit beside it, so `_Data` again — and the
        // unpack helper has to name the same one.
        label: 'sc3 compressed',
        doc: worldDoc('sc3', 64, 48),
        compress: 'rlep'
      }
    ]
    for (const entry of cases) {
      const files = renderResourceFiles({ kind: 'screen', doc: entry.doc }, 'res/world.screen.json', {
        name: 'g_World',
        format: 'c',
        out: 'content/world.h',
        helpers: true,
        compress: entry.compress
      })
      // Compiling is the assertion: an undefined symbol is an error, not a diff.
      expect(() =>
        compileAndRun(
          [strip(files.header ?? ''), strip(files.source ?? '')],
          'int main(void) { printf("ok\\n"); return 0; }',
          scratch()
        )
      , entry.label).not.toThrow()
    }
  })
})

/** A picture of a given size, with a conversion to match. */
function worldDoc(mode: 'sc3' | 'sc5' | 'sc8', width: number, height: number): ReturnType<typeof normalizeScreen> {
  const base = normalizeScreen({ mode, width, height })
  return { ...base, converted: blankConverted(mode, width, height) }
}

/** Guards the constant the helpers size their buffers from. */
it('sizes the framebuffer at 1536 bytes', () => {
  expect(SC3_VRAM_BYTES).toBe(1536)
})
