import { describe, expect, it } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { menuTemplate } from './menu'
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
    // Answered in the main process, not the renderer — see `EXTERNAL_DOCS` in index.ts.
    expect(sent).toContain('help.msxgl')
    expect(sent).toContain('help.msx2Handbook')
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
