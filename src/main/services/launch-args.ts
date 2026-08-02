/**
 * Pure argv → `.msxproj` path extraction for file-association launches.
 * Neither Windows nor Linux fire Electron's `open-file` event (that's
 * macOS-only, via Info.plist); both instead pass the double-clicked file as a
 * plain argv entry, appended after Electron's own args. Packaged argv looks
 * like `[exePath, ...args]`; dev argv looks like `[electronPath, '.', ...args]`.
 * Rather than guess which index is "ours", just take the first argument that
 * looks like a project file.
 */
export function extractProjectPath(argv: string[]): string | null {
  return argv.find((arg) => !arg.startsWith('-') && arg.toLowerCase().endsWith('.msxproj')) ?? null
}
