# MSXStudio

A desktop IDE for MSX game development: Godot's project/editor model, Pico-8's
"everything included" feel, VS Code's workbench — built on the
[MSXgl](https://github.com/aoineko-fr/MSXgl) C library, SDCC, and OpenMSX/WebMSX.
Targets MSX1, MSX2, MSX2+, and MSX turbo R.

Electron + Vue 3 (TypeScript) + Pinia + Vue Router + Monaco, built with
`electron-vite`, packaged with `electron-builder`. Ships on Linux and Windows.

See `specs/` for the full implementation plan — all of Specs 01–13 are
implemented: the app shell, toolchain acquisition, the project system, build
& run, the workbench editors (tile/sprite/map/screen/SFX), Git, the examples
browser, and packaging.

## Installing

MSXStudio isn't auto-updating (see "Known gaps") — grab the latest installer
for your OS from the project's GitHub Releases page and reinstall for
updates:

- **Linux:** `.AppImage` (`chmod +x`, then run) or `.deb`
  (`sudo apt install ./msxstudio-*.deb`).
- **Windows:** the `-setup.exe` installer, or the `-portable.exe` for a
  no-install copy.

Opening a `.msxproj` file (double-click, or `msxstudio path/to/Game.msxproj`
on the command line) launches MSXStudio straight into that project; if
MSXStudio is already running, it focuses the existing window instead of
starting a second copy.

MSXgl/SDCC/openMSX are never bundled in the installer — first run walks you
through Spec 02's toolchain setup (download or point at an existing install).

## Known gaps

- **No code signing.** Windows SmartScreen and Linux/browser download
  warnings are expected until a certificate exists — add signing to
  `electron-builder.yml` (`win.certificateFile`/`signtoolOptions`, notarization
  isn't relevant since there's no macOS target) when one does.
- **No auto-update.** YAGNI until there are users; see "Installing" above.

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Launch the app in development, with hot reload |
| `npm run build` | Type-check and bundle main/preload/renderer via electron-vite |
| `npm run start` | Preview the production build (`electron-vite preview`) |
| `npm run lint` | ESLint over the whole repo |
| `npm run typecheck` | `tsc` (main/preload/shared) + `vue-tsc` (renderer) |
| `npm run check` | `lint` + `typecheck` — the CI gate |
| `npm run test` | Vitest over `src/shared/` and `src/main/` |
| `npm run icons` | Regenerate `build/icon.png`/`build/icon.ico` from `scripts/generate-icons.mjs` |
| `npm run monaco:shim` | Regenerate `src/renderer/src/editors/monaco-full.ts` (re-run after bumping `monaco-editor`) |
| `npx electron-builder --dir` | Unpacked build for the current platform |
| `npx electron-builder --linux` / `--win` | Installers, per `electron-builder.yml` |

## Layout

```
src/main/       Electron main: services (state, later: fs, git, toolchain, build…)
src/preload/    single typed bridge: window.api.invoke / window.api.on
src/renderer/   Vue app: activity bar, panels, editor tabs, stores
src/shared/     ipc.ts (the IPC contract) + pure logic shared by main/renderer
specs/          implementation specs, one per feature area
scripts/        build-time generators (app icons, the trimmed Monaco import shim)
docs/           user guides — docs/resources.md (editors and their C output),
                docs/tutorials/ (walkthroughs of the MSXgl graphics samples)
```

## Licensing

MSXStudio itself doesn't bundle or redistribute MSXgl — Spec 02's toolchain
setup downloads it to the user's machine on demand. MSXgl is licensed CC BY-SA 4.0 (with
bundled third-party tools under their own free licenses); games built with it
inherit MSXgl's license terms.
