# Your computers

Your Beluga app stays on the device in front of you, with its own windows, menus and shortcuts.
Your other computers (a Mac mini, an AWS, Google Cloud or Azure server, a Linux box under the desk,
a Raspberry Pi) do the work: worktrees, Claude Code and Codex runs, plans, sentinels, setups and dev
servers run there, and this Mac and your phone show it as it happens, the way you already see a
friend's work.

It isn't the browser version: nothing about the app comes from the computer. Only what you do and
what it shows cross your end-to-end link, so the app feels like a Mac app because it is one. When
to use which: [Beluga on a server](headless.md#a-computer-of-yours-or-a-browser).

Everything here is in **Settings › Your Computers**.

## Adding a computer

**Add a Computer…** offers two ways.

- **Over SSH.** Pick one of your hosts (from your ssh config) or type `you@host`, then **Add**.
  Beluga reaches it with your own ssh (your keys, your agent; it never asks for or keeps a
  password), puts Beluga on it and starts it when it needs to, and opens a pairing there. The
  pictures the computer printed over SSH have to match the ones the app shows; then you're asked
  to add it. From a terminal: `beluga connect you@host --pair`.
- **Link or Code.** On the computer, run `beluga pair --computer`: it prints a link, a 12-character
  code and a QR, good once, for 10 minutes. Paste either in the app and press **Add**.

Either way you see **four pictures** here and on the computer. When they match, press **Join**:
your identity signs the computer in, and from then on it lets in your Beluga apps and phones, and
nobody else. It never needs a port opened: it reaches you directly when the network allows, and
through a relay that carries only ciphertext when it doesn't.

### Names, icons and kinds

A computer works out what it is on its own, and each kind has its own mark:

- **A cloud server**: AWS, Google Cloud, Azure, DigitalOcean and Hetzner with their logo and
  region; Oracle Cloud, Akamai (Linode), Vultr, Scaleway, OVHcloud, Alibaba Cloud, UpCloud and
  Exoscale with their logo.
- **An app host** that says so in its environment: GitHub Codespaces, Fly.io, Railway, Render, or
  a Kubernetes pod.
- **A Linux computer** by its distribution (Ubuntu, Debian, Fedora, Arch, Alpine, CentOS, Red Hat,
  Rocky, AlmaLinux, openSUSE, NixOS, Linux Mint, Manjaro, Pop!_OS, Gentoo, Kali), with its logo and
  version ("Ubuntu 24.04"); any other Linux gets Tux.
- **A Raspberry Pi, or a Docker or Podman container**, with its logo; **WSL** shows its
  distribution ("Ubuntu 24.04 · WSL").
- **A virtual machine**: VMware and QEMU/KVM (Proxmox, UTM) with their logo; VirtualBox,
  Parallels, Hyper-V and Apple Virtualization in Beluga's own icon.
- **A Mac by model** (Mac mini, Mac Studio, iMac, MacBook) or **a Windows PC**, each drawn in
  Beluga's own icons: Apple and Microsoft don't let others use their logos.

That gives it a fitting mark and a name you can keep. Click its name to rename it, or use its **••• › Rename…**; **••• › Icon** picks Server,
Cloud, Desktop, Laptop, Chip or Box instead of its kind's.

Each row says, in a line, how it is: its kind, the memory it has free and how many tasks it runs,
or **Offline · seen 2 h ago**. What runs there now is listed under it; click one to open it.

### On another version

A computer on another version of Beluga is still listed, read-only, with why in plain words. Where
the computer is the older one, **Update It** updates it, but only once nothing runs there (no agent
working, no program in a terminal); otherwise it says what runs and offers **When They're Done** or
**Now**. Before your app updates to a version a computer couldn't follow, the update sheet names
the computers it would leave behind and offers to update them first.

Whatever their versions, your app reads each computer's state whole (`src/ipc/state-compat.ts`). A
part an older computer doesn't have, or a field it doesn't have inside one, reads as empty, never
as missing. An action from a newer computer that your app doesn't know is skipped, and a fresh copy
of its state follows within a few seconds. An action your app can't apply brings a fresh copy at
once. The computer's cached state on this Mac (`machines/cache.ts`) skips such an action the same way.

## Where new work runs

### Run New Work On

**Settings › Your Computers › Run New Work On** says where the worktrees, runs, plans and
sentinels you start from now on go:

- **This Mac** (the computer in front of you), the default.
- **A computer of yours**, by name.
- **Best Available**: the computer with the most room right now. It weighs which ones are online,
  on your version, have the agent signed in and under its usage limit, already have the project
  (or can clone it), and how much memory, disk and load they have. When this Mac is the least busy,
  work stays here. Its line says which computer it would pick now, and why.

The setting says where new work goes now, and why: when the computer you chose is offline, on
another version or has Claude signed out, new work runs on this Mac for now, and it says so.

### Runs on, per task

Once you have a computer, a **Runs on** chip sits beside the mode and model wherever work is made:
the chat's box, a project's home, New Plan and New Sentinel. It starts from Run New Work On and
remembers your last pick per project.

Its menu lists **This Mac**, each computer with its line, and **Best Available**. A computer that
can't take the work is greyed, with why: **Offline since 14:02**, **Claude isn't signed in there**,
**Claude's limit resets at 16:00**, **On another version: update it in Settings**. If the computer you
picked can't take it when you send, nothing starts: you're told why, and you pick another or wait.
Work is never quietly made somewhere you didn't choose.

Without a computer paired, there's no chip and nothing changes.

### What it looks like

A worktree on a computer is in your sidebar like any other, its computer's icon beside it, under
**On your computers** where that helps. Its toolbar names the computer, and says **Slow** or
**Reconnecting** when the link is. Its chat, files, changes, terminal and Background tab work as
they do here: everything runs on the computer, and only what you see crosses.

The bell and the Dock count every computer's notices. Each says which computer it's from, opens
there, and an answer you give goes back to that computer. Do Not Disturb here silences them all.

## Getting a computer ready

When you start work on a computer that doesn't have the project yet, the new worktree shows
**Getting … ready** and each step as it goes, on the computer's own system with its own git, gh and
tools:

1. Its projects folder.
2. A clone of the project (with gh's sign-in there, when it has one; **Sign gh in on …** when a
   private GitHub repository needs it).
3. The tools the project's own files ask for (a Node version, Python, Go…). What's missing is named
   first; **Install Them** installs it the system's own way, as your user when it can.
4. Its setup, worked out for that system and kept there for the next worktree.

Errors are said in plain words, and nothing installs without your say. The next worktree in that
project starts at once.

## .env files

A worktree made on a computer needs the project's .env files, which are on this Mac. When the
computer's copy of the project lacks ones this Mac has, the new worktree (in its conversation and on
the project's page) asks with **their names only**:

- **Send Once**: sent over your end-to-end link and written there for this project's worktrees,
  readable only by you.
- **Don't Send**: nothing goes.
- **••• › Always for This Project**: sent without asking from then on.

**Settings › Your Computers › Env files sent without asking** lists the projects you said always
for, and **Ask Again** takes it back. Values are never logged, never in an ask, and never on the
phone. Templates (`.env.example`…) are ordinary files and aren't asked about. Keys, certificates,
anything in `.ssh` or `.aws`, and Beluga's own files are never sent, whatever you choose.

Dropping a file from Finder on a chat that runs on a computer sends it there, a piece at a time
with its progress in the box. An env file dropped there asks the same way (**Send Once** or
**Don't Send**); a key or a file from a credential folder is refused, with why.

### Your own variables

The variables you set in **Settings › Environment** are yours, not a project's, so they stay on
this Mac until you say otherwise: a computer's **••• › Keep My Secrets in Sync With …** asks once,
then sends them over your end-to-end link and keeps them in step both ways. **Stop Syncing My
Secrets** stops it; the ones already there stay.

## Ports

A dev server in a worktree on a computer opens on this Mac as if it ran here. The worktree's
**Background** tab lists each server under **Ports**, with **Open** at `localhost:<port>`. It uses
the same port when it's free, so OAuth callbacks, CORS and hot reload keep working; when this Mac
already uses that port, the next free one, and the tab says which.

The other way round, **Share a Port from This Mac** lets the computer reach a service running here
(a local database, an emulator): type the port and **Share**. Only the ports you shared are
reachable from the computer, and **Unshare** closes one at once.

## Files

A computer's files open in Files and the reader as this Mac's do. What you read is streamed: the
file under the pointer is fetched ahead, so it opens at once, and the next part is there before you
scroll to it. Searching and diffs run on the computer, and only their results come back.

- **Download** brings a file there to `~/Downloads/Beluga` and shows it in Finder.
- **Open in Editor** opens the computer's folder in VS Code or Cursor over Remote-SSH, for a
  computer you added over SSH.
- Pictures you paste or drop go as they do here.

What you looked at is kept on this Mac (capped, the oldest going first), so it stays readable when
the computer is offline. Secrets are never kept. Forgetting a computer clears what was kept of it.

## Moving work

- **A worktree's ⋯ › Continue On ▸** moves it to another of your computers (or back to This Mac)
  with its branch and its conversation. Changes not committed are asked about first (**Commit Them
  and Continue**); if its agent is at work, it continues there once the turn ends. The project is
  got ready there if needed, the .env is asked about as for any new worktree, and the old one is
  archived once the new one is there (**Continued on …** in its details). Your next message there
  picks up the conversation.
- **A plan's ⋯ › Move To ▸** moves it between milestones (**Pause and Move** while something runs in
  it; **Commit Them and Move** when its worktrees have changes not committed). It lands paused and
  resumes there if it was running; the old copy stays as its record (**Moved to …**).
- **A sentinel's ⋯ › Move To ▸** moves it, its runs, kept numbers and dashboard tiles, so an
  always-on computer watches for you. Its sources are checked with that computer's variables, and
  it's turned on there if it was on and nothing stands in the way; otherwise it waits there,
  paused, saying why.

Nothing is dropped halfway: until the copy is in, the original stays where it was as it was.

## Your settings follow you

Your models, effort, notifications, Run New Work On and the rest follow you to every computer by
themselves. Each computer keeps what belongs to it: its paths, shell, service, browser access and
phones. A change goes at once; a computer that's offline gets it when it's back, and what changed
there meanwhile comes back the same way. The same setting changed in two places while they were
apart keeps the latest, and **Your Settings** says so, with **Got It**.

## Always On

One computer that never sleeps can be **you on the network**. Your friends' messages and requests
then reach it while this Mac is closed, it runs them under the trust levels you set, and this Mac
shows everything through your link when it's open.

**A computer's ••• › Make Always On…** asks once. Your identity, your friends and their trust
levels, your groups and your chats move to it over your end-to-end link. This is the only time your
identity leaves this Mac. **Run new work there too** sets Run New Work On to it as well. Friends
notice nothing: same you, same chats, nothing to redo.

**You on the Network** says where you are: this Mac, or your Always On, and a move under way.

- **Delivered and Seen.** A friend's message to you shows **Delivered** as soon as your Always On
  has it, closed Mac or not, and **Seen** once you open it on this Mac or your phone.
- **Your phone** reaches your Always On by itself: with this Mac closed, People and chats read from
  it, messages you send go from it, and new messages still notify.
- **When it's down.** If your Always On doesn't answer for 10 minutes, this Mac **stands in** for
  it (Settings says **Standing In**) and friends reach you here. When it answers again, it takes
  over by itself with what came meanwhile. There's never two of you and never none.
- **Bringing it back.** **Make This Mac Always On…** under You on the Network moves you back here,
  the same way. To move it to another computer, bring it back first.

## Your phone without this Mac

Your phone already knows your computers: this Mac tells it about each one, and the phone reaches
each directly with the pairing it has, so work goes on while this Mac sleeps or is closed.

On the phone, **Work** lists each computer under **Your Computers**, with its icon and line;
its conversations open over its own link, and read-only from the phone's copy while it's away.
**Needs You** gathers every computer's, each saying which, and an answer goes back to that computer.
**New Task › Runs on** lists your computers with the same lines as the Mac's menu; picking one
lists its projects and starts the work there.

## Offline computers

A computer that's offline stays in your list, greyed, with when it was last seen. Its worktrees
stay in your sidebar and open from what this Mac last saw, read-only, files you looked at included.
Calls that need it say so at once instead of waiting. When it's back, each window catches up by
itself, terminals included; nothing to reload.

A link that drops while you work doesn't freeze anything: the toolbar says **Reconnecting**, and the
app dials again by itself.

## Forgetting a computer

**A computer's ••• › Forget …** (or `beluga computers forget <name>` on any of your devices) cuts it
off at once there, and on your other devices as soon as they hear. What this Mac kept of it goes
with it. On the computer, `beluga computers` lists the apps and phones that may drive it.

What crosses the link, and what a computer may and may not ask of your app:
[docs/security.md](security.md#machines-your-computers).
