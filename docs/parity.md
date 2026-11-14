# Every way in, and where the Mac app shows it

The Mac app drives Beluga's core through `src/ipc/api.ts`. This page lists every way in and where you find it in the app. `tests/parity.test.ts` fails when a command, a UI action, a menu or an API method exists without a row here.

Columns: **Core** is the API method or intent it uses; **Mac** is where you find it.

## Slash commands

| Command | Core | Mac |
|---|---|---|
| `/invite` | the Mac's message boxes route it themselves (`src/shared/invite-route.ts`, `lib/invite-command.ts`); elsewhere `session.submit` → `runCommand` | `/invite` alone: the Add a Friend sheet (link, code, QR) · `/invite @ata` adds ata to what's on screen: a channel (`network.groups.addMember`), a DM (offers “New channel with you, X and Y”, the New Channel sheet), a project or worktree (`sharing.shareWithFriend` once it exists, through `lib/share-with-friend.ts`; until then a friend in your room gets the worktree through the room, otherwise the room's share sheet opens with a note) · `/invite @` completes your friends' names, in the chat box and in a DM's or channel's box · Sidebar footer Invite · File › Invite… · ⌘K › Add a friend… (one entry for inviting and adding a friend) |
| `/overview` | `session.submit` → `runCommand` | typed in the composer · Sidebar › Overview · Go › Overview (⌘1) |
| `/room` | `session.submit` → `runCommand` | typed in the composer · Sidebar › Channels › Group chat and ⌘K › In this room › Group chat, while someone else is in the room (alone it goes Home: the room's chat is no place of its own, BLG-871) |
| `/new` | `session.submit` → `runCommand` | typed in the composer · Sidebar project ⌥ button · File › New Worktree… (⌘⇧N) · ⌘K · empty Overview / chat › New Worktree |
| `/chat` | `session.submit` → `runCommand` | typed in the composer · Sidebar project + · File › New Chat (⌘N: in a project, a new chat on its main folder; elsewhere a chat of its own) · ⌘K › New chat in … |
| `/review` | `session.submit` → `runCommand` | typed in the composer · the right panel's Changes tab (⌥⌘1; a diff opens in full with ⌘↩) |
| `/pr` | `session.submit` → `runCommand` | typed in the composer · Toolbar PR · ⌘K |
| `/run` | `session.submit` → `runCommand` | typed in the composer · Toolbar Run (shows the terminal, keeps the keyboard in the message box) · the panel's Terminal tab ▶ · person sheet “Run a command…” |
| `/terminal` | `session.submit` → `runCommand` | typed in the composer · the right panel's Terminal tab (⌥⌘3) or the drawer under the chat (⌘J, Settings › Terminal picks which) · Go › Terminal (⌘6) |
| `/setup` | `session.submit` → `runCommand` | typed in the composer · the panel terminal's Commands… |
| `/handoff` | `session.submit` → `runCommand` | typed in the composer · Toolbar ⋯ › Hand off |
| `/model` | `session.submit` → `runCommand` | typed in the composer (`/model codex:gpt-5` picks another agent: a live conversation is handed off) · Composer agent picker (runtimes as groups, BLG-446; only models turned on in Settings › Agent › Models in chat) |
| `/search` | `session.submit` → `runCommand` | typed in the composer · Sidebar › Search · ⌘⇧F |
| `/usage` | `session.submit` → `runCommand` | typed in the composer · Sidebar › Usage (⌘5) |
| `/inbox` | `session.submit` → `runCommand` | typed in the composer · toolbar bell (notification centre) · the right panel's Info › Notifications · Go › Inbox · ⌘K › Notifications |
| `/template` | `session.submit` → `runCommand` | typed in the composer · Palette › Start from a template… |
| `/shell` | `session.submit` → `runCommand` (`/shell fish`, `default`, `login on\|off`, `args …`) | typed in the composer · Settings › Terminal › Shell |
| `/env` | `session.submit` → `runCommand` (`/env KEY=value`, `KEY=` removes, `project KEY=value`) | typed in the composer · Settings › Environment |
| `/btw` | the Mac's composer calls `session.btw` itself (the answer shows above the box, never in the chat); elsewhere `session.submit` → `runCommand` | typed in the composer: `/btw ` turns the box into a side question, ↩ asks · the answer card's ✕ or esc closes it (`session.btwDismiss`) |
| `/compact` | `session.submit` → `runCommand` | typed in the composer · Toolbar ⋯ › Compact |
| `/visualize` | `session.submit` → `runCommand` (`/graph` too): your words in the chat, the agent asked for a `beluga-graph` | typed in the composer · ⌘K › Draw This as a Graph; the graph is drawn (docs/graphs.md) |
| `/merge` | `session.submit` → `runCommand` | typed in the composer · Toolbar Merge (the main button when ready) · Workspace › Merge (⇧⌘M) |
| `/commit` | `session.submit` → `runCommand` | typed in the composer · Toolbar Commit · Workspace › Commit (⇧⌘C) |
| `/fork` | `session.submit` → `runCommand` | typed in the composer · Toolbar ⋯ › Fork |
| `/finder` | `session.submit` → `runCommand` | typed in the composer · Toolbar ⋯ › Finder · the panel's Info › Finder · Files › Show in Finder |
| `/archive` | `session.submit` → `runCommand` | typed in the composer · Toolbar ⋯ › Archive · Usage row Archive |
| `/restore` | `session.submit` → `runCommand` | typed in the composer · Archived row › Restore |
| `/delete` | `session.submit` → `runCommand` | typed in the composer · Archived row › Delete |
| `/project` | `session.submit` → `runCommand` | typed in the composer · Sidebar Projects + · File › Add Project… |
| `/copy` | `session.submit` → `runCommand` | typed in the composer · Hover on an answer › Copy · ⌘K |
| `/follow` | `session.submit` → `runCommand` | typed in the composer · Person sheet › Follow |
| `/unfollow` | `session.submit` → `runCommand` | typed in the composer · Person sheet › Stop following |
| `/open` | `session.submit` → `runCommand` | typed in the composer · Files · links in chat |
| `/get` | `session.submit` → `runCommand` | typed in the composer · Viewer › Download |
| `/close` | `session.submit` → `runCommand` | typed in the composer · Viewer › Close |
| `/stop` | `session.submit` → `runCommand` | typed in the composer · ⌘K › Stop your agent everywhere (stopping in one conversation: `host.stopRun`, Mac only) |
| `/policy` | `session.submit` → `runCommand` | typed in the composer · Settings › General |
| `/trust` | `session.submit` → `runCommand` | typed in the composer · a friend's card (their conversation › Info › Trust, the one place it's set) · the room's new-person trust card · a request's “Trust them instead” |
| `/untrust` | `session.submit` → `runCommand` | typed in the composer · a friend's card › Trust |
| `/people` | `session.submit` → `runCommand` | typed in the composer · Sidebar › Friends (your room's people are friend rows, or Not friends yet) · the room popover in the sidebar footer |
| `/share` | `session.submit` → `runCommand` | typed in the composer · File › Share a Folder… |
| `/unshare` | `session.submit` → `runCommand` | typed in the composer · Share a Folder… › Stop sharing |
| `/settings` | `session.submit` → `runCommand` | typed in the composer · Beluga › Settings… (⌘,) |
| `/name` | `session.submit` → `runCommand` | typed in the composer · Settings › General › Your name |
| `/theme` | `session.submit` → `runCommand` | typed in the composer · Settings › Appearance |
| `/zoom` | `session.submit` → `runCommand` | typed in the composer · ⌘+ / ⌘− / ⌘0 · View menu |
| `/clear` | `session.submit` → `runCommand` | typed in the composer · /clear in the composer (sheet) |
| `/plan` | `session.submit` → `runCommand` | typed in the composer · Composer Act/Plan chip (⇧Tab) |
| `/remove` | `session.submit` → `runCommand` | typed in the composer · Person sheet › Remove |
| `/newlink` | `session.submit` → `runCommand` | typed in the composer · Settings › People › New link |
| `/lock` | `session.submit` → `runCommand` | typed in the composer · Settings › People › Take new people |
| `/help` | `session.submit` → `runCommand` | typed in the composer · ⌘K (Help › Keys and Commands opens Settings › Keyboard) |
| `/quit` | `session.submit` → `runCommand` | typed in the composer · Beluga › Quit (⌘Q) · tray |

## UI actions (`UiAction`, in `src/ui/workspace-models.ts`)

| Action | Mac |
|---|---|
| `open_ws` | click (`runUiActionWith`); a project's main checkout opens its home instead (or the chat its old conversation became) |
| `toggle_project` | click (`runUiActionWith`) |
| `toggle_fold` | click (`runUiActionWith`) |
| `agents_menu` | click (`runUiActionWith`) |
| `toggle_group` | click (`runUiActionWith`) |
| `toggle_archive` | click (`runUiActionWith`) |
| `project_menu` | click (`runUiActionWith`) |
| `archived_menu` | click (`runUiActionWith`) |
| `new_worktree` | click (`runUiActionWith`) |
| `new_chat` | click (`runUiActionWith`): a new, separate chat every time (in a project, on its main folder) |
| `add_project` | click (`runUiActionWith`) |
| `view` | click (`runUiActionWith`) |
| `close_tab` | click (`runUiActionWith`) |
| `ws` | click (`runUiActionWith`) |
| `review_file` | click (`runUiActionWith`) |
| `plan_toggle` | click (`runUiActionWith`) |
| `plan_full` | click (`runUiActionWith`) |
| `open_shared` | click (`runUiActionWith`) |
| `knock` | click (`runUiActionWith`) |
| `shell_open` | click (`runUiActionWith`) |
| `shell_run` | click (`runUiActionWith`) |
| `shared_menu` | click (`runUiActionWith`) |
| `answer` | click (`runUiActionWith`) |
| `inbox` | click (`runUiActionWith`) |
| `model_menu` | click (`runUiActionWith`) |
| `template` | click (`runUiActionWith`) |
| `templates_menu` | click (`runUiActionWith`) |
| `trust` | click (`runUiActionWith`) |
| `trust_later` | click (`runUiActionWith`) |
| `search_hit` | click (`runUiActionWith`) |
| `term_tab` | click (`runUiActionWith`) |
| `term_new` | click (`runUiActionWith`) |
| `ws_more` | click (`runUiActionWith`) |
| `open_link` | click (`runUiActionWith`) |
| `paste_image` | click (`runUiActionWith`) |
| `none` | click (`runUiActionWith`) |

## Menus and dialogs (`MenuKind`, from `menuSpec`)

| Menu | Mac |
|---|---|
| `welcome` | sheet |
| `settings` | Settings window |
| `model` | model picker / sheet (models turned on in Settings › Agent › Models in chat; thinking effort for this conversation, or Settings’ when it isn’t pinned) |
| `inbox` | notification centre under the toolbar bell: the same filters and groups, click to go there, hover for read/unread and ×, Mark all read, Clear all |
| `person` | the room card (`RoomPeerCard`), beside their row in Friends (a friend in your room, or Not friends yet) or the room popover's people: Message / Ask Your Agent / Run / Follow / Files buttons, their trust as a line with “Change in their card…” (a friend: their conversation's Info, the one place trust is set) or “Add as a friend”, Remove with an alert; you are your account card (name, who may use your agent), from the room popover. Right-click: Trust (read-only), Change in Their Card… / Add as Friend, and the same actions |
| `confirm` | sheet |
| `project` | sheet and right-click menu |
| `archived` | sheet and right-click menu |
| `agents` | sheet |
| `ws_share` | Share sheet: everyone in the room with an access popup (Can work here / Can follow / No access), Invite by Link… |
| `shared` | sheet (Chat / Files / Changes, who's in it, Leave… with an alert; the people button on its toolbar) and right-click menu |
| `clear` | sheet |
| `invite_person` | sheet: workspaces with Invite buttons, Work here / Follow |
| `share_folder` | Share a Folder sheet: the Open panel (or a path), your projects, who sees it (everyone or only some people), the agent may edit, what you share now with Stop Sharing |
| `share_who` | the Share a Folder sheet with the folder filled in |
| `pr` | sheet |
| `scripts` | sheet |
| `templates` | sheet |
| `handoff` | sheet |
| `remote_ws` | sheet |
| `ws_more` | sheet |
| `invite_link` | Invite People sheet (the room's own links: the room popover's Invite, the room panel, Hand Off's “invite someone”; `/invite` and File › Invite… add a friend instead): Invite to popup, They can (Watch / Prompt / Edit), link checkboxes, Copy Invite Link (Return, says Copied), how they join, people waiting, active links with Copy and Revoke |
| `guest_add` | the guest's card: Add ▾ beside the projects they're in |

## API methods

| Method | Mac |
|---|---|
| `session.submit` | ✓ |
| `session.copyInvite` | ✓ |
| `session.copyLastAnswer` | ✓ |
| `session.copyText` | ✓ |
| `session.setPrefs` | ✓ |
| `session.setPlanMode` | ✓ |
| `session.compact` | ✓ (context meter › Compact now) |
| `session.btw` | ✓ (`/btw` in the composer: the side-question card above the box) |
| `session.btwDismiss` | ✓ (the side-question card's ✕, or esc) |
| `session.react` | ✓ hover a person's message in the group chat or a worktree's chat › the smiley-plus button (quick row, More for every emoji); click a chip under it to add or take back yours |
| `session.setClaudeSharing` | ✓ |
| `session.rename` | ✓ |
| `session.zoom` | ✓ |
| `session.shareFolder` | ✓ |
| `session.unshareFolder` | ✓ |
| `session.follow` | ✓ |
| `session.clearChat` | ✓ |
| `session.removePerson` | ✓ |
| `session.newInviteLink` | ✓ |
| `session.setRoomOpen` | ✓ |
| `session.setFriendWorktrees` | ✓ |
| `session.setAccess` | ✓ |
| `session.runOnPeerByHand` | ✓ |
| `session.stopAgent` | ✓ |
| `session.quit` | ✓ |
| `session.serveFolder` | ✓ |
| `session.localLocation` | ✓ |
| `session.testNotification` | ✓ |
| `session.retryConnection` | ✓ Retry now in the connection status |
| `host.answerApproval` | ✓ |
| `host.promote` | ✓ |
| `host.sendNext` | ✓ Send Now on a queued message (runs it next, never interrupting) |
| `host.steerNow` | ✓ Send now on a steered message the agent hasn't read yet · ⇧⌥↩ (stops its step, your message is next) |
| `host.cancelSteer` | ✓ Cancel on a steered message the agent hasn't read yet (taken back, its words back in the box) |
| `host.stopRun` | ■ Stop beside Queue/Steer · ⌘. · Conversation › Stop the Agent · Stop on a running answer |
| `threads.stop` | Right panel › Threads › Stop on a running thread; on the phone, a chat's ••• › Threads › Stop |
| `threads.stopAll` | Right panel › Threads › ••• › Stop All Running; on the phone, a chat's ••• › Threads › Stop all running |
| `host.cancelQueued` | ✓ |
| `host.reorderQueued` | ✓ queue tray ↑ ↓ |
| `inbox.read` | ✓ |
| `inbox.unread` | ✓ |
| `inbox.clear` | ✓ (all, or × on one) |
| `questions.answer` | ✓ |
| `questions.pick` | ✓ |
| `people.setTrust` | ✓ |
| `people.dismissPrompt` | ✓ |
| `needs.dismiss` | ✓ Dismiss in a waiting item's right-click menu (the bell's Waiting for you); on the phone, Dismiss on a needs-you card |
| `people.forget` | ✓ |
| `sharing.invite` | ✓ |
| `sharing.remove` | ✓ |
| `sharing.leave` | ✓ |
| `sharing.shareWithFriend` | ✓ project ••• › Share with… (pick friends and a role) · `/invite @friend` in a project or worktree · a team project's conversation ••• › Share with Team ▸ (a teammate, or Everyone on the Team: that one worktree, live) |
| `sharing.unshareFriend` | ✓ Share with… › No access · a team project's conversation ••• › Stop Sharing (or untick a teammate under Share with Team ▸) |
| `sharing.leaveProject` | ✓ a shared project's ••• › Leave Project |
| `sharing.copyProject` | ✓ a shared project's ••• › Copy to This Mac Again (it copies by itself when shared whole) |
| `sharing.scratch` | ✓ a friend's worktree's Scratch tab |
| `sharing.earlier` | ✓ scrolling back in a friend's worktree |
| `sharing.runHere` | ✓ a friend's worktree's "Runs on" chip › This Mac |
| `sharing.fork` | ✓ a friend's worktree's header › Fork to My Mac (a sheet: what comes over, what stays behind, a name), Getting <project>… while a project not on this Mac yet is cloned or copied first, then Open My Fork |
| `invites.create` | ✓ |
| `invites.revoke` | ✓ |
| `invites.copyLink` | ✓ |
| `invites.letIn` | ✓ |
| `invites.decline` | ✓ |
| `invites.change` | ✓ |
| `invites.remove` | ✓ |
| `remote.requestWorktree` | ✓ |
| `remote.handoff` | ✓ |
| `remote.canHandOff` | ✓ the Hand Off sheet, as it opens: who can't take it and why |
| `diff.load` | ✓ |
| `diff.select` | ✓ |
| `shell.run` | ✓ the search field over a shared workspace's Files (find + grep) |
| `shell.openEntry` | – (the Files tab opens files directly) |
| `files.browseTo` | ✓ |
| `files.enter` | ✓ |
| `files.up` | ✓ |
| `files.loadDir` | ✓ |
| `files.open` | ✓ |
| `files.openSpec` | ✓ |
| `files.download` | ✓ · `to`: Save… dialog |
| `files.downloadSpec` | ✓ |
| `files.closeViewer` | ✓ |
| `files.readImage` | ✓ |
| `files.readImageFile` | ✓ images in the Markdown reader (`![](diagram.png)` next to the file); PDFs drawn page by page in Files, Changes and the reader; videos (MP4, M4V, MOV, WebM, up to 64 MB) played inline in the reader with play, pause and seek |
| `files.version` | ✓ (no surface of its own) a picture in a chat answer or the Markdown reader is read again when its file was rewritten since it was kept, so a screenshot re-taken to the same name shows the new one |
| `workspaces.scratch` | ✓ the panel's Scratch tab: the workspace's `.beluga/scratch/` and `.context/` folders, newest first, live, with how many files there are and how much they hold; the preview shows the newest until you pick one, and a file scrolled to its end (or Follow the End) follows what's written to it; drawn in outline (moving while the agent works) until something lands; the sort menu puts what can be looked at first (pictures, videos, PDFs, web pages; BLG-111), web pages are drawn in a sandboxed frame (no scripts), and full size ← → steps through the viewable files in that order, stopping at the ends; the images and files you sent the agent are copied into `.beluga/scratch/sent/` as it gets the message, and listed apart under From Your Agent · Sent by You (BLG-771; never on the new-file dot or the phone's outputs; an archive throws them away, deleting a chat its own `sent/<chat>/`) |
| `files.read` | ✓ a changed file as itself in Changes (Markdown formatted), without moving the Files tab's open file |
| `files.readRange` | ✓ (no surface of its own) a file read in pieces: a changed file's first screen, the rest of a big file as you scroll the reader, and the file under the pointer read ahead (on a computer, answered from this Mac's cache) |
| `files.searchContent` | ✓ the Files tab's search box on Contents: lines by file (ripgrep, else Node), Match Case / Whole Word / Regular Expression; a line opens the file there |
| `files.searchNames` | ✓ the Files tab's search box on Names: every file in the folder whose path matches (ripgrep's list, else git's), Match Case / Whole Word / Regular Expression; shown as a tree, a file opens |
| `files.save` | ✓ Edit in a file's header (files open read-only), then Save or ⌘S; asks before overwriting a change made since |
| `files.formatter` | ✓ whether a file's Format button is on (the project's Prettier), and why not in its tooltip |
| `files.format` | ✓ Format (the wand) in a file's header: the project's Prettier lays out the text you're editing (Save writes it) |
| `companion.pair.start` | ✓ the sidebar footer's phone mark › Pair a Phone…: a one-time pairing (QR and code, 10 minutes, one phone) |
| `companion.pair.approve` | ✓ the Phone popover's “Pair Kayra's Pixel 9?” with the four-picture fingerprint › Pair |
| `companion.pair.cancel` | ✓ the Phone popover's Cancel while a pairing is open (a waiting phone hears no) |
| `companion.devices.remove` | ✓ the Phone popover › a phone › Remove (its link drops at once, its key is refused from then on) |
| `machines.pair.start` | – on the computer: `beluga pair --computer` prints its link, code and QR (one app, 10 minutes, BLG-774) |
| `machines.pair.status` | – on the computer: `beluga pair --computer` follows it (the app waiting, its four pictures, joined) |
| `machines.pair.cancel` | – on the computer: Ctrl+C in `beluga pair --computer` |
| `machines.join.start` | ✓ Settings › Your Computers › Add a Computer… › Link or Code › Add (also `beluga computers add <link or code>`) |
| `machines.join.approve` | ✓ Settings › Your Computers › Add a Computer… › Join, after the four pictures (also `beluga computers add`'s Add? [y/N]) |
| `machines.join.cancel` | ✓ Settings › Your Computers › Add a Computer… › Cancel (also `beluga computers add`'s no or Ctrl+C) |
| `machines.ssh.hosts` | ✓ Settings › Your Computers › Add a Computer… › Over SSH: your hosts to pick from |
| `machines.ssh.pair` | ✓ Settings › Your Computers › Add a Computer… › Over SSH › Add: Beluga installed and started there when missing, the pictures checked over SSH and here (also `beluga connect you@host --pair`) |
| `machines.update` | ✓ Settings › Your Computers › a computer on an older version › Update It, and the update sheet's Update … First |
| `machines.leftBehind` | ✓ the update sheet (Beluga … is ready) warns which computers that update would leave unable to connect |
| `machines.look` | ✓ Settings › Your Computers › a computer › its name (rename in place) and its icon |
| `machines.placement` | ✓ Settings › Your Computers › Run New Work On: where new work goes now, and why |
| `machines.list` | ✓ Settings › Your Computers: each computer's icon, name, kind and region, online or offline, its load and health with fixes (also `beluga computers`) |
| `machines.devices` | – `beluga computers` on a computer: the apps and phones that may drive it (docs/machines.md) |
| `machines.secrets` | ✓ Settings › Your Computers › a computer › ••• › Keep My Secrets in Sync With… (asked once for it) / Stop Syncing My Secrets |
| `machines.settingsSync` | ✓ Settings › Your Computers › Your Settings: they follow you to every computer, and a conflict is said |
| `machines.settingsSync.clear` | ✓ Settings › Your Computers › Your Settings › a conflict's Got It |
| `machines.alwaysOn` | ✓ Settings › Your Computers › a computer › ••• › Make Always On… (one confirmation, and Run New Work On There Too), and Make This Mac Always On under You on the Network |
| `machines.alwaysOn.status` | ✓ Settings › Your Computers › You on the Network: this Mac or your Always On, and a move under way; the Always On tag on its computer |
| `machines.forget` | ✓ Settings › Your Computers › a computer › ••• › Forget (also `beluga computers forget <name>` on any of your devices) |
| `machines.ready.start` | ✓ a new worktree, plan or sentinel sent to a computer that doesn't have the project: Getting … ready, on the new worktree (BLG-787, BLG-788) |
| `machines.ready.status` | ✓ the same, each step as it goes (folder, clone, tools, setup) and any error in plain words |
| `machines.ready.install` | ✓ the same: Install Them, after what's missing there is named |
| `machines.ports` | – asked by your app over a computer's link every few seconds (BLG-802): each worktree's dev servers there |
| `machines.forwards` | ✓ a worktree on a computer › the panel's Background tab › Ports: each server with Open at localhost:<port>, and which port when the same was taken |
| `machines.share` | ✓ a worktree on a computer › the panel's Background tab › Share a Port from This Mac: a port and Share |
| `machines.unshare` | ✓ a worktree on a computer › Background › a port shared from this Mac › Unshare |
| `machines.upload.put` | – asked by your app over a computer's link (BLG-793): one piece of a file you dropped on a chat there, written into its uploads |
| `machines.upload.send` | ✓ a file dropped from Finder on a chat that runs on a computer: sent there a piece at a time, its progress in the box (BLG-793) |
| `machines.upload.check` | ✓ (no surface of its own) files dropped on a chat on a computer, checked first: an env file asks (Send Once or Don't Send, its name only), a key or a credential folder's file is refused with why (BLG-854) |
| `machines.download.piece` | – asked by your app over a computer's link (BLG-794): a piece of a file there for Download |
| `machines.download.fetch` | ✓ Download on a computer's page: Show in Finder for a file there brings it to ~/Downloads/Beluga and shows it in Finder (BLG-794) |
| `machines.editor` | ✓ (no surface of its own) which editor Open in Editor uses for a computer's folder over Remote-SSH: VS Code or Cursor (BLG-794) |
| `machines.env.here` | – asked by your app over a computer's link when a worktree is made there (BLG-800): the project and the env file names its folder has |
| `machines.env.receive` | – your app sends the env files you said to send over the computer's link; written 0600 there |
| `machines.env.decide` | ✓ a worktree made on a computer, in its conversation and on the project's page: the env file names, Send Once, Don't Send, ••• › Always for This Project |
| `machines.env.always` | ✓ Settings › Your Computers › Env files sent without asking |
| `machines.env.forget` | ✓ Settings › Your Computers › Env files sent without asking › Ask Again |
| `companion.phone.use` | ✓ Settings › Phone › Let your agent use this phone: Off · Ask each time · Use · Full (BLG-150) |
| `companion.phone.pairAdb` | ✓ Settings › Phone › Connect, once the phone shows a Wireless-debugging pairing code (runs `adb pair`) |
| `companion.phone.wifi` | ✓ Settings › Phone › Over Wi‑Fi: Use over Wi‑Fi while the phone is on a cable (turns on its Wireless debugging, reached through the link), or Turn Off (BLG-187) |
| `companion.phone.setUpLink` | ✓ Settings › Phone › Beluga Link › Set Up Beluga Link, while the phone lacks Link and adb reaches it (a cable or Wireless debugging): installs it and turns on its Accessibility (BLG-391) |
| `companion.phone.pairCable` | ✓ Settings › Phone › On the cable › Pair over the Cable, when Beluga is on the plugged-in phone but it isn't paired with this Mac (BLG-190) |
| `companion.phone.settings` | ✓ Settings › Phone › On the cable › Open on the Phone, while USB debugging is off: the phone shows its Developer options, or About phone (BLG-190) |
| `companion.phone.act` | ✓ the Your phone page's live mirror (full size, from the Phone tab’s ⤢ in Your Mac’s panel, BLG-196, BLG-292): click to tap, drag to swipe, the hardware-key buttons, the type line (BLG-171) |
| `companion.phone.macros` | ✓ the Your phone page's Macros strip: the saved flows (BLG-175) |
| `companion.phone.macroRun` | ✓ the Your phone page's Macros strip › Run |
| `companion.phone.macroDelete` | ✓ the Your phone page's Macros strip › a macro's × |
| `companion.older` | – the phone only: older turns of a conversation (or messages of a chat) as you scroll up (docs/companion.md) |
| `companion.ask` | – the phone only: Ask your Mac (a question in a project, as New Chat does, or a message in a conversation, Your Mac's `conv:mac:assistant` included), with photos and files the phone sent (`put`) |
| `companion.post` | – the phone only: a message in a friends' chat with files from the phone |
| `companion.askPerson` | – the phone only: ask a friend's agent yourself, as from their card in Requests (their approval and trust rules apply) |
| `companion.keepAwake` | Settings › Phone › Keep this Mac awake (the phone's Settings has the same switch) |
| `companion.defaultAgent` | Usage › a provider's card › Make default (the phone's usage cards have the same chip) |
| `companion.signOut` | – the phone only: Sign Out removes that phone's own certificate (the Mac's Remove is `companion.devices.remove`) |
| `companion.openOnMac` | – the phone only: ••• › Open on your Mac brings this window to the front on that conversation, plan or task (the window's `raise` capability and a navigate intent) |
| `companion.icon` | – the phone only: a project's icon, small, by the checksum its views carry (the Mac shows `projects.icon`) |
| `companion.mergeCheck` | – the phone only: the Merge sheet's checks (the Mac's own: `git.mergePreview` and its review) |
| `companion.merge` | – the phone only: Merge from a worktree's •••, the Mac's own merge (`workspaces.merge`), its progress in the conversation |
| `companion.resolve` | – the phone only: Ask Your Agent to resolve, as the Mac's Solve merge conflict (`workspaces.askClaudeToMerge`) |
| `companion.branchStep` | – the phone only: the branch band's steps in a worktree's conversation (Archive, Continue After Merge, Squash and Merge, Fix Checks…, Push, Re-run Failed Checks…), as the Mac's toolbar branch control does them; for Archive and Delete, also what happens to the chat's threads |
| `companion.viewFetch` | – the phone only: a live view's rows in a conversation, run here as `view.fetch` runs them for the window |
| `companion.draftTask` | – the phone only: New task by describing it, the agent's draft shown before it's added (the Mac's describe-to-create is `board.create`) |
| `companion.addTask` | – the phone only: the draft added as a task |
| `companion.files.list` | – the phone only: a worktree's folder, read-only, through the companion's file gate (the Mac's Files tab reads the folder itself) |
| `companion.files.find` | – the phone only: a worktree's files by name (the Mac's Files tab filters its tree) |
| `companion.files.read` | – the phone only: a page of a worktree's file, read-only, secrets refused |
| `companion.terminals` | – the phone only: a worktree's terminals, as the terminal dock's tabs list them |
| `companion.termOpen` | – the phone only: a worktree's shell (or a new one) for the phone to stream, the session the dock shows (`terminals.shell`, `terminals.global`) |
| `companion.termClose` | – the phone only: ends a worktree's terminal for every screen, as the dock's × (`terminals.close`) |
| `companion.subAgent` | – the phone only: a sub-agent's sheet, its activity in words and the report it gave back (the Mac's sub-agent page reads its transcript itself) |
| `companion.gone` | – the phone only: which conversations it saved files from were archived or deleted on the Mac, so it removes those files (the Mac archives and deletes them itself) |
| `companion.voice` | – the phone only: Settings › Voice, which of the Mac's voice models are here or coming (the Mac app has no microphone) |
| `companion.voicePrepare` | – the phone only: Settings › Voice, get a model on the Mac now |
| `companion.transcribe` | – the phone only: the Ask sheet's microphone, On your Mac: the recording written down here and deleted |
| `external.status` | Settings › External agents, and `beluga mcp status` |
| `external.setEnabled` | Settings › External agents, and `beluga mcp on` / `off` |
| `external.setRoute` | Settings › External agents › On your tailnet and Public address, and `beluga mcp on --tailscale` / `--public` |
| `external.pairingCode` | Settings › External agents › Make a code, and `beluga mcp pair` |
| `external.localToken` | `beluga mcp token`, with its card on the Mac |
| `external.agents` | Settings › External agents: the list, and `beluga mcp agents` |
| `external.revoke` | Settings › External agents › Revoke, and `beluga mcp revoke` |
| `external.resume` | Settings › External agents › Resume, and `beluga mcp resume` |
| `external.stopAgent` | The driven-by strip, Settings › External agents › Stop, and the phone's External agents |
| `external.stopAll` | Settings › External agents › Stop All, and the phone's External agents |
| `external.setPaused` | Settings › External agents › Pause All |
| `external.activity` | Settings › External agents › Activity, and the phone's External agents |
| `voice.models` | Settings › Voice: the models on this Mac, here or coming |
| `voice.prepare` | Settings › Voice › Get now |
| `voice.load` | – asked by a call's window now and then: how busy this Mac is, to decide who writes down whose words (BLG-718) |
| `voice.transcribe` | The composer's microphone beside Send, and the talk shortcut (Settings › Voice) |
| `calls.start` | A DM's, channel's or room's header › the phone button: rings everyone in it (BLG-706, BLG-716) |
| `calls.join` | The incoming call card's Join, the floating card's Join, the call strip's Join on a call going on; the phone's Needs you › Answer on Mac |
| `calls.leave` | The call strip's red Leave, the sidebar's call pill and the floating card's Leave |
| `calls.decline` | The incoming call card's and the floating card's Decline; the phone's Needs you › Decline |
| `calls.set` | The call strip's Mute, Camera and Share buttons (and the window says it's still in the call every few seconds) |
| `calls.signal` | – sent by the call's window on its own: WebRTC setup for the others' windows |
| `calls.notes` | – sent by the call's window as you leave: your own words, written down on this Mac, for the others who were in it (BLG-715) |
| `calls.forgetNotes` | A call's notes box in the chat › ••• › Forget These Notes |
| `calls.list` | – the shared state's `network.calls` is what screens show; this answers the CLI and tests |
| `terminalImport.detect` | Settings › Terminal › Import from… (Ghostty, iTerm2, Terminal, Alacritty, kitty, WezTerm, Warp), and the welcome's “Coming from another terminal?” step |
| `workspaces.open` | ✓ |
| `workspaces.load` | Overview › Archived › Read Conversation (read-only, stays in the Overview) |
| `workspaces.refresh` | ✓ |
| `workspaces.newWorktree` | ✓ |
| `workspaces.newChat` | ✓ |
| `workspaces.startChat` | ✓ New chat composer: starts on the first message with the selected Act/Plan mode |
| `workspaces.startWorktree` | ✓ (→ the new worktree's id; `plan`: its agent plans first; `tasks`: Plan with Tasks, its conversation is a draft plan's home (the home composer's new worktree mode menu); `quiet`: the window stays put; `agent`: who works it, from the home composer's Create Worktree ▾ › Start with ▸ (BLG-506). The phone's Ask › a project › Worktree, with Plan first, since 1.5, and its agent chip (1.35); Your Mac's `start_worktree`) |
| `workspaces.branches` | New worktree › Based on popup |
| `workspaces.fork` | ✓ |
| `workspaces.editPrompt` | Edit on your own message (hover, or right-click › Edit Message) › the message opens in place: Rewind Here or New Fork, then ↩ |
| `workspaces.continueInWorktree` | Continue in New Worktree… (toolbar and the ask banner) › sheet: Task, Based on, Agent (BLG-506: one that can't resume the conversation starts fresh, handed it, and the sheet says so), Name (the chat becomes the worktree) |
| `workspaces.archive` | ✓ |
| `workspaces.moveCheck` | ✓ a worktree's ⋯ › Continue On ▸ (a computer): it asks first about changes not committed (Commit Them and Continue) and waits for its agent's turn to end |
| `workspaces.movePack` | ✓ a worktree's ⋯ › Continue On ▸, on the computer it's on (its branch pushed, or bundled over the link) |
| `workspaces.moveChunk` | ✓ a worktree's ⋯ › Continue On ▸ (your app fetches it in pieces) |
| `workspaces.moveReceive` | ✓ a worktree's ⋯ › Continue On ▸, on the computer it goes to |
| `workspaces.moveLand` | ✓ a worktree's ⋯ › Continue On ▸: a worktree there on its branch with its conversation (the .env ask follows, as for any new one) |
| `workspaces.moveDone` | ✓ a worktree's ⋯ › Continue On ▸: the old one archived once the new one is there (Continued on … in its details) |
| `workspaces.moveUndo` | ✓ a worktree's ⋯ › Continue On ▸: a new one whose move didn't finish is archived again |
| `workspaces.restore` | ✓ |
| `workspaces.archivePlan` | ✓ the Archive dialog says how much space it frees |
| `workspaces.deletePlan` | ✓ the Delete dialog says how many commits were never pushed or merged, and leads with Archive (the phone's Delete step says it too) |
| `workspaces.freeSpace` | ✓ Free Up Space on a worktree: clears its dependencies, builds and caches |
| `workspaces.remove` | ✓ |
| `workspaces.commit` | ✓ |
| `workspaces.merge` | ✓ |
| `workspaces.prepareRemoval` | ✓ |
| `workspaces.applyEnvBack` | ✓ (and Copy to Main Folder on a worktree's env bar; Archive/Delete's “Also remove … there” takes removed keys out too) |
| `workspaces.keepEnvHere` | ✓ a worktree's env bar ••• › Keep in This Worktree Only (project page, worktree) |
| `workspaces.saveEnvInBeluga` | ✓ Save in Beluga on a worktree's env bar, and Archive/Delete's “Save them in Beluga” |
| `workspaces.checkEnv` | ✓ when a project's page or a worktree opens |
| `workspaces.ports` | – the ports a worktree's servers listen on, for forwarding a computer's to this Mac (the Ports tab is BLG-802) |
| `workspaces.askClaudeToReview` | ✓ |
| `workspaces.askClaudeToMerge` | ✓ |
| `workspaces.compact` | ✓ |
| `workspaces.openInFinder` | ✓ |
| `workspaces.setGroup` | ✓ |
| `workspaces.renameGroup` | ✓ (group row › Rename) |
| `workspaces.rename` | ✓ (chat or worktree row context menu › Rename…; inline edit, Enter or clicking away saves, Escape cancels; a worktree’s own branch takes the name unless it’s pushed, and a name with a / is that exact branch) |
| `workspaces.regenerateTitle` | ✓ (chat row context menu › Regenerate title; uses recent chat content, keeps the agent session, and protects the result as a manual name; errors leave the old title) |
| `workspaces.ungroup` | ✓ (group row › Ungroup / Delete Group) |
| `workspaces.arrange` | drag projects and groups in the sidebar, Move Up / Move Down (⌃⌘↑/↓), Move to Group ▸ |
| `workspaces.newGroup` | Projects + › New Group, right-click › New Group, Move to Group ▸ New Group… |
| `workspaces.showProject` | Hidden Projects in the sidebar, Settings › Workspaces, the Add Projects sheet's Show |
| `workspaces.hideProject` | ✓ |
| `workspaces.cleanAgentWorktrees` | ✓ |
| `workspaces.otherOrigins` | who made each worktree made outside Beluga (picks the right conversation; never shown as a tool's name) |
| `workspaces.otherActivity` | worktrees made outside Beluga listed after a project's own, most recently active first (5, then Show N more) |
| `workspaces.worktreeInfo` | the page a worktree from another tool shows when it has no conversation (or About This Worktree) |
| `workspaces.showConversation` | that page › Earlier conversations › Show |
| `workspaces.outsideConversations` | project ••• › Import from Claude Code… (the project's folder and the folders inside it; Choose Another Folder…) |
| `workspaces.importOutside` | that sheet › Continue in a Worktree (one brought in already: Open Its Worktree) |
| `workspaces.removeOther` | that page › Remove Worktree… (asks first; keeps the branch) |
| `workspaces.staleOthers` | a project's Clean Up Worktrees… (its right-click menu and its home) |
| `workspaces.cleanUpOthers` | Clean Up Worktrees… › Remove (only what you ticked; branches kept) |
| `workspaces.addProject` | ✓ |
| `workspaces.removeProject` | a project's ⋯ / right-click menu › Delete Project… (out of Beluga; its folder goes to the Trash only if ticked) |
| `workspaces.addFolder` | ✓ |
| `workspaces.selectFile` | ✓ |
| `workspaces.diffAhead` | ✓ (no surface of its own) the changed file under the pointer in Changes: its diff worked out ahead, so the click shows it at once (BLG-853) |
| `workspaces.review` | the right panel's Changes tab (loads and refreshes the changes while you stay in the chat) |
| `workbench.run` | ✓ |
| `workbench.stopRun` | ✓ |
| `workbench.runSetup` | ✓ |
| `workbench.setScript` | ✓ |
| `workbench.shareScripts` | ✓ |
| `workbench.setModel` | ✓ (the composer's agent picker: a model of the same runtime, for this conversation or new ones; only models turned on in Settings › Agent › Models in chat; the phone's picker since 1.32) |
| `workbench.setEffort` | ✓ (Mac composer only: a conversation’s thinking effort; `''` clears it so Settings apply; the phone does not set effort) |
| `workbench.setAgent` | ✓ (the agent picker's other runtimes, grouped Claude › Codex › Local model; a runtime this Mac doesn't run is greyed with why; the phone's picker since 1.32) |
| `workbench.createPr` | ✓ |
| `workbench.quickPr` | ✓ the toolbar's Create PR (and Create Draft PR under its chevron; in a fork, Create PR on the original too: pushed to the fork, opened on the repository it was forked from; on someone's fork's pull request that can't be pushed to, Open Your Own PR), the Changes panel's Create PR |
| `workbench.mergeToBase` | ✓ the branch control's chevron › Merge into main… (no PR yet, on GitHub): asks first, then lands the branch on origin's base and pushes |
| `workbench.gitFix` | ✓ the GitHub trouble card that a failed Create PR, Merge or Update Branch opens (Push over HTTPS, Log In to GitHub, Install GitHub CLI, the SSH steps under •••) |
| `workbench.signInClaude` | ✓ Sign In on a failed Claude card that says Claude Code isn’t signed in or its sign-in expired: a menu of a Claude subscription, an Anthropic Console account (runs `claude auth login --claudeai` or `--console` in a shell, then Claude continues) or a 3rd-party platform (opens its setup page) |
| `workbench.fixChecks` | ✓ the toolbar's branch state › Fix Checks… (the PR's checks failed and nothing still runs); while they run it says Checks running, calm, with Fix Checks… under its chevron |
| `workbench.resolvePrConflicts` | ✓ Resolve Conflicts… (the toolbar's branch state "Conflicts with main", folded "Resolve Conflicts"; PR sheet, the PR strip above the chat) when GitHub says the PR conflicts (never while GitHub is still working it out) |
| `workbench.continueAfterMerge` | ✓ Continue After Merge… (⋯, PR sheet, the PR strip) once the PR merged; the chat then shows a divider where that PR ends (the phone shows its words). A merge itself (Merge, Merge When Ready, on GitHub or anywhere else, Merge into its base, into the main folder) draws its own line in the chat as it's seen, “Above was merged into main in PR #N”, also on the phone; one that merged while Beluga was closed shows on the next start if nothing was said there since |
| `workbench.openPr` | ✓ |
| `workbench.refreshPrs` | ✓ |
| `workbench.mergePr` | ✓ the PR sheet › Merge on GitHub (squash, merge or rebase; Merge When Checks Pass; Merge Now, Skipping Checks), also in the PR strip above the chat. With commits here the PR doesn't have it's Push and Merge: the daemon pushes them first and merges only the head that has them (BLG-840), on the Mac and the phone alike |
| `workbench.prStep` | ✓ the toolbar's branch state › Update Branch (the PR is behind its base), Mark Ready for Review (a draft) |
| `workbench.pushPr` | ✓ the toolbar's branch state "N commits not on PR #n" › Push N Commits to PR #n: the worktree has commits its open PR doesn't, so merging would leave them out and GitHub's checks and conflicts are for an older commit (its menu: Push and Merge When Ready; the sidebar row's ↑N chip says the same; phone: the branch band's Push). Someone's fork's pull request goes to the fork's branch when its author lets maintainers edit it; otherwise the step is Open Your Own PR |
| `workbench.rerunChecks` | ✓ the toolbar's branch state "Checks failed" › its chevron › Re-run Failed Checks (`gh run rerun --failed`, for a flaky test; phone: the branch band's ••• too) |
| `workbench.prConversation` | ✓ the PR page (the PR strip's comments count, or the PR sheet's Comments): comments, reviews and threads on lines with their code; a `beluga-pr-comments` block in chat shows them read-only (phone: not yet) |
| `workbench.prPost` | ✓ the PR page: Reply in a thread, Resolve / Reopen, and a comment on the PR |
| `workbench.addressPrComments` | ✓ the PR page: Ask Claude (one thread) and Address All With Claude |
| `workbench.excerpt` | ✓ a `beluga-code` block in chat draws those lines of the worktree, highlighted; its path goes to the file at that line |
| `workbench.openCode` | ✓ Open in Editor on a `beluga-code` block or a PR thread (Cursor, VS Code or Zed at the line, else the default app) |
| `workbench.cancelMergeWhenReady` | ✓ the toolbar's branch state › Cancel Auto-Merge (while Merge When Ready waits) |
| `workbench.editPrPrompt` | ✓ |
| `workbench.resetPrPrompt` | ✓ |
| `workbench.measureDisk` | ✓ |
| `workbench.checkAgents` | ✓ Check Again on onboarding's Your agents step and in Settings › Agent › Your agents; Look Again under OpenCode's models in the agent picker, after adding a provider |
| `workbench.agentSignIn` | ✓ Sign In beside an agent that isn't signed in (onboarding, Settings › Agent); Add a provider under OpenCode's models in the agent picker (DeepSeek, Kimi…) |
| `workbench.search` | ✓ |
| `workbench.openHit` | ✓ |
| `workbench.saveTemplate` | ✓ |
| `workbench.removeTemplate` | ✓ |
| `terminals.shell` | ✓ |
| `terminals.global` | ✓ |
| `terminals.close` | ✓ |
| `terminals.restart` | ✓ the terminal's "started before your variables changed · Restart" |
| `terminals.rename` | ✓ double-click a shell tab, or right-click › Rename… (Return saves, Escape cancels, empty resets) |
| `agentTerm.open` | ✓ with Settings › Terminal › Advanced on: the Chat · Terminal · Both switch in a worktree's or chat's header (or ⇧⌘T): the agent's own terminal app on the same conversation (BLG-534) |
| `agentTerm.takeOver` | ✓ Take over on the chat's “The terminal is driving” banner; closing the terminal (phone: Take over on the conversation's banner) |
| `agentTerm.visual` | ✓ a graph or view link in the terminal, or ⌘↩ for the newest: opens it in the panel beside the terminal (BLG-535) |
| `env.get` | ✓ Settings › Environment (yours), and a project's Settings › Environment tab (••• › Environment…, the project page's pill and Environment section, Settings › Environment's project list) (values only go to the screen that asks) |
| `env.set` | ✓ Settings › Environment, and a project's Settings › Environment tab |
| `env.importDotenv` | ✓ a project's Environment › Keep a Copy in Beluga |
| `env.newKeysBack` | ✓ a project's Settings › Worktrees tab › New keys go to the main folder |
| `env.worktree` | ✓ a worktree's ••• › Environment… (and its row in the project's Settings › Worktrees tab and Environment section): its own variables, with what it gets from below greyed (BLG-924) |
| `env.setWorktree` | ✓ a worktree's ••• › Environment… |
| `env.carryWorktree` | ✓ Archive/Delete a worktree with variables of its own: “Carry its variables to the project” (on) |
| `env.overview` | ✓ the project page's Environment section: names and counts, never a value (BLG-926) |
| `env.addToExample` | ✓ a project's Environment tab and Environment section, when worktrees don't keep it in step: Add to .env.example / Create .env.example (placeholders, never values; BLG-925) |
| `env.exampleSync` | ✓ a project's Settings › Worktrees tab › Keep .env.example in step |
| `env.endpoints` | ✓ Settings › Claude › Local models |
| `env.saveEndpoint` | ✓ Settings › Claude › Local models › Add Endpoint / Save |
| `env.removeEndpoint` | ✓ Settings › Claude › Local models › Remove |
| `env.checkEndpoints` | ✓ Settings › Claude › Local models › Check Again |
| `env.testDatabase` | ✓ Settings › Environment › Database (Test Connection) |
| `env.claudeDotenv` | ✓ Settings › Environment › Your agent (and a .env approval's Always) |
| `attachments.add` | ✓ |
| `attachments.addFile` | ✓ a pasted path of an image becomes a waiting thumbnail |
| `attachments.reattach` | ✓ a queued message pulled back to edit gets its images back as thumbnails |
| `attachments.expand` | ✓ |
| `attachments.read` | ✓ images shown in messages |
| `attachments.open` | ✓ image full size › Open (in Preview) |
| `daemon.stop` | ✓ |
| `local.listDirs` | ✓ |
| `local.browse` | ✓ in a browser the web port served: the folder picker (Add Project › Choose Folders…, New Project › Change…, Share a Folder, Settings › People & access › Add Folder…; `dialogs/FolderBrowser.tsx`) |
| `local.openFolder` | ✓ |
| `local.statFiles` | ✓ ⌘V of file paths attaches the files (⌘⇧V keeps the words) |
| `projects.add` | ✓ Add projects sheet, Choose Folders…, drop folders on the sidebar |
| `projects.origin` | ✓ new work sent to one of your computers: its project found there by origin, or cloned from it (BLG-788) |
| `projects.addFolder` | ✓ (a dropped folder of projects is watched) |
| `projects.initGit` | ✓ Add projects sheet: a plain folder’s row offers Set Up Git |
| `projects.suggest` | ✓ "On this Mac" in the Add projects sheet |
| `projects.create` | ✓ Add projects sheet › Start new, New Project… in the Projects + menu and the palette |
| `projects.clone` | ✓ Add projects sheet › Clone, Clone from Git… in the Projects + menu, Clone a project… in the palette: paste a git address (https or ssh); a repository you have already opens instead |
| `projects.myRepos` | ✓ Add projects sheet › Clone: "Your repositories" from GitHub (gh's sign-in), filter and pick one; ones you have already say Here |
| `projects.newHome` | ✓ the location a new project goes in, in Add projects › Start new |
| `projects.icon` | ✓ project icons in the sidebar |
| `projects.iconAt` | ✓ icons of suggested folders |
| `projects.setIcon` | ✓ right-click a project › Change Icon… |
| `network.setEnabled` | ✓ the Friends card’s Turn On, Settings › People & access › Talk with friends directly (starts and stops live) |
| `network.status` | ✓ the network is on (the Friends card, Settings › People & access) |
| `network.friends.list` | ✓ sidebar Friends, the one people list (presence dots, notes, unread, relayed link; a friend in your room also shows their agent on and Following there) |
| `network.friends.addFromRoom` | ✓ sidebar Friends › Not friends yet › Add as friend (people in your room who aren't friends; never guests); the room card's Add as Friend; after joining a room by link, “Add <host> as a friend?” |
| `network.friends.answerOffer` | ✓ sidebar Friends › “kay wants to add you as a friend” › Accept / Not Now (right-click); the phone: a NeedsYou item with Accept / Not now |
| `network.friends.invite` | ✓ Add a Friend sheet › Create Invitation (code, link, QR, expiry) |
| `network.friends.accept` | ✓ Add a Friend sheet › Have a code or link? (pasted from the clipboard; `beluga://add…` links open it) |
| `network.friends.cancelInvite` | ✓ Add a Friend sheet › Cancel Invitation; replacing a group link |
| `network.friends.remove` | ✓ right-click a friend › Remove… (alert); the conversation’s ⋯ |
| `network.dm.send` | ✓ the conversation’s message box; Send Again on an undelivered one |
| `network.dm.history` | ✓ Show Earlier Messages |
| `network.groups.list` | ✓ sidebar Groups (unread, join requests) |
| `network.groups.create` | ✓ New Group sheet (name, friends with checkboxes) |
| `network.groups.send` | ✓ the group’s message box |
| `network.groups.history` | ✓ Show Earlier Messages |
| `network.groups.addMember` | ✓ Add People… sheet; right-click a friend › Add to Group ▸ |
| `network.groups.removeMember` | ✓ group info › a member’s menu › Remove… (alert) |
| `network.groups.setAdmin` | ✓ group info › a member’s menu › Make Admin / Remove as Admin |
| `network.groups.leave` | ✓ Leave Group… (alert) from the sidebar, the header ⋯ or the group info |
| `network.groups.delete` | ✓ Delete Channel… (alert) for a channel you've left: the ⋯ menus, the group info, the read-only banner, or ticked in the Leave alert |
| `network.groups.rename` | ✓ rename in place in the group info, or the sidebar (double-click, Rename…) |
| `network.groups.invite` | ✓ group info › Invite with a Link (Approve Each Request / Anyone with the Link), Copy Invite Link |
| `network.groups.join` | ✓ Join a Group sheet (`beluga://join#…` links) |
| `network.groups.approve` | ✓ group info › Asking to Join › Approve |
| `network.groups.decline` | ✓ group info › Asking to Join › Decline |
| `network.presence.set` | ✓ your status (sidebar footer, menu bar, palette), Away when idle |
| `network.presence.get` | ✓ the shared state’s `network.self` (no call needed) |
| `network.avatar.set` | ✓ Settings › General, your picture beside your name |
| `network.avatar.get` | ✓ every avatar (chats, headers, tasks, team), cached as data URLs |
| `network.read` | ✓ opening a conversation reads it (the `conversation` view is shown); Mark as Read on a group |
| `network.messages.delete` | ✓ a direct message's right-click menu › Delete… (yours: Delete for them too) |
| `network.messages.edit` | ✓ your direct message's right-click menu › Edit (in place: Return saves, Esc cancels) |
| `network.messages.react` | ✓ hover a message › the smiley-plus button: your six quick reactions, or More for every emoji (search, categories); click a chip under a message to add or take back yours |
| `network.clear` | ✓ a direct conversation's ⋯ menu › Clear Chat… |
| `network.post` | ✓ a conversation's message box: words, files waiting in the box, and the Ask Your Agent menu (yours, everyone's, one person's); Send Again on an undelivered one |
| `network.files.add` | ✓ the paper clip (Open panel), files dropped anywhere on a conversation |
| `network.files.addData` | ✓ files and pictures pasted into the message box (and picked in a browser) |
| `network.files.download` | ✓ a file card's Download (files up to 50 MB come by themselves); Try Again on one that didn't come |
| `network.files.cancel` | ✓ a file card's × while it comes; right-click › Stop Downloading |
| `network.files.open` | ✓ click a file card or a picture; right-click › Open |
| `network.files.reveal` | ✓ a file card's folder button; right-click › Show in Finder |
| `network.files.saveTo` | ✓ right-click a file › Save As… (the Save panel) |
| `network.files.preview` | ✓ pictures shown in the chat |
| `network.channels.main` | ✓ All Friends (the first chat tab, the top of sidebar Channels): made the first time it's opened |
| `stripe.connect` | ✓ Connect Earnings… (a project's right-click and ⋯ menus, the Overview's hint and Earnings card), then Connect Stripe in the sheet: it checks the key with Stripe and shows the account |
| `stripe.disconnect` | ✓ the Earnings sheet › Stripe › Disconnect |
| `stripe.refresh` | ✓ Refresh in the sheet and the Overview's Earnings card (the daemon also looks for new payments every 10 minutes by itself) |
| `revenuecat.connect` | Mac only (like `stripe.*`; nothing on the phone): the Earnings sheet's RevenueCat section checks the V2 secret key with RevenueCat, asks which project when the key sees several, and shows the apps |
| `revenuecat.disconnect` | Mac only: the Earnings sheet's RevenueCat section › Disconnect |
| `revenuecat.refresh` | Mac only: Refresh Now in the Earnings sheet (the daemon also looks again every 10 minutes by itself) |
| `revenuecat.setApps` | Mac only: the Earnings sheet's RevenueCat section › Choose apps… (Count revenue from) |
| `diagnostics.report` | ✓ Settings › About › Report a Problem: makes the report, shows it in Finder and opens a GitHub issue to attach it to |
| `diagnostics.windowProblem` | ✓ by itself: a part of the window that stalled or failed to load (a view, the file reader) is noted in the black box, so Report a Problem shows which and when |
| `diagnostics.windowCrash` | ✓ by itself: a part of the window that threw while drawing (the notification centre, the whole window) shows what went wrong in place of a grey window, and its error and stack are noted in the black box (BLG-905) |
| `support.answer` | ✓ the Star sheet after your third merge (Star Beluga on GitHub / Maybe Later) |
| `telemetry.choose` | ✓ the onboarding's last setting (Help make Beluga better: Off / Limited / On, Limited picked; Continue, Finish and Skip keep it) and Settings › General › Usage statistics › Share usage statistics; the phone's Settings › Usage statistics too. Only in a build that can send (Beluga's own releases) |
| `telemetry.answer` | ✓ the ask after an update, once, at a calm moment and never while one of your agents runs: Share (the level picked), Later (again in 3 days or after 5 merges), No thanks (never again); closing it is Later |
| `telemetry.exclude` | ✓ a project's Settings (General) › Send usage statistics from this project: off, its agents' runs send nothing whatever the level (shown only in a build that sends, at Limited or On) |
| `telemetry.mark` | ✓ by itself: the onboarding's steps and its end, the ask shown (names only), at a level that sends |
| `chats.snapshot` | ✓ the composer in a chat another person shares with you, at Send when the words name a chat of yours: “Share a copy of <title> with <person>?” › Share Copy adds a copy of its messages (no tool output, at most 200 messages and 48 KB, secrets redacted) to the message; Send Without It and Cancel send none (`src/core/chat-links/transcript.ts`) · Mac only |
| `chats.resolve` | ✓ a chat's chip (`chat:<owner>/<channel>` in an answer) and link: its current title, its state and where it opens (`src/core/chat-links/resolve.ts`) · the phone too |
| `stats.get` | ✓ Usage (the whole window, no panel beside it) › your card at the top (your pass on a lanyard you can swing and flip, with your picture, name and a title earned from your stats, the others to wear, and Play Your Recap: a Wrapped-style story of your numbers ending on your title), Sessions (each 5-hour session and week of your plan: how much you used, what was left, how often you ran out; only the agents and windows your plans report, and no card when none do, e.g. an API key) and Your stats: the strip of numbers (agent time, prompts, pasted, dictated, worktrees, PRs merged, lines shipped, tokens) for a week, month, year or all time, that number over time stacked by project or agent (point for a step, press a name to hide it, Share for parts of 100%), highlights, the year's calendar, each one's share in a ring, when you work |
| `stats.leaderboard` | ✓ Usage › Leaderboard: you and your friends on prompt characters, merged PRs and agent hours for a week, month or year: a podium of points, a race per number with how many times more each one did, and "Add friends to see them in the leaderboard." with no friends |
| `stats.note` | ✓ the composer reports how much text you pasted (its length) and dictation how long you spoke, for Usage › Your stats |
| `stats.saveImage` | ✓ Usage › your card › Share… (and the recap's last slide): Save Image… writes the picture of your stats where you pick in the Save panel; Copy Image needs no daemon |
| `assistant.newChat` | ✓ Your Mac's tab strip › + (a new empty chat, open now); on the phone, New chat in Your Mac's chats list or ••• |
| `assistant.openChat` | ✓ clicking one of Your Mac's tabs (or a notification from one of its chats); kept across restarts, and the phone's Ask your Mac follows it |
| `assistant.deleteChat` | ✓ a tab's × › Delete Chat (asks first; its run stops, its messages, folder and agent transcript go for good, no archive; the last one leaves a fresh chat); on the phone, long-press in Your Mac's chats list or ••• › Delete this chat |
| `assistant.scratch` | ✓ the panel's Scratch tab beside Your Mac's chat (BLG-704): its `work/.beluga/scratch/`, which all its chats share, newest first and live, with how much it holds in total; what nobody touched for 30 days goes to the Trash on its own (a minute after Beluga starts, then daily) |
| `gateway.list` | ✓ the shared state's `gateway` (task cards in conversations, Requests) |
| `gateway.confirm` | ✓ the “Ask bob's agent?” card in a conversation: Ask / Always / Not now |
| `gateway.cancel` | ✓ Cancel on a task card and in Requests (sent), Stop in Requests (received) |
| `gateway.forget` | – the phone only: Remove in an asked-of-friends conversation's ••• sheet (cancels it first while it's still going) |
| `gateway.ask` | ✓ Requests › Ask someone's agent… |
| `gateway.setAskFreely` | ✓ Settings › Access: “Your agent asks them without checking” › Ask Me First (Always on the card turns it on) |
| `gateway.setNote` | ✓ Requests › your “Ask me for…” note |
| `gateway.decide` | ✓ the request sheet (Approve once / Always, with its scope and expiry / Decline with a reason), the notification's and the menu bar's Approve / Always / Decline, and the request's card in the friends' chat it came from (BLG-207); a secret only Allow Once / Decline (BLG-209) |
| `gateway.answer` | ✓ a sent task's card when their agent asks something: pick an answer or write one, or Let them decide |
| `gateway.saveRule` | ✓ Settings › People & access › Rules, and a friend's card: change a rule's answer or expiry |
| `gateway.removeRule` | ✓ Settings › People & access › Rules, and a friend's card: Delete |
| `gateway.setCapabilities` | ✓ Settings › People & access › What your friends’ agents can do here (per capability and trust level, the folders) |
| `gateway.image` | ✓ screenshots on a task card's result |
| `board.create` | ✓ New Task (⌘N in Tasks, C, the + in a status group, ⌘K › New Task…; on a board of several repos, its Repo picker), sub-tasks on a task page; its Agent pop-up (BLG-497) picks the agent and model its worktree runs when it starts |
| `board.update` | ✓ a task's properties (status, priority, assignee, labels, estimate, due date, parent, and the repo it runs in on a board of several), its title in place, row and card menus |
| `board.setPrivate` | ✓ a task's ⋯ › Make Private / Share with Team (only offered when teammates or Linear would see it), the Share with Team button on a private task's page, New Task's Who Sees It |
| `board.move` | ✓ dragging a card between columns on the board, or within one |
| `board.editBrief` | ✓ a section of the brief on a task page (click to edit, ⌘↩ saves) |
| `board.restoreRevision` | ✓ History › Restore on a brief section |
| `board.comment` | ✓ the comment box under a task's activity |
| `board.relate` | ✓ Blocked by / Blocks / Related on a task page |
| `board.addProof` | ✓ Add Proof (a picture, a page, a file) on a task page; the agent's task_attach_proof |
| `board.removeProof` | ✓ a proof item's ✕ |
| `board.remove` | ✓ Delete Task… (an alert, with Cancel) |
| `board.setAgent` | – kept for phones on 1.35–1.37 (their task page's ⋯ › Agent). Neither the Mac nor a newer phone changes a task's agent from the task any more (BLG-569): a task's Agent row shows the agent at work in its worktree (a click opens its conversation, where it's changed: `workbench.setAgent`), or before it starts the one that will; Start › Start with another agent picks another for one start |
| `board.start` | ✓ Start on a task (its page, its ⋯ and right-click menu: a new worktree, In Progress, your agent on it with its brief, and you there; the task's own agent, else its plan's, else your default); Start's ▾ and the menus' Start with ▸ (BLG-506): every agent and model, this start only, one not set up greyed with why; ⋯ › Start Worktree Only; a task a worktree already does or carries shows Open Worktree instead. The phone's task › Start, and ⋯ › Start with… (1.35); your agent's task_start, from any of your conversations |
| `board.settleGone` | ✓ the banner on a task whose worktree was archived or deleted (Cancel Task / Back to Backlog / Keep) |
| `board.archive` | ✓ a finished task's ⋯ › Archive |
| `board.archiveDone` | ✓ the archive button on Done (list group, board column), Tasks ⋯ › Archive Done Tasks |
| `board.unarchive` | ✓ an archived task's banner (Restore), ⋯ › Restore from Archive |
| `board.emptyArchive` | ✓ Tasks › Archive › Empty Archive |
| `board.setAutoTasks` | ✓ Tasks › ⋯ › Agent Opens a Task for Worktree Work |
| `board.createBoard` | ✓ Tasks › the board switcher › New Board… (a name, the repos it covers, its keys) |
| `board.editBoard` | ✓ Tasks › the board switcher › Board Settings…, ⋯ › Board Settings… / Repos on This Board…, the Repos filter's Repos on This Board…, a task's Repo menu |
| `board.removeBoard` | ✓ a board of its own's settings sheet › Delete Board…, and Tasks › ⋯ › Delete Board… (its tasks go back to their repos' boards) |
| `board.setPrefix` | ✓ Tasks › ⋯ › Task Keys… |
| `board.createLabel` | ✓ a task's Labels menu › New Label… (a name, an icon, a color) |
| `board.removeLabel` | ✓ the New Label sheet: a project label's remove button (under Labels of this project) |
| `board.setContext` | ✓ Tasks › ⋯ › About This Project… (what the agent reads when it writes a task here; shared with teammates) |
| `board.syncTeams` | ✓ Tasks › ⋯ › Sync with Linear… (the sheet checks the key and lists its teams) |
| `board.syncConnect` | ✓ the Sync with Linear sheet › Connect (a team, Autosync, Also Send Open Tasks) |
| `board.syncDisconnect` | ✓ the Sync with Linear sheet › Disconnect… |
| `board.syncNow` | ✓ Tasks › ⋯ › Sync Now, and the Sync with Linear sheet’s Sync Now (the Linear pill in the Tasks bar opens the sheet) |
| `board.syncAuto` | ✓ the Sync with Linear sheet › Autosync |
| `sentinel.create` | ✓ New Sentinel (⌘N on the list, ⌘K › New Sentinel…, the empty list's New Sentinel and Try a Recipe): a recipe from the list (Nightly tests makes its Fix the nightly failure too, after it), Build It Yourself, or Describe It (then `sentinel.ask`); it starts paused · the agent's `sentinel_create` in any of your chats |
| `sentinel.update` | ✓ a sentinel's page: changes save at once (When, Steps with every kind's fields — an Ask Your Agent step's Agent pop-up picks the agent and model, BLG-497 —, Properties, whose Agent sets every agent step's; unticking the merge step's Ask Me Before Merging asks first) · the agent's `sentinel_update` (a change to what it can do pauses it) |
| `sentinel.remove` | ✓ a sentinel's ⋯ and right-click › Delete… (confirms) · the agent's `sentinel_remove` (always asks your approval, even when your agent never asks otherwise: the card in the conversation and the phone's needs-you) |
| `sentinel.runDelete` | ✓ a run's ••• › Delete Chat… and Delete Run… (each confirms; not while it runs) · the agent's `sentinel_delete_runs` (by ids, how they ended or before when; always asks your approval) (BLG-577) |
| `sentinel.duplicate` | ✓ a sentinel's ⋯ (its page) and its row's ⋯ and right-click › Duplicate (the copy starts paused) |
| `sentinel.run` | ✓ Run Now on a sentinel's page, and its row's ⋯ and right-click; the phone's sentinel page (Run Now) · the agent's `sentinel_run` |
| `sentinel.test` | not in the window yet (the Sentinel page rework gives it a Test button); Run Now already runs a paused sentinel without turning it on · the agent's `sentinel_test` (its sources only, paused or not; what they find is kept), and `sentinel_create` / `sentinel_update` run a source they add or change once before saving, answering with its preview; `sentinel_try_source` runs one alone to read the schema (BLG-302, BLG-304) |
| `sentinel.stop` | ✓ a running run's page › ⋯ › Stop |
| `sentinel.pause` | ✓ Turn On and Pause on a sentinel's page and its row's ⋯ and right-click; Resume on the paused-after-failures banner; Turn On on the agent's banner; the phone's sentinel page (••• › Pause / Turn On) · the agent's `sentinel_pause` (pause only) |
| `sentinel.moveCheck` | ✓ a sentinel's ⋯ › Move To ▸ (a computer): Move To, or Pause and Move To while it runs |
| `sentinel.movePack` | ✓ a sentinel's ⋯ › Move To ▸, on the computer it runs on (its steps, runs, kept numbers and tiles) |
| `sentinel.moveChunk` | ✓ a sentinel's ⋯ › Move To ▸ (your app fetches it in pieces) |
| `sentinel.moveReceive` | ✓ a sentinel's ⋯ › Move To ▸, on the computer it goes to |
| `sentinel.moveLand` | ✓ a sentinel's ⋯ › Move To ▸: it lands paused there, its sources checked, what it lacks there said |
| `sentinel.moveDrop` | ✓ a sentinel's ⋯ › Move To ▸: gone from where it was once the copy is in (or the copy, when the move didn't finish) |
| `sentinel.runs` | ✓ a sentinel's page › History (the dot strip, then the runs as rows); the phone's sentinel page draws the same runs from its `sentinel:<id>` topic |
| `sentinel.runGet` | ✓ a run's page: the steps' outputs (Show output) and the report; the phone opens a run's report |
| `sentinel.ask` | ✓ a sentinel's page › the box under its header, "Ask Your Agent to change this sentinel…" (⌘↩; the agent's last line while it works, its answer and Open Chat after) · New Sentinel › Describe It (an empty paused sentinel, then this) |
| `sentinel.recipes` | ✓ New Sentinel › Recipe: the twelve recipes as a list (icon, name, when it runs, one line) |
| `sentinel.decide` | ✓ Merge and Not Now on a run waiting for you (a run's page), and the phone's needs-you card |
| `sentinel.setRunAtOnce` | ✓ the Sentinel list's ⋯ › Run at Once ▸ (1 to 6 at once) |
| `sentinel.rotateSecret` | a webhook sentinel's page › When › Rotate Secret… (asks first; the old URL stops at once) |
| `sentinel.webhookUrl` | a webhook sentinel's page › When: its URL with Copy (or why there's none now) |
| `sentinel.metricRead` | ✓ a sentinel's page › Numbers: a number tile opens its chart over time (its whole history; a point opens its run); the phone reads it through `sentinel.metricRead` · the agent's `metric_read` (`mcp__beluga_dashboard__*`) |
| `sentinel.document` | a kept table's document chip (a typed `html` or `file` column, BLG-345) opens the document in Beluga's viewer (scripts and network off); the phone reads it through the Mac (640 KB at most) · Mac: a kept table's document chip (the column's button words or the file's name, on a dashboard tile, a sentinel's Numbers and Add Tile's preview) opens the document sheet (BLG-381) |
| `sentinel.documentOpen` | the document viewer's Open in Default App, or Show in Finder (Mac only: its path never leaves the daemon) · Mac: the document sheet's Open in Default App and Show in Finder (BLG-381) · phone: Open on your Mac on a document it doesn't show (BLG-386) |
| `sentinel.signStorage` | a kept table's storage chip (bucket and path columns): a Supabase link signed on click for 60 s, never kept; the phone asks the Mac to sign it · Mac: the storage sheet's Open Link in Browser, for a file too big to fetch (BLG-381) |
| `sentinel.storageDocument` | a kept table's storage chip on the Mac: the object fetched now through a signed link (nothing kept) and shown in the document sheet; a kind Beluga can't show gets its kind, size, bucket and path (BLG-381) |
| `sentinel.storageOpen` | the storage sheet's Open in Default App and Show in Finder: a copy saved in its run's files (readable only by you, swept with its documents) (BLG-381) · phone: Open on your Mac (BLG-386) |
| `sentinel.dataList` | a sentinel's page › Kept data (BLG-392): each metric with how much it keeps and since when, each run's files · phone: a sentinel's page › Kept data |
| `sentinel.runFile` | Kept data › a run's file chip (its report, a step's output, a document) opens in the document sheet, text redacted (BLG-392) |
| `sentinel.runFileOpen` | the document sheet's Open in Default App and Show in Finder for a run's file (BLG-392) · phone: Open on your Mac |
| `sentinel.dataExport` | Kept data › a metric's sheet › Export CSV / Export JSON, and a run's ••• › Save Its Files to Downloads: written to ~/Downloads/Beluga/<sentinel>/ and shown in Finder (BLG-392) |
| `sentinel.dataReveal` | Kept data's folder button and a metric's sheet › Show in Finder (its numbers' folder); a run's ••• › Show in Finder (its folder) (BLG-392) |
| `sentinel.runRow` | a kept table's action button (an `action` column) runs its sentinel with that row as the trigger's payload (the row checked against the latest rows) · Mac: a kept table's action button (its column's words) runs it (BLG-381) |
| `dashboard.create` | ✓ Sentinel › Dashboard › + beside the tabs, ⋯ › New Dashboard, and the empty page's New Dashboard (the first is made for you when the first number arrives) · the agent's `dashboard_create` |
| `dashboard.update` | ✓ Sentinel › Dashboard: the compare `Segmented` at the top (Previous · Yesterday · Last week · Last month, every tile); ⋯ › Rename… (or double-click its tab) · the agent's `dashboard_update` |
| `dashboard.remove` | ✓ Sentinel › Dashboard › ⋯ › Delete Dashboard… (confirms; the numbers stay with their sentinels) · the agent's `dashboard_remove` (always asks your approval first) |
| `dashboard.addTile` | ✓ Sentinel › Dashboard › Add a Tile › Pick it yourself: a number, a series, a table, an output (an agent, service or script step's latest export, or an output metric), text or a divider, from every metric or step by project and sentinel, its size and title, with a preview · the agent's `dashboard_add_tile` |
| `dashboard.updateTile` | ✓ a tile's ⋯: Rename…, Width ▸ (1 to 6 columns), Height ▸ (normal or tall), Compare ▸ (as the dashboard's, or pinned), Draw as ▸ (a series), Show as ▸ (an output: Markdown, a JSON tree, a table, text), Shows ▸ (a text tile) · the agent's `dashboard_update_tile` |
| `dashboard.removeTile` | ✓ a tile's ⋯ › Remove Tile · the agent's `dashboard_remove_tile` |
| `dashboard.moveTile` | ✓ Sentinel › Dashboard: a tile dragged onto any column and row, where it stays · the agent's `dashboard_move_tile` (a column and row, or an index) |
| `dashboard.refresh` | ✓ Sentinel › Dashboard › Refresh (Run Now on each sentinel it draws from, one at a time: "Fetching… 2 of 3"); the phone's dashboard: pull to refresh |
| `dashboard.ask` | ✓ Sentinel › Dashboard › Add a Tile › Describe it (the default): the agent builds the tile, and sets up a draft sentinel that fetches it when nothing does yet (the page then says "Your agent set up … · Review · Turn On"); the agent's last line while it works, its answer and Open Chat after |
| `sentinel.chatNew` | ✓ Sentinel › Chat › New Chat (the bar, and ⋯ › New Chat) |
| `sentinel.chatOpen` | ✓ Sentinel › Chat: the chat's name, a picker of the chats when there are several |
| `sentinel.chatClear` | ✓ Sentinel › Chat › ⋯ › Clear (its messages go, the agent starts afresh; the chat stays) |
| `sentinel.chatDelete` | ✓ Sentinel › Chat › ⋯ › Delete Chat… (confirms; the next chat opens, or a fresh first one) |
| `issues.list` | ✓ Issues (Work in the sidebar › Issues, Go › Issues, ⌘K › Go to Issues): a project's open or closed GitHub issues, newest activity first, through gh (GraphQL, so pull requests never take up the page); the search box asks GitHub; each shows what Beluga is doing about it; a project's home lists the latest four |
| `issues.pulls` | ✓ Pull Requests on a project's home: its open pull requests on GitHub (anyone's, not only your worktrees'), newest activity first, the latest four with their author, branch, Draft, review and checks; one on a worktree's branch opens that worktree, any other opens on GitHub (or in a worktree with Open in Worktree); See All opens Work › Pull Requests (every one read, a project switcher, Ask GitHub Again), See All on GitHub opens them there (through gh, GraphQL, a minute's cache) |
| `issues.openPull` | ✓ Open in Worktree on a pull request's row (Project Home) and in its ••• menu: its branch checked out in a new worktree that opens (one from this repository tracks origin's branch, so a push updates it; one from a fork comes from GitHub's pull ref, on its branch's name or pr-<n>); the worktree already on its branch opens instead |
| `issues.get` | ✓ an issue's page: the report and its comments in Markdown, its labels, assignees and dates, its task, and what to do next |
| `issues.investigate` | ✓ Investigate (an issue's page: the composer's first way, with anything the agent should know; its ⋯ and right-click menu): a task for it (or the one it has), a worktree, and your agent finding out why and reproducing it, writing what it found into the task's brief, without fixing it; the page shows it at work, then its report with Fix It · when a teammate on the same repository is already on it (team boards) it asks first (Start Anyway: `anyway`) |
| `issues.fix` | ✓ Fix It (an issue's page and menus; after an investigation also the task's page and the strip above its conversation): your agent fixes it, in the investigation's worktree when there is one, and opens a pull request with your PR instructions and "Fixes #n" · asks first when a teammate is on it, as Investigate does |
| `issues.toTask` | ✓ Make a Task in an issue's composer (the agent writes the title, goal and criteria; ☐ Look at the code first: the agent reads the code first, read-only, and adds where it is and the likely cause); also in its ⋯ and right-click menu (Make a Task, Make a Task After a Quick Look) |
| `issues.comment` | ✓ an issue's page › the Comment box under its thread (Markdown, your send key); and ⋯ › Post the Findings on GitHub… (after an investigation; asks first, shows what goes) |
| `ci.runs` | ✓ Actions (Work in the sidebar › Actions, Go › Actions, ⌘K › Go to Actions): a project's latest workflow runs, running ones first, through gh; Workflow and branch filters; refreshed every few seconds while one runs · a project's home lists the latest five, live |
| `ci.run` | ✓ a run's page: its workflow as a graph with each job coloured by how it's going, every job and its steps with their times, live while it runs |
| `ci.workflows` | ✓ Actions › Workflows: each workflow file drawn as a graph (what starts it, its jobs, what needs what), from the project's folder first; Show the YAML |
| `ci.log` | ✓ a failed job on a run's page › Show the Log (its end, where it failed) |
| `ci.rerun` | ✓ a run's page › Re-run Failed Jobs, and ⋯ › Re-run All Jobs; a run's right-click menu |
| `ci.cancel` | ✓ a running run's page › Cancel Run (asks first); a running run's right-click menu |
| `triage.settle` | ✓ the daemon's API, off until `chatCategories` is on: the sidebar's row and right-click menu › Settle; the phone's Work tab, a chat's long-press sheet › Settle |
| `triage.unsettle` | ✓ the daemon's API, off until `chatCategories` is on: the sidebar's row, its right-click menu and the line above the message box › Un-settle; the phone's Work tab, a chat's long-press sheet › Un-settle |
| `triage.snooze` | ✓ Remind Me Later (BLG-748, BLG-770), with `chatCategories` on or off: a chat or worktree row's right-click menu › Remind Me Later ▸ In 1 Hour / In 3 Hours / Tomorrow Morning / Next Week / Custom…; with the categories on, also the row's clock and plans' and friends' rows, and it moves to the Later list; off, it moves into a folded Later row at the bottom of its project (or of Chats) with a quiet clock; the line above the message box says when it reminds you; then one reminder notification; the phone's Work tab (categories on), a chat's long-press sheet › Remind Me Later (the same, without Custom…) |
| `triage.wake` | ✓ Show Again Now, with `chatCategories` on or off: the row's right-click menu and the line above the message box; with the categories on, also the row's eye; the phone's Work tab (categories on), a chat's long-press sheet › Show Again Now |
| `triage.setAutoSettle` | ✓ the daemon's API, off until `chatCategories` is on: the sidebar's right-click menu › Auto-settle |
| `team.answer` | ✓ the offer strip on a project's home and at the top of its Tasks (Team Up; ••• › Not Now, or Take Back while you wait for them); project ••• › Invite to Team ▸ (friends with the repository who aren't on the team, BLG-510); the phone's card (Team Up / Not Now) |
| `team.ackAssignment` | ✓ Got It on the strip a task a teammate gave you shows on its page; the phone's card (Got It) |
| `team.sharePlan` | ✓ a plan's ••• › Share Plan with Team / Stop Sharing with Team (only in a project worked on as a team) |
| `team.reviewPlan` | ✓ a teammate's shared plan (Plans › Shared by Your Team): Approve, Comment, and Suggest a Change… on a task or milestone; the phone's card (Approve, or words as a comment) |
| `team.applySuggestion` | ✓ Apply on a suggestion in Team Reviews on your plan's page; the phone's card (Apply) |
| `team.dismissSuggestion` | ✓ ••• › Set Aside on a suggestion in Team Reviews; the phone's card (Set Aside) |
| `team.knock` | ✓ a task's page, after "Ata is working on this": Knock to Join (pick whose worktree when several teammates are on it); Knock Again after a Not Now |
| `team.cancelKnock` | ✓ Take Back next to "Knocked. Waiting for Ata to let you in" on the task's page |
| `team.answerKnock` | ✓ the knock's card in the worktree's chat (Let In as Editor, Let In as Viewer; ••• › Not Now) and the bell's row; the phone's card (Let In as Editor / Not Now / Let In as Viewer) |
| `team.befriend` | ✓ the team badge on a project's row › its card › Add Friend beside someone on the team who isn't a friend (BLG-510); and Tasks › the faces beside Active and Backlog › someone › their card › Add Friend (BLG-906); they Accept like any friend request |
| `team.leave` | ✓ project ••• › Leave Team with Ata (Leave Team with several teammates: off it for everyone, BLG-510) |
| `plans.create` | ✓ Plans › New Plan (a goal; the agent plans in a conversation of its own in the project's main folder; More options › Agent picks who works its milestones and tasks, BLG-497); the phone's Ask › a project › Plan (1.5); Your Mac's `start_plan` (quietly) |
| `plans.here` | ✓ the composer's mode menu › Plan with Tasks (the agent plans in the conversation you're in) |
| `plans.approve` | ✓ Approve Plan / Apply Changes on a plan's page and its strip above the conversation; Approve Plan's ▾ › Approve, worked by ▸ (BLG-506: `plans.setWorkAgent`, then approve) |
| `plans.discard` | ✓ Discard Draft / Discard Changes on a plan's page |
| `plans.verify` | ✓ Approve Plan's ▾ › Verify, Then Approve on a plan's page and its strip above the conversation; ••• › Verify the Plan; Verify, Then Approve on the findings line once Fix was sent (BLG-772); the phone's approve card |
| `plans.fixReview` | ✓ Fix on the findings line and the plan page's main button, when verifying found something (BLG-772); the phone's card too |
| `plans.edit` | ✓ editing a plan's outline (rename, criteria, move, remove, what waits on what) |
| `plans.setAutonomy` | ✓ Step by Step · Check-ins · Autopilot on a plan's page (a milestone's own from its menu); the phone plan page's autonomy chip (1.5) |
| `plans.setPaused` | ✓ Pause / Resume on a plan's page |
| `plans.setParallel` | ✓ a plan's ⋯ › Run at Once ▸ |
| `plans.setWorkAgent` | ✓ a plan's ⋯ › Agent for Its Work ▸ (BLG-498): who works the milestones and tasks that start from now on (ones at work keep theirs, the toast says so); the phone's plan page › ⋯ › Agent for its work (1.35) |
| `plans.setTestsAt` | ✓ a plan's ⋯ › When to Run Tests ▸ (each milestone, or once at the end) |
| `plans.pass` | ✓ Pass Milestone on a plan's page |
| `plans.recheck` | ✓ Check Again on a milestone the agent is checking or that failed its check |
| `plans.openPr` | ✓ Open PR on a plan whose every milestone passed (plan/<slug> → main) |
| `plans.mergePr` | ✓ Merge on GitHub (or Merge When Checks Pass, ⋯ › Merge Now) once the plan's pull request is open |
| `plans.mergeLocal` | ✓ ⋯ › Merge into Main Locally on a plan ready to ship |
| `plans.bringInMain` | ✓ Resolve Conflicts on a plan whose pull request conflicts with main |
| `plans.retryConflicts` | ✓ Ask Claude Again on a plan's conflict that waits for you |
| `plans.showConflict` | ✓ Show in Finder on a plan's conflict that waits for you |
| `plans.sendBack` | ✓ Not Yet… on a milestone waiting for you |
| `plans.startTask` | ✓ Start on a ready task (step by step, or a task for you); `agent` (BLG-506): Start's ▾ in its details, the outline's right-click › Start with ▸, and Start N Tasks' ▾ on the plan's page (a milestone already at work keeps its agent) |
| `plans.resumeTask` | ✓ Resume on a task that stopped (the agent ran out of usage or crashed) |
| `plans.remove` | ✓ a plan's ⋯ › Delete Plan… (its tasks stay on the board) |
| `plans.tidyUp` | ✓ Tidy Up / No on a plan's leftover task worktrees (merged into its branch, then archived) |
| `plans.setStyle` | ✓ Plans › ⋯ › Planning Style… |
| `plans.moveCheck` | ✓ a plan's ⋯ › Move To ▸ (a computer): Move To when nothing runs in it, Pause and Move when something does |
| `plans.movePack` | ✓ a plan's ⋯ › Move To ▸, on the computer it runs on (Commit Them and Move when its worktrees have changes not committed) |
| `plans.moveChunk` | ✓ a plan's ⋯ › Move To ▸ (your app fetches the packed plan in pieces) |
| `plans.moveReceive` | ✓ a plan's ⋯ › Move To ▸, on the computer it goes to |
| `plans.moveLand` | ✓ a plan's ⋯ › Move To ▸, on the computer it goes to (it opens there once it's in) |
| `plans.moveDone` | ✓ a plan's ⋯ › Move To ▸: the old copy becomes its record once the new one is in (Moved to … on its page) |
| `plans.moveUndo` | ✓ a plan's ⋯ › Move To ▸: a copy whose move didn't finish is taken back off |
| `dialogues.start` | ✓ the composer: `@my:claude @my:codex talk about X, 6 turns` or `/dialogue claude codex …` (`session.submit` proposes it; the API starts one too) |
| `dialogues.confirm` | ✓ the dialogue's card in the chat › Start (Turns and Budget set on the card first) |
| `dialogues.continue` | ✓ the dialogue's card › Continue (when it paused at its cap) · the phone's card |
| `dialogues.stop` | ✓ the dialogue's card › Stop / Cancel · `/dialogue stop` in its conversation · the phone's card |
| `dialogues.interject` | ✓ the composer in a conversation with a dialogue going on: what you type lands as a turn (`session.submit`) |
| `claudeCode.steps` | ✓ a Claude Code session's or agent's live, read-only transcript (Activity, the strip above a workspace's chat, the Inspector's Claude Code panel) |
| `claudeCode.step` | ✓ opening a tool call or thinking line in that transcript: the command and its output, the file, the diff, the thinking |
| `claudeCode.findAgent` | ✓ opening a sub-agent's own worktree whose agent finished a while ago: it's found again and followed live |
| `claudeCode.outputs` | ✓ a sub-agent's Outputs tab: the screenshots, test output, logs and JSON it made or looked at (from its transcript, wherever it put them, plus its own `.beluga/scratch/agents/<name>/`), still on disk, newest first |
| `claudeCode.output` | ✓ looking at one of them: pictures inline (GIFs animate), videos playing inline up to 64 MB, text with secrets redacted (only files that agent made or looked at) |
| `claudeCode.taskOutput` | ✓ following a background command or watch the agent or a sub-agent started (the panel's Background tab, below the terminal; a sub-agent's Background): the end of its output, live, cleaned of terminal codes and secrets; its own log when it writes to one |
| `claudeCode.skills` | ✓ the message box's / list, including a new chat before its first message: the skills and custom commands in the conversation's folder (the project's, yours, your plugins'), each with its description |
| `claudeCode.mcpServers` | ✓ Settings › Agent › MCP servers: your agent's servers (yours, your projects', your plugins', claude.ai's), where each comes from and whether it's connected; with Claude and Codex both set up, one tab each |
| `claudeCode.mcpSignIn` | ✓ Settings › Agent › MCP servers › Sign In…: opens the server's sign-in page in your browser |
| `claudeCode.mcpSignedIn` | ✓ Settings › Agent › MCP servers: the row waits for the browser, then says whether you're signed in |
| `claudeCode.mcpSetEnabled` | ✓ Settings › Agent › MCP servers: a Codex server's switch turns it on or off in its config.toml |
| `agent.steps` | ✓ an agent card's steps as disclosure rows (an icon per tool, ✓/✗, how long it took), thinking as “Thought for 12s”, sub-agents' steps |
| `agent.step` | ✓ opening a step on an agent card: Bash's command and output (colours kept), the file read, an edit's diff, a search's matches, a page fetched, an MCP tool's input and output as JSON, the thinking |
| `view.fetch` | ✓ a live table, chart, stats or code view in a conversation fetching its next page, sorted or searched, or refreshing it (docs/views.md) |
| `preview.open` | ✓ a live preview in a conversation (Settings › Experimental › Live previews, docs/previews.md) as it scrolls into view, and a component file's Preview in Files: built on this computer, drawn in its frame with props from its types; off, it says so with Turn On… |
| `apps.get` | ✓ a step of a tool with an MCP App draws the server's page under it in the chat, fed the tool's input and result (only on a Claude Code with the MCP Apps capabilities; without them the step has no app) · phone: the step's one line · a driven computer: its app host's port isn't forwarded yet, so the frame doesn't load there |
| `apps.call` | ✓ an MCP App calls a tool of its own server (tools/call): a readOnly tool with 'app' visibility runs; any other asks Allow / Allow Always / Decline first (Always: that tool of that server, until Beluga quits); another server's tool or a model-only one is refused · phone: nothing (apps are drawn on the Mac) |
| `apps.read` | ✓ an MCP App reads a `ui://` resource of its own server (resources/read); other schemes are refused · phone: nothing |
| `apps.message` | ✓ an MCP App posts a message (ui/message): it asks Allow / Allow Always / Decline first (refused while your Claude works there), then shows in the chat as yours with "Sent by the <tool> app" and starts a turn of your Claude there · phone: the message, "Sent by the <tool> app" |
| `apps.context` | ✓ an MCP App sets what it tells the model (ui/update-model-context): the latest per app, added to your Claude's next turn in that chat as data, never instructions · phone: nothing |
| `preview.snapshot` | ✓ a live preview's ••• › Save as Picture (a PNG in the worktree's .beluga/scratch/previews); with a phone paired, each preview's newest picture is kept there too, for the phone to show |
| `git.fetch` | ✓ Fetch on a project's home (“fetched 3 min ago”, or why it couldn't: sign-in needed, offline) |
| `git.fetchIfStale` | ✓ opening a project's home fetches quietly when the last fetch is a few minutes old (the daemon also fetches every project every ~15 min, or as Settings › Workspaces › Fetch in the background says: slower, or never) |
| `git.updateMain` | ✓ Update main on a project's home: fetch and fast-forward the default branch; what can't fast-forward asks (changes in the way, or Let Your Agent Handle It) |
| `git.stashAndUpdate` | ✓ the “changes in the way” alert › Stash and Update (and put them back) |
| `git.moveAndUpdate` | ✓ the “changes in the way” alert › Move to Worktree |
| `git.switchToDefault` | ✓ “The main folder is on feat/…” › Switch to main (clean; or Move to Worktree / Bring Them Along) |
| `git.askClaude` | ✓ Let Your Agent Handle It (also on “Couldn’t fetch”): a worktree of its own for a failing fetch or diverged history; for what’s stuck in the main folder’s files, a conversation in its Questions whose run may only sync git (banner “Your agent is updating main”) |
| `git.syncFork` | ✓ Sync Fork on a fork's project home (shown when the original has new commits: “3 new on rstagi/app”): GitHub brings them into the fork's main, then Update main runs here |
| `git.syncForkWithClaude` | ✓ “Your fork and the original conflict” › Let Your Agent Handle It: a worktree where your agent merges the original in and opens a PR into the fork |
| `git.github` | ✓ the GitHub row on a project's home: GitHub ↗, Private/Public, people, open PRs, stars (through gh, cached an hour; Connect GitHub when gh isn't set up) |
| `git.githubRepo` | ✓ Open on GitHub in a project's right-click and ⋯ menus |
| `git.log` | ✓ History: a project home's latest commits, the History page (Show All) and the panel's History tab (⌥⌘5), as a graph |
| `git.commit` | ✓ a commit in History: message, author, date, parents, files with +/− and their diffs |
| `git.mergePreview` | ✓ the toolbar's Merge into main: where it goes, the commits and files, and checks (conflicts, uncommitted work, the main folder's branch) before you confirm |
| `git.filters` | ✓ History's Branch and Author pop-ups |
| `git.worktreeAt` | ✓ a commit in History › Start a Worktree Here |
| `web.link` | ✓ Settings › Advanced › Web access: turning on Open Beluga in a browser, and New Link (a one-time join link, 10 minutes, as a QR with Copy, under the address picked in Reached from; opens the web port first when it's closed); `beluga web` prints one |
| `web.sessions.list` | ✓ Settings › Advanced › Web access: the browsers let in (name, let in, last seen) and whether the port is open; `beluga web sessions` |
| `web.sessions.revoke` | ✓ a browser's Remove in Settings › Advanced › Web access (its sockets close at once, its page locks); `beluga web revoke <id or name>` |
| `web.stop` | ✓ Settings › Advanced › Web access: turning Open Beluga in a browser off; `beluga web stop` (and `beluga web --off`: the public link closes with it) |
| `web.ways` | ✓ Settings › Advanced › Web access: Tailscale is offered under Reached from only when it's installed and logged in |
| `web.tailscale` | ✓ Settings › Advanced › Web access › Reached from › Tailscale (the ts.net address, whose login gets in, a join link under it); `beluga web --tailscale` (with a QR), `beluga web --off`; `beluga status` shows it |
| `web.public` | ✓ Settings › Advanced › Web access › Reached from › Public link (what it exposes, its current address, refreshed while shown, so a new one after a cloudflared restart appears); `beluga web --public`, `beluga web --off`; `beluga status` shows the current address |
| `web.download` | ✓ in a browser the web port served: a chat file's Download, Show in Finder / Open on a file, Save on a shared file (docs/web.md) |
## Sending while the agent works, and images

| What | Core | Mac |
|---|---|---|
| Choose the default send action during a turn (Mac only) | Mac preference | Settings › General › Writing › **Send during a turn** · Queue (default) or Steer |
| Queue a message | `session.submit` | Return when Queue is the default, Option+Return when Steer is the default · **Queue** |
| Steer: the agent reads it at its next step without stopping, however long the step runs (a second steer joins the first; only Send now stops a step, and only a dead run is restarted) | `session.submit` with `urgent` | Return when Steer is the default, Option+Return when Queue is the default · **Steer** · agents without steering always queue |
| What waits, in run order (text, who asked) | `queueIn` (`src/ui/compose.ts`), the prompt comes with the `queued` event | the queue above the box |
| Run a waiting message now (steering, as above; a plan's Steer Now also stops a long command for it: `interrupt`) | `host.promote` | queue › Steer · plan › Steer Now |
| A steered message the agent hasn't read yet: sent, not read (its card is a note till the agent reads it: `READS_AFTER_STEP`, `STOPPING_FOR`, then `STEERED_IN` or its own turn) | `steerWaiting` (`src/shared/claude-notices.ts`), the message's `request` | your message dimmed, a clock and “Sent · the agent reads it after its current step” |
| Send it now: the agent's step stops (its interrupt, as Stop does) and the conversation goes on from your message | `host.steerNow` | **Send now** on that message · ⇧⌥↩ |
| Cancel it before the agent reads it: out of Claude Code's queue (`cancel_async_message`), the message and its card leave the chat (`TAKEN_BACK`), its words back in the box; an agent that can't take it back says so | `host.cancelSteer`, `Steer.cancel` | **Cancel** on that message (phone: long-press › Cancel, 1.43) |
| Drop a waiting message | `host.cancelQueued` | queue › ✕ |
| Edit a waiting message (back into the box) | `host.cancelQueued`, then the box | queue › ✎ |
| Change the order | `host.reorderQueued` (yours only; friends' keep their places) | queue › ↑ ↓ |
| Paste or drop an image | `attachments.add` | ⌘V / drop: a chip plus its picture above the text |
| An image in a message | `attachments.read` (yours from disk, a friend's through their share) | the picture (several in a grid); click for full size, ⌘C copies, Open shows it in Preview |

## Agent runs, per runtime

What an agent run does on each runtime (BLG-461, OpenCode BLG-686, Copilot BLG-873). A cell is **pass** (it works as on Claude), **fallback** (it works another way, or is greyed, and the UI says why: the reason is `src/shared/runtime-fallbacks.ts`, named here as `fallback:<id>`), or **n/a** (nothing of it applies on that runtime, so nothing is shown for it; a feature the runtime lacks altogether is `missing:<id>`, from the same file's `RUNTIME_MISSING`, and its control isn't offered there). `tests/parity.test.ts` fails on a blank cell, on a fallback or a missing feature the table and the code disagree about, on a fallback no screen shows, and on a capability Codex, OpenCode, Copilot or Grok Build lacks (`src/agent/runtime/codex/index.ts`, `src/agent/runtime/opencode/index.ts`, `src/agent/runtime/copilot/index.ts`, `src/agent/runtime/grok/index.ts`) that no row accounts for. The local model runtime has Claude's capabilities (it is Claude Code on another endpoint) except `hasModelList`, so its column would be Claude's.

| What | Ways in | Claude | Codex | OpenCode | Copilot | Grok Build |
| --- | --- | --- | --- | --- | --- | --- |
| Start a run in a worktree or chat, answers streamed | `session.submit`, `workspaces.startWorktree`, `workspaces.startChat` | pass | pass (`codex app-server`, a thread per place) | pass (`opencode acp`, a session per place) | pass (`copilot --acp`, a session per place; Copilot Free runs on Auto) | pass (`grok agent stdio`, a session per place) |
| Pick the agent and model, hand a live conversation off | `/model`, `workbench.setAgent`, `workbench.setModel`, `/handoff` | pass | pass (models from `model/list`, efforts per model; a handoff starts a new thread with the conversation carried) | pass (models from `opencode models`, efforts from each model's variants; a handoff starts a new session with the conversation carried) | pass (Auto, and the models a session offers; the model is its process flag, so a change mid-run takes effect from its next run unless the session offers it; a handoff starts a new session with the conversation carried) | pass (models from its `initialize`, efforts per model) |
| Continue a conversation later | `canResume` | pass | pass (`thread/resume`; one that can't be opened starts afresh and says so) | pass (`session/resume`; one that can't be opened starts afresh and says so) | pass (`session/load`; one that can't be opened starts afresh and says so) | pass (`session/resume`; one that can't be opened starts afresh and says so) |
| Queue and steer while it works | `host.promote`, `canSteer` | pass | pass (`turn/steer`) | pass (`missing:steer`: the composer always queues, one prompt at a time; Steer Now on an existing message stops the turn to read it) | pass (`missing:steer`: the composer always queues, one prompt at a time; Steer Now on an existing message stops the turn to read it) | pass (`missing:steer`: the composer always queues, one prompt at a time; Steer Now on an existing message stops the turn to read it) |
| Stop, Send now | `host.stopRun`, `host.steerNow`, `/stop`, `canInterrupt` | pass | pass (`turn/interrupt`, then the process) | pass (`session/cancel`, then the process) | pass (`session/cancel`, then the process) | pass (`session/cancel`, then the process) |
| Approve or deny a command or an edit | `host.answerApproval`, `canGateEveryTool` | pass (every tool through the PreToolUse hook) | pass (what leaves its sandbox asks you through the same gate; inside it, the sandbox confines it) | pass (every tool call asks Beluga first: Beluga's config makes each of its permissions, every agent's, "ask", judged by the same gate as Claude's) | pass (writes, commands that change things, other folders and MCP tools ask Beluga, judged by the same gate as Claude's; reads in the folder and read-only commands run without asking) | pass (every tool call asks Beluga first, through a hook of Beluga's for that process; a step turned down ends Grok's turn, and Beluga sends it back with the reason) |
| .env files and secrets stay out | `env.claudeDotenv`, `hasSandbox` | pass (policy.ts per call) | pass (its permissions profile denies them: `runtime/codex/sandbox.ts`) | pass (policy.ts per call, as Claude's) | pass (`.env` files, keys and credential folders are denied reads on its command line (`--deny-tool read(…)`); a read-only command naming one isn't asked about, which is why friends' tasks and guests stay off it) | pass (policy.ts per call, reads too) |
| A friend's task on your Mac | `gateway.decide` | pass | pass (sandboxed: network off, your MCP servers off) | fallback (`fallback:friends`): handed to Claude (or Codex) when one runs here, the friend's card saying why; your plugins could answer a step before Beluga is asked | fallback (`fallback:friends`): handed to Claude (or Codex) when one runs here, the friend's card saying why; it reads and runs read-only commands without asking | fallback (`fallback:friends`): handed to Claude (or Codex) when one runs here, the friend's card saying why; a company's Grok policy could switch Beluga's hook off |
| A guest in your room prompting your agent | `invites.create` | pass | fallback (`fallback:guests`): turned away with the reason; the Invite People sheet says it beside Prompt and Edit | fallback (`fallback:guests`): turned away with the reason; the Invite People sheet says it beside Prompt and Edit | fallback (`fallback:guests`): turned away with the reason; the Invite People sheet says it beside Prompt and Edit | fallback (`fallback:guests`): turned away with the reason; the Invite People sheet says it beside Prompt and Edit |
| A main folder stays read-only | `continue_in_worktree` | pass | pass (a read-only sandbox, Continue in New Worktree) | pass (policy.ts per call, Continue in New Worktree) | pass (policy.ts on every write it asks about, Continue in New Worktree) | pass (policy.ts per call, Continue in New Worktree) |
| Plan first, then approve | `/plan`, `session.setPlanMode`, `plans.here`, `hasPlanMode` | pass | pass (a read-only first turn answering with a plan, then the same approval card) | pass (its own plan agent, which edits nothing, then the same approval card) | pass (its own Plan mode, edits turned down too, then the same approval card) | pass (a read-only turn under policy.ts, then the same approval card) |
| Images in a message | `attachments.add`, `promptImages` | pass | pass | pass | pass | pass |
| Beluga's tools (room, board, plans, views, Mac, phone, sentinels) | `toolMounts` | pass (in process) | pass (stdio, scoped by a token) | pass (stdio, scoped by a token) | pass (http on 127.0.0.1, scoped by a token: Copilot takes no stdio servers from a client) | pass (stdio, scoped by a token, reached through its `use_tool`) |
| Steps on the agent card | `agent.steps`, `agent.step` | pass | pass (commands, edits, MCP calls mapped to the same steps) | pass (its read, edit, bash, grep, MCP calls mapped to the same steps) | pass (its read, edit, execute, search, fetch and MCP calls mapped to the same steps by their kind) | pass (its read, edit, shell, grep, MCP calls mapped to the same steps) |
| Usage and plan limits | `/usage`, `hasUsage` | pass | pass (its plan windows, filed under Codex) | pass (tokens and cost per turn; no plan windows: it runs on your providers or its free models) | pass (tokens per turn and the context meter; no plan windows: Copilot doesn't say what's left of your plan) | pass (tokens and cost per turn; the billing period from `grok usage` on the daemon route, or from `_x.ai/billing` on the shell route, otherwise the tokens from conversations on this Mac and a note that the period isn't available here) |
| Compact the conversation | `/compact`, `session.compact`, `workspaces.compact`, `hasCompaction` | pass | fallback (`fallback:compact`): Compact greyed in the toolbar with the reason; /compact and Compact now say it; auto-compact leaves Codex to compact itself | pass (its own `/compact`, its summary kept out of the chat) | pass (its own `/compact`, its summary kept out of the chat) | pass (its own `/compact`) |
| Fork a worktree | `/fork`, `workspaces.fork`, `canFork` | pass | fallback (`fallback:fork`): the toolbar's Fork says it in its hint, and the fork's first run says it as it starts | pass (`session/fork`) | fallback (`fallback:fork`): the toolbar's Fork says it in its hint, and the fork's first run says it as it starts | pass (`x.ai/session/fork`) |
| Edit a sent message (Rewind Here, New Fork) | `workspaces.editPrompt` | pass | fallback (`fallback:rewind`): the files go back; the line under the edit says the conversation starts afresh | fallback (`fallback:rewind`): the files go back; the line under the edit says the conversation starts afresh | fallback (`fallback:rewind`): the files go back; the line under the edit says the conversation starts afresh | fallback (`fallback:rewind`): the files go back; the line under the edit says the conversation starts afresh |
| Skills and custom commands | `claudeCode.skills`, `skills` | pass (native) | fallback (`fallback:skills`): translated; each one in the / list says what isn't on Codex | pass (it loads your Claude Code skills itself; custom commands are expanded for it, Claude Code's own built-ins go in as text with a note) | pass (it loads your Claude Code skills and commands itself; others are expanded for it, Claude Code's own built-ins go in as text with a note) | pass (it loads your Claude Code skills itself; custom commands are expanded for it, Claude Code's own built-ins go in as text with a note) |
| MCP servers of your own | `claudeCode.mcpServers`, `claudeCode.mcpSignIn`, `claudeCode.mcpSetEnabled` | pass | pass (its own from `~/.codex/config.toml` through `mcpServerStatus/list`, signed in with `mcpServer/oauth/login`, turned on and off with `config/value/write`; a friend's task gets them switched off) | n/a: the ones in your OpenCode config run in its runs, as in OpenCode; Settings lists Claude Code's and Codex's | n/a: the ones in your Copilot config (and its GitHub server) run in its runs, as in Copilot; Settings lists Claude Code's and Codex's | pass (the ones in your Grok config run in its conversations; Settings › MCP lists Claude Code's and Codex's) |
| Questions the agent asks you mid-run | `questions.answer`, `canAskUser` | pass | n/a: Codex asks in its answer, and you reply in the box | n/a: its question tool is off (it can't reach you over ACP), so it asks in its answer and you reply in the box | n/a: its question form is off (`--no-ask-user`: it can't reach you over ACP), so it asks in its answer and you reply in the box | n/a: its question tool can't reach you over ACP, so it asks in its answer and you reply in the box |
| Sub-agents and background agents | `claudeCode.findAgent`, `hasSubagents`, `hasBackgroundAgents` | pass | pass (its multi_agent on for your own runs, off for friends' and side calls: each sub-agent a row on the card with its name, prompt, steps and report, on the phone's sub-agent sheet too; the run stays open while ones it didn't wait for still work, up to the same 3 hours; Stop interrupts each one's turn. No Watch page or sidebar row: Codex keeps no Claude Code transcript for them) | pass (its task tool's sub-agents, each a row on the card; no background agents: a run ends when it answers) | n/a: no sub-agent rows; a run ends when it answers | pass (`spawn_subagent`, each a row on the card; no background agents: a run ends when it answers, `hasBackgroundAgents`) |
| Claude Code sessions outside Beluga | `claudeCode.steps` | pass | n/a: Claude Code's own transcripts | n/a: Claude Code's own transcripts | n/a: Claude Code's own transcripts | n/a: Claude Code's own transcripts |
| The process watched and killed for sure | `hasProcess` | pass | pass | pass | pass | pass |
| Side calls (naming a worktree, drafting a task, chat answers) | `complete` | pass | pass (`codexComplete`) | pass (`openCodeComplete`: one prompt as an agent of Beluga's, its session dropped after) | pass (`copilotComplete`: one prompt without your instruction files, its session dropped after; each uses one of your Copilot requests) | pass (`grokComplete`: one prompt with Beluga's prompt as its whole system prompt, its session dropped after) |
| A side question (/btw) | `/btw`, `session.btw` | pass | n/a (`missing:btw`): Codex can't fork its thread, so /btw isn't offered in its conversations | pass (a fork of its session with no tools, dropped after) | n/a (`missing:btw`): Copilot can't branch its session, so /btw isn't offered in its conversations | pass (a fork of its session with every tool turned down, dropped after) |
| The agent's own terminal | `agentTerm.open` | pass | n/a (`missing:terminal`): no Terminal view; its conversations stay in the chat | n/a (`missing:terminal`): no Terminal view; its conversations stay in the chat | n/a (`missing:terminal`): no Terminal view; its conversations stay in the chat | n/a (`missing:terminal`): no Terminal view; its conversations stay in the chat |

## Runtime conformance (BLG-462)

The same scenarios run on every runtime (`tests/runtime-conformance.ts`, `npx vitest run tests/runtime-conformance.test.ts`): the in-memory reference, Claude's real runner over a scripted Agent SDK `query` (`tests/fake-claude.ts`), Codex's real runner over a scripted `codex app-server` speaking the payloads codex-cli sends (`src/agent/runtime/codex/scripted.ts`), OpenCode's over a scripted `opencode acp` speaking the payloads OpenCode 1.19 sends (`src/agent/runtime/opencode/scripted.ts`), Copilot's over a scripted `copilot --acp` speaking the payloads Copilot CLI 1.0.107 sends (`src/agent/runtime/copilot/scripted.ts`), and Grok Build's over a scripted `grok agent stdio` speaking the payloads Grok Build sends (`src/agent/runtime/grok/scripted.ts`). Where runtimes may differ, a capability flag says so and the scenario checks it both ways; mutants of the reference runtime prove a difference no flag covers fails the suite. **Live** runs against a signed-in Claude Code or Codex are waived (BLG-475: no Codex sign-in on the build Mac). OpenCode's free models need no account, so its live column is `scripts/live-opencode.ts` run against OpenCode 1.19.5 (steering and friends' tasks are refused before OpenCode is reached, so they're waived). Copilot Free needs only a GitHub account, so its live column is `scripts/live-copilot.ts` run against Copilot CLI 1.0.107 on Auto (steering and friends' tasks are refused before Copilot is reached, so they're waived). Grok Build's live column is `scripts/live-grok.ts` (signed in; steering and friends' tasks are refused before Grok is reached, so they're waived).

| Scenario | Claude | Codex | OpenCode | Copilot | Grok Build | Live Claude | Live Codex | Live OpenCode | Live Copilot | Live Grok Build |
|---|---|---|---|---|---|---|---|---|---|---|
| Start and answer, the step streamed | pass | pass | pass | pass | pass | waived | waived | pass | pass | pass |
| A command that asks, approved | pass | pass | pass | pass | pass | waived | waived | pass | pass | pass |
| A command you deny | pass | pass | pass | pass | pass | waived | waived | pass | pass | pass |
| Session id: one per place, kept on resume | pass | pass | pass | pass | pass | waived | waived | pass | pass | pass |
| Usage event under its session (`hasUsage`) | pass | pass | pass | pass | pass | waived | waived | pass | pass | pass |
| Steer while it works (`canSteer`) | pass | pass | pass | pass | pass | waived | waived | waived | waived | waived |
| Interrupt, the message answered next (`canInterrupt`) | pass | pass | pass | pass | pass | waived | waived | pass | pass | pass |
| Stop on abort, the open step ended | pass | pass | pass | pass | pass | waived | waived | pass | pass | pass |
| Friends' tasks and guests (`canGateEveryTool`, `hasSandbox`) | pass | pass | pass | pass | pass | waived | waived | waived | waived | waived |
| Model list (`hasModelList`) | pass | pass | pass | pass | pass | waived | waived | pass | pass | pass |
| A worktree on Codex: a task, an approval, Stop, hand off to Claude (`tests/codex-flow.test.ts`, through the daemon's Session; the Mac's `packages/mac/e2e/codex-flow.spec.ts` runs with the plan's e2e) | pass | pass | n/a: the same flow on OpenCode is `tests/opencode-flow.test.ts` | n/a: the same flow on Copilot is `tests/copilot-flow.test.ts` | n/a: the Grok Build flow is `tests/grok-runtime.test.ts` | waived | waived | n/a | n/a | n/a |
| A worktree on OpenCode: a run, approvals, a read judged on its path, a key file turned down, Beluga's tools, plan then approve, /compact, Steer Now, Stop, /btw, a side call, models (`tests/opencode-flow.test.ts`; live: `npx tsx scripts/live-opencode.ts`, a free model, no account) | n/a | n/a | pass | n/a | n/a: the Grok Build flow is `tests/grok-runtime.test.ts` | n/a | n/a | waived: 12 of its 14 checks passed live; then OpenCode's free limit ran out, so the side call (fixed since, and checked by hand against OpenCode) and the key-file check wait for the next run | n/a | n/a |
| A worktree on Copilot: a run, a command asked about and declined, a new file judged on its path, Beluga's tools over http, plan then approve, resume, /compact, Steer Now, Stop, a side call, a 403 for a model the plan lacks, models (`tests/copilot-flow.test.ts`; the Mac's `packages/mac/e2e/copilot-flow.spec.ts`; live: `npx tsx scripts/live-copilot.ts`, Copilot Free) | n/a | n/a | n/a | pass | n/a | n/a | n/a | n/a | pass | n/a |

## Beyond the shared actions

| What | Where |
|---|---|
| Window vibrancy, menu bar, menu-bar icon, `beluga://` links, Settings window, ⌘K palette, drag-and-drop images | Mac |
| A workspace's screen: the conversation always in the center; a right panel (⌥⌘0, resizable, its tab remembered per workspace; in two panes split where you drag it: what the agent made on top (Changes, Files, Scratch, Info) and what runs below (Terminal, Background; it folds to its tabs); drag a tab to the other pane or right-click › Move to Bottom / Top, Reset Panel Layout; tabs always named; History is Changes' second view; a dot on Scratch when the agent saves something new) with Changes (files with +/−, the diff inline or the file as itself; a line's + comments on it, Shift for a range, and the comment waits above the message box as a card (where, the line, what you said; × takes it away), its lines marked, until Send takes it after your words; the full-size diff says how many wait, with Go to Chat (`views/DiffComment.tsx`, `chat/CommentCards.tsx`) — Markdown formatted, pictures and PDFs always as themselves — Show in Files, Commit / PR / Review), Files (a tree you filter by name, a preview with PDFs drawn page by page, Show Changes on a changed file), Terminal (the workspace's shells, setup and run) and Info (the inspector); a calm toolbar (what the workspace needs next, Run, ⋯ in sections: git steps, the conversation, the folder, putting it away; then Search, the bell, the panel); ⌘J types in the terminal, and puts it away when you're already typing there; the agent's steps fold away once it answers (Show Steps on the answer, Settings › Chat to keep them); ⌘J's terminal in that panel or a drawer under the chat; a diff, file or the terminal in full for a while (⌘↩, Esc back) | Mac (`layout/RightPanel.tsx`, `layout/panel/*`, `lib/panel.ts`) |
| Dock badge, clicking a desktop notification to go where it's about | Mac |
| Marking one notification unread again | Mac (hover a notification) |
| First-run welcome: an eight-part animated tour (parallel worktrees, live agents, the table weave: the agent picks Postgres, connects and answers with a real, sortable table view, friends, Sentinel: a sentence becomes a sentinel (its trigger, steps and access, turned on, run step by step, its report) for five real ones you can pick, then Sentinel at work: its page's films with the sentence that sets each up, earnings, archive), then the look, the message box’s fire (Arcade, Ghost or None, tried in a live box) and a few shared settings; the macOS permissions one a step, each optional (Not Now, Skip Permissions) with why in a sentence, whether Beluga has it, and a button to its System Settings pane: Screen Recording, Accessibility, Full Disk Access, Automation (`privacy_access`, `privacy_request` in `src-tauri/src/privacy.rs`); notifications (allowed or not); the Android phone app with Pair a Phone… (`companion.pair.start`) and where to get it; once per Mac, never after an update; Help › Welcome to Beluga shows it again | Mac (`onboarding/*`, `lib/privacy.ts`) |
| Local UI preferences (appearance, accent, text size, density, widths) | Mac (`lib/prefs.ts`) |
| Terminal look (font, size, line height, cursor style and blink, scrollback) | Mac (`lib/prefs.ts`, Settings › Terminal) |
| Environment variable editor (masked values, a copy button, paste KEY=value lines, search past ten, Undo after removing; a project's main folder .env loads by default and shows beside its own variables, with yours greyed below, each marked where it comes from, an edit to one overriding it and Use … undoing that, Keep a Copy in Beluga; names .env.example asks for that nothing sets shown empty as needed; a worktree's own variables over everything else) | Mac (Settings › Environment: yours and a list of projects; a project's Settings sheet with General, Environment and Worktrees tabs from the gear on its page, ••• › Project Settings… and Environment…, ⌘K › Project Settings… and its page's Environment pill and section; a worktree's ••• › Environment…: `dialogs/EnvEditor.tsx`, `dialogs/EnvironmentSheet.tsx`, `dialogs/native/ProjectSettingsSheet.tsx`). The phone gets none of it: settings stay the Mac's |
| A worktree changed a .env the main folder doesn't have: an env bar (its keys as +added ~changed −removed tags) with Copy to Main Folder and Keep Here, in the project page's Environment section and in the worktree; untouched copies follow the main folder's .env on their own; keys a worktree adds or removes reach its own .env.example (BLG-925) | Mac (`views/project/EnvAsks.tsx`, `views/project/EnvSection.tsx`) |
| Confirmations as alerts (archive/delete with “Commit & Archive”, an env-changes table, and boxes to carry a worktree's own variables to the project, copy its .env changes, and also remove keys it took out; clear, agent worktrees, hide project, leave a shared workspace), each with Cancel | Mac (`dialogs/native/*Alert.tsx`, `components/Alert.tsx`) |
| Inviting, people and sharing as sheets and cards: the Invite People sheet (Invite to popup, Watch / Prompt / Edit, Copy Invite Link with “Copied”, people waiting, active links with Copy and Revoke), a person's card beside their row (trust as a segmented control, Message / Ask Your Agent / Run / Follow / Files, usage meters, Remove with an alert), your account card (rename in place, who may use your agent), a right-click Trust ▸ submenu, the Share sheet for a workspace (an access popup per person), Share a Folder (Open panel, your projects, only some people, the agent may edit, Stop Sharing), the room's card from the sidebar's status | Mac (`dialogs/native/InviteSheet.tsx`, `PersonPopover.tsx`, `PersonCards.tsx`, `PersonMenu.tsx`, `WorkspaceShare.tsx`, `ShareFolderSheet.tsx`, `SharedSheet.tsx`, `RoomPopover.tsx`) |
| Addressing a message with a chip (“To bob”, “To bob's agent”, “To your agent”) | Mac (`MacUi.to`, the composer) |
| Run a command on a friend's computer from a sheet with a command field | Mac (`dialogs/native/PeerSheets.tsx`) |
| Search over a workspace shared with you (names and contents) above its Files, instead of a read-only shell tab | Mac (`views/SharedSearch.tsx`) |
| A shared workspace's earlier conversation drawn as people's messages | Mac (`lib/said.ts`, from each line's `said`) |
| Clicking an invite link (`beluga://<key>…#secret`) opens the Join sheet | Mac (`lib/native.ts` `inviteOf`) |
| Forms instead of typing in the message box: fork name, project Setup/Run (with where each comes from, and “Save to beluga.json”: `workbench.setScript(…, team)`), PR with extra instructions, new template with Plan first (`workbench.saveTemplate(…, plan)`), hand off, a worktree or a command on a friend's computer, the model, the welcome choice | Mac (`dialogs/native/`, `lib/native-routes.ts`) |
| Colours in the sidebar: right-click a project, chat or worktree › Color ▸ (the board's label colours, or None; a chat or worktree also has Same as Project): a soft stripe at the row's edge and its icon in the colour, in the project list, Chats, Unread and the categories; a project's chats and worktrees take its colour unless they have their own; a project's letter tile takes it too. Nothing is coloured until you pick one; kept on this Mac | Mac (`lib/row-colors.ts`, `layout/row-color-view.tsx`) |
| Groups in the sidebar: Move to Group ▸ submenu, a new group named in place, rename, ungroup (`workspaces.renameGroup`, `workspaces.ungroup`), drag a project onto a group or out of it | Mac (`layout/ProjectGroups.tsx`) |
| Arranging the sidebar Finder-style: drag projects to reorder them (an insertion line, the list scrolls near its edges, Esc puts it back), drop one on a group (the folder lights up; a folded one springs open) or between a group's projects, pull it out to the top level, drag groups among the projects; Move Up / Move Down (⌃⌘↑/↓) in a row's menu; empty groups you make stay until you delete them (`workspaces.arrange`, `workspaces.newGroup`; the order lives in projects.json's `order` and each group's list, see `src/workspaces/arrange.ts`). Project rows don't fold (their worktrees and chats always show, never the main checkout; clicking one opens the project); groups fold, with a count | Mac (`layout/ProjectTree.tsx`, `layout/arrange-drag.ts`, `layout/project-layout.ts`) |
| Hiding a project with Undo (“Hidden api — Undo”, ⌘Z) instead of an alert; Hidden Projects folded at the bottom of the sidebar, in Settings › Workspaces and in the Add Projects sheet, each with Show (`workspaces.showProject`; it comes back in its place and group) | Mac (`layout/ProjectTree.tsx`, `lib/undo-toast.tsx`) |
| “Connect GitHub” with copyable commands and Check Again (`workbench.refreshPrs(id, true)` looks for gh again) | Mac (PR sheet) |
| Stop your agent in one conversation (`host.stopRun`): your queued messages there come back into the box, other people's requests keep their places and run next, other conversations carry on | Mac (■ Stop beside the send control, ⌘., Conversation › Stop the Agent, Stop on a running answer) |
| Workspace and Conversation menus in the menu bar (Commit… ⇧⌘C, Pull Request… ⇧⌘P, Merge… ⇧⌘M, Run ⌘R, Ask Your Agent to Review… ⇧⌘R, Archive… ⌃⌘A, Stop ⌘., Plan First ⌥⌘P, Find ⌘F / ⌘G / ⇧⌘G, Clear ⇧⌘K, Previous/Next Workspace ⌥⌘↑/↓), greyed out when they can't run (`lib/commands.ts`, `set_menu_state`); what starts the agent or changes git (Review, Commit, Merge, Solve Conflict, Compact, Fix Checks) says what it will do and waits for Start, from every way in (a popover under its toolbar button, else an alert; `lib/work-confirm.ts`) | Mac |
| A search field at the top of the sidebar (⌥⌘F): chats by name, branch, PR or project at once, then messages through `workbench.search`; arrows and Enter, Esc clears, See All in Search opens the Search page | Mac (`layout/SidebarSearch.tsx`) |
| A calm sidebar: Overview, Work (Tasks, Issues and Plans in one row, a Tasks · Issues · Plans switch over each list, running plans under it) and Group chat at the top, always; Activity only while it's live and Requests only while one is unanswered (answered ones are tucked behind Show answered on the Requests page); Files (folders friends and the room share, grouped by person) as a row of its own, and projects friends share in Projects (there is no Shared with me any more); Search in the toolbar (⇧⌘F); Usage as an icon above the sidebar (amber when most of the week is used); the terminal in the right panel (⌘J). The places in order (Overview, Tasks, Chat, Search, Usage, Terminal, Files) for ⌘1…7, ⌃Tab, the Go menu and the palette (`lib/go.ts`) | Mac |
| The toolbar's main button chosen from the workspace's state (Commit / Merge / PR #n / Fix Checks / Solve Conflict / Restore / Run), the rest as icons and a ⋯ menu with shortcuts (`layout/toolbar-actions.ts`) | Mac |
| Select chats with Shift-click in visible sidebar order, across Chats and project chats. Selected rows that touch read as one box, with a dashed line between rows, and a count shows under the lists; both ease in and out. Their context menu archives or deletes the full selection after one confirmation with the count. A failed chat does not stop the batch, and one message reports the whole batch. The alert names failed chats, and they stay selected. While a batch runs, its chats stay selected. Escape or a plain click clears the selection, and the next Shift-click still starts from the last clicked chat. Folded projects and groups stay outside the selection. | Mac (`layout/chat-selection.ts`, `layout/chat-selection-view.tsx`, `layout/ProjectTree.tsx`, `layout/workspace-row.tsx`) |
| Find in a conversation (⌘F) | Mac (`chat/FindBar.tsx`) |
| Your own keyboard shortcuts (BLG-289): Settings › Keyboard (Help › Keys and Commands, ⌘/, ⌘K › Keyboard Shortcuts…) lists every shortcut by section; click a key and press the new one, + for another key, × to take one away, ↺ back to its own, Reset All with Undo; a key something else has offers Swap / Use Here / Cancel (↩ / esc), what macOS keeps (⌘Q, ⌘C…) and keys that would type are refused with why; find a shortcut by name or by pressing its keys (and see a key is free). The window, the pages' own keys, the message box, requests, the sidebar, the talk shortcut, the menu bar's accelerators (`set_menu_keys`, off while recording), tooltips and the palette all follow; kept on this Mac (`prefs.shortcuts`) | Mac (`lib/shortcuts-model.ts`, `lib/shortcuts.ts`, `dialogs/KeyboardSettings.tsx`) |
| Right-click menus: messages (Copy, Copy as Markdown, Quote in Reply, Ask Your Agent About This, Open Image), code blocks, files (Open, Show in Finder, Copy Path, Mention in Chat, Save a Copy…), a path named in chat (Open, Show in Finder, Copy Path), changed files and commits in Diff, search results, Usage rows, notifications | Mac |
| Save a shared file where you choose (`files.download` with `to`, the Save panel) | Mac |
| A new worktree's form: Based on (`workspaces.branches`), Name, Create Worktree (`workspaces.startWorktree` with `base` / `name`) | Mac |
| No standing main conversation per project (BLG-70): a project's conversations are the chats and worktrees you start; the main checkout is the project's home (Update main, Fetch, Merge into main, its terminal), not a conversation. Nothing lists or opens it as one (sidebar, Overview, ⌘K, @mentions, the project menu, notifications, the phone's Work and Open on your Mac go to its home or the chat it became), and the agent never runs in it on its own. Once, at startup, a main conversation from before becomes an ordinary chat in its project with its history, agent session, model and usage, named after its first message (`workspaces/main-migration.ts`; an empty one goes) | both (core: `workspaces/main-migration.ts`, `client/screen.ts` `viewFor`, `core/workspace-controller.ts`; Mac: `lib/project-home.ts` `newChatProject`) |
| Never change main: every agent run in a project's main folder (the main checkout, or a chat there) is questions only. Edits, writes and shell commands that aren't clearly read-only are denied (`agent/policy.ts` `askOnly`, `agent/read-only.ts`), the agent is told so, and a change request makes it call `continue_in_worktree`: a new worktree from the latest origin, named after the task, and the chat itself becomes that worktree (same conversation and agent session, now in the worktree's folder), and the work goes on there (your own requests move right away; someone else's ask you first) | both (core) |
| A project's home (`project` view): icon, name, main's branch and how it compares with origin, counts (active / ready to merge / archived, earnings), “What do you want to do in …?” with New Worktree (Based on, Name) or Just Ask, then its worktrees, questions and recently archived (Show All in Overview), and last (with Stripe or RevenueCat connected) its Earnings as one folded row: earned in the last 7 / 30 / 90 days, payments and paying customers (Stripe's), each against the span before, and the last payment; unfolded (both kept), the range, a bar per day, each source's part of it (with both), RevenueCat's MRR, active subscriptions, active trials, new customers and "You keep" with Open RevenueCat, and Stripe's latest payments (All / Refunds / Failed, New for what arrived while shown, Show All, Open Stripe; Earnings… for the sheet). Clicking a project opens it | Mac (`views/ProjectHome.tsx`, `lib/project-home.ts`) |
| Keeping main current and seeing history: the project home is about the default branch (main or master, “3 behind origin/main”, and “The main folder is on feat/…” with Switch to main), Update main and Fetch with when it last fetched, a quiet fetch of every project every ~15 min (Settings › Workspaces › Fetch in the background makes it slower, or turns it and the fetch on opening a project off; never a password prompt: GIT_TERMINAL_PROMPT=0), uncommitted changes in the way (stash and put back, or move to a worktree), anything else to the agent in a run whose only permission beyond reading is syncing git (`agent/sync-main.ts`; never push, never discard), the GitHub row, and History (a commit graph with lanes and merges, authors as initials, refs as pills, filters, a commit's diffs; `views/history/*`) | Mac (`views/project/MainSyncBar.tsx`, `views/project/GitHubRow.tsx`, `views/history/*`, `layout/panel/HistoryTab.tsx`; core: `core/main-sync.ts`, `workspaces/sync.ts`, `workspaces/history.ts`, `workspaces/github.ts`) |
| A questions-only chat: “Questions only — your agent won’t change anything in main.” above the box, Continue in New Worktree… as the toolbar's main button, “Ask about <project>…” in the box | Mac (`chat/AskBanner.tsx`, `dialogs/native/ContinueSheet.tsx`) |
| Sub-agents: under the conversation that started them in the sidebar (a robot, running first, “N more”), their own worktrees as the agent (never as your worktrees; old ones no conversation here started aren’t listed, Clean Up Worktrees… has them), the sub-agent page (who started it, type, model, effort, time, steps, context; its live transcript with thinking and tools; its worktree's Changes, Files and Scratch beside it; Send to Main Agent to steer it through its lead), Watch on a sub-agent in the chat | Mac (`src/layout/SubAgents.tsx`, `src/claude-code/AgentMonitor.tsx`) |
| Chats with friends: tabs above the conversation (All Friends first; open, close, + for a new channel), files shared Mac to Mac (cards, pictures, progress, Open / Show in Finder / Save As), agents called in with the Ask Your Agent menu (answers marked “bob’s agent”, “… is answering”), Settings › People & access › Who can ask your agent in chats; a task between two people's agents as a live card in their DM or channel (BLG-208), your own agent acting there with its tools, its "Ask Alice's agent?" cards, approvals and questions above the message box, and friends' requests approved on their card (BLG-207) | Mac (`src/network/ChatTabs.tsx`, `ChatFiles.tsx`, `NetComposer.tsx`, `ConversationView.tsx`) |
| Friends, direct messages, groups and your status (the Beluga network): sidebar Friends and Groups with presence and unread, the Add a Friend sheet (code, link, QR; `beluga://add` / `beluga://join` links), conversations (`conversation` view), New Group / Add People sheets, group info (members, admins, invite link, join requests, rename, leave), the status menu in the sidebar and the menu bar, Away when idle, Settings › People & access switch | Mac (`src/network/*`) |
| Empty states with one-click starters (New Worktree, New Chat, Add Projects…, first tasks for the agent) | Mac |
| The palette's commands as named actions (“Create Pull Request…”, “Fork This Workspace…”), never `/cmd <arg>` | Mac (`dialogs/palette-commands.ts`) |
| The Beluga network: friends added once by a one-time link or a short code, direct messages that wait for offline friends, groups that live on their members' Macs (no host, end-to-end encrypted, admins add and remove people, join by link), and your status (online, away, do not disturb, appear offline) — the `network.*` API and the shared state's `network` | Mac (the daemon runs it when `network: true` is in settings or `BELUGA_NETWORK=1`; `src/net/mesh/`, `src/core/network.ts`) |
| Earnings from Stripe and RevenueCat per project, added into one total (the Earnings… sheet connects either; RevenueCat apps billed through a connected Stripe account are left to Stripe so nothing counts twice; RevenueCat's own keys live in ~/.beluga/revenuecat.json, 0600, and its `revenuecat` state carries the apps, totals, proceeds and subscription figures, never the key). Stripe's part: a key per project (kept in ~/.beluga/stripe.json, 0600; screens only get `earnings`: connected, the account's name, all-time totals per currency, what it did lately (`activity`: the last 180 days' earnings per day, distinct paying customers per 7 / 30 / 90 days and the span before, the latest 25 payments with a first name and initial or a masked email, never more), when they were counted, what went wrong), counted in the background (a quick look for new payments every 10 minutes, the last months read again when something came in or once a day, a full recount weekly), shown as a pill beside each project in the sidebar (a new Stripe payment: it hops, and pixel-art confetti bursts from it; a rise in RevenueCat's total: it hops without confetti; none with reduced motion), as the Earnings section of the project's home, and as a card in the Overview and the Usage view, every total in one currency (`prefs.earningsCurrency`, "Show earnings in" in Settings › General and the Stripe sheet; unset: the one most was earned in), other currencies converted at the ECB's daily rates (`src/core/fx-rates.ts`, `fx` in the shared state, fetched alongside the daily Stripe count) — the `stripe.*` and `revenuecat.*` APIs and the shared state's `earnings` and `revenuecat` | Mac (`src/core/stripe-earnings.ts` and `stripe-activity.ts`, `src/core/revenuecat-earnings.ts` and `earnings-combined.ts`, the daemon runs them; `components/EarningsPill.tsx`, `components/PixelBurst.tsx` and `pixel-burst-model.ts`, `views/project/EarningsSection.tsx`, `dialogs/EarningsSheet.tsx`, `lib/earnings.ts`) |
| Supporting Beluga: worktrees Beluga made that end up merged (Merge into main, a pull request merged on GitHub, or git finding the branch's own commits in the default branch: archived worktrees too, and a deleted one just before its branch goes) count once per branch, kept in ~/.beluga/support.json; the third merge brings the Star sheet, once ("You shipped your 3rd PR with Beluga"): a paper-cut ocean of blue layers with the whale rising out of it (still with reduced motion), the maker as a GitHub chip, a GitHub-style Star button with the count, Share feedback (a new GitHub discussion), and the number yours would be (the daemon asks GitHub's public API once a day, nothing about you sent; no number when it can't), Star Beluga on GitHub or Maybe Later. Beluga never asks for money. Settings › About › Support Beluga (Star on GitHub) and the palette's Star Beluga on GitHub… have it any time ("Enjoying Beluga?") — the `support.*` API and the shared state's `support`. The phone never asks | Mac (`src/core/merge-counter.ts`, `src/core/support-store.ts`, `src/core/github-stars.ts`, the daemon runs it; `dialogs/SupportSheets.tsx`, `dialogs/StarScene.tsx`, `lib/support.ts`) |
| Usage statistics (BLG-922): only Beluga's own releases can send them (`telemetry-release.json` beside the daemon, written by `scripts/build-sidecar.mjs` from `BELUGA_TELEMETRY_URL` and `BELUGA_TELEMETRY_KEY`, a Ratel ingest-only key); a build from source never asks and never sends. Off sends nothing; Limited sends each turn of every runtime as spans (model, tokens, cost, tools by name, how it ended), features used (API method names, counted per minute), Claude Code's own telemetry without who you are, and this computer's kind; On adds the words you typed (never what Beluga adds to the prompt) and the agent's answers on your own turns, masked on this computer first (your variables' and the projects' .env values, keys by their shape, emails, home folders). Never files, commands, other people's messages, or error messages. New installs choose at the end of the onboarding (Limited picked); updated ones get one ask; Settings › General › Usage statistics and the phone's Settings change it (docs/telemetry.md) | Mac (`src/telemetry/`, `src/core/telemetry-store.ts`, the daemon runs it; `onboarding/ShareStep.tsx`, `dialogs/TelemetrySheets.tsx`, `dialogs/TelemetrySettings.tsx`), phone (Settings) |
| Your stats (Usage tab): the daemon counts prompts (where you typed them), characters, your agent's run time for you, worktrees and chats made and archived, tokens per day, project and agent, and how far each plan window (5-hour session, week) got before it reset, as they happen (pastes and dictation time come from the Mac's composer, lengths only), kept in ~/.beluga/stats.json; the first start backfills from workspace records and chat histories, and pull requests (opened, merged, lines) come from `gh pr list` for Beluga's branches every few hours; the Usage tab asks for them with `stats.get` while it's open. The phone keeps its plan meters | Mac (`src/core/stats/`, `src/shared/stats.ts`, `src/shared/stats-trend.ts`; `views/usage/StatsSection.tsx`, `views/usage/SessionsCard.tsx`, `views/usage/TrendChart.tsx`, `views/usage/stats-model.ts`) |
| Claude Code running outside Beluga, live and read-only: sessions you run through Conductor or a terminal, and their sub-agents (description, type, running / finished / failed / stopped / idle, the current step, steps, context), found by watching the transcripts Claude Code writes in ~/.claude/projects (never written to; tailed from the end, at most the last 200 steps per agent kept), in Activity (every live session by project, “6 agents running”), a strip above a workspace's chat and the Inspector's Claude Code panel (the session's folder is the workspace's, Conductor worktrees included), and a read-only transcript per session or agent; a background agent finishing notifies (`background`) — the `claudeCode.steps` API and the shared state's `claudeCode` (screens on this computer only, never sent to the room) | Mac (`src/core/claude-code/`, the daemon runs it; `src/claude-code/*` in the app) |
| A chat's link (`beluga://chat/<owner>/<channel>`): Copy Chat Link on the right-click menu of worktree, project-chat, plan and Your Mac rows and of Your Mac's tabs; opening one from anywhere, or from a message, shows that chat; a chat on another computer or a removed one says so and stays where you are. The phone opens links too (`app/chat-link.tsx`) and has no Copy Link: it has no row menus | Mac (`lib/chat-links.ts`, `lib/native.ts`, `chat/Markdown.tsx`) · phone (`app/+native-intent.tsx`, `app/chat-link.tsx`) |
| The Worktrees page: every worktree in your projects (Beluga's, sub-agents', made outside Beluga) with who made it (a sub-agent's conversation, or that it's gone), whether its work is done, its size and what can be cleared; tick some, then Free Up Space (they stay) or Archive (everything of yours kept); the sidebar's Worktrees row, a project's Manage Worktrees… | Mac (`src/views/worktrees/`) |
| Tasks between agents (the gateway): your agent finds who can help (`who_can`), asks their agent (`ask_person`) or runs one command on their Mac (`run_on`), waits (`wait_for`) or ends its turn and continues when the answer comes back; you're asked first for people you don't trust (a card in the conversation), their side approves with today's approval cards unless they trust you; results go only to the requester, as data. Task cards in conversations, the Requests view (Sent / Received) — the `gateway.*` API and the shared state's `gateway` | Mac (`src/core/gateway/`, the daemon runs it; `src/gateway/*` in the app) |
| Tasks (the board): a Tasks place in the sidebar with My Tasks, Active, Backlog and All, by project; a list grouped by status, a board you drag cards across, and a graph of what waits on what (the graph engine); filtered by who or by the worktree doing or carrying them (a worktree's Info tab lists its tasks and opens the board filtered to it); a task's page (its title, properties, a brief in sections that the agent and you keep true with every version kept, sub-tasks, blockers, its worktree and pull request, proof, activity and comments); a task opens with every new worktree and follows its pull request (In Review when it opens, Done when it merges); Start on a task (or Start Worktree Only), Open Worktree when one already does or carries it; your agent's runs in a task's worktree get its brief and the task tools (`mcp__beluga_board__*`) — the `board.*` API and the shared state's `board` | Mac (`src/core/board/`, the daemon runs it; `src/tasks/*` in the app) |
| GitHub issues: a project's issues in Beluga (the Issues place in the sidebar, an issue's page, the latest four on a project's home), read through gh with your own sign-in. One click hands one to the agent, always through a task, so it shows on the board and its pull request moves it along: Investigate (a worktree where the agent finds out why and reproduces it, its findings in the task's brief and on the issue's page, stopping before any fix), Fix It (there, or in a new worktree, with a pull request that says "Fixes #n"), Make a Task (written by the agent from the issue, or after a quick read-only look at the code). A task made from an issue links back to it (its page, its row, the strip above its conversation) and the agent's runs on it know the issue — the `issues.*` API and `Issue.github` | Mac (`src/core/issues/`, the daemon runs it; `src/issues/*` in the app); the phone sees the tasks, not the issues yet (BLG-170) |
| Team boards (BLG-220): friends with the same GitHub repository as a project on their own Macs find each other by a fingerprint keyed for the two of them (a friend who lacks the repository learns nothing), team up when both say yes, and keep one board for it; the team badge (teammates' avatars) on the project's row, Leave Team in its ••• — the `team.*` API and the shared state's `team` | Mac (`src/core/team/`, the daemon runs it with the board; `src/team/*` in the app); phone: the offer as a card |
| Sentinel (docs/sentinel.md, BLG-236): watchers that run on a schedule, by hand or after another sentinel, do a few steps in order (Ask Your Agent in the project, a worktree or Your Mac; Run a script with your environment; Notify me; Call a service with presets; Open a pull request; Merge if acceptable — checks, a review, your Merge; Message a chat; Ask a friend's agent; Run another sentinel) and leave a report; your agent sets one up or changes it (`sentinel.ask`); one run per sentinel at a time, at most Run at Once agent steps together, a time limit, runs per day, pausing after failures in a row; missed slots caught up once or skipped; ~/.beluga/sentinel.json and each run's folder in ~/.beluga/sentinel/runs — the `sentinel.*` API, the agent's `mcp__beluga_sentinel__*` tools (`sentinel_stop` inside a run, `sentinel_list`, `sentinel_get`, `sentinel_create`, `sentinel_update`, `sentinel_run`, `sentinel_test`, `sentinel_try_source`, `sentinel_pause`, `sentinel_remove`, `sentinel_runs`, `sentinel_delete_runs`) and the shared state's `sentinel` | Mac (`src/core/sentinel/`, the daemon runs it; the window's Sentinel section: the sidebar's Sentinel row, the list, a sentinel's page, a run's page, New Sentinel with its eleven recipes, ⌘K › Go to Sentinel and New Sentinel…, Go › Sentinel); the phone runs, pauses and reads runs (`sentinel.run`, `pause`, `runs`, `runGet`, `decide`) |
| The Sentinel chat (docs/sentinel.md §12, BLG-246): one conversation with your own agent for the whole of Sentinel (several kept, one open), its system prompt telling how Sentinel works with the sentinels, dashboards and numbers as material, the `beluga_sentinel` and `beluga_dashboard` tools; creating, changing and running without asking, deleting a sentinel or a dashboard always asking your approval; quiet (not in the sidebar's chats, Unread or notifications); ~/.beluga/sentinel/chat — the `sentinel.chat*` API, the `sentinel-chat:<id>` channels, the shared state's `sentinel.chats` | Mac (Sentinel › Chat: the app's own chat with its bar, New Chat, ⋯ › Clear and Delete Chat…; ⌘K › Go to Sentinel Chat); the phone's Sentinel screen › Chat opens it as a conversation it writes and answers in (`SentinelsView.chat`, `companion.ask`) |
| Numbers and dashboards (docs/sentinel.md §10, BLG-244, reworked in BLG-246): a Keep the numbers step (`measure`: from the step before, a view source, or the agent's `sentinel_measure`) keeps named numbers, series (a whole array), rows or a step's output per run in ~/.beluga/sentinel/metrics/<sentinel>/<name>.jsonl (two years or 20 000 points); the state carries each metric's last 90 points and last rows; dashboards in ~/.beluga/dashboards.json — the `dashboard.*` API and `sentinel.metricRead`, the agent's `mcp__beluga_dashboard__*` tools (`sentinel_measure` inside a run, `dashboard_list`, `dashboard_create`, `dashboard_update`, `dashboard_remove` (asks you), `dashboard_add_tile`, `dashboard_update_tile`, `dashboard_move_tile`, `dashboard_remove_tile`, `metric_list`, `metric_read`), six number recipes | Mac (a sentinel's page › Numbers above History; Sentinel's Dashboard tab (Sentinels · Dashboard · Chat at the top of the Sentinel page; ⌘K › Go to Dashboard and Go › Dashboard land there): tile kinds number, series, table, output, text and divider, sized and retitled from a tile's ⋯, its tabs, compare, Refresh, Add a Tile by description (a draft sentinel when nothing fetches it yet) or picked, drag; New Sentinel › Recipe › Keep the numbers); the phone's `dashboard:<id>` screen with compare chips and pull to refresh, Home's row of the first dashboard's first three numbers (`dashboard.refresh`, `sentinel.metricRead`) |
| Agent threads (`prefs.agentThreads`, off by default): an agent starts child chats on any installed harness and follows them with `mcp__beluga_threads__*`; no new screen, children show as normal chats | Mac (`src/core/threads/`, the daemon runs it) |
| Plans: milestones with pass criteria and parallel tasks, drafted by the agent in a conversation and kept off the board until approved; a live plan graph and outline; Step by Step · Check-ins · Autopilot run by a scheduler that starts worktrees and asks the agent to check each milestone; the composer's Plan with Tasks — the `plans.*` API, the agent's `mcp__beluga_plan__*` tools and the shared state's `plans` | Mac (`src/core/plans/`, the daemon runs it; `src/plans/*` in the app) |
| Your Mac (BLG-47): one conversation with your own agent for the whole Mac, not one project, the same on the phone and the Mac (the `assistant` view, channel `mac:assistant`). It runs in ~/.beluga/assistant/work (its scratch folder's files are its outputs on the phone; its session and history beside it stay secret), with your usual approvals, and its tools (`mcp__beluga_mac__*`: `screenshot`, `device_info`, `list_work`, `start_worktree`, `start_task`, `start_plan`, `archive_worktree`) plus the board's. Since BLG-565 it archives a worktree you ask it to, through `workspaces.archive` (lossless and restorable; a worktree with Claude still working waits for your yes). What it starts it names as `worktree:<id>`, `task:<KEY>`, `plan:<id>`, drawn as links on both screens. Since BLG-102 it holds several chats, tabs above its conversation on the Mac (the `assistant` view's `chat`; channels `mac:assistant` for the first, `mac:assistant:<id>` for the others; the shared state's `assistant`): + starts one, × deletes one for good after asking (no archive), and the open tab is kept across restarts (~/.beluga/assistant/chats.json; each chat's session and history in `chats/<id>/`, the old single chat moved into `chats/main/`) | Mac (the sidebar's top row, `layout/AssistantNav.tsx`; the tabs, `chat/AssistantTabs.tsx`; core: `src/core/assistant/`, `src/agent/mac-tools.ts`); phone (the Ask sheet's first target and Home's Ask your Mac: the chat open on the Mac; its other chats by name where conversations are listed) |
| Web access (BLG-649, BLG-650, docs/web.md): the daemon serves the whole UI to browsers on its own web port (127.0.0.1:7777; `beluga web --listen host:port --allow-host name`), apart from the token socket; a browser is let in once by a join link (`/join#<secret>`, 10 minutes, one use) and keeps an HttpOnly, SameSite=Strict session cookie (only its hash kept, in ~/.beluga/web-sessions.json); without one it gets only the Ask for a link page and no socket; revoking one cuts it off at once; the port reopens at each start until closed (~/.beluga/web.json) — the `web.*` API | Mac (Settings › Advanced › Web access, `dialogs/WebAccessSettings.tsx`; core: `src/daemon/web*.ts`); the browser shows the Mac app's own UI |
| Graphs the agent draws (`beluga-graph` blocks: interactive diagrams laid out by ELK and drawn with React Flow, in answers, reports and Markdown files; hover, details, walkthrough, full window) | Mac (`components/graph/*`; the format is `src/shared/graph-spec.ts`, the agent learns it from `agent/graph-prompt.ts`) |
| Views the agent shows (`beluga-view` blocks and the `show` tool: tables, charts, stats, code, colors; live from a file, folder, SQLite, Postgres, a web address or a command, paged, sorted and searched without the agent) | Mac (`components/views/*`; the format is `src/shared/view-spec.ts`, sources run in `core/views/sources.ts`, the agent learns it from `agent/view-prompt.ts`) |
| Mention grammar (BLG-443): `@bob` asks bob's default agent, `@bob:codex` one of theirs, `@agents` everyone's default; `@claude`, `@claude:bob` and `@claudes` stay aliases (a person named claude is `@claude:claude`, with a hint); a mistyped name gets "Did you mean @bob?" and a person with no published default gets their Claude, each said in a toast; the request carries the agent (`agent_request.agent`) | both (core: `core/mentions.ts` `parseInput`, `core/session.ts` `submit`; the phone sends what you type through the same `submit`) |
| Agent tags in the room (BLG-520): "@" lists your own agents that run here (`@codex`) and each person's that their card lists (`@bob:codex`, `@bob:claude`), each with its mark; a named agent rides the room ask (`agent_request.agent`, only for `@codex` / `@bob:codex`, not `@bob` or the `@claude…` aliases) and their Mac runs it when its card lists it and it runs there (yours: any that runs here), else their default with `agent_event.fallback`; the asker's room gets a line when another agent answers (not set up there, or an older Mac); the answer is labelled with the agent that ran | both (core: `shared/agent-tags.ts` `roomAgentTags`, `core/agent-host.ts` `pickNamed`, `core/session.ts` `sayWhoAnswers`; Mac: the room's composer list, `chat/Suggestions.tsx` marks; phone: `ConvView.tags` as chips over the room's message box, `components/Composer.tsx`) |
| Your default agent (BLG-444): who answers `@you`, in Settings › Agent ("Answers when friends write @you") and per project in its Settings sheet (`session.setPrefs` `defaultAgent` / `projectAgents`; a project's wins, `core/settings.ts` `chosenAgent`); published on your peer card (`defaultAgent`, `agents`) at once, without reconnecting | Mac (`dialogs/Settings.tsx`, `dialogs/native/ProjectSettingsSheet.tsx`, choices from `ui/agent-choice.ts`); the phone shows friends' defaults it gets on their cards |
| Models in chat, and thinking effort for one conversation: Settings › Agent › Models in chat turns each model on or off (`session.setPrefs` `openModels`, empty: every model, and it follows your other computers). The chat’s model menu, `/model` and the phone’s picker list only the ones that are on. In a conversation the thinking meter sets that conversation’s effort (`workbench.setEffort`; clear it and Settings apply again). On a project’s home the same picker sets the model and effort for new conversations | Mac (`dialogs/Settings.tsx`, `chat/ModelPicker.tsx`, a project’s home in `views/ProjectHome.tsx`, `src/shared/open-models.ts`); the phone’s picker shows the same models and does not set effort |
| A chat's family on the phone (BLG-172): Work's rows show each chat's harness mark and a child under its parent; a chat's ••• › Threads has its parent, its children, their live state and Stop, and its native sub-agents as read-only rows in the same list (no Stop; `ThreadFamilyView.agents`); a need in a child names it. Off with Agent threads off | Phone (`app/(tabs)/work.tsx`, `components/ThreadsSheet.tsx`, `src/companion/thread-family.ts`); the Mac's sidebar and Right panel › Threads |
| Agent threads (BLG-171): Settings › Advanced › Agent threads turns the thread tools on (`session.setPrefs` `agentThreads`, off by default; the next run has them or not), and Settings › Agent › Thread limits sets `threadLimits` (depth, working in one tree, kept in one tree, working on this computer; the next `thread_start` reads them). No agent tool writes them | Mac (`dialogs/AgentThreadsSettings.tsx`); settings stay Mac-only, so the phone has neither |
| A chat with threads (BLG-170): its archive and delete dialogs ask once whether its threads go too (`workspaces.archive` / `workspaces.remove` `children: 'with' \| 'keep'`; archive's default is with, delete's is keep; with `with`, a picked row under another picked row gets no call of its own, `lib/thread-family.ts` `batchCalls`). The usage card's Archive, typed `/archive` and `/delete`, and the sidebar's chat selection keep the threads and ask nothing | Mac (`dialogs/native/ThreadsChoice.tsx`, in the confirm alert, Overview's delete and the Worktrees view's `BatchAlert`); the phone's Archive and Delete sheets ask the same question with the same defaults (`companion.branchStep`'s third argument, `BranchView.threads`) |
| Continuing after a usage limit (BLG-757): a run that stopped on your plan's usage limit is told “Continue where you left off.” a minute after the limit resets (30 minutes after it stopped when the reset isn't known), on by default, in worktrees, project chats, Your Mac's chats and the Sentinel chat, never in the room, DMs or groups, nor a sentinel run's chat (the sentinel runs again itself), nor into an archived worktree or hours late (`core/auto-continue.ts`; plans resume their own with the same switches, `core/plans/watchdog.ts`). The limit card says when it sends and offers Don't Send › For This Session / Never in This Chat / Everywhere; turned off, it shows Continue and Send at HH:MM to undo (`session.setPrefs` `autoContinue` / `autoContinueOff` / `autoContinueSkip`, rules in `shared/auto-continue.ts`) | Mac (`chat/Items.tsx` LimitResume, Settings › Agent › Usage limits in `dialogs/UsageLimitSettings.tsx`); the phone says “Continues on its own at HH:MM” under the card (`TurnView.resumesAt`, 1.42), read-only |
| Your computers (docs/machines.md): the Runs on chip beside the mode and model wherever work is made (the chat's box, a project's home, New Plan, New Sentinel), This Mac, each computer with its line or why it can't take the work, and Best Available; the last pick remembered per project; shown only once a computer is paired | both (Mac: `chat/RunsOn.tsx`, rows from `machines/runs-on-model.ts`; phone: New Task › Runs on, the same lines from `src/machines/words.ts`) |
| A computer's work in this app: its worktrees in the sidebar with its mark (On your computers), its name in the toolbar with Slow or Reconnecting, its notices in the one bell and the Dock, each saying which computer | Mac (`machines/MachineTag.tsx`, `machines/RemoteRows.tsx`, `src/machines/attention.ts`); the phone lists them under Work › Your Computers and Needs You |
| An offline computer: its last state and the files you read, kept on this Mac (capped), open read-only until it's back; calls that need it say so at once | Mac (`src/machines/cache.ts`, `src/machines/files.ts`); the phone reads its own copy, greyed |

## Adding a feature

1. The API: an entry in `src/ipc/api.ts` and its handler in `src/ipc/handlers.ts`.
2. The behavior in the core, with a contract test in `tests/contract/` (runs in process and over the daemon's socket).
3. Model or action code in `src/ui/*-models.ts` / `*-actions.ts` / `menus.ts` (keep it browser-safe: `tests/browser-safe.test.ts`).
4. The Mac app's pixels (`packages/mac/src`).
5. A row on this page.
6. Command, palette, menu bar and help entries.
