/**
 * Windows 8.3 path helper. Isolated so `project.ts` and `build.ts` can share
 * it without an import cycle.
 */
import { execFileSync } from 'node:child_process'

const SHELL_UNSAFE = /[\s&()^]/

export function pathNeedsShortForm(root: string): boolean {
  return SHELL_UNSAFE.test(root)
}

/**
 * MSXgl's compiler.js concatenates `-I${ProjDir}` unquoted. A space in the
 * project path makes sdasz80 treat the rest as a filename, then the next `-I`
 * as an option after a file: "?ASxxxx-Error-Options come first."
 * On Windows, prefer the 8.3 short path so the unquoted flag stays one token.
 */
export function windowsShortPath(root: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32' || !pathNeedsShortForm(root)) return root
  try {
    const escaped = root.replace(/'/g, "''")
    const printed = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${escaped}').ShortPath`
      ],
      { encoding: 'utf-8' }
    ).trim()
    return printed && !pathNeedsShortForm(printed) ? printed : root
  } catch {
    return root
  }
}
