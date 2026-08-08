#!/usr/bin/env node
// Generates build/icon.png, build/icon.ico and resources/icon.png from the
// project's own logo, `docs/images/MSXDEVStudio_logo_icon.png`. Edit that file
// and rerun `npm run icons`.
//
// This used to draw an "MSX" monogram from a pixel font embedded in this
// script. That shipped the bare trademark as the application icon, which is
// exactly what the rebrand to MSXDEVStudio is meant to avoid — so the icon is
// now the project's own mark, and there is one source of truth for it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import pngToIco from 'png-to-ico'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'docs/images/MSXDEVStudio_logo_icon.png')

/**
 * Box-average downscale to `size`x`size`.
 *
 * Averaging rather than nearest-neighbour because the emitted sizes are not all
 * integer divisors of the source (48 and 24 are not), and dropping pixels at
 * those ratios eats whole strokes of the lettering. Averaging blurs instead,
 * which at 24px is the lesser evil.
 */
function downscale(source, size) {
  const out = new PNG({ width: size, height: size })
  const scaleX = source.width / size
  const scaleY = source.height / size

  for (let y = 0; y < size; y++) {
    const y0 = Math.floor(y * scaleY)
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * scaleY))
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * scaleX)
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * scaleX))

      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let sy = y0; sy < y1 && sy < source.height; sy++) {
        for (let sx = x0; sx < x1 && sx < source.width; sx++) {
          const i = (source.width * sy + sx) << 2
          r += source.data[i]
          g += source.data[i + 1]
          b += source.data[i + 2]
          a += source.data[i + 3]
          n++
        }
      }

      const idx = (size * y + x) << 2
      out.data[idx] = Math.round(r / n)
      out.data[idx + 1] = Math.round(g / n)
      out.data[idx + 2] = Math.round(b / n)
      out.data[idx + 3] = Math.round(a / n)
    }
  }
  return out
}

async function main() {
  const source = PNG.sync.read(readFileSync(SOURCE))
  if (source.width !== source.height) {
    throw new Error(`${SOURCE} must be square, got ${source.width}x${source.height}`)
  }

  const sizes = [16, 24, 32, 48, 64, 128, 256, 512]
  const buffers = Object.fromEntries(
    sizes.map((size) => [
      size,
      PNG.sync.write(size === source.width ? source : downscale(source, size))
    ])
  )

  mkdirSync(join(ROOT, 'build'), { recursive: true })
  mkdirSync(join(ROOT, 'resources'), { recursive: true })
  writeFileSync(join(ROOT, 'build/icon.png'), buffers[512])
  writeFileSync(join(ROOT, 'resources/icon.png'), buffers[512])

  // electron-builder wants an .ico with the classic Windows icon sizes embedded.
  const ico = await pngToIco([16, 24, 32, 48, 64, 128, 256].map((size) => buffers[size]))
  writeFileSync(join(ROOT, 'build/icon.ico'), ico)

  console.log(`Wrote build/icon.png, build/icon.ico, resources/icon.png from ${SOURCE}`)
}

main()
