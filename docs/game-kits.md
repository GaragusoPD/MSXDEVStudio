# New Game kits

**File ▸ New Game…** (or **New Game…** on the Welcome tab) builds a project that
already has a screen flow, the right MSXgl modules, and a playable stub. It is
not a finished game, and it is not the same as **New Project…**.

## Two ways to start

| Button | What you get |
|---|---|
| **New Project…** | MSXgl's blank `template.c`. Machine, target, modules. For people who want a 15-line hello world. |
| **New Game…** | A kit: genre, display mode, title/menu/credits, suggested ROM size. |

**New from example** (the Examples panel) still forks one MSXgl sample as-is.
**Install Demos…** copies the two authored demo games so you can study them —
those are not templates.

## Kits

| Kit | What the stub does | MSXgl sample it follows |
|---|---|---|
| Text | Print in SCREEN 0 (40 or 80 columns) | `s_hello`, `s_menu` |
| Platformer | Walk, jump, gravity | `s_game` (pawn) |
| Side scroller | Hardware scroll on X | `s_scroll` |
| Vertical scroller | Hardware scroll on Y | `s_scroll` |
| Top-down | Four-way walk, no gravity | `s_game` pawn, gravity off |
| Visual novel | Picture on top, dialogue below | custom, using `print` |
| Chunky arcade | Move a block-grid actor around a 64×48 SCREEN 3 playfield | custom — MSXgl has no SCREEN 3 sample |

A SCREEN 5 platformer is a real option — Vampire Killer did it. On MSX2 the
graphic kits offer SCREEN 1 through 8. SCREEN 0 is for the text kit and for a
visual novel that wants no picture.

### SCREEN 3, and the chunky arcade kit

SCREEN 3 is the MSX1 mode with **no colour clash**: 64×48 blocks of 4×4 dots,
any of the fixed 16 colours each, plus the 32 hardware sprites. It is what recent
chunky-pixel ZX Spectrum games build in software, and it works on every machine.

The **chunky arcade** kit is built around it. The whole playfield is a
1536-byte RAM shadow of the framebuffer; drawing happens there and only the
8-byte column strips that changed go to VRAM, so a moving actor costs a fraction
of a frame instead of two thirds of one. It is **double buffered** — the two
pages are two pattern tables and the flip is a single register write, so nothing
is copied and nothing tears. Collision is reading the picture back: with no
colour clash there is nothing between you and the blocks.

Every *other* kit on SCREEN 3 takes the other path — 2×2-block tiles are one
name-table entry each, so a map draws with the same call SCREEN 2 uses and a
scroller gets MSXgl's real camera.

One rule to know: **do not `Print` in SCREEN 3.** MSXgl's Print module does
nothing there, and the pattern table a font would load into is the picture. A
SCREEN 3 kit runs its title, menu and credits in SCREEN 1 and switches to
SCREEN 3 for play — that is what `GAME_TEXT_VDP_MODE` in `src/game.h` is.

The stub has no coins, lives, or win condition. You replace the art in `res/`
and the rules in `src/play.c`.

## What lands on disk

```
main.c              starts the state machine
src/game.h          shared constants
src/play.c          the play state
src/screens.c       title, menu, credits, …
res/                tiles, sprites, maps, screens — edit these
content/            generated from res/ (do not hand-edit)
```

`main.c` stays at the root so MSXgl still finds it. Everything else the kit
authors lives in `src/`, the same "one folder, one job" split `res/` already
uses.

`State_Play()` sets the level up once and hands over to `State_Resume()`, which
is the frame loop — gameplay goes there. Pause comes back through `State_Play`,
so the screen is redrawn rather than left with "PAUSED" printed over it.

## What the wizard changes in msxgl_config.h

The MSXgl templates are written for a blank hello world, so a kit rewrites the
`#define`s its modules need: the pawn kits turn off `PAWN_USE_SPRT_FX` and
`PAWN_USE_RT_LOAD` (nothing links the `spritefx` module) and read collisions
from VRAM, and the scrolling kits set `SCROLL_SRC_W`/`SCROLL_SRC_H` to the size
of the map in `res/`. **If you resize that map, change those two too** — the
scroll module reads the map through them, not through the export.

## Bitmap modes have no scaffolded picture

A SCREEN 5–8 picture is around 27 KB, and an ASCII-8 ROM only pages 32 KB in at
boot, so a kit in a bitmap mode ships no screen resource: the visual novel fills
its picture panel with a VDP command and says so in a comment. To ship a real
picture, export it as a raw file and place it on an 8 KB segment boundary via
the project's `files.rawFiles` — `demo_msx2` is the worked example.

SCREEN 3 is the exception: a whole screen is 1536 bytes, so the chunky kit does
scaffold `res/playfield.screen.json` and it fits with room to spare. Draw in it
and it becomes the backdrop the level tiles are laid over.

## Credits

`src/screens.c` always starts with the attributions the licenses ask for —
MSXDEVStudio, MSXgl + MSXtk (CC BY-SA 4.0), SDCC, and ayFX when you ticked
that box. If you include a Credits screen, those same lines are printed
in-game. Keep them if you ship the game. Put your own name on the
"Your name here" line.
