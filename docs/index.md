# MSXDEVStudio documentation

> **MSXDEVStudio is an independent project**, not affiliated with, endorsed by
> or official to MSX Licensing Corporation, the MSX Association, or any other
> holder of MSX rights. **"MSX" is a trademark of MSX Licensing Corporation**,
> used here descriptively to identify the hardware this software targets.

Everything here ships inside the application — **Help ▸ Documentation** opens
this page, and it all works offline.

New to MSX development? Read [Getting started](getting-started.md), then work
through the [tutorials](tutorials/README.md) in order.

## Using the application

| Guide | What it covers |
|---|---|
| [Getting started](getting-started.md) | First launch, the toolchain download, choosing an emulator, and your first project |
| [The demo games](demos.md) | Installing the two bundled games, and a step-by-step first session on each |
| [Project settings](project-settings.md) | Machine, target and ROM size, mappers, library modules, the ISR options, and the escape hatch to a hand-written config |
| [Building and running](building-and-running.md) | Build, Rebuild and Clean, the Problems panel, incremental builds, and running in openMSX or WebMSX |
| [Editing and navigating](editing.md) | The workbench, tabs, search, Git, the terminal, and the examples browser |
| [Keyboard shortcuts](shortcuts.md) | Every binding, in one table |
| [Troubleshooting](troubleshooting.md) | Silent emulator audio, blurry pixels, download warnings, build failures |

## Making the art and the sound

| Guide | What it covers |
|---|---|
| [Resources](resources.md) | All six asset editors, blocks, metasprites and fragments, exporting, and the ready-made C |
| [The project file](project-file.md) | What `.msxproj` holds, what `project_config.js` is generated from it, and the config chain MSXgl reads |

## Learning MSXgl

The [tutorials](tutorials/README.md) walk through the MSXgl graphics samples,
each ending in a complete program you can paste into `main.c` and Run.

1. [Hello world](tutorials/01-hello-world.md)
2. [Printing text](tutorials/02-printing-text.md)
3. [Tiles and maps](tutorials/03-tiles-and-maps.md)
4. [Sprites on MSX1](tutorials/04-sprites-mode1.md)
5. [Sprites on MSX2](tutorials/05-sprites-mode2.md)
6. [Scrolling](tutorials/06-scrolling.md)
7. [Bitmap graphics](tutorials/07-bitmap-graphics.md)
8. [Software sprites and tiles](tutorials/08-software-sprites.md)
9. [Meta-tiles](tutorials/09-meta-tiles.md)

For the library's own API reference, use **Help ▸ MSXgl Reference**, or the
**Offline docs** link at the bottom of the Examples panel when you have an
MSXgl checkout.

## The demo games

Two complete games ship *inside* MSXDEVStudio, both built entirely with the editors
described here. **[The demo games](demos.md)** is the guided tour: how to
install them, and a step-by-step first session on each.

- **[Demo 1 — a two-screen MSX1 platformer](../demo_msx1/README.md)**: a
  SCREEN 2 tileset, a six-pose sprite, a 64×12 map and an ayFX bank, in a
  32 KB ROM.
- **[Demo 2 — Canyon Runner, an MSX2 shooter](../demo_msx2/README.md)**:
  SCREEN 5 in a 128 KB MegaROM, hardware scrolling, sprite mode 2, and software
  sprites for the boss.

**Help ▸ Install Demo Projects…** copies both into a folder you choose — they
have to live somewhere you can write to, because building a project writes into
its own folder.
