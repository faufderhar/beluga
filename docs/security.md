# Security


Inviting someone exposes your agent, with your permissions, to other people. Beluga is built around that:

- **Solo by default.** Nothing is reachable until you click Invite.
- **The invite is the key.** Anyone with the link can join, so share it privately. The host can **remove** someone, **replace the link** (the old one stops working; people already in stay), or **close the room** to newcomers.
- **Nobody can speak for someone else.** Everyone has their own signing key (kept in `~/.beluga/identity.json`), their id comes from it, and **every message is signed**. Not even the host relaying the room can forge a message from you, so a trust level you gave someone can't be borrowed. Requests that act on your computer must be fresh: an old one replayed later is dropped. If `identity.json` is there but can't be read, Beluga leaves it as it is (a new key would make you someone else to your friends) and runs on a temporary identity, saying so in its log: restore the file from a backup, or move it aside to get a new identity.
- **You decide how much each person may do**: can't use your agent, ask each time, trusted, or full trust (see *Working with people*). Unanswered approvals are declined after 5 minutes.
- **Reaching outside your shared folders asks you.** Friends' requests use your shared folders; reading anything else, shell commands, web requests and edits outside a `:rw` folder ask you first, even ones Claude Code would normally auto-approve. Only **full trust** skips these. Folders are checked where they really are: a link inside a shared folder can't reach a file outside it, and a harmlessly named link to a key is still refused as the key.
- **Editing files never quietly becomes running commands.** A friend's change to a file that makes code run later (git hooks and `.git/config`, `.claude/` and `.mcp.json`, `.vscode/`, `.husky/`, `.envrc`, `package.json`, `Makefile`, CI workflows, shell start-up files, login items, `.command` files) asks you every time, even in a `:rw` folder, with only **Allow once** and **Decline**. Only **full trust** skips it.
- **Commands from friends are yours to approve.** A friend (or their agent) asking to run a command on your computer always shows you the exact command first, unless you fully trust them. It runs with no input, a time limit and capped output, and you get a notice afterwards.
- **A friend's request can't run on and on.** It stops after 20 minutes or 50 turns, after asking you to approve 8 steps, or when you decline 2 in a row, and the friend is told why. It takes at most 4 screenshots, commands like `screencapture` included.
- **Secrets stay put unless you send one yourself.** `.env` files, keys, `.ssh`, `.aws` and similar are never shared or readable by friends' requests, and commands or asks to their agent that touch them are refused, whatever the trust level. A friend can only ask for one secret file at a time (`get_file`): you then get a separate approval that says what it is ("kay's agent wants your private SSH key id_ed25519"), every time, with only **Allow once** and **Decline**. Trust, rules and Always never cover it. If you allow it, Beluga sends that one file (no agent reads it), and their agent is told you approved it. Beluga's own private files in `~/.beluga` (your identity, settings, rules) and the keychains are never sent, whoever approves.
- **A folder search skips the secrets in it.** A search over a folder (Grep, Glob, LS) doesn't open the `.env` files, keys and credential files it finds there, a harmlessly named link to one included. Claude's search runs with them left out; one that can't leave them out (it has a filter of its own that picks one, a name Beluga can't put in the filter, a listing) is refused. A folder too big to look through to the end (over 20,000 entries, `node_modules` and `.git` not counted), searched with a filter of its own that could still pick a key, asks you first, whatever the trust. Your own agent's `.env` asks you, as below.
- **A friend's Claude doesn't get your environment.** A friend's or guest's Claude run starts with only the basics (`PATH`, `HOME`, language, temp folder), Claude Code's own settings that aren't secrets (where its config is, its endpoint, Bedrock or Vertex and their region) and a proxy with no password in it. Your keys, tokens and cloud credentials stay out. So if Claude Code signs in on this Mac only through variables (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, a gateway's `ANTHROPIC_AUTH_TOKEN`, Bedrock's or Vertex's credentials), friends' tasks can't sign in, and their card names the variable. Sign Claude Code in on this Mac (`claude`, then `/login`) for friends' tasks to run. Your own runs keep your environment.
- **Your own `.env` files are yours.** You see and edit them in Files (friends never see even their names). Your own agent asks before it reads or changes one, even when it asks you nothing else: allow once, always for that project, or always. Take it back in Settings › Environment › Your agent. Keys, `.ssh`, `.aws` and Beluga's own files stay refused. Templates (`.env.example`, `.env.sample`…) hold no secrets and are ordinary files.
- **An image you put in an answer reaches your own agent.** Images you paste stay in `~/.beluga/attachments`, one of Beluga's own folders: never sent, and refused to friends' requests and their agents. An answer to your agent's question links the image by its path, so your own run (not a friend's, a guest's or an external agent's) may Read that one image right in that folder, judged where it really is (links followed). Nothing in `received/` or `room/`, no search or listing there, and no writing. Codex (it asks you only about its plan) gets the images in what you want changed the way it gets a message's: handed over with it, never through its sandbox.
- **Commands that name Beluga's private files are refused, but this check is not a fence.** A shell command, your own agent's too, is refused when it names `daemon.json`, `identity.json`, `env.json`, `devices.json` or `web-sessions.json` right under `~/.beluga` (`~`, `$HOME`, full paths and quoting count). A project's `.beluga` folder (reports, scratch) and the worktrees under `~/.beluga/workspaces` still work. This only reads the words of the command, and the command runs as you, so it does not stop a command that does not spell the name: `cat ~/.bel*`, `cd ~/.beluga && cat daemon.json`, `cat ~/.beluga/{daemon,env}.json`, a name built from variables or encoded, a script written earlier that reads the file when it runs, or a Beluga home moved by `BELUGA_HOME`. Treat a run that may execute commands without asking as able to read what you can read. Keep approvals on when that matters.
- **Files are sent one at a time.** When you approve sending a file, only a copy of that file is shared, with only that person, for 15 minutes.
- **Your task board, as far as you trust them.** A friend's request to your agent in one of your projects (a shared worktree's chat, or a request by DM naming the project) can use that project's board: Full trust freely, like you; Trusted reads it freely and asks you before each change; Ask me each time asks for every look too. Only that project's board: never another one, never a private task, never a new board, and every change shows in the task's activity as your agent's, for them. Guests invited by link and blocked people get none.
- **Your trust follows them everywhere.** The level you pick for someone counts wherever they reach you (the room, a shared worktree's chat, a DM), not only while they're in your room.
- **Work from friends is yours to approve.** Starting a worktree on your computer or taking over someone's work asks you first (unless you fully trust them); turn it off in Settings → Workspaces.
- **Direct connections are pinned.** A direct (peer-to-peer) connection is encrypted with Noise, has forward secrecy, and only completes with the host whose key is in the invite. The relay and the DHT see IP addresses, never content. See [docs/p2p.md](p2p.md).
- **Untrusted files are handled carefully.** Images from friends are size-checked before decoding, and SVGs can't load files from your disk.
- **MCP Apps stay in their frame.** Only runs that load your MCP servers (yours, or Full trust; never a friend's) show them. A tool's view runs in a sandboxed frame on a loopback origin of its own, with a CSP that lets it reach only the domains its server declared. It calls only tools of its own server that are meant for apps; a tool that isn't read-only asks you first (**Allow / Allow Always / Decline**). It opens only http(s) links, and what it tells your agent reaches the next turn as data, never instructions. See [docs/mcp-apps.md](mcp-apps.md).
- **Your Chrome asks you, unless you asked.** Every Claude run can use Claude in Chrome (Claude Code's `--chrome`): in worktrees, chats, DMs, the room, Sentinels and dialogues. Your Chrome is signed in as you, so who asked decides how it's used. A message you sent yourself, from the Mac app or your phone, uses it as Claude Code always does, under your usual approvals. Any other run asks you before its first Chrome step: a Sentinel run (even one you started), a friend's request (even with full trust), an external agent, a thread, a plan's step, a dialogue, or a message Beluga sent for you. Each request gets one card with only **Allow once** and **Decline**. Allow covers that request's Chrome steps. Decline refuses all of them without asking again. A run that isn't clearly yours asks you. Guests never get Chrome, and `--no-chrome` in Settings › Agents › Launch flags turns it off for every run. Claude's own terminal follows Claude Code's `/chrome` setting.
- **Be aware:** a friend's message can try to talk your agent into things (prompt injection). Keep approvals on for people you don't fully trust.

## Codex runs

Claude Code asks Beluga before every step it takes, so the rules above are checked one step at a time. Codex runs its own commands and edits without asking first, so on Codex the same rules are kept by **Codex's own sandbox** instead: a permissions profile Beluga sets for each run, enforced by the operating system.

On Linux, runs that keep your home private (a friend's task below Full trust, an external agent below Full trust, and quick side calls) start with Codex's minimal system-tool reads and explicit grants for the run's folders and your git config. Other user folders stay unreadable. This also keeps read-only shared folders usable: Codex 0.164's Linux sandbox cannot reopen them beneath a denied home directory. Beluga omits redundant nested masks while retaining secret denials inside readable shared folders. Tool-free side calls skip project instruction files, using only the instructions supplied with the call. Your own runs and other platforms keep their existing baseline.

- Writes go only to the run's own folders. A project's main folder, and a plan while it's being made, are read only.
- `.env` files, keys and credential stores (`.ssh`, `.aws`, the GitHub CLI's token, the keychains, Beluga's own files in `~/.beluga`, Codex's and Claude's logins) can't be read at all, so no command reaches them however it's written. Templates like `.env.example` are hidden too: the sandbox can't tell them apart.
- A friend's task runs with the network off, without your own Codex MCP servers, plugins, hooks and sub-agents (Codex's multi-agent), and without your environment's tokens. It can never ask to go past the sandbox. Beluga's own tools (the room, the board) still check each call against the friend's limits.
- Beluga's own tools (the room, the board, a plan's) go through the same gate as on Claude, for every run: the friend's limits, then Beluga's rules, then you. Your own Codex MCP servers keep Codex's own approvals.
- Your own run may ask to go past the sandbox (a command that needs more): you get the same approval prompt as for Claude.
- Your own run may start Codex sub-agents. They work under the same run, in the same sandbox, and what they ask to go past it comes to you the same way. Stopping the run stops them.
- Guests can't use Codex.
- Quick side calls on Codex (answering in a chat, naming a worktree, drafting a task) run as tightly as a friend's task, whoever asked: read only, your home and `.env` files out of reach, none of your own Codex tools, and no network unless the call runs commands (a pull request's review). A call given no tools can't read the folder either.
- A talk or cross-reference between agents only looks: a Codex speaker's sandbox writes nowhere, whatever the worktree allows.
- On Windows, Codex's unelevated sandbox (a standard account without MXC or Codex's elevated sandbox) fences writes but can't hide a file, and refuses a profile that does. There your own run still works in its folders, but it can read `.env` files and credential stores, and its card says so. Anyone else's run (a friend's task, an external agent below Full trust) is refused, because hiding those files is what keeps it out of your secrets. Codex's elevated sandbox, or MXC where Windows supports it, puts the denials back.

<!-- codex-trust-table -->
| Who asks | Trust | Files | Rest of your home | Network | `.env`, keys, credential stores | Going past the sandbox | Your Codex tools |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Your own run | — | write the run's folders | read | on | denied by the sandbox | asks you | on |
| An external agent's run | An external agent below Full trust (Ask me each time needs Claude) | write the run's folders | denied | on | denied by the sandbox | asks you | off |
| A friend's task | Ask me each time, Trusted | write the run's folders | denied | off | denied by the sandbox | not possible | off |
| A friend's task | Full trust | write the run's folders | read | off | denied by the sandbox | not possible | off |
| A guest | invited into one project | refused | | | | | |
<!-- /codex-trust-table -->

**An external agent is you, steering from another UI.** Its run has `from` = you, and the grant goes with it only as `via`, for the label, the audit log, Stop and Revoke. At Full trust the run has your tools, your variables, your MCP servers and your `.env` rule, with no friend limit, so a grant at Full is as strong as you are on this Mac, and it can reach Beluga's own token. Below Full trust each step reads the grant's level: a shell step, a step outside the run's folders and each Beluga tool ask you, and at Ask me each time every step asks you. A remote grant at Full gives this reach to whoever runs that service.

Whatever an agent's tool call starts goes at its grant's level, by whatever path: a plan's task it starts, a message it edits, a fix it asks for, a friend's answer to a task it sent, a chat it moves to a worktree. A worktree a tool call opens stays that agent's, so what a plan asks there later keeps its level and ends with its grant. A task brief can't raise this.

**Below Full trust, a Claude run has no path fence for a shell either.** Beluga refuses a read of its own files by name, and each shell step shows you a card, but a shell command can hide a path. If you say yes to it, or to the card that opens a terminal, it can reach Beluga's token. Read a shell card as you would read the command in your own terminal. Codex's sandbox holds this below Full trust, also after your yes.

On Codex an agent's run at Full trust has the row "Your own run". Below Full trust it has its own row: it writes only in the run's folders, your home is denied, your Codex tools are off, and it gets only the core environment. The network stays on, because an agent's chat does normal work and with your home denied there is little to send. Codex does not stop at Beluga's gate before each step, so Beluga reads the level when the run starts, and a level you change counts at the next run. At Ask me each time an agent cannot use Codex. Below Full trust its commands that Codex does not count as read-only ask you.

## External agents

[External agents](external-agents.md) control Beluga through its MCP server. Each one has a grant of its own, and you can stop or revoke it alone. Its chats run as your own runs. The server is off until you turn it on.

**What this protects, stated plainly:**

- **A remote agent is a real boundary.** It reaches only what its grant gives, through tools that check the grant at each call. A remote grant has Full trust only by your explicit choice for that one code. Tokens are bound to the address they were issued for, and plain http off this computer is refused. Through a tunnel or Tailscale Serve every request arrives from `127.0.0.1`, so Beluga never uses the socket address to tell local from remote. It uses the Host and the proxies' headers, and it refuses a name it does not know.
- **A local agent with a shell is not contained.** It runs as the same OS user as you, so it can read `~/.beluga` by itself, the daemon's token included. For it a grant gives identity, audit and stop, not containment, unless you sandbox the client yourself.
- **Full trust on a Claude run has no path fence.** It can reach anything you can, the daemon's token included.
- **Remote Full trust gives that to a hosted service.** It has your full power on this Mac, with no card. It can reach Beluga's own token, and anyone who runs that service gets it. With that token, it is no longer held by the rules on this page. It takes an explicit choice for one code (`--allow-remote-full`, or a second confirmation on the Mac), and a confirmation on the sign-in page that shows this warning. A full code made for this computer gets 403 through a route and makes no grant. You get a notice when such a grant is made, and the agent list marks it. Limits, suspension and the refused operations stay.
- **A hosted agent's service holds the access.** Whoever runs that service, or steals from it, can do what you gave it. The sign-in page says so. Limits, suspension and the audit log bound the damage. They do not prevent it.
- **Cloudflare carries the traffic of a public address** and can see it. Tailscale Serve stays on your tailnet.

**What each level allows.** A person answers `ask`. `ask-once` is the same, with no Always. Everything also needs the project or chat to be in the grant. The table is the same on every route.

<!-- external-decision-table -->
| Operation | Blocked | Ask each time | Trusted | Full trust |
| --- | --- | --- | --- | --- |
| Read chats, board, status | deny | ask | allow | allow |
| Stop its own work | deny | allow | allow | allow |
| Launch a chat, or send in one | deny | ask | allow | allow |
| A file step inside shared folders | deny | ask | allow | allow |
| A file step outside them, or a shell command | deny | ask | ask | allow |
| Change a file that runs code later | deny | ask-once | ask-once | allow |
| Board, sentinel, dashboard or plan changes | deny | ask | ask | allow |
| Reach people | deny | ask | ask | allow |
| Delete, archive or merge | deny | ask-once | ask-once | ask-once |
| What was only a person's: trust, invites, settings, approving a plan, turning a sentinel on | deny | ask-once | ask-once | ask-once |
| Secret files (`.env`, keys) | deny | deny | deny | deny |
| Human-only operations | deny | deny | deny | deny |
<!-- /external-decision-table -->

**Human-only operations.** No tool exposes these, at any level. An agent can see that an approval waits, and it cannot answer it.

- Answering approvals, and friends' requests that wait on you
- Reading or changing a grant: pairing codes, tokens, levels, stop, revoke, resume, pause, and turning the server or a route on
- Secret values: environment variables, API keys, a webhook's secret
- Signing in, and pairing a phone with the phone in hand
- A browser's join link, the public address and the tailnet address that make one: a browser session can answer approvals and read secret values

What was once a person's alone, such as trust, a plan's approval, the phone's actions and settings, is now a tool with one card at every level and no Always. Terminal input has a card to open the shell, which says that it can type anything there.

**Stop and revoke.** Stop, Stop all, a suspension and a revoke end the agent's runs and its queue, close its cards, and drop each yes it has not used, so a retry asks you again. A spent refresh token or an authorization code that comes back ends the grant and its work in the same way. A retry with other arguments on the same target replaces its waiting card. A card shows the arguments as they will run, with values that look like secrets scrubbed.

A new API method does not compile until it is classified in `src/external/coverage.ts`.

**What is kept.** Tokens as hashes only, in `~/.beluga/external-agents.json` (0600). Access tokens last 1 hour and stay in memory. Refresh tokens rotate, and a spent one that comes back ends the grant. `~/.beluga/external-audit.jsonl` (0600) has one record per call and decision: agent, tool, class, target, decision, who decided, result, a hash of the arguments and a short summary, never argument values. Beluga has no outside monitoring, so this log is the monitoring.

## Web access

`beluga web` serves the whole Beluga UI to browsers on a port of its own (see
[docs/web.md](web.md)). A browser there can do everything you can: run agents, open a
shell, read and write your files. So the web port is treated as the most sensitive way in.

- **The daemon's token never leaves the computer.** The Mac app and tools use a loopback socket
  with the 256-bit token in `~/.beluga/daemon.json`; the web port is a separate listener that never
  reads that token or serves that file. A browser's socket is let in by its session, then goes
  through the same accept path as the app's, as a `web` screen.
- **Never in the clear.** The web port listens on `127.0.0.1:7777`. An address others can reach
  over plain http (`0.0.0.0`, a LAN or public address) is refused: use an SSH tunnel, Tailscale
  (its `100.x` addresses are encrypted by WireGuard, or `tailscale serve` for https) or a https
  tunnel in front of 127.0.0.1. `--insecure-http` does it anyway, says so, and isn't remembered
  for the next start.
- **One link, one browser, once.** A join link (`/join#<128-bit secret>`) works once, for 10
  minutes. The secret is in the URL's fragment, which browsers never send to a server, and the
  join page wipes it from the address bar before it does anything else. Wrong secrets are
  rate-limited (10 per address and 50 in all per 10 minutes); a good link always works.
- **The session is a cookie scripts can't read.** `HttpOnly`, `SameSite=Strict`, and on https
  `Secure` with the `__Host-` prefix (and then only that one is taken). Only its SHA-256 is stored
  (`~/.beluga/web-sessions.json`, 0600).
- **Revoking is immediate.** Settings › Advanced › Web access and `beluga web sessions` list
  browsers; Revoke forgets one, stops hearing its socket at once and cuts it off, and its page
  locks. Only the Mac app and the command line make links, revoke and close the port: a browser
  can't, so a stolen cookie can't mint itself a new session before you revoke it.
- **Nothing before a session.** Without one the port answers with the Ask for a link page and
  refuses the socket; only the web app's manifest and icons are public.
- **Your Tailscale login, and only on your tailnet.** `beluga web --tailscale` uses Tailscale
  Serve, never Funnel. The machine owner's Tailscale login gets a session without a join link; the
  `Tailscale-User-Login` header that says so is believed only from loopback (tailscaled), under the
  `ts.net` name, while Serve is on. Another account on the same machine could forge it, so on a
  shared server use join links. A tagged machine trusts nobody's login.
- **A public link is guarded by its join links.** `beluga web --public` puts the port behind a
  Cloudflare quick tunnel: anyone with the address reaches the Ask for a link page, and anyone
  with a join link gets in. Wrong links through it are cut off harder (5 per visitor, 20 in all
  per 10 minutes). `beluga web --off` closes it, and it stays closed across restarts.
- **On a server, Claude's token stays put.** `beluga setup` keeps the `claude setup-token` token
  in `~/.beluga/claude-token` (0600) and hands it only to the Claude Code it runs; it is never
  printed, logged or sent to a phone or browser. How to run Beluga on a server, and what each way
  in lets through: [docs/headless.md](headless.md).
- **Only Beluga's own page.** The socket, the join exchange and uploads need the page's own
  Origin, so another website you visit can't drive Beluga through your browser; the Host must be a
  loopback name, an IP address or one you allowed (`--allow-host`, never a wildcard), so a website
  can't rebind its name to 127.0.0.1. The app is served with the Mac app's content security policy
  (only its own scripts and its own socket) and can't be framed.

### Review (BLG-653)

A review of the web port (`src/daemon/web*.ts`, `server.ts`'s `adopt`, the `web.*` API and the
browser side), with a probe against the running listener: every route, method and URL trick
without a session (absolute-form targets, `//`, encoded `..`, NUL, odd methods, upgrades on other
paths) got a 401 or 404; foreign, missing and `null` Origins and rebinding Host names were refused.

| # | Finding | Severity | Fixed |
| --- | --- | --- | --- |
| 1 | A revoked browser's socket kept being heard until it answered the close (up to 30 s); sessions pushed out at 100 kept their sockets | medium | frames on a closing socket are dropped, the socket is terminated, pushed-out sessions are revoked (`tests/web-security.test.ts`) |
| 2 | `--listen 0.0.0.0` sent the join secret and the cookie over plain http, and was reopened at every start | high | non-loopback, non-Tailscale addresses are refused without `--insecure-http`, which is said and never remembered |
| 3 | The served app had no content security policy (one injected script would be a shell) | medium | the Mac app's policy on every file: `script-src 'self'`, `connect-src` its own socket, `object-src 'none'` |
| 4 | A browser could make join links, revoke others, rebind the port, or allow every Host | medium | `web.link`, `web.sessions.revoke`, `web.stop`, `web.public`, `web.tailscale` are refused to `web` screens; `--allow-host` takes no wildcard |
| 5 | Cookies ignore ports: another server on 127.0.0.1 gets the cookie | low | accepted on http (that server is already on your computer, and the Origin checks stop it driving Beluga); on https only the `__Host-` cookie is taken |
| 6 | Junk join attempts could lock the owner's good link out | low | a good link is tried first; only wrong ones count |
| 7 | Hashed bundles were `public` for a year (a tunnel's CDN could serve them unauthenticated) | low | `private` |
| 8 | Uploads and download copies were never cleared; Windows device names | low | copies cleared and uploads older than 30 days swept at start; `CON`, `NUL`… get a prefix |
| 9 | Big uploads cut off after 5 minutes; `filename*` not RFC 5987; browsers counted as the Mac app for notifications | info | 30-minute request timeout for the port; RFC 5987 encoding; browsers are `web` screens, the Mac app gets notifications first |

Accepted: no notice yet when a browser joins (the daemon log says so; Settings lists it); no
upload quota beyond 512 MB per file and the 30-day sweep; a library's `eval` probe is blocked by
the policy, as it is in the Mac app.

## OpenCode runs

OpenCode asks before each step it takes, the way Claude Code does, once Beluga has told it to. For each run Beluga gives OpenCode settings that make every one of its permissions "ask", yours and each of its agents' (a "deny" of yours stays a deny). So every step comes to Beluga first and is checked by the same rules as Claude's, one step at a time.

- `.env` files, keys and credential stores are turned down unless you say yes, as on Claude. Reads, edits, commands and searches outside the run's folders ask you or are refused, as on Claude.
- A project's main folder stays read only, and a plan while it's being made edits nothing (OpenCode's own plan agent, and Beluga turns its edits down too).
- Beluga's own tools (the room, the board) check each call where they run, as on Codex.
- Beluga always answers "allow once" or "reject", never "always", so nothing it allows is kept in OpenCode.
- Friends' tasks and guests don't run on OpenCode. Your OpenCode plugins, and in newer OpenCode the rules you saved with "Always allow" in its own app, can answer a step before Beluga is asked, and OpenCode has no sandbox to fall back on. A friend's task goes to Claude (or Codex) instead, and their card says why. Guests are turned away, with the reason on the Invite People sheet.
- Quick side calls on OpenCode (answering in a chat, naming a worktree) and side questions (/btw) run without your plugins. Every tool still asks, and Beluga allows only the ones the call was given: none for a side question.

## Copilot runs

Copilot CLI asks before some of its steps, not all of them: before an edit, a command that changes something, a file outside the run's folder, and an MCP tool. Those come to Beluga and are checked by the same rules as Claude's, one step at a time. It reads files in the folder and runs commands that only look (`ls`, `git status`, `cat`) without asking anyone.

- Its reads of `.env` files, keys and credential folders are turned down on its command line for every run (`--deny-tool`, the list is `SECRET_READS` in `src/agent/runtime/copilot/connection.ts`), so they never reach it through its file tools. A command that only looks isn't asked about, so a command naming one of those files isn't caught: this is why friends' tasks and guests don't run on Copilot.
- A project's main folder stays read only, and a plan while it's being made edits nothing (Copilot's own Plan mode, and Beluga turns its edits down too).
- Beluga's own tools (the room, the board) reach Copilot over HTTP on 127.0.0.1, each run with its own token, and check each call where they run.
- Beluga always answers "allow once" or "deny", never "always", so nothing it allows is kept in Copilot.
- Friends' tasks and guests don't run on Copilot. A friend's task goes to Claude (or Codex) instead, and their card says why. Guests are turned away, with the reason on the Invite People sheet.
- Quick side calls on Copilot (answering in a chat, naming a worktree) run without your instruction files. Beluga allows only the tools the call was given.

## Grok Build runs

Grok Build runs what it thinks is read-only without asking, so Beluga starts each run with a hook of its own, for that one process, that makes every step ask. Every step, reads and searches and steps you once "always allowed" included, comes to Beluga first and is checked by the same rules as Claude's. Your Grok config isn't changed.

- `.env` files, keys and credential stores are turned down unless you say yes, as on Claude. Reads, edits, commands and searches outside the run's folders ask you or are refused, as on Claude.
- A project's main folder stays read only, and a plan while it's being made changes nothing (Beluga's read-only rules, and no sub-agents until you approve).
- Beluga's own tools (the room, the board) check each call where they run.
- Beluga always answers "allow once" or "reject", never "always", so nothing it allows is kept in Grok.
- Grok's web search runs on xAI's side: the step shows on the card, but Beluga isn't asked first.
- Friends' tasks and guests don't run on Grok Build. A company's Grok policy (`allowManagedHooksOnly`) can switch Beluga's hook off, and Grok has no sandbox Beluga could fall back on. A friend's task goes to Claude (or Codex) instead, and their card says why. Guests are turned away, with the reason on the Invite People sheet.

## Machines: your computers

Your Beluga app can drive your other computers (a Mac mini, a cloud server, a Linux box): see
[docs/machines.md](machines.md). Each of them can run anything you could, so who may drive one is
kept as tightly as who may open a terminal on it.

- **Only devices your identity signed.** Adding a computer (over SSH, or with the link or code
  `beluga pair --computer` prints, good once for 10 minutes) ends with the same four pictures on
  both sides and your click on Join; then your identity signs it into your **device set**. A
  computer lets in exactly the apps and phones in the newest set your identity signed, each by its
  own key, end to end encrypted (Noise), directly or through a relay that only carries ciphertext.
  Pairing over SSH uses your own ssh in batch mode: it never asks for or keeps a password.
- **What a driving app may do.** Everything you do in Beluga, as if you sat at that computer:
  chats, worktrees, runs, plans, sentinels, files, terminals, git, settings, friends. Not who gets
  in: making or revoking browser links, pairing phones, joining apps or computers, forgetting a
  device and quitting Beluga there stay with the computer itself (its own app or terminal) or with
  your app's own Settings › Your Computers. Every API method is decided one way or the other
  (`src/machines/coverage.ts`), and a refused one answers in plain words.
- **One direction.** Your app drives your computers; a computer never drives your app, nor another
  computer. Computers only swap the device set and your settings with each other. Work goes to a
  computer only from your app: on a computer, Run New Work On always means that computer. The app's
  UI is always its own build: nothing is served from the computer, only the app's actions and their
  answers cross the link.
- **What a computer may ask of your app.** Only to show a notification, copy text, come to the
  front, read an image you pasted, or open an http(s) page in your browser. Anything else (a
  `file:` link, another scheme) is answered no at the app's door, before it reaches the window.
- **Phones are trusted through your identity.** A phone you paired is in your device set, so each
  computer lets it in directly, with the phone's limits (the same as on your Mac,
  `src/companion/coverage.ts`), never an app's. A computer keeps no record of it on disk.
- **Forgetting an app, a phone or a computer.** Any of your devices can forget one (Settings › Your
  Computers › ••• › Forget, `beluga computers forget <name>`). It's cut off at once where you did
  it, and everywhere else as the set reaches them; forgets only add up, so an older set can't undo
  one. A device paired again later gets a new certificate. What your Mac kept of a forgotten
  computer (its last state and the files you read) is cleared.
- **Your identity leaves this Mac once, when you ask.** Make Always On… moves your identity and
  your friends network to one computer, after a confirmation that says so, over your own
  end-to-end link. Each file is checked (SHA-256) before the hand-over commits, so there's never two
  of you and never none. Your Mac keeps a stand-by copy that never leaves it again.
- **The lease keeps exactly one of you online.** Whichever install is you renews a lease every
  minute: a record on the DHT under a key only your identity derives. Your Mac stands in only after
  your Always On hasn't answered for 10 minutes and its lease is 10 minutes stale, and hands back by
  itself when it answers. An install that finds a fresher lease than its own stops being you at
  once, and one that was your Always On asks the lease before its network starts.
- **Secrets only after the ask.** Your settings follow you to every computer; your own variables
  (Settings › Environment) don't, until you say Keep My Secrets in Sync With … for that computer.
  Then they go over the end-to-end link and never into a log: names and counts only, and a hash of
  each value to tell what changed.
- **.env files are asked about by name, and logged by name.** A worktree made on a computer asks
  before the project's .env files go there (Send Once, Don't Send, or Always for This Project),
  showing their names only. A send is logged with the file names, never their values, and the files
  are written readable only by you. Values never reach an ask or the phone. Keys, certificates,
  `.ssh`, `.aws`, `~/.beluga` and links pointing at them never go, whatever you choose; a file
  dropped on a chat there is checked the same way.
- **Ports go only where you said.** Your app may open a stream to any port on a computer it drives
  (it could run anything there anyway); a computer reaches only the ports of this Mac you shared
  with it, until you Unshare.
- **What stays on your Mac.** A computer's last state and the pieces of files you read are cached
  under `~/.beluga/cache` (capped, never beside your keys), so an offline computer stays readable.
  `.env` files and keys are never cached.
