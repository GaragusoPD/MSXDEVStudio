/**
 * The shell a new terminal spawns. Honouring `$SHELL` is what makes the
 * terminal feel like the user's own on Linux; Windows has no equivalent
 * variable, so it gets the modern default rather than `cmd.exe`.
 */
// ponytail: no per-project shell setting — add one to `.msxproj` if anyone asks.
export function defaultShell(platform: string, env: Record<string, string | undefined>): string {
  if (platform === 'win32') return 'powershell.exe'
  // `/bin/sh` rather than bash: it is the one shell POSIX guarantees exists.
  return env.SHELL || '/bin/sh'
}
