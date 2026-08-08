# Troubleshooting

The problems people actually hit, and what they mean.

## Installing

**Windows warns about the download, or SmartScreen blocks it.** Expected: the
binaries are not code-signed yet, because a certificate costs money this project
does not have. Choose "More info" then "Run anyway" if you trust the source you
got it from.

**The AppImage will not start.** Make it executable first:
`chmod +x MSXDEVStudio-*.AppImage`.

## The toolchain

**"Toolchain not found" when building.** Open **Toolchain Settings** and check
the MSXgl path. MSXDEVStudio resolves each tool in the same order — an explicit
setting, then your `PATH`, then the platform default — and validates by running
the binaries, so a path that merely *looks* right can still fail here.

**The MSXgl download worked but builds fail on Linux.** MSXgl bundles its own
SDCC and tools, and a ZIP archive cannot record the executable bit. MSXDEVStudio
sets it after extracting; if you unpacked MSXgl yourself, you may need to do it
by hand. Re-running the download from Toolchain Settings is the easy fix.

**"Unknown LibModules entry".** An engine module name in
[Project settings](project-settings.md) is not one MSXgl has. Check the spelling
against the module list.

## Building

**A change to a header did not take effect.** It should — MSXDEVStudio watches
header modification times and forces a full rebuild when they move. If you
suspect a stale object anyway, use **Rebuild**, which cleans `out/` first. Note
that building from the command line has no such guard: use MSXgl's `rebuild`
step after touching a header.

**The build failed with a number and no explanation.** MSXgl's documented exit
codes get a message; anything else shows the last few lines of standard error
instead. The Output panel has the full log.

**The same failure shows a different number on Windows and Linux.** POSIX
truncates exit statuses to eight bits, so MSXgl's three-digit codes come back
`mod 256`. MSXDEVStudio matches both forms, which is why the *message* is the same.

**Errors point at files inside MSXgl.** They are listed but not clickable, since
they are outside your project. Usually it means a library module is missing from
Project Settings, or a `Custom ISR` setting is asking for a handler you have not
written.

## Running

### No sound from openMSX on Linux

The distributed openMSX builds can only use ALSA, and on a PipeWire desktop ALSA
has no working default device unless the bridge package is installed:

```
sudo apt install pipewire-alsa
```

Then log out and back in. This affects every ALSA application, not just openMSX,
and the emulator gives no sign: it runs perfectly and stays silent.

If you are not sure whether it is your game or your system, run
`speaker-test -t sine -l 1`. If that is silent too, it is the system.

### Blurry or uneven pixels

openMSX ships with a softened, TV-like picture. For a pixel-perfect image, open
its console with **F10** and set:

```
set scale_algorithm simple
set horizontal_stretch 256
set blur 0
set scanline 0
```

Settings save when openMSX exits. `horizontal_stretch` is the subtle one: the
default stretches 256 MSX pixels across 280, so some columns come out wider than
others whatever scaler you pick.

### openMSX from the Linux tarball cannot find its data

The relocatable `.tar.gz` build cannot locate its own `share/` directory.
MSXDEVStudio detects that layout and sets `OPENMSX_SYSTEM_DATA` when it launches
the emulator, so it works with no setup. If you launch openMSX yourself from a
terminal, you will need to set it too.

### "No C-BIOS turbo R machine"

openMSX ships no C-BIOS machine for the turbo R. Set an **openMSX machine
override** in Project Settings to a real turbo R machine you have the ROMs for.

### WebMSX loads but never boots the game

Chrome 141 and newer require permission for a page to reach your local network,
and WebMSX fetches your ROM from a loopback server on your own machine. Allow
local network access when the browser asks. Without it the page loads and sits
there with nothing in the cartridge slot.

## Resources

**An edit in an editor did not reach the game.** Exports run before every build,
skipping anything already up to date. If you think that check is wrong, use
**Force** in the Resources panel, which rewrites every header.

**A map broke after I reordered tiles.** It should not: deleting or dragging a
tile renumbers every map drawn with that tileset, along with the tile flags and
any block using it. Maps that are open update immediately, closed ones when you
next open them — so if a map was open in *another* application, that copy is the
stale one.

**Compression made the data bigger, so it was not applied.** By design: both the
map and screen exporters decline compression when it would not shrink the data,
and the generated header says which happened. See [Resources](resources.md).

**The game crashes after adding compressed data.** RLEp unpacking needs MSXgl's
`compress` module in your library modules, and `COMPRESS_USE_RLEP` /
`COMPRESS_USE_RLEP_DEFAULT` left at `TRUE` in `msxgl_config.h`.

## Still stuck

The [MSXgl Discord](https://discord.gg/pMeadGfv8E) is where the library's own
questions get answered, and the MSX community there has seen most hardware
oddities before. For MSXDEVStudio itself, open an issue with what you did, what you
expected and what the Output panel said.
