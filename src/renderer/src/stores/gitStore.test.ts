/**
 * The folder a clone URL lands in.
 *
 * This lived inside `GitPanel.vue` until the clone button was fixed, which meant
 * no test could reach it — `.vue` files are outside vitest. It moved here for
 * that reason alone, so the edge cases below are now pinned rather than assumed.
 */

import { describe, expect, it } from 'vitest'
import { repoNameFromUrl } from './gitStore'

describe('repoNameFromUrl', () => {
  it('takes the last path segment', () => {
    expect(repoNameFromUrl('https://github.com/user/project')).toBe('project')
  })

  it('drops a trailing .git, which is how most clone URLs are copied', () => {
    expect(repoNameFromUrl('https://github.com/user/project.git')).toBe('project')
  })

  it('drops trailing slashes before reading the segment', () => {
    // Without the slash strip this returns '' and falls through to the fallback,
    // so a URL pasted from a browser address bar would clone into 'repository'.
    expect(repoNameFromUrl('https://github.com/user/project/')).toBe('project')
    expect(repoNameFromUrl('https://github.com/user/project.git/')).toBe('project')
  })

  it('handles ssh and scp-style forms', () => {
    expect(repoNameFromUrl('git@github.com:user/project.git')).toBe('project')
    expect(repoNameFromUrl('ssh://git@host:22/user/project.git')).toBe('project')
  })

  it('reads a backslash path, since a Windows local clone source is legal', () => {
    expect(repoNameFromUrl('C:\\repos\\project')).toBe('project')
  })

  it('trims surrounding whitespace, which a paste usually carries', () => {
    expect(repoNameFromUrl('  https://github.com/user/project.git  ')).toBe('project')
  })

  it('falls back to "repository" rather than an empty folder name', () => {
    // An empty name would make the clone target the parent folder itself, which
    // git refuses only if it is non-empty — so this guard is not cosmetic.
    expect(repoNameFromUrl('')).toBe('repository')
    expect(repoNameFromUrl('   ')).toBe('repository')
    expect(repoNameFromUrl('/')).toBe('repository')
  })
})
