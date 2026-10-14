/**
 * Reading and editing a project's `msxgl_config.h` — the engine switches that
 * live in C, beside the `project_config.js` the IDE regenerates. Pure text in,
 * text out, so the game-kit scaffolder (main) and the music editor's "Set up
 * project" (renderer) share one implementation.
 */

/** Replace `#define NAME <old>` with `#define NAME <value>`. Throws if NAME is missing. */
export function patchConfigDefines(source: string, patches: Record<string, string>): string {
  let out = source
  for (const [name, value] of Object.entries(patches)) {
    const re = new RegExp(`^(#define\\s+${name}\\s+)\\S+`, 'm')
    if (!re.test(out)) throw new Error(`msxgl_config.h has no ${name} to patch`)
    out = out.replace(re, `$1${value}`)
  }
  return out
}

/** The value of `#define NAME value`, or null when the file doesn't define it. */
export function readConfigDefine(source: string, name: string): string | null {
  return new RegExp(`^#define\\s+${name}\\s+(\\S+)`, 'm').exec(source)?.[1] ?? null
}

/** What music with sound effects needs in LibModules (Spec 15). */
export const MUSIC_LIB_MODULES = ['psg', 'vgm/lvgm_player', 'ayfx/ayfx_player'] as const

/**
 * …and in `msxgl_config.h`. The templates ship lVGM with its MSX-MUSIC,
 * MSX-AUDIO and SCC parsers on, which link modules a PSG game doesn't have,
 * and point ayFX at **PT3's** register buffer (`AYFX_BUFFER_PT3`), which lVGM
 * never fills — effects would write to registers nothing sends to the chip.
 */
export const MUSIC_CONFIG: Readonly<Record<string, string>> = {
  PSG_ACCESS: 'PSG_INDIRECT',
  LVGM_USE_PSG: 'TRUE',
  LVGM_USE_MSXMUSIC: 'FALSE',
  LVGM_USE_MSXAUDIO: 'FALSE',
  LVGM_USE_SCC: 'FALSE',
  AYFX_BUFFER: 'AYFX_BUFFER_DEFAULT'
}

export interface MusicSetup {
  /** LibModules still to add. */
  modules: string[]
  /** `msxgl_config.h` defines that have another value, with the one they need. */
  defines: Record<string, string>
  /** Defines the file doesn't have at all — an old or hand-made config; these can't be patched. */
  missing: string[]
}

/** What `applyMusicSetup` would change. Nothing to do when all three are empty. */
export function musicSetup(config: string, libModules: readonly string[]): MusicSetup {
  const defines: Record<string, string> = {}
  const missing: string[] = []
  for (const [name, value] of Object.entries(MUSIC_CONFIG)) {
    const current = readConfigDefine(config, name)
    if (current === null) missing.push(name)
    else if (current !== value) defines[name] = value
  }
  return { modules: MUSIC_LIB_MODULES.filter((module) => !libModules.includes(module)), defines, missing }
}

export function musicSetupDone(setup: MusicSetup): boolean {
  return !setup.modules.length && !Object.keys(setup.defines).length
}
