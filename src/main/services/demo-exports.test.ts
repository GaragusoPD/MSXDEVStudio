/**
 * The additive guard, run against the two demos that ship with the repo.
 *
 * `demo_msx1/content/` and `demo_msx2/content/` are committed, generated files.
 * `emitC` is byte-stable by construction (no dates, no absolute paths) — that is
 * what makes the exporter's mtime skip work at all — so re-rendering every
 * resource from its `res/*.json` must reproduce them exactly.
 *
 * It fails for one of two reasons, and both are worth being told about: an
 * exporter change leaked into output nobody meant to touch, or a deliberate
 * change landed without re-exporting the demos.
 */

import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseResource, renderResourceFiles, sourcePathFor } from '../../shared/msx/resource'

for (const demo of ['demo_msx1', 'demo_msx2']) {
  describe(demo, () => {
    const root = join(process.cwd(), demo)
    for (const file of readdirSync(join(root, 'res')).filter((name) => name.endsWith('.json'))) {
      it(`re-exports res/${file} byte-identically`, () => {
        const rel = `res/${file}`
        const resource = parseResource(rel, readFileSync(join(root, rel), 'utf-8'))
        const block = resource.doc.export
        if (!block) return
        const out = renderResourceFiles(resource, rel, block)
        if (block.format === 'bin') {
          expect(Buffer.from(out.bin!).equals(readFileSync(join(root, block.out)))).toBe(true)
          return
        }
        expect(out.header).toBe(readFileSync(join(root, block.out), 'utf-8'))
        const source = sourcePathFor(block.out)
        if (existsSync(join(root, source))) {
          expect(out.source).toBe(readFileSync(join(root, source), 'utf-8'))
        }
      })
    }
  })
}
