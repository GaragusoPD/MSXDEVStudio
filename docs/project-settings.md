# Project settings

Open the project's `.msxproj` from the explorer, or **File ▸ Project Settings**.
This is the form that decides what your binary *is*: which machine it runs on,
what shape of ROM it becomes, and which parts of the engine get linked in.

![Project Settings: name and source modules, the target block, and the
ROM/startup options](images/editor_project_settings.png)

Everything here is stored in the `.msxproj` and translated into MSXgl's
`project_config.js` before each build — see [The project
file](project-file.md).

## Project

**Name** is `ProjName`: it names the artifact, so `canyon` builds `canyon.rom`.

**Source modules** is the list of `.c` files MSXgl compiles, comma-separated and
**without the `.c`**. A new project has just `main`. Add a file to your project
and it will not be compiled until it is named here.

You do not need to list the `.c` files the resource editors generate — those are
appended automatically at build time, because a resource that emits code has to
be compiled for the header to be worth including.

## Target

**Machine** is which MSX generation the binary is for: MSX1, MSX2, MSX2+, turbo R,
Korean MSX2, MSX0, or one of the combinations (`MSX1 + MSX2` and friends) that
build one binary detecting the machine at boot.

**Target** is the container. The picker shows a short curated list — 32 KB and
48 KB ROMs, the three common MegaROM mappers, MSX-DOS 1 and 2, and a BASIC disk
binary — and **Show all targets** reveals the rest: the smaller and page-2 ROMs,
the ISR-replacing 48/64 KB layouts, NEO-8/NEO-16, Yamanooto, ASCII16-X, Popolon,
tape and USR binaries, raw drivers and `.lib` libraries.

**ROM size (KB)** only appears for mapped-ROM targets — the MegaROM mappers —
because it is the only place the value means anything. On the others MSXgl
derives the size from the target itself.

> Machine and Target are always written into the generated config, even when
> they match MSXgl's defaults. Everything else is omitted at its default value
> to keep the file small — but these two decide what the binary *is*, and
> MSXgl's user-global config re-asserts every setting, so an omitted one could
> be silently overridden there.

## ROM / startup

| Setting | Effect |
|---|---|
| **Check MSX version at startup** | Refuses to run on a machine older than the target. On by default |
| **Delay ROM boot** | Lets disk and network ROMs initialise before yours takes over |
| **Add ROM signature** | Writes the identifying signature bytes into the image |
| **Automatic banked calls** | For mapped ROMs: calls across bank boundaries are trampolined for you |
| **ISR in RAM** | Copies the interrupt handler into RAM: none, page 0, segment 0, or page 3 |
| **Custom ISR** | Which interrupts your own handler takes: none, all, VBLANK, VBLANK+HBLANK, or V9990 |

**Custom ISR** is the one that catches people out. Setting it to `VBLANK` means
MSXgl calls a handler *of your own* by name each frame — the routine has to
exist or the link fails. It defaults to `VBLANK` in new projects. Anything that
must happen during the blanking period, such as writing the vertical scroll
register, belongs in that handler; `demo_msx2` is a worked example.

## Build

**Optimisation** is `Default`, `Speed` or `Size`. New projects use `Speed`.

**Compile complexity** — `Fast`, `Default`, `Optimized`, `Ultra`, `Insane` — is
how hard SDCC works. The higher settings cost build time for smaller, faster
code; leave it alone until a build is genuinely too big.

**Debug** keeps symbols and debug output. **Allow undocumented instructions**
permits the undocumented Z80 opcodes.

**Defines** are passed to the compiler as build arguments rather than written
into the config file, so they behave like `-D` on a command line. Changing one
is exactly the kind of change the incremental build cannot see on its own —
MSXStudio's stamp catches it and forces a full rebuild.

## Library modules

The list of MSXgl engine modules to link. A new project gets `system`, `bios`,
`vdp`, `print`, `input` and `memory`.

This is a real budget: each module is code in your ROM. Add what you need —
`scroll` for the scrolling module, `compress` to unpack RLEp-compressed maps and
screens, `game` for the game loop helpers — and leave out what you do not. A
name that MSXgl does not recognise fails the build with an "unknown LibModules
entry" error rather than being ignored.

The tutorials say which module each one needs.

## Files

**Raw files** are binary blobs placed into the ROM image: each entry names a
file plus exactly one of an offset, a page or a segment, and MSXgl's MSXhex
puts it there. This is how `demo_msx2` gets its full-screen pictures into
MegaROM segments.

**Disk files** and **disk size** (360 KB or 720 KB) apply to the disk targets.

## Emulator

Per project, so a MegaROM game can boot with an SCC and an MSX1 game need not.

**Preferred emulator** picks what `F5` launches: openMSX or WebMSX.

**Machine override** replaces MSXgl's default C-BIOS machine with a specific
openMSX one. Needed if you target turbo R, because openMSX ships no C-BIOS
turbo R machine and the build stops with a message telling you so.

**Extensions** add hardware to the emulated machine: SCC, MSX-MUSIC, MSX-AUDIO,
OPL4, a second PSG, V9990, extra RAM, PAC. **Ports A and B** attach a joystick,
mouse, paddle, JoyMega or NinjaTap. **60 Hz**, **full screen** and **mute** do
what they say.

## Image rules

Declarative MSXimg conversions, run before every build from the project root:
each rule is a source image, an output path, and the MSXimg command-line
arguments. MSXStudio edits the arguments as plain text and links to MSXimg's own
documentation rather than pretending to be an argument builder — MSXimg has more
options than a form could usefully hold.

This is the escape hatch for conversions the resource editors do not cover. For
ordinary tiles, sprites and pictures, use the editors — see
[Resources](resources.md).

## Custom config

The last resort. Tick it and MSXStudio stops generating `project_config.js`
entirely: the file becomes yours, and everything above stops having any effect
on the build. Use it when you need something MSXgl supports and this form does
not expose. [The project file](project-file.md) explains what the generated file
looks like, which is the sane place to start from.
