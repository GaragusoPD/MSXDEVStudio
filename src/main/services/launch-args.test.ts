import { describe, expect, it } from 'vitest'
import { extractProjectPath } from './launch-args'

describe('extractProjectPath', () => {
  it('finds a .msxproj path in packaged argv (exe, then args)', () => {
    expect(
      extractProjectPath(['/opt/MSXStudio/msxstudio', '/home/pablo/game/Game.msxproj'])
    ).toBe('/home/pablo/game/Game.msxproj')
  })

  it('finds a .msxproj path in dev argv (electron, script dir, then args)', () => {
    expect(extractProjectPath(['/usr/bin/electron', '.', '/home/pablo/game/Game.msxproj'])).toBe(
      '/home/pablo/game/Game.msxproj'
    )
  })

  it('is case-insensitive on the extension (Windows Explorer casing)', () => {
    expect(extractProjectPath(['app.exe', 'C:\\Games\\Game.MSXPROJ'])).toBe('C:\\Games\\Game.MSXPROJ')
  })

  it('ignores CLI flags', () => {
    expect(extractProjectPath(['app', '--flag', '--foo=bar'])).toBeNull()
  })

  it('ignores unrelated positional args', () => {
    expect(extractProjectPath(['app', 'somefile.txt'])).toBeNull()
  })

  it('returns null with no args or no match', () => {
    expect(extractProjectPath(['app'])).toBeNull()
    expect(extractProjectPath([])).toBeNull()
  })
})
