# Spec 01 — Application Shell

**Phase:** 1 · **Depends on:** none · **Suggested implementation model:** Sonnet 5

## Goal

Scaffold the Electron + Vue 3 application every other spec builds on: window, process
architecture, IPC contract pattern, layout chrome, theming, and persisted app state.

## Stack (fixed — do not substitute)

- Electron (current stable), `electron-vite` for dev/build tooling
- Vue 3 (script setup + TypeScript), Pinia, Vue Router
- Monaco editor (used by later specs; install now)
- `electron-builder` config present but packaging polish is Spec 13
- Target OS: Linux and Windows. No hard-coded paths, use `path.join`/`app.getPath`.

## Process architecture

- **Main process** hosts all services (files, git, toolchain, build, emulators — added by
  later specs) under `src/main/services/`. Services are plain classes registered in
  `src/main/index.ts`.
- **Renderer** is the Vue app in `src/renderer/`. No Node integration;
  `contextIsolation: true`, single preload at `src/preload/index.ts`.
- **IPC contract:** one shared file `src/shared/ipc.ts` declares every channel with its
  request/response types:

```ts
export interface IpcApi {
  'app:getState': { req: void; res: AppState }
  // later specs append here, e.g. 'build:run', 'git:status', …
}
export interface IpcEvents {
  'app:stateChanged': AppState
  // main → renderer push events
}
```

  The preload exposes exactly `window.api.invoke(channel, payload)` (typed against
  `IpcApi`) and `window.api.on(channel, handler)` (typed against `IpcEvents`). Later
  specs extend these two interfaces only — never add ad-hoc `ipcRenderer` calls.

## Window & layout

Single main window, VS Code-like chrome, dark theme default:

- **Activity bar** (left edge, icons): Explorer, Search, Git, Resources, Run — routes
  swap the side panel. Panels themselves come from later specs; ship placeholders.
- **Side panel** (collapsible, resizable via drag handle).
- **Editor area** (center): tab strip + router-view. Placeholder "Welcome" tab for now.
- **Bottom panel** (collapsible): tabs for Output / Problems / Terminal-like build log.
  Ship the container + an Output pane component that later specs write into via a
  Pinia `outputStore` (`append(channel: string, line: string)`).
- **Status bar**: left = project name / git branch (placeholder), right = target
  machine + screen mode (placeholder).

Use plain CSS grid + a small splitter component (write one, ~50 lines; no docking
library). Theme via CSS custom properties in `src/renderer/theme.css` (dark + light,
dark default).

## App state

Pinia `appStore` persisted to `app.getPath('userData')/state.json` via a
`StateService` in main (debounced write). Holds: window bounds, last opened project
path, recent projects list (max 10), theme, panel sizes/visibility.

On startup: restore window bounds; if a last project exists, later specs reopen it
(shell just exposes the value).

## Welcome screen

Shown when no project is open: recent projects list, "New Project" and "Open Project"
buttons (buttons emit to `projectStore` stubs; wired for real in Spec 03).

## Acceptance

- `npm run dev` opens the window with all chrome regions, panels collapse/resize, state
  survives restart.
- `npm run build && npm run start` works on Linux; `electron-builder --dir` produces an
  unpacked build without errors for Linux and Windows targets.
- Adding a new IPC channel requires touching only `src/shared/ipc.ts`, one service, and
  the calling store — demonstrate with `app:getState`.
- ESLint + `vue-tsc` pass; both wired into `npm run check`.
