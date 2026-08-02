# Spec 12 — Examples Browser ("solved code")

**Phase:** 2 · **Depends on:** 01, 02, 03, 04 · **Suggested model:** Sonnet 5

## Goal

Surface MSXgl's 56 sample projects as browsable, runnable, forkable recipes —
scrolling, sprites, mappers, sound drivers, etc. — so a "how do I do X on MSX"
question is answered with working code, not documentation.

## Catalog

Samples live in **one** folder, `<msxglPath>/projects/samples/`, as
`s_<name>.c` (source) + `s_<name>.js` (per-sample config override). Ship a curated
static catalog `src/renderer/examples/catalog.json` — one entry per sample:
`{ id: "s_scroll", title, category, machine, target, description, tags }`.
Categories: Getting started · Text & print · Graphics & VDP · Sprites · Scrolling ·
Tiles & maps · ROM mappers & memory · Sound & music · Input & devices · Storage &
DOS · System & misc. (Author the descriptions from the sample table in
`specs/msxgl-notes.md`.) At load, drop entries whose `.c` file is missing (catalog
survives MSXgl version drift); log dropped ids to console.

## UI (activity-bar "Examples" panel + editor tabs)

- Panel: search box + category tree of catalog entries with machine badges
  (MSX1/2/2+…).
- Clicking opens a read-only Monaco tab of `s_<name>.c` (registry entry
  `example-viewer`) with a header bar: description, machine/target chips, and two
  actions:
  - **▶ Try it** — builds and runs the sample *in place*: Spec 04's BuildService
    with cwd = `<msxglPath>/projects/samples` and extra args
    `projname=<id> run`. No files copied, no project needed; output streams to the
    normal Output panel. (Requires toolchain + emulator configured; same gating as
    any run.)
  - **⧉ New project from example** — Spec 03 wizard pre-filled: machine/target from
    the sample's `.js` (evaluated with the Spec 03 sandbox evaluator, which also
    yields `LibModules`, `RawFiles`, `DiskFiles`, `Emul*` overrides → mapped into
    the new `.msxproj`), `main.c` = copy of `s_<name>.c`, `msxgl_config.h` copied
    from `samples/msxgl_config_msx1.h` or `_msx2.h` per machine.

## Asset dependency copying (the only subtle part)

Samples reference shared generated data. When forking, copy into the new project:

1. Every `#include "<path>"` in the sample source that resolves to a file under
   `samples/content/` (resolve against the sample's include dirs: project root and
   `content/`); recurse one level into copied headers for nested includes.
2. Every path in the sample config's `RawFiles` / `DiskFiles`.
3. Mapper-segment siblings: any `s_<name>_s*_b*.c/.asm` and `s_<name>_p0.c` files
   (copy beside `main.c`, renamed to `<projname>_s*_b*` to match MSXgl's
   segment-discovery convention).

If an include can't be resolved, list it in a post-create notice rather than
failing. Provide a "copy entire samples content/ folder" checkbox as the blunt
fallback.

## Docs links

Panel footer: MSXgl doc (https://aoineko.org/msxgl-doc), offline copy at
`<msxglPath>/engine/doc/html/index.html` (open externally).

## Acceptance

- Try-it on `s_hello` and `s_scroll` boots in openMSX untouched.
- Fork `s_scroll` → new project builds and runs without manual fixes.
- Fork `s_mapper` (segment files) and `s_vgm` (RawFiles) → segment sources renamed
  correctly, raw files copied, project builds.
- Catalog search finds "scroll" and machine badges are correct.
