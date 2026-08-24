/**
 * The font families installed on this machine, for the Preferences dialog.
 *
 * Electron has no API for this, so it is one shell command per platform. All
 * three are read-only queries that print family names; none of them installs,
 * changes or opens anything.
 *
 * Failure is not exceptional here — a machine without `fc-list`, a locked-down
 * PowerShell, a slow `system_profiler` — so every path returns `[]` rather than
 * throwing. The dialog treats an empty list as "no suggestions" and leaves the
 * user a plain text field, which is why this can afford to give up quietly.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Long enough for a cold `system_profiler`, short enough not to hang the dialog. */
const TIMEOUT = 5000

interface Query {
  command: string
  args: string[]
  /** Turns the command's stdout into family names. */
  parse: (stdout: string) => string[]
}

const QUERIES: Record<string, Query> = {
  linux: {
    command: 'fc-list',
    args: [':', 'family'],
    // Each line is a comma-separated list of aliases for one font; the first is
    // the family proper and the rest are localised names.
    parse: (stdout) => stdout.split('\n').map((line) => line.split(',')[0])
  },
  darwin: {
    command: 'system_profiler',
    args: ['-json', 'SPFontsDataType'],
    parse: (stdout) => {
      const parsed = JSON.parse(stdout) as { SPFontsDataType?: { _name?: string }[] }
      return (parsed.SPFontsDataType ?? []).map((entry) => entry._name ?? '')
    }
  },
  win32: {
    command: 'powershell',
    args: [
      '-NoProfile',
      '-Command',
      'Add-Type -AssemblyName System.Drawing; ' +
        '(New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }'
    ],
    parse: (stdout) => stdout.split(/\r?\n/)
  }
}

/** Sorted, deduplicated, blanks dropped. Empty when the platform cannot answer. */
export async function listSystemFonts(platform: string = process.platform): Promise<string[]> {
  const query = QUERIES[platform]
  if (!query) return []
  try {
    const { stdout } = await run(query.command, query.args, { timeout: TIMEOUT, maxBuffer: 8 * 1024 * 1024 })
    return normalizeFamilies(query.parse(stdout))
  } catch {
    return []
  }
}

/** Exported for the tests, which own the parsing rules rather than the shelling out. */
export function normalizeFamilies(names: readonly string[]): string[] {
  const seen = new Set<string>()
  for (const name of names) {
    const trimmed = name.trim()
    // A leading '.' marks a system-internal face on macOS (`.SF NS`), which is
    // not selectable and only clutters the list.
    if (!trimmed || trimmed.startsWith('.')) continue
    seen.add(trimmed)
  }
  // Case-insensitive, which is how a font list reads, with the raw name as the
  // tiebreak so the order does not depend on the machine's locale.
  return [...seen].sort(
    (a, b) => a.toLowerCase().localeCompare(b.toLowerCase(), 'en') || (a < b ? -1 : a > b ? 1 : 0)
  )
}
