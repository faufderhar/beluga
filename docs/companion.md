# Beluga for phones (the companion)

A phone app for one person: you. It shows what your Mac's Beluga is doing and lets you answer,
ask and chat from it. It has no daemon, no agent and no projects of its own: every screen is a
view of your Mac, and every button is a call to your Mac. Android first; iOS from the same code.

Code: `src/companion/` (the Mac side: pairing, the device link, views, what the phone may call),
`packages/companion/` (the app). This page is the design; `CLAUDE.md` has the rules that keep the
two in step.

## What it is for

| On the phone | Not on the phone |
|---|---|
| What needs you: approvals, your agent's questions, friends' requests, plan decisions, with a push notification | Code in conversations: no diffs, no code blocks in answers (they show as a "code · 24 lines" chip) |
| Live work: conversations, your agent's answers, sub-agents and their steps | Changes, review, commit; git writes beyond Merge |
| Outputs: screenshots, images, logs, test output, reports, PDFs (anything `isArtifact` calls an output) | Editing any file, from anywhere |
| A worktree's **Files**, read-only: browse, search by name, read source with colours (BLG-42) | Secrets (`isSecretPath`), whatever the screen |
| A worktree's **Terminal**, interactive: the same session as the Mac's terminal dock, both typing (BLG-42) | The Mac's other shells, or files outside a worktree |
| Plans as they're designed and run: milestones, tasks, decisions | Editing plans' structure (approve, decide and comment only) |
| Asking your Mac to do anything (Your Mac, a new worktree, plan or question in a project, or a message in a conversation), and getting the answer, images and files back | Settings beyond the phone's own (notifications, sign out) |
| Chats with friends (DMs, channels, files, Ask your agent); asking a friend's agent (`ask_person`) | Hosting rooms, invites |
| Your Claude plan allowance (5-hour and weekly windows), and your friends' | Billing |

Text is never blocked: a `.log`, `.txt`, `.json`, `.md`, `.csv` an agent wrote or a test produced
opens in the text viewer. In a conversation's outputs, source code is held back, with the same rule the Mac's Outputs tab
already uses (`src/core/claude-code/outputs.ts` `isArtifact`: pictures anywhere; text outside the
project or in the folders outputs go to, like `.beluga/scratch`, `test-results`, `coverage`).
Secrets (`isSecretPath`) are never sent, whatever the file. Source code reaches the phone in one
place only: a worktree's Files, read-only ("Files and Terminal" below).

```beluga-graph
{"title": "How the phone reaches your Mac", "summary": "One encrypted link, opened only while you look", "direction": "right",
 "nodes": [
  {"id": "ui", "type": "client", "label": "App screens", "sublabel": "React Native · packages/companion/app", "group": "phone"},
  {"id": "worklet", "type": "service", "label": "Link worklet", "sublabel": "Bare · hyperdht + Noise", "group": "phone", "emphasis": true},
  {"id": "phone", "type": "group", "label": "Your phone"},
  {"id": "dht", "type": "external", "label": "Hyperswarm DHT", "sublabel": "finds your Mac, punches the hole"},
  {"id": "host", "type": "service", "label": "CompanionHost", "sublabel": "src/companion/host.ts", "group": "mac", "emphasis": true},
  {"id": "views", "type": "function", "label": "Views", "sublabel": "src/companion/views.ts", "group": "mac"},
  {"id": "api", "type": "service", "label": "Daemon API", "sublabel": "src/ipc/api.ts, phone allowlist", "group": "mac"},
  {"id": "mac", "type": "group", "label": "Your Mac"},
  {"id": "push", "type": "external", "label": "Beluga Push", "sublabel": "blind relay → FCM / APNs"}
 ],
 "edges": [
  {"from": "ui", "to": "worklet", "label": "RPC", "kind": "call"},
  {"from": "worklet", "to": "dht", "label": "lookup", "kind": "flow"},
  {"from": "worklet", "to": "host", "label": "Noise stream (pinned keys)", "kind": "data"},
  {"from": "host", "to": "views", "label": "subscribed topics", "kind": "call"},
  {"from": "host", "to": "api", "label": "allowed calls", "kind": "call"},
  {"from": "host", "to": "push", "label": "sealed nudge", "kind": "async"},
  {"from": "push", "to": "ui", "label": "notification", "kind": "async"}
 ],
 "steps": [
  {"title": "1. You open the app", "text": "The worklet starts, looks your Mac up on the DHT and opens one Noise stream to it. Only your phone's key gets through the Mac's firewall.", "focus": ["worklet", "dht", "host"]},
  {"title": "2. The screen subscribes", "text": "The phone names the topics on screen (home, one conversation). The Mac sends each as a small, finished view, and again when it changes.", "focus": ["host", "views"]},
  {"title": "3. You act", "text": "Approve, answer, send: a call to the same API the Mac app uses, if it's on the phone's allowlist.", "focus": ["ui", "api"]},
  {"title": "4. You put it away", "text": "Fifteen seconds in the background and the link closes and the DHT node stops: no radio, no battery.", "focus": ["worklet"]},
  {"title": "5. Something needs you", "text": "The Mac seals a nudge to the phone's key and sends it through Beluga Push. The phone shows it; acting on it opens the link for a second.", "focus": ["host", "push", "ui"]}
 ]}
```

## Signing in: your phone is a device of you

Beluga has no accounts: you are your Ed25519 identity (`~/.beluga/identity.json`). The identity's
private key never leaves the Mac. The phone gets its own key and a **device certificate** your
identity signs, so it can prove it speaks for you without being able to sign as you.

1. **Mac › Settings › Phone › Pair a Phone** opens a one-time pairing (`beluga://device#<secret>`,
   128 bits, 10 minutes, one use) as a QR code, plus a short code to type (`K7QM-4XPA-R2TD`, as
   friend codes, but stretched with Argon2id at 64 MiB so the phone can do it with sodium; works
   for 10 minutes).
2. The phone makes its device key (Ed25519, kept in the Android Keystore-wrapped encrypted store;
   the iOS Keychain later), its link key pair (Noise) and its box key (X25519), all from one seed
   it keeps (keyed BLAKE2b, `device-crypto.ts` `deviceKeys`).
3. The phone dials the temporary key the secret derives (the technique of friend invitations,
   `invitations.ts` `pairingSecrets`, with keyed BLAKE2b and labels `beluga-device-*` so the phone
   needs only sodium), and the two sides trade proofs bound to that Noise handshake (`devProof`):
   nobody without the secret can sit in the middle. Everything the phone does here is in
   `src/companion/device-crypto.ts`, shared by both sides, sodium-universal and b4a only.
4. The Mac shows "Pair Kayra's Pixel 9?" with the phone's name and a 4-emoji fingerprint the phone
   shows too. You click Pair.
5. The Mac answers with the **device certificate**
   `{ v:1, owner: peerId, ownerKey, device: deviceKey, link: linkPublicKey, box: x25519, name, platform, issuedAt }`
   signed by the identity (`signText('beluga-device-v1', canonical(cert))`; the phone checks it with
   sodium's `crypto_sign_verify_detached`, the raw key being the SPKI's last 32 bytes), the Mac's companion
   address, your name and profile. Both keep it: the Mac in `~/.beluga/devices.json` (0600), the
   phone in its store.

From then on the phone dials your Mac's **companion address** (stable, HKDF of your identity,
`'companion-v1'`, separate from the mesh address so it works whether or not the network is on), and
the Mac's firewall lets in only link keys of certificates it issued and hasn't revoked. The Noise IK
handshake pins both ends: the phone knows it reached your Mac, the Mac knows which phone it is.

**Removing a phone** (Settings › Phone, or Sign Out on the phone) deletes the certificate: the link
drops at once and the key is refused from then on. A lost phone is cut off from the Mac in one click.
Up to 4 phones.

Friends never see the phone. To them it is still you on your Mac; a chat message you send from the
phone is sent by your Mac, signed by your identity.

## The link

One Noise stream (`@hyperswarm/secret-stream` over hyperdht's UDX), framed as today's transport
(`[u32 length][u8 kind][payload]`), JSON messages validated by `src/companion/protocol.ts`:

| Phone → Mac | Mac → Phone |
|---|---|
| `hello {v, app, platform, topics}` | `welcome {v, min, mac, me}` (or close 4002 "update") |
| `sub {topics}`: what's on screen now | `view {topic, rev, data}`: a finished view, replacing the last |
| `call {id, method, args}`: an API call on the allowlist | `result {id, ok, value \| error}` |
| `get {id, ref, variant: thumb \| full \| text, off}` | `chunk {id, off, b64, eof, size, mime}` |
| `push {platform, token, relayKey}` (register for notifications) | `nudge {kind, title, body, topic}` (while linked, in place of a push) |
| `put {id, name, mime, size, off, b64, eof}`: a photo or file for the Mac, in pieces | `result {id, value: {received} \| {ref}}`: the last piece's `up:` ref |
| `term_attach {term}` / `term_detach {term}` (1.7): a terminal on screen | `term_status {term, running, exit?, cols, rows, gone?}`, then `term_data {term, data, reset?}` as it comes (~30 a second) |
| `term_input {term, data}` (1.7): keys typed on the phone | (the session's own echo, in `term_data`) |
| `control {state}` (1.16): what this phone lets its Mac do, and how it's reached | `req {id, op, args}` (1.16): do something on the phone (the Accessibility service) |
| `reply {id, ok, value \| error}` (1.16): the answer to a `req` | |
| `adb_code {code}` (1.16): the Wireless-debugging pairing code the user typed | |
| `tun_ok / tun_data / tun_ack / tun_close {id, …}` (1.16): the adb tunnel, phone side | `tun_open {id, to}` then `tun_data / tun_ack / tun_close` (1.16): the adb tunnel, Mac side |
| `vid {seq, b64, key?, ts, w, h, sw, sh}` (1.18): a piece of the screen's live video, after `req mirror` | `vid_ack {seq}` (1.18): the Mac took it (the phone paces itself by these) |
| `vid_end {reason?}` (1.18): the video stopped (the user said no or pressed Stop) | |
| `bye` | `bye {reason}` |

**Files come in pieces, the phone asking for each.** One `get` is answered by one `chunk` of at most
`COMPANION_PIECE` (192 KB) from `off`; the phone asks for the next offset until `eof`
(`packages/companion/lib/pieces.ts`, BLG-106), writing a full picture to its cache as it comes
(`lib/sink.ts`) and showing the thumbnail meanwhile, with how far it is. A piece that doesn't come
in 20 s fails the fetch with words and Retry, never an endless spinner.

**Videos stream** (BLG-100, BLG-103). The link worklet runs a small HTTP server on the phone's
loopback (`127.0.0.1`, a random port and a random token in every URL;
`src/companion/media-stream.ts`), and the player (expo-video) plays from it. Each range request is
answered with pieces fetched over the link with the same `get {ref, 'full', off}`, so no protocol
change: only what the player reads is fetched, two pieces ahead and no faster than it takes them,
and what came is kept in a 48 MB cache (seeking back costs nothing). Nothing autoplays or loops; a
video plays only when tapped and pauses when you swipe away, leave or put the app away. MP4, M4V and
MOV play on both platforms, WebM on Android (iPhone says so); a codec the player lacks shows why.
Nothing is transcoded. The Mac makes a video's thumbnail from its first frame (Quick Look). Android
allows plain http only to 127.0.0.1 (`plugins/loopback-cleartext.js`), iOS only to local addresses
(`NSAllowsLocalNetworking`).

**Views, not state.** The Mac's shared state is several MB and full of things the phone mustn't
show. The phone never sees it: `src/companion/views.ts` turns it into small views per topic, each
already cut down for the phone (code stripped, steps in words, paths as opaque refs):

- `home`: the Mac (name, awake), your usage, what needs you, what's running now, unread counts, tasks
  waiting for your review (1.3), and Your Mac's summary (`assistant`, 1.5). Outputs aren't listed here any more (1.3: `outputs` is sent empty);
  each running conversation says how many it made since its latest run began (`fresh`).
- `work`: projects (with their icon's checksum, 1.3) and their conversations (title, status, last line):
  the chats and worktrees you started. A project's main checkout has no conversation of its own
  (BLG-70): one from before became an ordinary chat in its project, listed like any other, and
  `conv:ws:<main>` isn't a conversation the phone can send to. Your Mac isn't a project either.
  Every project of yours is listed, also one with no conversations yet (`conversations: []`, last;
  BLG-675): one just added with `beluga project add` is where the Ask sheet starts its first
  worktree. Chats (conversations outside any project) isn't a project and isn't listed. Older
  phones skipped projects with no conversations, so the change is additive.
- `conv:<channel>`: one conversation (`conv:mac:assistant` is Your Mac, 1.5): turns (your messages, your agent's answers), what a running turn
  is doing now (`live`: thinking, writing, the step with its tool, time and count) and its steps in
  words with their tools (`trail`), sub-agents (title, status, steps, their own live step, kind,
  outputs), everything its worktree made (`outputs`: scratch files, reports, its agent's and
  sub-agents' outputs, newest first), your queued messages (`queue`), where a merge started from the
  phone stands (`merge`), its pending question or approval.
- `plans` and `plan:<id>`: milestones, tasks and their status, decisions waiting. Since 1.5 a plan
  carries how it runs (`autonomy`, `paused`, `parallel`, `running`), each milestone what it waits on
  (`dependsOn`), each task its goal, acceptance, the tasks it waits on (`blockedBy`) and why.
- `tasks` and `task:<id>` (1.3): the board by project and status (key, title, priority, who has
  it); a task's goal, acceptance with ticks, activity, worktree and pull request, and where it may
  be moved. `tasks.others` (optional, BLG-109): the tasks the lists leave out (older done,
  canceled), by key, title and status only, so a task key in words is a live chip on the phone
  as on the Mac: `task:BLG-12` in inline code, a bare `BLG-12` the board has, `@BLG-12`, read by
  the Mac's own `linkTaskKeys` (src/shared/task-refs.ts). An older Mac leaves it out.

**Drawn blocks (1.3).** What your agent drew for the screen in an answer (a `beluga-view`: table,
chart, stats, code, colors; a `beluga-graph`; `beluga-tasks`) goes along with its code chip entry
(`code[n].block`, its JSON as written). The phone reads it with the Mac's own parsers and models
(`src/shared/view-spec.ts`, `graph-spec.ts`, `src/shared/render/`) and draws it natively. A view's
source never runs on the phone: `companion.viewFetch` names the view (conversation, turn, block) and
the Mac runs its source as `view.fetch` does for the window, only for your own agent's answers and
only sources the view names. Any other code still never leaves the Mac.

**Tables written as text (BLG-71).** The agent often draws a table as text: box characters
(`┌─┬─┐ │ ├─┼─┤`), a `+---+---+` grid, pipes over a rule, or columns lined up over dashes. The Mac
reads them (`src/shared/render/text-table.ts`, in `stripCode`), in the prose or as a fenced block
that is only a table, and sends each as a table view block (the spec Markdown tables make,
`md-table.ts` `tableSpec`), so the phone draws it with the same table as Markdown tables and views;
any phone since 1.3 reads it. One that only looks like a table goes as a `text` block (1.5), shown
monospaced and never wrapped, scrolling sideways. Changes keep their signs ("+4.9%").

**More blocks drawn (1.9, BLG-87).** `stripCode` also reads what a plain code block really is
(`src/shared/render/rich-fence.ts`): a file tree (├── └──) goes as a `tree` block, ```` ```json ````
as `json`, a shell session or command output as `terminal`, each as written, and the phone draws a
tree that folds, a colored JSON tree, a terminal with its colors. A ```` ```mermaid ```` diagram goes as
the `graph` or `view` it reads as (`mermaid.ts`), so any phone since 1.3 draws it. Math: display math
(`$$…$$`, `\[…\]`, ```` ```math ````) is a `math` block; inline math stays `$…$` in the words. The Mac
typesets both with MathJax (`src/companion/math-svg.ts`) into `ProseView.math`: SVG paths in
`currentColor`, sized in ex, which the phone draws with `react-native-svg`. Prices ("$5 and $10")
stay words (`src/shared/render/math.ts`). A phone before 1.9 shows a chip for the new kinds.

**Outputs and data on a small screen (BLG-71).** A turn's outputs are one strip that swipes
sideways: pictures as ~110 px thumbnails, text and logs as small cards (icon, name, size); a tap
opens the viewer, which swipes through that turn's outputs. Every table, chart, view and graph has
Expand: full screen, the one page of the app that turns sideways (`expo-screen-orientation`; the app
is otherwise kept upright). A table wider than the screen has a toggle by its row count: scroll
sideways, or cards (one per row, its columns as label and value).

**What came when.** A phone checks the Mac's minor (`welcome.v`, `SINCE` in protocol.ts) before it
subscribes to a newer topic or makes a newer call: an older Mac drops a whole `sub` frame that names a
topic it doesn't know. 1.7 brought a worktree's Files and Terminal (`SINCE.files`, `SINCE.terminal`).
1.8 brought a branch's every step from the phone (`SINCE.branchSteps`): the band at the top of a
worktree's conversation shows its state (Merged #7, Conflicts…), the step it needs next as a button
and the rest under Other Steps, the very steps of the Mac's toolbar (`BranchView.steps`), done with
`companion.branchStep`. Steps the agent does, and the ones that can't be undone, ask first; Merge into
the main folder keeps its sheet, and Open PR opens GitHub. That band is the one place for them: the
conversation's ••• doesn't repeat Merge. An older Mac's band only says the next step.
1.10 (BLG-110) brought a sub-agent opened on the phone (`SINCE.subAgent`): `companion.subAgent(topic,
turn, id)` → `SubAgentDetailView`, its whole activity in words (up to 200 steps, from your agent's
step records of the turn, else the transcript Claude Code keeps of it) and, once it ended, the report
it gave back, through `stripCode` like any answer of the agent's (never its prompt, its tools' input or
output, or a file). A sub-agent Claude Code still sees working stays `running` in the view though its
turn ended (one left working in the background). An older Mac's sheet shows the view's steps.
1.21 (BLG-237) brought Sentinel (`SINCE.sentinel`, docs/sentinel.md): `sentinels` (every sentinel,
its schedule in words, paused, its last run and next one) and `sentinel:<id>` (its steps by name,
its last 30 runs with each report as an output ref, and its run waiting for your Merge). Run Now,
Pause / Turn On and a run's report text are `sentinel.run` / `pause` / `runGet`; a merge waiting is
a `decision` with Merge and Not Now (`sentinel.decide`); a run that ended where the sentinel
notifies the phone is a `done` nudge collapsed as `sentinel:<id>`.
1.22 (BLG-244) brought numbers and dashboards (`SINCE.dashboard`, docs/sentinel.md §10):
`dashboard:<id>` (its tiles worked out on the Mac: a number with its change for every compare and a
sparkline, a chart's series, a table's first rows, a text tile's headline; paused or gone said
quietly; a Refresh going, "Fetching… 2 of 3"), and in `sentinels` the dashboards and the first
one's first three numbers for Home. Pull to refresh is `dashboard.refresh`; a number over time is
`sentinel.metricRead`. Tiles never carry a source, a query or a key.
1.23 (BLG-246) brought Sentinel's own dashboard and its chat (`SINCE.sentinelChat`, docs/sentinel.md
§10 and §12): tiles of kind `series` (numbers over time keep coming as `chart`, so an older phone
draws them; a kept array comes with its points' `labels`) and `output` (a step's latest export:
Markdown without its code, or JSON for a tree or a table), a tile's real size (`span`, `tall`;
`width` stays 1 to 3), the `draft` state, and in `sentinels` the Sentinel chat's open conversation
(`chat`), a `conv:sentinel-chat:<id>` topic the phone writes and answers in as any conversation. A
delete the agent asks for there is an `approval` like any other.
1.24 (BLG-322) brought New Task from one message (`SINCE.severalTasks`): `companion.draftTask`
with `several` drafts every task the words ask for (`more`, under the first when `epic`), each with
the teammate it names (`for`); `companion.addTask` with them adds them all and answers their keys
(`more`). An older Mac never gets `several`, so it drafts one task as before.
1.26 (BLG-361) brought the Home-screen widgets (`SINCE.widgets`, docs/sentinel.md "On the phone's
Home screen"): `widgets`, every board tile in words as the Mac's desktop widgets read them (a number
with its change and points, a chart's points, an output, a table or a headline as text; its project,
tint and icon checksum). The Android app watches it while open, and while away with Stay connected
when a widget is placed. Never a source, a query or a key.
1.27 (BLG-354) lets the phone remove a request you asked of a friend (`gateway.forget`, cancelled
first while it's still going) and dismiss a needs-you item without answering it (`needs.dismiss`,
gone on the Mac too). An older Mac never gets either: Remove isn't offered, and a dismissed card
is only hidden on the phone until it relinks.
1.28 (BLG-387) lets the phone edit a message you sent (`TurnView.edit`, `workspaces.editPrompt`):
long-press it, change it, then Rewind Here (the conversation goes back to it, a worktree's files too)
or New Fork (a new worktree or chat from that point). Only messages whose words reach the phone whole
(no code in them). An older Mac sends no `edit`, so Edit isn't offered.
1.29 (BLG-386, BLG-392) draws a board table's typed cells on the phone and opens what they point
to: each document or storage object comes as a ref (`table.typed[].docs`) the phone streams with
`get`, read (or fetched through a link signed on the Mac) only when asked and kept nowhere; a
sentinel's kept data (`sentinel.dataList`) lists its metrics' histories (CSV, made when fetched) and
its runs' files the same way. A kind the phone can't show offers Open on your Mac
(`sentinel.documentOpen`, `sentinel.storageOpen`, `sentinel.runFileOpen`). An older Mac sends no
refs, so its cells stay plain text and Kept data isn't shown.
1.30 (BLG-429) lets the phone change a direct chat as the Mac does (BLG-425): long-press a message to
Delete it (yours: for your friend too) or Edit your own (`network.messages.delete`, `network.messages.edit`;
only one whose words reach the phone whole, `ChatMessageView.editable`), and Clear chat from the
chat's ••• (`network.clear`, on the Mac only: your friend keeps theirs). An older Mac offers none of them.
1.31 (BLG-500): boards and repos are many to many. `TasksView.projects` are boards (a repo's own, or one
covering several), a task on a board of several says which repo it runs in (`TaskSummary.repo`), and
`companion.draftTask` / `addTask` take a board's id too.
1.32 (BLG-446) gives the phone the composer's agent picker: a conversation's ••• › Agent opens runtimes as
groups with their models (`ConvView.agent`), your default agent first, one your Mac doesn't run greyed with
what's missing. The list is the models turned on in Settings › Agent › Models in chat (with none chosen, every
model). A model of the same runtime is `workbench.setModel`; another runtime, `workbench.setAgent`. Effort stays
on the Mac.
1.41 (BLG-702) brings emoji reactions to the phone's chats (`SINCE.reactions`): each message's
`reactions` (emoji, count, whether one is yours, who) as chips under it (a tap adds yours or takes it
back, a long-press says who), and long-press on a message opens its sheet with your quick row
(`ChatView.quick`, the six you use most) on top (`network.messages.react`). The room's and workspaces'
chats do the same on a person's turn (`TurnView.reactions`, `reactable`, `ConvView.quick`,
`session.react`). An older Mac sends neither, and long-press stays as it was.
1.44 (BLG-172) brings child threads to the phone (`SINCE.threads`). With Agent threads on, each row of
Work shows its chat's harness mark and a child sits under its parent (`ConvSummary.harness`, `parent`;
a kept child, or one whose parent is gone, is a row of its own). A chat's ••• › Threads opens its parent
and children with their live state, and Stop on each one at work (`ConvView.threadFamily`, `threads.stop`, `threads.stopAll`):
the Mac's own stop, so those under it stop too. The sheet carries titles and states only, never a
thread's task or result. Its native sub-agents share the list as read-only rows (`ThreadFamilyView.agents`,
`SINCE.threadAgents`): the chat's harness mark, a quiet "sub-agent" word, no Stop and no page of their own
(their steps stay on the conversation's strip); one "N running" counts both kinds. An older Mac leaves them
out: the sheet lists threads only. A need in a child names
it (`NeedsYou.thread`). Archive and Delete ask once about a chat's threads, with the Mac's defaults:
archive takes them, delete keeps them (`BranchView.threads`, and the third argument of
`companion.branchStep`, `with` or `keep`). The phone sends that argument only to a Mac with
`SINCE.threads`, because an older Mac refuses an argument it doesn't know. An older Mac sends none of the
fields: flat rows, no Threads sheet, no question, and its children stay. An older phone sends no answer to a
newer Mac: children stay there too.
- `chats` and `chat:<conversation>`: friends' DMs and channels.
- `people`: friends, presence, their usage and what they let your agent do.

A view is sent whole when it changes (by a hash), at most every 500 ms per topic: whole views are
simpler than patches and can't drift. A conversation view carries its last 40 turns; older ones come
with `call companion.older`.

**Files** travel only as refs the Mac handed out in a view (`out:<random>`), resolved on the Mac,
checked again with `isArtifact` and `isSecretPath` before a byte is read. Images come first as a
thumbnail (longest side 640 px, JPEG, made with `sips` and cached), the full image only when you open
it. Text comes as text (the first 256 KB, then more as you scroll; logs that grow follow their tail).
Everything is cached on the phone by checksum, so nothing is fetched twice.

**Calls.** The phone calls the daemon's own API (`src/ipc/api.ts`), validated by the same zod
schemas, through one allowlist: `src/companion/coverage.ts` classifies **every** API method as
`phone` or `mac`. Anything `mac` (git, the Mac's own `terminals.*` and `files.*`, editing,
settings…) is refused before it is parsed; a worktree's files and terminals reach the phone only
through `companion.files.*` and `companion.terminals` / `termOpen` / `termClose`. The type is `Record<Method, …>`, so a new API method doesn't compile until someone decides.

**Asking from the phone** (`src/ipc/companion-api.ts`, all `phone`):

- `companion.ask {target: {project} | {topic}, text, files?}` → `{topic}`: a question in a project
  (what New Chat does on the Mac, then `session.submit`) or a message in a conversation you can
  write in (Your Mac too: `{topic: 'conv:mac:assistant'}`). `files` are `up:` refs from `put` (25 MB a file, 10 a message): pictures go where
  pasted images go (`attachments.ts`, made smaller if they're too big for the agent), other files are
  named by their path in `~/.beluga/attachments/phone`. A ref works only for the phone that sent it.
- `companion.post {conversation, text, files?, ask?}`: a friends' chat message, files taken in as
  chat files.
- `companion.askPerson {peerId, text, needs?, project?}` → `{topic, task}`: a friend's agent, as
  from their card on the Mac (`gateway.ask`; their approval and trust rules apply). It reads as the
  conversation `conv:task:<id>`: what you asked, their agent's steps and answer, its files.
- `companion.signOut`: the calling phone's own certificate goes (never another's), its link closes.
- `companion.openOnMac {topic | need}` (1.3): every screen is told where to go (a navigate intent)
  and the Mac app's window comes to the front (its `raise` capability) → `{opened, why?}`.
- `companion.icon(sum)` (1.3): a project's icon, a PNG of at most 128 px (or a small SVG), by the
  checksum views carry; the phone keeps it by that checksum.
- `companion.mergeCheck` / `merge` / `resolve` (1.3): a worktree's merge, the Mac's own way (the
  Merge sheet's checks, the controller's merge, Solve merge conflict), followed in its `merge`.
- `companion.draftTask` / `addTask` (1.3): a task described in words, the agent's draft shown first.
- `companion.viewFetch` (1.3): a live view's rows (above).
- `workspaces.startWorktree(project, text, {plan?, quiet: true})` → the worktree's id, and
  `plans.create({projectId, goal})` → the plan (1.5): the Ask sheet's Worktree and Plan, the same
  calls as the Mac's project home (`plan`: Plan first, the Mac's Plan mode, on in it before the agent
  reads your words). A phone checks `SINCE.askModes` first; an older Mac gets a question.
- Also `phone` since 1.3: `board.move` and `board.start` (a task moved along, or started in a new
  worktree with your agent), and `session.submit` with `urgent` (Steer) next to `host.promote` and
  `host.cancelQueued` for the queue.
- `companion.voice` / `voicePrepare(model)` / `transcribe {audio, model, language, prompt?}` (1.16,
  BLG-140): the Mac writes down what you said on the phone, one phrase at a time (BLG-160: the phone
  cuts the recording at your pauses, `src/shared/voice-phrases.ts`, and sends each as it's cut, with
  the words before it as Whisper's `prompt`). The phone `put`s a 16 kHz mono WAV (`audio/wav`, only
  that phone's ref); the Mac runs Whisper Turbo or Parakeet v3 on its GPU (whisper.cpp through
  `@fugood/whisper.node`, `src/core/voice.ts`, one model loaded for the phone and the Mac app),
  deletes the recording and answers `{text, language?, ms}`. Models (`src/shared/voice-models.ts`)
  come once, into `~/.beluga/voice`, the first time they're asked for; until one is here,
  `transcribe` starts it and says how far it is, and the phone writes it down itself.

**Answering.** Every needs-you item carries its buttons as calls (`actions`), and, when it takes
picks or words, an `answer` template: call `method` with `args` after putting the answer at
`slot` (a path into the args; several picks joined with `join`). Your agent's questions use
`questions.pick` for the earlier questions of a prompt and `questions.answer` for the last; a
friend's agent's question `gateway.answer`; a milestone sent back `plans.sendBack`. Someone at the
door with your link: `invites.letIn` / `invites.decline`; someone asking to join a channel you
run: `network.groups.approve` / `decline`. Nothing appears without a way to answer it.

**Typed calls.** `src/companion/calls.ts` `PhoneCalls`: every `phone` method with its argument
tuple (the API's own zod) and its result; the app imports it rather than keeping a list.

## Files and Terminal (BLG-42)

A worktree's ••• menu has **Files** and **Terminal** next to Outputs (1.7, `SINCE.files`
and `SINCE.terminal`: a Mac too old just doesn't offer them).

**Files, read-only.** `companion.files.list(topic, path)` → a folder (folders first, pictures with a
`ref` for the image viewer), `companion.files.find(topic, query)` → names that match anywhere in the
worktree, `companion.files.read(topic, path, {off})` → a page of a file (512 KB of whole lines, its
language for colours). Everything goes through the companion's file gate
(`src/companion/worktree-files.ts`): the path stays inside that worktree (no absolute paths, no
`..`, nothing in `.git`); links are followed and where they really lead is checked again (out of
the worktree, or onto a secret under another name: refused, and not listed); `isSecretPath` (dotenv
files, keys, credential stores, Beluga's own files) is refused by name and by real path; secrets a
file holds are redacted as logs are. On the phone: a folder browser (breadcrumbs, folder and file
icons, search by name) and a viewer (monospace, line numbers, colours by language from a cheap
per-line tokenizer, wrap, find). There is no way to change a file. The agent's answers still go
through `stripCode`.

**Terminal, shared with the Mac.** The daemon runs one PTY per terminal (`src/terminal/pty-host.ts`);
the Mac app attaches to it over its local socket (`term_*` frames, `src/daemon/server.ts`), the
phone over the companion link (`src/companion/terminals.ts`). It's the very same session: both see
the same output live, and either can type.

- `companion.terminals(topic)` lists a worktree's terminals (its shell, setup and run, and shells
  started in its folder); `companion.termOpen(topic, {key? | fresh?})` opens one, its shell (started
  as the Mac's dock starts it, `terminals.shell`) or a new shell in its folder (`terminals.global`);
  `companion.termClose(key)` ends it for every screen (the phone asks first). Then `term_attach`,
  `term_input`, `term_detach` frames. Only terminals of your worktrees, never another of the Mac's
  shells by key.
- **Size: the Mac's.** The session keeps the Mac's grid (`cols × rows`, told in `term_status`, again
  when the Mac resizes it). The phone never resizes it: with two screens on one PTY the last resize
  wins, and the Mac's terminal would reflow under you each time you looked from the phone. The phone
  draws that grid at a readable text size (13 px by default, BLG-108) and pans over what's wider or
  taller than the screen; a pinch or ••• › A−/A+ sets the size (8–24 px), ••• › Fit draws the whole
  width instead, and the choice is remembered (`lib/terminal/zoom.ts`). One finger pans, then
  scrolls back; output keeps the cursor in view.
- **Drawn by xterm.js in a WebView** (`react-native-webview`, an iframe in the web build), bundled
  with the app (`lib/terminal/xterm.generated.ts`, `npm run terminal:bundle`), in JetBrains Mono
  (OFL, Latin subsets inline as `lib/terminal/font.generated.ts`, no ligatures) and xterm's WebGL
  renderer (`@xterm/addon-webgl`, in the same bundle), which draws box drawing, blocks and braille
  itself, lined up to the cell; without WebGL the DOM renderer draws. No CDN, nothing fetched. Raw PTY bytes go in, so colours, cursor moves and full-screen programs draw as on the Mac.
  The page drops xterm's answers to the program's own queries (cursor position, device
  attributes): the Mac's screen answers those, once.
- **Keys.** A key bar above the keyboard: Esc, Tab, Ctrl (for the next key), ↑ ↓ ← → (in the
  program's cursor mode), |, ~, / and paste. No "Mac is typing": both just show.
- **Battery.** Output is coalesced on the Mac to one frame per ~33 ms, and streams only while the
  terminal screen is open: leaving it detaches, and the app going to the background (`focus
  {on: false}`) stops every stream; coming back attaches again and draws the screen afresh.
- **Safety.** This is running commands from the phone. It's allowed because it's your own paired
  device (the firewall, the pinned keys, the certificate you issued and can revoke), and it's
  logged on the Mac: which phone opened, started or closed which terminal, and how many characters
  it typed, never what.

## Any network

Kayra's dorm Wi-Fi put the phone and the Mac behind one public IP with client isolation: the DHT
lookup worked, the peer connection didn't. So the phone tries every way, quickly, and remembers
which one worked (`src/companion/dial.ts`):

| Way | How | Path shown |
|---|---|---|
| hyperdht | LAN address first when both share a public IP, then hole-punching | `lan` or `direct` |
| Relay | A WebSocket to the Mac's Cloudflare quick tunnel, Noise inside | `relay` |

- **Raced, not queued.** The way that worked last time on this network (kept per local subnet,
  `link-hints` in the app's storage) starts at once; the other starts 1.5 s later, or as soon as the
  first one fails. The first Noise handshake that opens with the Mac's key wins; the other is dropped.
- **The relay keeps end-to-end security.** The Mac's relay server (`src/companion/relay.ts`) listens
  on 127.0.0.1 and takes WebSockets at `/companion/<key>`; cloudflared (as rooms use it) makes it
  `wss://<name>.trycloudflare.com/companion`. Inside the socket runs the same Noise handshake as
  over hyperdht (secret-stream over the socket), the Mac answering as the key the phone dialed (its
  companion key, or an open pairing's). Both keys stay pinned, the frames, proofs and firewall are
  the same, and Cloudflare carries ciphertext only (`tests/companion-relay.test.ts` checks a tapping
  relay never sees plaintext). A removed phone is told 4010 inside the link, as over hyperdht.
- **Finding the relay.** Its URL changes whenever cloudflared restarts, so the Mac publishes it as
  a signed mutable record on the DHT (`RelayRecord`, hyperdht `mutablePut`) under its companion
  key and under each open pairing's keys, again every 10 minutes (`src/companion/reach.ts`). Pairing
  links carry it too (`beluga://device#<secret>?r=<url>`), so a QR works even where the DHT doesn't;
  a typed code finds it through the record. Each welcome says the current one; the phone keeps the
  last three.
- **A tunnel that's gone is replaced.** Cloudflare drops a quick tunnel's name when the Mac sleeps
  long enough, while cloudflared keeps running, so the Mac would keep handing out a dead URL (BLG-126).
  Every tunnel's public URL is checked each minute and right after a wake (the clock jumped); two
  misses while Cloudflare itself answers kill it, and a fresh one (a new name, a new record) opens
  30 s later. Offline isn't counted. Rooms' fallback relays come back the same way.
- **On the phone**, Bare has no WebSocket, so the worklet asks the app's (React Native's, with the
  OS's TLS) through its IPC and passes ciphertext both ways in base64.
- **Only while needed.** The relay server and its tunnel run only while a phone is paired or a
  pairing is open, and not at all with Remote access set to direct only (`p2p`) or `none`, or in the demo.
- **Your computers, by themselves (BLG-809).** Your Mac tells its phones where each of your
  computers is (the `computers` frame, 1.46: companion address and relays), after the welcome and
  whenever one joins, moves or is renamed. The phone keeps that list and links to each computer
  itself, with the same certificate and keys, dialed the same three ways: no second pairing, no Mac
  in the middle, so it works while the Mac sleeps. Each computer lets in the phones of your device
  set through its phone door, with the phone table's limits (`src/companion/coverage.ts`), and names
  them in its relay record; a phone forgotten anywhere is cut off there (`src/machines/phones.ts`,
  `packages/companion/lib/link/computers.ts`). Those links open and close with the Mac's.
- **Their work on the phone (BLG-810).** Work lists each computer under Your Computers, with its
  icon, name and one line (what it has free, or offline since when the phone last reached it,
  greyed); its conversations open over its own link (`?on=<id>`, `lib/scope.ts`), read-only from
  the phone's cache while it's away. Needs You merges every computer's, each saying which, and an
  answer goes back to that computer. New Task has one row, Runs on This Mac ›, whose sheet lists
  your computers with the same line as the Mac's menu (`src/machines/words.ts`); picking one lists
  its projects and starts the work there. Pictures, files, terminals and merges in a computer's
  conversation stay on that computer for now.
- **Friends with your Mac closed (BLG-850).** Your Always On runs your friends network, so while
  the Mac's link is down the phone's People, Chats and chat screens read from the Always On's link,
  and `network.*` calls (send, read, approve) go there; with the Mac back they go to the Mac again.
  A friend's new message is a `mentions` nudge on its chat (`newMessages`, `src/companion/push.ts`),
  told only by the install that runs the network: a Mac that only shows your Always On's network
  doesn't also tell a phone that links there, so one message is one notification. With Stay
  connected on, the Always On's link stays open while the app is away, so those nudges notify with
  the Mac closed. A push token sent on that link is kept there (`phone-push.json`) for Beluga Push.
  An older phone, linked only to the Mac, hears them from the Mac as before.

## When it can't connect

The phone says what's wrong in plain words and what to do; a "Why?" sheet holds the detail (what
was tried, how each went) and Try again (`src/companion/diagnose.ts`, shared with the Mac). Before
blaming anything else it checks the phone is online at all (one look, only after a failure).

| Problem | Said |
|---|---|
| `offline` | This phone is offline |
| `dht-blocked` | This network blocks Beluga's connection (UDP blocked, and no relay) |
| `relay-down` | Reconnecting to your Mac…: it's online, this network blocks a direct connection, and its relay is restarting. The banner stays and says "Trying again by itself" |
| `no-path` | Your Mac is there, but this network won't connect you: try mobile data |
| `mac-offline` | Your Mac isn't online: asleep, Beluga closed, or its network off |
| `pairing-gone`, `pairing-wrong`, `pairing-busy`, `pairing-full` | The pairing closed, ran out, was used; the code was off; another phone is pairing; 4 phones already |
| `update-mac`, `update-app` | Whose update would fix it |
| `removed` | This phone was removed: pair it again. Learned from the close code (4010) while linked, or, once the Mac has let it go, from its relay record: under the companion key it names its phones (`RelayRecord.phones`, each link key's first 16 hex) and is put once more, naming none, when the last one goes. The banner's button becomes Pair again |

Pairing refusals carry a `why` for this (`dev_refused`), and the phone's `hello` says how it came
(`via {path, tried}`), so the Mac's Settings › Phone and the footer popover can say "Your phone found
this Mac but couldn't connect directly on its network, so it used the relay." The phone's
Settings › Advanced shows "Connected directly · same network / over the internet" or "Connected
through the relay (end-to-end encrypted)". Raw codes never reach the surface.

On the Mac, Settings › Phone › Reaching your Mac says whether phones on other networks get through
(`companion.relay`: ready, starting, off), and the footer popover says so when it isn't ready.

## Keeping your Mac awake

A sleeping Mac can't be reached, and it can't be woken over the internet (Wake-on-LAN needs the same
network, and isolating Wi-Fi drops it). So Settings › Phone › Keep this Mac awake (Never, On power,
Always; the phone's Settings › Advanced has the same, `companion.keepAwake`, since 1.13) keeps it
from sleeping while a phone is paired: `caffeinate -s` (on power) or `-i`, tied to the daemon's pid
(`src/companion/awake.ts`). The display still sleeps, and closing a laptop's lid still sleeps it.

## Battery

The phone holds no connection it isn't using (unless you turn on Stay connected, below).

- **Open only while you look.** The worklet dials when the app comes to the front and closes 15 s
  after it goes to the background (the grace covers a quick app switch). Then the DHT node is
  destroyed: no UDP, no keepalives, no wakeups. Coming back is about one second (the DHT lookup and
  the handshake; the Mac's last direct address is tried first, and on the same Wi-Fi hyperdht
  connects over the LAN).
- **Coming back checks the link (BLG-105).** Android stops the app's timers in the background, so
  the grace may never fire there and the process is frozen with the link "open". Back in front
  (AppState, or a link or notification opening it), the phone goes by the clock
  (`packages/companion/lib/link/resume.ts`): away past the grace, the link is replaced at once;
  otherwise one ping (3 s) checks it, and a link that doesn't answer is replaced. A dial under way
  is left alone (one at a time). A link that drops while you look is dialed again by itself, after
  1, 2, 4… up to 30 s, then every 30 s for as long as the app is in front (BLG-126: the Mac may be
  restarting its relay, and it should just come back); never in the background.
- **The relay costs nothing extra.** It's one more way to open the same link, open only while the
  app is in front and closed with it; the keepalives and views over it are the same. The phone
  never holds a relay socket in the background.
- **Quiet while open.** One keepalive every 20 s (UDP NAT mappings on mobile networks last about
  30 s). The Mac only sends the topics on screen, coalesced to one view per 500 ms; nothing is
  streamed character by character. Thumbnails before full images, cached by checksum.
- **No polling, ever.** When the app is closed it learns things only from push.
- **Push wakes it, briefly.** Something that needs you is a high-priority push; anything else is
  normal priority with a collapse key, so Android batches it and never wakes the radio for it.
  Approve or reply from the notification opens the link headless, makes one call and closes it again
  (a few seconds of radio).
- **The Mac decides when to push.** Only when you're not at the Mac (its idle time over 2 minutes,
  or the screen locked or asleep), and never for what you're already looking at on the phone. While
  linked, the Mac sends a `nudge` in-band instead.

## Staying connected

Beluga Push isn't built yet, so with the app closed nothing can reach the phone. Stay connected
(Settings, Android only, off by default; BLG-128) is the way that needs no server:

- **A foreground service** (`packages/companion/modules/stay-connected`, a local Expo module, type
  `remoteMessaging`) keeps the app's process, and with it the worklet's link, running with the
  screen off. A partial wake lock keeps the 20 s heartbeat beating (as ntfy does). Its notification
  is quiet and ongoing ("Connected to your Mac" / "Reconnecting to your Mac…"), since Android
  requires one. It starts only while the app is in front (Android refuses it otherwise) and stops
  when the app is swiped away, you turn it off, or you sign out.
- **Away, the link carries almost nothing.** The phone sends `focus: false` and subscribes to no
  topic, so the Mac sends no views; only pings and `nudge`s. Back in front, the link is checked
  with one ping (not replaced for having been away) and the screen's topics come back.
- **What notifies.** Needs you, the runs you asked from the phone, and, for a phone away with the
  link open, every run of yours that finishes or stops (the Mac's own "… finished in …"
  notices, `Nudge.away`, never pushed). Each nudge becomes a notification in its channel, as set in
  Notify me about; tapping it opens its conversation.
- **A slower heartbeat while away.** Over the relay (TCP; Cloudflare drops a socket idle for 100 s)
  or the same Wi-Fi (no NAT) the phone pings every 50 s instead of 20 (`KEEPALIVE_AWAY_MS`), and a
  Mac with `SINCE.awayBeat` (1.13) waits three of those before it calls the phone gone. A
  hole-punched link keeps 20 s: mobile NATs forget a UDP mapping in about 30.
- **Dropped links come back by themselves:** quickly at first, then every two minutes while away.
- **Battery.** Asking Android to leave Beluga unrestricted (Settings shows a row until it is),
  since its battery saver may otherwise cut the link off.

## Notifications: Beluga Push

Android needs Firebase Cloud Messaging (and iOS needs APNs) to wake an app; both need a server
holding credentials. Beluga Push is that server and nothing more: a stateless relay (a Cloudflare
Worker), so the peer-to-peer design holds.

- The phone registers its FCM token with the relay and gets a `relayKey`; it gives the Mac
  `{token, relayKey}` over the link. Only someone holding the key can push to that phone.
- The Mac seals each notification to the phone's box key (`sealTo`, X25519 + AES-256-GCM) and posts
  `{token, sealed, priority, collapse}` signed with the relay key. The relay sees a token and
  ciphertext; FCM sees ciphertext; the phone opens it (an FCM data message, decoded in the app; on
  iOS a Notification Service Extension).
- Without the relay (not set up, or you turn it off), the app works the same while open; it just
  can't tell you anything while closed.

What notifies (each can be turned off on the phone): **Needs you** (approvals, your agent's questions,
friends' requests, plan decisions: with Approve / Decline or a reply right on the notification),
**Done** (a conversation you asked from the phone finished), **Mentions** (friends' chats).

## Using it: the screens

Small screen, thumbs, one hand. Friendly and calm: soft pastels (sky, mint, peach, lavender,
butter; rose for danger) as tinted backgrounds behind icons and chips, never glows or neon. Light
and dark themes follow the phone's own setting, or what you pick in Settings › Appearance
(System, Light or Dark). Dark is the Mac app's own dark grey (`#1e1e21`, cards `#2a2a2e`), not black, with the same
pastels toned down. Both themes take their neutrals from `packages/mac/src/styles/tokens.css`. Rounded cards, generous space, and icons everywhere (one rounded
set, an icon in a tinted circle for every row, tab and kind), with one word rather than a sentence.
Motion is smooth and purposeful: springs, shared transitions and haptics when something is
committed, and no decorative loops.

**The surface stays simple.** Each screen shows only its main action. Everything else is one tap
away, always in the same place: the ••• button or a long press opens a sheet (Always allow,
details, Open on your Mac, the model and project in Ask). Settings has the basics on top and
Advanced at the bottom. Learn it once and it works everywhere.

- **Home**: your Mac at the top (a small status dot: linked, away, asleep), and your allowance as
  two soft progress bars (5 hours and week, each with its percentage and reset time). Then **Needs you** as a
  stack of cards: swipe right to approve, left to decline, tap to read it whole, long-press for
  Always. Then **Running now**: each live conversation as a card with its project's icon, its step
  ticking over, its sub-agents as dots and a small count of new outputs. Then tasks **for your
  review**.
- **Work**: Conversations · Plans · Tasks. While Settings on the Mac has chat categories on, Conversations
  shows the Inbox by project, then Working, Later and Settled, folded. Long-press a chat for Settle, Remind Me
  Later, Show Again Now or Un-settle. The phone never changes the setting, and a question in a chat put off
  till later stays in Needs you.
  A conversation reads as cards: your message, the agent's
  answer (code folded into chips; views and graphs drawn), and while it works a live panel: thinking
  or writing with a soft shimmer, the step it's on with its tool, time and progress, the steps
  before it sliding in. Sub-agents are rows in the turn that started them, with their own live step
  and how long they've been at it; while any works, a strip under the header says "3 agents · 2
  running" with a chip each, wherever their turn has scrolled to. Tap one for a sheet with what it's
  doing now, its activity, the report it gave back and its outputs (BLG-110). The composer's field
  takes the width and grows to seven lines; its photo button is always there (photos go along as
  `companion.ask` files). While the agent works its one round button queues (after) and a long-press
  offers Steer (now, words only); what's queued sits above it. The header's outputs button (and ••• › Outputs) shows everything the
  worktree made; ••• › Merge… checks, merges and gets conflicts resolved; ••• › Files reads the
  worktree's files and ••• › Terminal is its terminal, shared with the Mac (BLG-42). Images open full screen from where they are (shared
  transition): pinch, swipe between them, swipe down to put back; GIFs animate. Videos show their
  first frame with a play mark and stream when tapped, with the platform's controls (play, pause,
  seek, full screen); Done gives the swipes back. Text files open in a reader with
  search, wrap and "follow" for logs.
- **The Ask button** (in the middle of the tab bar, always there): "Ask your Mac…" with where it goes
  as one pill: **Your Mac** first and by default (a laptop), then a project, an open conversation,
  or a friend's agent. A project offers three icon chips, as the Mac's project home: **Worktree**
  (the default: a new worktree with your agent on your words, then it opens), **Advanced plan**
  (Beluga's Plans, `plans.create`: the agent drafts milestones, tasks and what waits on what; the draft
  opens to approve) and **Question** (a read-only chat in its main folder). **Plan first** beside
  Worktree is Claude Code's plan mode (it proposes before it acts), nothing to do with Advanced plans. Attach a photo
  or a file from the phone. The answer comes back into that conversation, with a notification if you
  left. The **microphone** beside Send (here and in a conversation's box)
  speaks instead of typing (`lib/voice.ts`, `lib/voice-session.ts`): each pause of three seconds cuts
  a phrase that's written down at once while you go on (a pause never stops the recording) (up to two minutes), so the words are ready when you stop.
  **■** puts them in the field to edit; **↑** sends them as you said them once the last phrase is
  written (the conversation opens with it). While it records, the stage takes the field's place (`components/Voice.tsx`), in the field's own type:
  a liquid pastel blob (metaballs, `components/Metaballs.tsx`, drawn on the UI thread) that swells
  and stretches with your voice and pinches a droplet off at each pause, the words arriving phrase
  by phrase, a shimmering pill where one is still being written, a light tick at each pause. Where and by which model is
  **Settings › Voice** (BLG-142): four presets (Quick or Best on this phone: Whisper Base 57 MB,
  Whisper Turbo 547 MB; Best or Fastest on your Mac: Whisper Turbo, Parakeet), the one Beluga
  suggests marked and chosen until you pick another (your Mac when it can; Parakeet there only for
  English, since it has no Turkish; without the Mac, Turbo on a phone with 8 GB or more), the
  language, and under Choose it yourself your own where and model and the models on the phone and
  the Mac. A phone model comes once, the first time it's needed. With the Mac away, too old or still
  getting its model, the phone writes the rest down itself and says so. The web build speaks
  through the Mac only (the browser's microphone; the demo Mac answers with sample lines).
- **Plans** (in Work and on Home when one runs): milestones as a vertical timeline (each says what it
  runs after), tasks as rows with their state and what they wait on (tap one for its goal and what
  done means), decisions as cards with their buttons (Approve or Discard a draft, pass a milestone's
  gate), how many run side by side, and how it runs as one chip (Step by Step, Check-ins, Autopilot:
  `plans.setAutonomy`).
- **Chats**: your friends' DMs and channels, as on the Mac, with photos and files both ways and
  Ask your agent. A task between you and a friend's agent shows as a small card there (`ChatMessageView.task`:
  who asks whom, where it is, the result's summary and files; BLG-208); a phone too old for it shows the
  message's words.
- **People**: friends, their presence and allowance; tap one for Message, Ask their agent, Take a
  screenshot of their desktop.

Everything has a state for "your Mac is asleep": the last views stay (cached on the phone, marked
"as of 10:42"), actions wait in a small outbox and go when the Mac answers (or you discard them).

**What you send shows at once; the Mac confirms it** (`packages/companion/lib/sends.ts`). A message
in a conversation or chat is drawn as yours straight away ("Sending…"). It counts as sent only when
the Mac answers the call, and its bubble goes only when the Mac's view has the message, so it is never
missing in between. A refusal leaves it "Not sent" with Retry and Remove, your words kept. If the link
drops before the answer, it says "Checking…" until the Mac's next view shows whether it arrived. A
start from Ask (a new worktree, a plan, a question, a friend's agent) closes the sheet and opens its
Starting screen at once. That screen becomes the conversation or the plan when the Mac answers, or
goes back to Ask with your words and the reason. While the Mac is away, sends wait (kept across
launches) and go when it answers. `workspaces.startWorktree` answers once the worktree is made; the
model's name for it follows (the id stays).

## Your Mac (BLG-47)

One conversation with your own agent for the whole Mac, not one project or worktree: "Take a
screenshot and send it to me", "What's using my CPU?", "Start a worktree in beluga for the login
bug", "Open a task to fix X". The same conversation on both screens: the Ask sheet's first target
and Home's compact **Ask your Mac** row on the phone (`conv:mac:assistant`, live steps, Steer and
Queue, outputs, as any conversation), the sidebar's top row on the Mac (the `assistant` view).

- **Its chats (BLG-102).** Several at once, tabs on its page on the Mac: + starts one, × deletes
  one for good after asking (its messages here and on the phone, its folder, its agent's transcript;
  there's no archive; deleting the last leaves a fresh one). Each is its own conversation: the first
  keeps `conv:mac:assistant`, the others are `conv:mac:assistant:<id>` (`isMacTopic`). The tab open
  on the Mac is Home's `assistant` (its topic), so Ask your Mac talks to it; the others are listed
  by name ("Your Mac · …") wherever conversations are (working now, what needs you). An older
  phone, knowing only `conv:mac:assistant`, reaches the open chat once the first one is deleted
  (`phoneChannel`), and a message it sends there brings the first chat back as a tab.
- **Its chats on the phone (1.14, `SINCE.macChats`).** Home's `macChats` lists every chat in tab
  order, each titled by its tab. Ask your Mac's chats button (or a long-press) and the chats button
  in a Your Mac conversation open the list: New chat on top (`assistant.newChat`, a new tab on the
  Mac too, opened on the phone), a chat to switch to, a long-press to delete one for good after
  asking (`assistant.deleteChat`; also under •••). Opening a chat on the phone doesn't move the
  Mac's open tab (`assistant.openChat` stays the Mac's).
- **Where it runs.** `~/.beluga/assistant/work/` is its agent's folder, shared by its chats; its
  scratch folder is `work/.beluga/scratch/`. Each chat's agent session id and history sit beside
  it (`chats/<id>/state.json`, `history.json`; `chats.json` lists them in tab order with the one
  open). The one chat from before BLG-102 (`state.json`, `history.json`) moves into `chats/main/`
  on the first start. Everything in Beluga's home is secret to the phone (`isSecretPath`) except the folders
  the agent works in (`workspaces`, `chats`, `tasks/work`…): `assistant/work` joins them, narrowly, the
  way friends' tasks' `tasks/work` did, and nothing beside it does. Credentials are secret anywhere,
  so a `.env` in it still never leaves. Outside the home (`~/Beluga Assistant`) would have put a
  folder in your home you didn't make; inside, it's with Beluga's own and goes with it.
- **Whose agent.** Yours, with your approvals as anywhere (commands ask unless you set never);
  edits only in its own folder go without asking. Nobody else can write in it.
- **Its tools** (`src/agent/mac-tools.ts`, server `beluga_mac`): `screenshot` (the main display or
  an app's window, with the gateway's `captureScreen`: saved in its scratch folder, so it reaches
  the phone as an output, and the agent sees a smaller copy; macOS's Screen Recording permission still
  applies), `device_info` (the gateway's), `list_work` (projects, worktrees and chats with ids, what
  runs, plans), `start_worktree` (a project, a first message, plan first), `start_task` (a board
  task in its own worktree), `start_plan`, `archive_worktree` (BLG-565: a worktree by id or name, the
  same lossless archive as the Mac's; one with Claude still working waits until you say yes); and the board's tools (`task_create` in a named project,
  `task_update`…). Starting is quiet: the Mac's window stays where it is.
- **Links.** What it starts it names as `worktree:<id>`, `task:<KEY>` or `plan:<id>` in inline code;
  both screens draw a pill that opens it (`src/shared/render/inline-model.ts`).
- **Versions.** 1.5 (`SINCE.assistant`): an older Mac never gets the topic subscribed, and the Ask
  sheet doesn't offer Your Mac.

## Your phone, from your Mac (BLG-150)

The other direction: ask your agent on the Mac to do something on your *own* paired Android phone —
look at the screen, tap, type, open apps, install a build, read logs, debug. Only your own phone,
only your own runs; never a friend's agent, never a guest. Off by default.

- **Routes, best first** (`src/companion/phone-control.ts`, `PhoneControl.reach`). USB; Wireless
  debugging carried through the Beluga link (from any network, and the only way it's reached, BLG-187);
  or, when debugging is off, the app's **Accessibility service**. Each tool picks the best route it
  has; the ones that need adb (shell, logs, install) say so plainly when only Accessibility is there.
- **adb** (`src/companion/phone-adb.ts`). Found at `~/Library/Android/sdk/platform-tools/adb`, on
  `PATH`, or in Homebrew; Settings › Phone says whether it's there. Taps and typing become
  `input tap`/`input text`, a screenshot `screencap -p`, the screen `uiautomator dump`.
- **From anywhere (the tunnel).** The Mac's adb connects to `127.0.0.1:<port>` on the Mac; a byte
  tunnel (`tun_open`/`tun_data`/`tun_ack`/`tun_close`, 1.16) carries it through the link, and the
  worklet dials the phone's own adbd over `bare-tcp`. adb's TLS stays end to end between adb and
  adbd; the link carries only ciphertext. Pairing: the phone shows a six-digit code, you type it
  into Beluga's notification, and the Mac runs `adb pair` over a tunnel to the pairing port.
- **The Accessibility service** (`packages/companion/modules/phone-control`, Kotlin). Reads the
  screen as a labelled tree (never a password field), taps/swipes/types (`dispatchGesture`,
  `ACTION_SET_TEXT`), presses back/home/recents (global actions), opens apps and links, and takes a
  screenshot (`takeScreenshot`, API 30+, no MediaProjection prompt). The Mac asks with `req`, the
  app answers with `reply`. `FLAG_SECURE` screens capture black; the tool says so rather than lying.
- **Beluga Link, an add-on app** (BLG-377, `modules/phone-control/addon`). The
  Accessibility service lives in its own small APK (`sh.ratel.beluga.control`), attached to each
  release beside the app. Play Protect's fraud protection blocks a sideloaded app that declares an
  Accessibility service ("App blocked to protect your device"), so the main APK no longer declares
  one and always installs; only the add-on can hit that block, and installing it over adb (the Mac
  on a cable or Wireless debugging) goes through. The app binds the add-on's `ControlService` and
  they swap Messenger messages (`shared/…/ControlLink.kt`: `HELLO`, `PERFORM`/`RESULT`, `STATE`,
  `LAUNCH`); each side answers only a caller signed with the same key. The add-on also opens the
  mirror's "Start now" screen from the background for the app (`LAUNCH`, a PendingIntent), which a
  bound Accessibility service may do. `./gradlew assembleRelease` builds both APKs
  (`plugins/phone-control-addon.js` adds the add-on to the generated project). Each release
  carries it as `Beluga-Link.apk` (no version in the name, so `releases/latest/download/` always
  finds it). Its icon is Beluga's beluga in ink on a soft pastel with a link badge
  (`scripts/make-link-icon.mjs`), so it never looks like a second Beluga.
- **Setting up Beluga Link from the Mac** (BLG-391). Settings › Phone › **Set Up Beluga Link**
  (`companion.phone.setUpLink`), or the agent's `phone_setup_link`: with adb reaching the phone (a
  cable or Wireless debugging), the Mac downloads the latest `Beluga-Link.apk`, installs it
  (`adb install --user 0`, which Play Protect doesn't block), and adds its service to
  `enabled_accessibility_services`, keeping the others and dropping Beluga's own from before 1.6.0.
  Nothing to tap on the phone, and no "Allow restricted settings".
- **Over adb, the mirror is video too** (BLG-185). With USB, Wireless debugging or debugging
  through the link, the Mac streams Android's own `screenrecord --output-format=h264` (sized to
  1280 px, 6 Mbit/s on a cable, 4 on Wi‑Fi, 2.5 through the link; started again after its
  3 minutes), cut into pictures by `src/companion/phone-video.ts` (`AnnexBSplitter`): nothing to
  allow on the phone, and the same player. A still screen sends nothing, and that's fine. Before,
  each picture was a 1.9 MB `screencap` PNG (~0.75 s on a Galaxy S24+); now the first picture
  comes in ~0.5 s and each change after it at once. The mirror's own taps go by the Accessibility
  service when it's on (instant gestures), and an action's route is reused for 3 s.
- **Wireless debugging, safely** (BLG-187, BLG-189). A phone's adb is a full shell, so the Mac
  never trusts an address on the network or a name announced over mDNS. Two ways, the first that
  works: **straight over the same Wi‑Fi** (fastest), to the address and port the paired phone gave
  over the link, used only once the device there proves it's that phone: the Mac sends the app a
  one-time code over the link (`proof`, 1.19), the app keeps it in its own files folder, and the
  Mac reads it back with `adb shell cat` over the new connection (again each minute); or **through
  the link**: a local tunnel the paired phone's app carries, end-to-end encrypted to its keys, to its
  own debugging port. Many networks (dorms, campuses, cafés) keep devices apart: the straight way is
  then `blocked`, Settings › Phone says so in a sentence ("this Wi‑Fi keeps devices apart, so through
  Beluga's link instead"), and it's tried again on another network or after 5 minutes. Settings ›
  Phone › Over Wi‑Fi: **Use over Wi‑Fi** (on a cable: `settings put global adb_wifi_enabled 1`;
  Android asks "Allow wireless debugging on this network?", behind the lock screen if it's locked;
  tap Allow, not Always) and **Turn Off**; turned on by Beluga, it goes off after 15 minutes unused.
  The phone's own switch and its notification's **Stop** cut every route, adb's included, and the
  Mac keeps that no on the device record (`DeviceRecord.stopped`). adb in the agent's Bash only at Full.
- **A phone on the cable** (BLG-190). The daemon looks at macOS's own USB list every 4 s
  (`ioreg -p IOUSB`, read-only; Android vendors or "Android" in the name) and asks adb only once a
  phone is there. Settings › Phone › **On the cable** says what's next: USB debugging is off (the
  steps, and **Open on the Phone**, which shows its Developer options or About phone through its
  Beluga, `open {settings}`, 1.19); "tap Allow on Allow USB debugging?"; or ready. A phone with
  Beluga that isn't paired with this Mac (matched by its device name) gets **Pair over the Cable**:
  a pairing opens here and the Mac opens it on the phone (`am start … beluga://device#…`, which the
  app routes to its pairing screen, `app/+native-intent.tsx`); the four pictures are checked as ever.
- **The phone beside the chat** (BLG-186). The right panel has a **Phone** tab (⌥⌘8) wherever it
  shows, while an Android phone is paired: the same live mirror, fitted to the panel, beside any
  conversation or Your Mac. What the agent does shows on it as it happens: a ripple where it taps, a
  trail along a swipe, a caption ("The agent pressed Back"; never what it typed), from `phone_touch`
  frames; and the tab has a dot while the agent is acting (`PhoneControlView.busy`, 15 s after its last
  move). The Phone page's Ask your agent opens Your Mac with the Phone tab beside it.
- **The mirror on the Mac** (Your phone, BLG-173/BLG-184). Live H.264 video when the phone can
  (`control.video`, 1.18): the Mac asks with `req mirror {on, max, fps, kbps}`; the first time,
  the phone shows Android's "Start now" sheet (MediaProjection, from a see-through screen, or a
  notification where Android won't open one from the background), then its hardware encoder
  streams `vid` pieces (Annex B, 1280 px on the long side, up to 30 fps, ~2.5 Mbit/s, a still
  screen repeated four times a second). The Mac acks each with `vid_ack`; a phone with a dozen
  unanswered skips to the next key frame, and stops encoding after 10 s without acks. The Mac
  app decodes with WebCodecs (`packages/mac/src/phone/h264.ts`, rewritten to AVCC for WebKit).
  When the mirror closes the encoder stops and the capture is kept 90 s (reopening doesn't ask
  again). Until video flows, or without it, the mirror shows pictures: `screencap` over adb, or
  the Accessibility screenshot at most one per 340 ms (Android's minimum is 333 ms). The agent's own
  `phone_screenshot` stays a full-quality capture and `phone_screen` reads the UI, so the
  mirror's video is only for your eyes.
- **What the phone says** (`control`, 1.16): `allowed` (its own switch), `accessibility`,
  `screenshots`, `video` (1.18), `adb {on, port, pairing}` (found over mDNS, `_adb-tls-connect._tcp`), `wifi {ip}`,
  and the device. Samsung turns debugging off on network changes and the port changes each toggle,
  so the phone re-finds it and re-sends `control`.
- **The agent's tools** (`src/agent/phone-tools.ts`, server `beluga_phone`): `phone_status`,
  `phone_screenshot` (an image, saved as an output), `phone_screen`, `phone_tap`, `phone_swipe`,
  `phone_type`, `phone_key`, `phone_scroll`, `phone_open`, `phone_apps`, `phone_info`,
  `phone_install`, `phone_shell`, `phone_logcat`. Given only to the owner's own runs (like
  `beluga_mac`). Looking is always allowed; acting follows the phone's level.
- **The level, per phone** (Settings › Phone on the Mac): **Off**, **Ask each time**, **Use** (taps,
  typing, opening, installs without asking), **Full** (shell too). Kept on the device record
  (`DeviceRecord.use`); the owner-approval gate honours it (`agent-host.ts` `authorizeTool`).
- **On the phone**: one switch, **Let your Mac use this phone**, which turns on Stay connected and
  walks you through Beluga Link: **Get Beluga Link** while it isn't installed opens a guide
  (`app/link.tsx`, BLG-390) that says what Link is for, why it's an app of its own, that Android
  may block it when downloaded ("App blocked to protect your device"), and the two ways to install
  it (from the Mac over a cable, recommended, or Download Beluga Link); then **Turn on Beluga
  Link** in Accessibility (and, for a downloaded app, Android 13+'s "Allow restricted settings"). While the Mac is acting, an ongoing notification says so and has **Stop**, which cuts
  every route at once. iPhone can't do any of this.

## On the Mac

- **The sidebar's footer** shows a phone mark when a phone is paired: lit with a dot while it's
  linked, outlined when it's away ("Pixel 9 · last seen 12 min ago" on hover). Click: the Phone
  popover (the devices, Pair a Phone…, Remove).
- **Settings › Phone › Let your agent use your phone** (BLG-150): the adb line, and each phone with its
  route and an **Off · Ask · Use · Full** preset, plus **Connect** when Wireless debugging needs the
  pairing code. Nothing shows here when no phone is paired.
- **Settings › Phone**: pair (QR and code), the devices (name, platform, app version, last seen,
  notifications on or off), Remove, and Beluga Push (on by default once set up).
- **Shared state**: `companion: { devices: DeviceView[] }` (`linked`, `lastSeen`, `push`), never keys.

## Updating the app

The Android app updates itself from GitHub's latest release, like Beluga for Mac (BLG-426). It shows a pill on Home and a sheet with the notes and Update Now, and has Update automatically in Settings › Advanced › Updates. It doesn't go through the Mac or the link. How it works: docs/updates.md, "The phone app".

## Staying in step with the Mac app

The Mac app changes quickly; the phone must not fall behind silently.

1. **One API.** The phone calls `src/ipc/api.ts`, through `coverage.ts` (every method is `phone` or
   `mac`; a missing one is a compile error and a failing test). Renaming or changing a method's
   arguments changes it for both.
2. **Views are code next to the state.** `views.ts` reads `DomainState` directly: a change to the
   state that breaks a view breaks the typecheck. `tests/companion-views.test.ts` snapshots the views
   of the demo state, so a change that alters what the phone shows shows up in review.
3. **One protocol file, imported by both.** The app imports `src/companion/protocol.ts` from this
   repo (Metro `watchFolders`): within one commit the two can't disagree.
4. **Versions across releases.** `COMPANION_PROTO = { major, minor }`. Within a major, only additive
   changes: new topics, new fields, new needs-you kinds. The phone ignores what it doesn't know, and
   draws an unknown needs-you item as a generic card with "Open on your Mac". A breaking change bumps
   the major; the Mac keeps answering the previous major for one release, and the phone says "Update
   Beluga on your Mac" (or "Update the app") rather than misbehaving.
5. **CLAUDE.md** says it in words for every change (the agent reads it before working here).

## Phases

1. **This branch**: the contract (`protocol.ts`, `coverage.ts`), the Mac side (pairing, devices,
   `CompanionHost`, views, the footer mark, Settings › Phone), the app with Home, Work, a
   conversation, outputs, Needs you, Ask, Chats and People against a demo Mac, and the link worklet.
2. **Notifications**: Beluga Push (the Worker, a Firebase project), notification actions, Done and
   Mentions.
3. **iOS**: the same app; Keychain, APNs, the Notification Service Extension.
4. **Later**: screen sharing (ScreenCaptureKit → H.264 over the same link, on demand only), voice
   asks, a home-screen widget for usage and Needs you (board tiles came first: BLG-361), other agents' allowance next to Claude's plan
   (the usage view is a list of providers, not one).

## Risks

- **Bare on Android.** The worklet runs Holepunch's Bare runtime (`react-native-bare-kit`, as Keet
  does) so hyperdht and its native UDP run unchanged on the phone. Where UDP or hole-punching
  fails, the relay (see "Any network") carries the same Noise link over a WebSocket.
- **The relay is Cloudflare's quick tunnel.** It has no uptime promise; when it's down the record
  says no relay and the phone explains. It only ever sees ciphertext.
- **A sleeping Mac can't answer.** The phone shows the last views and queues actions. Keeping the
  Mac awake while plugged in and the agent is working is already the Mac's choice to make, not the
  phone's.
- **Push needs a server.** Beluga Push sees which phone tokens get pushed, and when; never what.
