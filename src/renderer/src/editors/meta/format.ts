/**
 * Which editor a `*.meta-tiles.json` opens in — decided by the file.
 *
 * The suffix names two formats: version 3 owns its pixels and is edited with
 * the pose editor (`../anim`), version 2 references one tileset's tiles and
 * keeps the editor it always had, which offers to convert it. Neither editor
 * may open the other's file: each would read it as its own format and, on
 * save, write the other's data away. So the file is read once, before either
 * session exists, and the answer is kept per path.
 */

import { reactive } from 'vue'
import { isOwnedMeta } from '../../../../shared/msx/meta-owned'

/** `owned`: version 3, the pose editor. `refs`: version 2, the meta editor. */
export type MetaFormat = 'owned' | 'refs'

const formats = reactive(new Map<string, MetaFormat>())
const pending = new Map<string, Promise<MetaFormat>>()

/** The format, once known; null while the file is still being read. */
export function metaFormat(path: string): MetaFormat | null {
  return formats.get(path) ?? null
}

/** Reads the file's version, once per path. An empty or missing file is a new meta, which is created owning its pixels. */
export function sniffMetaFormat(path: string): Promise<MetaFormat> {
  const known = formats.get(path)
  if (known) return Promise.resolve(known)
  const inflight = pending.get(path)
  if (inflight) return inflight
  const promise = (async (): Promise<MetaFormat> => {
    let format: MetaFormat = 'owned'
    try {
      const text = await window.api.invoke('fs:read', { path })
      if (text.trim() && !isOwnedMeta(JSON.parse(text))) format = 'refs'
    } catch {
      // Unreadable: the pose editor says why when it tries, and saves nothing.
    }
    formats.set(path, format)
    return format
  })().finally(() => pending.delete(path))
  pending.set(path, promise)
  return promise
}

/** Records a conversion: the tab re-renders in the other editor. */
export function setMetaFormat(path: string, format: MetaFormat): void {
  formats.set(path, format)
}
