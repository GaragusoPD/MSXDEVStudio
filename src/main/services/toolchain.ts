/**
 * Pure(ish) toolchain logic: MSXgl/openMSX validation, acquisition (git clone
 * / zip fallback), and the `default_config.js` Emulator rewrite.
 *
 * Deliberately electron-free (no `app`, `ipcMain`, `dialog`) so it can be
 * unit-tested directly under Vitest. `toolchain-service.ts` wires this up to
 * IPC, StateService and progress broadcasting.
 */
import { execFile, execFileSync, spawn } from 'node:child_process'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  chmodSync,
  statSync,
  writeFileSync
} from 'node:fs'
import * as https from 'node:https'
import { dirname, join, resolve as resolvePath } from 'node:path'
import yauzl from 'yauzl'

export const MSXGL_GIT_URL = 'https://github.com/aoineko-fr/MSXgl.git'
export const MSXGL_ZIP_URL = 'https://codeload.github.com/aoineko-fr/MSXgl/zip/refs/heads/main'

/** File MSXStudio drops at the root of a zip-installed MSXgl to record when it was installed (no git HEAD to read). */
export const MSXSTUDIO_META_FILE = '.msxstudio-meta.json'

export interface ProgressPayload {
  message: string
  percent: number | null
}
export type ProgressCallback = (payload: ProgressPayload) => void

/** Sentinel files that must exist under a valid MSXgl root (relative, POSIX-style). `build.js` never gets `.exe`. */
export const MSXGL_SENTINELS = [
  'engine/script/js/build.js',
  'tools/sdcc/bin/sdcc',
  'tools/MSXtk/bin/MSXimg',
  'tools/build/Node/node',
  'tools/build/msxtar/msxtar'
] as const

/** Directories whose files need `chmod +x` after a zip extract on Linux (zip loses exec bits). */
export const MSXGL_CHMOD_DIRS = [
  'tools/sdcc/bin',
  'tools/MSXtk/bin',
  'tools/build/Node',
  'tools/build/msxtar',
  'tools/build/DskTool'
] as const

function sentinelPath(root: string, rel: string, platform: NodeJS.Platform): string {
  const needsExe = platform === 'win32' && !rel.endsWith('.js')
  const withExt = needsExe ? `${rel}.exe` : rel
  return join(root, ...withExt.split('/'))
}

export function validateMsxglRoot(
  root: string,
  platform: NodeJS.Platform = process.platform
): { valid: boolean; missing: string[] } {
  const missing = MSXGL_SENTINELS.filter((rel) => !existsSync(sentinelPath(root, rel, platform)))
  return { valid: missing.length === 0, missing }
}

export function getMsxglVersion(root: string): { isGitRepo: boolean; version: string | null } {
  if (existsSync(join(root, '.git'))) {
    try {
      const sha = execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], {
        encoding: 'utf-8'
      }).trim()
      return { isGitRepo: true, version: sha || null }
    } catch {
      return { isGitRepo: true, version: null }
    }
  }
  try {
    const meta = JSON.parse(readFileSync(join(root, MSXSTUDIO_META_FILE), 'utf-8')) as {
      installedAt?: string
    }
    return {
      isGitRepo: false,
      version: meta.installedAt ? `downloaded ${meta.installedAt.slice(0, 10)}` : null
    }
  } catch {
    return { isGitRepo: false, version: null }
  }
}

// ---------------------------------------------------------------------------
// openMSX
// ---------------------------------------------------------------------------

export function parseOpenmsxVersion(output: string): string | null {
  const match = /openmsx\s+([0-9][\w.+-]*)/i.exec(output)
  return match ? match[1] : null
}

export function findOpenmsxOnPath(): string | null {
  const cmd = process.platform === 'win32' ? 'where' : 'which'
  try {
    const out = execFileSync(cmd, ['openmsx'], { encoding: 'utf-8' }).trim().split(/\r?\n/)[0]
    return out || null
  } catch {
    return null
  }
}

export const WINDOWS_DEFAULT_OPENMSX_PATH = 'C:\\Program Files\\openMSX\\openmsx.exe'

export function runOpenmsxVersion(execPath: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile(execPath, ['--version'], { timeout: 5000 }, (error, stdout, stderr) => {
      if (error) {
        resolvePromise(null)
        return
      }
      resolvePromise(parseOpenmsxVersion(stdout || stderr))
    })
  })
}

// ---------------------------------------------------------------------------
// Acquisition: git clone
// ---------------------------------------------------------------------------

export function cloneMsxgl(
  url: string,
  targetDir: string,
  onProgress?: ProgressCallback
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    mkdirSync(dirname(targetDir), { recursive: true })
    const child = spawn('git', ['clone', '--depth', '1', '--progress', url, targetDir])
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      const percentMatch = /(\d+)%/.exec(text)
      const message = text.trim().split(/\r|\n/).pop() ?? text.trim()
      onProgress?.({ message, percent: percentMatch ? Number(percentMatch[1]) : null })
    })
    child.on('error', rejectPromise)
    child.on('close', (code) => {
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(`git clone exited with code ${code}`))
    })
  })
}

export function pullMsxgl(
  root: string,
  onProgress?: ProgressCallback
): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn('git', ['-C', root, 'pull', '--ff-only'])
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      output += text
      onProgress?.({ message: text.trim(), percent: null })
    })
    child.on('error', (err) => resolvePromise({ ok: false, message: String(err) }))
    child.on('close', (code) => resolvePromise({ ok: code === 0, message: output.trim() }))
  })
}

// ---------------------------------------------------------------------------
// Acquisition: zip fallback (git absent)
// ---------------------------------------------------------------------------

export function downloadZipFile(
  url: string,
  destPath: string,
  onProgress?: ProgressCallback
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = (currentUrl: string, redirectsLeft: number): void => {
      https
        .get(currentUrl, (res) => {
          const { statusCode, headers } = res
          if (statusCode && statusCode >= 300 && statusCode < 400 && headers.location) {
            if (redirectsLeft <= 0) {
              rejectPromise(new Error('too many redirects'))
              return
            }
            res.resume()
            request(headers.location, redirectsLeft - 1)
            return
          }
          if (statusCode !== 200) {
            rejectPromise(new Error(`download failed: HTTP ${statusCode}`))
            return
          }
          const total = Number(headers['content-length'] ?? 0)
          let received = 0
          const file = createWriteStream(destPath)
          res.on('data', (chunk: Buffer) => {
            received += chunk.length
            onProgress?.({
              message: 'Downloading MSXgl…',
              percent: total ? Math.round((received / total) * 100) : null
            })
          })
          res.pipe(file)
          file.on('finish', () => file.close(() => resolvePromise()))
          file.on('error', rejectPromise)
        })
        .on('error', rejectPromise)
    }
    request(url, 5)
  })
}

/** `chmod +x` every file under the toolchain dirs a zip extract loses exec bits on. No-op on Windows. */
export function chmodExtractedToolchain(
  root: string,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform === 'win32') return
  for (const dir of MSXGL_CHMOD_DIRS) {
    const abs = join(root, ...dir.split('/'))
    if (!existsSync(abs)) continue
    for (const file of walkFiles(abs)) {
      chmodSync(file, 0o755)
    }
  }
}

function* walkFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walkFiles(full)
    else yield full
  }
}

/** Strips the single top-level folder GitHub zips wrap everything in (`MSXgl-main/...` -> `...`). */
function stripFirstSegment(entryPath: string): string {
  const parts = entryPath.split('/').filter(Boolean)
  parts.shift()
  return parts.join('/')
}

export function extractZip(
  zipPath: string,
  targetDir: string,
  onProgress?: ProgressCallback
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    mkdirSync(targetDir, { recursive: true })
    const targetRoot = resolvePath(targetDir)
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        rejectPromise(err ?? new Error('failed to open zip'))
        return
      }
      const total = zipfile.entryCount
      let done = 0
      const next = (): void => zipfile.readEntry()

      zipfile.on('entry', (entry) => {
        const relPath = stripFirstSegment(entry.fileName)
        done += 1
        onProgress?.({
          message: `Extracting ${relPath || entry.fileName}`,
          percent: total ? Math.round((done / total) * 100) : null
        })
        if (!relPath) {
          next()
          return
        }
        const destPath = resolvePath(join(targetDir, relPath))
        if (!destPath.startsWith(targetRoot)) {
          // zip-slip guard: entry tries to escape targetDir — skip it
          next()
          return
        }
        if (/\/$/.test(entry.fileName)) {
          mkdirSync(destPath, { recursive: true })
          next()
          return
        }
        mkdirSync(dirname(destPath), { recursive: true })
        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr || !readStream) {
            next()
            return
          }
          const writeStream = createWriteStream(destPath)
          readStream.pipe(writeStream)
          writeStream.on('finish', next)
          writeStream.on('error', rejectPromise)
        })
      })
      zipfile.on('end', () => {
        chmodExtractedToolchain(targetDir)
        resolvePromise()
      })
      zipfile.on('error', rejectPromise)
      next()
    })
  })
}

// ---------------------------------------------------------------------------
// default_config.js — surgical `Emulator` line rewrite
// ---------------------------------------------------------------------------

// Matches only the assignment itself (up to the first `;`), leaving any
// trailing inline `//` comment on the same line (MSXgl's template has one)
// untouched.
const EMULATOR_LINE_RE = /^Emulator\s*=\s*[^;]*;/m

/**
 * Creates `<msxglRoot>/projects/default_config.js` from the engine's template
 * if it doesn't exist yet, then rewrites (only) the `Emulator = "...";` line.
 * Everything else in the file — including prior user edits — is preserved.
 */
export function writeEmulatorConfig(msxglRoot: string, emulatorPath: string): void {
  const templatePath = join(msxglRoot, 'engine', 'script', 'js', 'default_config.js')
  const targetPath = join(msxglRoot, 'projects', 'default_config.js')

  let content: string
  if (existsSync(targetPath)) {
    content = readFileSync(targetPath, 'utf-8')
  } else if (existsSync(templatePath)) {
    content = readFileSync(templatePath, 'utf-8')
  } else {
    content = 'Emulator = "";\n'
  }

  const escaped = emulatorPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const line = `Emulator = "${escaped}";`
  content = EMULATOR_LINE_RE.test(content)
    ? content.replace(EMULATOR_LINE_RE, line)
    : `${content}\n${line}\n`

  mkdirSync(dirname(targetPath), { recursive: true })
  writeFileSync(targetPath, content)
}

export function isExecutable(path: string): boolean {
  return (statSync(path).mode & 0o111) !== 0
}
