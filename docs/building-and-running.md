# Building and running

MSXStudio never reimplements MSXgl's build. It runs MSXgl's own `build.js` with
your project folder as the working directory, and puts a user interface around
what comes back.

## The four commands

They are on the **Build** menu, and Build and Run also have toolbar buttons.

| Command | Shortcut | What it does |
|---|---|---|
| **Build** | `Ctrl+Shift+B` | Compiles what changed, links, and deploys the artifact |
| **Rebuild** | | Deletes `out/` first, then builds everything |
| **Clean** | | Deletes the build output and stops |
| **Run** | `F5` | Builds, then launches the emulator |
| **Stop** | | Kills the running build's whole process tree |

Each maps onto MSXgl's own step keywords — `all`, `rebuild`, `clean`, and `run`
appended for openMSX. Run only adds the `run` step when openMSX is the
preferred emulator; WebMSX is launched by MSXStudio instead (see below).

Before every build, two things happen automatically:

1. **`project_config.js` is regenerated** from your `.msxproj`, unless the
   project is set to a custom config. See [The project file](project-file.md).
2. **Resources are exported.** Every tile bank, sprite sheet, map, screen and
   sound bank writes its C header if the source is newer than the output, so an
   edit in a resource editor reaches the compiler without you exporting by hand.

## Reading the output

The bottom panel has two tabs.

**Output** is the raw build log, exactly as MSXgl printed it.

**Problems** is that log parsed into a clickable list. MSXStudio understands
SDCC's diagnostics, this SDCC's `sdasz80`, and the `?ASxxxx-Error-…` /
`?ASlink-Warning-…` forms the linker uses. A problem that names a file inside
your project is clickable and jumps to the line; one that names a file
elsewhere (inside the engine, say) is still listed, just not clickable.

The status bar shows the current error and warning counts at all times.

## Incremental builds, and when they are not enough

Generated configs set MSXgl's `CompileSkipOld`, which skips a source file whose
`.rel` in `out/` is newer than it. That makes ordinary builds fast, but the
check only ever compares a `.c` against its own `.rel` — it cannot see:

- a header you edited, which several `.c` files include,
- a change to the build flags, the machine, the target, or a `define=`,
- anything else that changes *how* the same source compiles.

So MSXStudio guards it. After each successful build it writes a stamp file into
`out/` recording the configuration those `.rel` files were compiled with, and
before the next one it compares the stamp and sweeps the modification times of
every `.h`/`.inc` in the project. If either says the objects are stale, it
quietly swaps MSXgl's `all` step for `rebuild` and does the whole thing
properly.

You should not have to think about this. If you ever suspect you are looking at
a stale binary, **Rebuild** is the hammer.

> Building from the command line instead? There is no stamp there — use
> `rebuild` after touching a header.

## Running it

**openMSX** launches through MSXgl's own `run` step, using the emulator path
MSXStudio wrote into MSXgl's user-global config. Per-project emulator options —
the machine override, cartridge extensions like SCC or MSX-MUSIC, joystick
ports, 60 Hz, full screen, mute — live in [Project
settings](project-settings.md).

**WebMSX** runs the game in your browser instead. MSXStudio starts a small
server bound to `127.0.0.1` on a random port, lends it *only* the files this
build produced, and opens webmsx.org pointed at the right one. Nothing else on
your machine is reachable through it, and no path is ever taken from the
request. Chrome 141 and newer ask permission for local network access the first
time; without it the page cannot fetch the ROM.

Which one Run uses is the **preferred emulator** setting, per project.

## When a build fails

MSXStudio explains MSXgl's own exit codes rather than showing a bare number.
The ones you are most likely to meet:

| Meaning | What to do |
|---|---|
| Toolchain not found or not usable | Check Toolchain Settings — MSXgl's path, and that its bundled SDCC is executable |
| Unknown `LibModules` entry | An engine module name is wrong; fix it in Project Settings |
| Compilation or assembly failed | Look at the Problems panel — this is your code |
| No C-BIOS turbo R machine in openMSX | Set an openMSX machine override in Project Settings |

MSXgl's exit codes are three digits, and POSIX truncates exit statuses to eight
bits — so the same failure arrives as, say, `310` on Windows and `54` on Linux.
MSXStudio matches both, which is why the message is the same on either.

If a code has no explanation attached, the message carries the last few lines
of standard error, which is usually enough to see what happened.

## What a build produces

Everything generated goes in `out/`, and the finished artifact is deployed
according to the target: a `.rom` for the ROM targets, `.com` for MSX-DOS,
`.bin` for the BASIC ones, `.lib` for a library. Clean and Rebuild both wipe
`out/`, so nothing there is worth keeping.
