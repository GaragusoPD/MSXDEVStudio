/**
 * The Resources panel's thumbnails as image URLs, made from the files on disk
 * (`thumbnailOf` decides what each kind shows) and cached until the file — or,
 * for a map, its tileset — reads differently.
 */

import { parseResource, resourceKindOf } from '../../../shared/msx/resource'
import { thumbnailOf, type Thumbnail } from '../../../shared/msx/thumbnail'
import type { TilesDoc } from '../../../shared/msx/tile'

const cache = new Map<string, { key: string; url: string | null }>()

/** A thumbnail for the resource at `path`, or null when it has no picture (or cannot be read). */
export async function thumbnailUrl(path: string): Promise<string | null> {
  try {
    const text = await window.api.invoke('fs:read', { path })
    const resource = parseResource(path, text)
    let tileset: TilesDoc | null = null
    let key = text
    if (resource.kind === 'map' && resource.doc.tileset && resourceKindOf(resource.doc.tileset) === 'tiles') {
      const tilesetText = await window.api.invoke('fs:read', { path: resource.doc.tileset })
      const parsed = parseResource(resource.doc.tileset, tilesetText)
      if (parsed.kind === 'tiles') tileset = parsed.doc
      key += '\u0000' + tilesetText
    }
    const held = cache.get(path)
    if (held?.key === key) return held.url
    const thumb = thumbnailOf(resource, tileset)
    const url = thumb ? toDataUrl(thumb) : null
    cache.set(path, { key, url })
    return url
  } catch {
    return null
  }
}

/** Index 0 is see-through, as the hardware draws it; the card's own background shows there. */
function toDataUrl(thumb: Thumbnail): string | null {
  const canvas = document.createElement('canvas')
  canvas.width = thumb.width
  canvas.height = thumb.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const image = ctx.createImageData(thumb.width, thumb.height)
  for (let i = 0; i < thumb.indices.length; i++) {
    const index = thumb.indices[i]
    const color = thumb.rgb[index]
    if (!index || !color) continue
    image.data[i * 4] = color.r
    image.data[i * 4 + 1] = color.g
    image.data[i * 4 + 2] = color.b
    image.data[i * 4 + 3] = 255
  }
  ctx.putImageData(image, 0, 0)
  return canvas.toDataURL()
}
