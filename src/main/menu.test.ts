import { describe, expect, it } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { menuTemplate } from './menu'
import { EXTERNAL_DOCS, EXTERNAL_MARK, isExternal } from './external-docs'
import type { MenuCommand } from '../shared/ipc'

function walk(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [item, ...walk((item.submenu as MenuItemConstructorOptions[]) ?? [])])
}

describe('menuTemplate', () => {
  it('sends one command per app-specific item', () => {
    const sent: MenuCommand[] = []
    const items = walk(menuTemplate((command) => sent.push(command))).filter((item) => item.click)
    for (const item of items) item.click?.(undefined as never, undefined, undefined as never)
    expect(sent.length).toBe(items.length)
    expect(new Set(sent).size).toBe(sent.length) // no command wired to two items
    expect(sent).toContain('file.save')
    expect(sent).toContain('file.saveAll')
    expect(sent).toContain('file.newGame')
    // Answered in the main process, not the renderer — see `EXTERNAL_DOCS` in index.ts.
    expect(sent).toContain('help.msxgl')
    expect(sent).toContain('help.msx2Handbook')
  })

  it('marks every item that opens in the browser, and only those', () => {
    // A native menu draws plain text, so the arrow is a glyph rather than the
    // icon font the rest of the UI uses. The point of the test is that the mark
    // tracks `EXTERNAL_DOCS` — a link added to one but not the other is either
    // an unmarked surprise or an arrow that opens a tab.
    const sent: MenuCommand[] = []
    const items = walk(menuTemplate((command) => sent.push(command))).filter((item) => item.click)
    for (const item of items) {
      sent.length = 0
      item.click?.(undefined as never, undefined, undefined as never)
      const marked = String(item.label).endsWith(EXTERNAL_MARK)
      expect(marked).toBe(isExternal(sent[0]))
    }
    expect(Object.keys(EXTERNAL_DOCS).length).toBeGreaterThan(0)
  })

  it('never registers an accelerator for a command the renderer already binds', () => {
    // The shortcuts live in the renderer, so a registered accelerator here would
    // fire both paths — two saves on Ctrl+S. Only the clipboard roles may bind.
    const bound = walk(menuTemplate(() => undefined)).filter(
      (item) => item.accelerator && item.registerAccelerator !== false
    )
    expect(bound).toEqual([])
  })
})
