import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LICENSE_VERSION } from './license'

describe('LICENSE_VERSION', () => {
  it('matches the version declared in the LICENSE file', () => {
    // The gate re-prompts when LICENSE_VERSION differs from what the user
    // accepted. Editing the terms without bumping it here would leave everyone
    // silently bound to text they never saw.
    const license = readFileSync(join(__dirname, '../../LICENSE'), 'utf-8')
    expect(license).toContain(`\nVersion ${LICENSE_VERSION}\n`)
  })
})
