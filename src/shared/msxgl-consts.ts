/**
 * MSXgl enumerations the IDE has to mirror: machine versions and build
 * targets, transcribed from `engine/script/js/setup_target.js` and
 * `setup_global.js` (see `specs/msxgl-notes.md`).
 *
 * Kept dependency-free so the wizard, the settings form, the config
 * generator, and the importer all share one source of truth.
 */

export const MSX_MACHINES = [
  { value: '1', label: 'MSX1' },
  { value: '2', label: 'MSX2' },
  { value: '2P', label: 'MSX2+' },
  { value: 'TR', label: 'MSX turbo R' },
  { value: '12', label: 'MSX1 + MSX2' },
  { value: '22P', label: 'MSX2 + MSX2+' },
  { value: '122P', label: 'MSX1 + MSX2 + MSX2+' },
  { value: '2K', label: 'Korean MSX2' },
  { value: '0', label: 'MSX0' }
] as const

export type Machine = (typeof MSX_MACHINES)[number]['value']

/** Every target `setup_target.js` accepts, in its own order. */
export const MSX_TARGETS = [
  { value: 'ROM_8K', label: 'ROM 8 KB (page 1)' },
  { value: 'ROM_8K_P2', label: 'ROM 8 KB (page 2)' },
  { value: 'ROM_16K', label: 'ROM 16 KB (page 1)' },
  { value: 'ROM_16K_P2', label: 'ROM 16 KB (page 2)' },
  { value: 'ROM_32K', label: 'ROM 32 KB (pages 1-2)' },
  { value: 'ROM_48K', label: 'ROM 48 KB (pages 0-2)' },
  { value: 'ROM_48K_ISR', label: 'ROM 48 KB + ISR replacement' },
  { value: 'ROM_64K', label: 'ROM 64 KB (pages 0-3)' },
  { value: 'ROM_64K_ISR', label: 'ROM 64 KB + ISR replacement' },
  { value: 'ROM_ASCII8', label: 'MegaROM ASCII-8' },
  { value: 'ROM_ASCII16', label: 'MegaROM ASCII-16' },
  { value: 'ROM_KONAMI', label: 'MegaROM Konami (K4)' },
  { value: 'ROM_KONAMI_SCC', label: 'MegaROM Konami SCC (K5)' },
  { value: 'ROM_NEO8', label: 'MegaROM NEO-8' },
  { value: 'ROM_NEO16', label: 'MegaROM NEO-16' },
  { value: 'ROM_YAMANOOTO', label: 'MegaROM Yamanooto' },
  { value: 'ROM_ASCII16X', label: 'MegaROM ASCII16-X' },
  { value: 'ROM_POPOLON', label: 'MegaROM Popolon' },
  { value: 'DOS0', label: 'MSX-DOS boot (.com)' },
  { value: 'DOS1', label: 'MSX-DOS 1 (.com)' },
  { value: 'DOS2', label: 'MSX-DOS 2 (.com)' },
  { value: 'DOS2_MAPPER', label: 'MSX-DOS 2 + RAM mapper (.com)' },
  { value: 'BIN_DISK', label: 'BASIC binary on disk (.bin)' },
  { value: 'BIN_TAPE', label: 'BASIC binary on tape (.bin)' },
  { value: 'BIN_USR', label: 'BASIC USR driver (.bin)' },
  { value: 'RAW', label: 'Raw binary / driver' },
  { value: 'LIB', label: 'C library (.lib)' }
] as const

export type Target = (typeof MSX_TARGETS)[number]['value']

/** Shown first in the target picker; everything else hides behind "all targets". */
export const CURATED_TARGETS: Target[] = [
  'ROM_32K',
  'ROM_48K',
  'ROM_ASCII8',
  'ROM_ASCII16',
  'ROM_KONAMI_SCC',
  'DOS1',
  'DOS2',
  'BIN_DISK'
]

/** Mapped-ROM targets — the only ones where `ROMSize` means anything. */
export const MAPPED_ROM_TARGETS: Target[] = [
  'ROM_ASCII8',
  'ROM_ASCII16',
  'ROM_KONAMI',
  'ROM_KONAMI_SCC',
  'ROM_NEO8',
  'ROM_NEO16',
  'ROM_YAMANOOTO',
  'ROM_ASCII16X',
  'ROM_POPOLON'
]

/** `setup_target.js` head: short names an existing project's config may use. */
const TARGET_ALIASES: Record<string, Target> = {
  BIN: 'BIN_DISK',
  BAS: 'BIN_DISK',
  USR: 'BIN_USR',
  DOS: 'DOS1',
  BOOT: 'DOS0',
  ROM: 'ROM_32K',
  ROM_K4: 'ROM_KONAMI',
  ROM_K5: 'ROM_KONAMI_SCC',
  DRIVER: 'RAW'
}

/** Resolves aliases and case exactly as `setup_target.js` does. Unknown names pass through upper-cased. */
export function resolveTarget(target: string): string {
  const upper = target.toUpperCase()
  return TARGET_ALIASES[upper] ?? upper
}

export function isMappedRomTarget(target: string): boolean {
  return (MAPPED_ROM_TARGETS as string[]).includes(resolveTarget(target))
}

export const INSTALL_RAM_ISR = ['RAMISR_NONE', 'RAMISR_PAGE0', 'RAMISR_SEGMENT0', 'RAMISR_PAGE3'] as const
export const CUSTOM_ISR = ['NONE', 'ALL', 'VBLANK', 'VHBLANK', 'V9990'] as const
export const OPTIM_LEVELS = ['Default', 'Speed', 'Size'] as const
export const COMPILE_COMPLEXITY = ['Fast', 'Default', 'Optimized', 'Ultra', 'Insane'] as const
export const JOYSTICK_DEVICES = ['', 'Joystick', 'Mouse', 'Paddle', 'JoyMega', 'NinjaTap'] as const
