import { defineStore } from 'pinia'
import type { ConversionResult, ResourceEntry } from '../../../shared/ipc'
import { createMapDoc, SCREEN_COLS, SCREEN_ROWS } from '../../../shared/msx/map'
import { defaultExport, serializeResource } from '../../../shared/msx/resource'
import { createTilesDoc } from '../../../shared/msx/tile'
import { useAppStore } from './appStore'
import { useOutputStore } from './outputStore'

/**
 * The Resources panel (Spec 07): what editor resources the project holds and
 * the manual export/convert commands. Builds run the same step automatically
 * via `BuildService`, so this is only for exporting on demand.
 */
export const useResourcesStore = defineStore('resources', {
  state: () => ({
    entries: [] as ResourceEntry[],
    busy: false,
    /** Results of the last export, newest run only. */
    lastRun: [] as ConversionResult[],
    /** Absolute path of MSXgl's bundled `MSXimg.txt`, when available. */
    msximgHelp: null as string | null,
    importVisible: false,
    /** The "New tiled screen" dialog — a flag here, like `importVisible`, so the File menu can open it from any view. */
    newScreenVisible: false,
    /** Why the last listing failed, if it did — shown in the panel instead of thrown at the console. */
    error: null as string | null
  }),

  actions: {
    /**
     * Re-lists the project's resources. Called from mounts and watchers with
     * `void`, so a rejection here would be an unhandled one in the console and
     * nothing else — a folder deleted under the app is enough to cause it. The
     * previous list is kept rather than blanked: a stale entry the user can
     * click is more use than an empty panel.
     */
    async refresh(): Promise<void> {
      try {
        this.entries = await window.api.invoke('resources:list', undefined)
        this.msximgHelp = await window.api.invoke('resources:msximgHelp', undefined)
        this.error = null
      } catch (error) {
        this.error = String(error)
      }
    },

    /** Streams the outcome to the Output panel — same place builds report it. */
    async exportAll(force = false): Promise<void> {
      if (this.busy) return
      this.busy = true
      useAppStore().showBottomPanel('output')
      const output = useOutputStore()
      try {
        this.lastRun = await window.api.invoke('resources:exportAll', { force })
        for (const result of this.lastRun) {
          const line = `${result.input} → ${result.out}: ${result.status}${result.message ? ` (${result.message})` : ''}`
          output.append(result.status === 'failed' ? 'build:err' : 'build', line)
        }
        if (!this.lastRun.length) output.append('build', 'No resources or image rules to convert.')
      } catch (error) {
        output.append('build:err', String(error))
      } finally {
        this.busy = false
      }
    },

    async exportOne(path: string): Promise<void> {
      const output = useOutputStore()
      useAppStore().showBottomPanel('output')
      try {
        const result = await window.api.invoke('resources:exportOne', { path, force: true })
        output.append(
          result.status === 'failed' ? 'build:err' : 'build',
          `${result.input} → ${result.out}: ${result.status}${result.message ? ` (${result.message})` : ''}`
        )
      } catch (error) {
        output.append('build:err', String(error))
      }
    },

    /**
     * Scaffolds a tiled screen: a tileset plus a one-screen map over it — no
     * third document type, so everything the map editor can do to a map it
     * can do to a screen. `base` is the path stem, `res/title`, and the pair
     * is `res/title.tiles.json` + `res/title.map.json`.
     *
     * Tile 0 is reserved so an unpainted cell reads as blank instead of as
     * whatever art happens to land at index 0. Both docs get their default
     * export block: without one the pair would list, open and paint, and never
     * be emitted for a build. Refuses when either file exists — a blank
     * tileset over someone's art is not a "new" screen, and a map already open
     * in a tab would keep its old session — rather than asking, because a
     * `window.confirm` from a store blocks the renderer and cannot be tested.
     */
    async newTiledScreen(base: string): Promise<{ tileset: string; map: string }> {
      const tileset = `${base}.tiles.json`
      const map = `${base}.map.json`
      for (const path of [tileset, map]) {
        if (await window.api.invoke('fs:stat', { path })) throw new Error(`${path} already exists.`)
      }
      // `fs:write` doesn't create parent folders, and a project made before
      // resources existed (or one whose res/ was deleted) hasn't got one.
      const dir = base.slice(0, base.lastIndexOf('/'))
      if (dir) await window.api.invoke('fs:create', { path: dir, kind: 'directory' })
      await window.api.invoke('fs:write', {
        path: tileset,
        content: serializeResource({ kind: 'tiles', doc: { ...createTilesDoc('sc2', 1, true), export: defaultExport(tileset) } })
      })
      await window.api.invoke('fs:write', {
        path: map,
        content: serializeResource({ kind: 'map', doc: { ...createMapDoc(tileset, SCREEN_COLS, SCREEN_ROWS), export: defaultExport(map) } })
      })
      await this.refresh()
      return { tileset, map }
    }
  }
})
