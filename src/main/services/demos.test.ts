import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  DEMO_PROJECTS,
  demosRoot,
  installDemos,
  installedVersion,
  planInstall,
  shouldCopy,
  STAMP_FILE
} from './demos'

/** A stand-in demo tree: the files that matter plus the ones that must not travel. */
function fakeDemo(root: string, id: string, projectFile: string): void {
  mkdirSync(join(root, id, 'res'), { recursive: true })
  mkdirSync(join(root, id, 'out'), { recursive: true })
  mkdirSync(join(root, id, 'emul'), { recursive: true })
  mkdirSync(join(root, id, '.msxdevstudio'), { recursive: true })
  writeFileSync(join(root, id, projectFile), '{}')
  writeFileSync(join(root, id, 'main.c'), 'void main(void) {}')
  writeFileSync(join(root, id, 'res', 'tiles.tiles.json'), '{}')
  writeFileSync(join(root, id, 'out', 'demo.rom'), 'STALE')
  writeFileSync(join(root, id, 'emul', 'openmsx.log'), 'noise')
  writeFileSync(join(root, id, '.msxdevstudio', 'state.json'), '{}')
}

let source: string
let target: string

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'msxdevstudio-demos-'))
  source = join(base, 'src')
  target = join(base, 'dest')
  mkdirSync(source, { recursive: true })
  for (const demo of DEMO_PROJECTS) fakeDemo(source, demo.id, demo.projectFile)
})

afterEach(() => {
  rmSync(resolve(source, '..'), { recursive: true, force: true })
})

describe('shouldCopy', () => {
  it.each(['main.c', 'res/tiles.tiles.json', 'datasrc/make-art.mjs', ''])('keeps %s', (path) => {
    expect(shouldCopy(path)).toBe(true)
  })

  it.each([
    'out',
    'out/demo.rom',
    'emul/openmsx.log',
    '.msxdevstudio/state.json',
    'node_modules/x/index.js'
  ])('drops %s', (path) => {
    expect(shouldCopy(path)).toBe(false)
  })

  it('matches whole segments, not substrings — `outline.c` is not `out/`', () => {
    expect(shouldCopy('outline.c')).toBe(true)
    expect(shouldCopy('res/outer/thing.json')).toBe(true)
  })

  it('handles Windows separators', () => {
    expect(shouldCopy('out\\demo.rom')).toBe(false)
    expect(shouldCopy('res\\tiles.tiles.json')).toBe(true)
  })
})

describe('demosRoot', () => {
  it('reads the repo folders in development', () => {
    expect(demosRoot(false, resolve('/repo'), resolve('/elsewhere'))).toBe(resolve('/repo'))
  })

  it('reads extraResources when packaged', () => {
    expect(demosRoot(true, resolve('/app.asar'), resolve('/res'))).toBe(join(resolve('/res'), 'demos'))
  })
})

describe('planInstall', () => {
  it('reports both demos as available and unconflicted on a clean target', () => {
    const plan = planInstall(source, target)
    expect(plan).toHaveLength(DEMO_PROJECTS.length)
    expect(plan.every((entry) => entry.available && !entry.conflict)).toBe(true)
  })

  it('flags a destination that already exists', () => {
    mkdirSync(join(target, 'demo_msx1'), { recursive: true })
    const plan = planInstall(source, target)
    expect(plan.find((e) => e.demo.id === 'demo_msx1')?.conflict).toBe(true)
    expect(plan.find((e) => e.demo.id === 'demo_msx2')?.conflict).toBe(false)
  })

  it('flags a demo this build did not ship', () => {
    rmSync(join(source, 'demo_msx2'), { recursive: true, force: true })
    expect(planInstall(source, target).find((e) => e.demo.id === 'demo_msx2')?.available).toBe(false)
  })
})

describe('installDemos', () => {
  it('copies both demos, creating the target folder', () => {
    const result = installDemos(source, target)
    expect(result.installed.map((i) => i.id)).toEqual(DEMO_PROJECTS.map((d) => d.id))
    expect(result.conflicts).toEqual([])
    expect(result.missing).toEqual([])
    expect(existsSync(join(target, 'demo_msx1', 'main.c'))).toBe(true)
    expect(existsSync(join(target, 'demo_msx2', 'res', 'tiles.tiles.json'))).toBe(true)
  })

  it('leaves build output and IDE state behind', () => {
    installDemos(source, target)
    for (const dir of ['out', 'emul', '.msxdevstudio']) {
      expect(existsSync(join(target, 'demo_msx1', dir))).toBe(false)
    }
  })

  it('points the caller at the project file to open', () => {
    const result = installDemos(source, target)
    const first = result.installed[0]
    expect(first.projectFile).toBe(join(target, 'demo_msx1', 'demo.msxproj'))
    expect(existsSync(first.projectFile)).toBe(true)
  })

  it('refuses to overwrite by default, and touches nothing it reported', () => {
    mkdirSync(join(target, 'demo_msx1'), { recursive: true })
    writeFileSync(join(target, 'demo_msx1', 'main.c'), 'MY EDITS')

    const result = installDemos(source, target)

    expect(result.conflicts).toEqual(['demo_msx1'])
    expect(result.installed.map((i) => i.id)).toEqual(['demo_msx2'])
    expect(readFileSync(join(target, 'demo_msx1', 'main.c'), 'utf-8')).toBe('MY EDITS')
  })

  it('overwrites when asked', () => {
    mkdirSync(join(target, 'demo_msx1'), { recursive: true })
    writeFileSync(join(target, 'demo_msx1', 'main.c'), 'MY EDITS')

    const result = installDemos(source, target, { overwrite: true })

    expect(result.conflicts).toEqual([])
    expect(readFileSync(join(target, 'demo_msx1', 'main.c'), 'utf-8')).toBe('void main(void) {}')
  })

  it('merges rather than clearing, so work beside the demo survives an overwrite', () => {
    mkdirSync(join(target, 'demo_msx1'), { recursive: true })
    writeFileSync(join(target, 'demo_msx1', 'my-notes.txt'), 'keep me')

    installDemos(source, target, { overwrite: true })

    expect(readFileSync(join(target, 'demo_msx1', 'my-notes.txt'), 'utf-8')).toBe('keep me')
  })

  it('reports a demo the build did not ship instead of throwing', () => {
    rmSync(join(source, 'demo_msx2'), { recursive: true, force: true })
    const result = installDemos(source, target)
    expect(result.missing).toEqual(['demo_msx2'])
    expect(result.installed.map((i) => i.id)).toEqual(['demo_msx1'])
  })

  it('stamps each copy with the MSXDEVStudio version', () => {
    installDemos(source, target, { version: '1.2.3' })
    expect(existsSync(join(target, 'demo_msx1', STAMP_FILE))).toBe(true)
    expect(installedVersion(join(target, 'demo_msx1'))).toBe('1.2.3')
  })

  it('reads an unstamped or corrupt copy as null rather than failing', () => {
    installDemos(source, target)
    expect(installedVersion(join(target, 'demo_msx2'))).toBe('unknown')
    expect(installedVersion(join(target, 'nope'))).toBeNull()
    writeFileSync(join(target, 'demo_msx1', STAMP_FILE), 'not json')
    expect(installedVersion(join(target, 'demo_msx1'))).toBeNull()
  })
})
