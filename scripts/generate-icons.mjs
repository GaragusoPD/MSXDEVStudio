#!/usr/bin/env node
// Generates build/icon.png, build/icon.ico, and resources/icon.png from an
// in-repo pixel-art "MSX" monogram — no external image assets, no SVG editor.
// The pixel data lives right here; edit it and rerun `npm run icons`.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import pngToIco from 'png-to-ico'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// 5x7 pixel font, one glyph per letter needed for the "MSX" monogram.
const FONT = {
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#', '#...#', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  X: ['#...#', '.#.#.', '..#..', '..#..', '..#..', '.#.#.', '#...#']
}

const BG = [0x14, 0x16, 0x2b] // dark slate, matches the app's dark theme
const FG = [0x4c, 0xd9, 0xe8] // bright cyan monogram

// Base pixel-art canvas every output size is nearest-neighbor scaled from.
// 16 (the smallest emitted size) so the base art is only ever upscaled, never
// downscaled — downscaling a hand-drawn 1px-stroke font blurs it past legibility.
const GRID = 16

function drawGlyph(pixels, glyph, ox, oy, color) {
  FONT[glyph].forEach((row, y) => {
    ;[...row].forEach((cell, x) => {
      if (cell === '#') pixels[oy + y][ox + x] = color
    })
  })
}

/** "MS" on the top row, "X" centered underneath — reads as "MSX", roughly square. */
function buildBaseGrid() {
  const pixels = Array.from({ length: GRID }, () => Array.from({ length: GRID }, () => BG))
  const left = Math.floor((GRID - 11) / 2) // "M" + 1px gap + "S" = 11 wide
  const top = Math.floor((GRID - 16) / 2) // two 7-tall rows + 2px gap = 16 tall
  drawGlyph(pixels, 'M', left, top, FG)
  drawGlyph(pixels, 'S', left + 6, top, FG)
  drawGlyph(pixels, 'X', left + 3, top + 9, FG)
  return pixels
}

function rasterize(pixels, size) {
  const png = new PNG({ width: size, height: size })
  for (let y = 0; y < size; y++) {
    const srcY = Math.min(GRID - 1, Math.floor((y * GRID) / size))
    for (let x = 0; x < size; x++) {
      const srcX = Math.min(GRID - 1, Math.floor((x * GRID) / size))
      const [r, g, b] = pixels[srcY][srcX]
      const idx = (size * y + x) << 2
      png.data[idx] = r
      png.data[idx + 1] = g
      png.data[idx + 2] = b
      png.data[idx + 3] = 255
    }
  }
  return PNG.sync.write(png)
}

async function main() {
  const base = buildBaseGrid()
  const sizes = [16, 24, 32, 48, 64, 128, 256, 512]
  const buffers = Object.fromEntries(sizes.map((size) => [size, rasterize(base, size)]))

  mkdirSync(join(ROOT, 'build'), { recursive: true })
  mkdirSync(join(ROOT, 'resources'), { recursive: true })
  writeFileSync(join(ROOT, 'build/icon.png'), buffers[512])
  writeFileSync(join(ROOT, 'resources/icon.png'), buffers[512])

  // electron-builder wants an .ico with the classic Windows icon sizes embedded.
  const ico = await pngToIco([16, 24, 32, 48, 64, 128, 256].map((size) => buffers[size]))
  writeFileSync(join(ROOT, 'build/icon.ico'), ico)

  console.log('Wrote build/icon.png, build/icon.ico, resources/icon.png')
}

main()
