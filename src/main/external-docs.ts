/**
 * The Help items that leave the app entirely, and the mark that says so.
 *
 * One module rather than a constant beside each use, because the two halves
 * would otherwise drift: `menu.ts` decides how an item is *labelled* and
 * `index.ts` decides what it *does*, and a third link added to one but not the
 * other is either an unmarked surprise or an arrow that opens a tab. Here a
 * command is external or it isn't, and both files read the same answer.
 *
 * The mark is a glyph rather than an icon on purpose: a native menu renders
 * plain text, so the Material Symbols font the rest of the UI uses is not
 * available here.
 */

import type { MenuCommand } from '../shared/ipc'

/** Appended to the label of anything that opens in the system browser. */
export const EXTERNAL_MARK = ' ↗'

export const EXTERNAL_DOCS: Partial<Record<MenuCommand, string>> = {
  'help.msxorg': 'https://www.msx.org/',
  'help.msxgl': 'https://github.com/aoineko-fr/MSXgl/wiki',
  'help.msx2Handbook': 'https://github.com/Konamiman/MSX2-Technical-Handbook'
}

/** True when this command hands off to the browser instead of the renderer. */
export function isExternal(command: MenuCommand): boolean {
  return command in EXTERNAL_DOCS
}
