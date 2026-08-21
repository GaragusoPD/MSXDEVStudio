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
text-bottom; SCREEN 0 is the text-only opt-out — and VN excludes SCREEN 3 for the
same reason it excludes SCREEN 1: it needs `Print`, which MULTICOLOR has not got.

The **chunky arcade** kit is SCREEN 3 only, on every machine: a 64×48 playfield
of 4×4 blocks with no colour clash, drawn into a RAM shadow and page-flipped.
Every other kit on SCREEN 3 takes the name-table path instead, so a scroller gets
MSXgl's real camera.

A SCREEN 3 kit runs its title, menu and credits in **SCREEN 1** — MSXgl's `Print`
is an empty case in MULTICOLOR and the pattern table it would load a font into is
the picture. `GAME_TEXT_VDP_MODE` is that second macro; it equals
`GAME_VDP_MODE` in every other mode.

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
  in the 32 KB an ASCII-8 ROM pages in at boot. A **SCREEN 3** kit does scaffold
  one: 1536 bytes fits with room to spare.
- `configPatches` writes `VDP_USE_MODE_MC TRUE` (which has no engine default, and
  makes `VDP_SetMode` a silent no-op when FALSE) and `VDP_USE_MODE_G2 TRUE`
  (which is what compiles `VDP_WriteLayout_GM2`) for every SCREEN 3 kit.
- `npm run check` and the new `game-kit` tests pass.
