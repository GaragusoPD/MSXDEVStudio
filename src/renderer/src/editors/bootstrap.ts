import { registerEditor } from './registry'
import { registerMsxglCompletions } from './msxgl-completions'
import { setupMonacoEnvironment } from './monaco-setup'
import { useProjectStore } from '../stores/projectStore'
import * as btiles from './btiles/session'
import * as map from './map/session'
import * as meta from './meta/session'
import * as screen from './screen/session'
import * as sfx from './sfx/session'
import * as sprite from './sprite/session'
import * as swsprite from './swsprites/session'
import * as tile from './tile/session'
import BitmapTileEditorTab from './btiles/BitmapTileEditorTab.vue'
import DocsTab from './docs/DocsTab.vue'
import ExampleViewerTab from './ExampleViewerTab.vue'
import GitDiffTab from './GitDiffTab.vue'
import MapEditorTab from './map/MapEditorTab.vue'
import MetaTileEditorTab from './meta/MetaTileEditorTab.vue'
import MonacoEditorTab from './MonacoEditorTab.vue'
import ProjectSettingsTab from './ProjectSettingsTab.vue'
import ScreenEditorTab from './screen/ScreenEditorTab.vue'
import SfxEditorTab from './sfx/SfxEditorTab.vue'
import SpriteEditorTab from './sprite/SpriteEditorTab.vue'
import SwSpriteEditorTab from './swsprites/SwSpriteEditorTab.vue'
import TerminalTab from './terminal/TerminalTab.vue'
import TileEditorTab from './tile/TileEditorTab.vue'
import { dispose as disposeTerminal } from './terminal/session'

setupMonacoEnvironment()
// The symbol index itself is fetched lazily, on the first completion request.
registerMsxglCompletions()

registerEditor({
  extensions: ['c', 'h', 's', 'asm', 'json', 'md', 'markdown'],
  component: MonacoEditorTab
})

// Opening the project's `.msxproj` from the explorer is the settings UI. Its
// document is the project store rather than a per-path session, but Save is
// still Save.
registerEditor({
  extensions: ['msxproj'],
  component: ProjectSettingsTab,
  save: () => useProjectStore().save()
})

// The bundled documentation, opened by `openDocs()` from the Help menu. One
// tab for all of it: `docs/session.ts` holds which page is showing, because
// following a link navigates in place rather than opening another tab.
registerEditor({
  extensions: ['docs'],
  component: DocsTab
})

// Synthetic tabs opened by gitStore.openDiff() — not a real file extension.
registerEditor({
  extensions: ['git-diff'],
  component: GitDiffTab
})

// Synthetic tabs opened by examplesStore.openViewer() — not a real file extension.
registerEditor({
  extensions: ['example-viewer'],
  component: ExampleViewerTab
})

// Synthetic tabs opened by `openTerminalTab()` — a shell, not a file. `close`
// is what kills it: the tab is the only thing that owns the PTY.
registerEditor({
  extensions: ['terminal'],
  component: TerminalTab,
  close: disposeTerminal
})

// The resource editors all keep their document in a per-path session module, so
// save/undo/redo is the same three lines each time — see `registry.ts` for why
// they are registered rather than left inside the tab component.
//
// Spec 08: `file-kind.ts` gives resource files a compound extension, so this
// claims `*.tiles.json` without stealing plain `.json` from Monaco.
registerEditor({
  extensions: ['tiles.json'],
  component: TileEditorTab,
  save: (path) => tile.saveSession(tile.tileSession(path)),
  undo: (path) => tile.undo(tile.tileSession(path)),
  redo: (path) => tile.redo(tile.tileSession(path))
})

// The bitmap-mode tileset: same role as `*.tiles.json` in a pattern mode, and
// registered the same way. `file-kind.ts` lists `btiles.json` before
// `tiles.json` so the longer suffix wins the match.
registerEditor({
  extensions: ['btiles.json'],
  component: BitmapTileEditorTab,
  save: (path) => btiles.saveSession(btiles.bitmapTileSession(path)),
  undo: (path) => btiles.undo(btiles.bitmapTileSession(path)),
  redo: (path) => btiles.redo(btiles.bitmapTileSession(path))
})

// Meta-tile sets: groups of tiles a map can index instead of indexing tiles.
// One editor for both suffixes — the document is the same, and the kind only
// decides which `_DrawMeta` the export emits. `file-kind.ts` lists the
// hyphenated suffixes first so the longer match wins; they cannot collide with
// `tiles.json`/`btiles.json` anyway, which is why the hyphen is there.
for (const extension of ['meta-tiles.json', 'meta-btiles.json']) {
  registerEditor({
    extensions: [extension],
    component: MetaTileEditorTab,
    save: (path) => meta.saveSession(meta.metaSession(path)),
    undo: (path) => meta.undo(meta.metaSession(path)),
    redo: (path) => meta.redo(meta.metaSession(path))
  })
}

// Spec 09: same compound-extension trick, for `*.sprites.json`.
registerEditor({
  extensions: ['sprites.json'],
  component: SpriteEditorTab,
  save: (path) => sprite.saveSession(sprite.spriteSession(path)),
  undo: (path) => sprite.undo(sprite.spriteSession(path)),
  redo: (path) => sprite.redo(sprite.spriteSession(path))
})

// Software sprites: images blitted into the picture, as against the hardware's
// 32 slots. `file-kind.ts` lists `swsprites.json` before `sprites.json` so the
// longer suffix wins the match.
registerEditor({
  extensions: ['swsprites.json'],
  component: SwSpriteEditorTab,
  save: (path) => swsprite.saveSession(swsprite.swSpriteSession(path)),
  undo: (path) => swsprite.undo(swsprite.swSpriteSession(path)),
  redo: (path) => swsprite.redo(swsprite.swSpriteSession(path))
})

// Spec 11: the ayFX sound-effect bank editor.
registerEditor({
  extensions: ['sfx.json'],
  component: SfxEditorTab,
  save: (path) => sfx.saveSession(sfx.sfxSession(path)),
  undo: (path) => sfx.undo(sfx.sfxSession(path)),
  redo: (path) => sfx.redo(sfx.sfxSession(path))
})

// Spec 10: same compound-extension trick, for `*.map.json` and `*.screen.json`.
registerEditor({
  extensions: ['map.json'],
  component: MapEditorTab,
  save: (path) => map.saveSession(map.mapSession(path)),
  undo: (path) => map.undo(map.mapSession(path)),
  redo: (path) => map.redo(map.mapSession(path))
})
registerEditor({
  extensions: ['screen.json'],
  component: ScreenEditorTab,
  save: (path) => screen.saveSession(screen.screenSession(path)),
  undo: (path) => screen.undo(screen.screenSession(path)),
  redo: (path) => screen.redo(screen.screenSession(path))
})
