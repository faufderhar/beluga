# Security


Inviting someone exposes your agent, with your permissions, to other people. Beluga is built around that:

- **Solo by default.** Nothing is reachable until you click Invite.
- **The invite is the key.** Anyone with the link can join, so share it privately. The host can **remove** someone, **replace the link** (the old one stops working; people already in stay), or **close the room** to newcomers.
- **Nobody can speak for someone else.** Everyone has their own signing key (kept in `~/.beluga/identity.json`), their id comes from it, and **every message is signed**. Not even the host relaying the room can forge a message from you, so a trust level you gave someone can't be borrowed. Requests that act on your computer must be fresh: an old one replayed later is dropped.
- **You decide how much each person may do**: can't use your agent, ask each time, trusted, or full trust (see *Working with people*). Unanswered approvals are declined after 5 minutes.
- **Reaching outside your shared folders asks you.** Friends' requests use your shared folders; reading anything else, shell commands, web requests and edits outside a `:rw` folder ask you first, even ones Claude Code would normally auto-approve. Only **full trust** skips these. Folders are checked where they really are: a link inside a shared folder can't reach a file outside it, and a harmlessly named link to a key is still refused as the key.
- **Editing files never quietly becomes running commands.** A friend's change to a file that makes code run later (git hooks and `.git/config`, `.claude/` and `.mcp.json`, `.vscode/`, `.husky/`, `.envrc`, `package.json`, `Makefile`, CI workflows, shell start-up files, login items, `.command` files) asks you every time, even in a `:rw` folder, with only **Allow once** and **Decline**. Only **full trust** skips it.
- **Commands from friends are yours to approve.** A friend (or their agent) asking to run a command on your computer always shows you the exact command first, unless you fully trust them. It runs with no input, a time limit and capped output, and you get a notice afterwards.
- **A friend's request can't run on and on.** It stops after 20 minutes or 50 turns, after asking you to approve 8 steps, or when you decline 2 in a row, and the friend is told why. It takes at most 4 screenshots, commands like `screencapture` included.
- **Secrets stay put unless you send one yourself.** `.env` files, keys, `.ssh`, `.aws` and similar are never shared or readable by friends' requests, and commands or asks to their agent that touch them are refused, whatever the trust level. A friend can only ask for one secret file at a time (`get_file`): you then get a separate approval that says what it is ("kay's agent wants your private SSH key id_ed25519"), every time, with only **Allow once** and **Decline**. Trust, rules and Always never cover it. If you allow it, Beluga sends that one file (no agent reads it), and their agent is told you approved it. Beluga's own private files in `~/.beluga` (your identity, settings, rules) and the keychains are never sent, whoever approves.
- **Your own `.env` files are yours.** You see and edit them in Files (friends never see even their names). Your own agent asks before it reads or changes one, even when it asks you nothing else: allow once, always for that project, or always. Take it back in Settings › Environment › Your agent. Keys, `.ssh`, `.aws` and Beluga's own files stay refused. Templates (`.env.example`, `.env.sample`…) hold no secrets and are ordinary files.
- **Files are sent one at a time.** When you approve sending a file, only a copy of that file is shared, with only that person, for 15 minutes.
- **Your task board, as far as you trust them.** A friend's request to your agent in one of your projects (a shared worktree's chat, or a request by DM naming the project) can use that project's board: Full trust freely, like you; Trusted reads it freely and asks you before each change; Ask me each time asks for every look too. Only that project's board: never another one, never a private task, never a new board, and every change shows in the task's activity as your agent's, for them. Guests invited by link and blocked people get none.
- **Your trust follows them everywhere.** The level you pick for someone counts wherever they reach you (the room, a shared worktree's chat, a DM), not only while they're in your room.
- **Work from friends is yours to approve.** Starting a worktree on your computer or taking over someone's work asks you first (unless you fully trust them); turn it off in Settings → Workspaces.
- **Direct connections are pinned.** A direct (peer-to-peer) connection is encrypted with Noise, has forward secrecy, and only completes with the host whose key is in the invite. The relay and the DHT see IP addresses, never content. See [docs/p2p.md](p2p.md).
- **Untrusted files are handled carefully.** Images from friends are size-checked before decoding, and SVGs can't load files from your disk.
- **Be aware:** a friend's message can try to talk your agent into things (prompt injection). Keep approvals on for people you don't fully trust.

## Codex runs

Claude Code asks Beluga before every step it takes, so the rules above are checked one step at a time. Codex runs its own commands and edits without asking first, so on Codex the same rules are kept by **Codex's own sandbox** instead: a permissions profile Beluga sets for each run, enforced by macOS.

- Writes go only to the run's own folders. A project's main folder, and a plan while it's being made, are read only.
- `.env` files, keys and credential stores (`.ssh`, `.aws`, the GitHub CLI's token, the keychains, Beluga's own files in `~/.beluga`, Codex's and Claude's logins) can't be read at all, so no command reaches them however it's written. Templates like `.env.example` are hidden too: the sandbox can't tell them apart.
- A friend's task runs with the network off, without your own Codex MCP servers, plugins, hooks and sub-agents (Codex's multi-agent), and without your environment's tokens. It can never ask to go past the sandbox. Beluga's own tools (the room, the board) still check each call against the friend's limits.
- Your own run may ask to go past the sandbox (a command that needs more): you get the same approval prompt as for Claude.
- Your own run may start Codex sub-agents. They work under the same run, in the same sandbox, and what they ask to go past it comes to you the same way. Stopping the run stops them.
- Guests can't use Codex.
- Quick side calls on Codex (answering in a chat, naming a worktree, drafting a task) run as tightly as a friend's task, whoever asked: read only, your home and `.env` files out of reach, none of your own Codex tools, and no network unless the call runs commands (a pull request's review). A call given no tools can't read the folder either.
- A talk or cross-reference between agents only looks: a Codex speaker's sandbox writes nowhere, whatever the worktree allows.

<!-- codex-trust-table -->
| Who asks | Trust | Files | Rest of your home | Network | `.env`, keys, credential stores | Going past the sandbox | Your Codex tools |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Your own run | — | write the run's folders | read | on | denied by the sandbox | asks you | on |
| A friend's task | Ask me each time, Trusted | write the run's folders | denied | off | denied by the sandbox | not possible | off |
| A friend's task | Full trust | write the run's folders | read | off | denied by the sandbox | not possible | off |
| A guest | invited into one project | refused | | | | | |
<!-- /codex-trust-table -->

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
