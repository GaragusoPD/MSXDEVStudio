# Spec 13 — Packaging & Distribution

**Phase:** 5 · **Depends on:** all · **Suggested model:** Sonnet 5

## Goal

Installable builds for Linux and Windows via `electron-builder`.

## Scope

- **Linux:** AppImage + `.deb`. **Windows:** NSIS installer + portable zip.
- App id `com.msxstudio.app`, proper icon set (source SVG → png sizes; a simple
  pixel-art "MSX" monogram placeholder is fine, done in-repo).
- File associations: `.msxproj` (project file, Spec 03) opens the app.
- CI: GitHub Actions workflow building both platforms on tag push, artifacts
  attached to a draft release. No code signing (documented as a known gap; add
  when certificates exist).
- Auto-update: **skipped** — YAGNI until there are users; document manual download.
- The toolchain (SDCC/OpenMSX/MSXgl) is *never* bundled into installers — Spec 02
  downloads/detects at runtime. Verify the packaged app still resolves toolchain
  paths correctly from a clean user profile on both OSes.

## Acceptance

- Fresh Linux VM: AppImage runs, creates a project, builds a ROM (with toolchain
  installed via Spec 02 flow), launches OpenMSX.
- Fresh Windows VM: NSIS install → same loop works.
- CI produces both artifacts from a clean checkout.
