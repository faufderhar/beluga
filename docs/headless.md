# Beluga on a server

Beluga runs with no window on a computer that stays on: a Linux server, a home PC, a Mac mini.
Your projects, worktrees and agents live there; you use them from your phone, or open the whole
Beluga app in any browser. The README has [the short version](../README.md#run-it-on-a-server);
this is the rest.

## What it needs

- **Linux or macOS**, x64 or arm64. On Linux, glibc 2.28 or later: Ubuntu 20.04, Debian 10,
  RHEL 8 and newer.
- **curl** (or wget) to install, and **git** for your projects (`sudo apt install git` if it's
  missing).
- **A Claude subscription.** Beluga downloads Claude Code itself the first time it needs it.
- No sudo, no Node, no open port.

## Install

```sh
curl -fsSL https://github.com/beluga-labs/beluga/releases/latest/download/install.sh | sh
```

It puts Beluga, with its own Node, in `~/.beluga/server` and links the `beluga` command into
`~/.local/bin`. When that folder isn't on your PATH yet, it prints the line that adds it, like:

```sh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
```

Run that, then open a new terminal (or `source ~/.bashrc`).

To install a particular release (its tag from the
[releases page](https://github.com/beluga-labs/beluga/releases)), or link the command into another
folder, set these before `sh`:

```sh
curl -fsSL https://github.com/beluga-labs/beluga/releases/latest/download/install.sh | BELUGA_VERSION=<tag> sh
curl -fsSL https://github.com/beluga-labs/beluga/releases/latest/download/install.sh | BELUGA_BIN_DIR="$HOME/bin" sh
```

## Set up

```sh
beluga setup
```

Five steps, each skipped when it's done already. Stop it at any point and run it again: it picks
up where you left off.

1. **Claude**: signs Claude Code in (below).
2. **This computer**: the name your phone shows for it.
3. **A project**: a folder on the server, or a git URL to clone. Enter skips it.
4. **Your phone**: a QR code to scan with the Beluga app. Enter skips it.
5. **Keep it running**: installs the service, so Beluga starts when the computer does.

For a script or cloud-init, `beluga setup --yes` takes every default and asks nothing (sign
Claude in with `CLAUDE_CODE_OAUTH_TOKEN`, below), and `--project <folder or git URL>` adds a
first project.

### Signing Claude in on a server

A server has no browser, so setup uses Claude Code's own `claude setup-token`:

1. It shows a link. Open it on your laptop or phone and sign in to Claude.
2. Claude shows a code: paste it back into the server's terminal.
3. Claude Code prints a long token starting `sk-ant-`. Copy it, and paste it when setup asks (it
   stays hidden).

Beluga keeps the token in `~/.beluga/claude-token`, readable by you alone, and gives it only to
the Claude Code it runs. It never prints or logs it.

Already have a token (from `claude setup-token` elsewhere)? Set it and run setup, which keeps it:

```sh
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-… beluga setup
```

If Claude Code on the server is already signed in the usual way, setup says so and moves on.

## Keep it running

Setup's last step is the same as:

```sh
beluga service install
```

- **Linux**: a systemd user service, `~/.config/systemd/user/beluga.service`. It starts again if
  it stops by itself. To start at boot and keep running after you log out, systemd needs
  lingering on for you; Beluga turns it on when it can, and otherwise prints the one line to
  run: `sudo loginctl enable-linger $USER`.
- **macOS**: a launchd agent, `~/Library/LaunchAgents/io.github.kayraucklnc.beluga.server.plist`.
  It starts when you log in. For a Mac mini that restarts on its own, turn on automatic login in
  System Settings › Users & Groups.
- **A container, or no systemd**: run `beluga up --foreground` as the container's command, or
  `beluga up`, which runs until the computer restarts.

| Command | What it does |
| --- | --- |
| `beluga status` | whether it runs, its version, projects, phones, relay and browser access |
| `beluga logs -f` | follow its log |
| `beluga up` · `beluga stop` | start it, stop it (a stopped service stays stopped) |
| `beluga service` | whether the service is installed |
| `beluga service remove` | stop it and don't start it at boot any more |
| `beluga project add <folder or git URL>` | add a project; a URL is cloned into your projects folder, `--into <folder>` picks another |
| `beluga project list` · `beluga project remove <name>` | list projects, remove one (its folder stays) |

## Your phone

Get the Beluga phone app (Android: `Beluga-<version>.apk` on the
[releases page](https://github.com/beluga-labs/beluga/releases/latest)). Setup pairs one phone;
for another, on the server:

```sh
beluga pair
```

Scan the QR code with the app (or type the code under it), then confirm on both. `beluga phones`
lists the paired phones and removes one.

The phone reaches the server directly and end to end encrypted, from any network: nothing to open
on the server. When a network blocks a direct connection, it goes through Beluga's relay instead
(a Cloudflare tunnel the server opens), still end to end encrypted: Cloudflare carries only
ciphertext.

## Your Beluga app

The server can also join your devices, so the Beluga app on your Mac drives it. On the server:

```sh
beluga pair --computer
```

It prints a link, a code and a QR, good once for 10 minutes. Add the server from the app with
either; both show the same four pictures, and once you agree the app signs the server in with
your identity. From then on the server lets in the Beluga apps you signed, and nobody else.

`beluga computers` lists your devices: who may drive this server, the computers you drive, your
phones. `beluga computers forget <name>` forgets one, on any of them: it's cut off there at once,
and on your other devices as soon as they hear.

If you can already `ssh` into the server, you can skip all of this: Settings › Your Computers ›
Add a Computer… › Over SSH installs Beluga there, starts it and pairs it in one step. Everything a
computer of yours does (Run New Work On, Runs on, .env files, ports, moving work, Always On):
[docs/machines.md](machines.md).

### A computer of yours, or a browser

Both show the work running on the server. They differ in what runs where:

- **Your Beluga app driving the server** keeps the app on your Mac: its own windows, menus,
  shortcuts, notifications and Dock, at native speed, and it shows this Mac's work and every
  computer's side by side. Only what you do and what you see cross an end-to-end link, and nothing
  of the app comes from the server. The server's dev servers open at `localhost` on your Mac. Use
  it whenever the device in front of you has Beluga: your own Mac, or one you set up.
- **A browser** gets the whole app served by the server. Use it where you can't or won't install
  Beluga (a borrowed laptop, a work machine, a Chromebook, a tablet), or to reach the server for
  a moment. A browser is let in with a join link and can be revoked from the server.
- **Your phone** follows and answers work on the server, and starts tasks there, without your Mac.

## In a browser

The whole Beluga app, the one the Mac shows, also opens in any browser. Beluga serves it on the
server's own `127.0.0.1:7777`, which nothing outside the server reaches; each way in below brings
it to you.

Every browser is let in once, with a **join link**: it works one time, for 10 minutes. The browser
then stays signed in (for 90 days after it was last used). Links are made only on the server,
never from a browser.

```sh
beluga web link          # a new join link
beluga web sessions      # the browsers let in
beluga web revoke <name> # sign one out, at once
beluga web --off         # close browser access, every way in
```

Browser access stays on across restarts until `beluga web --off`.

A browser has no menu bar, so the gear at the top left of the sidebar holds it: **Settings…**
first, then Keys and Commands, Everything You Can Do… (⌘K), and the File, View and Go menus.
Settings there change the Beluga on the server, as the Mac app's do; how it looks (appearance,
text size) is kept by each browser.

### Through Tailscale

You need Tailscale on the server and on your laptop or phone, logged in to the same tailnet. Then,
on the server:

```sh
beluga web --tailscale
```

It prints `https://<server>.<tailnet>.ts.net` and a QR code for your phone's browser. Open it from
any of your devices: your own Tailscale login gets straight in. Anyone else on your tailnet needs
the join link printed under it; run `beluga web --tailscale` again for a new one. It uses
Tailscale Serve, never Funnel: only your tailnet can reach it. On a machine tagged in Tailscale
(owned by no one), every browser needs a join link.

### Through SSH

On your laptop (Linux or macOS), with the `beluga` command there too from the same install line
(it starts nothing there):

```sh
beluga connect you@your-server
```

It asks the server for a join link over ssh (starting Beluga there if it isn't running), opens
an SSH tunnel, and opens your browser through it. A dropped tunnel comes back by itself; Ctrl+C
closes it. Any host from `~/.ssh/config` works, with its user, port and keys. Nothing is opened on
the server.

Without Beluga on the laptop, run `beluga web` on the server. It prints a join link and the ssh
line to run on the laptop:

```sh
ssh -N -L 7777:127.0.0.1:7777 you@your-server
```

Leave that running and open the join link on the laptop.

### A public link

With neither Tailscale nor SSH, on the server:

```sh
beluga web --public
```

It opens a Cloudflare tunnel and prints a `https://….trycloudflare.com` address with a join link
under it. That link works from anywhere, once, for 10 minutes. **Anyone with a join link gets
in**; the address alone shows only a page that asks for one, and wrong links are limited hard.
Keep join links to yourself, and `beluga web sessions` shows who came in. Run
`beluga web --public` again for a new join link.

The address changes when the tunnel restarts; `beluga status` shows the current one. A domain of
your own that stays the same: [docs/web.md](web.md#your-own-domain).

## Updating

```sh
beluga update
```

It runs the install line again, which replaces `~/.beluga/server` in place and starts Beluga again
on the new version if it was running. Your projects, phones, browsers and sign-in stay. Pasting
the install line yourself does the same.

## Removing

```sh
beluga web --off
beluga service remove
beluga stop
rm -rf ~/.beluga/server ~/.local/bin/beluga
```

That removes Beluga's program. Your settings, paired phones, browsers and Claude token stay in
`~/.beluga`; to forget them too, `rm -rf ~/.beluga`. Your projects' folders are never touched.
On the phone, remove the computer from the app.

## What each way in lets through

Beluga's own key to itself (the token in `~/.beluga/daemon.json`) never leaves the server: every
phone and browser gets its own way in, which you can take back.

| Way in | Who can reach it | Who gets in | Opened on the server | Take it back |
| --- | --- | --- | --- | --- |
| Phone | anyone, over the internet | a phone you paired, by its own key | nothing | `beluga phones` |
| Your Beluga app | anyone, over the internet | an app your identity signed, by its own key | nothing | `beluga computers forget` |
| Tailscale | your tailnet only | your Tailscale login; others with a join link | nothing (Tailscale Serve) | `beluga web --off` |
| SSH | whoever can ssh in | a browser with a join link | nothing | `beluga web revoke` |
| Public link | anyone with the address | a browser with a join link | nothing (an outgoing tunnel) | `beluga web --off` |

A browser or phone that's in can do what you can on the server: run agents, open a shell, read and
write your files. So:

- Join links are one use, 10 minutes, and their secret never reaches a server log.
- A browser's session is a cookie scripts can't read; the server keeps only its hash, and revoking
  it cuts the browser off at once.
- On a server other people log in to, use join links rather than Tailscale's login check: another
  account on the same machine could pretend to be Tailscale.
- The Claude token stays in `~/.beluga/claude-token` (0600) and goes only to Claude Code.

The details, and the review behind them: [docs/security.md](security.md#web-access).

## When something doesn't work

**`beluga: command not found`** right after installing: `~/.local/bin` isn't on your PATH. Run the
`echo 'export PATH=…'` line the install printed, then open a new terminal.

**The phone can't connect.** Some networks block the UDP a direct connection needs. Beluga's relay
covers that: `beluga status` says whether the relay is ready. If it says the relay isn't
running, `beluga logs` says why; the server needs outgoing https to Cloudflare for it. The phone
says what it found too, under **Why?**. Pairing with the QR code works even where a typed code
can't find the server.

**Tailscale says it isn't connected**, or isn't installed: install it with
`curl -fsSL https://tailscale.com/install.sh | sh`, log in with `sudo tailscale up`, then run
`beluga web --tailscale` again. Beluga says the one thing to fix when:

- Tailscale needs your say-so to serve as you: `sudo tailscale set --operator=$USER`, once.
- HTTPS certificates are off for your tailnet: turn them on in the Tailscale admin console › DNS ›
  HTTPS Certificates.
- The machine has no name: turn on MagicDNS in the admin console › DNS.

**SSH: "is port … free here?"** `beluga connect` uses port 7777 on your laptop when it's free, and
another one when it isn't. If ssh still can't open the tunnel, choose one:
`beluga connect you@your-server --port 7790`. For the plain ssh line, change the first `7777`:
`ssh -N -L 7790:127.0.0.1:7777 you@your-server`, then open the join link with `7790` in place of
`7777`.

**Port 7777 is busy on the server**: run Beluga's web port on another one,
`beluga web --listen 127.0.0.1:7778`. `beluga connect` follows it by itself.

**`beluga connect` says Beluga isn't installed** on the server: install it there (the line above).
`beluga connect` looks for it in `~/.local/bin` and on the PATH of a plain ssh command; installed
with `BELUGA_BIN_DIR` somewhere else, put that folder on the PATH in `~/.profile`.

**A public link stopped answering**: Cloudflare quick tunnels sometimes drop. Beluga opens a new
one by itself; `beluga status` shows its new address, and `beluga web --public` gives a fresh
join link.

**Anything else**: `beluga status`, then `beluga logs -f`.
