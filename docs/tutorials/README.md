# MSXgl graphics tutorials

Walkthroughs of the MSXgl graphics samples, written for MSXStudio users. Each
one explains a sample from the MSXgl checkout, gives you a complete program you
can paste into `main.c` and Run, and points at the MSXStudio editor that makes
the art for it.

Read them in order if you are new to MSX development. Every API name in these
files was checked against the MSXgl engine source rather than written from
memory.

| # | Tutorial | Covers | Machine |
|---|---|---|---|
| 1 | [Hello world](01-hello-world.md) | Program entry point, screen modes, printing, the main loop | MSX1 and up |
| 2 | [Printing text](02-printing-text.md) | The Print module: fonts, positioning, numbers, colors | MSX1 and up |
| 3 | [Tiles and maps](03-tiles-and-maps.md) | Pattern modes, the three VDP tables, loading a tileset, drawing a map | MSX1 and up |
| 4 | [Sprites on MSX1](04-sprites-mode1.md) | Sprite mode 1, patterns, placement, the 4-per-line limit | MSX1 and up |
| 5 | [Sprites on MSX2](05-sprites-mode2.md) | Sprite mode 2, per-line colors, layering for multicolor characters | MSX2 and up |
| 6 | [Scrolling](06-scrolling.md) | The scroll module, its compile-time configuration, maps bigger than one screen | MSX1 and up |
| 7 | [Bitmap graphics](07-bitmap-graphics.md) | SCREEN 5 to 8, palettes, showing an image, the VDP command engine | MSX2 and up |
| 8 | [Software sprites and tiles](08-software-sprites.md) | Drawing objects without the sprite hardware, and its CPU cost | MSX2 and up |

## Before you start

The samples live in your MSXgl checkout under `projects/samples/`. MSXStudio's
**Examples** browser can open and build them directly, which is the quickest way
to see one running before you read about it.

Settings these tutorials refer to (**LibModules**, **Machine**, **Target**,
**CustomISR**) are all in **Project Settings** inside MSXStudio.

For making your own tiles, sprites, maps, screens and sound effects, see
[the resources guide](../resources.md).
