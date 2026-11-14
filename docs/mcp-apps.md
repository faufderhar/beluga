# MCP Apps

Beluga is an MCP Apps host (SEP-1865, the open standard Claude, ChatGPT and VS Code apps use).
When your Claude calls a tool of one of your own MCP servers, and the tool declares
`_meta.ui.resourceUri` (or the older `_meta["ui/resourceUri"]`, or ChatGPT's
`_meta["openai/outputTemplate"]`), the Mac chat draws the server's `ui://` page under the tool's
step. The page talks to Beluga over the standard `ui/*` JSON-RPC bridge on `postMessage`. There is
no setting to turn on.

## When there are apps

- **Only runs that load your MCP servers.** Your own runs, and runs at Full trust, load them; a
  friend's run (a guest run) never does, so it records no app (`tracksMcpApps` in
  `src/agent/runtime/claude/runner.ts`).
- **Only a Claude Code that can host them.** Each turn's `system/init` lists the CLI's
  capabilities. Without both `mcp_tool_ui_meta_v1` (each tool's `_meta.ui`) and
  `mcp_read_resource_v1` (reading `ui://` resources), the run's tracker records no app and never
  asks for the tool list (`src/mcp-apps/domain/capabilities.ts`). A step with no app is a step as
  before: `apps.*` answer `missing` and touch nothing, and the window draws no frame.
- **Codex, OpenCode and Copilot runs** have none: Claude Code is the MCP client.

## How a view gets to the chat

Claude Code is the one MCP client: Beluga opens no second connection and uses the same settings
and sign-ins as your runs.

1. A run's tool call whose tool has a `ui://` resource keeps it on its step (`StepApp`: the
   server, the tool, the resource and the result's `structuredContent`, bounded). Claude Code's
   `mcpServerStatus()` gives each tool's `_meta.ui`.
2. `apps.get` reads the resource once through `readMcpResource` (in an idle Claude Code session
   of its own, kept for the app's calls: the run may be over) and serves it on the app host: a loopback server of its own
   (`127.0.0.1:47792`, or any free port), one page per id nobody can guess.
3. The Mac draws it in an iframe with `sandbox="allow-scripts allow-same-origin allow-forms"` on
   that origin (never the window's), with no referrer, and hands it the tool's input and result.

## The sandbox and the CSP

Each page is served with a Content-Security-Policy made from its resource's `_meta.ui.csp`
(`src/mcp-apps/domain/csp.ts`):

- Its own inline HTML, scripts and styles run. Scripts, styles, images, fonts and media load
  only from the `resourceDomains` it declared.
- `connect-src` is its `connectDomains`, `frame-src` its `frameDomains`, and `base-uri` its
  `baseUriDomains` (else `'self'`). Nothing declared: no network at all.
- `form-action 'none'`, and `frame-ancestors` is the Beluga window only.
- Each domain must be a plain `https://` or `wss://` origin (an optional `*.` subdomain and port);
  anything else is dropped. Browser permissions a resource asks for (camera, microphone…) are not
  granted.

The app host answers only `GET` on a loopback address under a loopback host name (no DNS
rebinding). Every message from the frame is checked against the frame's own window; others are
ignored.

## The bridge

`packages/mac/src/chat/mcp-app/bridge.ts`. Requests Beluga doesn't offer get `-32601`; a request
Beluga refused or couldn't run gets `-32000` with the reason, so the app can say it.

| Method | Supported | What Beluga does |
| --- | --- | --- |
| `ui/initialize` | ✓ | Protocol `2026-01-26`, `hostCapabilities` (`serverTools`, `serverResources`, `message`, `updateModelContext`, `openLinks`) and `hostContext` (theme, `displayMode`, `availableDisplayModes`, size, locale, `platform: desktop`) |
| `ui/notifications/initialized` | ✓ | Sends `ui/notifications/tool-input`, then `ui/notifications/tool-result` (when the tool came back) |
| `ui/notifications/size-changed` | ✓ | Follows the height, up to 720 px in the chat |
| `ping` | ✓ | Answers `{}` |
| `tools/call` | ✓ | `apps.call`, through the tool gate (below) |
| `resources/read` | ✓ | `apps.read`: `ui://` resources of the app's own server only |
| `ui/message` | ✓ | `apps.message`: asks you first, with the words (Allow / Allow Always / Decline; Always per tool of a server). Refused while your Claude works in that chat, or while the app's last message waits for you. Allowed, the text goes into the app's chat as yours, marked "Sent by the <tool> app", and starts a turn of your Claude |
| `ui/update-model-context` | ✓ | `apps.context`: kept per app instance (an update replaces the last one), added to your Claude's next turn in that chat, then dropped |
| `ui/open-link` | ✓ | `http://` and `https://` only, in your browser (the Tauri opener), one link per 2 s; any other scheme is refused |
| `ui/request-display-mode` | ✓ | `inline` and `fullscreen` (the same frame over the window: the app keeps its state). Answers the mode set and sends `ui/notifications/host-context-changed`. Exit Full Screen (or Esc, while the focus is outside the app) goes back and tells the app, and so does an approval that waits in that chat (it would be under the app). Other modes are refused |
| `ui/resource-teardown` | ✓ (host → app) | Sent when the frame goes away |
| `ui/notifications/host-context-changed` | ✓ (host → app) | Display mode changes only |
| `pip` display mode | ✗ | Refused |
| `notifications/message` (logging) | ✗ | Ignored |
| `ui/notifications/tool-input-partial`, `ui/notifications/tool-cancelled` | ✗ | Not sent |
| Theme and size changes after start | ✗ | Not sent as `host-context-changed` yet |
| `tools/list`, `resources/list`, prompts, sampling | ✗ | Method not found |
| Browser permissions (`_meta.ui.permissions`) | ✗ | Not granted |
| Apps in Codex, OpenCode or Copilot runs | ✗ | Claude Code only (it is the MCP client) |

## The tool gate

An app calls tools as you, so `apps.call` checks each call (`src/mcp-apps/domain/tool-gate.ts`):

- **Its own server only.** The server is the one of the app's step, never one the app names.
- **Tools meant for apps.** The tool's `_meta.ui.visibility` must include `app`. A tool that
  declares no `ui` is for both (the standard's default); a `ui` that failed Claude Code's checks
  is for neither.
- **Reading runs, changing asks.** A tool whose `readOnly` hint is set runs at once. Any other
  asks you first, in the chat, with **Allow / Allow Always / Decline**. Always holds for that tool
  of that server until Beluga quits. A hint comes from the server: it is trusted as much as the
  server you installed.
- Arguments over 256 KB are refused. The call goes through Claude Code's `mcp_call` with
  `result_not_for_model`: the server's own content comes back for the app, and no model reads it.
  The calls of one server share one Claude Code session: the first call opens it (a few seconds),
  the next ones reuse it. It closes 60 s after its last use, when a call fails, and when Beluga
  stops.

## What an app tells your Claude

An app is third-party code, and nothing tells Beluga that you clicked in it. So a message it
posts as you asks you first, shows "Sent by the <tool> app" and can't be edited as yours; one
app can't queue turn after turn. Its model context is added to
the next turn inside `<mcp_app_context>` blocks, with a note that it is data, not instructions;
the app's text can't close the block. Only your own runs get it, never a friend's.

## On the phone

The phone draws no app. A step with one reads "<Tool> app, on your Mac"; a message an app posted
reads "Sent by the <tool> app". `apps.*` are Mac methods (`src/companion/coverage.ts`).

## Not yet

- A driven computer (Beluga › Computers): its app host's port isn't forwarded, so the frame
  doesn't load there.
- Apps in a friend's shared worktree, or in a friend's Claude's answer: only your own Claude's.
- Always for app tools and messages is not kept across restarts, and not listed in Settings.
- People you invited into a chat see an app's message as yours, without the app's mark (the
  protocol has no field for it yet).
