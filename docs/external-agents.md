# External agents

Other agents can control Beluga through one MCP server: a Claude Code or Codex in your own terminal, a local model, or a hosted agent such as GrokBot. An agent is you on another screen, like the phone or a browser: its chats run with your own logins. It has its own grant and its own name on what it does. You can see what it did, and you can stop it or revoke its grant at any time.

The server is off until you turn it on. Read [the risks](security.md#external-agents) before you connect an agent.

Everything here is in **Settings › External agents** on the Mac. The `beluga` command does the same. It is the engine's command line (`node dist/cli.js` in a build of this repository).

## Get the URL

```sh
beluga mcp on
beluga mcp url
```

This gives the local URL, `http://127.0.0.1:7778/mcp`. Only programs on this computer reach it.

For an agent on another computer, open an HTTPS route. Plain http off this computer is refused.

| Route | Command | Who reaches it | Address |
| --- | --- | --- | --- |
| Your tailnet | `beluga mcp on --tailscale` | Devices on your tailnet (Tailscale Serve on port 8443, never Funnel) | `https://<machine>.<tailnet>.ts.net:8443/mcp` |
| Public | `beluga mcp on --public` | Anyone with the address, and each agent still needs a pairing code | `https://<name>.trycloudflare.com/mcp` |

```sh
beluga mcp url --tailscale
beluga mcp url --public
beluga mcp status
```

**A public address changes when its tunnel restarts**: after you restart Beluga, after your Mac sleeps for a long time, or when Cloudflare drops the name. A token works only at the address it was issued for. Through a new address, the old token gets a 401 that says to sign in again, and you make a new pairing code for that sign-in. Tailscale's address does not change.

`beluga mcp off --public` or `--tailscale` closes one route. `beluga mcp off` closes the port and every route. Routes that you leave on open again when Beluga starts.

## Approve a sign-in

An agent that uses OAuth opens a sign-in page. The page names the agent and says where its access goes: this computer, another computer, or a hosted service by its host. It asks for a pairing code that you make:

```sh
beluga mcp pair --level trusted --project my-project
```

For an agent outside this computer, add `--remote`:

```sh
beluga mcp pair --remote --level trusted --project my-project
```

The code works once, for 10 minutes. It sets what the agent may do and what it reaches. With no flags, a code gives what you reach in the app: level `full`, all projects (also later ones), your chats with no project, direct messages and groups. With `--remote` and no level, the level is `trusted`. Each flag restricts it: `--level ask` or `trusted`, `--project <name>` (repeat; only these, and `--project chats` adds your chats with no project), `--no-dms` and `--no-groups`. The sign-in page cannot raise them. An agent that signs in through a route, or with a `--remote` code, is remote.

A remote agent gets `full` only by your explicit choice for that one code:

```sh
beluga mcp pair --remote --level full --allow-remote-full --project my-project
```

**This gives the hosted service your full power on this Mac, with no card. It can reach Beluga's own token, and anyone who runs that service gets it.** The sign-in page shows this warning and asks again. A `full` code made without `--remote` gets 403 through a route and makes no grant. You get a notice when such a grant is made, and the agent list marks it. Delete and merge still ask you once, and secret files and answering approvals stay refused.

The sign-in lasts 30 days. Then the agent signs in again with a new code.

## Claude Code

```sh
claude mcp add --transport http beluga http://127.0.0.1:7778/mcp
```

Then run `/mcp` in Claude Code, choose `beluga`, and enter your code on the page that opens.

## Codex

```sh
codex mcp add beluga --url http://127.0.0.1:7778/mcp
```

Codex prints a sign-in address. Open it and enter your code. If that wait ran out, start it again:

```sh
codex mcp login beluga
```

Codex has its own approvals for MCP tools. A `codex exec` with no one at its screen refuses these calls before they reach Beluga, unless you tell it to approve this server's tools. Beluga's own level still applies, and your card still shows:

```sh
codex -c approval_policy='"never"' -c 'mcp_servers.beluga.default_tools_approval_mode="approve"' exec -s read-only 'Call the beluga_capabilities tool of the beluga MCP server.' < /dev/null
```

## Claude (claude.ai)

Claude connects from Anthropic's servers, so it needs a public address, also when you use Claude Desktop.

1. Run `beluga mcp on --public`, then `beluga mcp url --public`.
2. In claude.ai, open **Customize › Connectors**, select **Add connector**, then **Add custom connector**.
3. Enter a name and the public URL, and select **Continue**.
4. Keep what Claude detected (**Sign in now** and **Use Claude's published identity**), and select **Add**.
5. Run `beluga mcp pair --remote --level ask --project my-project`, select **Connect**, and enter your code on the page that opens.

Claude has its own permission prompt for each tool (**Allow once**, **Always allow**). Beluga's level and your card still apply after it. When the public address changes, remove the connector and add it again with the new URL.

To remove it: open the connector in **Customize › Connectors**, select **More options**, then **Remove**. This does not end the grant, so also run `beluga mcp revoke <id>`.

## ChatGPT

ChatGPT needs a public address. Custom MCP servers depend on your plan and your workspace's settings ([OpenAI's guide](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)).

1. Run `beluga mcp on --public`, then `beluga mcp pair --remote --level ask --project my-project`.
2. In ChatGPT, open **Plugins**, select the plus button, then **Add custom MCP server**.
3. Enter the public URL, and choose OAuth for authentication.
4. Select **Scan Tools**, and enter your code on the page that opens.

ChatGPT's service holds the access. See the warning on the sign-in page. When the public address changes, you must connect it again with the new URL.

## Other agents

Give a client the URL. It must support MCP over Streamable HTTP and OAuth 2.1 with PKCE (S256) and a resource indicator. It finds the rest at `/.well-known/oauth-protected-resource/mcp`. Clients register by a client ID metadata document, or by dynamic registration. There are public clients only.

A hosted agent uses the public address, or the tailnet address when it runs on your tailnet.

## Scripts and clients with no OAuth

A program on this computer can have a named token. You approve it with a card on the Mac. The token shows once.

```sh
beluga mcp token --name my-script --level ask --project my-project
```

A client that only speaks stdio runs the bridge. It takes the token from its environment, never from the command line:

```sh
claude mcp add beluga -e BELUGA_MCP_TOKEN=<token> -- beluga mcp stdio
```

A script calls the URL with the token in its environment:

```sh
export BELUGA_MCP_TOKEN=<token>
curl -s http://127.0.0.1:7778/mcp \
  -H "Authorization: Bearer $BELUGA_MCP_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

This token works only at the local URL. Through a route it gets a 401.

## What a client lists

A client lists 14 tools: the 12 chat tools, `beluga_find` and `beluga_call`. Everything else stays reachable through those two. `beluga_find` searches the other tools by name, description and schema, and it returns each match with its input schema. It ranks them on this Mac with a small built-in BM25 (`src/external/domain/tool-search.ts`): no model, no service, and nothing leaves this Mac. It leaves out what the agent's level denies. `beluga_call` calls a tool by its name, after its arguments fit its schema. The named tool's own rules apply: its class, its card, its limits and its line in the audit log. The card and the log name that tool, never `beluga_call`. No tool answers an approval or changes a grant, so `beluga_call` cannot reach those either.

## See and stop

```sh
beluga mcp agents
```

**Settings › External agents** lists each agent with its level and when it was last seen, and **Activity** shows what it did and who decided. A chat that an agent drives shows a strip with its name and **Stop**, and each of its messages says who sent it. The phone can also list, stop and revoke agents.

- **Stop** ends what the agent has going. Its grant stays.
- **Pause all agents** refuses every agent and keeps their grants.

## Limits

| | Remote agent | Local agent |
| --- | --- | --- |
| Requests per minute | 120 | 1200 |
| Requests in flight | 8 | 32 |
| Runs at once | 3 | 16 |
| Request body | 256 KB | 4 MB |
| Text of one tool result | 64 KB | 1 MB |

Past a limit, a request gets 429 (`rate_limited`) and the audit log shows it, or a body gets 413. A flood with no token shows in the log too, as the agent `visitor`, with one record per kind per window so that a flood cannot grow the log. A longer result is cut and says so. 
**Wrong pairing codes can stop new remote sign-ins.** Through a route, 5 wrong codes from one visitor stop that visitor, and 20 in all, from anyone, stop every new remote sign-in, the right code included, for up to 10 minutes. This guard fails closed, so a stranger who knows the public address can cause it. You get one notice. Wait, or close the route with `beluga mcp off --public` (a new public address starts with a new name, and the lockout still counts until the 10 minutes end). Agents that are connected keep working and can refresh, and a sign-in on this computer is not affected.

Invalid tokens do not count toward this. At `/token`, 10 failures in 10 minutes stop that visitor, and 300 failures in a minute through a route stop every invalid token, with 429 (`slow_down`). The audit log shows it. A valid code or refresh token always goes through.

**A remote agent that is refused 10 times in 10 minutes is suspended.** Its work stops, you get a notice, and each call gets 403 (`grant_suspended`) until you choose **Resume** or **Revoke**:

```sh
beluga mcp resume <id>
```

## An agent is you, from another UI

A chat that an agent starts is your own run on this Mac. It uses your installed Claude Code or Codex and your login.

| Level | What its chats do |
| --- | --- |
| Full | The same as a chat you start: your tools, your variables, your MCP servers, your `.env` rule, your "My agent asks before commands" setting, and the Codex row of your own runs. |
| Trusted | Your tools, inside the chat's folders. A shell step, a step outside its folders and each Beluga tool show a card. It gets no secret, no variables and no MCP servers of yours. |
| Ask | The same as Trusted, and each step shows a card. It needs Claude, because Codex does not ask before each step. |

On Codex, a level below Full holds in the sandbox: your home is denied, your Codex tools are off, and it gets only the core environment. Codex does not stop at Beluga's gate before each step, so a level you change counts at the next run.

The agent stays a separate name. Its grant goes with each run, so you see the label "Sent by", the strip with Stop, the activity list and the first-use notice. A friend sees the label on each request, also on `ask_agent` and `run_on_peer`, as "kay (via GrokBot)", and the friend's own rules apply. **Stop** and **Revoke** end its runs and its queued messages, and your own runs and other agents' runs go on. Each step reads the level again, so a lower level counts at the next step. No friend limit applies: no turn limit, no time limit and no limit on cards.

The phone follows its own setting, as your own runs do: Off refuses, Ask shows a card, Use and Full run. Below level Full each action also shows a card.

What the app keeps for you also has a tool, with a card each time at every level and no Always: setting trust, invites, settings, turning a sentinel on, approving a plan, and the like. The card says in plain words what changes, for example "GrokBot wants to set kay to full trust". A no leaves everything as it was.

These stay refused at every level: answering an approval, reading or changing a grant, and secret values. An agent at Full has what you have on this Mac. Give Full only to an agent that you trust as you trust yourself.

## When a call waits for you

A call that needs your card waits at most 50 seconds. A client gives up sooner than a card ends (claude.ai after about 2 minutes, a card after 5), so Beluga then answers `waiting_for_owner`: nothing ran, and the client can tell its user. Your card stays open. When the client calls again with the same arguments, it gets your answer. One answer runs one call, and an answer that no call comes back for is dropped after 10 minutes. A tool never runs for a client that has left.

## Remove an agent

```sh
beluga mcp revoke <id>
```

It takes effect at once: its next call gets a 401, its runs stop, and what it has waiting on you is declined.

## Removing this feature

The feature comes out in one change, with the build and the existing tests still passing. This list was proven in a throwaway worktree (BLG-272, again at the head in BLG-290): with all of it removed and staged, typecheck has no errors at the root, in the Mac app and in the phone app (beyond the phone's known errors from `src/net` and `archive-git.ts`, which `upstream/main` has too), `npm run build` passes, and `tests/boundaries`, `tests/parity` and `tests/companion-coverage` pass. `tests/boundaries` keeps `src/external` in its list of core folders.

Delete these files:

- `src/external/`, and `tests/external-*.test.ts`
- `src/ipc/external-api.ts` and `src/ipc/external-handlers.ts`
- `src/cli/mcp.ts` and `src/cli/chat.ts`
- `packages/mac/src/dialogs/ExternalAgentsSettings.tsx` and `packages/mac/src/chat/DrivenStrip.tsx`
- `packages/mac/e2e/external-agents.spec.ts`, `external-card.spec.ts` and `external-via.spec.ts`
- `packages/companion/app/agents.tsx`

Remove these lines:

- `src/ipc/api.ts`: the `EXTERNAL_API` import and its spread. `src/ipc/handlers.ts`: the same for `EXTERNAL_HANDLERS`.
- `src/daemon/core.ts`: the `launchExternal` import, `stopExternal` and its two uses, and the comment above the launch.
- `src/cli/main.ts`: the `mcp` and `chat` cases. `src/cli/args.ts`: the `mcp` and `chat` commands.
- `src/companion/coverage.ts`: the `external.*` rows. `src/companion/calls.ts`: the `external.*` entries and their comment.
- `packages/mac/src/dialogs/Settings.tsx`: the import and the `external` pane. `packages/mac/src/dialogs/settings-index.ts`: the `external` pane entry (line 20) and the `// External agents` block of search rows: `rows('external', …)` with Let other agents connect, Pause all agents and MCP URL; the groups Connect an agent, Connected agents and Activity, each with its `rows('external', …)`. `packages/mac/src/lib/settings-search.ts`: `'external'` in `SettingsPane`. `packages/mac/src/views/ChatView.tsx`: `DrivenStrip` and its line.
- `packages/companion/app/settings.tsx`: the External agents row and `supportsAgents`. `packages/companion/lib/link/calls.ts`: the `external*` calls. `packages/companion/lib/link/demo/transport.ts`: the `external.*` cases.
- `docs/parity.md`: the `external.*` rows.
- `tests/mac-settings-search.test.ts`: the `external` line in `PANE_SOURCES`. `'Nothing yet'` in `NOT_SETTINGS` can stay.

What stays, harmless with no caller:

- `via` on chat, agent and gateway frames, and its labels on the Mac and the phone. With no agent, no frame carries it.
- In `src/core/agent-host.ts`: `runExternal`, `stopExternal`, the external gates, `asOwner`, `asksFirst`, and the card's `signal`. Nothing calls them.
- `src/core/acting-agent.ts`, `session.askForPlan` and the pilot's timer: with no agent's tool call they do nothing.
- `ext:` requesters in `src/core/trust.ts`, `mayCall` in `src/daemon/server.ts`, `Actor.external` on the board, `startedByAgent` on a chat, and `SINCE.externalAgents` in the phone protocol.
- The Codex row `agent`, the hardening in `src/agent/policy.ts`, the 0600 terminal config file, the `.GIT` refusal, and Codex's real path, which all runs use.
