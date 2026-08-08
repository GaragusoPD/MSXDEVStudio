/**
 * The live terminals, keyed by id — the same id the main process keys its PTYs
 * by. Both the xterm instance and the element it rendered into are kept here
 * rather than in the component, for the reason `monaco-models.ts` keeps
 * Monaco's models out of the tabs store: the view is unmounted whenever
 * another tab is activated, and neither the scrollback nor the running shell
 * may die with it. Re-mounting moves xterm's element into the new parent.
 */

import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

interface TerminalSession {
  term: Terminal
  fit: FitAddon
  /** xterm's own element, re-parented on every mount. */
  container: HTMLDivElement
  /** Unsubscribes this session's `terminal:data` listener. */
  off: () => void
  /** False once the shell exited; the next mount starts a fresh one. */
  alive: boolean
}

const sessions = new Map<string, TerminalSession>()
let counter = 0

/** The bottom panel's terminal. There is one, and it is never closed. */
export const PANEL_TERMINAL = 'terminal:panel'

/** Id for a new editor-area terminal — used as both the tab id and the PTY id. */
export function newTerminalId(): string {
  return `terminal:${++counter}`
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function xtermTheme(): Record<string, string> {
  return {
    background: cssVar('--color-bg-editor'),
    foreground: cssVar('--color-text'),
    cursor: cssVar('--color-text'),
    // The accent at 40%: readable over both themes without a second variable.
    selectionBackground: `${cssVar('--color-accent')}66`
  }
}

/** Re-reads the theme variables into every terminal. Called when the app theme flips. */
export function applyTheme(): void {
  for (const session of sessions.values()) session.term.options.theme = xtermTheme()
}

function startShell(id: string, session: TerminalSession): void {
  const dims = session.fit.proposeDimensions()
  session.alive = true
  window.api
    .invoke('terminal:start', { id, cols: dims?.cols ?? 80, rows: dims?.rows ?? 24 })
    .catch((error: unknown) => {
      // A shell that will not spawn — `$SHELL` pointing at something gone, no
      // PTY available — must say so here rather than leave a blank pane.
      session.alive = false
      session.term.write(`\r\n\x1b[31mCould not start a shell: ${String(error)}\x1b[0m\r\n`)
    })
}

/** Mounts `id`'s terminal into `parent`, creating it and its shell on first use. */
export function attach(id: string, parent: HTMLElement): void {
  const existing = sessions.get(id)
  if (existing) {
    parent.appendChild(existing.container)
    // Coming back to a terminal whose shell exited (the user typed `exit`)
    // gives a fresh one rather than a dead pane.
    if (!existing.alive) {
      existing.term.reset()
      startShell(id, existing)
    }
    refit(id)
    return
  }

  const container = document.createElement('div')
  container.style.cssText = 'width:100%;height:100%'
  parent.appendChild(container)

  const term = new Terminal({
    fontFamily: cssVar('--font-mono') || 'monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 10000,
    theme: xtermTheme()
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(container)

  const session: TerminalSession = { term, fit, container, off: () => {}, alive: false }

  // Subscribed before `terminal:start`, so the shell's first prompt cannot
  // arrive before anything is listening for it.
  const offData = window.api.on('terminal:data', (payload) => {
    if (payload.id === id) term.write(payload.data)
  })
  const offExit = window.api.on('terminal:exit', (payload) => {
    if (payload.id !== id) return
    session.alive = false
    term.write(`\r\n\x1b[2m[shell exited with code ${payload.code}]\x1b[0m\r\n`)
  })
  session.off = () => {
    offData()
    offExit()
  }
  term.onData((data) => void window.api.invoke('terminal:write', { id, data }))

  sessions.set(id, session)
  startShell(id, session)
}

/**
 * Refits after a mount, a panel drag or a window resize, and passes the new
 * size to the PTY. No-ops while the pane is hidden, where the fit is 0×0.
 */
export function refit(id: string): void {
  const session = sessions.get(id)
  if (!session) return
  const dims = session.fit.proposeDimensions()
  // Written as `!(x >= 1)` so a NaN from a mid-layout measurement is rejected too.
  if (!dims || !(dims.cols >= 1) || !(dims.rows >= 1)) return
  session.term.resize(dims.cols, dims.rows)
  void window.api.invoke('terminal:resize', { id, cols: dims.cols, rows: dims.rows })
}

export function focus(id: string): void {
  sessions.get(id)?.term.focus()
}

/**
 * Kills every terminal — switching projects. The tabs strip is rebuilt from
 * scratch for the new project, so without this the shells would go on running
 * in the old project's directory with nothing left on screen to reach them.
 */
export function disposeAll(): void {
  for (const id of [...sessions.keys()]) dispose(id)
}

/** Kills the shell and drops the session — closing a terminal tab. */
export function dispose(id: string): void {
  const session = sessions.get(id)
  if (!session) return
  session.off()
  session.term.dispose()
  session.container.remove()
  sessions.delete(id)
  void window.api.invoke('terminal:kill', { id })
}
