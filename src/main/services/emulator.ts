/**
 * An openMSX the IDE can talk to: launched with `-control stdio`, so every Tcl
 * console command — `vpeek`, `peek`, `screenshot`, `keymatrixdown`, `type` — can
 * be sent and its answer read back. This is what lets an agent *look at* the
 * running game (Spec 17), the way CLAUDE.md asks emitted C to be verified:
 * a screenshot before and after, VRAM read back rather than eyeballed.
 *
 * The Build ▸ Run button keeps launching openMSX through MSXgl's own `run`
 * step; this is a second, controllable instance, started on request.
 *
 * Pure parts (the control protocol, machine choice, argument list) are
 * exported for tests; `OpenMsxSession` holds the process.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import type { MsxProject } from '../../shared/msxproj'

// ── The control protocol ────────────────────────────────────────────────────
//
// openMSX's stdio control (https://openmsx.org/manual/openmsx-control.html):
// the client sends `<openmsx-control>` once, then one `<command>…</command>`
// per Tcl command; openMSX answers each, in order, with
// `<reply result="ok|nok">…</reply>`, interleaved with `<log>` and `<update>`
// elements the client did not ask for.

export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function unescapeXml(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

export function commandXml(command: string): string {
  return `<command>${escapeXml(command)}</command>\n`
}

export interface ControlReply {
  ok: boolean
  text: string
}

/**
 * Pulls complete `<reply>` elements (and `<log>` lines) out of a growing
 * buffer. Returns what was found and the unconsumed tail to keep for the next
 * chunk — a reply can arrive split across reads.
 */
export function parseControlOutput(buffer: string): { replies: ControlReply[]; logs: string[]; rest: string } {
  const replies: ControlReply[] = []
  const logs: string[] = []
  const element = /<(reply|log|update)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g
  let consumed = 0
  for (let match = element.exec(buffer); match; match = element.exec(buffer)) {
    consumed = element.lastIndex
    const [, tag, attrs, body = ''] = match
    if (tag === 'reply') replies.push({ ok: /result="ok"/.test(attrs), text: unescapeXml(body) })
    else if (tag === 'log') logs.push(unescapeXml(body))
  }
  return { replies, logs, rest: buffer.slice(consumed) }
}

// ── Launch ──────────────────────────────────────────────────────────────────

/**
 * The machine openMSX boots: the project's override, else the C-BIOS machine
 * MSXgl's own `run` step would pick (`setup_emulator.js`), so the two agree.
 */
export function openmsxMachine(project: MsxProject): string {
  if (project.emulator.openmsxMachine) return project.emulator.openmsxMachine
  const region = project.emulator.hz60 ? 'JP' : 'EU'
  const machine = String(project.machine).toUpperCase()
  if (['2', '2K', '22P'].includes(machine)) return `C-BIOS_MSX2_${region}`
  if (['2P', '0', 'TR'].includes(machine)) return `C-BIOS_MSX2+_${region}`
  return `C-BIOS_MSX1_${region}`
}

/** The media flag for an artifact: a ROM in slot A, a disk image in drive A. */
export function mediaArgs(artifact: string): string[] {
  return /\.dsk$/i.test(artifact) ? ['-diska', artifact] : ['-cart', artifact]
}

/** The extensions the project asks for, as openMSX names them. */
export function extensionArgs(project: MsxProject): string[] {
  const ext = project.emulator.ext
  const names: string[] = []
  if (ext.scc) names.push('scc')
  if (ext.msxMusic) names.push('fmpac')
  if (ext.msxAudio) names.push('audio')
  if (ext.opl4) names.push('moonsound')
  if (ext.psg2) names.push('2nd_PSG')
  if (ext.v9990) names.push('gfx9000')
  if (ext.pac) names.push('pac')
  return names.flatMap((name) => ['-ext', name])
}

export function launchArgs(project: MsxProject, artifact: string): string[] {
  return ['-machine', openmsxMachine(project), ...extensionArgs(project), ...mediaArgs(artifact), '-control', 'stdio']
}

// ── Keys ────────────────────────────────────────────────────────────────────

/** The keyboard-matrix keys a game reads most, by name: `[row, bit mask]`. */
export const MATRIX_KEYS: Record<string, [number, number]> = {
  SPACE: [8, 0x01],
  HOME: [8, 0x02],
  INS: [8, 0x04],
  DEL: [8, 0x08],
  LEFT: [8, 0x10],
  UP: [8, 0x20],
  DOWN: [8, 0x40],
  RIGHT: [8, 0x80],
  ESC: [7, 0x04],
  TAB: [7, 0x08],
  STOP: [7, 0x10],
  BS: [7, 0x20],
  SELECT: [7, 0x40],
  RETURN: [7, 0x80],
  ENTER: [7, 0x80],
  SHIFT: [6, 0x01],
  CTRL: [6, 0x02],
  GRAPH: [6, 0x04],
  CAPS: [6, 0x08],
  CODE: [6, 0x10],
  F1: [6, 0x20],
  F2: [6, 0x40],
  F3: [6, 0x80],
  F4: [7, 0x01],
  F5: [7, 0x02],
  M: [4, 0x04],
  N: [4, 0x08],
  Z: [5, 0x80],
  X: [5, 0x20]
}

export function matrixKey(name: string): [number, number] | null {
  return MATRIX_KEYS[name.trim().toUpperCase()] ?? null
}

/** A Tcl list `{1 2 3}` (what `vpeek` loops return) as numbers. */
export function tclNumbers(text: string): number[] {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
}

/** A Tcl one-liner that reads `length` bytes from `address` with `vpeek` or `peek`. */
export function peekCommand(space: 'vram' | 'memory', address: number, length: number): string {
  const read = space === 'vram' ? 'vpeek' : 'peek'
  return `set r {}; for {set i 0} {$i < ${length}} {incr i} {lappend r [${read} [expr {${address} + $i}]]}; set r`
}

// ── The session ─────────────────────────────────────────────────────────────

export interface EmulatorStatus {
  running: boolean
  machine: string | null
  media: string | null
}

type Spawn = (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => ChildProcess

/**
 * One controllable openMSX. Commands are queued, because openMSX answers them
 * strictly in order; each resolves with its reply or rejects with openMSX's own
 * error text (a `nok` reply) or when the process goes away.
 */
export class OpenMsxSession {
  private child: ChildProcess | null = null
  private buffer = ''
  private pending: { resolve: (text: string) => void; reject: (error: Error) => void }[] = []
  private status: EmulatorStatus = { running: false, machine: null, media: null }
  /** The last few `<log>` lines — openMSX's own warnings, for when something does not boot. */
  readonly log: string[] = []

  constructor(private readonly spawnProcess: Spawn = (command, args, options) => spawn(command, args, { ...options, windowsHide: true })) {}

  get current(): EmulatorStatus {
    return { ...this.status }
  }

  start(binary: string, args: string[], env: NodeJS.ProcessEnv, info: { machine: string; media: string }): void {
    this.stop()
    const child = this.spawnProcess(binary, args, { env })
    this.child = child
    this.buffer = ''
    this.status = { running: true, machine: info.machine, media: info.media }
    child.stdout?.on('data', (chunk: Buffer) => this.consume(chunk.toString('utf-8')))
    child.stderr?.on('data', (chunk: Buffer) => {
      // Line by line, without the sound library's complaints on a machine with no card.
      for (const line of chunk.toString('utf-8').split('\n')) if (!/^ALSA lib /.test(line)) this.remember(line.trim())
    })
    const gone = (why: string): void => {
      if (this.child !== child) return
      this.child = null
      this.status = { running: false, machine: null, media: null }
      for (const waiter of this.pending.splice(0)) waiter.reject(new Error(why))
    }
    child.on('error', (error) => gone(`openMSX could not start: ${error.message}`))
    child.on('exit', (code) => gone(`openMSX exited${code === null ? '' : ` (code ${code})`}`))
    child.stdin?.write('<openmsx-control>\n')
  }

  /** Sends one Tcl command and waits for its reply. */
  command(tcl: string, timeoutMs = 10000): Promise<string> {
    const child = this.child
    if (!child?.stdin) return Promise.reject(new Error('openMSX is not running — start it with emulator_start.'))
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.pending.indexOf(entry)
        // A reply that never comes leaves openMSX out of step with the queue; stop trusting it.
        if (index >= 0) this.pending.splice(index, 1)
        reject(new Error(`openMSX did not answer within ${timeoutMs} ms`))
      }, timeoutMs)
      const entry = {
        resolve: (text: string) => {
          clearTimeout(timer)
          resolve(text)
        },
        reject: (error: Error) => {
          clearTimeout(timer)
          reject(error)
        }
      }
      this.pending.push(entry)
      child.stdin!.write(commandXml(tcl))
    })
  }

  stop(): void {
    const child = this.child
    if (!child) return
    this.child = null
    this.status = { running: false, machine: null, media: null }
    for (const waiter of this.pending.splice(0)) waiter.reject(new Error('openMSX was stopped'))
    try {
      child.stdin?.write(commandXml('exit'))
      child.stdin?.end()
    } catch {
      // Already gone.
    }
    const hard = setTimeout(() => child.kill(), 2000)
    child.once('exit', () => clearTimeout(hard))
  }

  private consume(text: string): void {
    const { replies, logs, rest } = parseControlOutput(this.buffer + text)
    this.buffer = rest
    for (const line of logs) this.remember(line)
    for (const reply of replies) {
      const waiter = this.pending.shift()
      if (!waiter) continue
      if (reply.ok) waiter.resolve(reply.text)
      else waiter.reject(new Error(reply.text.trim() || 'openMSX refused the command'))
    }
  }

  private remember(line: string): void {
    if (!line) return
    this.log.push(line)
    if (this.log.length > 50) this.log.splice(0, this.log.length - 50)
  }
}
