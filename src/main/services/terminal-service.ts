import { ipcMain } from 'electron'
import { spawn, type IPty } from '@lydell/node-pty'
import { homedir } from 'node:os'
import { defaultShell } from '../../shared/terminal'
import type { IpcEvents } from '../../shared/ipc'

type Emit = <K extends keyof IpcEvents>(channel: K, payload: IpcEvents[K]) => void

/**
 * One PTY per terminal id, owned here rather than by the view that shows it:
 * an editor-area terminal tab is unmounted the moment another tab is
 * activated, and the shell running in it has to survive that.
 *
 * There is no pure/service split (see the other services) because there is no
 * logic to split off — the shell choice is `shared/terminal.ts` and everything
 * else here is node-pty plumbing.
 */
export class TerminalService {
  private readonly ptys = new Map<string, IPty>()

  constructor(
    private readonly cwd: () => string | null,
    private readonly emit: Emit
  ) {}

  registerIpc(): void {
    ipcMain.handle('terminal:start', (_e, req: { id: string; cols: number; rows: number }) =>
      this.start(req.id, req.cols, req.rows)
    )
    ipcMain.handle('terminal:write', (_e, req: { id: string; data: string }) => {
      this.ptys.get(req.id)?.write(req.data)
    })
    ipcMain.handle('terminal:resize', (_e, req: { id: string; cols: number; rows: number }) => {
      // A pane that is laid out but hidden fits to 0×0; passing that on wedges
      // curses apps, which believe it.
      if (req.cols < 1 || req.rows < 1) return
      this.ptys.get(req.id)?.resize(req.cols, req.rows)
    })
    ipcMain.handle('terminal:kill', (_e, req: { id: string }) => this.kill(req.id))
  }

  private start(id: string, cols: number, rows: number): void {
    if (this.ptys.has(id)) return

    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value
    }
    // Last word, over whatever Electron was launched with: it describes the
    // emulator on the other end of the PTY, which is xterm.js either way.
    env.TERM = 'xterm-256color'

    const pty = spawn(defaultShell(process.platform, process.env), [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: this.cwd() ?? homedir(),
      env
    })
    pty.onData((data) => this.emit('terminal:data', { id, data }))
    pty.onExit(({ exitCode }) => {
      this.ptys.delete(id)
      this.emit('terminal:exit', { id, code: exitCode })
    })
    this.ptys.set(id, pty)
  }

  private kill(id: string): void {
    this.ptys.get(id)?.kill()
    this.ptys.delete(id)
  }

  dispose(): void {
    for (const id of [...this.ptys.keys()]) this.kill(id)
  }
}
