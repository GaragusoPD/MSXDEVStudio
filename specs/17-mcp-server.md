# Spec 17 — MCP server: Claude in the IDE

**Phase:** 5 · **Depends on:** 04, 07, 08

## Goal

Let an agent (Claude Code, Claude Desktop, any MCP client) act in the
**running** IDE — the project the user has open, the window they are looking
at — rather than on a headless copy: what it builds streams into the Output
panel, what it opens appears as a tab, what it writes reloads in the editor.

## Transport and safety

- MCP over **Streamable HTTP, stateless** (`@modelcontextprotocol/sdk`): each
  POST to `/mcp` gets a fresh `McpServer` + transport with JSON responses. No
  sessions to keep. GET/DELETE answer 405.
- Bound to **127.0.0.1**. `requestAllowed` refuses a `Host` that is not this
  server's (DNS rebinding) and any request with an `Origin` (a browser).
- **Off by default.** `AppState.mcp = { enabled, port }` (default 47811),
  toggled in Preferences ▸ Claude (MCP). `McpService.init()` starts it after
  the window exists if enabled; `configure` restarts it on change and reports
  a taken port as `status.error`.
- The renderer only answers requests after the licence gate (`initMcpBridge`
  is called from `startWorkbench`).
- `.mcp.json` (written on request by `mcp:writeProjectConfig`) holds the URL
  only — merged into an existing file, safe to commit.

## Layers

- `main/services/mcp.ts` — `createMcpServer(deps, version)`: every tool,
  against `McpDeps`, with no Electron. Tested through a real MCP `Client` over
  `InMemoryTransport`.
- `main/services/mcp-service.ts` — `McpService`: the HTTP server, `McpDeps`
  filled from the app's services, a ring buffer of build output and the last
  `BuildFinished` (fed by `observeBuild` from `BuildService`'s `emit`), the
  renderer bridge, and the controllable openMSX. Tested over real HTTP with
  `StreamableHTTPClientTransport`.
- `main/services/emulator.ts` — openMSX under `-control stdio`: the XML control
  protocol (`parseControlOutput`, `commandXml`), machine choice matching MSXgl's
  `setup_emulator.js`, launch args, matrix key names, `OpenMsxSession`. Under
  control openMSX starts with **no renderer and the power off** (it waits for
  Catapult); `bootControlled` sets `renderer SDLGL-PP` (SDL fallback) and
  `power on`.
- `renderer/src/mcp-bridge.ts` — answers `mcp:request` over `mcp:respond`:
  `tabs`, `open`, `saveAll`, `notify`, `preview` (the Resources panel's
  `thumbnailUrl`), `createResource` (`resourcesStore.createResource`, shared
  with the panel's New). Unknown methods and failures answer with an error,
  never silence. `stores/mcpStore.ts` holds the status and the agent's
  messages; `AgentMessages.vue` shows them; the status bar shows "Claude"
  while enabled.

## Tools

| Group | Tools |
|---|---|
| Project & build | `project_info`, `list_resources`, `export_resources`, `build`, `get_build_output`, `get_problems`, `list_files`, `read_file`, `write_file` |
| Resources | `read_resource`, `write_resource`, `create_resource`, `preview_resource` |
| Run & inspect | `emulator_start`, `emulator_screenshot`, `emulator_peek`, `emulator_keys`, `emulator_type`, `emulator_tcl`, `emulator_status`, `emulator_stop` |
| The window | `list_tabs`, `open_file`, `save_all`, `show_message` |

- `build` calls `BuildService.start` — the toolbar's path — so the renderer
  updates from the same events. It returns `buildReport`: the verdict, the
  problems, the output's tail.
- `write_resource` parses through `parseResource` and saves
  `serializeResource`, so what lands on disk is what an editor would save. It
  returns `validateResource`'s problems (a world's need its rooms: export it).
- `write_file`/`write_resource` are refused when the renderer reports the
  file's tab dirty. Paths go through `projectPath` (relative, no `..`, no
  drive) and then `FsService`'s own root guard.
- Images (`preview_resource`, `emulator_screenshot`) are MCP image content.

## Verified

Live, under xvfb: the app with MCP enabled at startup; a real client called
`project_info`, `open_file`, `preview_resource`, `show_message`, `build` (the
MSX1 demo, success), `emulator_start`, then after 14 s `emulator_screenshot`
(the title screen), `emulator_peek` of the name table, `emulator_keys SPACE`,
and a second screenshot showing the game started.
