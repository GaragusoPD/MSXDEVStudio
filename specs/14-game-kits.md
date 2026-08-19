# Spec 14 — Game-kit wizard

**Phase:** 6 · **Depends on:** 03, 07, 12 · **Suggested model:** Opus 5

## Goal

A **New Game…** wizard, parallel to Spec 03's thin New Project dialog, that
scaffolds a compiling game skeleton: genre kit, display mode, screen flow,
suggested ROM, MSXgl modules. Experienced users keep the blank template.

## Creation paths (four, not one)

| Path | What it is |
|---|---|
| New Project… | Unchanged Spec 03 hello world |
| New Game… | This spec |
| New from example | Spec 12 sample fork |
| Install Demos… | Authored `demo_msx1` / `demo_msx2` — never used as templates |

## Playability

Playable stub from MSXgl samples (`s_game`, `s_scroll`, `s_hello`, `s_menu`).
Not a mini-game. Demos are not copied.

## Kits and display modes

Graphic kits on MSX2 offer SCREEN 1–8 (a SCREEN 5 platformer is valid).
Text kit: SCREEN 0/40, and SCREEN 0/80 on MSX2+. VN defaults to picture-top +
text-bottom; SCREEN 0 is the text-only opt-out.

## Layout

`main.c` at the project root. Authored kit C in `src/` (`game.h`, `play.c`,
`screens.c`). Editor files stay in `res/`. `ProjModules` is
`["main", "src/play", "src/screens"]`.

## Credits

`src/screens.c` always starts with the license attribution comments
(MSXDEVStudio, MSXgl/MSXtk CC BY-SA 4.0, SDCC; ayFX when selected). The
credits *screen* prints the same strings.

## Acceptance

- File ▸ New Game… and Welcome **New Game…** open the stepped wizard inside
  the shared `Modal` (same shell as New Project).
- File ▸ New Project… is unchanged.
- A text kit on MSX2 can pick SCREEN 0/80; an MSX1 platformer cannot.
- An MSX2 platformer can pick SCREEN 5.
- Generated tree has `main.c` at root and kit C under `src/`.
- `src/screens.c` always contains the attribution comments; they are printed
  only when Credits is selected.
- Every kit **links** against a real MSXgl, not just compiles: the scaffolder
  patches `msxgl_config.h` for the modules it turns on (`PAWN_*`, `SCROLL_SRC_*`),
  and `game-kit-build.test.ts` builds one project per `emitPlayC` branch.
- A bitmap-mode kit scaffolds no screen resource — 27 KB of picture does not fit
  in the 32 KB an ASCII-8 ROM pages in at boot.
- `npm run check` and the new `game-kit` tests pass.
