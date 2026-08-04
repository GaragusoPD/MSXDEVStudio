/**
 * Canvas-2D rendering shared by the sprite list thumbnails, the paint canvas,
 * the layer picker's swatches and the animation filmstrip. Pure presentation
 * (no business logic, so it isn't unit-tested — see the ponytail note in
 * `shared/sprite-editor.ts` for what *is* tested) over `compositeFrame`'s
 * indices, which is the one place VDP color math happens.
 */

import type { Rgb } from '../../../../shared/msx/palette'

/**
 * Fills each non-transparent (index ≠ 0) pixel as a `scale`×`scale` square.
 * `width` is the row stride; the height follows from the buffer length, so a
 * metasprite's taller composite draws without any extra argument.
 */
export function drawIndices(ctx: CanvasRenderingContext2D, indices: ArrayLike<number>, width: number, scale: number, rgb: readonly Rgb[]): void {
  const height = indices.length / width
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = indices[y * width + x]
      if (!index) continue
      const c = rgb[index] ?? { r: 255, g: 0, b: 255 }
      ctx.fillStyle = `rgb(${c.r}, ${c.g}, ${c.b})`
      ctx.fillRect(x * scale, y * scale, scale, scale)
    }
  }
}

/** Pixel grid over `width`×`height` dots, with a stronger line every `cell` dots (0 = none). */
export function drawGrid(ctx: CanvasRenderingContext2D, width: number, scale: number, height = width, cell = 0): void {
  ctx.lineWidth = 1
  for (let x = 1; x < width; x++) {
    if (cell && x % cell === 0) continue
    ctx.strokeStyle = 'rgba(128, 128, 128, 0.25)'
    ctx.beginPath()
    ctx.moveTo(x * scale + 0.5, 0)
    ctx.lineTo(x * scale + 0.5, height * scale)
    ctx.stroke()
  }
  for (let y = 1; y < height; y++) {
    if (cell && y % cell === 0) continue
    ctx.strokeStyle = 'rgba(128, 128, 128, 0.25)'
    ctx.beginPath()
    ctx.moveTo(0, y * scale + 0.5)
    ctx.lineTo(width * scale, y * scale + 0.5)
    ctx.stroke()
  }
  if (!cell) return
  // Cell seams: each one is where one hardware sprite ends and the next begins.
  ctx.strokeStyle = 'rgba(120, 170, 255, 0.75)'
  for (let x = cell; x < width; x += cell) {
    ctx.beginPath()
    ctx.moveTo(x * scale + 0.5, 0)
    ctx.lineTo(x * scale + 0.5, height * scale)
    ctx.stroke()
  }
  for (let y = cell; y < height; y += cell) {
    ctx.beginPath()
    ctx.moveTo(0, y * scale + 0.5)
    ctx.lineTo(width * scale, y * scale + 0.5)
    ctx.stroke()
  }
}
