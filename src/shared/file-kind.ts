/**
 * Maps a filename to an "extension" key (used by the editor registry, see
 * `editors/registry.ts`) and that key to a Monaco language id.
 *
 * Resource files get a compound key (`tiles.json` rather than `json`) so
 * Specs 08–11 can register their own editors for them without stealing
 * plain `.json` files; until those specs land, compound-key files simply
 * have no registered editor yet (same "no editor registered" fallback as
 * any other unregistered type).
 */
const RESOURCE_SUFFIXES = ['tiles.json', 'sprites.json', 'map.json', 'screen.json', 'sfx.json']

export function extensionFor(filename: string): string {
  const lower = filename.toLowerCase()
  const compound = RESOURCE_SUFFIXES.find((suffix) => lower.endsWith(`.${suffix}`))
  if (compound) return compound
  const dot = filename.lastIndexOf('.')
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase()
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  c: 'c',
  h: 'c',
  json: 'json',
  md: 'markdown',
  markdown: 'markdown',
  s: 'plaintext',
  asm: 'plaintext'
}

/** Monaco language id for a plain (non-resource) extension; `plaintext` for anything unknown. */
export function languageFor(extension: string): string {
  return LANGUAGE_BY_EXTENSION[extension.toLowerCase()] ?? 'plaintext'
}
