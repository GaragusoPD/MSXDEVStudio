/**
 * "An animation — or a meta-tile that owns its pixels — was saved", for the
 * tile tabs whose tileset it is attached to, so a window shows the new frame
 * 0 (and a meta its new tiles) at once rather than at the next build. One module-level listener set, the shape `onTilesReordered`
 * (`shared/tile-editor.ts`) uses for the same kind of cross-editor news.
 */

import type { OwnedMetaDoc } from '../../../../shared/msx/meta-owned'
import type { TileAnimDoc } from '../../../../shared/msx/tile-anim'

export interface AnimSavedEvent {
  path: string
  /** An animation's poses, or a meta-tile's — the tile tabs refresh whichever they have attached. */
  doc: TileAnimDoc | OwnedMetaDoc
}

type Listener = (event: AnimSavedEvent) => void

const listeners = new Set<Listener>()

export function onAnimSaved(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function emitAnimSaved(event: AnimSavedEvent): void {
  for (const listener of [...listeners]) listener(event)
}
