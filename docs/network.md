# The Beluga network (Mac app)

Friends, direct messages, groups and presence with **no server and no host**: every Mac is its
own infrastructure. It runs in the daemon only when turned on (`"network": true` in
`~/.beluga/settings.json`, or `BELUGA_NETWORK=1`), next to today's rooms, which are unchanged.
The Mac app turns it on and off while Beluga runs (`network.setEnabled`: saved in settings, started
or stopped at once, no restart).
Code: `src/net/mesh/` (the node), `src/core/network.ts` (the core service and the `network.*`
API), `src/core/network-store.ts` (the shared state's `network`).

## Your address

Everything is derived from your identity (`~/.beluga/identity.json`) with HKDF, so it is the same
on every run:

- the **address**: an Ed25519 Noise key pair your Mac listens on in the Hyperswarm DHT;
- the **box key**: an X25519 key that group keys are sealed to;
- your **card**: peer id, identity key, address and box key, signed by your identity key. A card
  is checked wherever it's learned (pairing, group entries, the friends file).

Unlike a room's per-run key, the address is stable on purpose (friends find you by it), so DHT
observers can tell when that address is online.

## Adding a friend

An invitation is a one-time link (`beluga://add#<22 chars>`, 128 bits, works for 24 h) and a
short code (`K7QM-4XPA-R2TD`, 60 bits, works for 1 h). The code can also be sent as a link,
`beluga://add?code=K7QM-4XPA-R2TD`. Old `klaud://` links from before the rename still open. Codes are typed loosely: any case, dashes or spaces anywhere,
O for 0, I or L for 1. Neither form contains your address: the inviter listens on a temporary key
pair made from the secret (HKDF for the link; scrypt for the code, see below), so only someone
holding it can find you. On that connection:

```
invitee → pair_hello { profile, proof }   proof = HMAC(auth, "invitee" ‖ Noise handshake hash ‖ profile)
inviter → pair_ok    { profile, proof }   (or pair_refused)
```

A profile (`PeerInfo`) may carry `agents` and `defaultAgent`: the agents that person runs and the one they use first. Chat and `agent_event` bodies, and a friend-chat message's `claude` extra, may carry an `agent`: whose agent wrote it. An older Mac leaves them out, which means Claude.

The proofs bind both cards to that one connection (no replay, no one in the middle without the
secret), and the invitee must dial with the address on its card. Friend invitations are
single-use and last 24 h; five bad proofs in a minute pause an invitation for the rest of it.
Using an invitation that fails says why. A failed hole-punch (`HOLEPUNCH_*`) means the inviter answered
(a hole-punch only starts after that), so it says the two networks couldn't connect directly, names the
code, and that the invitation still works. Anything else is "Nobody is waiting for that invitation":
`PEER_NOT_FOUND`, no answer at all, and `PEER_CONNECTION_FAILED` (an invitation that closed while the DHT
still remembers it) (`pairFailure` in `src/net/mesh/pairing.ts`). Pairing has no relay yet: nobody is
linked to both of you before you're friends.
Group invitations (`beluga://join#…`, `beluga://join?code=…`) work the same, are multi-use (the
link for 7 days, the code for an hour), and either let people in at once (`auto`) or leave a
request for an admin (`network.groups.approve`). Someone who was removed always needs an admin.

**Why guessing a code is infeasible.** The code's listening key is visible to DHT nodes, so an
attacker could guess codes offline until one produces that key, then pair first. Each guess costs
one scrypt with N=2^16, r=8, p=1: 64 MiB of memory and about 0.1 s on a Mac. There are 2^60
(≈1.2·10^18) codes; finding one takes 2^59 guesses on average. Even granting a large GPU
10^5 such guesses per second (memory-bound: about a thousand 64 MiB instances at once), that is
≈5.8·10^12 GPU-seconds, about 1.6 billion GPU-hours, and the code dies after one hour: it would
take over a billion GPUs. Precomputing a table isn't possible either (2^60 entries of 32 bytes,
about 37 exabytes). The link (128 bits, no scrypt needed) is out of reach entirely.

## Links

The daemon keeps one Noise link to every friend and group member who is online: it dials them
(backing off from 1 s to 60 s while they're away) and its firewall accepts only addresses it
knows. Two Macs dialing each other at once keep the same connection (direct over relayed, then
the one dialed by the lower address); a reconnection after a restart replaces the stale link
at once. A relayed link is retried directly now and then and replaced once that works. Each link has a heartbeat (dropped after 3 missed),
2 MB frames and token-bucket limits on messages and bytes. Messages are versioned JSON (`hello` carries
`proto: 1`; unknown kinds are ignored): `hello`, `presence`, `dm`/`dm_ack`/`dm_seen`,
`av_get`/`av_data` (profile pictures), `g_heads`/`g_sync`/`g_entries`, `tun_open`/`tun_in`/`tun_data`/`tun_close`, `gw` (the gateway), `share`
(sharing with friends), `team` (team boards: friends on the same GitHub repository, see docs/tasks-and-plans.md phase 3).

**Delivered, then Seen** (BLG-798). A direct message is Delivered once the install that is them on the network
(their Mac, or their Always On) acks it with `dm_ack`. `dm_seen { id }` says their messages up to that one were on
a screen of theirs: a conversation visible in a Beluga window in front, or opened on their phone (`network.read`),
said by whichever install runs their network, never by an Always On on its own (it has no screens; your Mac's
attention reaches it through your link). Once per newest message, only while linked, and not at all when Say
When You've Seen a Message is off (`readReceipts`, a setting that follows you to every device). An older Beluga
ignores the frame and never sends it, so its messages stay Delivered. Seen is kept as a `{ seen }` line in the DM log.

**Versions and features.** `hello` also carries the Beluga version (`app`) and what this Mac does (`can`,
`src/net/mesh/features.ts`: `chat.*` always, `task.*` while the gateway listens, `share.*` while sharing with friends
runs, `team.*` while team boards run, said again when that changes).
A friend's card and `who_can` show their version. A request their Mac said it can't take fails at once
("Ata's Beluga 1.1.0 can't take file requests yet. Ask Ata to update Beluga") rather than waiting a week;
"isn't taking requests" only counts while they're linked (a Mac withdraws it as it quits). Macs from before
this say neither, and are asked as before. Someone on another `proto` major is shown as needing an update
(`update: 'them' | 'you'`), not as offline. See docs/agent-to-agent.md for where this is going.

**Relaying.** When a direct dial fails (both sides behind strict NATs, UDP blocked), your Mac asks
someone linked to both of you (people in a shared group first) to open a tunnel. The relay only
forwards bytes; inside, the two ends run their own Noise handshake with their addresses
(`@hyperswarm/secret-stream`), so the relay sees ciphertext and can't pose as either side. It
does learn that the two of you talk, and how much. HyperDHT's own blind relays (`relayThrough`)
were not used: they can't be exercised on a local test network, while these tunnels are tested.
Limits: 16 tunnels per link, 64 per relay, 16 ending at you through one relay; relayed tunnels
nothing went through for 5 minutes are dropped.

## Groups

A group is a signed, append-only log kept on every member's Mac (`~/.beluga/groups/<id>.jsonl`):

- entry: `{ id, group, author, lamport, parents, type, ts, body, sig }`; `id` = SHA-256 of the
  canonical JSON of the rest, `sig` = the author's identity signature over `id`, `lamport` = 1 +
  the highest parent's. Every copy orders entries by `(lamport, id)`, so all copies agree.
- types: `create`, `member_add`, `member_remove`, `admin_add`, `admin_remove`, `rename`,
  `sender_key`, `message`.
- rules, applied in that order: the creator is the first admin; only admins add or remove people
  and make admins; anyone may leave or rename; entries by non-members change nothing; if the last
  admin leaves, the longest-standing member becomes admin. Conflicting changes (two admins
  removing each other) are settled by the order: the first one applied wins. Removal wins over
  anything the removed person wrote without having seen it, so nobody can write themselves back
  in from an old copy. Only an admin's add makes a newcomer's entries checkable at all.
- limits: a sending key belongs to its author (nobody can reuse its id), message numbers may only
  run 1000 ahead of the chain, at most 100 members.
- sync: on link up and every 30 s each side sends its heads; whoever lacks something sends its
  own heads and gets what it's missing oldest first, in batches of 200 entries / 512 KB. New
  entries are passed on to every linked member (gossip), so they reach people you can't link to.
  Someone removed is only sent entries up to their removal. Each person gets at most 10 catch-up
  answers a second (bursts of 60), and a link that delivers more than 200 forged or malformed
  entries is dropped (they may link again).

**Encryption: sender keys.** Each member sends with a chain key sealed for each current member
(ephemeral X25519 + HKDF + AES-256-GCM) in a `sender_key` entry. Every message gets its own key
(`HMAC(chain, 1)`, then `chain = HMAC(chain, 2)`); bodies are AES-256-GCM with the group, author,
chain and number as associated data. Headers are signed, bodies encrypted. Whenever who's in the
group changes, each member starts a new chain at their next message, sealed only for the people
in it now: someone removed can't read what's sent after, and someone added can't read what came
before. Keys never leave the daemon; the shared state and the API only carry views.

## Offline

Direct messages to an offline friend wait in your outbox (`~/.beluga/outbox.json`, 7 days) and
are sent when a link comes up; the receiver acknowledges and de-duplicates. Group entries are
held by every member, so you catch up from whoever is online.

### The mailbox (BLG-272)

A friend you're never online with at the same time would never get what waits in your outbox, so
team board changes, sharing frames and tasks between agents also go through a mailbox: a
Cloudflare Worker (`packages/mailbox`, rules in `src/net/mailbox/handler.ts`, client in
`src/net/mesh/mailbox.ts`).

- **When something goes there.** A frame nobody acknowledged for `mailboxAfterMin` minutes
  (default 2) while its friend isn't linked; and on quitting (or turning the network off), all of
  what still waits at once (`Mesh.leaving`, called before any service stops). Each frame is mailed once.
- **Before the Mac sleeps (BLG-277).** The Mac app hears IOKit's "will sleep" (`src-tauri/src/power.rs`),
  sends the daemon SIGUSR2, and holds the sleep until the daemon has mailed (it writes
  `~/.beluga/slept.at`), 5 s at most. A closed lid strands nothing.
- **On the task (BLG-273).** A team task whose latest change a teammate's Mac hasn't acknowledged shows
  a small clock on its card and row (state `team.waiting`), and on its page who and where:
  in their mailbox, or waiting for their Mac. Nothing shows once everyone has it.
- **What the mailbox sees.** It's sealed to the friend's box key and signed by you: the Worker
  checks the signature and keeps it 7 days; it learns who wrote to whom, when and how much, never what.
  Only its owner can take or delete their mail. A Mac opens mail only from friends.
- **Taking mail.** On start, after the Mac wakes (a late tick), and every 3 minutes while any
  friend is offline; nothing while everyone is linked. What it takes is handed on as if it came
  over the link, and acknowledged back over the link, or by mail when the sender is offline.
- **Clearing your outbox.** Only an acknowledgement does: a frame stays in your outbox until then,
  and still goes over the link when one comes up. A frame that arrives twice is dropped (frame
  ids; board changes merge; a task request is known by its id).
- **Settings.** `mailbox`: another mailbox's URL, or `"off"` (also `BELUGA_MAILBOX`); `mailboxAfterMin`.
  No default mailbox until Beluga's is deployed (`DEFAULT_MAILBOX_URL`).

## Presence

`{ state: online | away | dnd | offline, note?, until? }`, sent on link up and on change.
Choosing `offline` means appear offline: links stay up and messages arrive, but others see a
plain `offline`. A status with `until` reverts to online by itself. Idle detection is the
screen's job (`network.presence.set`): the Mac app sets Away after 10 minutes without input (the
system's idle time) when you chose Online, and Online again when you're back. New messages notify
through the shared Notifier (the `mentions` kind), silently on Do Not Disturb or while you appear
offline.

## Profile pictures (BLG-276)

Your picture is set in Settings › General (`network.avatar.set`). The Mac crops it square and shrinks
it to 256 px first; the daemon keeps PNG, JPEG, WebP or GIF up to 96 KB, by checksum, under
`~/.beluga/avatars/` (`src/net/mesh/avatars.ts`, with `index.json` saying which is yours and which one
each person said is theirs last). `hello` carries its checksum (`avatar`) and is sent again when it
changes. Someone who doesn't have that picture yet asks once (`av_get { sha }`) and gets its bytes
(`av_data { sha, d }`); a Mac only answers for its own current picture, and the receiver keeps it only
if it's the checksum that person announced, it hashes to it, and it is a small picture. Views carry the
checksum (`PersonView.avatar`, `NetworkSelf.avatar`) and screens get the bytes with `network.avatar.get`,
so a picture crosses the network once per change and still shows while its owner is away.

## The leaderboard (BLG-904)

Being friends means sharing three numbers a day with each other, for Usage › Leaderboard: the
characters you wrote to your agents, the pull requests merged, and your agents' working time (the
run's whole time, tests and waits included). Nothing else goes: no projects, prompts or agents.
`src/core/leaderboard/` sends your last 400 days as a `stats` frame (`{ v: 1, at, days: { "2026-11-09":
[chars, prs, agentMs] } }`, checked in `protocol.ts`) when a friend's link comes up and again when
your numbers changed (looked at every 5 minutes); only friends' frames are taken. What each friend sent
last is kept in `~/.beluga/leaderboard.json` so they still show while away, and dropped once they're no
longer a friend. Macs that do it say `stats.board`; a friend's Beluga without it shows as needing an
update. The Usage tab asks for everyone's with `stats.leaderboard`.

## Friends from your room (BLG-202)

There is one people list: Friends. Someone in your room who is also a friend is just their friend row,
with the room's bits on it (agent on, following their screen). Someone in your room who isn't a friend
shows under **Not friends yet** with one action, Add as Friend; guests (project-link visitors) aren't listed.

Add as Friend (`network.friends.addFromRoom`, `src/core/friend-offers.ts`) makes a one-time friend
invitation only that person may use (`for`: anyone else who got hold of it is refused) and sends it to
them as a directed room message (`friend_offer`, a guarded kind: fresh and only once). Their Beluga
keeps the link in the daemon, never in the shared state, and shows "kay wants to add you as a friend"
in Friends and as a NeedsYou item on the phone, with a notification. Accept
(`network.friends.answerOffer`) uses the invitation and checks it really came from the person who sent it.
Macs from before this drop the message. After joining a room with an old room link, the room chat offers
its host: "Add kay as a friend?".

Trust is a property of a friend, set in one place: their card (the conversation's Info › Trust). The
room's menus, Settings › People and a request's sheet say it and link there.

## Multiple rooms

One person can be in several rooms at once. Each room is its own Beluga: its own core, room client
and peer list. All of them sign as the same identity,
so the person's peer id is the same in every room (`tests/multi-room.test.ts`).

- **Presence and the people list are per room.** Each hub lists whoever is connected to it. Leaving
  room A takes you out of A's list only.
- **Routing stays in the room it started in.** Directed frames (`to: peerId`) go to the connection
  in that hub. `ask_agent`, `run_on_peer` and room gateway tasks find the person by name in that
  room's peer list. If Bob is in both of your rooms, a request made in room B reaches his Beluga in B.
  The mesh (friends, DMs, groups, gateway tasks over friends' links) runs only in the daemon, so one
  Beluga per Mac takes those. A task over the mesh reaches the Beluga where the person runs the network,
  not necessarily the one in your room.
- **What they share is merged, not overwritten.** `~/.beluga/settings.json` `people` (trust) is
  re-read before every change, and each change starts from what's saved. New people arriving re-read
  it too, so a choice made in one room counts in the other. Before this, each Beluga wrote back the list it
  had loaded at startup. `seen.json` (the replay guard) takes in the file before writing. A request
  seen in one room can't be replayed into the other after a restart.
- **The same room twice** (the same identity joining one hub again) still keeps the seat with whoever
  has it. The newcomer is told "You’re already in this room from another window" (4003) and retries
  in the background, so no window kicks another out in a loop. The hub then pings the existing seat. If
  it doesn't answer within 3 s (`TWIN_PROBE_MS`), for example because a Mac went to sleep or its network
  changed, the hub drops it, and the owner's next try gets in. Before this, a dead seat kept its owner
  out until the 25 s heartbeat noticed, which took up to about 50 s.
- **Limits.** The daemon (and so the Mac app) is in one room at a time. Joining a friend's room
  restarts it with `join <link>`, and a terminal attaching with `BELUGA_DAEMON=1` to a different room is
  refused. To be in two rooms from one Mac, the second one runs in a terminal. Desktop notifications
  from two Belugas don't say which room they came from.

## Known limits (phase 1)

- Logs are never compacted; very long-lived groups grow.
- Removal wins: once someone is removed, entries they wrote without having seen their removal
  don't count (even a message written offline at the same moment). Someone removed while
  offline learns of it from any member who still accepts them (removed people may call in for
  7 days).
- A burst of wrong proofs pauses an invitation for a minute rather than burning it, so nobody
  can kill your invitation, but they can delay it.
- Open invitations (their link and code) are in the shared state, so any screen attached to
  your daemon can show and copy them, as with room invites.
- Appear offline only changes what others are shown: your Mac still links and acknowledges
  messages, so a friend's Beluga could tell you're connected.
- The relay learns who talks to whom and how much (not what).
- A join request reaches the admin whose invitation was used, not every admin.
- Groups you didn't ask for are only fetched from friends (an admin adding you directly) and
  from the admin whose invite you used; at most 500 groups and 100 people per group.
- Exactly one of you on the network: the install that holds your identity runs it, this Mac or the
  computer you made your Always On (below), never both. Your other devices (apps, computers,
  phones) show your network through their link to it. A second Beluga process with the same
  `~/.beluga` doesn't start the network, and the lease stands this Mac in only while your Always
  On is down. How your computers fit together: [docs/machines.md](machines.md).

## Your Always On

Code: `src/machines/always-on.ts` (the handover), `always-on-bundle.ts` (what moves, staged and checked),
`always-on-state.ts` (`~/.beluga/always-on.json`: where you are), `src/core/identity.ts` (the identity the
device set, the companion and the network read through). Settings › Your Computers › a computer › ••• ›
Make Always On…, and Make This Mac Always On under You on the Network (BLG-796).

- One of your computers can be you on the network. After one confirmation your identity, your friends
  network's files (friends, invitations, DMs and their outbox, reactions, read marks, presence, groups
  and their logs, avatars) and the settings that are you to friends (name, trust levels, Ask Me For,
  what friends may ask, the mailbox) travel there over your own end-to-end device link. Friends see the
  same peer id, name, groups and chats: nothing for them to redo.
- Two steps, so there is never two of you and never none: the giver stops its network and sends; the
  taker stages everything, checks each file's SHA-256 and that the identity is the one its device set
  belongs to, and says ready; only then does the giver note where you are, wipe its copy and say commit,
  and the taker installs it and starts the network. A link that drops before commit changes nothing; one
  that drops after it leaves the staging, and the giver says commit again until it lands.
- The install that gave it keeps a stand-in key of its own, never starts the network itself while
  `always-on.json` names another device, and shows your network through the link (your Always On says
  its friends, groups and invitations in each poll). Every device certificate stays valid; each install
  pins its companion address (`companion-seed.json`) before its identity changes, so phones and computers
  reach it as before. New phones and computers are signed in where your identity is.
- Make This Mac Always On brings it back the same way; moving it to another computer goes through this
  Mac (back here, not started, then on). Rooms keep the key they joined with until Beluga restarts.
- Friends through it (`src/machines/friends.ts`, BLG-797): this Mac's daemon keeps a client link of its
  own to the Always On and mirrors its network into this Mac's state (`net_mirror`, then each `net_*`
  action), so People, chats, groups, calls and the phone work as before and notify as before. Every
  `network.*` and `calls.*` call is forwarded there (the Friends switch too). What this Mac's screens show
  is said there, so those conversations are read. Friends' requests run there under the same trust levels;
  the ones waiting on you show here as `ao:<id>` and the first answer from any device counts. Call
  signals come back to the window in the call: audio and video stay on this Mac. The last mirror is kept
  in `friends-mirror.json`, so messages that came while this Mac was closed are news when it opens.
- Never two of you, never none (`src/machines/lease.ts`, BLG-799): whichever install is you renews a
  lease every minute, a DHT mutable record under a key only your identity derives (`beluga-lease-v1`).
  The Mac that made a computer its Always On keeps its own copy of your identity
  (`identity-standby.json`: it never leaves this Mac again) and a replica of the network files, refreshed
  from the Always On every 10 minutes (never the identity). Once the Always On hasn't answered for 10
  minutes, its lease is 10 minutes stale (or the DHT can't be read), and one last try over the link fails,
  this Mac stands in from the replica and Settings › Your Computers says so. When it answers again, the
  stand-in hands back by itself: chat logs are merged line by line, the rest is the stand-in's. A holder
  that finds a fresher lease of another install stops at once, and an install that was your Always On
  asks the lease before its network starts, so it never comes back as a second you. Installs that never
  took part in an Always On never read or write the lease.

## Chats: channels, files and agents

Code: `src/core/chat/` (files, agents, the main channel, `launch.ts`), `src/net/mesh/extras.ts` (what a
message carries), the Mac app's `src/network/` (`ChatTabs`, `ChatFiles`, `NetComposer`). The daemon runs it
whenever the network is on.

**What a message carries.** Inside the encryption (a group message's sealed JSON, a direct message's Noise
link) a message is `{ text, files?, ask?, claude?, task? }`: `files` are `{ sha, name, size, mime?, image? }` (the
bytes travel separately), `ask: { to: 'all' | peerIds }` calls agents in, `claude: { for }` marks an agent's
answer to message `for`, `task: { id, role: 'request' }` is a task's card (see *Tasks between Claudes*). Older Macs read only `text`. Names are cleaned (no folders, control or bidi
characters); malformed extras are dropped.

**Reactions** (BLG-702). Under a message, a chip per emoji with how many put it there (who, on hover; yours
in the accent's soft tint; a click adds yours or takes it back). Hovering a message shows a smiley-plus
button: your six quick reactions (the ones you use most in these chats, then 👍 ❤️ 😂 🎉 👀 ✅) and More, every
emoji (Emojibase's set, `emojibase-data`, loaded when it first opens; searchable, in categories; nothing past
Emoji 16, which today's Macs and phones can't draw). The model is `src/shared/reactions.ts`: one person's
change at a time (this emoji on or off, at `at`), the newest per message, emoji and person wins and an off wins
a tie, so every copy that got the same changes shows the same chips in any order. One emoji is an emoji only
(32 UTF-16 units, no words), each person has it once on a message, a message shows at most 20 different
ones, and one person keeps at most 20 on it. In a **direct conversation** a change is a `dm_react { id, e, on,
at }` frame (`dm_react_ack` back), checked on arrival, kept next to the messages in
`~/.beluga/dms/<peer>.reactions.jsonl` and, until their Mac says it got it, in `~/.beluga/dm-reactions.json`
(sent again on every link, like an edit). In a **channel** it is an encrypted message of its author's in the
group's log, `{ text, react: { to, e, on } }`, so it syncs, is kept and checked like any message and nobody
outside sees who reacted; its log position orders one author's changes. Macs that know reactions fold those
into their message and never show, count or hand them to agents as messages; older Macs show the `text`
("Reacted 👍 to “Morning!…”"). Screens get a message's `reactions` (`MessageView`) and a change as
`net_reacted`; `network.messages.react(conversation, id, emoji, on?)` makes one (none flips yours).

The room's **group chat** and **workspace chats** (yours shared in the room, or a worktree shared with
friends) have the same reactions, with the same rules, as a `chat_react { channel, to, e, on, at }` body
(src/protocol.ts; an older Mac doesn't know the kind and drops it). A chat message now carries its own `mid`,
so its id is `<from>:<mid>` in every copy (`chatMessageId`; an older Mac's keeps its frame's id). In the room
the change goes into the room's history (`keep`), so someone who joins later gets it too; in a workspace it
goes to each person in it, and in a friend's worktree through its owner's Mac, which passes it on (from
anyone who sees the worktree: viewers may react, never post). Each chat item keeps its changes (`reacts`,
`core/chat-reactions.ts`), so a workspace's reactions are saved with its conversation in
`~/.beluga/history/<id>.json`. `session.react(channel, id, emoji, on?)` makes one. Earlier lines of a shared
worktree (its history page, drawn as messages) aren't messages here and take none.

Each person's agent is drawn in that person's color (its mark and its name), here and in rooms, so a
conversation with several agents reads as who's who.

**Channels.** Groups are shown as channels, as tabs above the conversation (`chatTabs` in the window's
preferences). Your **main channel** ("All Friends" to you, "kay’s friends" to the others) is a group with all
your friends, made the first time you open it (nobody gets a group they didn't expect before that); every
friend you add later joins it (you're its admin). Its id is `mainChannel` in settings.

**Files.** Attaching a file takes it into `~/.beluga/chat-files/<sha>/<name>` (an APFS clone: instant, no space;
a copy elsewhere), so Send is instant and later edits to the original don't change what friends get. Folders
are refused (compress them first); there's no size limit, 20 files per message; pasted media goes to the daemon
in 4 MB parts. Friends pull a file straight from a Mac that has it over the same Noise links as messages:
`f_get { rid, sha, off, len }` → `f_data { rid, off, d }` (base64, 256 KB pieces) or `f_err`, with 12 pieces
in flight. Any Mac that has the file serves it, but only to someone in a conversation it was shared in (who
isn't gets the same "not here" as for a file that isn't there); if the one asked stops answering, the rest
comes from the next (the sharer first, then the others in the conversation), and a file nobody online has
waits until one of them is back. The SHA-256 is checked before the file is kept. A Mac only serves a file
to someone if *somebody else* shared it in a conversation they're both in (claiming you shared a checksum
yourself gets you nothing), at most 48 pieces at once and 48 MB/s per person (more is answered "busy" and
asked again shortly). Files up to 50 MB that a friend shares come by themselves; the rest (and anything from
someone who isn't your friend) when you click Download. While you pull from a Mac, its `f_data` frames have
their own allowance on the link (64 MB/s, bursts of 128 MB), so a transfer doesn't starve messages; at
other times they count like anything else. On a local link a 128 MB file takes about 2 s. A direct message
with only files carries "📎 name" as its text for Macs that don't know about files yet.

**Your agent acts when you ask it** (BLG-207). When you ask your own agent in a DM or a channel (Ask your agent
› yours, or @-mentioning it), it takes a real turn with its tools, not the toolless answer below: your own run
in that chat's lane (`AgentHost.runChat`, channel `dm:<peerId>` / `group:<id>`), working in Your Mac's folder
(`~/.beluga/assistant/work`, `MacAssistant.forChat`; no saved session: each ask carries the chat as below), with
your usual approvals, the Mac tools and the gateway's (`who_can`, `ask_person`, `run_on`, `get_file`,
`wait_for`…), whose tasks belong to that chat. Its final answer goes into the chat as "<owner>’s agent".
When a friend's result or their agent's question comes back after its turn ended, it carries on in the
chat and answers there (`ChatClaude.continueWith`). In the conversation, above the message box, you see its
tool approvals and questions, and its "Ask Alice's agent?" cards (and any request whose card is in your DM
with that person); a friend's request that came from this chat is approved on its card. Approvals of
requests from a chat point at it (`Approval.channel`), so their notification and the phone's item open the
chat. Without the Mac app (no Your Mac) your own asks are answered without tools as before. Friends' asks
of your agent are unchanged:

**Agents, only when asked.** Nobody's agent reads along. The Ask menu under the message box asks
your agent, everyone's, or one person's, for that one message. The message may have no words: the agents
then read the conversation and answer what's being discussed (older Macs get "✳ Asked Claude to read the
conversation" as its text). Each Mac whose owner's agent was asked
answers with that owner's own agent and login: no tools, no saved session (`AgentBackend.answerChat`),
reading the conversation as every member's Mac holds it: the latest 12 messages (8 000 characters, with
who wrote what) and the newest 20 written since the ask (8 000 characters). When there's more before
that, the agent is told so and gets one tool, `read_earlier` (BLG-428), to page further back through that
one conversation only (up to 50 messages a page, never a locked one), and does only when the window
isn't enough. Your own ask of your own agent, a turn with its tools, gets the last 60 messages
(30 000 characters) instead. It also reads the ask's text files (200 KB each, 120 000 characters in all) and pictures (4, 3.75 MB
each). The answer goes back into the chat as "<owner>’s agent" (split into up to four messages when long),
so every agent shares one history and each answer is part of what the next one reads; there is no
per-agent session to drift. While it works the others see "bob’s agent is answering…" (`live` frames,
repeated every minute, forgotten after three; only for an ask that called that person's agent, four at
most per person). The history and files are marked as context from several
people: only the asker's message is a request.

**What needs their Mac goes there by itself.** A friend's agent in a chat has no tools, so when your ask
needs their Mac (open a link, a screenshot, a file) its answer ends with a `[[request needs=…: …]]` line,
which travels as `claude.request`. Your Mac sends it at once as your request on their Mac
(`src/core/chat/requests.ts`, the gateway, `by: 'person'`, its `answer` the answer's id): you already
asked, so there's no second click. Their trust settings or their Allow still decide whether it runs, and
its card shows under that answer. Only for your own ask that called that agent in, only for an answer
under 10 minutes old, each once (`~/.beluga/chat-requests.json`). One that couldn't go (their Mac doesn't
take requests) tells you why and keeps an **Ask on Berca's Mac** button.

Who may call your agent: you always; others as **Settings › People & access › Who can ask your agent in
chats** says (`chatClaude`: friends in the chat (default), people you trust, only you; someone in a channel
who isn't your friend needs your trust either way), never someone you blocked; 20 asks per person an hour
and 60 from everyone together, two answers at a time, 20 waiting. Chat text and files can't open or close
the prompt's own sections (`<chat>`, `<message>`, `<file>` in them are defused). An ask older than 10 minutes when
it reaches you (you were offline) isn't answered, and each is answered once (`~/.beluga/chat-claude.json`).
If your agent can't answer, you get a notification; the others just see it stop.

## Calls (BLG-706)

Voice, cameras and screen sharing in a DM, a channel or a room, with no call server. The call stays in its
conversation, and it's the same chat.

- **Setup over the links you already have.** `call` link frames (core/calls, checked there, only
  between people in that conversation): `ring`, `here` (I'm in it: muted, sharing, joined at; every
  10 s), `bye`, `decline`, and `sig`, WebRTC setup for one person's window (64 KB at most). Nobody
  runs a call: each Mac keeps the roster from what it hears and drops whoever was quiet for 32 s.
  Two people pressing Call at once end up in the same call (the lower id wins on every Mac).
- **Only someone who can answer.** A call whose `ring` would reach nobody (everyone offline, so no
  link to send it on) doesn't start, and the Call button says so before you press it. The caller
  hears it ring at the others' (a bright ring-ring, then a moment of quiet, as a phone does) until
  someone joins; the window wakes
  its sound on that click, since WebKit keeps sound started without one silent.
- **Missed calls.** A ring that stops before you answered or said Not Now (nobody picked up in
  45 s, or the caller hung up) leaves "Ann tried calling you at 14:05" where it rang in the
  conversation, with Call Back, and in the inbox (core/calls/missed.ts, kept in
  `~/.beluga/missed-calls.json` for a month, so it's still there when you open Beluga again).
- **Media goes Mac to Mac.** The window makes the call with WebRTC (packages/mac/src/call): Opus
  voice with echo cancellation and noise suppression to everyone in it (a mesh), DTLS-SRTP
  encrypted. Public STUN only finds each Mac's address; there's no TURN yet, so two networks that
  block UDP can't call each other, and neither can a Mac behind a VPN that gives each destination
  its own port (Cloudflare WARP does) with most home networks. Call notes still arrive then (they go
  between the daemons), so a line that hasn't connected after 12 s says so in the strip, by name,
  until it does: otherwise it looks like a call where nobody talks.
- **Screen sharing through a tree.** A share is tuned for text (`contentHint: text`, resolution
  kept before frame rate, H.264 first: the Mac's hardware encodes it). The sharer feeds the first
  three viewers; each viewer passes it on to at most two more (`shareTree` in shared/calls.ts), so
  the sharer's upload stays the same however big the call gets. Every Mac draws the same tree from
  the roster, in join order.
- **Pointing at it.** The laser, ink that fades after a few seconds and Ask Claude's marked area go
  as vectors on a WebRTC data channel (fractions of the picture), never through the daemons. Ask
  Claude puts a snapshot of the share (with the ink on it) in the chat as a question for your own
  Claude; its answer is a chat message, shown on the stage for everyone in the call.
- **One window makes your side.** The Mac screen that started or joined it (or the first to say
  so after you answered from the phone) gets the setup and says it's still there every few
  seconds. If it goes quiet for 32 s, you leave the call.
- **Pointing, without tools** (BLG-717). On a shared screen a click sends a ripple everyone sees,
  and dragging draws; your pointer shows only once you choose to (below). Strokes a moment apart are one sketch (a word,
  a circle and an arrow); drawing again after a pause clears your old sketch, and left alone it
  dissolves a few seconds later by itself. The Box tool (or Shift as you drag) marks a box instead;
  it goes as a stroke along its sides, so it fades and can be asked about like any sketch. Beside
  your sketch, Ask your agent sends the part it covers, ink and all, to the chat; the sketch stays up
  while you type the question. The sharer picks Sharp (text) or Smooth (motion) behind •••; each
  viewer can pick their own there too (BLG-743), or keep the sharer's. A viewer's choice goes out as
  `want`, and whoever feeds them the picture sends it that way (the sharer captures every frame once
  anyone wants Smooth); passed on through another viewer, it can't be sharper than what they get. Full
  Screen gives the picture the whole display. Nothing is written over the shared screen while the
  chat shows beside it.
- **Everyone's pointer** (BLG-733). Off until you turn on Show My Pointer in the stage's bar (each
  share starts with it off). Then your pointer shows for the others as an arrow in your colour with
  your picture and name, and you see the same mark under your own mouse in place of the usual
  arrow, so it looks the same on both ends. It's sent 60 times a second on a second data channel,
  unordered and never resent (only the newest spot counts), once the other Mac says it has one
  (`pointers` in `streams`); older Macs get it on the stage channel. Each screen glides it to its
  last spot on a critically damped spring (call/glide.ts), so it moves smoothly however the
  network delivers.
- **Microphone and speaker** (BLG-737). The chevron beside Mute picks which microphone and speaker
  the call uses; a new microphone goes on every line at once, and the choice is kept on this Mac.
  Picking a speaker needs WebKit's `setSinkId`; without it, macOS's own output is used. A voice is
  only sent to a speaker by name when one was picked; otherwise it plays where macOS plays sound.
- **Background noise** (BLG-744). WebKit ignores a page's `noiseSuppression` and
  `autoGainControl`: only echo cancellation applies (macOS's voice processing, Standard Mic Mode),
  and macOS lets no app turn Voice Isolation on for itself (only the user, in Control Center). So
  the call has its own filter (call/noise-filter.ts): RNNoise (via @sapphi-red/web-noise-suppressor)
  in an audio worklet at 48 kHz, between the microphone and everything that hears you (the lines,
  the speaking ring, the notes). It's off until you turn on Noise Removal in the microphone menu,
  then on in every call on this Mac until you turn it off; either way every line switches at once
  (the sender's track is replaced, nothing renegotiated). It was on in every call at first, and
  friends stopped hearing each other since: until a call between two Macs proves its Web Audio
  track reaches the other side, the line sends the microphone itself. If the audio engine won't
  start, or stops and won't resume, the plain microphone goes on instead and the menu says it can't run.
- **The chat where it can't be seen.** Full Screen and Face to Face cover the chat, so what the
  others write from then on pops up on the right, dissolves once there was time to read it, and a
  line under it answers in the same chat (call/ChatPops.tsx). Messages that were already there
  never pop up; timing counts from when each message reached this Mac, not its sender's clock.
- **What can be shared.** Share opens macOS's own picker (WebKit's ScreenCaptureKit picker): one
  window, or one whole display, any of them with several monitors. A whole app (all its windows)
  isn't something WebKit's capture offers.
- **The sharer.** Sharing, you're likely looking at another app, not Beluga. While you are, the
  floating card says you're sharing, in the call's colour, with Stop, and tucks away for the rest
  of that share (˄), leaving only the frame; a click-through window
  covers the shared screen (src-tauri/src/call_overlay.rs) with a soft frame around it, the
  others' sketches, pointers and clicks where they made them, and what they write in the chat
  bottom right. Both ask macOS to leave them out of captures (`NSWindowSharingNone`), so the
  others don't see them. Since macOS 15, ScreenCaptureKit doesn't always listen, so the overlay
  first shows a few pixels of two colours in turn in its top-left corner and the sharer's window
  looks for them in its own capture (call/leak-probe.ts, BLG-736). Found: the overlay still shows
  (a screen whose owner can't see the pointers is no use, BLG-743), and the sharer says so
  (`overlay` with `inPicture`): the others stop drawing pointers over that picture, since they're in
  it, so nobody sees one twice. Ink lands on the same spot in both, so it stays. Sharing one window,
  WebKit doesn't say where it is, so the shell looks it up in macOS's window list
  (src-tauri/src/shared_window.rs): the window whose size in pixels is the picture's; several that
  size in one place (maximized) are one place, in different places the title settles it, else
  nothing. Found, the overlay covers just that window and follows it (looked up again every 400
  ms); not found, the frame and the ink stay off and the chat still pops up. A window's capture
  never has the overlay in it, so there's nothing to probe. In Beluga, the strip, the stage and the sidebar's pill say
  you're sharing, and the pill can stop it. In full screen the stage's bar floats over the
  bottom and steps aside after a couple of seconds without the pointer moving.
- **Calls of 5–10.** Each Mac measures what it can send (WebRTC's own estimate per line) and says so
  with `here`; the share tree puts the best uploads closest to the sharer, each feeding as many as
  its upload carries (one to five), and weak connections only watch (`shareTreeBy`). Each window
  says how big it shows each camera (face to face or a small collage: big; a tile: small; not on
  screen: none), and each sender splits its upload by that, sending nothing to whoever doesn't look.
- **Cameras** (BLG-714). Each camera goes to everyone in the call, smaller as it grows (full size
  for two, about a third of the bitrate past four). A line says once on the data channel which of
  its streams is the camera and which the screen. Faces show as a band under the strip, or a
  filmstrip over a shared screen. Face to Face puts the call over the whole window, like FaceTime:
  one other person fills it, a group is a collage, and you're a picture you drag to any corner.
- **Notes** (BLG-715, BLG-718). Only once someone else is in the call: a call nobody picked up is
  never written down and leaves no notes. Nobody records anyone else: each Mac records only its own
  microphone (the call's echo-cancelled stream), cut at its pauses into phrases, keeping no sound
  once a phrase is written down. Each phrase is written down by whichever Mac in the call will
  finish it soonest (shared/scribe-plan.ts): every few seconds each Mac says whether it has a voice
  model, how fast it writes down, how much waits for it, its CPU load and whether it's on battery
  (`scribe` on the data channel). Its own Mac when that's close enough (no sound leaves it), else
  the phrase's WAV goes in parts (`clip`) to the soonest one, which sends the words back
  (`clip-text`). So someone with no model, or a slow or busy Mac, still gets notes.
  **The best model, one language** (BLG-738): each Mac also says which voice models it has, and a
  phrase goes to the best one in the call for its language (Whisper Turbo over Parakeet, which
  doesn't know Turkish; a lesser model only when the best is far behind), its own Mac when that's
  among the best. Each Mac counts how many seconds of its phrases came out in which language and
  says so too (`langs`); once one language clearly leads across the call (8 s heard, 60% of it),
  every phrase is written down in it (`lang` on `clip`), so a short Turkish phrase can't come out
  as Russian, and the early phrases that came out in another language are written down again. A
  language set in Settings › Voice always wins for your own words. The Notes button says which
  model writes on which Mac, and the call's language once it settled. And not word
  by word at any cost: with time to spare each phrase is written down at once; busy (load per
  core over 0.7) or on battery, phrases wait and go together, up to 28 seconds of speech in one
  go, never waiting more than a minute. As you leave, your words go to the others who were in
  the call (`notes` frames, accepted only from someone who was in a call you were in); everyone keeps one merged transcript (`~/.beluga/call-notes/<call>.json`), a
  one-line chip in the chat however long the call was. It opens in a reader beside the chat, made
  for long calls: your words on the right and everyone else's on the left, search (⌘F), one
  person's words only, and the call's timeline to jump along. Notes never go into a prompt:
  agents look them up with tools (server `beluga_calls`, and inside a chat answer `beluga_chat`):
  `call_notes_list`, `call_notes_search` and `call_notes_read`. Your own runs reach every call you
  were in; an answer in a chat only that chat's calls, and its prompt only says they exist. Its
  ••• › Talk About It opens a chat with your own agent that only you see, its message a
  `call:<id>` chip, never the transcript. Notes need a voice model on at least one Mac in the
  call: a call never downloads one.
- **Rooms** (BLG-716). The same calls in a room's chat: `call` bodies sent through the hub to one
  person at a time (never kept for latecomers), everyone connected and not a guest is in it, and
  the media still goes Mac to Mac. Its latest notes sit folded on top of the room's chat.
- **Wherever you are.** In the conversation, a strip under its header; elsewhere in Beluga, a pill
  at the bottom of the sidebar; with Beluga behind other apps, a small floating card
  (src-tauri/src/call_float.rs). Someone ringing you is a card at the top of the window with the
  ringtone, a notification, and a Needs you item on the phone (Answer on Mac, Decline).

## Tasks between Claudes (the gateway)

Code: `src/core/gateway/` (protocol, the gateway, the receiving side, files), `src/agent/gateway-tools.ts`
(your agent's tools), the Mac app's `src/gateway/` (task cards, Requests). The daemon runs it
(`launchGateway`), over today's room at once and over friends' links whenever the network is on.

- **Messages** (`protocol.ts`): `task_request {id, from, to, kind: ask|run|file, ask, summary?, needs, project?,
  expects?: JSON schema | "files", deadline?, command?/cwd?/timeoutSec?, path?, by}`, `task_update {id,
  state: queued|awaiting_approval|working, step?}`, `task_result {id, status: done|declined|failed|
  cancelled, summary, data?, files[{name, size, b64? | ref + sha256, image?}], log, secret?}`, `task_cancel`,
  `task_question {id, qid, questions}` / `task_answer {id, qid, answers? | skip}`,
  `file_get {id, ref, offset}` / `file_chunk {id, ref, offset, b64, eof, error?}`, and `card` (your
  trust in them, what your Beluga offers them, your projects, your "Ask me for…" note, and how much
  of your plans is left per provider, only to those Settings › Friends › Who sees your usage allows:
  people you trust by default, never anyone blocked). Each rides in a frame `{f, m}` that
  the other side acknowledges (`{ack}`): over a mesh link as `gw`, in a room as a `gateway` body
  sent to one person. Requests, results and cancels wait in `~/.beluga/tasks/outbox.json` until
  acknowledged (resent every 20 s while reachable, 7 days at most); updates and cards are only
  sent to someone reachable now. Over the network only friends are heard; a result is only taken
  from the person the task went to, and only once. A request to a friend whose Mac is off waits for
  them for those 7 days; the ack adds "Reached <name>'s Mac" to its steps, and only from then does
  a day without word fail it (not in the 10 minutes after either Mac wakes, starts or links again,
  so a waiting result arrives first). A request that ends on your Mac without their answer leaves
  nothing in the outbox, and your Claude's conversation hears it like a result (BLG-705).
- **Receiving**: your rules and capability settings decide (see *Approvals and rules* below):
  declined (with the reason), let in at once (you trust them, or a rule of yours covers it), or you
  are asked. It runs in the project it names (if there is one) or a scratch folder
  (`~/.beluga/tasks/work/<task>`), with the usual tool approvals (none with full trust; commands
  without asking where Run commands is Allow for their trust level). `run` tasks go through
  PeerRun (`serveTask`: secrets never, limits per person); `file` tasks are sent by Beluga itself.
  The agent ends its answer with a fenced `beluga-result` block for data and files; data is checked
  against `expects` on both sides; files only from the folder it ran in (and the folders you chose;
  anywhere with full trust), never secrets: up to 512 KB in all inline, bigger ones fetched in
  pieces (see *Big files*). A file request someone said yes to (or that a rule of theirs covers) may
  come from anywhere on their Mac, not only the folders they share.
- **Secrets** (BLG-209): a `file` request for a secret (`isSecretPath`: an SSH key, a `.env` file, cloud
  credentials, a token file, any other key) is never declined up front, and never let in either: its owner
  always gets a separate approval that says what it is ("kay's agent wants your private SSH key
  id_ed25519", `secretKindOf` / `secretLabel`), each time, with only Allow once / Decline (on the card,
  the request sheet, the pop-up and the menu bar; its notification only offers Review…). Trust, Allow
  rules and Always never cover it; a capability that is Off or a Decline rule still declines it. If
  they allow it, Beluga sends that one file and the `task_result` carries `secret: "private SSH key
  id_ed25519"`, so the requester's agent is told (outside the data block) that the owner approved it and
  hands it over instead of refusing. Still refused at once: Beluga's own private files in `~/.beluga`
  and the keychains (`isNeverSent`), and every `run` or `ask` task that touches secrets. Macs that do this
  say `task.secret`; asking an older one for a secret fails at once ("Ata's Beluga 1.2.0 can't send
  secrets Ata approves yet. Ask Ata to update Beluga.").
- **Both people see it** (BLG-208): when a task goes to a friend, the requester's Beluga posts its card
  in the chat they share: the channel it was asked from if the friend is in it (the request carries
  `chat: "group:<id>"`), else their DM. The message carries `task: { id, role: 'request' }` and words for
  older Macs ("kay's agent asked bob's agent: take a screenshot of your desktop"); each side draws the
  card from its own task book by id (`TaskView.chat` says where), so it moves along: sent, waiting for
  approval, working, done / declined / failed, with the summary and files. Someone else in the channel
  has no such task and sees only those words. The result posts nothing more; the person whose agent
  (or Mac) ran it gets a notification when it's done, pointing at the chat. A card makes no message
  notification of its own (the request itself asks you). The phone draws it as a small card
  (`ChatMessageView.task`).
- **Mentioning a friend, or their agent**: two different things. `@claude:mia` is mia's agent: your agent
  asks it with `ask_person`, takes a file with `get_file`, or runs one command with `run_on`. `@mia` is mia,
  the person: said to your agent in a worktree or Your Mac, Beluga sends mia a direct message ("kay mentioned
  you in fix-auth (bob-api): …", `src/core/person-mentions.ts`) and your agent only asks mia's agent if the
  work itself needs their Mac, access or answer (it may decide to on its own, under the usual check). In a
  DM or channel `@mia` is the person and `@claude:mia` calls mia's agent, as before. The message box offers
  each friend twice as you type `@` (the person, then their agent). Every request carries a `summary` (at most
  140 characters, "take a screenshot of your desktop") that their pop-up, notification and menu bar
  show; the full ask is behind See more.
- **Asking**: `ask_person` / `run_on` for someone you don't trust (Trusted / Full) first put an
  "Ask Alice's agent?" card in the conversation (Ask / Edit / Not now, 10 minutes). Results reach
  your agent as data in a `<task_result>` block, marked untrusted. If its turn ended before the
  result came (or it didn't wait for it), a new turn starts in that conversation with it.
- **Inside `~/.beluga`** everything stays private to friends' tasks (`isSecretPath`, compared as
  the Mac compares names: any case, links followed, the older homes too) except the scratch
  folders tasks run in (`tasks/work/`) and the files results brought (`tasks/files/`).
- **Files**: `~/.beluga/tasks/tasks.json` (the last 200 tasks, friends' cards, and results whose
  big files are still coming), `outbox.json`, `files/<task>/` (what results brought),
  `work/<task>/` (and `work/<task>/screens/`); `~/.beluga/rules.json` (your rules, 0600); your
  capability settings are `capabilities` in `~/.beluga/settings.json`.

### Approvals and rules

A request from a friend is decided in this order; the first that applies wins:

1. you blocked them: declined;
2. it needs a capability that is **Off** for their trust level: declined, saying which
   ("kay's Beluga doesn't let you see the screen");
3. a **Decline** or **Ask** rule of yours catches it: declined, or you're asked. Rules can always
   narrow what trust allows;
4. you trust them (Trusted or Full trust) and every capability it needs is **Allow**: it runs
   (trust decides first; no rule needed);
5. an **Allow** rule covers it: it runs;
6. otherwise you're asked.

A rule (`access.ts`, kept by `rule-book.ts`) is person × kind (`task`: their agent asks yours,
with these needs; `command`: one command; `file`: one file) × scope (a project by name, or a
folder and what's inside it; or anywhere) × expiry (or never) → allow, ask or decline. An Allow
rule covers requests that need no more than it lists (a request naming a project also needs
`project`); Ask and Decline rules catch any request needing one of what they list (all of that
kind when they list nothing). A command rule names the exact command (or any command); an Allow
rule for any command must be limited to a folder or a project. Folders are saved where they
really are (~ expanded, links followed); a command that names no folder is decided (and its
"Always" scoped) for the folder it would run in. Expired rules are dropped as they're met. A
`rules.json` that can't be read is kept aside as `rules.json.bad-<time>` (never overwritten) and
you're told; requests it covered ask you again.

Capabilities hold inside a run too: every tool call of a friend's task is checked (Bash needs
Run commands; Write, Edit and the like need Read and write files), so a capability that is Off, or
a Decline rule, stops it even with full trust. Requests from people you blocked are answered and
nothing of them is kept. A request is decided before anything about your projects is said: a
project that isn't there reads "That isn't available on Kay's Mac", like one they can't have.

You're asked with today's approval card (linked to the task) and the **request sheet**: who
(and your trust in them, with "Trust them instead"), what, what it needs (capabilities that are
set to Ask me are marked), where it would run, what comes back. **Approve once**; **Always…**
writes one rule for this person, kind and needs, with the scope spelled out and editable (this
project or any; for a command, this command or any; for how long: until you change it, a day, a
week); **Decline…** with an optional reason they see. While it runs, the sheet shows its steps
and Stop. "Always" on the plain approval card (or a notification, or the menu bar) writes the same
rule with the narrow defaults (this project, this command, no expiry); it no longer makes the
person Trusted: that's a separate choice (the sheet's link, their card, Settings).

The same rules apply to commands friends run through a room (`run_on_peer`) while the app's
gateway runs (PeerRun's "Always" writes a rule for that command in that folder); without it (the
terminal on its own), trust alone decides as before.

**The pop-up.** A friend's request waiting for you gets a small card of its own in the top-right
corner of the screen, above whatever app you're in, without taking the keyboard from it (the app
shell's `request-popup` window, `src-tauri/src/popup.rs`; the card is `src/popup/`, what it shows is
`gateway/popup-model.ts`): "mia's agent wants to take a screenshot of your desktop", what it needs,
**See more** (everything their agent sent, where it would run, what goes back, and "Open in Beluga
for more choices…"), and **Decline** / **Allow Always** / **Allow**. Allow Always writes the same
rule as the approval card's Always (this project, this command, until you change it). Up to three
requests show at once ("2 more waiting in Beluga"); × hides them until something new comes (they
still wait in Beluga and the menu bar). In place of a banner, only the notification's sound plays.
On Do Not Disturb (Beluga's, or your status) or while you appear offline it stays away. In a browser
(development, tests) `popup.html` in another tab hears the window over a BroadcastChannel.

**Notifications.** In the Mac app a friend's task request gets the pop-up instead of a banner. The
macOS notification's buttons are still registered (and used in a browser): a friend's request on
its own gets them (tauri-plugin-notification 2.7 shows actions on desktop: with several, macOS puts them in an
"Options" menu, and a click on that menu's title reports the first action, so the first is the
harmless **Review…**): Review… / Approve / Always Allow for a Week / Decline. Anything else (your
own agent's tools) only gets Review…: it's answered in the window. A click on the notification
opens the request sheet. The **menu-bar menu** lists friends' requests waiting (up to six), each
with Approve / Always Allow for a Week (tasks only) / Decline / Review…. "Always" from outside the
window is this project, this command, for a week; the sheet offers the other choices. On **Do Not Disturb** or while you **appear offline**, friends'
requests still queue (cards, inbox, Requests, the menu bar) but make no notification; rules still
let requests in, and those notices are quiet too.

### What your friends' agents can do here

Settings › People & access › *What your friends' agents can do here*: each capability is Allow,
Ask me or Off for each trust level (Ask me each time can only ask or be off; blocked people get
nothing). Defaults:

| | Ask me each time | Trusted | Full trust |
|---|---|---|---|
| Run commands | ask | ask | allow |
| Read and write files (the folders you choose) | ask | allow | allow |
| Work in projects | ask | allow | allow |
| See the screen | ask | ask | allow |
| Device info | ask | allow | allow |

Your card tells each friend what you offer them (their agent sees it in `who_can`).

- **See the screen**: the task's agent gets a `screenshot` tool (MCP server `beluga_task`, only in
  runs for a request that needed `screen` and was let in): `screencapture -x` of the main display,
  or of one app's front window (found through CoreGraphics' window list). It sees a smaller JPEG
  (`sips`); the PNG goes back with the result as an image. At most 4 per request. A command that
  takes one (`screencapture`, `scrot`, a script grabbing the screen) is the screen too: refused in
  a request that didn't need `screen`, asked about like the screen, and counted in the same 4.
  macOS asks you once to allow Screen Recording for Beluga.
- **Device info**: a `device_info` tool: macOS version and build, model and chip (from
  `system_profiler`, never the serial number), cores, memory, disk space, battery (`pmset`),
  uptime, local network addresses (no MAC addresses, nothing looked up outside), and the apps in
  /Applications and ~/Applications.
- **Read and write files**: the folders you choose are added to the task's agent's folders when
  the request needs `files`; `get_file(person, path)` (a `file` task) sends one file from them
  (anywhere with full trust); a secret only when they approve that one request (see *Secrets* above).

**Limits, so a request can't loop** (BLG-427, `gateway/serve.ts`, `gateway.ts`). A friend's task
here runs at most 50 turns and 20 minutes (sooner if its deadline is), then stops as failed
("Stopped after 20 minutes", "Stopped after 50 turns"). It asks you to approve its steps at most 8
times; the next one stops it instead, and so do 2 declines in a row ("Stopped: kay declined 2 of
its steps in a row"); the requester hears why. One person has at most 5 requests open here. On the
asking side, one conversation's agent sends the same person's agent at most 3 requests in 10
minutes (commands and files aren't counted); past that, `ask_agent` tells it to stop and tell you,
and a result that comes in later tells it not to send the same ask again.

### Big files

Files a result can't carry inline (over 512 KB in all) are offered under a random id, to the
requester only, for 24 hours (in memory: a restart of the sender drops them). The requester pulls
each one in 192 KB pieces (`file_get` → `file_chunk`) over the same link (a friend's Noise link,
or the room), one piece at a time, asking again after 20 s (six tries), checks the size it was
told and the SHA-256, and only then keeps it under `files/<task>/`. At most 32 MB a file and 64 MB
a task. Meanwhile the task stays *working* ("Receiving files…", with progress); the result is
kept on disk, so a restart carries on fetching. A file that can't be had is listed as not
received.

### Questions from their agent

When the friend's agent asks something while working on your task (AskUserQuestion), its
question goes back to you as `task_question` and waits (15 minutes, then it goes on with its best
judgment; at most 5 per task). On your side your agent is asked first: a `wait_for` that is
waiting returns the question; if its turn ended, a new turn starts in that conversation with it.
It answers with `answer_question` (one answer per question, or skip) from what it knows, or asks
you first (its own AskUserQuestion). If you never saw that task (it went straight to someone you
trust), its answer waits on the task's card for you to send, change, or let them decide. Each
question is taken once (a replay is ignored, frames are de-duplicated by id) and at most five per
task (more are answered "go on"). The question is shown as data from that person, never as
instructions. You can also answer (or let them decide) on the task's card; a task you asked
yourself notifies you.

## Sharing with friends

Code: `src/core/friend-share/` (`protocol.ts`, `courier.ts`, `service.ts`), `src/core/friend-share-store.ts` (the shared
state), the Mac app's `layout/SharedProjects.tsx` and `dialogs/native/ShareProjectSheet.tsx`. The daemon runs it whenever
the network is on (`launchFriendShares`), and says `share.project` and `share.folder` in its `hello`.

**A project, shared with a friend.** You share it from the project's ••• menu (**Share with…**: each friend gets
*Can work here*, *Can follow* or *No access*), or with `sharing.shareWithFriend({ peerId, projectId?, workspaceId?, role })`
(`role`: `contribute` | `view`; a `workspaceId` alone shares that one worktree). Only friends; a friend whose Beluga said
it can't open shared projects is told at once ("Ata's Beluga 1.1.0 can't open shared projects yet. Ask Ata to update
Beluga"). Nobody hosts: everything goes over the two Macs' Noise link in `share` frames.

On their Mac it's one row in **Projects**, after yours: the project's icon with your avatar on its corner, "· ata's" beside
its name, and its worktrees nested under it as your own are. It stays while your Mac is offline ("ata is offline") and
after either of you restarts (`~/.beluga/shared-projects.json`). New worktrees appear and archived ones go by themselves.
**Leave Project** (its ••• menu) takes it off their Mac and tells yours; *No access* (or `sharing.unshareFriend`) takes it
back. Each worktree also becomes a workspace shared with them (the state's `shared`, `via: 'mesh'`), so its conversation,
files and changes open as a room share's do; unlike those, it isn't wiped when a room ends. Your side keeps who has what
in `~/.beluga/project-shares.json`.

**What travels** (`protocol.ts`): each message rides in `{f, m}`, acknowledged with `{ack}`.

- `project {id, name, icon?, role, worktrees[{id, name, branch?}], members[{peerId, name, role}]}`: what they have of it
  now, sent whenever any of that changes (the newest replaces one still waiting). The icon goes when it's under 120 KB.
- `unshare {id}` (you took it back), `leave {id}` (they left).
- `history {ws, items}`: a worktree's last 60 messages and answers, once, when it's first shared
  with them; their Mac keeps it, and what's said after, with the project. Each message goes whole up to 60,000
  characters (a graph or a long answer) to a Beluga with `share.history.long`, and cut at 4,000 to one without it.
  A page stays under 400 KB, so long messages make it shorter and the rest comes as they scroll back.
- `body {b, as?}`: one of the room's own messages about a shared worktree or folder: `chat`, `agent_request`,
  `agent_event`, `agent_question`/`agent_answer`, the files' `fs_list`/`fs_read`/`fs_fetch`/`fs_search`/`ws_diff` and
  their answers. The sending Session hands it over instead of the room (`Session.meshRoute`); the receiving one checks
  it as if the room had brought it (`receiveFromFriend`: the replay guard, who may post, who may see, which share), and
  only for what's shared between the two of you: a channel of a worktree shared with them (or by them), a share of
  one of those worktrees or of a folder shared with them, the answer to a request they made over the link. A share
  you give a room is never reachable this way. `as`: a message the worktree's owner passes on from someone else in it.
- `folder {name, label, writable, active}`: a folder you share with them (see below).

**A worktree, live for everyone in it.** Anyone it's shared with to work in (`contribute`) talks to its agent, which
runs on the owner's Mac: their message goes to the owner as `chat` plus `agent_request`, and the owner's Mac takes it as a
room request from someone invited into that workspace (`canPost`; the owner's policy and tool approvals as usual; a
request for another project, or into a worktree not shared with them, is declined). Its agent's turn goes back to
everyone in it (`agent_event`), and so does the owner's own chat. The owner's Mac passes each person's message on to
the others (`as`), so people who aren't friends with each other still see it all. Someone who only follows along
(`view`) reads but can't ask; their Mac refuses, and the owner's would too.

**Your own agent in a friend's worktree.** There, "@claude …" is your agent, not theirs (`core/shared-guest.ts`): it
runs on your Mac in a folder of its own (`~/.beluga/guest-work`), is told whose worktree it is, and reads it with
`list_peer_files` / `read_peer_file` (the worktree's share, over the link); it can't change it. Your line goes to everyone
as any message does, and its turn (`agent_event`, requested by you) goes to the owner, who takes it into the worktree's
conversation (a contributor's own agent, for their own ask only: `WorkspaceSharing.agentMayWrite`) and passes it on
(`as`). A plain line, or "@claude:<owner> …", is the owner's agent, as before. In a room-shared worktree it's the same,
your Mac telling each person directly.

The worktree's header shows each person in it, its owner first, with how they're doing (online, away, offline, "needs
an update" when their Beluga can't link with yours; someone who isn't your friend isn't known), on the owner's Mac too
(`core/friend-share-people.ts`). While the owner's Mac is offline the message box says "ata's Mac is offline: your
message goes when it's back"; a message sent then shows "Waiting for ata's Mac" under it, then "Delivered" once their
Mac took it (`delivery` in the state). The phone lists the worktree in its work view under "ata · bob-api", chats there
the same way, and its message box says the same (`ConvView.waiting`).

**A fork on your own Mac** (`fork.ts`, BLG-312). In a friend's worktree you work in (*Can work here*), **Fork to My
Mac** in its header makes it a worktree of yours: the sheet says what comes over and what stays behind, and asks for a
name. Your Mac finds the project in your Projects (your copy of a project shared whole, or your own clone of the same
repository: the `project` message carries `repo`, its https address, for that) and sends `fork_request {ws, have}`,
`have` being up to 40 of your newest branch tips. Their Mac packs `fork.tgz` in a private share only you can read and
answers `fork_ready {ws, share, size}` (or `fork_failed {ws, error}`); it says in the worktree's chat that you forked it.

- `fork.bundle`: the branch's last commit and a commit of the uncommitted work on top (made with an index of its own,
  so nothing in their worktree changes), without what `have` reaches. No bundle when you have all of it.
- `history.json`: the whole conversation; `session.jsonl`: Claude Code's session, the values of the worktree's .env
  files replaced by `[secret]`; `scratch/`: its Scratch folder (files up to 50 MB, 120 MB in all).
- Never what git ignores (node_modules, build output: the setup makes them again), nor a secret (`isDenied`).

Your Mac fetches it, makes your branch (`beluga/<name>`) at their tip, a worktree on it with the uncommitted work
left uncommitted, Scratch in place and Claude's session where Claude Code looks, so the first turn resumes it as a fork
(`forkFromSession`): your agent remembers the conversation. As with a handoff, their code only gets your .env files
and the setup when you trust them fully; otherwise the chat says so, with Terminal → Run setup. How far it got is in
the state's `forks` (asking, copying, ready with your worktree's id, failed with why); the header button follows it
(Packing…, Waiting for ata's Mac…, Copying…, then Open My Fork). The same trust rule now holds for "Runs on" › This Mac.

**Handing a worktree to a friend (BLG-341).** Hand Off lists your friends as well as the room's people with their
agent. To a friend outside your room, the room's own `ws_handoff` (note, chat, branch bundle in a private share for
them) goes over their link instead (`FriendShares.routeHandoff`), and so does their `ws_handoff_result`; each side
keeps the `hid` so only that answer is let through, and the bundle's share is fetched the way a fork's pack is (the
`outgoing`/`incoming` maps). The offer waits for an offline friend, its bundle for an hour. Once they take it, their
Mac shares the new worktree back to you over the network to follow along. Packs in an outbox (copies, forks,
handoffs) are never offered as folders. A Beluga without `share.handoff` is told before anything is sent.

**Checking first, and saying why (BLG-614).** Before a note is written or anything is committed or sent, the Mac
handing off asks `ws_handoff_check` (just the origin URL): does their Mac have that repository, and do they take work
from friends? Nobody approves it; the answer is only yes or a reason. The Hand Off sheet asks it of everyone online
as it opens (`remote.canHandOff`) and shows who can't take it and why. It goes the same way the handoff would (room,
or the friend's link via `FriendShares.routeHandoffCheck`, matched by `reqId`). No answer within 8 seconds (an older
Beluga, or someone offline) lets the handoff go ahead as before. The receiving Mac also checks for the repository
before asking you to approve. Its `ws_handoff_result` carries a `reason` (`declined`, `off`, `no_repo`,
`bad_branch`, `failed`), and the sender says it in words (`handoffProblem`); from an older Beluga, the reason is read
back out of its `error` text.

**Folders, under Files.** A folder you share with only some people (**Share a Folder** › *Only…*, which lists your
friends as well as the room's people) goes to those of them who are friends over the network as well, with no room
needed: a `folder` message, again when you change it, `active: false` when you stop or untick them. On their Mac it's in
**Files**, under your name (the top of Files is grouped by person: friends' folders, then what the room shares,
`rootRows`). Its files are read over the link with the room's own `fs_list`/`fs_read`/`fs_fetch` (256 KB pieces, `fs_chunk`)
and checked as the room checks them (`ShareService`: inside the folder, links followed, `isDenied` secrets never),
read-only unless you shared it read and write; a share you give the whole room never answers a friend this way. The
"Shared with me" sidebar section is gone: shared projects are in Projects (a room's shared worktrees too, grouped by
their project), folders in Files, which has a row of its own at the top of the sidebar. Room shares still work for the
room's people, in the same places.

**Never dropped** (`courier.ts`). Messages, requests to an agent, its questions and answers, the project's state and the
steps of a run that matter (queued, started, waiting for approval, done, failed, declined) wait in
`~/.beluga/share-outbox.json` until the friend's Mac acknowledges them: sent again every 20 s while you're linked, at
once when a link comes up, for 7 days. An agent's streamed steps and file pieces only go to someone linked now. Frames
are de-duplicated by id, and a message handed on is remembered by the replay guard, so a resend never acts twice.
