/**
 * The application menu (Spec 01's workbench, filled in later).
 *
 * Every item that does something app-specific sends a `MenuCommand` to the
 * renderer, which runs it through the *same* store actions the buttons and
 * keyboard shortcuts use (`renderer/src/menu-commands.ts`). Nothing is
 * implemented twice.
 *
 * Accelerators are labels only — `registerAccelerator: false`. The shortcuts
 * are already bound in the renderer (`EditorArea.vue`, each editor tab, Monaco
 * itself), and a menu that also registered them would fire both handlers: two
 * saves on Ctrl+S, two undos on Ctrl+Z. The clipboard roles are the exception,
 * because nothing in the renderer implements those.
 */

import type { MenuItemConstructorOptions } from 'electron'
import type { MenuCommand } from '../shared/ipc'
import { EXTERNAL_MARK, isExternal } from './external-docs'

/**
 * `send` receives every app-specific command; `index.ts` answers the `help.*`
 * ones itself and forwards the rest to the renderer.
 */
export function menuTemplate(send: (command: MenuCommand) => void): MenuItemConstructorOptions[] {
  /**
   * An app-specific item: the accelerator is shown, not bound. See the note above.
   *
   * Anything that leaves for the browser gets marked here rather than in its
   * label, so the arrow can't be forgotten on the next link someone adds.
   */
  const item = (label: string, command: MenuCommand, accelerator?: string): MenuItemConstructorOptions => ({
    label: isExternal(command) ? `${label}${EXTERNAL_MARK}` : label,
    accelerator,
    registerAccelerator: false,
    click: () => send(command)
  })

  return [
    {
      label: '&File',
      submenu: [
        item('New Project…', 'file.newProject'),
        item('New Game…', 'file.newGame'),
        item('Open Project…', 'file.openProject'),
        { type: 'separator' },
        item('Save', 'file.save', 'Ctrl+S'),
        item('Save All', 'file.saveAll', 'Ctrl+Shift+S'),
        { type: 'separator' },
        item('Project Settings', 'file.projectSettings'),
        item('Toolchain Settings', 'file.toolchainSettings'),
        { type: 'separator' },
        item('Close Tab', 'file.closeTab', 'Ctrl+W'),
        { role: 'quit', label: 'Exit' }
      ]
    },
    {
      label: '&Edit',
      submenu: [
        item('Undo', 'edit.undo', 'Ctrl+Z'),
        item('Redo', 'edit.redo', 'Ctrl+Y'),
        { type: 'separator' },
        // Roles, so they act on whatever has focus — and the only items here
        // whose accelerators are really bound, since nothing else binds them.
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        item('Find in Files', 'edit.findInFiles')
      ]
    },
    {
      label: '&Build',
      submenu: [
        item('Build', 'build.build', 'Ctrl+Shift+B'),
        item('Rebuild', 'build.rebuild'),
        item('Clean', 'build.clean'),
        { type: 'separator' },
        item('Run', 'build.run', 'F5'),
        item('Stop', 'build.stop')
      ]
    },
    {
      label: '&View',
      submenu: [
        item('Explorer', 'view.explorer'),
        item('Search', 'view.search'),
        item('Git', 'view.git'),
        item('Resources', 'view.resources'),
        item('Examples', 'view.examples'),
        { type: 'separator' },
        item('Toggle Side Panel', 'view.toggleSide'),
        item('Toggle Bottom Panel', 'view.toggleBottom'),
        item('Output', 'view.output'),
        item('Problems', 'view.problems'),
        item('Terminal', 'view.terminal', 'Ctrl+`'),
        item('New Terminal Tab', 'view.terminalTab'),
        { type: 'separator' },
        // Not the `resetZoom`/`zoomIn`/`zoomOut` roles: their accelerators are
        // registered natively and `zoomIn`'s default (`CommandOrControl+Plus`)
        // never fires on a layout where `+` is a shifted `=`. `index.ts` matches
        // the keys itself — see `services/zoom.ts` — so these stay labels.
        item('Actual Size', 'view.zoomReset', 'Ctrl+0'),
        item('Zoom In', 'view.zoomIn', 'Ctrl+='),
        item('Zoom Out', 'view.zoomOut', 'Ctrl+-'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' }
      ]
    },
    {
      label: '&Help',
      submenu: [
        item('Documentation', 'help.docs'),
        item('Tutorials', 'help.tutorials'),
        item('Demo Games', 'help.demos'),
        item('Install Demo Projects…', 'help.installDemos'),
        { type: 'separator' },
        item('MSX.org', 'help.msxorg'),
        item('OpenMSX', 'help.openmsx'),
        item('MSXgl Reference', 'help.msxgl'),
        item('MSX2 Technical Handbook', 'help.msx2Handbook'),
        { type: 'separator' },
        item('About MSXDEVStudio', 'help.about')
      ]
    }
  ]
}
