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
const RESOURCE_SUFFIXES = [
  // Longest first: `endsWith` would otherwise hand `hero.btiles.json` to the
  // `tiles.json` editor. The meta suffixes are hyphenated, so they cannot
  // collide with these at all — which is exactly why they are.
  'meta-btiles.json',
  'meta-tiles.json',
  'btiles.json',
  'tiles.json',
  'swsprites.json',
  'sprites.json',
  'map.json',
  'screen.json',
  'sfx.json'
]

export function extensionFor(filename: string): string {
  const lower = filename.toLowerCase()
  const compound = RESOURCE_SUFFIXES.find((suffix) => lower.endsWith(`.${suffix}`))
  if (compound) return compound
  const dot = filename.lastIndexOf('.')
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase()
}

/**
 * Monaco language ids for the extensions worth highlighting.
 *
 * Not an allowlist of what may be opened — anything not binary opens as text,
 * and an extension missing here simply gets `plaintext`. It only decides
 * colouring, so adding one is a convenience, never a gate.
 */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  markdown: 'markdown',
  // Z80 assembly: Monaco has no dialect for it, and `plaintext` is honest —
  // a C-like highlighter mostly gets it wrong.
  s: 'plaintext',
  asm: 'plaintext',
  inc: 'plaintext',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  bat: 'bat',
  cmd: 'bat',
  ps1: 'powershell',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  html: 'html',
  htm: 'html',
  css: 'css',
  xml: 'xml',
  svg: 'xml',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  py: 'python',
  sql: 'sql',
  txt: 'plaintext',
  log: 'plaintext',
  gitignore: 'plaintext',
  gitattributes: 'plaintext'
}

/** Monaco language id for a plain (non-resource) extension; `plaintext` for anything unknown. */
export function languageFor(extension: string): string {
  return LANGUAGE_BY_EXTENSION[extension.toLowerCase()] ?? 'plaintext'
}

/**
 * Extensions whose contents are not text, so opening them in a text editor
 * shows mojibake and — for a big one — can lock the window up rewrapping it.
 *
 * A denylist rather than an allowlist on purpose. An allowlist means every new
 * kind of text file is a bug report; the set of *binary* things a project holds
 * is small, known, and mostly ours (ROMs, images, sound).
 */
const BINARY_EXTENSIONS = new Set([
  'rom', 'bin', 'dsk', 'cas', 'sna', 'wav', 'mp3', 'ogg', 'flac',
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'tga', 'pcx',
  'zip', 'gz', 'tar', 'xz', '7z', 'rar',
  'exe', 'dll', 'so', 'dylib', 'o', 'obj', 'lib', 'a',
  'ttf', 'otf', 'woff', 'woff2', 'pdf'
])

export function isBinaryExtension(extension: string): boolean {
  return BINARY_EXTENSIONS.has(extension.toLowerCase())
}
