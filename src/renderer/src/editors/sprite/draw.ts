/**
 * Canvas-2D rendering shared by the sprite list thumbnails, the paint canvas,
 * the layer picker's swatches and the animation filmstrip. Pure presentation
 * (no business logic, so it isn't unit-tested — see the ponytail note in
 * `shared/sprite-editor.ts` for what *is* tested) over `compositeFrame`'s
 * indices, which is the one place VDP color math happens.
 */

import type { Rgb } from '../../../../shared/msx/palette'

/** Fills each non-transparent (index ≠ 0) pixel as a `scale`×`scale` square. */
export function drawIndices(ctx: CanvasRenderingContext2D, indices: ArrayLike<number>, size: number, scale: number, rgb: readonly Rgb[]): void {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = indices[y * size + x]
      if (!index) continue
      const c = rgb[index] ?? { r: 255, g: 0, b: 255 }
      ctx.fillStyle = `rgb(${c.r}, ${c.g}, ${c.b})`
      ctx.fillRect(x * scale, y * scale, scale, scale)
    }
  }
}

export function drawGrid(ctx: CanvasRenderingContext2D, size: number, scale: number): void {
  ctx.strokeStyle = 'rgba(128, 128, 128, 0.25)'
  ctx.lineWidth = 1
  for (let i = 1; i < size; i++) {
    ctx.beginPath()
    ctx.moveTo(i * scale + 0.5, 0)
    ctx.lineTo(i * scale + 0.5, size * scale)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(0, i * scale + 0.5)
    ctx.lineTo(size * scale, i * scale + 0.5)
    ctx.stroke()
  }
}
