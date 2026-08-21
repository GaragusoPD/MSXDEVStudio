# MSXgl Repository Reference (for implementers)

Facts gathered from a clone of https://github.com/aoineko-fr/MSXgl (branch `main`,
HEAD `946ce2b`, July 2026). `<ROOT>` = the MSXgl folder. Verify against the user's
actual checkout when implementing; this is the ground truth the specs were written
against.

## Layout

`engine/` (library sources + build tool + docs) · `projects/` (template,
template_msx2, samples, targets) · `tools/` (bundled toolchain). License CC BY-SA 4.0.

## Build system (Node.js — no Makefile, no Python)

- Entry: `node <ROOT>/engine/script/js/build.js <args>` with **cwd = project folder**
  (`ProjDir = process.cwd()`). Engine root is derived from build.js's `__dirname` —
  projects can live anywhere.
- Bundled Node v18.12.1 at `tools/build/Node/node(.exe)`; no npm deps.
- Config chain (each a plain JS file executed into globals, later wins):
  `engine/script/js/setup_global.js` (defaults) → `<ROOT>/projects/default_config.js`
  (user-global, gitignored, auto-created; set `Emulator` here) →
  `<ProjDir>/project_config.js` → `<ProjDir>/<ProjName>.js` (optional sub-project
  override; how `samples/` hosts 56 projects) → CLI args.
- CLI args: `projname= target= machine= romsize= delay ramisr ramseg ram3isr clean
  compile make package deploy run all rebuild none define=NAME[:value] help`.
- Steps: Compile (sdcc/sdasz80 per file, `-DTARGET/-DROM_SIZE/-DMSX_VERSION`,
  `-I<proj> -I<engine/src> -I<engine/content> -I<tools>`) → Make (sdar lib + sdcc
  link → .ihx) → Package (`MSXhex`) → Deploy (fills `<proj>/emul/{rom,bin,cas,dsk,
  dos1,dos2}/`, DSK via `msxtar`) → optional Run (emulator).
- Build also writes into the project: `out/`, `<name>_rawdef.h`, `version.h`,
  `out/crt0_config.asm`, optionally `out/compile_commands.json` (`GenCompileDB`).
- Distinct exit codes: 20/30/35/40/50 tool paths, 110 bad LibModules entry,
  500 openMSX turbo-R/C-BIOS gap, 540 meisei non-ROM.

## project_config.js — key settings

`ProjName`, `ProjModules`, `ProjSegments`, `LibModules` (engine modules to compile,
resolved as `engine/src/<entry>.c`, subdirs as `dir/name`), `AddSources`, `AddLibs`,
`Machine` ("1","2","12","2K","2P","22P","122P","0","TR"), `Target`, `ROMSize`,
`ROMSkipBoot(Key)`, `CheckVersion`, `ROMDelayBoot`, `AddROMSignature`,
`InstallRAMISR` (NONE/PAGE0/SEGMENT0/PAGE3), `CustomISR` (NONE/ALL/VBLANK/VHBLANK/
V9990), `BankedCall`, `ForceCodeAddr/ForceRamAddr`, `RawFiles`
(`{offset|page|segment, file}` → injected by MSXhex, defines generated into
`<name>_rawdef.h`), `DiskFiles`, `DiskSize` ("360K"/"720K"), `AppSignature/
AppCompany/AppID`, `Debug`, `AllowUndocumented`, `AsmOptim`, `Optim`
(Default/Speed/Size), `CompileComplexity`, `CompileOpt/LinkOpt`, `BuildVersion`,
`PreBuildScripts/PostBuildScripts`, `Verbose`, `Emulator` (path; empty silently
disables run), `EmulMachine/Emul60Hz/EmulFullScreen/EmulMute/EmulDebug/EmulTurbo/
EmulExtraParam`, extensions `EmulSCC/EmulMSXMusic/EmulMSXAudio/EmulOPL4/EmulPSG2/
EmulV9990/EmulRAM/EmulPAC/EmulKanji/EmulPrinter/Emul2ndCart`, `EmulPortA/B`
(Joystick/Mouse/Paddle/JoyMega/NinjaTap), `RunDevice(Opt)`, `Analyzer*`,
`Standalone`, `Loc*`.

Configs are executed, not parsed (template literals, spreads) — read effective
values only via a sandboxed evaluation, never regex.

Each project also has `msxgl_config.h` (~257 `#define`s: engine compile-time
feature config — BIOS/VDP/INPUT/AUDIO drivers/SCROLL/TILE/etc.). Samples use a
dispatcher including `msxgl_config_msx1.h` / `_msx2.h` on `MSX_VERSION`.

## Targets (setup_target.js)

BIN/BIN_DISK/BIN_TAPE/BIN_USR (BASIC), DOS0/DOS1/DOS2/DOS2_MAPPER (.com),
ROM_8K(_P2)/16K(_P2)/32K/48K(_ISR)/64K(_ISR) (plain ROMs), mapped ROMs:
ROM_ASCII8, ROM_ASCII16, ROM_KONAMI (K4), ROM_KONAMI_SCC (K5), ROM_NEO8, ROM_NEO16,
ROM_YAMANOOTO, ROM_ASCII16X, ROM_POPOLON; RAW (driver), LIB. Aliases: ROM→ROM_32K,
DOS→DOS1, BAS/BIN→BIN_DISK. Mapped-ROM segment sources are auto-discovered by name:
`<ProjSegments>_s<seg>_b<bank>.{c,s,asm}`, page-0 copy `<ProjSegments>_p0.*`.

## Bundled toolchain (tools/) — Linux AND Windows binaries unless noted

- `sdcc/` — SDCC **4.6.0** (sdcc, sdasz80, sdar, sdldz80, sdcpp)
- `MSXtk/bin/` — `MSXhex` (ihx→bin, in build path), `MSXimg` (image converter,
  FreeImage inside), `MSXbin` (bin→C/asm table), `MSXzip` (RLEp + VGM→lVGM),
  `MSXmath`. CLI help dumps beside each binary (`MSXimg.txt` …). MSXcrypt source-only.
- `build/Node/` node v18 · `build/msxtar/` (default DskTool) · `build/DskTool/` ·
  `build/DOS/` (COMMAND.COM/COMMAND2.COM/MSXDOS.SYS/MSXDOS2.SYS) ·
  `build/standalone/Emulicious/` (jar + C-BIOS)
- `audio/` — Arkos `SongTo*.exe`, `trilo/tmucompile.exe`, `pcmenc.exe`
  (**Windows-only**); `pcmplay/wav2pcm.py` (cross-platform, needs ffmpeg)
- `compress/` — Bitbuster, LZ48, Pletter, ZX0 (match engine decompressors)
- Zip-extracted installs on Linux need `chmod +x` on all these binaries.

## Emulator integration (setup_emulator.js)

Selection by executable filename: OPENMSX / EMULICIOUS / FMSX / MSXEC / BLUEMSX /
MEISEI / MSX (RuMSX). openMSX args generated: `-machine C-BIOS_MSX1_EU|
C-BIOS_MSX2_EU|C-BIOS_MSX2+_EU` (+`_JP` for 60 Hz; **no turbo R C-BIOS → exit
500**), `-cart/-diska/-command cassetteplayer…`, `-ext scc|fmpac|audio|moonsound|
2nd_PSG|gfx9000|ram4mb|pac|msxdos2|debugdevice`, `-command "plug joyporta …"`.
Real hardware via `RunDevice`: EASY-USB, RISKY MSX, PICOVERSE 2040.

## Samples (projects/samples/ — 56, `s_<name>.c` + `s_<name>.js`)

hello, text, print, draw, sprite (mode2), sm1 (mode1), sprtfx, swsprt, swtile,
scroll, gm3 (IM2+HBlank scroll), vdpcmd, v9990, bios, sys, math, clock, crypt,
zip (all decompressors), qrcode/qrtiny, loc, game (FSM+pawn), menu, save, keybrd,
joystk, jmega, mouse, paddle, lgun, ntap, usr, wavegm, lpt, pac, onet, drv,
mapper (ASCII8+BankedCall), neomap (NEO-8 8MB), dos, dos0, dos2, dosmap, psg, pt3,
arkos (5 replayers), ayfx, wyz, wyz2, trilo (SCC), vgm, lvgm, ndp, pcmenc, pcmplay.
Shared `content/` (generated headers), `datasrc/` (PNG sources +
`build_data.bat` — Windows-only pipeline the IDE's imgRules replace).
No createproject script exists: template = copy `projects/template(_msx2)/`
(`build.sh/bat`, `project_config.js`, `msxgl_config.h`, `template.c`).

## Engine (engine/src/)

Umbrella `#include "msxgl.h"` (core/system/bios/vdp/draw/print/input/memory/math/
color/clock/compress/string). Other modules included explicitly and enabled via
`LibModules`. Top-level modules: system, bios, vdp, v9990, print, draw, input,
input_manager, keyboard, joystick, mouse, memory, memory_mapper, rom_mapper, math,
string, clock, scroll, tile, sprite_fx, dos, dos_mapper, psg, scc, msx-music,
msx-audio, compress, crypt, debug, fsm, localize, game*. Subdirs: arkos/ ayfx/
compress/ crt0/ device/ game/ mglv/ msxi/ ndp/ network/ pcm/ pt3/ tool/ trilo/
vgm/ wyz/. Audio replayer modules for LibModules: `arkos/akg_player`,
`arkos/akm_player`, `arkos/aky_player`, `ayfx/ayfx_player`, `vgm/vgm_player`,
`vgm/lvgm_player`, `pt3/pt3_player`, `wyz/wyz_player(2)`,
`trilo/trilo_scc_player`, `ndp/ndp_player`, `pcm/pcmenc`, `pcm/pcmplay`.
Ready-made content headers in `engine/content/`: ~45 fonts, 14 palettes, 31 math
tables (on the include path as `-I…/engine/content`).

## MSXimg quick reference

`MSXimg <file> -out <o> -format auto|c|asm|bas|bin -mode bmp|txt|gm1|gm2|sprt|mglv
-pos x y -size x y -num x y -name g_X -trans 0xRRGGBB -bpc 1|2|4|8|16
-pal msx1|custom|input… -dither none|floyd|bayer4|8|16|cluster…
-compress none|crop*|rle*|rlep|auto|best|pletter -data … -asm … -def -idx -bload
-font x y first last` — full help in `tools/MSXtk/bin/MSXimg.txt`. Output headers
carry a round-trippable "Generation parameters" comment block and per-byte ASCII
art.

## SCREEN 3 (MULTICOLOR) — what MSXgl does and does not give you

Extracted from the real checkout; the notes above say nothing about this mode and
neither does any sample. **MSXgl supports SCREEN 3 at the "set the mode and poke
VRAM" level and nothing above it.**

- `VDP_MODE_SCREEN3 = VDP_MODE_MULTICOLOR` (`vdp.h`, `enum VDP_MODE`). Note the
  enum is not in BASIC screen order — MC sits between TEXT1 and GRAPHIC1.
- Table bases (`vdp.h`): `VDP_MC_ADDR_NT 0x0800`, `VDP_MC_ADDR_PT 0x0000`,
  `VDP_MC_ADDR_SAT 0x1B00`, `VDP_MC_ADDR_SPT 0x3800`. There is **no colour
  table** — the pattern byte *is* two 4-bit colours.
- `VDP_SetModeMultiColor()` (`vdp.c`) sets the mode flag and those bases, and
  **nothing else**. In particular it does not write the name table, so the mode
  is not a framebuffer until you do.

**Two traps worth stating outright:**

1. `VDP_USE_MODE_MC` has **no engine-side default** (`config_option.h` and
   `config_default.h` do not mention it) and when it is `FALSE`,
   `VDP_SetMode(VDP_MODE_SCREEN3)` is a **silent no-op** — `g_VDP_Data.Mode` is
   assigned before the switch, so `VDP_GetMode()` afterwards still reports
   MULTICOLOR while the VDP never changed. `projects/template*` ship it `TRUE`;
   `projects/targets/msxgl_config.h` ships it `FALSE`.
2. `VDP_SetSpriteMultiColor` / `VDP_SetSpriteExMultiColor` are **sprite mode 2**
   (MSX2, per-line colour) functions and have nothing to do with this mode. The
   SCREEN 3 sprite API is `VDP_SetSpriteSM1(index, x, y, shape, color)`, sprite
   mode 1, same as SCREEN 1/2 — `s_sm1.c` is the only reference code for it.

**What works:**

- `VDP_WriteVRAM` / `VDP_FillVRAM` / `VDP_Peek` / `VDP_Poke` are mode-agnostic,
  and MC is explicitly in the MSX1 **29 cc** VRAM timing tier alongside G1/G2
  (`vdp.c`), so the hand-written `outi` loops are correctly tuned for it. Nothing
  written in C will beat them.
- `VDP_WriteLayout_GM2` / `VDP_FillLayout_GM2` are pure `g_ScreenLayoutLow + dy *
  32 + dx` arithmetic and MC's name table is the same 32×24, so **they work
  here** — but they are gated `#if (VDP_USE_MODE_G2 || VDP_USE_MODE_G3)`, which
  does not mention MC. A SCREEN 3 project that wants them must set
  `VDP_USE_MODE_G2 TRUE` as well.
- `scroll.c` is likewise name-table-only (`g_ScreenLayoutLow` +
  `VDP_WriteVRAM_16K`), and `SCROLL_ADJUST` — its one V9938 part — is `FALSE` on
  MSX1. So MSXgl's real scrolling camera drives a SCREEN 3 map unchanged.
- `COLOR_MERGE(a, b)` (`color.h`) packs two colours into the nibble pair a MC
  byte holds.

**What is missing, and so is ours to emit:**

- **The name table.** SCREEN 3's 64×48 framebuffer only exists once the 768-byte
  name table holds `NT[cx,cy] = (cy >> 2) * 32 + cx`. MSXgl has no function for
  it; `BIOS_InitScreen3()` (`R_INIMLT`) does it at the cost of a BIOS dependency
  and a full screen reset.
- **Pixel plotting.** `draw.h` is gated `#if ((MSX_VERSION >= MSX_2) &&
  (VDP_USE_COMMAND))` — `Draw_Point`, `Draw_Line`, `Draw_FillBox` are all V9938
  command wrappers and simply do not exist on MSX1.
- **Image conversion.** MSXimg's `-mode` takes `bmp|txt|gm1|gm2|sprt|mglv`
  (`exporter.h`, `MSXimg.txt`) — there is no multicolor exporter. `MGLV.h`
  reserves `MGLV_SCR_MODE_MC 3` but `parser.cpp` only ever emits
  `MGLV_SCR_MODE_BITMAP`, so it is a documented constant with no implementation.
- **Print.** `print.c`'s `case VDP_MODE_MULTICOLOR:` is an empty `break` — no
  tab size, no `ScreenWidth`. And the pattern table a font would load into *is*
  the picture. Text in a SCREEN 3 game means switching to another mode for it.
- **Software sprites and tiles.** `s_swsprt` and `tile.h` are bitmap-mode only
  (`tile.h`: "Tile support for bitmap mode", `TILE_BPP 4`,
  `TILE_SCREEN_WIDTH 256`). `game_pawn` does have `PAWN_SPT_MODE_MSX1`, which
  works here because sprite mode 1 is mode-independent.
- **No sample uses SCREEN 3 at all** — 0 of 56.
