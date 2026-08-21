import { afterAll, describe, expect, it } from 'vitest'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportResourceFile, findResourceFiles } from './resources'

/**
 * Re-exports the two authored demos into a scratch copy and compares every file
 * with the one committed beside the originals.
 *
 * They are the only real projects in the tree, so this is the closest thing to a
 * golden test over the whole shared model at once: any change to a document
 * type, a packer, a constant or a helper that would alter what an existing
 * project emits shows up here as a byte difference, in a project nobody edited.
 *
 * Into a copy rather than in place, so a test run never writes to the repo —
 * exporting over the committed files would "fix" a stale one instead of failing.
 */
const DEMOS = ['demo_msx1', 'demo_msx2']
const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe.runIf(DEMOS.every((demo) => existsSync(join(process.cwd(), demo))))('demo re-export', () => {
  for (const demo of DEMOS) {
    it(`${demo} emits exactly what is committed`, () => {
      const source = join(process.cwd(), demo)
      const scratch = mkdtempSync(join(tmpdir(), `${demo}-`))
      dirs.push(scratch)
      // Only `res/` matters: the exporter reads editor files and writes content.
      cpSync(join(source, 'res'), join(scratch, 'res'), { recursive: true })
      mkdirSync(join(scratch, 'content'), { recursive: true })

      const files = findResourceFiles(scratch)
      expect(files.length).toBeGreaterThan(0)
      const failed = files
        .map((relative) => ({ relative, result: exportResourceFile(scratch, relative, { force: true }) }))
        .filter((entry) => entry.result.status === 'failed')
      expect(failed.map((entry) => `${entry.relative}: ${entry.result.message}`)).toEqual([])

      const emitted = readdirSync(join(scratch, 'content')).sort()
      expect(emitted.length).toBeGreaterThan(0)
      for (const name of emitted) {
        const committed = join(source, 'content', name)
        expect(existsSync(committed), `${demo}/content/${name} is not committed`).toBe(true)
        expect(
          readFileSync(join(scratch, 'content', name)).equals(readFileSync(committed)),
          `${demo}/content/${name} changed`
        ).toBe(true)
      }
    }, 120_000)
  }
})
