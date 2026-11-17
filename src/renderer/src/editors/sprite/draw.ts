/**
 * Canvas-2D rendering shared by the sprite list thumbnails, the paint canvas,
 * the layer picker's swatches and the animation bar (sprites and poses).
 * Presentation over `compositeFrame`'s indices, which is the one place VDP
 * color math happens (see the ponytail note in `shared/sprite-editor.ts`); the
 * one rule here worth pinning — how a dot maps to canvas pixels — is in
 * `draw.test.ts`.
 */

import type { Rgb } from '../../../../shared/msx/palette'

/**
 * Fills each non-transparent (index ≠ 0) pixel as a `scale`×`scale` square.
 * `width` is the row stride; the height follows from the buffer length, so a
 * metasprite's taller composite draws without any extra argument.
 *
 * From scale 1 up, edges snap to whole canvas pixels, so a fractional scale (a
 * thumbnail fitted to its box) draws crisp dots rather than half-covered seams
 * between them, and every dot still gets at least one pixel; at a whole scale
 * the snapping changes nothing. Below 1 there are fewer pixels than dots and
 * snapping would round some dots to nothing — a 64-dot metasprite in a 48-pixel
 * thumbnail lost every fourth row and column — so each dot keeps its own
 * fractional square and antialiasing shows it.
 *
 * A pose of 16×16 tiles is 16,384 dots, redrawn on every stroke step, so a
 * colour's CSS string is built once per call and `fillStyle` (which the canvas
 * parses on every assignment) is set only when the colour changes.
 */
export function drawIndices(ctx: CanvasRenderingContext2D, indices: ArrayLike<number>, width: number, scale: number, rgb: readonly Rgb[]): void {
  if (!(scale > 0)) return
  const height = indices.length / width
  const snap = scale >= 1
  const styles: string[] = []
  let current = -1
  for (let y = 0; y < height; y++) {
    const top = snap ? Math.round(y * scale) : y * scale
    const tall = snap ? Math.round((y + 1) * scale) - top : scale
    for (let x = 0; x < width; x++) {
      const index = indices[y * width + x]
      if (!index) continue
      if (index !== current) {
        let style = styles[index]
        if (style === undefined) {
          const c = rgb[index] ?? { r: 255, g: 0, b: 255 }
          style = styles[index] = `rgb(${c.r}, ${c.g}, ${c.b})`
        }
        ctx.fillStyle = style
        current = index
      }
      const left = snap ? Math.round(x * scale) : x * scale
      const wide = snap ? Math.round((x + 1) * scale) - left : scale
      ctx.fillRect(left, top, wide, tall)
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
