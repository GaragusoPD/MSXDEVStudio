<script setup lang="ts">
/**
 * Spec 08's live preview strip: if some `.map.json` in the project draws with
 * this tileset, show one screenful of it with the tiles as they are right now.
 * Read-only on purpose — editing maps is Spec 10.
 */
import { onMounted, ref, watchEffect } from 'vue'
import { getCell, SCREEN_COLS, SCREEN_ROWS, type MapDoc } from '../../../../shared/msx/map'
import { paletteToRgb } from '../../../../shared/msx/palette'
import { parseResource } from '../../../../shared/msx/resource'
import { tilePixels, TILE_SIZE } from '../../../../shared/msx/tile'
import type { TileSession } from './session'

const props = defineProps<{ session: TileSession }>()

const canvas = ref<HTMLCanvasElement | null>(null)
const map = ref<{ path: string; doc: MapDoc } | null>(null)

const normalize = (path: string): string => path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()

onMounted(async () => {
  try {
    const entries = await window.api.invoke('resources:list', undefined)
    for (const entry of entries.filter((candidate) => candidate.kind === 'map')) {
      const text = await window.api.invoke('fs:read', { path: entry.path })
      const parsed = parseResource(entry.path, text)
      if (parsed.kind === 'map' && normalize(parsed.doc.tileset) === normalize(props.session.path)) {
        map.value = { path: entry.path, doc: parsed.doc }
        return
      }
    }
  } catch {
    map.value = null // a missing or malformed map is not this editor's problem
  }
})

watchEffect(() => {
  const element = canvas.value
  const found = map.value
  if (!element || !found) return
  const layer = found.doc.layers.find((candidate) => candidate.kind === 'tiles' && candidate.visible)
  if (!layer) return

  const cols = Math.min(SCREEN_COLS, found.doc.width)
  const rows = Math.min(SCREEN_ROWS, found.doc.height)
  element.width = cols * TILE_SIZE
  element.height = rows * TILE_SIZE
  const context = element.getContext('2d')
  if (!context) return

  const doc = props.session.doc
  const rgb = paletteToRgb(doc.palette)
  const image = new ImageData(element.width, element.height)
  const cache = new Map<number, Uint8Array>()
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const index = getCell(layer, found.doc, cx, cy)
      let pixels = cache.get(index)
      if (!pixels) {
        pixels = tilePixels(doc, index)
        cache.set(index, pixels)
      }
      for (let y = 0; y < TILE_SIZE; y++) {
        for (let x = 0; x < TILE_SIZE; x++) {
          const value = pixels[y * TILE_SIZE + x]
          const color = rgb[value] ?? { r: 0, g: 0, b: 0 }
          const at = ((cy * TILE_SIZE + y) * image.width + cx * TILE_SIZE + x) * 4
          image.data[at] = color.r
          image.data[at + 1] = color.g
          image.data[at + 2] = color.b
          image.data[at + 3] = 255
        }
      }
    }
  }
  context.putImageData(image, 0, 0)
})
</script>

<template>
  <div
    v-if="map"
    class="preview"
  >
    <span class="label">{{ map.path }}</span>
    <canvas ref="canvas" />
  </div>
</template>

<style scoped>
.preview {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-top: 1px solid var(--color-border);
  overflow-x: auto;
}

.label {
  font-size: 10px;
  color: var(--color-text-muted);
  white-space: nowrap;
}

canvas {
  height: 96px;
  image-rendering: pixelated;
  border: 1px solid var(--color-border);
}
</style>
