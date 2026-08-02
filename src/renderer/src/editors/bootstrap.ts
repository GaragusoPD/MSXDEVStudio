import { registerEditor } from './registry'
import { registerMsxglCompletions } from './msxgl-completions'
import { setupMonacoEnvironment } from './monaco-setup'
import ExampleViewerTab from './ExampleViewerTab.vue'
import GitDiffTab from './GitDiffTab.vue'
import MapEditorTab from './map/MapEditorTab.vue'
import MonacoEditorTab from './MonacoEditorTab.vue'
import ProjectSettingsTab from './ProjectSettingsTab.vue'
import ScreenEditorTab from './screen/ScreenEditorTab.vue'
import SfxEditorTab from './sfx/SfxEditorTab.vue'
import SpriteEditorTab from './sprite/SpriteEditorTab.vue'
import TileEditorTab from './tile/TileEditorTab.vue'

setupMonacoEnvironment()
// The symbol index itself is fetched lazily, on the first completion request.
registerMsxglCompletions()

registerEditor({
  extensions: ['c', 'h', 's', 'asm', 'json', 'md', 'markdown'],
  component: MonacoEditorTab
})

// Opening the project's `.msxproj` from the explorer is the settings UI.
registerEditor({
  extensions: ['msxproj'],
  component: ProjectSettingsTab
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

// Spec 08: `file-kind.ts` gives resource files a compound extension, so this
// claims `*.tiles.json` without stealing plain `.json` from Monaco.
registerEditor({
  extensions: ['tiles.json'],
  component: TileEditorTab
})

// Spec 09: same compound-extension trick, for `*.sprites.json`.
registerEditor({
  extensions: ['sprites.json'],
  component: SpriteEditorTab
})

// Spec 11: the ayFX sound-effect bank editor.
registerEditor({
  extensions: ['sfx.json'],
  component: SfxEditorTab
})

// Spec 10: same compound-extension trick, for `*.map.json` and `*.screen.json`.
registerEditor({
  extensions: ['map.json'],
  component: MapEditorTab
})
registerEditor({
  extensions: ['screen.json'],
  component: ScreenEditorTab
})
