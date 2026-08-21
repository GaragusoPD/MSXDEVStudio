import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { normalizeBitmapTiles } from './bitmap-tile'
import { renderResourceFiles } from './resource'
import { blankConverted, encodeIndices, decodeIndices, normalizeScreen } from './screen'
import { sc3Offset, SC3_COLS, SC3_ROWS, SC3_VRAM_BYTES } from './sc3'

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
})

/** Guards the constant the helpers size their buffers from. */
it('sizes the framebuffer at 1536 bytes', () => {
  expect(SC3_VRAM_BYTES).toBe(1536)
})
