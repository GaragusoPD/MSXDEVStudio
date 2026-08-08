/**
 * The IPC contract. Every channel MSXStudio exposes between main and renderer
 * is declared here, with its request/response (or push-event) types.
 *
 * Adding a channel: append one line to `IpcApi` (or `IpcEvents`), implement it
 * in a main-process service, and call `window.api.invoke`/`window.api.on` from
 * a renderer store. Nothing else — never call `ipcRenderer` directly outside
 * `src/preload/index.ts`.
 */

import type { Machine } from './msxgl-consts'
import type { MsxProject } from './msxproj'
import type { ProjectTabsState } from './tabs'
import type { SearchMatch } from './search'

export type Theme = 'dark' | 'light'

export interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
}

export interface PanelLayout {
  sideVisible: boolean
  sideWidth: number
  bottomVisible: boolean
  bottomHeight: number
}

/** Global toolchain paths (Spec 02), persisted via StateService like everything else in AppState. */
export interface ToolchainSettings {
  msxglPath: string | null
  openmsxPath: string | null
  /** Override; default = bundled tools/build/Node/node(.exe) inside msxglPath. */
  nodePath: string | null
}

export interface MsxglStatus {
  valid: boolean
  path: string | null
  /** Git HEAD short sha, or `"downloaded YYYY-MM-DD"` for a zip install. Null if unknown/invalid. */
  version: string | null
  /** Sentinel files (relative paths) missing from `path`, when invalid. */
  missing: string[]
  isGitRepo: boolean
}

export interface OpenmsxStatus {
  valid: boolean
  path: string | null
  version: string | null
}

export interface ToolchainStatus {
  msxgl: MsxglStatus
  openmsx: OpenmsxStatus
  /** `process.platform` of the main process, so the renderer can pick install guidance text. */
  platform: string
}

export interface ToolchainProgress {
  phase: 'clone' | 'download' | 'extract' | 'update'
  message: string
  percent: number | null
}

/**
 * One completable MSXgl symbol, parsed out of the engine headers' own
 * NaturalDocs comments (see `main/services/msxgl-symbols.ts`).
 */
export interface MsxglSymbol {
  name: string
  kind: 'function' | 'constant'
  /** Declaration with SDCC attributes stripped, e.g. `void VDP_SetPaletteEntry(u8 index, u16 color)`. */
  signature?: string
  /** The doc comment's description, or a trailing `//` comment for constants. */
  detail?: string
  /** `name - description` per documented parameter. */
  params?: string[]
  /** MSXgl's compatibility tag when it has one, e.g. `MSX2/2+/TR`. */
  machines?: string
  /** Header this came from, relative to the MSXgl root. */
  file: string
}

/** A file-tree entry as returned by `fs:readDir`, one level (not recursive). */
export interface FsEntry {
  name: string
  /** Project-root-relative, forward-slash. */
  path: string
  isDirectory: boolean
  /** OS-native absolute path, for "Reveal"/"Copy path" display only — never sent back for `fs:*` calls. */
  absolutePath: string
}

export interface FsStat {
  isDirectory: boolean
  size: number
  mtimeMs: number
}

export interface FsChangeEvent {
  type: 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir'
  /** Project-root-relative, forward-slash. */
  path: string
}

export interface AppState {
  windowBounds: WindowBounds
  /** Absolute path to the last opened project, if any. */
  lastProject: string | null
  /** Most-recent-first, capped at 10. */
  recentProjects: string[]
  theme: Theme
  panelLayout: PanelLayout
  toolchain: ToolchainSettings
}

/** The currently open project, as `project:open`/`create`/`save` return it. */
export interface OpenProject {
  /** Absolute path of the project root folder (also the FsService root). */
  root: string
  /** Root-relative `.msxproj` filename, e.g. `mygame.msxproj`. */
  projectFile: string
  project: MsxProject
  /** True when the folder had no `.msxproj` and one was imported from `project_config.js`. */
  imported: boolean
}

export interface NewProjectRequest {
  name: string
  /** Absolute parent folder; the project is created in `<location>/<name>`. */
  location: string
  machine: Machine
  target: string
  libModules: string[]
}

/** What the Build/Run buttons ask for (Spec 04). `run` = build, then launch the preferred emulator. */
export type BuildCommand = 'build' | 'rebuild' | 'clean' | 'run'

/** One diagnostic parsed out of the build output; same shape as the renderer's `Problem`. */
export interface BuildProblem {
  id: string
  severity: 'error' | 'warning' | 'info'
  message: string
  /** Project-root-relative, forward-slash — only set when the file is inside the project (so it can be clicked). */
  file?: string
  line?: number
}

/** A deployed build output (ROM/DSK/COM/BIN/MAP…). */
export interface BuildArtifact {
  /** Project-root-relative, forward-slash — safe to pass to `fs:reveal`. */
  path: string
  size: number
}

export interface BuildFinished {
  ok: boolean
  /** Process exit code; null when the build was killed or failed to spawn. */
  code: number | null
  artifacts: BuildArtifact[]
  problems: BuildProblem[]
  /** Friendly explanation for a failure (exit-code hint, killed, …). Null on success. */
  message: string | null
}

/** Outcome of one resource export or imgRule conversion (Spec 07). */
export interface ConversionResult {
  kind: 'resource' | 'imgRule'
  /** Project-root-relative source path. */
  input: string
  /** Project-root-relative output path. */
  out: string
  status: 'converted' | 'skipped' | 'failed'
  /** Failure reason, or a short note about what was written. */
  message?: string
}

/** One editor resource found in the project, for the Resources panel. */
export interface ResourceEntry {
  /** Project-root-relative, forward-slash. */
  path: string
  kind: 'tiles' | 'btiles' | 'sprites' | 'map' | 'screen' | 'sfx'
  /** Its `export.out`, or null when the file has no export block. */
  out: string | null
}

/** One file's status vs the index (`staged`) and vs the working tree (`unstaged`); either may be null. */
export type GitChangeCode = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange' | 'untracked'

export interface GitFileStatus {
  /** Project-root-relative, forward-slash. Current path (post-rename, for renamed entries). */
  path: string
  /** Set only for renamed/copied entries — the path it was staged from. */
  origPath?: string
  staged: GitChangeCode | null
  unstaged: GitChangeCode | null
  /** Unmerged (conflict) entry — `staged`/`unstaged` are meaningless when true. */
  conflicted: boolean
}

export interface GitStatus {
  isRepo: boolean
  /** False when the `git` binary itself couldn't be run (missing/not on PATH). */
  gitAvailable: boolean
  /** Current branch name, or null when detached or no commits yet. */
  branch: string | null
  detached: boolean
  /** True when HEAD has no commits yet (a freshly `git init`'d repo). */
  initial: boolean
  /** Upstream branch (`origin/main`), or null when unset. */
  upstream: string | null
  ahead: number
  behind: number
  files: GitFileStatus[]
}

export interface GitBranch {
  name: string
  current: boolean
  upstream: string | null
}

export interface GitLogEntry {
  hash: string
  shortHash: string
  author: string
  email: string
  /** ISO 8601 (author date); the renderer formats it relative-to-now. */
  date: string
  subject: string
  body: string
}

/** Old (left) / new (right) file contents for the diff editor — see `git:diff`. */
export interface GitDiffResult {
  old: string
  new: string
}

/** Outcome of a push/pull: never throws — failures surface as `stderr` for the Output panel. */
export interface GitResult {
  ok: boolean
  stderr: string
}

/** Main-process handlers, invoked from the renderer via `window.api.invoke`. */
export interface IpcApi {
  'app:getState': { req: void; res: AppState }
  'app:setState': { req: Partial<AppState>; res: AppState }
  'toolchain:getStatus': { req: void; res: ToolchainStatus }
  'toolchain:setPaths': { req: Partial<ToolchainSettings>; res: ToolchainStatus }
  'toolchain:downloadMsxgl': { req: { targetDir?: string }; res: ToolchainStatus }
  'toolchain:updateMsxgl': { req: void; res: ToolchainStatus }
  /** Native folder-picker dialog; used for both the MSXgl path and a download target. */
  'toolchain:pickFolder': { req: void; res: string | null }
  /** MSXgl API symbols for editor completion; empty when MSXgl is not configured.
   *  Cached in main per checkout — `force` re-reads it after an update to the same path. */
  'toolchain:msxglSymbols': { req: { force?: boolean }; res: MsxglSymbol[] }
  /** Native file-picker dialog; used for both the openMSX and node executable overrides. */
  'toolchain:pickFile': { req: void; res: string | null }
  /** Scaffolds a new project from the MSXgl template and opens it. */
  'project:create': { req: NewProjectRequest; res: OpenProject }
  /** Opens a folder or `.msxproj` path; with no `path`, shows a folder picker (null if canceled).
   *  A folder holding only `project_config.js` is imported (`customConfig: true`). */
  'project:open': { req: { path?: string }; res: OpenProject | null }
  /** Writes the `.msxproj` and regenerates `project_config.js` (unless `customConfig`). */
  'project:save': { req: { project: MsxProject }; res: OpenProject }
  'project:close': { req: void; res: void }
  /** LibModules candidates from a scan of `<msxgl>/engine/src/`; cached per MSXgl path. */
  'project:libModules': { req: void; res: string[] }
  /** Per-project workbench state from `<project>/.msxstudio/state.json`. */
  'project:getIdeState': { req: void; res: ProjectTabsState | null }
  'project:setIdeState': { req: ProjectTabsState; res: void }
  'fs:readDir': { req: { path: string }; res: FsEntry[] }
  'fs:stat': { req: { path: string }; res: FsStat | null }
  'fs:read': { req: { path: string }; res: string }
  'fs:write': { req: { path: string; content: string }; res: void }
  /** Binary-safe variants (Spec 10): `fs:read`/`fs:write` round-trip through UTF-8 and corrupt arbitrary
   *  bytes — the screen editor's source PNGs need these instead. */
  'fs:readBinary': { req: { path: string }; res: ArrayBuffer }
  'fs:writeBinary': { req: { path: string; content: ArrayBuffer }; res: void }
  'fs:rename': { req: { path: string; newPath: string }; res: void }
  'fs:delete': { req: { path: string }; res: void }
  'fs:create': { req: { path: string; kind: 'file' | 'directory' }; res: void }
  'fs:reveal': { req: { path: string }; res: void }
  /** Uses ripgrep from PATH when present, else FsService's recursive fallback scanner. */
  'search:query': { req: { query: string; include?: string; exclude?: string }; res: SearchMatch[] }
  /** Runs one build command; rejects if a build is already running. Resolves when it finishes. */
  'build:start': { req: { command: BuildCommand }; res: BuildFinished }
  /** Terminates the running build's process tree. No-op when idle. */
  'build:kill': { req: void; res: void }
  /** Opens an http(s) URL in the default browser, or a local path with its default app. */
  'shell:open': { req: { target: string }; res: void }
  /** Spec 07: every `*.tiles|sprites|map|screen.json` in the project, for the Resources panel. */
  'resources:list': { req: void; res: ResourceEntry[] }
  /** Spec 07: exports one editor resource to its `export.out`. `force` ignores the mtime skip. */
  'resources:exportOne': { req: { path: string; force?: boolean }; res: ConversionResult }
  /** Spec 07: every resource plus every `imgRules` entry. Spec 04 calls this before each build. */
  'resources:exportAll': { req: { force?: boolean }; res: ConversionResult[] }
  /** Spec 07: absolute path of the bundled `MSXimg.txt` CLI help, or null when MSXgl isn't configured. */
  'resources:msximgHelp': { req: void; res: string | null }
  /** Spec 12: which of these sample ids still have a `<id>.c` on disk (catalog survives MSXgl version drift). */
  'examples:existingIds': { req: { ids: string[] }; res: string[] }
  /** Spec 12: the read-only source of one MSXgl sample, for the example viewer tab. */
  'examples:read': { req: { id: string }; res: string }
  /** Spec 12: builds and (if an emulator is configured) runs a sample in place, in
   *  `<msxgl>/projects/samples` — no project involved, same one-build-at-a-time rule. */
  'examples:tryIt': { req: { id: string }; res: BuildFinished }
  /** Spec 12: forks a sample into a new project (asset dependencies copied/renamed per
   *  the sample's evaluated config), then opens it like `project:create` would. */
  'examples:fork': {
    req: { id: string; request: NewProjectRequest; copyEntireContent?: boolean }
    res: { opened: OpenProject; notices: string[] }
  }
  /** Non-repo/non-project folders resolve to an all-false/empty status, never an error. */
  'git:status': { req: void; res: GitStatus }
  'git:stage': { req: { paths: string[] }; res: GitStatus }
  'git:unstage': { req: { paths: string[] }; res: GitStatus }
  /** Renderer confirms first — destructive (untracked files are deleted; tracked changes reverted to the index). */
  'git:discard': { req: { paths: string[] }; res: GitStatus }
  'git:commit': { req: { message: string; amend?: boolean }; res: GitStatus }
  'git:log': { req: { limit?: number; path?: string }; res: GitLogEntry[] }
  /** Local branches only. */
  'git:branches': { req: void; res: GitBranch[] }
  'git:checkout': { req: { name: string }; res: GitStatus }
  /** Creates and switches to a new branch off HEAD. */
  'git:createBranch': { req: { name: string }; res: GitStatus }
  'git:push': { req: void; res: GitResult }
  'git:pull': { req: void; res: GitResult }
  /** `staged`: diff index vs HEAD; else diff working tree vs index. `origPath` reads the old side from a rename's source path. */
  'git:diff': { req: { path: string; staged?: boolean; origPath?: string }; res: GitDiffResult }
  /** `git init` + a starter `.gitignore` (only written when none exists yet). */
  'git:init': { req: void; res: GitStatus }
  'git:clone': { req: { url: string; targetDir: string }; res: void }

  /**
   * Spawns a shell in a PTY under `id`, cwd = the open project. Idempotent:
   * a view re-attaching to a terminal it already started must not fork a
   * second shell, so an id that is already running is left alone.
   */
  'terminal:start': { req: { id: string; cols: number; rows: number }; res: void }
  'terminal:write': { req: { id: string; data: string }; res: void }
  'terminal:resize': { req: { id: string; cols: number; rows: number }; res: void }
  /** Kills the shell and forgets the id — closing a terminal. */
  'terminal:kill': { req: { id: string }; res: void }
}

/** Main → renderer push events, subscribed to via `window.api.on`. */
export interface IpcEvents {
  'app:stateChanged': AppState
  'toolchain:progress': ToolchainProgress
  'fs:changed': FsChangeEvent
  /** Pushed whenever the open project changes on the main side (null = closed). */
  'project:changed': OpenProject | null
  'build:started': { command: BuildCommand }
  /** Line-buffered, ANSI-stripped build output, batched per stream chunk. */
  'build:output': { channel: 'build' | 'build:err'; lines: string[] }
  'build:finished': BuildFinished
  /** Pushed after every mutating `git:*` call and on out-of-band `.git/HEAD`/`.git/index` changes. */
  'git:changed': GitStatus
  /** Raw PTY output — ANSI intact, unlike `build:output`, because xterm renders it. */
  'terminal:data': { id: string; data: string }
  'terminal:exit': { id: string; code: number }
  /** An application-menu item was clicked — see `MenuCommand`. */
  'menu:command': MenuCommand
}

/**
 * What the application menu can ask for. `main/menu.ts` builds the menu from
 * these and `renderer/src/menu-commands.ts` runs each one through the store
 * action the equivalent button already uses, so a menu item is never a second
 * implementation of anything. `help.*` is answered in the main process.
 */
export type MenuCommand =
  | 'file.newProject'
  | 'file.openProject'
  | 'file.save'
  | 'file.saveAll'
  | 'file.projectSettings'
  | 'file.toolchainSettings'
  | 'file.closeTab'
  | 'edit.undo'
  | 'edit.redo'
  | 'edit.findInFiles'
  | 'build.build'
  | 'build.rebuild'
  | 'build.clean'
  | 'build.run'
  | 'build.stop'
  | 'view.explorer'
  | 'view.search'
  | 'view.git'
  | 'view.resources'
  | 'view.examples'
  | 'view.toggleSide'
  | 'view.toggleBottom'
  | 'view.output'
  | 'view.problems'
  | 'view.terminal'
  | 'view.terminalTab'
  | 'help.docs'
  | 'help.msxgl'
  | 'help.about'

/** Shape of the single preload bridge exposed as `window.api`. */
export interface WindowApi {
  invoke<K extends keyof IpcApi>(channel: K, payload: IpcApi[K]['req']): Promise<IpcApi[K]['res']>
  on<K extends keyof IpcEvents>(channel: K, handler: (payload: IpcEvents[K]) => void): () => void
}
