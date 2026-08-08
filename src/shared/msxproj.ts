/**
 * The `.msxproj` model (Spec 03) plus the two pure translations around it:
 *
 * - `generateProjectConfig()` — model → the `project_config.js` text MSXgl
 *   actually executes. Values equal to MSXgl's own defaults are omitted so
 *   the generated file stays readable and diffs stay small.
 * - `projectFromConfigGlobals()` — the effective globals dumped by the
 *   sandboxed config evaluator → a fresh model, for importing an existing
 *   MSXgl project.
 *
 * Dependency-free (same rule as `state.ts`): it runs in main, in the
 * renderer, and in Vitest unchanged.
 */

import { isMappedRomTarget, resolveTarget, type Machine } from './msxgl-consts'

export interface RawFileEntry {
  /** Exactly one of these three is set; MSXhex picks the placement from whichever it is. */
  offset?: number
  page?: number
  segment?: number
  file: string
}

/**
 * One declarative MSXimg conversion (Spec 07 C), run before every build with
 * cwd = the project root. `args` is the raw CLI tail — the Project Settings UI
 * edits it as a string and links to `tools/MSXtk/bin/MSXimg.txt` rather than
 * pretending to be an argument builder.
 */
export interface ImgRule {
  /** Project-relative source image. */
  input: string
  /** Project-relative output, e.g. `content/title.h`. */
  out: string
  args: string[]
}

export interface MsxProjectEmulator {
  preferred: 'openmsx' | 'webmsx'
  /** openMSX `-machine` override; null = MSXgl's C-BIOS default for `machine`. */
  openmsxMachine: string | null
  ext: {
    scc: boolean
    msxMusic: boolean
    msxAudio: boolean
    opl4: boolean
    psg2: boolean
    v9990: boolean
    ram: boolean
    pac: boolean
  }
  portA: string
  portB: string
  hz60: boolean
  fullscreen: boolean
  mute: boolean
}

export interface MsxProject {
  version: 1
  name: string
  machine: Machine
  target: string
  /** KB; mapped-ROM targets only. Null = leave MSXgl's default alone. */
  romSize: number | null
  libModules: string[]
  /** Source basenames MSXgl compiles (`ProjModules`). The wizard creates `main.c`. */
  projModules: string[]
  build: {
    optim: 'Default' | 'Speed' | 'Size'
    debug: boolean
    allowUndocumented: boolean
    compileComplexity: string
    /** Passed as `define=NAME:value` build args (Spec 04), never written into the config file. */
    defines: Record<string, string>
  }
  rom: {
    checkVersion: boolean
    delayBoot: boolean
    signature: boolean
    installRamIsr: string
    customIsr: string
    bankedCall: boolean
  }
  files: {
    rawFiles: RawFileEntry[]
    diskFiles: string[]
    diskSize: '360K' | '720K'
  }
  emulator: MsxProjectEmulator
  resources: { imgRules: ImgRule[] }
  /** True = the user owns `project_config.js`; the IDE never writes it again. */
  customConfig: boolean
}

export function defaultProject(name: string): MsxProject {
  return {
    version: 1,
    name,
    machine: '1',
    target: 'ROM_32K',
    romSize: null,
    libModules: ['system', 'bios', 'vdp', 'print', 'input', 'memory'],
    projModules: ['main'],
    build: {
      optim: 'Speed',
      debug: false,
      allowUndocumented: false,
      compileComplexity: 'Default',
      defines: {}
    },
    rom: {
      checkVersion: true,
      delayBoot: false,
      signature: false,
      installRamIsr: 'RAMISR_NONE',
      customIsr: 'VBLANK',
      bankedCall: false
    },
    files: { rawFiles: [], diskFiles: [], diskSize: '720K' },
    emulator: {
      preferred: 'openmsx',
      openmsxMachine: null,
      ext: { scc: false, msxMusic: false, msxAudio: false, opl4: false, psg2: false, v9990: false, ram: false, pac: false },
      portA: '',
      portB: '',
      hz60: false,
      fullscreen: false,
      mute: false
    },
    resources: { imgRules: [] },
    customConfig: false
  }
}

/**
 * Fills in anything a hand-edited or older `.msxproj` is missing, so the rest
 * of the app can treat every field as present. Unknown extra keys survive
 * untouched (a later spec's settings shouldn't be dropped by an older build).
 */
export function normalizeProject(raw: unknown, fallbackName: string): MsxProject {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<MsxProject>
  const base = defaultProject(input.name || fallbackName)
  return {
    ...base,
    ...input,
    version: 1,
    name: input.name || fallbackName,
    build: { ...base.build, ...input.build, defines: { ...input.build?.defines } },
    rom: { ...base.rom, ...input.rom },
    files: { ...base.files, ...input.files },
    emulator: {
      ...base.emulator,
      ...input.emulator,
      ext: { ...base.emulator.ext, ...input.emulator?.ext }
    },
    resources: { imgRules: normalizeImgRules(input.resources?.imgRules) }
  }
}

/** Coerces a hand-edited `resources.imgRules` array into well-formed rules, dropping junk entries. */
function normalizeImgRules(raw: unknown): ImgRule[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      input: String(entry.input ?? ''),
      out: String(entry.out ?? ''),
      args: Array.isArray(entry.args) ? entry.args.map(String) : []
    }))
}

// ── project_config.js generation ────────────────────────────────────────────

/** MSXgl's own defaults (`setup_global.js`) for every setting we generate. */
const MSXGL_DEFAULTS: Record<string, unknown> = {
  Machine: '1',
  Target: 'ROM_32K',
  CheckVersion: false,
  ROMDelayBoot: false,
  AddROMSignature: false,
  InstallRAMISR: 'RAMISR_NONE',
  CustomISR: 'VBLANK',
  BankedCall: false,
  Debug: false,
  AllowUndocumented: false,
  Optim: 'Speed',
  CompileComplexity: 'Default',
  DiskSize: '720K',
  EmulMachine: true,
  Emul60Hz: false,
  EmulFullScreen: false,
  EmulMute: false,
  EmulExtraParam: '',
  EmulSCC: false,
  EmulMSXMusic: false,
  EmulMSXAudio: false,
  EmulOPL4: false,
  EmulPSG2: false,
  EmulV9990: false,
  EmulRAM: false,
  EmulPAC: false,
  EmulPortA: '',
  EmulPortB: ''
}

export const GENERATED_BANNER_PREFIX = '// GENERATED by MSXDEVStudio from'

function jsLiteral(value: unknown): string {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0x100) {
    return `0x${value.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return JSON.stringify(value)
}

function rawFileLiteral(entry: RawFileEntry): string {
  const placement =
    entry.offset !== undefined
      ? `offset:${jsLiteral(entry.offset)}`
      : entry.page !== undefined
        ? `page:${entry.page}`
        : `segment:${entry.segment ?? 0}`
  return `{ ${placement}, file:${JSON.stringify(entry.file)} }`
}

/**
 * Renders `project_config.js`. `projectFileName` only appears in the banner.
 *
 * Every setting whose value equals MSXgl's default is skipped; project
 * identity (`ProjName`/`ProjModules`/`LibModules`) is always written because
 * MSXgl's defaults for those are empty.
 */
export function generateProjectConfig(
  project: MsxProject,
  projectFileName: string,
  /**
   * Sources the exporter generates (`content/tiles`, …), appended to
   * ProjModules. A C export puts its tables in a `.c` so several modules can
   * include the header; that `.c` has to be compiled, and expecting the user to
   * list every resource by hand would make the export a trap.
   */
  generatedModules: readonly string[] = []
): string {
  const out: string[] = [
    `${GENERATED_BANNER_PREFIX} ${projectFileName} — edit settings in the IDE, or set`,
    '// "customConfig": true to hand-edit this file.',
    ''
  ]

  const emit = (key: string, value: unknown, literal = jsLiteral(value)): void => {
    if (key in MSXGL_DEFAULTS && JSON.stringify(MSXGL_DEFAULTS[key]) === JSON.stringify(value)) return
    out.push(`${key} = ${literal};`)
  }
  const section = (title: string): void => {
    if (out[out.length - 1] !== '') out.push('')
    out.push(`//-- ${title}`)
  }

  section('Project')
  emit('ProjName', project.name)
  const projModules = [...project.projModules, ...generatedModules.filter((m) => !project.projModules.includes(m))]
  emit('ProjModules', projModules, `[${projModules.map((m) => JSON.stringify(m)).join(', ')}]`)
  emit('LibModules', project.libModules, `[${project.libModules.map((m) => JSON.stringify(m)).join(', ')}]`)

  section('Target')
  // Machine and Target are written even at MSXgl's default value: the user-global
  // `projects/default_config.js` re-asserts every setting, so anything omitted here
  // could be silently overridden there — not acceptable for what the binary *is*.
  out.push(`Machine = ${jsLiteral(project.machine)};`)
  out.push(`Target = ${jsLiteral(resolveTarget(project.target))};`)
  if (project.romSize !== null && isMappedRomTarget(project.target)) {
    out.push(`ROMSize = ${project.romSize};`)
  }
  emit('CheckVersion', project.rom.checkVersion)
  emit('ROMDelayBoot', project.rom.delayBoot)
  emit('AddROMSignature', project.rom.signature)
  emit('InstallRAMISR', project.rom.installRamIsr)
  emit('CustomISR', project.rom.customIsr)
  emit('BankedCall', project.rom.bankedCall)

  section('Build')
  // Skip recompiling sources whose .rel is newer. The mtime check is blind to
  // header/config/define changes — the IDE detects those and forces `rebuild`
  // (see `needsFullRebuild` in main/services/build.ts).
  out.push('CompileSkipOld = true;')
  emit('Optim', project.build.optim)
  emit('CompileComplexity', project.build.compileComplexity)
  emit('Debug', project.build.debug)
  emit('AllowUndocumented', project.build.allowUndocumented)
  // `build.defines` deliberately absent: Spec 04 passes them as `define=` build args.

  section('Files')
  if (project.files.rawFiles.length) {
    out.push(`RawFiles = [ ${project.files.rawFiles.map(rawFileLiteral).join(', ')} ];`)
  }
  if (project.files.diskFiles.length) {
    out.push(`DiskFiles = [${project.files.diskFiles.map((f) => JSON.stringify(f)).join(', ')}];`)
  }
  emit('DiskSize', project.files.diskSize)

  section('Emulator')
  const { emulator } = project
  // openMSX has no separate machine-name setting: an override replaces MSXgl's
  // generated `-machine C-BIOS_…` (EmulMachine) with an explicit extra param.
  if (emulator.openmsxMachine) {
    emit('EmulMachine', false)
    emit('EmulExtraParam', `-machine ${emulator.openmsxMachine}`)
  }
  emit('Emul60Hz', emulator.hz60)
  emit('EmulFullScreen', emulator.fullscreen)
  emit('EmulMute', emulator.mute)
  emit('EmulSCC', emulator.ext.scc)
  emit('EmulMSXMusic', emulator.ext.msxMusic)
  emit('EmulMSXAudio', emulator.ext.msxAudio)
  emit('EmulOPL4', emulator.ext.opl4)
  emit('EmulPSG2', emulator.ext.psg2)
  emit('EmulV9990', emulator.ext.v9990)
  emit('EmulRAM', emulator.ext.ram)
  emit('EmulPAC', emulator.ext.pac)
  emit('EmulPortA', emulator.portA)
  emit('EmulPortB', emulator.portB)

  // Drop trailing section headers that ended up with no settings under them.
  while (out.length && (out[out.length - 1] === '' || out[out.length - 1].startsWith('//-- '))) out.pop()
  return `${out.join('\n')}\n`
}

// ── import (config globals → model) ─────────────────────────────────────────

/** The subset of MSXgl globals the importer reads; also what the dumper prints. */
export const IMPORTED_CONFIG_KEYS = [
  'ProjName',
  'ProjModules',
  'LibModules',
  'Machine',
  'Target',
  'ROMSize',
  'CheckVersion',
  'ROMDelayBoot',
  'AddROMSignature',
  'InstallRAMISR',
  'CustomISR',
  'BankedCall',
  'Optim',
  'CompileComplexity',
  'Debug',
  'AllowUndocumented',
  'RawFiles',
  'DiskFiles',
  'DiskSize',
  'Emul60Hz',
  'EmulFullScreen',
  'EmulMute',
  'EmulSCC',
  'EmulMSXMusic',
  'EmulMSXAudio',
  'EmulOPL4',
  'EmulPSG2',
  'EmulV9990',
  'EmulRAM',
  'EmulPAC',
  'EmulPortA',
  'EmulPortB',
  /** Read by the examples browser (Spec 12) when forking a sample: mapper-segment
   *  sibling files are named `${ProjSegments}_s<seg>_b<bank>.*`, defaulting to
   *  ProjName when unset (mirrors check_config.js — not replayed by this evaluator). */
  'ProjSegments'
] as const

export type ConfigGlobals = Partial<Record<(typeof IMPORTED_CONFIG_KEYS)[number], unknown>>

const str = (v: unknown, fallback: string): string => (typeof v === 'string' && v ? v : fallback)
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)
const strArray = (v: unknown, fallback: string[]): string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : fallback

/**
 * Maps evaluated config globals onto a fresh `.msxproj`. `customConfig` is
 * left to the caller (import sets it true so the original file stays
 * authoritative).
 */
export function projectFromConfigGlobals(globals: ConfigGlobals, fallbackName: string): MsxProject {
  const base = defaultProject(str(globals.ProjName, fallbackName))
  const target = resolveTarget(str(globals.Target, base.target))
  return {
    ...base,
    machine: str(globals.Machine, base.machine).toUpperCase() as Machine,
    target,
    romSize: isMappedRomTarget(target) && typeof globals.ROMSize === 'number' ? globals.ROMSize : null,
    libModules: strArray(globals.LibModules, base.libModules),
    projModules: strArray(globals.ProjModules, []),
    build: {
      ...base.build,
      optim: str(globals.Optim, base.build.optim) as MsxProject['build']['optim'],
      compileComplexity: String(globals.CompileComplexity ?? base.build.compileComplexity),
      debug: bool(globals.Debug, base.build.debug),
      allowUndocumented: bool(globals.AllowUndocumented, base.build.allowUndocumented)
    },
    rom: {
      checkVersion: bool(globals.CheckVersion, false),
      delayBoot: bool(globals.ROMDelayBoot, false),
      signature: bool(globals.AddROMSignature, false),
      installRamIsr: str(globals.InstallRAMISR, base.rom.installRamIsr),
      customIsr: str(globals.CustomISR, base.rom.customIsr),
      bankedCall: bool(globals.BankedCall, false)
    },
    files: {
      rawFiles: Array.isArray(globals.RawFiles) ? (globals.RawFiles as RawFileEntry[]) : [],
      diskFiles: strArray(globals.DiskFiles, []),
      diskSize: str(globals.DiskSize, base.files.diskSize) as '360K' | '720K'
    },
    emulator: {
      ...base.emulator,
      hz60: bool(globals.Emul60Hz, false),
      fullscreen: bool(globals.EmulFullScreen, false),
      mute: bool(globals.EmulMute, false),
      portA: str(globals.EmulPortA, ''),
      portB: str(globals.EmulPortB, ''),
      ext: {
        scc: bool(globals.EmulSCC, false),
        msxMusic: bool(globals.EmulMSXMusic, false),
        msxAudio: bool(globals.EmulMSXAudio, false),
        opl4: bool(globals.EmulOPL4, false),
        psg2: bool(globals.EmulPSG2, false),
        v9990: bool(globals.EmulV9990, false),
        ram: bool(globals.EmulRAM, false),
        pac: bool(globals.EmulPAC, false)
      }
    }
  }
}
