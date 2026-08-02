# Spec 05 — Workbench: File Explorer, Code Editor, Search

**Phase:** 1 (minimal) / 2 (complete) · **Depends on:** 01, 03 · **Suggested model:** Sonnet 5

## Goal

The VS Code-like core: browse the open project's files, edit them in Monaco tabs,
search across the project. Phase 1 needs the explorer + editor tabs; search and
polish land in Phase 2.

## File explorer (side panel, "Explorer" activity)

- Tree of the open project folder. Main-process `FsService` provides
  `fs:readDir`, `fs:stat`, `fs:read`, `fs:write`, `fs:rename`, `fs:delete`,
  `fs:create` IPC channels and pushes `fs:changed` events from a `chokidar` watcher
  scoped to the project root (ignore `node_modules`, `out`, `emul`, `.git` contents).
- Context menu: New File, New Folder, Rename, Delete (to OS trash via
  `shell.trashItem`), Reveal in file manager, Copy path.
- Resource files with dedicated editors (`.tiles.json`, `.sprites.json`, `.map.json`,
  `.screen.json`, `.sfx.json` — see Specs 08–11) get distinct icons and open in their
  editor instead of Monaco. Icon/editor mapping lives in one registry:
  `src/renderer/editors/registry.ts` — later specs register themselves there.

## Editor area

- Tab strip over Monaco. Dirty-dot on unsaved tabs, middle-click close, Ctrl+S save,
  Ctrl+W close, Ctrl+Tab MRU switch. Prompt on closing dirty tabs.
- Monaco languages: C (`.c/.h`), assembly (`.s/.asm` — plain text with `asm` syntax if
  a community Monarch grammar is trivial to inline, else plaintext), JSON, Markdown.
- Editor settings that matter for retro C: tab size 4, insert spaces, trailing
  whitespace trim on save, `.editorconfig` respected if present. No LSP/IntelliSense
  beyond Monaco's built-in word completion — MSXgl header-aware completion is a
  possible later spec, not this one.
- Persist open tabs + active tab per project in the project's IDE state (Spec 03).

## Search (Phase 2)

- Side panel "Search": query + include/exclude globs, results grouped by file,
  click jumps to location. Implement with `ripgrep` if present on PATH, else a
  simple recursive scan in `FsService` (both behind `search:query` IPC). Replace is
  out of scope.

## Problems panel

- The bottom-panel "Problems" tab lists diagnostics pushed to a Pinia
  `problemsStore` (`set(source, Problem[])`). This spec builds the UI list
  (file:line, message, severity, click-to-jump); Spec 04 feeds it from SDCC output.

## Acceptance

- Open project → tree renders, external file changes appear within 1s.
- Editing round-trip: open `.c` file, edit, save, dirty state correct, reopen after
  restart restores tabs.
- 10k-file project doesn't freeze the UI (tree loads lazily per directory).
- Search finds a known string in the MSXgl `engine/src` tree in under 2s with ripgrep.
