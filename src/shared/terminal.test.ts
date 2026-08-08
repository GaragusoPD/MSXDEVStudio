import { describe, expect, it } from 'vitest'
import { defaultShell } from './terminal'

describe('defaultShell', () => {
  it('uses the user shell on unix', () => {
    expect(defaultShell('linux', { SHELL: '/usr/bin/fish' })).toBe('/usr/bin/fish')
  })

  it('falls back to /bin/sh when SHELL is unset or empty', () => {
    expect(defaultShell('linux', {})).toBe('/bin/sh')
    expect(defaultShell('darwin', { SHELL: '' })).toBe('/bin/sh')
  })

  it('ignores SHELL on windows, where it would be an MSYS/Git-Bash leftover', () => {
    expect(defaultShell('win32', { SHELL: '/bin/bash' })).toBe('powershell.exe')
  })
})
