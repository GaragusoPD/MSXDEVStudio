/**
 * Everything the build wrapper does that isn't spawning a process: build
 * arguments, output parsing, artifact resolution, exit-code explanations, the
 * WebMSX hand-off, and the tiny HTTP server that lends artifacts to
 * webmsx.org.
 *
 * Electron-free on purpose (same split as `toolchain.ts` / `project.ts`) so
 * all of it is directly unit-testable — see `build.test.ts`.
 */

import { createServer, type Server } from 'node:http'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, isAbsolute, join, relative } from 'node:path'
import type { BuildArtifact, BuildCommand, BuildProblem } from '../../shared/ipc'
import type { MsxProject } from '../../shared/msxproj'
import { resolveTarget } from '../../shared/msxgl-consts'
import { CONFIG_FILE } from './project'

// ── build invocation ────────────────────────────────────────────────────────

export function buildScript(msxglPath: string): string {
  return join(msxglPath, 'engine', 'script', 'js', 'build.js')
}

/** MSXgl's own step keywords for each IDE command. `run` only adds MSXgl's `run` step for openMSX.
 *  `forceFull` swaps `all` for `rebuild` (= clean + all) when the incremental guard tripped. */
export function commandSteps(
  command: BuildCommand,
  launchesEmulator: boolean,
  forceFull = false
): string[] {
  const all = forceFull ? 'rebuild' : 'all'
  switch (command) {
    case 'build':
      return [all]
    case 'rebuild':
      return ['rebuild']
    case 'clean':
      return ['clean']
    case 'run':
      return launchesEmulator ? [all, 'run'] : [all]
  }
}

/**
 * Full argument list for `node build.js …`. `build.defines` become repeated
 * `define=NAME:value` args (valueless entries stay bare, which MSXgl turns
 * into a plain `-DNAME`).
 */
export function buildArgs(
  msxglPath: string,
  project: MsxProject,
  command: BuildCommand,
  launchesEmulator: boolean,
  forceFull = false
): string[] {
  const defines = Object.entries(project.build.defines ?? {}).map(([name, value]) =>
    value === '' || value === undefined ? `define=${name}` : `define=${name}:${value}`
  )
  return [buildScript(msxglPath), ...commandSteps(command, launchesEmulator, forceFull), ...defines]
}

// ── incremental rebuild guard ───────────────────────────────────────────────
// Generated configs set MSXgl's `CompileSkipOld`, whose check only compares
// each source file against its own `.rel`. These helpers catch what that
// check can't see — header/include edits and compile-flag changes — and the
// build service swaps `all` for MSXgl's `rebuild` step when they trip.

const STAMP_FILE = '.msxdevstudio-stamp'

/** Root-level output dirs — everything inside is generated, never a compile input. */
const NON_SOURCE_DIRS = new Set(['out', 'emul', 'node_modules'])

/** The compile-flag inputs the mtime check can't see: config file content + `define=` args. */
export function buildStamp(root: string, project: MsxProject): string {
  let config = ''
  try {
    config = readFileSync(join(root, CONFIG_FILE), 'utf-8')
  } catch {
    /* customConfig project without the file yet — stamp on defines alone */
  }
  return `${JSON.stringify(project.build.defines ?? {})}\n${config}`
}

/** Newest mtime of any include file (.h/.inc) under `dir`, skipping output and hidden dirs. */
function newestIncludeMtime(dir: string, top: boolean): number {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || (top && NON_SOURCE_DIRS.has(entry.name))) continue
      newest = Math.max(newest, newestIncludeMtime(path, false))
    } else if (/\.(h|inc)$/i.test(entry.name)) {
      newest = Math.max(newest, statSync(path).mtimeMs)
    }
  }
  return newest
}

/**
 * True when the `.rel` files in `out/` can't be trusted: the compile flags
 * changed since they were built (stamp mismatch), or an include file is newer
 * than the oldest of them. False with no `.rel` files at all — a plain `all`
 * compiles everything anyway.
 */
export function needsFullRebuild(root: string, stamp: string): boolean {
  const outDir = join(root, 'out')
  let rels: number[]
  try {
    rels = readdirSync(outDir)
      .filter((name) => name.endsWith('.rel'))
      .map((name) => statSync(join(outDir, name)).mtimeMs)
  } catch {
    return false
  }
  if (!rels.length) return false

  let previous: string
  try {
    previous = readFileSync(join(outDir, STAMP_FILE), 'utf-8')
  } catch {
    return true // .rels exist but no stamp — built before the guard existed
  }
  if (previous !== stamp) return true

  return newestIncludeMtime(root, true) > Math.min(...rels)
}

/** Records what the `.rel`s produced by the upcoming build were compiled with. */
export function writeBuildStamp(root: string, stamp: string): void {
  mkdirSync(join(root, 'out'), { recursive: true })
  writeFileSync(join(root, 'out', STAMP_FILE), stamp)
}

// ── output ──────────────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex -- stripping terminal color codes is the point
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g

export function stripAnsi(line: string): string {
  return line.replace(ANSI, '').replace(/\r$/, '')
}

/** `<file>:<line>: …` — SDCC and this SDCC's sdasz80 both use it (see `__fixtures__/`). */
const FILE_LINE = /^(\S.*?\.[A-Za-z0-9_]{1,4}):(\d+): (.+)$/
/** SDCC's numbered diagnostics: `error 20: Undefined identifier 'x'`. */
const SDCC_CODED = /^(warning|error) (\d+): (.*)$/i
/** sdasz80 4.6.0: `Error: <u> undefined symbol encountered during assembly`. */
const TOOL_PREFIXED = /^(error|warning):?\s+(.*)$/i
/** The `?ASxxxx-Error-…` / `?ASlink-Warning-…` forms documented in msxgl-notes.md. */
const ASXXXX = /^\?AS\w+-(Error|Warning)-(.*)$/
const AS_LOCATION = /^(.*?)\s*in line (\d+) of (\S+)\s*$/

/**
 * Project-root-relative path for a diagnostic's file, or undefined when it
 * points outside the project (engine sources) — the Problems panel only makes
 * a location clickable when the IDE can actually open it.
 */
function projectRelative(root: string, file: string): string | undefined {
  const cleaned = file.replace(/^\.[\\/]/, '').split('\\').join('/')
  const rel = isAbsolute(cleaned) ? relative(root, cleaned).split('\\').join('/') : cleaned
  return rel && !rel.startsWith('..') ? rel : undefined
}

/**
 * One output line → a diagnostic, or null. `root` decides which files are
 * clickable; files outside it keep their path in the message instead.
 */
export function parseProblem(line: string, root: string): Omit<BuildProblem, 'id'> | null {
  const text = stripAnsi(line).trimEnd()

  const asxxxx = ASXXXX.exec(text)
  if (asxxxx) {
    const severity = asxxxx[1].toLowerCase() as 'error' | 'warning'
    const located = AS_LOCATION.exec(asxxxx[2])
    const file = located ? projectRelative(root, located[3]) : undefined
    if (!located || !file) return { severity, message: asxxxx[2] }
    return { severity, message: located[1] || asxxxx[2], file, line: Number(located[2]) }
  }

  const match = FILE_LINE.exec(text)
  if (!match) return null
  const [, rawFile, rawLine, rest] = match

  let severity: BuildProblem['severity'] = 'error'
  let message = rest
  const coded = SDCC_CODED.exec(rest)
  const prefixed = coded ? null : TOOL_PREFIXED.exec(rest)
  if (coded) {
    severity = coded[1].toLowerCase() as 'error' | 'warning'
    message = `${coded[1].toLowerCase()} ${coded[2]}: ${coded[3]}`
  } else if (prefixed) {
    severity = prefixed[1].toLowerCase() as 'error' | 'warning'
    message = prefixed[2]
  }

  const file = projectRelative(root, rawFile)
  return {
    severity,
    message: file ? message : `${rawFile}:${rawLine}: ${message}`,
    ...(file ? { file, line: Number(rawLine) } : {})
  }
}

/** Parses a whole captured stream; ids are stable within one build. */
export function parseProblems(text: string, root: string): BuildProblem[] {
  const problems: BuildProblem[] = []
  for (const line of text.split('\n')) {
    const problem = parseProblem(line, root)
    if (problem) problems.push({ ...problem, id: `p${problems.length}` })
  }
  return problems
}

// ── exit codes ──────────────────────────────────────────────────────────────

const TOOLCHAIN_HINT =
  'Toolchain path invalid — open Toolchain Settings and check the MSXgl folder.'

/** build.js / check_config.js exit codes worth explaining (see msxgl-notes.md). */
const EXIT_HINTS: Record<number, string> = {
  20: TOOLCHAIN_HINT,
  30: TOOLCHAIN_HINT,
  35: TOOLCHAIN_HINT,
  40: TOOLCHAIN_HINT,
  50: TOOLCHAIN_HINT,
  110: 'Unknown LibModules entry — check the engine module list in Project Settings.',
  300: 'Unsupported source file format in ProjModules.',
  310: 'Compilation failed — see the Problems panel.',
  320: 'Assembly failed — see the Problems panel.',
  500:
    'openMSX has no C-BIOS turbo R machine — set an openMSX machine override in Project Settings.',
  540: 'meisei can only run ROM targets.'
}

/**
 * POSIX truncates exit statuses to 8 bits, so MSXgl's three-digit codes come
 * back as `code % 256` on Linux/macOS but intact on Windows. Both are matched.
 */
export function exitCodeMessage(code: number | null, stderrTail: string[] = []): string | null {
  if (code === 0) return null
  if (code === null) return 'Build canceled.'
  const documented = Object.keys(EXIT_HINTS).map(Number)
  const matched = documented.find((known) => known === code || known % 256 === code)
  if (matched !== undefined) return EXIT_HINTS[matched]
  const tail = stderrTail.filter((line) => line.trim()).slice(-5)
  return [`Build failed (exit code ${code}).`, ...tail].join('\n')
}

// ── artifacts ───────────────────────────────────────────────────────────────

/** The extension MSXgl's `setup_target.js` gives this target — it decides the deploy layout. */
export function targetExtension(target: string): 'rom' | 'bin' | 'com' | 'lib' {
  const resolved = resolveTarget(target)
  if (resolved.startsWith('ROM_')) return 'rom'
  if (resolved.startsWith('DOS')) return 'com'
  if (resolved === 'LIB') return 'lib'
  return 'bin'
}

/** Project-root-relative paths MSXgl's Deploy step may have written, in "most useful first" order. */
export function artifactCandidates(project: MsxProject): string[] {
  const name = project.name
  const target = resolveTarget(project.target)
  const paths: string[] = []

  switch (targetExtension(target)) {
    case 'rom':
      paths.push(`emul/rom/${name}.rom`)
      break
    case 'bin':
      paths.push(`emul/bin/${name}.bin`)
      if (target === 'BIN_TAPE') paths.push(`emul/cas/${name}.cas`)
      else if (target !== 'RAW') paths.push(`emul/dsk/${target}_${name}.dsk`)
      break
    case 'com': {
      const dos = target === 'DOS0' ? 0 : target === 'DOS2' || target === 'DOS2_MAPPER' ? 2 : 1
      paths.push(dos === 0 ? `emul/dos0/BOOTDISK.COM` : `emul/dos${dos}/${name}.com`)
      paths.push(`emul/dsk/${target}_${name}.dsk`)
      break
    }
    case 'lib':
      paths.push(`lib/${name}.lib`)
      break
  }
  paths.push(`out/${name}.map`)
  return paths
}

/** Whichever candidates actually exist, with their sizes. */
export function resolveArtifacts(root: string, project: MsxProject): BuildArtifact[] {
  return artifactCandidates(project)
    .map((path) => ({ path, abs: join(root, ...path.split('/')) }))
    .filter((entry) => existsSync(entry.abs) && statSync(entry.abs).isFile())
    .map((entry) => ({ path: entry.path, size: statSync(entry.abs).size }))
}

/** The artifact WebMSX should boot: the ROM, else the DSK, else nothing runnable. */
export function runnableArtifact(
  artifacts: BuildArtifact[]
): { artifact: BuildArtifact; slot: 'ROM' | 'DISK' } | null {
  const rom = artifacts.find((a) => a.path.endsWith('.rom'))
  if (rom) return { artifact: rom, slot: 'ROM' }
  const disk = artifacts.find((a) => a.path.endsWith('.dsk'))
  return disk ? { artifact: disk, slot: 'DISK' } : null
}

// ── WebMSX ──────────────────────────────────────────────────────────────────

export const WEBMSX_URL = 'https://webmsx.org/'

/**
 * MSXgl `Machine` → WebMSX's `MACHINE` value (verified against the WebMSX
 * README: `MACHINE=MSX1|MSX2|MSX2P|MSXTR`). Multi-machine values pick the
 * highest one they cover.
 */
export function webmsxMachine(machine: string): string {
  const value = machine.toUpperCase()
  if (value.includes('TR')) return 'MSXTR'
  if (value.includes('2P')) return 'MSX2P'
  if (value.includes('2')) return 'MSX2'
  return 'MSX1'
}

export function webmsxUrl(machine: string, slot: 'ROM' | 'DISK', artifactUrl: string): string {
  return `${WEBMSX_URL}?MACHINE=${webmsxMachine(machine)}&${slot}=${encodeURIComponent(artifactUrl)}`
}

// ── artifact server ─────────────────────────────────────────────────────────

/**
 * Lends the current build's artifacts to webmsx.org over loopback: one
 * `http.Server` on a random 127.0.0.1 port that serves an explicit allowlist
 * of files and nothing else (any other path is a 404 — no path is ever
 * derived from the request). CORS is wide open because webmsx.org is the
 * whole point.
 */
export class ArtifactServer {
  private server: Server | null = null
  private files = new Map<string, string>()

  /** Publishes `absolutePaths` (replacing anything served before) and returns their URLs, in order. */
  async serve(absolutePaths: string[]): Promise<string[]> {
    this.files = new Map(absolutePaths.map((path) => [`/${encodeURIComponent(basename(path))}`, path]))
    const port = await this.listen()
    return absolutePaths.map((path) => `http://127.0.0.1:${port}/${encodeURIComponent(basename(path))}`)
  }

  private listen(): Promise<number> {
    const existing = this.server?.address()
    if (existing && typeof existing === 'object') return Promise.resolve(existing.port)

    const server = createServer((req, res) => {
      const file = req.url ? this.files.get(req.url.split('?')[0]) : undefined
      if (req.method !== 'GET' || !file || !existsSync(file)) {
        res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }).end('Not found')
        return
      }
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/octet-stream',
        'Content-Length': statSync(file).size
      })
      createReadStream(file).pipe(res)
    })
    this.server = server

    return new Promise((resolvePort, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolvePort(typeof address === 'object' && address ? address.port : 0)
      })
    })
  }

  stop(): void {
    this.files.clear()
    this.server?.close()
    this.server = null
  }
}
