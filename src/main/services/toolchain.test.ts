import { execFileSync, execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  chmodExtractedToolchain,
  cloneMsxgl,
  extractZip,
  findOpenmsxOnPath,
  getMsxglVersion,
  isExecutable,
  openmsxSystemDataDir,
  parseOpenmsxVersion,
  sdlAudioDriver,
  pullMsxgl,
  validateMsxglRoot,
  writeEmulatorConfig
} from './toolchain'

// A real MSXgl checkout used as a fast, offline git-clone source (`file://` URL)
// and as ground truth for sentinel-file validation. Never referenced from
// product code — only from this test.
const REAL_MSXGL = '/tmp/claude-1000/-home-pablo-Development-MSXStudio/b16afaee-93f6-41b7-bbba-1f23c075314a/scratchpad/MSXgl'

function commandExists(cmd: string): boolean {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const hasGit = commandExists('git')
const hasZip = commandExists('zip')

const tmpDirs: string[] = []
function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('validateMsxglRoot', () => {
  it.runIf(hasGit && existsSync(REAL_MSXGL))('accepts a real MSXgl checkout', () => {
    const result = validateMsxglRoot(REAL_MSXGL, 'linux')
    expect(result.valid).toBe(true)
    expect(result.missing).toEqual([])
  })

  it('lists exactly the missing sentinel files for a broken folder', () => {
    const dir = makeTmpDir('msxgl-broken-')
    mkdirSync(join(dir, 'engine/script/js'), { recursive: true })
    writeFileSync(join(dir, 'engine/script/js/build.js'), '// stub')
    // tools/* deliberately absent

    const result = validateMsxglRoot(dir, 'linux')
    expect(result.valid).toBe(false)
    expect(result.missing).toEqual([
      'tools/sdcc/bin/sdcc',
      'tools/MSXtk/bin/MSXimg',
      'tools/build/Node/node',
      'tools/build/msxtar/msxtar'
    ])
  })

  it('requires .exe suffixes on windows (except build.js)', () => {
    const dir = makeTmpDir('msxgl-win-')
    mkdirSync(join(dir, 'engine/script/js'), { recursive: true })
    writeFileSync(join(dir, 'engine/script/js/build.js'), '// stub')
    mkdirSync(join(dir, 'tools/sdcc/bin'), { recursive: true })
    writeFileSync(join(dir, 'tools/sdcc/bin/sdcc'), 'x') // no .exe -> should still count as missing on win32

    const result = validateMsxglRoot(dir, 'win32')
    expect(result.missing).toContain('tools/sdcc/bin/sdcc')

    writeFileSync(join(dir, 'tools/sdcc/bin/sdcc.exe'), 'x')
    const result2 = validateMsxglRoot(dir, 'win32')
    expect(result2.missing).not.toContain('tools/sdcc/bin/sdcc')
  })
})

describe('getMsxglVersion', () => {
  it.runIf(hasGit && existsSync(REAL_MSXGL))('reads the git HEAD short sha for a git checkout', () => {
    const result = getMsxglVersion(REAL_MSXGL)
    expect(result.isGitRepo).toBe(true)
    expect(result.version).toMatch(/^[0-9a-f]{7,}$/)
  })

  it('falls back to the recorded install date for a zip install', () => {
    const dir = makeTmpDir('msxgl-zip-meta-')
    writeFileSync(
      join(dir, '.msxstudio-meta.json'),
      JSON.stringify({ installedAt: '2026-08-01T12:00:00.000Z' })
    )
    const result = getMsxglVersion(dir)
    expect(result.isGitRepo).toBe(false)
    expect(result.version).toBe('downloaded 2026-08-01')
  })

  it('reports null version when nothing is recorded', () => {
    const dir = makeTmpDir('msxgl-nothing-')
    const result = getMsxglVersion(dir)
    expect(result.isGitRepo).toBe(false)
    expect(result.version).toBeNull()
  })
})

describe('parseOpenmsxVersion', () => {
  it('parses a plain release version string', () => {
    expect(parseOpenmsxVersion('openMSX 19.1\n')).toBe('19.1')
  })

  it('parses a dev-build version string with a git suffix', () => {
    expect(parseOpenmsxVersion('openMSX 0.16.0-179-g1234567 (LINUX)\n')).toBe(
      '0.16.0-179-g1234567'
    )
  })

  it('returns null for unrecognized output', () => {
    expect(parseOpenmsxVersion('command not found')).toBeNull()
  })
})

describe('findOpenmsxOnPath', () => {
  it('returns a string or null without throwing', () => {
    expect(() => findOpenmsxOnPath()).not.toThrow()
    const result = findOpenmsxOnPath()
    expect(result === null || typeof result === 'string').toBe(true)
  })
})

describe('openmsxSystemDataDir', () => {
  it('returns ../share for the relocatable tarball layout, null otherwise', () => {
    const root = makeTmpDir('openmsx-bin-')
    mkdirSync(join(root, 'bin'), { recursive: true })
    const exec = join(root, 'bin', 'openmsx')
    writeFileSync(exec, '')
    expect(openmsxSystemDataDir(exec)).toBeNull() // no share/machines yet
    mkdirSync(join(root, 'share', 'machines'), { recursive: true })
    expect(openmsxSystemDataDir(exec)).toBe(join(root, 'share'))
    expect(openmsxSystemDataDir(null)).toBeNull()
  })
})

describe.skipIf(process.platform !== 'linux')('sdlAudioDriver', () => {
  it('names pulseaudio when a PulseAudio socket exists', () => {
    const runtime = makeTmpDir('msxstudio-runtime-')
    mkdirSync(join(runtime, 'pulse'), { recursive: true })
    writeFileSync(join(runtime, 'pulse', 'native'), '')
    expect(sdlAudioDriver({ XDG_RUNTIME_DIR: runtime })).toBe('pulseaudio')
  })

  it('leaves the environment alone when there is no socket, or the user set one', () => {
    const runtime = makeTmpDir('msxstudio-runtime-')
    // A pure-ALSA box: openMSX's own default is right, so say nothing.
    expect(sdlAudioDriver({ XDG_RUNTIME_DIR: runtime })).toBeNull()
    expect(sdlAudioDriver({})).toBeNull()

    mkdirSync(join(runtime, 'pulse'), { recursive: true })
    writeFileSync(join(runtime, 'pulse', 'native'), '')
    expect(sdlAudioDriver({ XDG_RUNTIME_DIR: runtime, SDL_AUDIODRIVER: 'alsa' })).toBeNull()
  })
})

describe('cloneMsxgl', () => {
  it.runIf(hasGit && existsSync(REAL_MSXGL))(
    'clones a local repo via a file:// URL and produces a valid MSXgl root',
    async () => {
      const dest = join(makeTmpDir('msxgl-clone-parent-'), 'MSXgl')
      await cloneMsxgl(`file://${REAL_MSXGL}`, dest)
      expect(validateMsxglRoot(dest, 'linux').valid).toBe(true)
      expect(existsSync(join(dest, '.git'))).toBe(true)
    },
    30_000
  )
})

describe('pullMsxgl', () => {
  it.runIf(hasGit)('pulls a fast-forward update from a local remote', async () => {
    const remote = makeTmpDir('msxgl-remote-')
    execSync('git init -q -b main', { cwd: remote })
    execSync('git config user.email a@b.c && git config user.name test', { cwd: remote })
    writeFileSync(join(remote, 'a.txt'), '1')
    execSync('git add a.txt && git commit -q -m first', { cwd: remote })

    const local = join(makeTmpDir('msxgl-local-parent-'), 'clone')
    execSync(`git clone -q "${remote}" "${local}"`)

    writeFileSync(join(remote, 'b.txt'), '2')
    execSync('git add b.txt && git commit -q -m second', { cwd: remote })

    const result = await pullMsxgl(local)
    expect(result.ok).toBe(true)
    expect(existsSync(join(local, 'b.txt'))).toBe(true)
  })
})

describe('extractZip + chmodExtractedToolchain', () => {
  it.runIf(hasZip)(
    'extracts a fake MSXgl zip, strips the wrapper folder, and restores exec bits',
    async () => {
      const buildDir = makeTmpDir('msxgl-zipsrc-')
      const wrapper = join(buildDir, 'MSXgl-main')
      const files = [
        'engine/script/js/build.js',
        'tools/sdcc/bin/sdcc',
        'tools/MSXtk/bin/MSXimg',
        'tools/build/Node/node',
        'tools/build/msxtar/msxtar'
      ]
      for (const rel of files) {
        const full = join(wrapper, rel)
        mkdirSync(join(full, '..'), { recursive: true })
        writeFileSync(full, '#!/bin/sh\necho stub\n')
        chmodSync(full, 0o644) // zip loses exec bits anyway, but be explicit
      }

      const zipPath = join(buildDir, 'MSXgl.zip')
      execSync(`zip -q -r "${zipPath}" MSXgl-main`, { cwd: buildDir })

      const targetDir = makeTmpDir('msxgl-extracted-')
      await extractZip(zipPath, targetDir)

      const status = validateMsxglRoot(targetDir, 'linux')
      expect(status.valid).toBe(true)

      // Files under the chmod dirs get their exec bit restored…
      expect(isExecutable(join(targetDir, 'tools/sdcc/bin/sdcc'))).toBe(true)
      expect(isExecutable(join(targetDir, 'tools/MSXtk/bin/MSXimg'))).toBe(true)
      expect(isExecutable(join(targetDir, 'tools/build/Node/node'))).toBe(true)
      expect(isExecutable(join(targetDir, 'tools/build/msxtar/msxtar'))).toBe(true)
      // …but build.js, outside those dirs, is left alone.
      expect(isExecutable(join(targetDir, 'engine/script/js/build.js'))).toBe(false)
    },
    30_000
  )

  it('chmodExtractedToolchain is a no-op on win32', () => {
    const dir = makeTmpDir('msxgl-winchmod-')
    mkdirSync(join(dir, 'tools/sdcc/bin'), { recursive: true })
    const file = join(dir, 'tools/sdcc/bin/sdcc.exe')
    writeFileSync(file, 'x')
    chmodSync(file, 0o644)
    expect(() => chmodExtractedToolchain(dir, 'win32')).not.toThrow()
    expect(isExecutable(file)).toBe(false)
  })
})

const REAL_TEMPLATE_PATH = join(REAL_MSXGL, 'engine/script/js/default_config.js')
const hasRealTemplate = existsSync(REAL_TEMPLATE_PATH)

describe('writeEmulatorConfig', () => {
  it.runIf(hasRealTemplate)(
    'creates projects/default_config.js from the template and sets Emulator without touching other settings',
    () => {
      const realTemplate = readFileSync(REAL_TEMPLATE_PATH, 'utf-8')
      const root = makeTmpDir('msxgl-config-')
      mkdirSync(join(root, 'engine/script/js'), { recursive: true })
      writeFileSync(join(root, 'engine/script/js/default_config.js'), realTemplate)

      writeEmulatorConfig(root, '/usr/bin/openmsx')

      const targetPath = join(root, 'projects/default_config.js')
      expect(existsSync(targetPath)).toBe(true)
      const written = readFileSync(targetPath, 'utf-8')
      expect(written).toContain('Emulator = "/usr/bin/openmsx";')
      // Original template content untouched elsewhere.
      expect(written).toContain('DoClean')
      expect((written.match(/^Emulator\s*=/gm) ?? []).length).toBe(1)

      // Simulate a prior user edit alongside a second call: only the
      // Emulator line should change, the custom line must survive.
      writeFileSync(targetPath, `${written}\nMyCustomSetting = 42;\n`)
      writeEmulatorConfig(root, '/opt/openmsx/openmsx')
      const rewritten = readFileSync(targetPath, 'utf-8')
      expect(rewritten).toContain('Emulator = "/opt/openmsx/openmsx";')
      expect(rewritten).not.toContain('/usr/bin/openmsx')
      expect(rewritten).toContain('MyCustomSetting = 42;')
      expect((rewritten.match(/^Emulator\s*=/gm) ?? []).length).toBe(1)
    }
  )

  it('creates a minimal default_config.js when no template exists', () => {
    const root = makeTmpDir('msxgl-config-notemplate-')
    writeEmulatorConfig(root, 'C:\\Program Files\\openMSX\\openmsx.exe')
    const written = readFileSync(join(root, 'projects/default_config.js'), 'utf-8')
    expect(written).toContain('Emulator = "C:\\\\Program Files\\\\openMSX\\\\openmsx.exe";')
  })
})
