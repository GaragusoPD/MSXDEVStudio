# Working with Claude (MCP)

MSXDEVStudio can let Claude work in the IDE with you, through MCP (the Model
Context Protocol). Claude Code, Claude Desktop, or any other MCP client on this
computer then acts on **the project you have open, in the window you are
looking at**. It doesn't use a copy of the project or a separate build. When
Claude builds, the Output panel streams it. When it opens a file, the tab
appears. When it changes a map, the open editor reloads.

## Turning it on

**File ▸ Preferences ▸ Claude (MCP)**, tick **Let Claude connect to
MSXDEVStudio**. The server starts at once on `http://127.0.0.1:47811/mcp`. Pick
another port there if that one is taken; the page says so if it is. A
**Claude** item appears in the status bar while it runs, and clicking it opens
the same page.

It is off until you turn it on, and it stays as you left it across restarts.

### Connecting Claude Code

Once, for every project, run the command the page shows (**Copy** puts it on
the clipboard):

```
claude mcp add --transport http msxdevstudio http://127.0.0.1:47811/mcp
```

Or only for the open project: **Add to this project's .mcp.json** writes the
server into the project's `.mcp.json`. Claude Code started in that folder then
offers to connect. The file holds only the URL, so it is safe to commit. Any
other servers already in it are kept.

### Connecting another client

Any client that speaks MCP over Streamable HTTP connects to the same URL.

## What Claude can do

**Project and build**

| Tool | What it does |
|---|---|
| `project_info` | The open project — machine, target, modules — the build state, the open tabs |
| `list_resources` | Every tileset, sprite bank, map, world, song… with the header it exports to |
| `export_resources` | Exports one resource, or all, to C — as a build would |
| `build` | Build, Rebuild, Clean or Run — exactly the toolbar's — and the result, the problems and the output's tail |
| `get_build_output`, `get_problems` | The last build's output and its errors and warnings |
| `list_files`, `read_file`, `write_file` | The project's files |

**Resources**

| Tool | What it does |
|---|---|
| `read_resource` | A resource as the editors read it — every field present — and what its export would refuse |
| `write_resource` | Writes one through the editors' own parser: filled in, cleaned up, then saved |
| `create_resource` | A new resource, as the Resources panel's New makes it, opened in a tab |
| `preview_resource` | A picture of it, as the Resources panel draws it |

**Run and inspect** — a second openMSX that Claude can look into. It boots the
last build on the project's machine, with its extensions.

| Tool | What it does |
|---|---|
| `emulator_start`, `emulator_stop`, `emulator_status` | Boot it, close it, ask how it is |
| `emulator_screenshot` | What the MSX shows |
| `emulator_peek` | Read VRAM (`vpeek`) or memory (`peek`) |
| `emulator_keys`, `emulator_type` | Hold keys (SPACE, the arrows, RETURN…) or type text |
| `emulator_tcl` | Any openMSX console command |

**The window**

| Tool | What it does |
|---|---|
| `list_tabs` | The open tabs, which one is active, which have unsaved changes |
| `open_file` | Opens a file in its editor and shows it to you |
| `save_all` | File ▸ Save All |
| `show_message` | A short message in the bottom-right corner: what Claude did, or what it needs from you |

## What it will not do

- **Overwrite unsaved work.** A write to a file that is open with unsaved
  changes is refused. Claude is told to ask you to save it, or to call
  `save_all`, so neither copy overwrites the other.
- **Leave the project.** Every path is relative to the project's root. A path
  that climbs out of it, or an absolute one, is refused.
- **Answer anything but this computer.** The server listens on 127.0.0.1 only.
  It also refuses any request from a web browser, so a web page cannot reach
  it either.
- **Run before you accept the licence.** Like the menus, it waits for the
  licence screen.

## Tips

- C-BIOS takes about ten seconds before a cartridge starts. Wait that long
  after `emulator_start` before taking a screenshot.
- The project's `CLAUDE.md`/`AGENTS.md` documents the C every resource exports.
  Claude reads it from the project folder.
