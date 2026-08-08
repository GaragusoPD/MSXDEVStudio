# Editing and navigating

The parts of the workbench that are not an asset editor: the code editor, the
side panels, Git, the terminal and the examples browser.

![The workbench: activity bar, explorer, an open source file, and the Output and
Problems panels below](images/editor_c_language.png)

The layout will look familiar if you have used VS Code. An **activity bar** down
the left switches the side panel; **tabs** across the top hold whatever you have
open; a **bottom panel** carries Output, Problems and terminals; and the
**status bar** shows the project path, the branch, the error and warning counts,
the machine and target, and the theme toggle.

`Ctrl+W` closes a tab, middle-click does the same, and `Ctrl+Tab` returns to the
tab you were in before this one. Which tabs were open is remembered per project.

## The code editor

C and assembler files open in Monaco — the editor from VS Code — so its
shortcuts apply: `Ctrl+F` find, `Ctrl+H` replace, `Ctrl+/` comment, `Alt+↑`/`↓`
to move a line.

The part worth knowing about is completion. Press `Ctrl+Space` and you get the
**whole MSXgl API**: over five thousand functions and constants with their real
signatures, descriptions and per-parameter documentation. None of it is a
hand-maintained list — MSXDEVStudio parses MSXgl's own headers, so the completions
describe the checkout you are actually building against, and they follow it when
you update. The index is built once per configured MSXgl path and cached.

## Explorer

The project's files. Clicking one opens it in the editor that handles its kind:
`.c` and `.h` in Monaco, `.tiles.json` in the tile editor, the `.msxproj` in
Project Settings, and so on. The tree follows changes on disk, so files created
by a build or by an external tool appear without a refresh.

## Search

Find in Files searches the whole project, with optional include and exclude
globs. It uses **ripgrep** when it is on your PATH and falls back to its own
scanner when it is not, so it works either way. Clicking a result opens the file
at that line.

## Resources

Every `*.tiles.json`, `*.btiles.json`, `*.sprites.json`, `*.map.json`,
`*.screen.json` and `*.sfx.json` in the project, grouped by kind, with the
header each one exports beside it. **Export all** writes every header;
**Force** ignores the "already up to date" check and rewrites them all.

Exports also run automatically before every build, so this panel is for when you
want a header *now*. See [Resources](resources.md).

## Git

![The workbench with the Git view available from the activity bar](images/editor_welcome_tab.png)

Enough Git for day-to-day work, on the repository containing your project:

- Stage, unstage and discard individual files
- Commit, with `Ctrl+Enter` from the message box, and amend the last commit
- Browse the log, and open any commit to see what it touched
- Create and switch branches
- Push and pull
- Open a diff for any changed file as a tab

If the project is not in a repository yet, the panel offers to initialise one.
It can also clone a repository to start from. Failures surface the real Git
error rather than a generic message — when Git refuses a push, you get Git's
reason.

## Examples

![The Examples browser: MSXgl's samples by topic, each tagged with the machine
it needs](images/editor_MSXgl_examples_easy_access.png)

MSXgl ships a large set of sample programs, and this panel is the fastest way
into them. They are grouped by topic — getting started, text and print, graphics
and VDP, sprites, scrolling, tiles and maps, ROM mappers and memory, sound and
music — and each is tagged with the machine it needs.

Open one and you get its source, read-only, with two buttons:

- **Try it** builds and runs the sample in place, with the output going through
  the same Output and Problems panels a project build uses.
- **New project from example** copies it into a project of your own, which is
  the honest way to start from a sample rather than editing MSXgl's copy.

At the bottom of the panel, **MSXgl documentation** opens the online reference,
and **Offline docs** opens the HTML documentation inside your MSXgl checkout —
useful with no network.

The [tutorials](tutorials/README.md) walk through these samples one at a time.

## Terminal

``Ctrl+` `` opens a shell in the bottom panel, already in the project root,
which is where `git`, `make` and MSXgl's own scripts expect to be run. **View ▸
New Terminal Tab** puts one in the editor area instead, if you want it large.

It runs your own shell: `$SHELL` on Linux and macOS, PowerShell on Windows.

A focused terminal takes every keystroke except ``Ctrl+` ``, because a shell
needs them — `Ctrl+W` is delete-word, `Ctrl+S` is flow control, `Ctrl+C`
interrupts. Press ``Ctrl+` `` to get back out.

## Output and Problems

**Output** is the build log as MSXgl printed it. **Problems** is that log parsed
into a clickable list of errors and warnings. Both are covered in [Building and
running](building-and-running.md).

## Themes

The status bar's rightmost item toggles between the dark and light themes. Every
colour in the interface comes from one set of variables, so the switch is
immediate and complete.
